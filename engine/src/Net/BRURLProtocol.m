#import "BRURLProtocol.h"
#import <libkern/OSAtomic.h>
#import "BRHTTPRequest.h"
#import "BRAdBlock.h"
#import "BRCSSRewriter.h"
#import "BRFontConverter.h"
#import "BRMediaProxy.h"
#import "BRImageConverter.h"
#import "BRSpeech.h"
#import "BRCommon.h"
#import "BRSettings.h"
#import "BRMemory.h"
#include <Security/SecRandom.h>

static const NSUInteger BRMaxRewriteBody = 4 * 1024 * 1024;
// What the page's own channels to the app take (shims-extra.js: the text of an inserted script, of an inserted style):
// as much as a script file or a big style, not what a hostile page could pile up; more is answered 413.
static const NSUInteger BRMaxLowerBody = 8 * 1024 * 1024, BRMaxCSSRunBody = 2 * 1024 * 1024;
// (scripts: a site's whole application can be one file, mapy.com's is 4.5 MB; the rewriter waits for memory first)
static const NSUInteger BRMaxScriptRewriteBody = 8 * 1024 * 1024;
static const NSUInteger BRMaxFontRewriteBody = 8 * 1024 * 1024, BRMaxImageRewriteBody = 6 * 1024 * 1024;
// (documents too: edition.cnn.com's front page is 4.1 MB of HTML, most of it data; left as it came it had no polyfills,
// no rewritten styles and none of its scripts ran)
static const NSUInteger BRMaxDocumentRewriteBody = 8 * 1024 * 1024;
static NSUInteger BRRewriteLimit(NSString *kind)
{
    if ([kind hasPrefix:@"js"]) return BRMaxScriptRewriteBody;
    if ([kind isEqualToString:@"html"]) return BRMaxDocumentRewriteBody;
    if ([kind isEqualToString:@"font"] || [kind isEqualToString:@"woff"] || [kind isEqualToString:@"sfnt"]) return BRMaxFontRewriteBody;
    if ([kind isEqualToString:@"webp"] || [kind isEqualToString:@"bigimage"]) return BRMaxImageRewriteBody;
    return BRMaxRewriteBody;
}

// The page's ES module loader (shims-extra.js) asks for module files with this query marker: the response is the
// lowered module (a __brModules.define registration). The marker is removed before the request goes out.
static NSString * const BRModuleMarker = @"__brmod=1";
static BOOL BRIsModuleRequest(NSURL *url)
{
    return url.query.length && [url.query rangeOfString:BRModuleMarker].location != NSNotFound;
}
// The Worker shim (shims-extra.js) asks for the script of a worker started from a URL with this marker: the script
// then starts with the worker polyfills (the old engine's workers have no console, TextEncoder, ...).
static NSString * const BRWorkerMarker = @"__brwork=1";
static BOOL BRIsWorkerRequest(NSURL *url)
{
    return url.query.length && [url.query rangeOfString:BRWorkerMarker].location != NSNotFound;
}
// (the server never sees either marker)
static NSURL *BRURLWithoutModuleMarker(NSURL *url)
{
    if (!BRIsModuleRequest(url) && !BRIsWorkerRequest(url)) return url;
    NSString *s = url.absoluteString;
    for (NSString *marker in @[BRModuleMarker, BRWorkerMarker]) {
        s = [s stringByReplacingOccurrencesOfString:[@"&" stringByAppendingString:marker] withString:@""];
        s = [s stringByReplacingOccurrencesOfString:[NSString stringWithFormat:@"?%@&", marker] withString:@"?"];
        s = [s stringByReplacingOccurrencesOfString:[@"?" stringByAppendingString:marker] withString:@""];
    }
    return [NSURL URLWithString:s] ?: url;
}

static void BRSetHeaderField(NSMutableDictionary *fields, NSString *name, NSString *value)
{
    NSMutableArray *remove = [NSMutableArray array];
    for (NSString *k in fields) {
        if ([k caseInsensitiveCompare:name] == NSOrderedSame) [remove addObject:k];
    }
    [fields removeObjectsForKeys:remove];
    if (value) fields[name] = value;
}

// 1x1 transparent GIF served for blocked image requests
static const uint8_t BRBlankGIF[] = {
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xFF, 0xFF, 0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2C, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3B
};

static NSString * const BRHandledKey = @"BRURLProtocolHandled";
NSString * const BRPageProgressNotification = @"BRPageProgressNotification";
NSString * const BRPageDocumentNotification = @"BRPageDocumentNotification";

// The HTML of a page is about to reach WebKit: how heavy it is to draw (bytes; `html` nil when only the size is
// known), told to the main thread before WebKit lays it out.
static void BRNotePageDocument(NSURL *url, NSData *html, unsigned long long bytes)
{
    NSUInteger videos = 0;
    const char *p = html.bytes, *end = p + html.length;
    while (p && p + 6 <= end && (p = memchr(p, '<', (size_t)(end - p))) && p + 6 <= end) {
        if ((p[1] | 0x20) == 'v' && (p[2] | 0x20) == 'i' && (p[3] | 0x20) == 'd' && (p[4] | 0x20) == 'e' && (p[5] | 0x20) == 'o') videos++;
        p++;
    }
    NSDictionary *info = @{ @"url": url ?: [NSNull null], @"bytes": @(bytes), @"videos": @(videos) };
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSNotificationCenter defaultCenter] postNotificationName:BRPageDocumentNotification object:nil userInfo:info];
    });
}

// A script too big for the iPad 2 (past the rewrite limit: it would reach WebKit as it came, and parsing it alone runs
// the iPad out of memory - YouTube's 10.8 MB desktop bundle): the page's site is told to the main thread, which asks it
// for the version phones get (see BRSettings noteHostTooHeavy) before iOS closes the app.
NSString * const BRPageTooHeavyNotification = @"BRPageTooHeavyNotification";
static void BRNoteTooBigScript(NSURLRequest *request, unsigned long long bytes)
{
    NSURL *page = request.mainDocumentURL;
    if (!page.host.length || [BRSettings lighterVersionForHost:page.host]) return;
    BRLog(@"Script of %llu KB for %@ is too big for the iPad: %@", bytes >> 10, page.host, request.URL.absoluteString);
    NSDictionary *info = @{ @"url": page, @"script": request.URL ?: [NSNull null] };
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSNotificationCenter defaultCenter] postNotificationName:BRPageTooHeavyNotification object:nil userInfo:info];
    });
}

#pragma mark - Page progress and main document facts

static NSURL *g_lastMainURL;
static NSString *g_lastMainTLS;
static NSString *g_lastMainContentType;
static NSString *g_progressPage;        // main document URL string of the page being counted
static NSUInteger g_progressStarted, g_progressFinished;
static CFAbsoluteTime g_progressPosted;

static void BRPostProgress(BOOL force)
{
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    if (!force && now - g_progressPosted < 0.15) return;
    g_progressPosted = now;
    NSDictionary *info = @{ @"page": g_progressPage ?: @"", @"started": @(g_progressStarted), @"finished": @(g_progressFinished) };
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSNotificationCenter defaultCenter] postNotificationName:BRPageProgressNotification object:nil userInfo:info];
    });
}

// Called for every request that reaches the network: counts requests per page for the progress bar.
static void BRProgressRequestStarted(NSURLRequest *request)
{
    NSString *page = request.mainDocumentURL.absoluteString ?: request.URL.absoluteString;
    BOOL isMain = !request.mainDocumentURL || [request.URL isEqual:request.mainDocumentURL];
    @synchronized ([BRURLProtocol class]) {
        if (isMain || ![page isEqualToString:g_progressPage]) {
            if (!isMain && g_progressPage && ![page isEqualToString:g_progressPage]) return;   // a stray load of an old page
            g_progressPage = page;
            g_progressStarted = 0;
            g_progressFinished = 0;
        }
        g_progressStarted++;
    }
    BRPostProgress(isMain);
}

static void BRProgressRequestFinished(NSURLRequest *request)
{
    NSString *page = request.mainDocumentURL.absoluteString ?: request.URL.absoluteString;
    BOOL post = NO;
    @synchronized ([BRURLProtocol class]) {
        if ([page isEqualToString:g_progressPage] && g_progressFinished < g_progressStarted) {
            g_progressFinished++;
            post = YES;
        }
    }
    if (post) BRPostProgress(g_progressFinished == g_progressStarted);
}
static NSString * const BRCacheStoredAtKey = @"BRStoredAt";     // NSCachedURLResponse.userInfo
static NSString * const BRCacheMaxAgeKey = @"BRMaxAge";
static NSString * const BRCacheRewriteTagKey = @"BRRewriteTag";   // the rewriters that made a stored text body
static NSString * const BRCacheCredentialedKey = @"BRCredentialed";   // fetched with the user's cookies or login

// a stored document, stylesheet or script was rewritten by the rewriters of another version: not used (a fixed
// transpiler would otherwise not reach a script cached for a year)
static NSString *BRHeader(NSDictionary *headers, NSString *name);
// NSURLCache on one queue: stores from many request threads at once crashed inside CFNetwork (a NULL dereference in
// the cache's store, idnes.cz); reads wait for the stores before them
static dispatch_queue_t BRCacheQueue(void)
{
    static dispatch_queue_t q;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ q = dispatch_queue_create("com.samcejko.browser.cache", DISPATCH_QUEUE_SERIAL); });
    return q;
}
// Stores wait for the lookups: a response to keep is held here (and found here by lookups) until no lookup waits, then
// written one at a time on the cache queue. Each store took the cache queue for long on the iPad's flash, and every
// lookup queued behind all the stores before it: IKEA's visit from the cache waited 8 s for one lookup. Held bytes
// are bounded: above the bound a store goes out even while lookups wait.
static NSMutableDictionary *g_pendingStores;       // URL string -> @[NSCachedURLResponse, NSURLRequest]
static NSMutableArray *g_pendingOrder;             // URL strings, oldest first
static unsigned long long g_pendingBytes;
static volatile int32_t g_lookupsWaiting;
static BOOL g_flushScheduled;
static const unsigned long long BRPendingStoreBound = 16ULL * 1024 * 1024;
static NSObject *BRPendingLock(void)
{
    static NSObject *lock;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ lock = [NSObject new]; });
    return lock;
}
static NSCachedURLResponse *BRPendingStoreFor(NSURLRequest *request)
{
    NSString *key = request.URL.absoluteString;
    if (!key) return nil;
    @synchronized (BRPendingLock()) { return [g_pendingStores[key] firstObject]; }
}
static void BRForgetPendingStore(NSURLRequest *request)
{
    NSString *key = request.URL.absoluteString;
    if (!key) return;
    @synchronized (BRPendingLock()) {
        NSArray *p = g_pendingStores[key];
        if (!p) return;
        g_pendingBytes -= MIN(g_pendingBytes, (unsigned long long)[(NSCachedURLResponse *)p[0] data].length);
        [g_pendingStores removeObjectForKey:key];
        [g_pendingOrder removeObject:key];
    }
}
static void BRScheduleCacheFlush(NSTimeInterval delay);
// (cache queue) the oldest held store, unless lookups wait and the held bytes are within the bound
static void BRFlushOneStore(void)
{
    NSArray *p = nil;
    BOOL more = NO;
    @synchronized (BRPendingLock()) {
        g_flushScheduled = NO;
        if (!g_pendingOrder.count) return;
        if (g_lookupsWaiting > 0 && g_pendingBytes < BRPendingStoreBound) { more = YES; }
        else {
            NSString *key = g_pendingOrder[0];
            [g_pendingOrder removeObjectAtIndex:0];
            p = g_pendingStores[key];
            [g_pendingStores removeObjectForKey:key];
            if (p) g_pendingBytes -= MIN(g_pendingBytes, (unsigned long long)[(NSCachedURLResponse *)p[0] data].length);
            more = g_pendingOrder.count > 0;
        }
    }
    if (p) [[NSURLCache sharedURLCache] storeCachedResponse:p[0] forRequest:p[1]];
    // (the next one as a block of its own: lookups queued meanwhile go first)
    if (more) BRScheduleCacheFlush(p ? 0 : 0.3);
}
static void BRScheduleCacheFlush(NSTimeInterval delay)
{
    @synchronized (BRPendingLock()) {
        if (g_flushScheduled) return;
        g_flushScheduled = YES;
    }
    if (delay <= 0) dispatch_async(BRCacheQueue(), ^{ @autoreleasepool { BRFlushOneStore(); } });
    else dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), BRCacheQueue(), ^{ @autoreleasepool { BRFlushOneStore(); } });
}
static void BRStoreLater(NSCachedURLResponse *c, NSURLRequest *request)
{
    NSString *key = request.URL.absoluteString;
    if (!key || !c) return;
    @synchronized (BRPendingLock()) {
        if (!g_pendingStores) { g_pendingStores = [NSMutableDictionary dictionary]; g_pendingOrder = [NSMutableArray array]; }
        NSArray *old = g_pendingStores[key];
        if (old) { g_pendingBytes -= MIN(g_pendingBytes, (unsigned long long)[(NSCachedURLResponse *)old[0] data].length); [g_pendingOrder removeObject:key]; }
        g_pendingStores[key] = @[c, request];
        [g_pendingOrder addObject:key];
        g_pendingBytes += c.data.length;
    }
    BRScheduleCacheFlush(0.3);
}
// A text body stored as it came (too big to rewrite, rewriting switched off) is tagged with what made it so: it goes
// stale when the rewriters or those limits change, like a rewritten one.
static NSString *BRRawCacheTag(void)
{
    return [NSString stringWithFormat:@"%@/raw-%d%d-%lu-%lu-%lu", [BRCSSRewriter rewriteTag], [BRSettings cssFixEnabled], [BRSettings transpileEnabled],
            (unsigned long)BRMaxRewriteBody, (unsigned long)BRMaxScriptRewriteBody, (unsigned long)BRMaxDocumentRewriteBody];
}
// Fonts are kept as the converter made them (unpacked, variation tables and heavy layout tables dropped), tagged with
// its version: they go stale when it changes. (3: ligature icon fonts keep their layout tables, text fonts do not.)
static NSString *const BRFontCacheTag = @"font-3";
static BOOL BRIsFontType(NSString *type)
{
    return [type hasPrefix:@"font/"] || [type rangeOfString:@"font-"].location != NSNotFound || [type rangeOfString:@"opentype"].location != NSNotFound;
}
// A body the rewriter would take for a document, a stylesheet or a script whose bytes say otherwise: the kind to give it
// ("font", "woff", "sfnt", "webp"), "binary" for another picture to pass as it is, nil for text. (Google's icon font kit,
// fonts.gstatic.com/l/font?kit=..., comes as text/html: rewritten as a document the WOFF2 was ruined and every icon of
// Google Maps was a box, "FT_Open_Face failed: error 2".)
static NSString *BRSniffBinaryKind(NSData *d)
{
    if (d.length < 12) return nil;
    const unsigned char *b = d.bytes;
    if (!memcmp(b, "wOF2", 4)) return @"font";
    if (!memcmp(b, "wOFF", 4)) return @"woff";
    // (an sfnt's table count follows its tag: a script that starts with "true..." has text there)
    unsigned numTables = ((unsigned)b[4] << 8) | b[5];
    if ((!memcmp(b, "OTTO", 4) || !memcmp(b, "true", 4) || (b[0] == 0 && b[1] == 1 && b[2] == 0 && b[3] == 0)) && numTables > 0 && numTables < 64) return @"sfnt";
    if (!memcmp(b, "RIFF", 4) && !memcmp(b + 8, "WEBP", 4)) return @"webp";
    if (!memcmp(b, "\x89PNG", 4) || (b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) || !memcmp(b, "GIF8", 4)) return @"binary";
    return nil;
}
static BOOL BRCachedRewriteIsStale(NSCachedURLResponse *c)
{
    if (![c.response isKindOfClass:[NSHTTPURLResponse class]]) return NO;
    NSString *type = [BRHeader([(NSHTTPURLResponse *)c.response allHeaderFields], @"Content-Type") lowercaseString] ?: @"";
    if (BRIsFontType(type)) return ![c.userInfo[BRCacheRewriteTagKey] isEqual:BRFontCacheTag];
    BOOL rewritable = [type hasPrefix:@"text/html"] || [type hasPrefix:@"text/css"] || [type hasPrefix:@"application/xhtml"] ||
                      [type rangeOfString:@"javascript"].location != NSNotFound || [type rangeOfString:@"ecmascript"].location != NSNotFound;
    if (!rewritable) return NO;
    id tag = c.userInfo[BRCacheRewriteTagKey];
    return ![tag isEqual:[BRCSSRewriter rewriteTag]] && ![tag isEqual:BRRawCacheTag()];
}
static BOOL BRCachedIsHTML(NSCachedURLResponse *c)
{
    NSString *type = [c.response.MIMEType lowercaseString] ?: @"";
    return [type isEqualToString:@"text/html"] || [type isEqualToString:@"application/xhtml+xml"];
}
static const NSUInteger BRMaxCacheableBody = 16 * 1024 * 1024;   // (big bundles and front pages are what is worth keeping)

#pragma mark - HTTP authentication (Basic)

static NSString *BRHeader(NSDictionary *headers, NSString *name);

static BRAuthenticationHandler g_authHandler;
static NSMutableDictionary *g_credentials;          // "https://host:443" -> "Basic base64(user:password)", this session only
static dispatch_semaphore_t g_authPromptLock;       // one login dialog at a time

static NSString *BRAuthKeyForURL(NSURL *url)
{
    NSString *scheme = [url.scheme lowercaseString] ?: @"http";
    NSInteger port = url.port ? [url.port integerValue] : ([scheme isEqualToString:@"https"] ? 443 : 80);
    return [NSString stringWithFormat:@"%@://%@:%ld", scheme, [url.host lowercaseString] ?: @"", (long)port];
}

static NSString *BRStoredAuthorization(NSString *key)
{
    @synchronized ([BRURLProtocol class]) { return key ? g_credentials[key] : nil; }
}

static void BRStoreAuthorization(NSString *key, NSString *value)
{
    if (!key) return;
    @synchronized ([BRURLProtocol class]) {
        if (!g_credentials) g_credentials = [NSMutableDictionary dictionary];
        if (value) g_credentials[key] = value; else [g_credentials removeObjectForKey:key];
    }
}

static NSString *BRRealmFromChallenge(NSString *challenge)
{
    NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"realm\\s*=\\s*\"?([^\",]*)\"?" options:NSRegularExpressionCaseInsensitive error:NULL];
    NSTextCheckingResult *m = challenge.length ? [re firstMatchInString:challenge options:0 range:NSMakeRange(0, challenge.length)] : nil;
    return (m && m.numberOfRanges > 1) ? [challenge substringWithRange:[m rangeAtIndex:1]] : @"";
}

// Third-party check for cookies: the request host must share the registrable domain (last two labels) with the page.
static BOOL BRSameSite(NSURL *a, NSURL *b)
{
    NSString *ha = [a.host lowercaseString], *hb = [b.host lowercaseString];
    if (!ha.length || !hb.length) return YES;
    if ([ha isEqualToString:hb]) return YES;
    NSArray *pa = [ha componentsSeparatedByString:@"."], *pb = [hb componentsSeparatedByString:@"."];
    if (pa.count < 2 || pb.count < 2) return NO;
    return [pa[pa.count - 1] isEqualToString:pb[pb.count - 1]] && [pa[pa.count - 2] isEqualToString:pb[pb.count - 2]];
}

static BOOL BRLooksLikeImageRequest(NSURLRequest *request)
{
    NSString *accept = [BRHeader(request.allHTTPHeaderFields, @"Accept") lowercaseString] ?: @"";
    if ([accept hasPrefix:@"image/"]) return YES;
    NSString *ext = [[request.URL.path pathExtension] lowercaseString] ?: @"";
    return [@[@"png", @"jpg", @"jpeg", @"gif", @"webp", @"bmp", @"avif", @"jfif"] containsObject:ext];
}

#pragma mark - Helpers

// Case-insensitive header lookup (NSHTTPURLResponse.allHeaderFields is case-insensitive in practice, plain dictionaries are not).
static NSString *BRHeader(NSDictionary *headers, NSString *name)
{
    id v = headers[name];
    if (v) return [v description];
    for (NSString *k in headers) {
        if ([k caseInsensitiveCompare:name] == NSOrderedSame) return [headers[k] description];
    }
    return nil;
}

static NSDate *BRParseHTTPDate(NSString *s)
{
    if (!s.length) return nil;
    static NSArray *formatters;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSLocale *posix = [[NSLocale alloc] initWithLocaleIdentifier:@"en_US_POSIX"];
        NSTimeZone *gmt = [NSTimeZone timeZoneWithAbbreviation:@"GMT"];
        NSMutableArray *fs = [NSMutableArray array];
        for (NSString *fmt in @[@"EEE, dd MMM yyyy HH:mm:ss zzz", @"EEEE, dd-MMM-yy HH:mm:ss zzz", @"EEE MMM d HH:mm:ss yyyy"]) {
            NSDateFormatter *f = [[NSDateFormatter alloc] init];
            f.locale = posix;
            f.timeZone = gmt;
            f.dateFormat = fmt;
            [fs addObject:f];
        }
        formatters = fs;
    });
    @synchronized (formatters) {   // NSDateFormatter is not thread safe on iOS 6
        for (NSDateFormatter *f in formatters) {
            NSDate *d = [f dateFromString:s];
            if (d) return d;
        }
    }
    return nil;
}

// Seconds a 200 response may be served without revalidation: > 0 fresh for that long,
// 0 = always revalidate (validators present), -1 = do not cache at all.
static NSTimeInterval BRMaxAgeForResponse(NSDictionary *headers, BOOL hasSetCookie)
{
    NSString *cc = [BRHeader(headers, @"Cache-Control") lowercaseString] ?: @"";
    NSString *pragma = [BRHeader(headers, @"Pragma") lowercaseString] ?: @"";
    NSString *vary = BRHeader(headers, @"Vary");
    BOOL hasValidator = BRHeader(headers, @"ETag") != nil || BRHeader(headers, @"Last-Modified") != nil;
    if ([cc rangeOfString:@"no-store"].location != NSNotFound) return -1;
    if ([vary isEqualToString:@"*"]) return -1;
    // (an answer that differs by the user's cookies or login: the cache is keyed by URL alone, so a kept one would go to
    // the next user of the iPad, or to a request made without them)
    NSString *varyNames = [vary lowercaseString] ?: @"";
    if ([varyNames rangeOfString:@"cookie"].location != NSNotFound || [varyNames rangeOfString:@"authorization"].location != NSNotFound) return -1;
    if ([cc rangeOfString:@"no-cache"].location != NSNotFound || [pragma rangeOfString:@"no-cache"].location != NSNotFound) {
        return hasValidator ? 0 : -1;
    }
    NSRange r = [cc rangeOfString:@"max-age="];
    if (r.location != NSNotFound) {
        NSTimeInterval v = [[cc substringFromIndex:r.location + r.length] doubleValue];
        if (v > 0) return v;
        return hasValidator ? 0 : -1;
    }
    NSDate *date = BRParseHTTPDate(BRHeader(headers, @"Date")) ?: [NSDate date];
    NSString *expires = BRHeader(headers, @"Expires");
    if (expires.length) {
        NSDate *e = BRParseHTTPDate(expires);
        NSTimeInterval v = e ? [e timeIntervalSinceDate:date] : 0;
        if (v > 0) return v;
        return hasValidator ? 0 : -1;
    }
    NSDate *lm = BRParseHTTPDate(BRHeader(headers, @"Last-Modified"));
    if (lm && !hasSetCookie) {
        // Heuristic freshness like browsers: 10 % of the age, at most one day.
        NSTimeInterval v = [date timeIntervalSinceDate:lm] * 0.1;
        return MIN(MAX(v, 0), 24 * 3600);
    }
    return hasValidator ? 0 : -1;
}

static BOOL BRCachedResponseIsFresh(NSCachedURLResponse *c)
{
    NSNumber *storedAt = c.userInfo[BRCacheStoredAtKey];
    NSNumber *maxAge = c.userInfo[BRCacheMaxAgeKey];
    if (!storedAt || !maxAge) return NO;
    return [NSDate timeIntervalSinceReferenceDate] - [storedAt doubleValue] < [maxAge doubleValue];
}

static NSData *BRReadBodyStream(NSInputStream *stream)
{
    if (!stream) return nil;
    NSMutableData *d = [NSMutableData data];
    [stream open];
    uint8_t buf[16384];
    for (;;) {
        NSInteger n = [stream read:buf maxLength:sizeof(buf)];
        if (n <= 0) break;
        [d appendBytes:buf length:(NSUInteger)n];
    }
    [stream close];
    return d;
}

// A request's body, at most `limit` bytes of it: nil with *tooBig set when there is more
static NSData *BRReadBodyUpTo(NSURLRequest *request, NSUInteger limit, BOOL *tooBig)
{
    *tooBig = NO;
    NSData *body = request.HTTPBody;
    if (body) {
        if (body.length <= limit) return body;
        *tooBig = YES;
        return nil;
    }
    NSInputStream *stream = request.HTTPBodyStream;
    if (!stream) return nil;
    NSMutableData *d = [NSMutableData data];
    [stream open];
    uint8_t buf[16384];
    for (;;) {
        NSInteger n = [stream read:buf maxLength:sizeof(buf)];
        if (n <= 0) break;
        if (d.length + (NSUInteger)n > limit) { *tooBig = YES; d = nil; break; }
        [d appendBytes:buf length:(NSUInteger)n];
    }
    [stream close];
    return d;
}

// a URL string without its fragment: how pages are named (the manifest's doc= against the request's main document)
static NSString *BRWithoutFragment(NSString *s)
{
    NSRange hash = [s rangeOfString:@"#"];
    return hash.location == NSNotFound ? s : [s substringToIndex:hash.location];
}

// "scheme://host:port" of a web address (http, https), nil for another: two addresses of one origin give the same
static NSString *BRWebOrigin(NSURL *url)
{
    NSString *scheme = [url.scheme lowercaseString];
    if (!url.host.length || !([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"])) return nil;
    return BRAuthKeyForURL(url);
}

// n bytes of the system's secure generator as lowercase hex; nil when it fails (never a weaker source instead)
static NSData *BRRandomHex(size_t n)
{
    uint8_t *bytes = malloc(n);
    char *hex = malloc(n * 2);
    if (!bytes || !hex || SecRandomCopyBytes(kSecRandomDefault, n, bytes) != 0) {
        free(bytes);
        free(hex);
        return nil;
    }
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        hex[2 * i] = digits[bytes[i] >> 4];
        hex[2 * i + 1] = digits[bytes[i] & 15];
    }
    memset(bytes, 0, n);
    free(bytes);
    return [NSData dataWithBytesNoCopy:hex length:n * 2 freeWhenDone:YES];
}

// A stored response that sets cookies (kept by versions before Set-Cookie was taken out of the cache): not served, the
// session cookies of then would come back with it
static BOOL BRCachedSetsCookies(NSCachedURLResponse *c)
{
    if (![c.response isKindOfClass:[NSHTTPURLResponse class]]) return NO;
    NSDictionary *f = [(NSHTTPURLResponse *)c.response allHeaderFields];
    return BRHeader(f, @"Set-Cookie") != nil || BRHeader(f, @"Set-Cookie2") != nil;
}

@interface BRURLProtocol ()
@property (nonatomic, strong) NSThread *clientThread;
@property (nonatomic, strong) NSArray *clientModes;
@property (nonatomic) BOOL loggedWait;          // a slow delivery to the client thread was logged (see performOnClientThread)
@property (nonatomic, strong) BRHTTPRequest *httpRequest;
@property (nonatomic) BOOL stopped;             // stopLoading was called
@property (nonatomic) BOOL counted;             // counted as started in the page progress
@property (nonatomic) BOOL done;                // finished, failed or redirected: nothing more goes to the client
@property (nonatomic, strong) NSCachedURLResponse *staleCached;   // stale cache entry being revalidated
@property (nonatomic, strong) NSMutableData *cacheBody;
@property (nonatomic) NSTimeInterval cacheMaxAge;
@property (nonatomic) NSUInteger cacheLimit;                  // the most of this body that is gathered for the cache
@property (nonatomic) BOOL fontBody;                          // a font: stored with the converter's version (BRFontCacheTag)
@property (nonatomic, strong) NSHTTPURLResponse *response;
@property (nonatomic, copy) NSDictionary *responseFields;          // the headers it was made from
@property (nonatomic) NSInteger responseStatus;
// CSS/HTML rewriting: the body is buffered and the response is sent once the rewritten data is ready
@property (nonatomic, copy) NSString *rewriteKind;
@property (nonatomic, strong) NSMutableData *rewriteBuffer;
@property (nonatomic, copy) NSString *rewriteCharset;
@property (nonatomic, strong) NSDictionary *pendingHeaderFields;
@property (nonatomic) NSInteger pendingStatus;
// what went on the wire (a 401 answer repeats the request with credentials)
@property (nonatomic, copy) NSString *sentMethod;
@property (nonatomic, strong) NSDictionary *sentHeaders;
@property (nonatomic, strong) NSData *sentBody;
@property (nonatomic) BOOL thirdParty;          // cookies are neither sent nor stored
@property (nonatomic) BOOL credentialedEntry;   // the cache keeps an answer made with credentials, not for this request
@property (nonatomic) BOOL authAttempted;       // the user was asked once for this request
// (for the list of requests in flight: surfari:requests?key=...)
@property (nonatomic) NSTimeInterval startedAt;
@property (nonatomic) unsigned long long receivedBytes;
@end

// the requests WebKit has started and not stopped yet
static NSHashTable *g_activeProtocols;

@implementation BRURLProtocol

+ (void)registerProtocol
{
    [NSURLProtocol registerClass:self];
}

+ (NSString *)activeRequestsReport
{
    NSArray *list = nil;
    @synchronized ([BRURLProtocol class]) { list = g_activeProtocols.allObjects; }
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    list = [list sortedArrayUsingComparator:^NSComparisonResult(BRURLProtocol *a, BRURLProtocol *b) {
        return a.startedAt < b.startedAt ? NSOrderedAscending : a.startedAt > b.startedAt ? NSOrderedDescending : NSOrderedSame;
    }];
    NSMutableString *out = [NSMutableString stringWithFormat:@"%lu requests in flight", (unsigned long)list.count];
    for (BRURLProtocol *p in list) {
        // (only flags and pointer tests: the request's objects belong to other threads)
        NSString *state = p.done ? @"done" : p.rewriteBuffer != nil ? @"buffering for the rewriter" : p.rewriteKind != nil ? @"rewriting"
                        : p.response != nil ? @"receiving" : p.httpRequest != nil ? @"waiting for the server" : @"not sent";
        NSString *u = p.request.URL.absoluteString ?: @"?";
        [out appendFormat:@"\n%5ld s  %@  %llu KB  %@ %@", (long)(now - p.startedAt), state, p.receivedBytes >> 10, p.request.HTTPMethod ?: @"GET",
                          u.length > 200 ? [u substringToIndex:200] : u];
    }
    return out;
}

+ (void)setAuthenticationHandler:(BRAuthenticationHandler)handler
{
    @synchronized (self) {
        g_authHandler = [handler copy];
        if (!g_authPromptLock) g_authPromptLock = dispatch_semaphore_create(1);
    }
}

+ (void)forgetCredentials
{
    @synchronized (self) { [g_credentials removeAllObjects]; }
}

+ (void)dropPendingCacheStores
{
    @synchronized (BRPendingLock()) {
        [g_pendingStores removeAllObjects];
        [g_pendingOrder removeAllObjects];
        g_pendingBytes = 0;
    }
}

+ (NSURL *)lastMainDocumentURL { @synchronized (self) { return g_lastMainURL; } }
+ (NSString *)lastMainDocumentTLSInfo { @synchronized (self) { return g_lastMainTLS; } }
+ (NSString *)lastMainDocumentContentType { @synchronized (self) { return g_lastMainContentType; } }

// A script the page could not parse (a SyntaxError from its own URL, see shims-extra.js): its cached copy goes, once per
// URL and session, so that the next visit loads it and lowers it again. (IKEA's recommendation chunks were in the cache
// as they came, with a year to live: every visit threw and the panels never came.)
+ (void)evictCachedScript:(NSString *)urlString
{
    NSURL *url = urlString.length ? [NSURL URLWithString:urlString] : nil;
    if (!url || ![[url.scheme lowercaseString] hasPrefix:@"http"]) return;
    static NSMutableSet *done;
    @synchronized (self) {
        if (!done) done = [NSMutableSet set];
        if ([done containsObject:url.absoluteString] || done.count > 200) return;
        [done addObject:url.absoluteString];
    }
    dispatch_async(BRCacheQueue(), ^{
        NSURLRequest *request = [NSURLRequest requestWithURL:url];
        NSCachedURLResponse *cached = BRPendingStoreFor(request) ?: [[NSURLCache sharedURLCache] cachedResponseForRequest:request];
        // (and the transpiler's result for that text, which may be an "unchanged" kept by an older version)
        if (cached.data.length) [[BRCSSRewriter shared] forgetTranspiledScript:cached.data];
        BRForgetPendingStore(request);
        [[NSURLCache sharedURLCache] removeCachedResponseForRequest:request];
        BRLog(@"Script that did not parse: %@ %@", cached ? @"cached copy dropped" : @"not in the cache", url.absoluteString.length > 160 ? [url.absoluteString substringToIndex:160] : url.absoluteString);
    });
}

// data:image/webp,... (placeholders of lazy images, feature tests): decoded here like WebP responses
static BOOL BRIsWebPDataURL(NSURL *url)
{
    NSString *s = url.absoluteString;
    if (s.length < 20) return NO;
    return [[[s substringToIndex:MIN(s.length, (NSUInteger)32)] lowercaseString] hasPrefix:@"data:image/webp"];
}

// data:font/woff2;base64,... (fonts inlined in stylesheets): WOFF2, which the old engine cannot read, is decoded like
// font responses (also under another media type: its signature, "wOF2", in base64)
static BOOL BRIsFontDataURL(NSURL *url)
{
    NSString *s = url.absoluteString;
    if (s.length < 40) return NO;
    NSRange comma = [s rangeOfString:@"," options:0 range:NSMakeRange(0, MIN(s.length, (NSUInteger)128))];
    if (comma.location == NSNotFound) return NO;
    NSString *meta = [[s substringToIndex:comma.location] lowercaseString];
    if ([meta rangeOfString:@"woff2"].location != NSNotFound) return YES;
    return [meta hasSuffix:@";base64"] && s.length > comma.location + 7 && [[s substringWithRange:NSMakeRange(comma.location + 1, 6)] isEqualToString:@"d09GMg"];
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request
{
    NSString *scheme = [request.URL.scheme lowercaseString];
    if ([scheme isEqualToString:@"data"]) return BRIsWebPDataURL(request.URL) || BRIsFontDataURL(request.URL);
    if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) return NO;
    if (![request.URL.host length]) return NO;
    if ([NSURLProtocol propertyForKey:BRHandledKey inRequest:request]) return NO;
    return YES;
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request
{
    return request;
}

#pragma mark - Client thread

// The NSURLProtocolClient is talked to on the thread that called -startLoading, in the run loop
// modes that were active at that time (the same pattern as Apple's CustomHTTPProtocol sample).
- (void)performOnClientThread:(dispatch_block_t)block
{
    if (!self.clientThread || !block) return;
    // (a response that waits long for that thread is logged once: what a page stands still for when its resources are
    // at hand - IKEA loaded nothing for 12 s of a visit from the cache)
    NSTimeInterval queued = [NSDate timeIntervalSinceReferenceDate];
    dispatch_block_t timed = ^{
        NSTimeInterval waited = [NSDate timeIntervalSinceReferenceDate] - queued;
        if (waited > 1.5 && !self.loggedWait) {
            self.loggedWait = YES;
            NSThread *t = self.clientThread;
            NSString *u = self.request.URL.absoluteString ?: @"?";
            BRLog(@"Delivery waited %.1f s for the %@ thread: %@", waited, t.isMainThread ? @"main" : t.name.length ? t.name : @"loader", u.length > 120 ? [u substringToIndex:120] : u);
        }
        block();
    };
    [self performSelector:@selector(br_runBlock:) onThread:self.clientThread withObject:(id)[timed copy] waitUntilDone:NO modes:self.clientModes];
}

- (void)br_runBlock:(dispatch_block_t)block
{
    if (self.stopped) return;
    block();
}

#pragma mark - Loading

- (void)startLoading
{
    self.startedAt = [NSDate timeIntervalSinceReferenceDate];
    @synchronized ([BRURLProtocol class]) {
        if (!g_activeProtocols) g_activeProtocols = [NSHashTable weakObjectsHashTable];
        [g_activeProtocols addObject:self];
    }
    self.clientThread = [NSThread currentThread];
    NSString *mode = [[NSRunLoop currentRunLoop] currentMode];
    NSMutableArray *modes = [NSMutableArray arrayWithObject:NSDefaultRunLoopMode];
    if (mode.length && ![mode isEqualToString:NSDefaultRunLoopMode]) [modes addObject:mode];
    self.clientModes = modes;

    NSURLRequest *request = self.request;
    NSURL *url = request.URL;
    NSString *method = request.HTTPMethod.length ? [request.HTTPMethod uppercaseString] : @"GET";
    BOOL isGET = [method isEqualToString:@"GET"];
    NSURLRequestCachePolicy policy = request.cachePolicy;

    // 0. A WebP picture in a data: URL
    if ([[url.scheme lowercaseString] isEqualToString:@"data"]) {
        if (BRIsFontDataURL(url)) [self serveFontDataURL]; else [self serveWebPDataURL];
        return;
    }

    // 0'. The media proxy's own address (see BRMediaProxy): the system's player loads from it, WebKit never. A page,
    // frame or script of a page there would run on the proxy's origin and read what it relays.
    if ([BRMediaProxy isProxyURL:url]) {
        BRLog(@"A load of the media proxy's own address was refused");
        [self deliverEmptyStatus:403];
        return;
    }

    // 0a. Our own resources (polyfill bundle) live on a reserved host name that never resolves; the polyfill bundle
    // is also answered on the page's own host (/__br_polyfills-<crc>.js, see BRCSSRewriter), and so are the big inline
    // scripts the rewriter set aside (/__br_inline-<name>.js: same origin, so the page's error reports stay whole)
    if ([[url.host lowercaseString] isEqualToString:@"ios6-browser.invalid"] ||
        (isGET && ([url.path hasPrefix:@"/__br_polyfills"] || [url.path hasPrefix:@"/__br_inline-"]) && [url.path hasSuffix:@".js"])) {
        [self serveInternalResource];
        return;
    }

    // 0b. Ad and tracker blocking (never for the main document)
    BOOL subresource = request.mainDocumentURL && ![url isEqual:request.mainDocumentURL];
    if ([self adBlockApplies]) {
        BOOL knownTag = [BRAdBlock isKnownTagScriptURL:url];
        if (knownTag || [BRAdBlock shouldBlockHost:url.host]) {
            [BRAdBlock noteBlockedRequest];
            [self serveBlockedResponseWithScript:(knownTag || [BRAdBlock isTagManagerHost:url.host]) ? [BRAdBlock tagScriptStub] : nil];
            return;
        }
    }
    // 0c. Data saver: images are answered with a blank picture
    if (subresource && ![BRSettings loadImages] && BRLooksLikeImageRequest(request)) {
        [self serveBlockedResponse];
        return;
    }
    self.thirdParty = subresource && [BRSettings blockThirdPartyCookies] && !BRSameSite(url, request.mainDocumentURL);

    // 1. Cache: looked up on the cache queue, never on this thread. This is WebKit's loader thread, which delivers every
    // response of the page: a lookup waiting there held all of them (IKEA's visit from the cache: 35 responses at hand
    // waited 13-15 s, nothing loaded for 12 s). The load goes on here with what it found.
    if (isGET && policy != NSURLRequestReloadIgnoringLocalCacheData && policy != NSURLRequestReloadIgnoringLocalAndRemoteCacheData) {
        NSTimeInterval lookup0 = [NSDate timeIntervalSinceReferenceDate];
        // (a request made without the user's cookies: a third party's while those are blocked, or one WebKit sends without
        // credentials - withCredentials = false, credentials: 'omit')
        BOOL anonymous = self.thirdParty || !request.HTTPShouldHandleCookies;
        OSAtomicIncrement32(&g_lookupsWaiting);
        dispatch_async(BRCacheQueue(), ^{
            NSCachedURLResponse *cached = nil;
            BOOL credentialed = NO;
            @autoreleasepool {
                cached = BRPendingStoreFor(request) ?: [[NSURLCache sharedURLCache] cachedResponseForRequest:request];
                if (cached && (BRCachedRewriteIsStale(cached) || BRCachedSetsCookies(cached) || ![BRCSSRewriter lazyPartsPresentIn:cached.data] ||
                               (BRCachedIsHTML(cached) && ![BRCSSRewriter inlineScriptsPresentIn:cached.data]))) {
                    // (rewritten by other versions of the rewriters, or a lowered chunk whose factories kept for later, or a
                    // document whose inline scripts set aside, are gone from the transpiler's cache: loaded again; and one
                    // kept with its Set-Cookie by an older version goes from the disk)
                    BRForgetPendingStore(request);
                    [[NSURLCache sharedURLCache] removeCachedResponseForRequest:request];
                    cached = nil;
                }
                // An answer fetched with the user's cookies or login is the user's: a request made without them neither
                // gets it nor replaces it. (The cache is keyed by URL alone: another site's request would get the user's
                // personal answer - readable to it when the server allows any origin - and blocking third-party cookies
                // would not keep a third party from the cookies' result.)
                if (cached && anonymous && [cached.userInfo[BRCacheCredentialedKey] boolValue]) {
                    cached = nil;
                    credentialed = YES;
                }
            }
            OSAtomicDecrement32(&g_lookupsWaiting);
            NSTimeInterval lookup = [NSDate timeIntervalSinceReferenceDate] - lookup0;
            if (lookup > 1.0) BRLog(@"Cache lookup took %.1f s (%@): %@", lookup, cached ? @"hit" : @"miss", url.absoluteString.length > 120 ? [url.absoluteString substringToIndex:120] : url.absoluteString);
            [self performOnClientThread:^{
                if (credentialed) self.credentialedEntry = YES;
                [self continueLoadingWithCached:cached lookedUp:YES];
            }];
        });
        return;
    }
    [self continueLoadingWithCached:nil lookedUp:NO];
}

// startLoading goes on here (client thread) with the cache's answer: a fresh copy is served, a stale one revalidated
- (void)continueLoadingWithCached:(NSCachedURLResponse *)cached lookedUp:(BOOL)lookedUp
{
    NSURLRequest *request = self.request;
    NSURL *url = request.URL;
    NSString *method = request.HTTPMethod.length ? [request.HTTPMethod uppercaseString] : @"GET";
    NSURLRequestCachePolicy policy = request.cachePolicy;
    if (lookedUp) {
        if (cached && [cached.response isKindOfClass:[NSHTTPURLResponse class]] && cached.userInfo[BRCacheStoredAtKey]) {
            if (BRCachedResponseIsFresh(cached) || policy == NSURLRequestReturnCacheDataElseLoad || policy == NSURLRequestReturnCacheDataDontLoad) {
                [self serveCachedResponse:cached];
                return;
            }
            self.staleCached = cached;
        }
        if (policy == NSURLRequestReturnCacheDataDontLoad) {
            [self failWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorResourceUnavailable
                                                userInfo:@{ NSURLErrorFailingURLStringErrorKey: url.absoluteString ?: @"" }]];
            return;
        }
    }

    // 2. Request headers: WebKit's own, cookies from the shared jar, validators for a stale cache entry
    NSMutableDictionary *headers = [NSMutableDictionary dictionaryWithDictionary:request.allHTTPHeaderFields ?: @{}];
    if (self.thirdParty) {
        [headers removeObjectForKey:@"Cookie"];
    } else if (request.HTTPShouldHandleCookies && !BRHeader(headers, @"Cookie")) {
        NSArray *cookies = nil;
        @synchronized (BRCookieLock()) { cookies = [[NSHTTPCookieStorage sharedHTTPCookieStorage] cookiesForURL:url]; }
        if (cookies.count) {
            NSString *cookieHeader = [NSHTTPCookie requestHeaderFieldsWithCookies:cookies][@"Cookie"];
            if (cookieHeader.length) headers[@"Cookie"] = cookieHeader;
        }
    }
    if (self.staleCached) {
        NSDictionary *old = ((NSHTTPURLResponse *)self.staleCached.response).allHeaderFields;
        NSString *etag = BRHeader(old, @"ETag");
        NSString *lastModified = BRHeader(old, @"Last-Modified");
        if (etag.length) headers[@"If-None-Match"] = etag;
        if (lastModified.length) headers[@"If-Modified-Since"] = lastModified;
    }
    NSString *stored = [self mayUseStoredCredentials] ? BRStoredAuthorization(BRAuthKeyForURL(url)) : nil;
    if (stored && !BRHeader(headers, @"Authorization")) headers[@"Authorization"] = stored;
    NSData *body = request.HTTPBody ?: BRReadBodyStream(request.HTTPBodyStream);

    // 3. Go (a page's request waits while the iPad is nearly out of memory: see BRMemory holdLoad:)
    BOOL mainDocument = !request.mainDocumentURL || [url isEqual:request.mainDocumentURL];
    if (mainDocument) BRLog(@"%@ %@ (main document)", method, url.absoluteString);
    self.counted = YES;
    BRProgressRequestStarted(request);
    if (!mainDocument && [BRMemory holdLoad:^{
        [self performOnClientThread:^{ if (!self.httpRequest) [self sendRequestWithMethod:method headers:headers body:body]; }];
    }]) return;
    [self sendRequestWithMethod:method headers:headers body:body];
}

// Starts (or restarts, after a 401) the network request. Callbacks of a superseded request are ignored.
- (void)sendRequestWithMethod:(NSString *)method headers:(NSDictionary *)headers body:(NSData *)body
{
    NSURLRequest *request = self.request;
    NSURL *url = BRURLWithoutModuleMarker(request.URL);   // (the server never sees the module loader's marker)
    self.sentMethod = method;
    self.sentHeaders = headers;
    self.sentBody = body;
    BRHTTPRequest *r = [[BRHTTPRequest alloc] initWithMethod:method URL:url];
    r.headers = headers;
    r.body = body;
    r.verifyTLS = [BRSettings verifyTLS];
    r.connectTimeout = 20;
    r.readTimeout = request.timeoutInterval > 0 ? MAX(20, request.timeoutInterval) : 60;
    r.highPriority = !request.mainDocumentURL || [url isEqual:request.mainDocumentURL];
    __weak BRURLProtocol *weakSelf = self;
    __weak BRHTTPRequest *weakR = r;
    r.onHeaders = ^(NSInteger status, NSDictionary *hdrs) { BRURLProtocol *s = weakSelf; if (s && s.httpRequest == weakR) [s handleHeaders:status]; };
    r.onData = ^(NSData *chunk) { BRURLProtocol *s = weakSelf; if (s && s.httpRequest == weakR) [s handleData:chunk]; };
    r.onComplete = ^(NSError *error) { BRURLProtocol *s = weakSelf; if (s && s.httpRequest == weakR) [s handleComplete:error]; };
    self.httpRequest = r;
    [r start];
}

// Basic credentials (stored ones, or asked for) go only with a request of the host's own pages that carries
// credentials: never with one made without them (WebKit clears HTTPShouldHandleCookies for withCredentials = false
// and credentials: 'omit'), nor with another site's (a server that answers Access-Control-Allow-Origin: * would hand
// that site the protected answer).
- (BOOL)mayUseStoredCredentials
{
    NSURLRequest *request = self.request;
    if (!request.HTTPShouldHandleCookies) return NO;
    NSURL *page = request.mainDocumentURL;
    if (!page || [request.URL isEqual:page]) return YES;
    NSString *host = [request.URL.host lowercaseString];
    return host.length && [host isEqualToString:[page.host lowercaseString]];
}

// A 401 with a Basic challenge: ask the user (once per request) and repeat the request with the answer.
// Runs on the request's worker thread, which waits for the dialog. Returns YES when the request was restarted.
- (BOOL)handleAuthenticationChallenge:(NSString *)challenge
{
    if (self.authAttempted || !g_authHandler || !g_authPromptLock || ![self mayUseStoredCredentials]) return NO;
    self.authAttempted = YES;
    NSURL *url = self.request.URL;
    NSString *key = BRAuthKeyForURL(url);
    NSString *realm = BRRealmFromChallenge(challenge);
    if (BRHeader(self.sentHeaders, @"Authorization")) BRStoreAuthorization(key, nil);   // stored credentials were refused
    dispatch_semaphore_wait(g_authPromptLock, DISPATCH_TIME_FOREVER);
    NSString *stored = BRStoredAuthorization(key);   // another request may have asked meanwhile
    if (!stored && !self.stopped) {
        dispatch_semaphore_t answered = dispatch_semaphore_create(0);
        __block NSString *user = nil, *password = nil;
        BRAuthenticationHandler handler = g_authHandler;
        dispatch_async(dispatch_get_main_queue(), ^{
            handler(url.host ?: @"", realm, ^(NSString *u, NSString *p) { user = u; password = p; dispatch_semaphore_signal(answered); });
        });
        dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(300 * NSEC_PER_SEC)));
        if (user.length) {
            NSData *pair = [[NSString stringWithFormat:@"%@:%@", user, password ?: @""] dataUsingEncoding:NSUTF8StringEncoding];
            stored = [@"Basic " stringByAppendingString:BRBase64Encode(pair)];
            BRStoreAuthorization(key, stored);
        }
    }
    dispatch_semaphore_signal(g_authPromptLock);
    if (!stored || self.stopped) return NO;
    BRLog(@"Authenticating to %@ (%@)", url.host, realm);
    NSMutableDictionary *headers = [self.sentHeaders mutableCopy] ?: [NSMutableDictionary dictionary];
    for (NSString *k in [headers allKeys]) if ([k caseInsensitiveCompare:@"Authorization"] == NSOrderedSame) [headers removeObjectForKey:k];
    headers[@"Authorization"] = stored;
    [self.httpRequest cancel];
    [self sendRequestWithMethod:self.sentMethod headers:headers body:self.sentBody];
    return YES;
}

- (void)noteFinishedForProgress
{
    if (!self.counted) return;
    self.counted = NO;
    BRProgressRequestFinished(self.request);
}

- (void)stopLoading
{
    @synchronized ([BRURLProtocol class]) { [g_activeProtocols removeObject:self]; }
    self.stopped = YES;
    [self.httpRequest cancel];
    self.httpRequest = nil;
    [self noteFinishedForProgress];
}

#pragma mark - Worker thread callbacks

- (NSDictionary *)headerFieldsForWebKit
{
    BRHTTPRequest *r = self.httpRequest;
    NSMutableDictionary *fields = [NSMutableDictionary dictionary];
    for (NSArray *pair in r.responseHeaderPairs) {
        NSString *name = pair[0];
        NSString *value = pair[1];
        NSString *lname = [name lowercaseString];
        if ([lname isEqualToString:@"connection"] || [lname isEqualToString:@"transfer-encoding"] || [lname isEqualToString:@"keep-alive"]) continue;
        if (r.decodedContentEncoding && ([lname isEqualToString:@"content-encoding"] || [lname isEqualToString:@"content-length"])) continue;
        NSString *existingKey = nil;
        for (NSString *k in fields) {
            if ([k caseInsensitiveCompare:name] == NSOrderedSame) { existingKey = k; break; }
        }
        if (existingKey) fields[existingKey] = [NSString stringWithFormat:@"%@, %@", fields[existingKey], value];
        else fields[name] = value;
    }
    return fields;
}

- (void)handleHeaders:(NSInteger)status
{
    if (self.stopped || self.done) return;
    BRHTTPRequest *r = self.httpRequest;
    if (!r) return;
    NSURL *url = self.request.URL;

    // HTTP authentication: ask the user and repeat the request
    if (status == 401) {
        NSString *challenge = r.responseHeaders[@"www-authenticate"] ?: @"";
        if ([[challenge lowercaseString] hasPrefix:@"basic"] && [self handleAuthenticationChallenge:challenge]) return;
    }

    // Cookies go into the shared jar so document.cookie and later requests see them.
    if (self.request.HTTPShouldHandleCookies && r.setCookieHeaders.count && !self.thirdParty) {
        NSHTTPCookieStorage *jar = [NSHTTPCookieStorage sharedHTTPCookieStorage];
        for (NSString *value in r.setCookieHeaders) {
            NSArray *cookies = [NSHTTPCookie cookiesWithResponseHeaderFields:@{ @"Set-Cookie": value } forURL:url];
            if (cookies.count) { @synchronized (BRCookieLock()) { [jar setCookies:cookies forURL:url mainDocumentURL:self.request.mainDocumentURL ?: url]; } }
        }
    }

    // Revalidated cache entry
    if (status == 304 && self.staleCached) {
        self.done = YES;
        [r cancel];
        NSTimeInterval maxAge = BRMaxAgeForResponse(r.responseHeaders, r.setCookieHeaders.count > 0);
        NSNumber *oldMaxAge = self.staleCached.userInfo[BRCacheMaxAgeKey];
        if (maxAge < 0 && oldMaxAge) maxAge = [oldMaxAge doubleValue];
        self.fontBody = [self.staleCached.userInfo[BRCacheRewriteTagKey] isEqual:BRFontCacheTag];   // (a font stays one)
        NSHTTPURLResponse *staleResponse = (NSHTTPURLResponse *)self.staleCached.response;
        [self storeHeaders:staleResponse.allHeaderFields status:staleResponse.statusCode data:self.staleCached.data maxAge:MAX(maxAge, 0)];
        [self serveCachedResponse:self.staleCached];
        return;
    }

    // Redirects: hand the new request to WebKit, which starts a fresh load (through this protocol again).
    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
        NSString *location = r.responseHeaders[@"location"];
        NSURL *target = location.length ? [[NSURL URLWithString:location relativeToURL:url] absoluteURL] : nil;
        if (!target) {
            // Some servers emit spaces or non-ASCII characters in Location.
            NSString *escaped = [location stringByAddingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
            target = escaped.length ? [[NSURL URLWithString:escaped relativeToURL:url] absoluteURL] : nil;
        }
        if (target) {
            self.done = YES;
            [r cancel];
            NSMutableURLRequest *redirect = [self.request mutableCopy];
            redirect.URL = target;
            NSString *method = [self.request.HTTPMethod uppercaseString] ?: @"GET";
            BOOL toGET = (status == 303) || ((status == 301 || status == 302) && ![method isEqualToString:@"GET"] && ![method isEqualToString:@"HEAD"]);
            if (toGET) {
                redirect.HTTPMethod = @"GET";
                redirect.HTTPBody = nil;
                redirect.HTTPBodyStream = nil;
                [redirect setValue:nil forHTTPHeaderField:@"Content-Type"];
                [redirect setValue:nil forHTTPHeaderField:@"Content-Length"];
            }
            [redirect setValue:nil forHTTPHeaderField:@"Cookie"];   // cookies for the new URL are added on the next pass
            NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:[self headerFieldsForWebKit]];
            [self performOnClientThread:^{
                [self.client URLProtocol:self wasRedirectedToRequest:redirect redirectResponse:response];
                // The client ignores this error; it is the documented way to end the current load after a redirect.
                [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSCocoaErrorDomain code:NSUserCancelledError userInfo:nil]];
            }];
            return;
        }
    }

    // Normal response
    if (!self.request.mainDocumentURL || [url isEqual:self.request.mainDocumentURL]) {
        BRLog(@"%@ %@ -> %ld %@ [%@]", self.request.HTTPMethod ?: @"GET", url.absoluteString, (long)status,
              r.responseHeaders[@"content-type"] ?: @"", r.tlsInfo ?: @"");
        @synchronized ([BRURLProtocol class]) {
            g_lastMainURL = url;
            g_lastMainTLS = [[url.scheme lowercaseString] isEqualToString:@"https"] ? [r.tlsInfo copy] : nil;
            g_lastMainContentType = [r.responseHeaders[@"content-type"] copy];
        }
    }
    NSDictionary *webKitFields = [self headerFieldsForWebKit];
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:webKitFields];
    self.response = response;
    self.responseFields = webKitFields;   // (what the cache is given, see storeHeaders)
    self.responseStatus = status;
    self.cacheMaxAge = -1;
    self.cacheBody = nil;
    NSString *method = [self.request.HTTPMethod uppercaseString] ?: @"GET";
    if ([method isEqualToString:@"GET"] && status == 200) {
        NSTimeInterval maxAge = BRMaxAgeForResponse(r.responseHeaders, r.setCookieHeaders.count > 0);
        long long declared = [r.responseHeaders[@"content-length"] longLongValue];
        // (the body is gathered in memory until it is stored: big ones only for text, which is also what gets rewritten;
        // pictures, sounds and videos up to 2 MB)
        NSString *type = [r.responseHeaders[@"content-type"] lowercaseString] ?: @"";
        BOOL text = [type hasPrefix:@"text/"] || [type rangeOfString:@"javascript"].location != NSNotFound || [type rangeOfString:@"json"].location != NSNotFound ||
                    [type rangeOfString:@"xml"].location != NSNotFound || !type.length;
        self.cacheLimit = text ? BRMaxCacheableBody : 2 * 1024 * 1024;
        if (maxAge >= 0 && declared <= (long long)self.cacheLimit) {
            self.cacheMaxAge = maxAge;
            self.cacheBody = [NSMutableData data];
        }
    }

    // Stylesheets and documents are rewritten for the old engine before WebKit sees them.
    NSString *ctype = [r.responseHeaders[@"content-type"] lowercaseString] ?: @"";
    NSString *kind = nil;
    // (a picture sent with another type is still a picture: DuckDuckGo's WebP illustrations come as text/html, which the
    // document rewriter garbled; browsers go by the bytes there)
    BOOL pictureRequest = self.request.mainDocumentURL && ![url isEqual:self.request.mainDocumentURL] && BRLooksLikeImageRequest(self.request);
    // (a document sent with an error status is a page all the same: a site's own 404 page, and weather.com's pages for
    // a locale it has no route for, the whole app with a 404; without the rewrite they had no polyfills: no globalThis)
    BOOL okStatus = status >= 200 && status < 300, errorPage = status >= 400 && status < 600;
    if ((okStatus || errorPage) && ![method isEqualToString:@"HEAD"] && [BRSettings cssFixEnabled] && [BRCSSRewriter shared].available) {
        NSString *path = [url.path lowercaseString] ?: @"";
        NSString *accept = [BRHeader(self.request.allHTTPHeaderFields, @"Accept") lowercaseString] ?: @"";
        if ([ctype hasPrefix:@"text/css"]) kind = okStatus ? @"css" : nil;
        else if (([ctype hasPrefix:@"text/html"] || [ctype hasPrefix:@"application/xhtml+xml"]) && !pictureRequest) kind = @"html";
        else if (!ctype.length && [accept hasPrefix:@"text/css"] && okStatus) kind = @"css";
        (void)path;
        long long declared = [r.responseHeaders[@"content-length"] longLongValue];
        if (kind && declared > (long long)BRRewriteLimit(kind)) kind = nil;
    }
    // ES modules requested by the page's module loader (marker ?__brmod=1): registrations for the loader (a JSON module,
    // import ... with { type: 'json' }, goes to the loader as it is; a CSS module was rewritten as a stylesheet above)
    if (!kind && status >= 200 && status < 300 && ![method isEqualToString:@"HEAD"] && BRIsModuleRequest(url) && [BRSettings transpileEnabled] && [BRCSSRewriter shared].available &&
        [ctype rangeOfString:@"json"].location == NSNotFound) {
        long long declared = [r.responseHeaders[@"content-length"] longLongValue];
        if (declared <= (long long)BRMaxScriptRewriteBody) kind = @"jsmodule";
    }
    // scripts: ES2015+ syntax lowered to ES5 (jsfix.js); scripts the engine parses pass through unchanged
    if (!kind && status >= 200 && status < 300 && ![method isEqualToString:@"HEAD"] && [BRSettings transpileEnabled] && [BRCSSRewriter shared].available) {
        NSString *path = [url.path lowercaseString] ?: @"";
        BOOL script = [ctype rangeOfString:@"javascript"].location != NSNotFound || [ctype rangeOfString:@"ecmascript"].location != NSNotFound;
        if (!script && (!ctype.length || [ctype hasPrefix:@"text/plain"] || [ctype hasPrefix:@"application/octet-stream"]) &&
            ([path hasSuffix:@".js"] || [path hasSuffix:@".mjs"])) script = YES;
        long long declared = [r.responseHeaders[@"content-length"] longLongValue];
        if (script && declared <= (long long)BRMaxScriptRewriteBody) kind = @"js";
        else if (script) BRNoteTooBigScript(self.request, (unsigned long long)declared);
    }
    // WOFF2 fonts are decoded to TTF (no JavaScript involved, so this works even without the rewriter)
    if (!kind && status >= 200 && status < 300 && ![method isEqualToString:@"HEAD"]) {
        NSString *path = [url.path lowercaseString] ?: @"";
        if ([ctype hasPrefix:@"font/woff2"] || [ctype hasPrefix:@"application/font-woff2"] || [ctype hasPrefix:@"application/x-font-woff2"] ||
            [path hasSuffix:@".woff2"] || [url.absoluteString rangeOfString:@".woff2?"].location != NSNotFound) {
            long long declared = [r.responseHeaders[@"content-length"] longLongValue];
            if (declared <= (long long)BRMaxFontRewriteBody) kind = @"font";
        } else if ([ctype hasPrefix:@"font/woff"] || [ctype hasPrefix:@"application/font-woff"] || [ctype hasPrefix:@"application/x-font-woff"] ||
                   [path hasSuffix:@".woff"] || [url.absoluteString rangeOfString:@".woff?"].location != NSNotFound) {
            long long declared = [r.responseHeaders[@"content-length"] longLongValue];
            if (declared <= (long long)BRMaxFontRewriteBody) kind = @"woff";
        } else if ([ctype hasPrefix:@"font/ttf"] || [ctype hasPrefix:@"font/otf"] || [ctype hasPrefix:@"font/sfnt"] ||
                   [ctype hasPrefix:@"application/x-font-ttf"] || [ctype hasPrefix:@"application/x-font-opentype"] ||
                   [ctype hasPrefix:@"application/font-sfnt"] || [ctype hasPrefix:@"application/vnd.ms-opentype"] ||
                   [path hasSuffix:@".ttf"] || [path hasSuffix:@".otf"]) {
            // plain TrueType/OpenType: only variable fonts need work (variation tables are dropped)
            long long declared = [r.responseHeaders[@"content-length"] longLongValue];
            if (declared <= (long long)BRMaxFontRewriteBody) kind = @"sfnt";
        } else if ([ctype hasPrefix:@"image/webp"] || [path hasSuffix:@".webp"] || [url.absoluteString rangeOfString:@".webp?"].location != NSNotFound ||
                   (pictureRequest && ![ctype hasPrefix:@"image/"] && ![ctype hasPrefix:@"video/"] && ![ctype hasPrefix:@"audio/"])) {
            // (a picture of another declared type is converted only when its bytes are WebP)
            long long declared = [r.responseHeaders[@"content-length"] longLongValue];
            if (declared <= (long long)BRMaxImageRewriteBody) kind = @"webp";
        } else if ([ctype hasPrefix:@"image/jpeg"] || [ctype hasPrefix:@"image/jpg"] || [ctype hasPrefix:@"image/pjpeg"] || [ctype hasPrefix:@"image/png"]) {
            // a photo far bigger than the screen comes smaller (see BRImageConverter downscaledImageData); the files of
            // ordinary pictures are too small to hold one and pass as they come
            long long declared = [r.responseHeaders[@"content-length"] longLongValue];
            if (declared >= 200 * 1024 && declared <= (long long)BRMaxImageRewriteBody) kind = @"bigimage";
        }
    }
    // (told from the network's own headers: the response object is WebKit's once it has it, and reading its headers
    // on this thread while WebKit does crashed CFNetwork on idnes.cz)
    self.fontBody = [kind isEqualToString:@"font"] || [kind isEqualToString:@"woff"] || [kind isEqualToString:@"sfnt"] || BRIsFontType(ctype);
    BOOL mainHTML = (!self.request.mainDocumentURL || [url isEqual:self.request.mainDocumentURL]) && ([ctype hasPrefix:@"text/html"] || [ctype hasPrefix:@"application/xhtml+xml"]);
    if (mainHTML && ![kind isEqualToString:@"html"]) BRNotePageDocument(url, nil, (unsigned long long)MAX(0LL, [r.responseHeaders[@"content-length"] longLongValue]));
    if (kind) {
        self.rewriteKind = kind;
        self.rewriteBuffer = [NSMutableData data];
        self.pendingStatus = status;
        self.pendingHeaderFields = webKitFields;
        NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"charset\\s*=\\s*\"?([A-Za-z0-9_-]+)" options:0 error:NULL];
        NSTextCheckingResult *m = [re firstMatchInString:ctype options:0 range:NSMakeRange(0, ctype.length)];
        self.rewriteCharset = (m && m.numberOfRanges > 1) ? [ctype substringWithRange:[m rangeAtIndex:1]] : nil;
        return;   // didReceiveResponse follows once the rewritten body is ready
    }
    [self performOnClientThread:^{
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    }];
}

// The body grew beyond the rewrite limit: send what we have unchanged and stream the rest.
- (void)abandonRewrite
{
    NSData *buffered = self.rewriteBuffer;
    if ([self.rewriteKind isEqualToString:@"html"] && (!self.request.mainDocumentURL || [self.request.URL isEqual:self.request.mainDocumentURL]))
        BRNotePageDocument(self.request.URL, buffered, buffered.length);
    if ([self.rewriteKind hasPrefix:@"js"]) BRNoteTooBigScript(self.request, buffered.length);
    self.rewriteBuffer = nil;
    self.rewriteKind = nil;
    NSHTTPURLResponse *response = self.response;
    if (self.cacheBody) [self.cacheBody appendData:buffered];
    [self performOnClientThread:^{
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        if (buffered.length) [self.client URLProtocol:self didLoadData:buffered];
    }];
}

- (void)finishRewrite
{
    NSData *buffered = self.rewriteBuffer ?: [NSData data];
    self.rewriteBuffer = nil;
    NSString *kind = self.rewriteKind;
    // (a font or a picture whatever its type said, see BRSniffBinaryKind)
    if ([kind isEqualToString:@"html"] || [kind isEqualToString:@"css"] || [kind isEqualToString:@"js"]) {
        NSString *sniffed = BRSniffBinaryKind(buffered);
        if ([sniffed isEqualToString:@"binary"]) {
            NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:self.pendingStatus HTTPVersion:@"HTTP/1.1" headerFields:self.pendingHeaderFields];
            if (self.cacheBody && buffered.length <= BRMaxCacheableBody) [self storeHeaders:self.pendingHeaderFields status:self.pendingStatus data:buffered maxAge:self.cacheMaxAge];
            self.cacheBody = nil;
            [self performOnClientThread:^{
                [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
                if (buffered.length) [self.client URLProtocol:self didLoadData:buffered];
                [self.client URLProtocolDidFinishLoading:self];
            }];
            return;
        }
        if (sniffed) {
            BRLog(@"%@ as %@ by its bytes: %@", kind, sniffed, self.request.URL.absoluteString.length > 120 ? [self.request.URL.absoluteString substringToIndex:120] : self.request.URL.absoluteString);
            kind = self.rewriteKind = sniffed;
            if (![sniffed isEqualToString:@"webp"]) self.fontBody = YES;
        }
    }
    if ([kind isEqualToString:@"font"] || [kind isEqualToString:@"woff"] || [kind isEqualToString:@"sfnt"] || [kind isEqualToString:@"webp"] || [kind isEqualToString:@"bigimage"]) {
        // synchronous, on the worker thread
        BOOL isFont = [kind isEqualToString:@"font"];
        BOOL isWOFF = [kind isEqualToString:@"woff"];
        BOOL isSFNT = [kind isEqualToString:@"sfnt"];
        NSString *imageType = nil;
        NSData *converted = isFont ? [BRFontConverter ttfDataFromWOFF2:buffered] :
                            isWOFF ? [BRFontConverter ttfDataFromWOFF:buffered] :
                            isSFNT ? [BRFontConverter staticFontDataFromSFNT:buffered] :
                            [kind isEqualToString:@"bigimage"] ? [BRImageConverter downscaledImageData:buffered mimeType:&imageType] :
                            [BRImageConverter imageDataFromWebP:buffered mimeType:&imageType];
        NSMutableDictionary *f = [self.pendingHeaderFields mutableCopy] ?: [NSMutableDictionary dictionary];
        NSData *out = converted ?: buffered;
        if (converted && !isSFNT) BRSetHeaderField(f, @"Content-Type", (isFont || isWOFF) ? @"font/ttf" : imageType ?: @"image/png");
        BRSetHeaderField(f, @"Content-Length", [NSString stringWithFormat:@"%lu", (unsigned long)out.length]);
        NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:self.pendingStatus HTTPVersion:@"HTTP/1.1" headerFields:f];
        if (self.cacheBody && out.length <= BRMaxCacheableBody) [self storeHeaders:f status:self.pendingStatus data:out maxAge:self.cacheMaxAge];
        self.cacheBody = nil;
        [self performOnClientThread:^{
            [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
            if (out.length) [self.client URLProtocol:self didLoadData:out];
            [self.client URLProtocolDidFinishLoading:self];
        }];
        return;
    }
    // Google's tag scripts from the site's own host (see BRAdBlock): the stub instead of a minute of lowering
    if ([kind isEqualToString:@"js"] && [self adBlockApplies] && [BRAdBlock isTagManagerScript:buffered]) {
        [BRAdBlock noteTagScriptAtURL:self.request.URL];
        [BRAdBlock noteBlockedRequest];
        self.cacheBody = nil;
        [self serveBlockedResponseWithScript:[BRAdBlock tagScriptStub]];
        return;
    }
    NSString *charset = self.rewriteCharset;
    NSInteger status = self.pendingStatus;
    NSDictionary *fields = self.pendingHeaderFields;
    NSURL *url = self.request.URL;
    NSURL *page = self.request.mainDocumentURL ?: url;
    BOOL cacheable = (self.cacheBody != nil);
    NSTimeInterval maxAge = self.cacheMaxAge;
    self.cacheBody = nil;
    BOOL mainFrame = !self.request.mainDocumentURL || [url isEqual:self.request.mainDocumentURL];
    if (mainFrame && [kind isEqualToString:@"html"]) BRNotePageDocument(url, buffered, buffered.length);
    else if ([kind isEqualToString:@"html"]) BRLog(@"HTML subresource %@ (%lu KB, %@)", url.absoluteString.length > 160 ? [url.absoluteString substringToIndex:160] : url.absoluteString,
                                                 (unsigned long)(buffered.length >> 10), BRHeader(fields, @"Content-Type") ?: @"?");
    [[BRCSSRewriter shared] rewriteData:buffered kind:kind charset:charset pageURL:page sourceURL:BRURLWithoutModuleMarker(url) mainFrame:mainFrame completion:^(NSData *out, NSString *outCharset, BOOL keep) {
        if (self.stopped) return;
        // a worker's script starts with the worker polyfills (see BRWorkerMarker)
        if ([kind isEqualToString:@"js"] && BRIsWorkerRequest(url)) {
            NSMutableData *withPolyfills = [[@"try{importScripts(\"https://ios6-browser.invalid/worker-polyfills.js\");}catch(e){}\n" dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
            if (out) [withPolyfills appendData:out];
            out = withPolyfills;
        }
        NSMutableDictionary *f = [fields mutableCopy] ?: [NSMutableDictionary dictionary];
        NSString *ctype = BRHeader(f, @"Content-Type") ?: ([kind isEqualToString:@"css"] ? @"text/css" : [kind isEqualToString:@"js"] ? @"text/javascript" : @"text/html");
        NSRange semi = [ctype rangeOfString:@";"];
        NSString *mediaType = semi.location == NSNotFound ? ctype : [ctype substringToIndex:semi.location];
        if (outCharset.length) {
            BRSetHeaderField(f, @"Content-Type", [NSString stringWithFormat:@"%@; charset=%@", [mediaType stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]], outCharset]);
        }
        BRSetHeaderField(f, @"Content-Length", [NSString stringWithFormat:@"%lu", (unsigned long)out.length]);
        NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:f];
        // (a stand-in for this time only, e.g. a script left unlowered for lack of memory, is not cached)
        if (cacheable && keep && out.length <= BRMaxCacheableBody) [self storeHeaders:f status:status data:out maxAge:maxAge];
        [[BRCSSRewriter shared] registerManifestInData:out pageURL:page sourceURL:url];
        // (the page shim fetches the manifest from us: WebKit gets the text without it)
        NSData *body = [kind hasPrefix:@"js"] ? out : [BRCSSRewriter dataWithoutManifest:out];
        if (body.length != out.length) {
            BRSetHeaderField(f, @"Content-Length", [NSString stringWithFormat:@"%lu", (unsigned long)body.length]);
            response = [[NSHTTPURLResponse alloc] initWithURL:url statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:f];
        }
        [self performOnClientThread:^{
            [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
            if (body.length) [self.client URLProtocol:self didLoadData:body];
            [self.client URLProtocolDidFinishLoading:self];
        }];
    }];
}

- (void)handleData:(NSData *)chunk
{
    if (self.stopped || self.done) return;
    self.receivedBytes += chunk.length;
    if (self.rewriteBuffer) {
        [self.rewriteBuffer appendData:chunk];
        if (self.rewriteBuffer.length > BRRewriteLimit(self.rewriteKind)) [self abandonRewrite];
        return;
    }
    if (self.cacheBody) {
        if (self.cacheBody.length + chunk.length > self.cacheLimit) self.cacheBody = nil;
        else [self.cacheBody appendData:chunk];
    }
    [self performOnClientThread:^{
        [self.client URLProtocol:self didLoadData:chunk];
    }];
}

- (void)handleComplete:(NSError *)error
{
    [self noteFinishedForProgress];
    if (self.stopped || self.done) return;
    self.done = YES;
    if (error) {
        NSError *urlError = BRURLErrorFromError(error, self.request.URL);
        BRLog(@"%@ %@ failed: %@", self.request.HTTPMethod, self.request.URL.absoluteString, error.localizedDescription);
        [self performOnClientThread:^{
            [self.client URLProtocol:self didFailWithError:urlError];
        }];
        return;
    }
    // cut off by a closed or reset connection: shown, never cached (every store below and in finishRewrite goes by
    // cacheBody)
    if (self.httpRequest.bodyTruncated) self.cacheBody = nil;
    if (self.rewriteBuffer) {
        [self finishRewrite];
        return;
    }
    if (self.cacheBody && self.responseFields) [self storeHeaders:self.responseFields status:self.responseStatus data:self.cacheBody maxAge:self.cacheMaxAge rewritten:NO];
    self.cacheBody = nil;
    [self performOnClientThread:^{
        [self.client URLProtocolDidFinishLoading:self];
    }];
}

#pragma mark - Cache

- (void)serveCachedResponse:(NSCachedURLResponse *)cached
{
    self.done = YES;
    NSHTTPURLResponse *stored = (NSHTTPURLResponse *)cached.response;
    NSData *data = cached.data;
    // (WebKit gets a response of its own, see storeHeaders; never with cookies to set)
    NSMutableDictionary *f = [stored.allHeaderFields mutableCopy] ?: [NSMutableDictionary dictionary];
    BRSetHeaderField(f, @"Set-Cookie", nil);
    BRSetHeaderField(f, @"Set-Cookie2", nil);
    NSString *cachedType = [BRHeader(f, @"Content-Type") lowercaseString] ?: @"";
    if ([cachedType hasPrefix:@"text/html"] && (!self.request.mainDocumentURL || [self.request.URL isEqual:self.request.mainDocumentURL]))
        BRNotePageDocument(self.request.URL, data, data.length);
    if ([cachedType hasPrefix:@"text/css"] || [cachedType hasPrefix:@"text/html"]) {
        NSTimeInterval m0 = [NSDate timeIntervalSinceReferenceDate];
        [[BRCSSRewriter shared] registerManifestInData:data pageURL:self.request.mainDocumentURL ?: self.request.URL sourceURL:self.request.URL];
        NSData *body = [BRCSSRewriter dataWithoutManifest:data];
        if (body.length != data.length) {
            BRSetHeaderField(f, @"Content-Length", [NSString stringWithFormat:@"%lu", (unsigned long)body.length]);
            data = body;
        }
        NSTimeInterval took = [NSDate timeIntervalSinceReferenceDate] - m0;
        if (took > 0.3) BRLog(@"Cached %@ manifest took %.1f s (%lu KB): %@", [cachedType hasPrefix:@"text/css"] ? @"stylesheet" : @"document", took,
                              (unsigned long)(cached.data.length >> 10), self.request.URL.lastPathComponent ?: @"?");
    }
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:stored.URL ?: self.request.URL statusCode:stored.statusCode HTTPVersion:@"HTTP/1.1" headerFields:f];
    [self performOnClientThread:^{
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        if (data.length) [self.client URLProtocol:self didLoadData:data];
        [self.client URLProtocolDidFinishLoading:self];
    }];
}

- (void)storeHeaders:(NSDictionary *)headers status:(NSInteger)status data:(NSData *)data maxAge:(NSTimeInterval)maxAge
{
    [self storeHeaders:headers status:status data:data maxAge:maxAge rewritten:YES];
}

// The cache gets a response object of its own, made from the headers here: NSURLCache archives the one it is given on
// its own threads whenever it likes, and WebKit reads the one it was given on its own thread; the same object in both
// crashed CFNetwork (KERN_INVALID_ADDRESS 0x10 / 0x14 on idnes.cz and seznam.cz). serveCachedResponse gives WebKit a copy
// in turn.
- (void)storeHeaders:(NSDictionary *)headers status:(NSInteger)status data:(NSData *)data maxAge:(NSTimeInterval)maxAge rewritten:(BOOL)rewritten
{
    if (!headers || !data || !self.request.URL) return;
    if ([BRSettings privateMode]) return;   // private browsing leaves nothing on disk
    if (self.credentialedEntry) return;     // (made without the credentials the kept one was made with: see startLoading)
    // (cookies are the jar's alone: kept here, a session's cookies stayed on disk after logout or "Clear cookies", and a
    // response served from the cache would set them again)
    NSMutableDictionary *kept = [headers mutableCopy];
    BRSetHeaderField(kept, @"Set-Cookie", nil);
    BRSetHeaderField(kept, @"Set-Cookie2", nil);
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:kept];
    if (!response) return;
    BOOL credentialed = BRHeader(self.sentHeaders, @"Cookie") != nil || BRHeader(self.sentHeaders, @"Authorization") != nil;
    NSDictionary *info = @{ BRCacheStoredAtKey: @([NSDate timeIntervalSinceReferenceDate]), BRCacheMaxAgeKey: @(maxAge),
                            BRCacheRewriteTagKey: self.fontBody ? BRFontCacheTag : rewritten ? [BRCSSRewriter rewriteTag] : BRRawCacheTag(),
                            BRCacheCredentialedKey: @(credentialed) };
    // (the body is not changed after this: the request lets go of it)
    NSCachedURLResponse *c = [[NSCachedURLResponse alloc] initWithResponse:response data:data userInfo:info storagePolicy:NSURLCacheStorageAllowed];
    BRStoreLater(c, self.request);   // (written once no lookup waits, see BRStoreLater)
}

- (void)serveFontDataURL
{
    NSURL *url = self.request.URL;
    NSString *s = url.absoluteString;
    NSRange comma = [s rangeOfString:@","];
    NSData *font = nil;
    if (comma.location != NSNotFound) {
        NSString *meta = [[s substringToIndex:comma.location] lowercaseString], *payload = [s substringFromIndex:comma.location + 1];
        if ([meta hasSuffix:@";base64"]) font = BRBase64Decode([payload stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding] ?: payload);
        else font = [[payload stringByReplacingPercentEscapesUsingEncoding:NSISOLatin1StringEncoding] dataUsingEncoding:NSISOLatin1StringEncoding];
    }
    NSData *ttf = font.length ? [BRFontConverter ttfDataFromWOFF2:font] : nil;
    NSData *out = ttf ?: font;
    id<NSURLProtocolClient> client = self.client;
    if (!out.length) {
        [client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotDecodeContentData userInfo:nil]];
        return;
    }
    NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url MIMEType:ttf ? @"font/ttf" : @"application/octet-stream" expectedContentLength:(NSInteger)out.length textEncodingName:nil];
    [client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [client URLProtocol:self didLoadData:out];
    [client URLProtocolDidFinishLoading:self];
}

- (void)serveWebPDataURL
{
    NSURL *url = self.request.URL;
    NSString *s = url.absoluteString;
    NSRange comma = [s rangeOfString:@","];
    NSData *webp = nil;
    if (comma.location != NSNotFound) {
        NSString *meta = [[s substringToIndex:comma.location] lowercaseString], *payload = [s substringFromIndex:comma.location + 1];
        if ([meta hasSuffix:@";base64"]) webp = BRBase64Decode([payload stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding] ?: payload);
        else webp = [[payload stringByReplacingPercentEscapesUsingEncoding:NSISOLatin1StringEncoding] dataUsingEncoding:NSISOLatin1StringEncoding];
    }
    NSString *mime = nil;
    NSData *image = webp.length ? [BRImageConverter imageDataFromWebP:webp mimeType:&mime] : nil;
    id<NSURLProtocolClient> client = self.client;
    if (!image.length) {
        [client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCannotDecodeContentData userInfo:nil]];
        return;
    }
    BRLog(@"WebP data: URL decoded (%lu -> %lu bytes %@)", (unsigned long)webp.length, (unsigned long)image.length, mime ?: @"image/png");
    NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url MIMEType:mime ?: @"image/png" expectedContentLength:(NSInteger)image.length textEncodingName:nil];
    [client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    [client URLProtocol:self didLoadData:image];
    [client URLProtocolDidFinishLoading:self];
}

- (void)serveInternalResource
{
    NSString *path = self.request.URL.path ?: @"";
    NSData *body = nil;
    NSString *type = @"text/javascript; charset=utf-8";
    NSString *cacheControl = @"max-age=31536000";
    NSInteger status = 200;   // (another one answers with an empty body)
    if (([path hasPrefix:@"/polyfills"] || [path hasPrefix:@"/__br_polyfills"]) && [path hasSuffix:@".js"]) {
        body = [BRCSSRewriter polyfillBundle];
    } else if ([path isEqualToString:@"/worker-polyfills.js"]) {
        body = [BRCSSRewriter workerPolyfills];
    } else if ([path isEqualToString:@"/manifest"]) {
        // :has() / @container entries collected for the requesting page (see BRCSSRewriter: kept under the request's main
        // document). For that page's own origin only, or any page could read which pages were open lately, their
        // stylesheets and their variables:
        // - ?doc= names the main document or another address of its origin: after history.pushState the page's address
        //   changes, the main document's does not (WebKit's first party for cookies), and the entries are kept under it;
        // - the Origin WebKit puts on the shim's request (cross-origin; no page can set it) is the main document's, so a
        //   frame of another origin that names the top page (document.referrer) gets 403 too. (A frame of the page's own
        //   origin gets the page's entries, its own stylesheets' among them.)
        NSString *query = self.request.URL.query ?: @"";
        NSString *doc = nil, *since = nil;
        for (NSString *pair in [query componentsSeparatedByString:@"&"]) {
            if ([pair hasPrefix:@"doc="]) doc = [[pair substringFromIndex:4] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
            else if ([pair hasPrefix:@"since="]) since = [[pair substringFromIndex:6] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
        }
        NSURL *mainURL = self.request.mainDocumentURL;
        NSString *page = mainURL.absoluteString.length ? BRWithoutFragment(mainURL.absoluteString) : nil;
        NSString *mainOrigin = BRWebOrigin(mainURL), *origin = BRHeader(self.request.allHTTPHeaderFields, @"Origin");
        BOOL docOK = page && doc && ([BRWithoutFragment(doc) isEqualToString:page] ||
                                    (mainOrigin && [BRWebOrigin([NSURL URLWithString:doc]) isEqualToString:mainOrigin]));
        BOOL originOK = !origin.length || !mainOrigin || [BRWebOrigin([NSURL URLWithString:origin]) isEqualToString:mainOrigin];
        if (!docOK || !originOK) status = 403;
        else body = [[BRCSSRewriter shared] manifestJSONForPageURLString:page since:since];
        type = @"application/json; charset=utf-8";
        cacheControl = @"no-store";
    } else if ([path isEqualToString:@"/random"]) {
        // crypto.getRandomValues of workers (worker-shims.js: a synchronous request, the bytes pooled there): n bytes of
        // the system's secure generator as lowercase hex. A worker has no other source but Math.random.
        NSInteger n = 0;
        for (NSString *pair in [(self.request.URL.query ?: @"") componentsSeparatedByString:@"&"])
            if ([pair hasPrefix:@"n="]) n = [[pair substringFromIndex:2] integerValue];
        BOOL fits = n >= 1 && n <= 65536;
        body = fits ? BRRandomHex((size_t)n) : nil;
        if (!body) status = fits ? 500 : 400;
        type = @"text/plain";
        cacheControl = @"no-store";
    } else if ([path isEqualToString:@"/state"]) {
        // what the page shim cannot see itself: whether the page is drawn with accelerated compositing (without it iOS 6
        // scrolls boxes with one finger only in the shim's own way), whether its ads are blocked (their empty boxes go)
        NSString *pageHost = self.request.mainDocumentURL.host;
        BOOL ads = [BRSettings adBlockEnabled] && ![BRSettings adBlockDisabledForHost:pageHost];
        body = [[NSString stringWithFormat:@"{\"compositing\":%@,\"adblock\":%@}", [BRMemory compositing] ? @"true" : @"false", ads ? @"true" : @"false"]
                dataUsingEncoding:NSUTF8StringEncoding];
        type = @"application/json; charset=utf-8";
        cacheControl = @"no-store";
    } else if ([path isEqualToString:@"/mediaproxy"]) {
        // a media file the system's player could not load (current TLS only): the same file through the app's network
        // layer, from the local proxy (see BRMediaProxy)
        NSString *u = nil;
        for (NSString *pair in [(self.request.URL.query ?: @"") componentsSeparatedByString:@"&"])
            if ([pair hasPrefix:@"u="]) u = [[pair substringFromIndex:2] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
        NSURL *mediaURL = u.length ? [NSURL URLWithString:u] : nil;
        NSString *scheme = [mediaURL.scheme lowercaseString];
        NSString *proxied = ([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"]) ? [[BRMediaProxy shared] proxyURLStringForURL:mediaURL pageURL:self.request.mainDocumentURL] : nil;
        body = [NSJSONSerialization dataWithJSONObject:@{ @"url": proxied ?: [NSNull null] } options:0 error:NULL];
        type = @"application/json; charset=utf-8";
        cacheControl = @"no-store";
    } else if ([path isEqualToString:@"/wsproxy"]) {
        // a WebSocket the page opens: the local address WebCore connects to instead, the socket itself going through the
        // app's network layer (see BRMediaProxy)
        NSString *u = nil;
        for (NSString *pair in [(self.request.URL.query ?: @"") componentsSeparatedByString:@"&"])
            if ([pair hasPrefix:@"u="]) u = [[pair substringFromIndex:2] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
        NSURL *socketURL = u.length ? [NSURL URLWithString:u] : nil;
        NSString *scheme = [socketURL.scheme lowercaseString];
        NSString *local = ([scheme isEqualToString:@"wss"] || [scheme isEqualToString:@"ws"]) ? [[BRMediaProxy shared] webSocketURLStringForURL:socketURL pageURL:self.request.mainDocumentURL] : nil;
        body = [NSJSONSerialization dataWithJSONObject:@{ @"url": local ?: [NSNull null] } options:0 error:NULL];
        type = @"application/json; charset=utf-8";
        cacheControl = @"no-store";
    } else if ([path hasPrefix:@"/speech/"]) {
        // speechSynthesis of the page shim: info (voices), speak / cancel / pause / resume, and the events poll
        NSMutableDictionary *q = [NSMutableDictionary dictionary];
        for (NSString *pair in [(self.request.URL.query ?: @"") componentsSeparatedByString:@"&"]) {
            NSRange eq = [pair rangeOfString:@"="];
            if (eq.location == NSNotFound) continue;
            NSString *value = [[pair substringFromIndex:eq.location + 1] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
            if (value) q[[pair substringToIndex:eq.location]] = value;
        }
        BRSpeech *speech = [BRSpeech shared];
        NSString *action = [path substringFromIndex:8];
        if ([action isEqualToString:@"info"]) body = [speech infoJSON];
        else if ([action isEqualToString:@"events"]) body = [speech eventsJSONSince:[q[@"since"] integerValue]];
        else {
            if ([action isEqualToString:@"speak"]) {
                [speech speak:q[@"text"] utteranceId:q[@"id"] lang:q[@"lang"]
                         rate:q[@"rate"] ? [q[@"rate"] floatValue] : 1 pitch:q[@"pitch"] ? [q[@"pitch"] floatValue] : 1
                       volume:q[@"volume"] ? [q[@"volume"] floatValue] : 1];
            }
            else if ([action isEqualToString:@"cancel"]) [speech cancel];
            else if ([action isEqualToString:@"pause"]) [speech pause];
            else if ([action isEqualToString:@"resume"]) [speech resume];
            body = [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
        }
        type = @"application/json; charset=utf-8";
        cacheControl = @"no-store";
    } else if ([path hasPrefix:@"/dev/"] && [[NSUserDefaults standardUserDefaults] boolForKey:@"BRDevPages"]) {
        // test pages on the device (a debugging switch, off unless set over SSH): files copied to tmp/devpages are served
        // like a web page, so they get the rewriter and the polyfills of the real engine
        NSString *name = [path substringFromIndex:5];
        NSString *ext = [[name pathExtension] lowercaseString];
        NSDictionary *types = @{ @"html": @"text/html; charset=utf-8", @"js": @"text/javascript; charset=utf-8", @"css": @"text/css; charset=utf-8",
                                 @"json": @"application/json", @"bin": @"application/octet-stream", @"txt": @"text/plain; charset=utf-8" };
        if (name.length && [name rangeOfString:@"/"].location == NSNotFound && ![name hasPrefix:@"."] && types[ext]) {
            NSString *file = [[NSTemporaryDirectory() stringByAppendingPathComponent:@"devpages"] stringByAppendingPathComponent:name];
            body = [NSData dataWithContentsOfFile:file];
            type = types[ext];
            cacheControl = @"no-store";
            // (scripts too, as the network layer takes them: lowered, a worker's with the worker polyfills)
            BOOL devHTML = [ext isEqualToString:@"html"] && [BRSettings cssFixEnabled], devJS = [ext isEqualToString:@"js"] && [BRSettings transpileEnabled];
            if (body && (devHTML || devJS) && [BRCSSRewriter shared].available) {
                self.done = YES;
                self.rewriteKind = devHTML ? @"html" : @"js";
                self.rewriteBuffer = [body mutableCopy];
                self.rewriteCharset = @"utf-8";
                self.pendingStatus = 200;
                self.pendingHeaderFields = @{ @"Content-Type": type, @"Cache-Control": @"no-store" };
                [self finishRewrite];
                return;
            }
        }
    } else if ([path hasPrefix:@"/__br_inline-"] && [path hasSuffix:@".js"]) {
        // a big inline script of a document, set aside by the rewriter: lowered like a script file (the transpiler
        // keeps the result by its text)
        body = [BRCSSRewriter inlineScriptNamed:[[path substringFromIndex:13] stringByDeletingPathExtension]];
        cacheControl = @"no-store";
        if (body && [BRSettings transpileEnabled] && [BRCSSRewriter shared].available) {
            self.done = YES;
            self.rewriteKind = @"js";
            self.rewriteBuffer = [body mutableCopy];
            self.rewriteCharset = @"utf-8";
            self.pendingStatus = 200;
            self.pendingHeaderFields = @{ @"Content-Type": type, @"Cache-Control": @"no-store" };
            [self finishRewrite];
            return;
        }
    } else if ([path isEqualToString:@"/lower"]) {
        // the text of a classic script a page inserts (shims-extra.js lowerClassic): lowered by the transpiler, which keeps
        // it by the text; an empty body when it needs nothing, an error when it could not be lowered (the page tries itself).
        // Answered here, blocking: the page asks synchronously, and a synchronous request runs on the WebThread, whose
        // loop would otherwise time the request out after some 10 s (Discord's 5.5 MB lazy factory: NETWORK_ERR 101)
        BOOL tooBig = NO, failed = NO;
        NSData *src = BRReadBodyUpTo(self.request, BRMaxLowerBody, &tooBig);
        if (tooBig) status = 413;
        else {
            body = src.length ? [[BRCSSRewriter shared] loweredPageScript:src failed:&failed] : nil;
            if (!body && !failed) body = [NSData data];
        }
        type = @"text/plain; charset=utf-8";
        cacheControl = @"no-store";
    } else if ([path isEqualToString:@"/cssrun"]) {
        // a style a page's script inserted, rewritten by the app's rewriter (blocking, as /lower); an error status while
        // the rewriter is busy: the page does it itself
        BOOL tooBig = NO;
        NSData *src = BRReadBodyUpTo(self.request, BRMaxCSSRunBody, &tooBig);
        if (tooBig) status = 413;
        else body = [[BRCSSRewriter shared] runtimeStyleResult:src];
        type = @"application/json; charset=utf-8";
        cacheControl = @"no-store";
    } else if ([path hasPrefix:@"/lazy/"]) {
        // /lazy/<crc>-<length>/<n>.js: factory n of a webpack chunk the transpiler kept for later (a synchronous request
        // of the page's stub, answered when it is lowered; blocking, as /lower)
        NSArray *comps = [[path substringFromIndex:6] componentsSeparatedByString:@"/"];
        NSString *base = comps.count == 2 ? comps[0] : nil;
        NSString *file = comps.count == 2 ? comps[1] : nil;
        if (base.length && [base rangeOfString:@"^[0-9a-f]+-[0-9a-f]+$" options:NSRegularExpressionSearch].location != NSNotFound &&
            [file rangeOfString:@"^[0-9]+\\.js$" options:NSRegularExpressionSearch].location != NSNotFound)
            body = [[BRCSSRewriter shared] lazyModuleForBase:base index:[file integerValue]];
        cacheControl = @"no-store";
    } else if ([path hasPrefix:@"/indexeddbshim"] && [path hasSuffix:@".js"]) {
        NSString *file = [[NSBundle mainBundle] pathForResource:@"indexeddbshim" ofType:@"js" inDirectory:@"js"];
        body = file ? [NSData dataWithContentsOfFile:file] : nil;
    } else if ([path isEqualToString:@"/browserscore.js"] || [path isEqualToString:@"/cssfix.js"] || [path isEqualToString:@"/jsfix.js"]) {
        // the browserscore runner, the CSS rewriter itself (the runner asks it what a page would get; a page loads it
        // when its scripts insert styles: the minified copy in js/, half the text to parse) and the transpiler (for
        // tests on the device)
        NSString *name = [path.lastPathComponent stringByDeletingPathExtension];
        NSString *file = [[NSBundle mainBundle] pathForResource:name ofType:@"js" inDirectory:@"js"] ?: [[NSBundle mainBundle] pathForResource:name ofType:@"js"];
        body = file ? [NSData dataWithContentsOfFile:file] : nil;
    } else if ([path isEqualToString:@"/acorn.js"] || [path isEqualToString:@"/unicode-props.js"]) {
        NSString *file = [[NSBundle mainBundle] pathForResource:[path.lastPathComponent stringByDeletingPathExtension] ofType:@"js" inDirectory:@"js"];
        body = file ? [NSData dataWithContentsOfFile:file] : nil;
    } else if ([path isEqualToString:@"/browserscore-features.js"]) {
        // flattened browserscore/features definitions, generated at build time
        NSString *file = [[NSBundle mainBundle] pathForResource:@"browserscore-features" ofType:@"js" inDirectory:@"js"];
        body = file ? [NSData dataWithContentsOfFile:file] : nil;
    } else if ([path isEqualToString:@"/csstest.html"] || [path isEqualToString:@"/browserscore.html"]) {
        // bundled test pages served like web pages: they go through the CSS rewriter and get the polyfills
        NSString *file = [[NSBundle mainBundle] pathForResource:[path.lastPathComponent stringByDeletingPathExtension] ofType:@"html"];
        body = file ? [NSData dataWithContentsOfFile:file] : nil;
        type = @"text/html; charset=utf-8";
        if (body && [BRSettings cssFixEnabled] && [BRCSSRewriter shared].available) {
            self.done = YES;
            self.rewriteKind = @"html";
            self.rewriteBuffer = [body mutableCopy];
            self.rewriteCharset = @"utf-8";
            self.pendingStatus = 200;
            self.pendingHeaderFields = @{ @"Content-Type": type, @"Cache-Control": @"no-store" };
            [self finishRewrite];
            return;
        }
    }
    [self deliverInternalBody:body type:type cacheControl:cacheControl status:status];
}

// an internal resource's answer (any thread): the body, or a failure when there is none. A status other than 200 is a
// refusal the page shim reads (an empty body): readable from the pages' own origins, as the answers are.
- (void)deliverInternalBody:(NSData *)body type:(NSString *)type cacheControl:(NSString *)cacheControl status:(NSInteger)status
{
    self.done = YES;
    if (status != 200) {
        body = [NSData data];
        type = @"text/plain";
        cacheControl = @"no-store";
    }
    if (!body) {
        [self failWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist
                                            userInfo:@{ NSURLErrorFailingURLStringErrorKey: self.request.URL.absoluteString ?: @"" }]];
        return;
    }
    NSDictionary *fields = @{ @"Content-Type": type, @"Content-Length": [NSString stringWithFormat:@"%lu", (unsigned long)body.length],
                              @"Cache-Control": cacheControl, @"Access-Control-Allow-Origin": @"*" };
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:fields];
    BOOL noStore = [cacheControl isEqualToString:@"no-store"];
    [self performOnClientThread:^{
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:noStore ? NSURLCacheStorageNotAllowed : NSURLCacheStorageAllowedInMemoryOnly];
        [self.client URLProtocol:self didLoadData:body];
        [self.client URLProtocolDidFinishLoading:self];
    }];
}

// A load that is refused outright: the status, no body, nothing for other origins or to be taken for another type
- (void)deliverEmptyStatus:(NSInteger)status
{
    self.done = YES;
    NSDictionary *fields = @{ @"Content-Type": @"text/plain", @"Content-Length": @"0", @"Cache-Control": @"no-store", @"X-Content-Type-Options": @"nosniff" };
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:fields];
    [self performOnClientThread:^{
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        [self.client URLProtocolDidFinishLoading:self];
    }];
}

// Empty script / stylesheet or a blank image, so the page does not wait or show broken elements.
// ads and trackers: this request is not made (and a page's own requests to its main document never are)
- (BOOL)adBlockApplies
{
    NSURLRequest *request = self.request;
    BOOL subresource = request.mainDocumentURL && ![request.URL isEqual:request.mainDocumentURL];
    return subresource && [BRSettings adBlockEnabled] && ![BRSettings adBlockDisabledForHost:request.mainDocumentURL.host];
}

- (void)serveBlockedResponse
{
    [self serveBlockedResponseWithScript:nil];
}

// script: the body when a script is expected (see BRAdBlock tagScriptStub), nil for an empty one
- (void)serveBlockedResponseWithScript:(NSData *)script
{
    NSString *accept = BRHeader(self.request.allHTTPHeaderFields, @"Accept") ?: @"";
    NSData *body = script ?: [NSData data];
    NSString *type = @"text/javascript";
    if ([accept rangeOfString:@"image"].location != NSNotFound || BRLooksLikeImageRequest(self.request)) {
        body = [NSData dataWithBytes:BRBlankGIF length:sizeof(BRBlankGIF)];
        type = @"image/gif";
    } else if ([accept rangeOfString:@"text/css"].location != NSNotFound) {
        type = @"text/css";
        body = [NSData data];
    } else if ([accept rangeOfString:@"text/html"].location != NSNotFound) {
        type = @"text/html";
        body = [NSData data];
    }
    NSDictionary *fields = @{ @"Content-Type": type, @"Content-Length": [NSString stringWithFormat:@"%lu", (unsigned long)body.length], @"Cache-Control": @"no-store" };
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:200 HTTPVersion:@"HTTP/1.1" headerFields:fields];
    self.done = YES;
    [self performOnClientThread:^{
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
        if (body.length) [self.client URLProtocol:self didLoadData:body];
        [self.client URLProtocolDidFinishLoading:self];
    }];
}

- (void)failWithError:(NSError *)error
{
    self.done = YES;
    [self performOnClientThread:^{
        [self.client URLProtocol:self didFailWithError:error];
    }];
}

@end

@implementation BRURLCache

- (void)removeAllCachedResponses
{
    [BRURLProtocol dropPendingCacheStores];
    [super removeAllCachedResponses];
}

@end
