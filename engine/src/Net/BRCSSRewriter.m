#import "BRCSSRewriter.h"
#import "BRJSEngine.h"
#import "BRSettings.h"
#import "BRCommon.h"
#import "BRMemory.h"

#include <zlib.h>
#include <CommonCrypto/CommonDigest.h>

static const NSUInteger BRMaxPagesRemembered = 8;
// seconds without work before an engine gives its whole heap back (the rewriter's engine only above the given
// resident size: every document needs it, and reloading cssfix.js costs half a second)
static const NSTimeInterval BRTranspilerIdleRelease = 6;
static const NSTimeInterval BRRewriterIdleRelease = 15;
static const long BRRewriterIdleReleaseAboveMB = 170;
// what the system should have available before heavy work starts (MB): a floor plus a share of the input size
// (measured: lowering a 1-1.5 MB script function by function takes 45-75 MB, Vimeo's 3.3 MB chunk 125 MB while the
// page kept growing next to it, mapy.com's 4.4 MB bundle 94 MB: past 1.5 MB a script costs less per MB, see
// BRScriptRoomMB; rewriting takes less)
static const long BRRoomFloorMB = 55, BRRoomPerMBScript = 45, BRRoomPerMBDocument = 25;
// A big script is looked at first (JSFix.plan: the engine's parse of it and, when that fails, the search for the few
// pieces that need lowering; seznam.cz's 4.4 MB "ES5" bundle then took 7 s instead of 52 s): that and a lowering in
// pieces take less room than a whole one.
static const NSUInteger BRPlanMinBytes = 192 * 1024;
static long BRScriptPlanMB(long bytes)
{
    return 15 + (long)((long long)bytes * 18 / (1024 * 1024));
}
static long BRScriptRoomMB(long bytes)
{
    long small = (long)((long long)bytes * BRRoomPerMBScript / (1024 * 1024)), big = 30 + (long)((long long)bytes * 25 / (1024 * 1024));
    return MIN(small, big);
}
// A small script takes little room of its own (the tree of a 7 KB module is well under a megabyte): a lower floor, so it
// does not wait a minute for room it does not need and then stay unlowered (stripe.com: a 7 KB module waited 60 s for
// 55 MB with 52 available, and the page stood still behind it).
static long BRScriptFloorMB(long bytes)
{
    return bytes < 64 * 1024 ? 30 : BRRoomFloorMB;
}
// A script lowered a group of statements at a time (jsfix.js pieces) holds the tree of one group only (128 KB): its
// text in and out, and a lower floor (jsfix.js PIECES_FLOOR_MB: it stops below 32 MB, and goes on from there when the
// app has waited for BRPiecesResumeMB).
static const NSUInteger BRPiecesMinBytes = 384 * 1024;
static const long BRPiecesFloorMB = 32, BRPiecesResumeMB = 44;
static long BRScriptPiecesMB(long bytes)
{
    return 12 + (long)((long long)bytes * 6 / (1024 * 1024));
}
// bumped when a page load is stopped for lack of memory: queued work of that page is dropped
static volatile NSUInteger g_workGeneration;
static NSString *BRPageKey(NSURL *url);
// The bundle is cached by pages for a year, so its URL carries a checksum of the content: a new
// build with new polyfills gets a new URL instead of the old cached bundle. It is a path on the page's own host
// (answered by BRURLProtocol for every host): from another origin, an error thrown in a callback run by the
// polyfills (promise jobs, timers) reached the page only as "Script error.".
static NSString *g_polyfillURL;

static NSStringEncoding BREncodingForCharset(NSString *charset)
{
    if (!charset.length) return 0;
    CFStringEncoding cf = CFStringConvertIANACharSetNameToEncoding((__bridge CFStringRef)charset);
    if (cf == kCFStringEncodingInvalidId) return 0;
    return CFStringConvertEncodingToNSStringEncoding(cf);
}

// charset declared inside the document itself (<meta charset>, <meta http-equiv>, @charset)
static NSString *BRSniffCharset(NSData *data, NSString *kind)
{
    NSUInteger len = MIN(data.length, (NSUInteger)4096);
    NSString *head = [[NSString alloc] initWithBytes:data.bytes length:len encoding:NSISOLatin1StringEncoding];
    if (!head) return nil;
    NSRegularExpression *re;
    if ([kind isEqualToString:@"css"]) {
        re = [NSRegularExpression regularExpressionWithPattern:@"^@charset\\s+\"([A-Za-z0-9_-]+)\"" options:0 error:NULL];
    } else {
        re = [NSRegularExpression regularExpressionWithPattern:@"charset\\s*=\\s*[\"']?\\s*([A-Za-z0-9_-]+)" options:NSRegularExpressionCaseInsensitive error:NULL];
    }
    NSTextCheckingResult *m = [re firstMatchInString:head options:0 range:NSMakeRange(0, head.length)];
    if (!m || m.numberOfRanges < 2) return nil;
    return [head substringWithRange:[m rangeAtIndex:1]];
}

static NSString *BRDecode(NSData *data, NSString *charset, NSString **usedCharset)
{
    NSString *s = nil;
    NSStringEncoding enc = BREncodingForCharset(charset);
    if (enc) {
        s = [[NSString alloc] initWithData:data encoding:enc];
        if (s) { *usedCharset = charset; return s; }
    }
    s = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (s) { *usedCharset = @"utf-8"; return s; }
    s = [[NSString alloc] initWithData:data encoding:NSWindowsCP1252StringEncoding];
    if (s) { *usedCharset = @"windows-1252"; return s; }
    *usedCharset = @"iso-8859-1";
    return [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
}

// Caches/transpiled/<text key>-<jsfix tag>.js: lowered scripts by content (an empty file: nothing to lower)
static NSString *BRTranspiledDirectory(void)
{
    NSString *caches = [NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES) firstObject];
    return [caches stringByAppendingPathComponent:@"transpiled"];
}

// The name of a text the results made from it are kept under, on disk and in memory - lowered scripts, rewritten
// styles, set-aside inline scripts, kept factories: the first half of its SHA-256 (over `more` too, when given) and its
// length. Every site's pages share these results, so the name must be one no page can give a text of its own: a
// CRC-32, as before, anyone can match, and a page could have put its code under the name of another site's script, to
// be run there.
static NSString *BRTextKey(NSData *data, NSData *more)
{
    CC_SHA256_CTX ctx;
    CC_SHA256_Init(&ctx);
    if (data.length) CC_SHA256_Update(&ctx, data.bytes, (CC_LONG)data.length);
    if (more.length) CC_SHA256_Update(&ctx, more.bytes, (CC_LONG)more.length);
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &ctx);
    static const char digits[] = "0123456789abcdef";
    char hex[33];
    for (int i = 0; i < 16; i++) {
        hex[2 * i] = digits[digest[i] >> 4];
        hex[2 * i + 1] = digits[digest[i] & 15];
    }
    hex[32] = 0;
    return [NSString stringWithFormat:@"%s-%lx", hex, (unsigned long)data.length];
}

// a checksum of jsfix.js: results of another version are not reused
static NSString *BRTranspileTag(void)
{
    static NSString *tag;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [[NSBundle mainBundle] pathForResource:@"jsfix" ofType:@"js"];
        NSData *d = path ? [NSData dataWithContentsOfFile:path] : nil;
        unsigned long crc = crc32(0L, Z_NULL, 0);
        if (d.length) crc = crc32(crc, (const Bytef *)d.bytes, (uInt)d.length);
        tag = [NSString stringWithFormat:@"%08lx", crc];
    });
    return tag;
}

// a checksum of both rewriters (jsfix.js and cssfix.js): the HTTP cache keeps bodies as they were rewritten, so a
// changed rewriter needs a cache of its own (see BRAppDelegate)
static NSString *BRRewriterTag(void)
{
    static NSString *tag;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        unsigned long crc = crc32(0L, Z_NULL, 0);
        for (NSString *name in @[@"jsfix", @"cssfix"]) {
            NSString *path = [[NSBundle mainBundle] pathForResource:name ofType:@"js"];
            NSData *d = path ? [NSData dataWithContentsOfFile:path] : nil;
            if (d.length) crc = crc32(crc, (const Bytef *)d.bytes, (uInt)d.length);
        }
        tag = [NSString stringWithFormat:@"%08lx", crc];
    });
    return tag;
}

// the text of factory n of a webpack chunk kept for later (base = the chunk's BRTextKey; see jsfix.js LAZY_*)
static NSString *BRLazyPartPath(NSString *base, long n)
{
    return [BRTranspiledDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"%@s%ld-%@.js", base, n, BRTranspileTag()]];
}

// the text of a document's inline script set aside by the rewriter (see cssfix.js fixScripts), nil for a bad name (the
// name is the text's BRTextKey, given in rewriteData)
static NSString *BRInlineScriptPath(NSString *name)
{
    if (!name.length || name.length > 48 || [name rangeOfString:@"^[0-9a-f]{32}-[0-9a-f]+$" options:NSRegularExpressionSearch].location == NSNotFound) return nil;
    return [BRTranspiledDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"inline-%@-%@.js", name, BRTranspileTag()]];
}

static void BRPruneTranspiled(void);
// Caches/transpiled grows with every page's scripts and styles: pruned at launch, and again whenever 16 MB more were
// written (a long session, or pages that send endless new texts to /lower and /cssrun, stays within the limit)
static void BRNoteTranspiledWrite(NSUInteger bytes)
{
    static unsigned long long written;
    BOOL prune = NO;
    @synchronized ([BRCSSRewriter class]) {
        written += bytes + 4096;   // (a file takes a block of the flash at least)
        if (written >= 16ull * 1024 * 1024) { written = 0; prune = YES; }
    }
    if (prune) dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_BACKGROUND, 0), ^{ @autoreleasepool { [BRCSSRewriter pruneTranspiledCache]; } });
}

@implementation BRCSSRewriter {
    NSMutableDictionary *_noRoom;       // script key -> when it did not fit in memory (not waited for again soon)
    BOOL _loaded;
    BOOL _loadFailed;
    BOOL _jsfixLoaded;                  // in the rewriter's engine (inline scripts of documents)
    BOOL _jsfixLoadedTranspiler;        // in the transpiler engine (script files)
    BOOL _jsfixLoadedTranspiler2;       // in the second one (see scriptEngineFor:)
    BOOL _jsfixFailed;
    NSCache *_transpiled;               // cache key -> lowered script (empty data: unchanged)
    NSMutableDictionary *_pageVars;     // page key -> NSMutableDictionary of --name: value
    NSMutableArray *_pageOrder;
    NSMutableDictionary *_pageManifests;   // page key -> @{ @"has": NSMutableArray, @"cq": NSMutableArray, @"seen": NSMutableSet }
    NSMutableArray *_manifestOrder;
}

+ (instancetype)shared
{
    static BRCSSRewriter *r;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ r = [[BRCSSRewriter alloc] init]; });
    return r;
}

static CGFloat g_viewportWidth = 768;
static CGFloat g_devicePixelRatio = 1;
// the web view in both orientations and the current one (viewport units become pixels per orientation, see
// VP_UNIT_RE in cssfix.js); set by the browser's layout on the main thread, read by the engines
static CGSize g_viewPortrait = { 768, 930 }, g_viewLandscape = { 1024, 674 };
static BOOL g_landscape = NO;

// the kinds of manifest entries cssfix.js writes (see manifestAdd there): :has(), @container, deferred values,
// @position-try, runtime custom properties, structural selectors, rules with markers, grid rules
static NSArray *BRManifestKinds(void)
{
    static NSArray *kinds;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ kinds = @[@"has", @"cq", @"dv", @"pt", @"cv", @"sc", @"mk", @"gd"]; });
    return kinds;
}

+ (void)noteWebViewSize:(CGSize)size landscape:(BOOL)landscape
{
    CGSize screen = [UIScreen mainScreen].bounds.size;   // portrait on iOS 6
    CGFloat shortSide = MIN(screen.width, screen.height), longSide = MAX(screen.width, screen.height);
    CGFloat chrome = (landscape ? shortSide : longSide) - size.height;   // status bar and our bars, the same both ways
    if (size.width <= 0 || size.height <= 0 || chrome < 0) return;
    @synchronized (self) {
        g_viewPortrait = CGSizeMake(shortSide, longSide - chrome);
        g_viewLandscape = CGSizeMake(longSide, shortSide - chrome);
        g_landscape = landscape;
    }
}

+ (void)warmUp
{
    BRCSSRewriter *r = [self shared];
    CGRect screen = [UIScreen mainScreen].bounds;
    g_viewportWidth = MIN(screen.size.width, screen.size.height);   // portrait width: the wider layout of the two is fine
    g_devicePixelRatio = [UIScreen mainScreen].scale ?: 1;          // read here, on the main thread
    [[BRJSEngine shared] performAsync:^{ [r ensureLoaded]; if ([BRSettings transpileEnabled]) [r ensureJSFixIn:[BRJSEngine shared]]; }];
    [[BRJSEngine transpiler] performAsync:^{ if ([BRSettings transpileEnabled]) [r ensureJSFixIn:[BRJSEngine transpiler]]; }];
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_BACKGROUND, 0), ^{ @autoreleasepool { [BRCSSRewriter pruneTranspiledCache]; } });
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        _pageVars = [NSMutableDictionary dictionary];
        _pageOrder = [NSMutableArray array];
        _pageManifests = [NSMutableDictionary dictionary];
        _manifestOrder = [NSMutableArray array];
        _transpiled = [[NSCache alloc] init];
        _transpiled.totalCostLimit = 8 * 1024 * 1024;
        [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(engineDidReset:) name:BRJSEngineDidResetNotification object:nil];
    }
    return self;
}

#pragma mark - Manifest (:has() and @container entries for the page shim)

// "/*br-page:{"calc":"...","trans":"..."}*/" (or "<!--br-page:...-->") right before the manifest: the properties a
// document gives -webkit-calc() values and the ones it transitions (see guardCalcTransitions in cssfix.js). They join
// the page's " calc" / " trans" entries, which the page's later documents are rewritten with; a cached copy is not
// rewritten again, so its comment is the only way its findings reach them.
- (void)registerPageStateInData:(NSData *)data before:(NSUInteger)limit pageURL:(NSURL *)pageURL
{
    if (limit > data.length || limit < 16) return;
    NSUInteger from = limit > 16384 ? limit - 16384 : 0;
    NSRange marker = [data rangeOfData:[@"br-page:{" dataUsingEncoding:NSUTF8StringEncoding] options:NSDataSearchBackwards range:NSMakeRange(from, limit - from)];
    if (marker.location == NSNotFound || marker.location < 2) return;
    const char *bytes = data.bytes;
    if (!(bytes[marker.location - 2] == '/' && bytes[marker.location - 1] == '*') && !(marker.location >= 4 && memcmp(bytes + marker.location - 4, "<!--", 4) == 0)) return;
    NSUInteger start = marker.location + 8;   // at the "{"
    NSRange end = [data rangeOfData:[@"}" dataUsingEncoding:NSUTF8StringEncoding] options:0 range:NSMakeRange(start, limit - start)];
    if (end.location == NSNotFound) return;
    NSDictionary *state = [NSJSONSerialization JSONObjectWithData:[data subdataWithRange:NSMakeRange(start, end.location + 1 - start)] options:0 error:NULL];
    if (![state isKindOfClass:[NSDictionary class]]) return;
    NSMutableDictionary *vars = [self varsForPage:BRPageKey(pageURL) create:YES];
    @synchronized (self) {
        for (NSString *kind in @[@"calc", @"trans"]) {
            NSString *names = state[kind];
            if (![names isKindOfClass:[NSString class]] || !names.length) continue;
            NSString *entry = [@" " stringByAppendingString:kind];
            NSString *old = [vars[entry] isKindOfClass:[NSString class]] ? vars[entry] : @"";
            NSMutableOrderedSet *set = [NSMutableOrderedSet orderedSetWithArray:[old componentsSeparatedByString:@" "]];
            [set addObjectsFromArray:[names componentsSeparatedByString:@" "]];
            [set removeObject:@""];
            vars[entry] = [set.array componentsJoinedByString:@" "];
        }
    }
}

- (void)registerManifestInData:(NSData *)data pageURL:(NSURL *)pageURL sourceURL:(NSURL *)sourceURL
{
    if (data.length < 20 || !pageURL) return;
    // the comment sits at the very end: "/*br-manifest:{...}*/" or "<!--br-manifest:{...}-->"; with the custom
    // property entries of a big framework it can be several hundred KB
    NSData *markerData = [@"br-manifest:" dataUsingEncoding:NSUTF8StringEncoding];
    NSRange marker = [data rangeOfData:markerData options:NSDataSearchBackwards range:NSMakeRange(0, data.length)];
    // (the calc / transition findings come just before it, or last when there is no manifest)
    NSUInteger stateLimit = data.length;
    if (marker.location != NSNotFound) stateLimit = marker.location >= 4 && memcmp((const char *)data.bytes + marker.location - 4, "<!--", 4) == 0 ? marker.location - 4 : marker.location >= 2 ? marker.location - 2 : marker.location;
    [self registerPageStateInData:data before:stateLimit pageURL:pageURL];
    if (marker.location == NSNotFound) return;
    NSUInteger start = marker.location + marker.length;
    NSRange tailRange = NSMakeRange(start, data.length - start);
    NSRange end = [data rangeOfData:[@"*/" dataUsingEncoding:NSUTF8StringEncoding] options:NSDataSearchBackwards range:tailRange];
    if (end.location == NSNotFound) end = [data rangeOfData:[@"-->" dataUsingEncoding:NSUTF8StringEncoding] options:NSDataSearchBackwards range:tailRange];
    if (end.location == NSNotFound || end.location < start) return;
    NSString *json = [[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(start, end.location - start)] encoding:NSUTF8StringEncoding];
    if (!json) return;
    json = [json stringByReplacingOccurrencesOfString:@"-\\u002d" withString:@"--"];
    NSDictionary *parsed = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
    if (![parsed isKindOfClass:[NSDictionary class]]) return;
    NSString *key = BRPageKey(pageURL);
    NSString *source = (sourceURL ?: pageURL).absoluteString ?: @"";
    NSRange hash = [source rangeOfString:@"#"];
    if (hash.location != NSNotFound) source = [source substringToIndex:hash.location];
    @synchronized (self) {
        NSMutableDictionary *m = _pageManifests[key];
        if (!m) {
            m = [@{ @"sheets": [NSMutableArray array], @"seen": [NSMutableSet set] } mutableCopy];
            for (NSString *kind in BRManifestKinds()) m[kind] = [NSMutableArray array];
            _pageManifests[key] = m;
            [_manifestOrder addObject:key];
            while (_manifestOrder.count > BRMaxPagesRemembered) {
                [_pageManifests removeObjectForKey:_manifestOrder[0]];
                [_manifestOrder removeObjectAtIndex:0];
            }
        }
        NSMutableSet *seen = m[@"seen"];
        // custom property rules remember which stylesheet they came from: the page shim orders them the way the
        // document orders its stylesheets (they arrive in network order)
        NSMutableArray *sheets = m[@"sheets"];
        NSUInteger sheetIndex = [sheets indexOfObject:source];
        for (NSString *kind in BRManifestKinds()) {
            NSArray *entries = parsed[kind];
            if (![entries isKindOfClass:[NSArray class]]) continue;
            for (NSDictionary *e in entries) {
                if (![e isKindOfClass:[NSDictionary class]] || ![e[@"h"] isKindOfClass:[NSString class]]) continue;
                NSString *entryId = [kind stringByAppendingString:e[@"h"]];
                if ([seen containsObject:entryId]) continue;
                [seen addObject:entryId];
                if ([kind isEqualToString:@"cv"]) {
                    if (sheetIndex == NSNotFound) { [sheets addObject:source]; sheetIndex = sheets.count - 1; }
                    NSMutableDictionary *withSheet = [e mutableCopy];
                    withSheet[@"si"] = @(sheetIndex);
                    [m[kind] addObject:withSheet];
                } else {
                    [m[kind] addObject:e];
                }
            }
        }
    }
}

+ (NSData *)dataWithoutManifest:(NSData *)data
{
    if (data.length < 20) return data;
    NSRange m = [data rangeOfData:[@"br-manifest:" dataUsingEncoding:NSUTF8StringEncoding] options:NSDataSearchBackwards range:NSMakeRange(0, data.length)];
    if (m.location == NSNotFound || m.location < 4) return data;
    const char *bytes = data.bytes;
    NSUInteger start;
    NSData *closer;
    if (bytes[m.location - 2] == '/' && bytes[m.location - 1] == '*') { start = m.location - 2; closer = [@"*/" dataUsingEncoding:NSUTF8StringEncoding]; }
    else if (memcmp(bytes + m.location - 4, "<!--", 4) == 0) { start = m.location - 4; closer = [@"-->" dataUsingEncoding:NSUTF8StringEncoding]; }
    else return data;
    NSRange end = [data rangeOfData:closer options:NSDataSearchBackwards range:NSMakeRange(m.location, data.length - m.location)];
    if (end.location == NSNotFound) return data;
    NSUInteger after = end.location + end.length;
    NSMutableData *out = [NSMutableData dataWithCapacity:start + (data.length - after)];
    [out appendBytes:bytes length:start];
    [out appendBytes:bytes + after length:data.length - after];
    return out;
}

// since: "has:3,cq:0,...,vars:40,sheets:2", what the page has already: only the entries after those counts come back
// (all of them, with reset, when the page has more than there are), and {"same":1} when nothing changed. GitHub's
// manifest is 2.3 MB, and the page asks again whenever its DOM settles.
- (NSData *)manifestJSONForPageURLString:(NSString *)pageURLString since:(NSString *)since
{
    if (!since.length) return [self manifestJSONForPageURLString:pageURLString];
    NSMutableDictionary *have = [NSMutableDictionary dictionary];
    for (NSString *part in [since componentsSeparatedByString:@","]) {
        NSRange c = [part rangeOfString:@":"];
        if (c.location != NSNotFound) have[[part substringToIndex:c.location]] = @([[part substringFromIndex:c.location + 1] integerValue]);
    }
    NSString *key = BRPageKey([NSURL URLWithString:pageURLString ?: @""]);
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    NSArray *kinds = BRManifestKinds();
    BOOL changed = NO, reset = NO;
    @synchronized (self) {
        NSDictionary *m = _pageManifests[key];
        NSMutableDictionary *rootVars = [_pageVars[key] mutableCopy] ?: [NSMutableDictionary dictionary];
        [rootVars removeObjectForKey:@" scoped"];
        for (NSString *kind in kinds) if ([have[kind] integerValue] > (NSInteger)[m[kind] count]) reset = YES;
        for (NSString *kind in kinds) {
            NSArray *list = m[kind] ?: @[];
            NSUInteger from = reset ? 0 : (NSUInteger)MAX(0, [have[kind] integerValue]);
            if (from < list.count) { out[kind] = [list subarrayWithRange:NSMakeRange(from, list.count - from)]; changed = YES; }
            else out[kind] = @[];
        }
        NSArray *sheets = [m[@"sheets"] copy] ?: @[];
        if ((NSInteger)sheets.count != [have[@"sheets"] integerValue] || (NSInteger)rootVars.count != [have[@"vars"] integerValue]) changed = YES;
        out[@"sheets"] = sheets;
        out[@"vars"] = rootVars;
    }
    if (!changed && !reset) return [@"{\"same\":1}" dataUsingEncoding:NSUTF8StringEncoding];
    if (reset) out[@"reset"] = @YES;
    return [NSJSONSerialization dataWithJSONObject:out options:0 error:NULL] ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
}

- (NSData *)manifestJSONForPageURLString:(NSString *)pageURLString
{
    NSString *key = BRPageKey([NSURL URLWithString:pageURLString ?: @""]);
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    @synchronized (self) {
        NSDictionary *m = _pageManifests[key];
        NSMutableDictionary *rootVars = [_pageVars[key] mutableCopy] ?: [NSMutableDictionary dictionary];
        [rootVars removeObjectForKey:@" scoped"];
        // (a page without entries still has its " calc" / " trans" findings, which the shims read from the vars)
        for (NSString *kind in BRManifestKinds()) out[kind] = [m[kind] copy] ?: @[];
        if (m) out[@"sheets"] = [m[@"sheets"] copy] ?: @[];
        out[@"vars"] = rootVars;
    }
    return [NSJSONSerialization dataWithJSONObject:out options:0 error:NULL] ?: [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
}

- (void)engineDidReset:(NSNotification *)note
{
    // posted on the engine's own thread
    if (note.object == [BRJSEngine transpiler]) _jsfixLoadedTranspiler = NO;
    else if (note.object == [BRJSEngine transpiler2]) _jsfixLoadedTranspiler2 = NO;
    else { _loaded = NO; _jsfixLoaded = NO; }
}

- (BOOL *)jsfixFlagFor:(BRJSEngine *)engine
{
    return engine == [BRJSEngine transpiler] ? &_jsfixLoadedTranspiler : engine == [BRJSEngine transpiler2] ? &_jsfixLoadedTranspiler2 : &_jsfixLoaded;
}

// Script files go to the transpiler engine; when it has work queued, a script that is not big goes to the second one
// (the iPad 2 has two cores, and pages ask for dozens of modules at once: Pinterest's were lowered one after the other
// for a minute). urgent: the page stands still for it (a lazy factory, an inserted script), so a free engine is taken
// whatever the size (TikTok waited 25 s for a 52 KB factory behind other scripts). The second one only while there is
// room for two lowerings at once.
- (BRJSEngine *)scriptEngineFor:(NSUInteger)length urgent:(BOOL)urgent
{
    BRJSEngine *t1 = [BRJSEngine transpiler], *t2 = [BRJSEngine transpiler2];
    NSInteger p1 = t1.pending, p2 = t2.pending;
    if (p1 == 0 || ![BRSettings transpileEnabled]) return t1;
    if (!urgent && length > 256 * 1024) return t1;
    if ([BRMemory availableMB] < BRRoomFloorMB + 45) return t1;
    return p2 < p1 ? t2 : t1;
}

// the engine's queue only: acorn and the transpiler, loaded on the first script that needs them (the rewriter's
// engine for inline scripts of documents, the transpiler engine for script files)
- (BOOL)ensureJSFixIn:(BRJSEngine *)engine
{
    BOOL *loaded = [self jsfixFlagFor:engine];
    if (*loaded) return YES;
    if (_jsfixFailed) return NO;
    if (!engine.available) { _jsfixFailed = YES; return NO; }
    NSBundle *b = [NSBundle mainBundle];
    NSString *acornPath = [b pathForResource:@"acorn" ofType:@"js" inDirectory:@"js"] ?: [b pathForResource:@"acorn" ofType:@"js"];
    NSString *fixPath = [b pathForResource:@"jsfix" ofType:@"js"];
    NSString *acorn = acornPath ? [NSString stringWithContentsOfFile:acornPath encoding:NSUTF8StringEncoding error:NULL] : nil;
    NSString *fix = fixPath ? [NSString stringWithContentsOfFile:fixPath encoding:NSUTF8StringEncoding error:NULL] : nil;
    if (!acorn.length || !fix.length) {
        BRLog(@"acorn.js or jsfix.js is missing from the bundle");
        _jsfixFailed = YES;
        return NO;
    }
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    // Unicode property tables for \p{...} (optional: without them such patterns stay RegExp constructor calls)
    NSString *uniPath = [b pathForResource:@"unicode-props" ofType:@"js" inDirectory:@"js"];
    NSString *uni = uniPath ? [NSString stringWithContentsOfFile:uniPath encoding:NSUTF8StringEncoding error:NULL] : nil;
    if (uni.length) [engine evaluateScript:uni sourceName:@"unicode-props.js"];
    if (![engine evaluateScript:acorn sourceName:@"acorn.js"] || ![engine evaluateScript:fix sourceName:@"jsfix.js"]) { _jsfixFailed = YES; return NO; }
    NSString *probe = [engine callFunction:@"JSFix.run" arguments:@[@"let f = (a = 1) => `${a}`;", @"{\"force\":true}"]];
    if (!probe.length) { BRLog(@"jsfix.js self test failed"); _jsfixFailed = YES; return NO; }
    *loaded = YES;
    BRLog(@"jsfix.js loaded in %ld ms (%@)", (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000),
          engine == [BRJSEngine transpiler] ? @"scripts" : engine == [BRJSEngine transpiler2] ? @"scripts, second engine" : @"documents");
    return YES;
}

// a transpiler engine's queue only (the engine given): the ES5 text of a script, nil when it needs nothing (or cannot
// be lowered); a module always gives its registration for the page's loader (or a stub reporting why it failed).
// engine.lastNoRoom says afterwards whether it was given up for lack of memory.
- (NSData *)transpiledScript:(NSData *)data charset:(NSString *)charset url:(NSURL *)url module:(BOOL)module engine:(BRJSEngine *)engine
{
    engine.lastNoRoom = NO;
    NSString *activityKey = engine == [BRJSEngine transpiler2] ? @"js3" : @"js";   // (what the memory report says each engine does)
    // (a module's registration names its URL: the key has it too)
    NSString *base = BRTextKey(data, module ? [url.absoluteString dataUsingEncoding:NSUTF8StringEncoding] : nil);
    NSString *key = [NSString stringWithFormat:@"%@%@-%@", base, module ? @"m" : @"", BRTranspileTag()];
    NSString *dir = BRTranspiledDirectory();
    NSString *path = [dir stringByAppendingPathComponent:[key stringByAppendingPathExtension:@"js"]];
    BOOL private = [BRSettings privateMode];
    NSData *cached = [_transpiled objectForKey:key];
    if (!cached && !private) {
        cached = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL];
        if (cached) {
            [[NSFileManager defaultManager] setAttributes:@{ NSFileModificationDate: [NSDate date] } ofItemAtPath:path error:NULL];   // recently used
            [_transpiled setObject:cached forKey:key cost:cached.length];
        }
    }
    if (cached && ![BRCSSRewriter lazyPartsPresentIn:cached]) {
        // (a chunk whose kept factories were pruned: lowered again)
        [_transpiled removeObjectForKey:key];
        [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
        cached = nil;
    }
    if (cached) return cached.length ? cached : nil;
    NSString *name = url.lastPathComponent.length ? url.lastPathComponent : @"script";
    // a webpack chunk keeps its big factories for later: only the rest is lowered now (and needs room)
    NSString *text = nil, *lazyScan = nil;
    long lazyBytes = 0;
    if (!module && !private && data.length >= 256 * 1024 && [self ensureJSFixIn:engine]) {
        NSString *used = nil;
        text = BRDecode(data, charset.length ? charset : nil, &used);
        lazyScan = text ? [engine callFunction:@"JSFix.lazyScan" arguments:@[text]] : nil;
        NSArray *parts = lazyScan.length ? [NSJSONSerialization JSONObjectWithData:[lazyScan dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
        if (![parts isKindOfClass:[NSArray class]]) { parts = nil; lazyScan = nil; }
        for (NSArray *p in parts) if ([p isKindOfClass:[NSArray class]] && p.count == 2) lazyBytes += [p[1] longValue] - [p[0] longValue];
    }
    // room first: when the iPad is short of memory the page waits (loads slower) instead of iOS closing the app; a big
    // script that still does not fit is left as it is (not cached: it is lowered on a later visit). A factory the page
    // waits for (a synchronous request: the page stands still) waits less, and one that did not fit a moment ago does
    // not wait again (a page may ask for it over and over).
    long work = MAX(0L, (long)data.length - lazyBytes);
    long floorMB = BRScriptFloorMB(work);
    long need = floorMB + BRScriptRoomMB(work);
    BOOL lazyPart = [url.host isEqualToString:@"ios6-browser.invalid"];
    NSString *optsJSON = @"{}";
    NSMutableDictionary *o = [NSMutableDictionary dictionary];
    if (url.absoluteString.length) o[@"url"] = url.absoluteString;
    if (module) o[@"module"] = @YES;
    if (lazyScan.length) o[@"lazy"] = base;
    // (a small one stops at the floor it waited for: jsfix.js's own 40 MB gave up IKEA's 32 KB module at 39 MB available)
    if (floorMB < 40) o[@"memoryFloor"] = @(floorMB);
    NSData *oj = [NSJSONSerialization dataWithJSONObject:o options:0 error:NULL];
    if (oj) optsJSON = [[NSString alloc] initWithData:oj encoding:NSUTF8StringEncoding] ?: @"{}";
    // a big row of statements goes a group of them at a time (jsfix.js pieces): the tree of one group only, groups the
    // engine takes keep their text, and no plan (the engine's parse of all of it). First for the inline scripts set
    // aside and for webpack chunks pushed one after the other (CNN's 2 MB of modules inline: with room at the start, the
    // page took it back during the whole lowering, which gave up after 28 s); other scripts only when there is no room
    // for them (below): the lexer pass costs about a second per MB.
    BOOL pieces = NO;
    if (!module && !lazyPart && !lazyScan.length && data.length >= BRPiecesMinBytes && [self ensureJSFixIn:engine]) {
        BOOL likely = [url.path hasPrefix:@"/__br_inline-"];
        if (!likely) {
            static const char push[] = ").push([[";
            const char *bytes = data.bytes, *end = bytes + data.length, *at = bytes;
            int seen = 0;
            while (seen < 2 && (at = memmem(at, (size_t)(end - at), push, sizeof(push) - 1))) { seen++; at += sizeof(push) - 1; }
            likely = seen >= 2;
        }
        if (likely) {
            if (!text) { NSString *used = nil; text = BRDecode(data, charset.length ? charset : nil, &used); }
            if (text && [[engine callFunction:@"JSFix.shape" arguments:@[text, optsJSON]] isEqualToString:@"pieces"]) {
                pieces = YES;
                floorMB = BRPiecesFloorMB;
                need = floorMB + BRScriptPiecesMB(work);
            }
        }
    }
    // a big script: what its lowering takes first, when there is room to find out (JSFix.plan: nothing for one the
    // engine takes as it is, little for one lowered in pieces, see jsfix.js islands)
    NSString *plan = nil;
    if (!pieces && !module && !lazyPart && data.length >= BRPlanMinBytes && [BRMemory availableMB] >= BRRoomFloorMB + BRScriptPlanMB((long)data.length) && [self ensureJSFixIn:engine]) {
        if (!text) { NSString *used = nil; text = BRDecode(data, charset.length ? charset : nil, &used); }
        if (text) plan = [engine callFunction:@"JSFix.plan" arguments:@[text, optsJSON]];
        if ([plan isEqualToString:@"es5"]) {
            // (remembered like a lowering that found nothing; the engine's parse of it left garbage)
            [_transpiled setObject:[NSData data] forKey:key cost:64];
            if (!private) {
                [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
                [[NSData data] writeToFile:path atomically:YES];
                BRNoteTranspiledWrite(0);
            }
            [engine collectGarbage];
            [engine releaseWhenIdleFor:BRTranspilerIdleRelease aboveMB:0];
            return nil;
        }
        if ([plan isEqualToString:@"islands"] || [plan isEqualToString:@"stand-in"]) { floorMB = BRRoomFloorMB; need = floorMB + BRScriptPlanMB(work); }
    }
    // no room for all of it at once: a big row of statements goes a group of them at a time (jsfix.js pieces), which
    // takes little room (CNN's 2 MB of modules inline wanted 138 MB with 75 left beside the page, and stayed ES2020)
    if (!pieces && !module && !lazyPart && !lazyScan.length && data.length >= BRPiecesMinBytes && [BRMemory availableMB] < need && [self ensureJSFixIn:engine]) {
        if (!text) { NSString *used = nil; text = BRDecode(data, charset.length ? charset : nil, &used); }
        if (text && [[engine callFunction:@"JSFix.shape" arguments:@[text, optsJSON]] isEqualToString:@"pieces"]) {
            BRLog(@"jsfix %@: no room for all of it (%ld MB available, %ld wanted), lowered a group of statements at a time", name, [BRMemory availableMB], need);
            pieces = YES;
            floorMB = BRPiecesFloorMB;
            need = floorMB + BRScriptPiecesMB(work);
        }
    }
    NSDate *noRoom = nil;
    @synchronized (self) { noRoom = _noRoom[key]; }
    // (a script left as it is breaks the page: better slower, since the page's new requests wait meanwhile anyway; a
    // factory asked for synchronously holds the page's thread, and the screen with it: shorter)
    NSTimeInterval patience = (noRoom && -[noRoom timeIntervalSinceNow] < 120) ? 0 : lazyPart ? 10 : 60;
    BOOL fits = patience > 0 ? [BRMemory waitForAvailableMB:need timeout:patience reason:[NSString stringWithFormat:@"lowering %@ (%lu KB)", name, (unsigned long)(work >> 10)] engine:engine]
                             : [BRMemory availableMB] >= need;
    if (!fits && [BRMemory availableMB] < floorMB + (need - floorMB) / 2) {
        BRLog(@"jsfix %@: left unlowered, not enough memory", name);
        @synchronized (self) {
            if (!_noRoom) _noRoom = [NSMutableDictionary dictionary];
            if (_noRoom.count > 64) [_noRoom removeAllObjects];
            _noRoom[key] = [NSDate date];
        }
        engine.lastNoRoom = YES;
        return nil;
    }
    if (![self ensureJSFixIn:engine]) return nil;
    if (!text) {
        NSString *used = nil;
        text = BRDecode(data, charset.length ? charset : nil, &used);
    }
    if (!text) return nil;
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    long mb0 = (long)BRResidentMemoryMB();
    [BRMemory setActivity:[NSString stringWithFormat:@"transpiling %@ (%lu KB)", name, (unsigned long)(work >> 10)] forKey:activityKey];
    NSString *result = [engine callFunction:@"JSFix.run" arguments:@[text, optsJSON]];
    // a row of statements given up for lack of memory keeps the groups it did: once there is room again it goes on from
    // there (the page waits for this script anyway, and a page like CNN's takes the room back while it is lowered)
    for (int wait = 0; pieces && !result.length && wait < 4; wait++) {
        NSString *why = [engine callFunction:@"JSFix.last" arguments:@[]] ?: @"";
        if ([why rangeOfString:@"memory"].location == NSNotFound) break;
        // (engine nil: the wait would release the transpiler's context, and the groups done with it)
        [engine collectGarbage];
        if (![BRMemory waitForAvailableMB:BRPiecesResumeMB timeout:30 reason:[NSString stringWithFormat:@"going on with %@", name] engine:nil]) continue;
        BRLog(@"jsfix %@: going on after a wait for room (%ld MB available)", name, [BRMemory availableMB]);
        result = [engine callFunction:@"JSFix.run" arguments:@[text, optsJSON]];
    }
    // a whole lowering given up for lack of memory: left as it is the script breaks the page (a SyntaxError where the old
    // engine meets the newer syntax), and the page waits for it anyway. Once there is room again (the transpiler's heap
    // let go first) it is lowered again, twice at most. (The Verge's 333 KB turbopack chunk, one big factory, gave up at
    // 42 MB available while the page grew beside it.) A module answers with its failure for the loader: the same.
    for (int again = 0; !pieces && !lazyPart && again < 2; again++) {
        NSString *why = [engine callFunction:@"JSFix.last" arguments:@[]] ?: @"";
        if (result.length && !(module && [why hasPrefix:@"failed"])) break;
        if ([why rangeOfString:@"memory"].location == NSNotFound) break;
        [engine releaseContextNow];
        BOOL room = [BRMemory waitForAvailableMB:need timeout:45 reason:[NSString stringWithFormat:@"lowering %@ again", name] engine:nil];
        if (!room || ![self ensureJSFixIn:engine]) {
            BRLog(@"jsfix %@: gave up, the iPad is short of memory (%ld MB available)", name, [BRMemory availableMB]);
            [BRMemory setActivity:nil forKey:activityKey];
            engine.lastNoRoom = YES;
            return module && result.length ? [result dataUsingEncoding:NSUTF8StringEncoding] : nil;
        }
        BRLog(@"jsfix %@: lowered again after a wait for room (%ld MB available)", name, [BRMemory availableMB]);
        result = [engine callFunction:@"JSFix.run" arguments:@[text, optsJSON]];
    }
    // the factories kept for later go next to the lowered chunk, where the page's stubs ask for them
    NSUInteger kept = 0;
    if (lazyScan.length && [result hasPrefix:@"/*br-lazy:"]) {
        kept = [self storeLazyParts:[engine callFunction:@"JSFix.lazy" arguments:@[]] ofText:text base:base];
        if (!kept) {
            BRLog(@"jsfix %@: the factories kept for later could not be stored", name);
            [BRMemory setActivity:nil forKey:activityKey];
            return nil;
        }
        else BRLog(@"jsfix %@: %lu factories (%ld KB) lowered only when the page needs them", name, (unsigned long)kept, lazyBytes >> 10);
    }
    text = nil;
    long ms = (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000);
    NSData *out = result.length ? [result dataUsingEncoding:NSUTF8StringEncoding] : nil;
    result = nil;
    long mb1 = (long)BRResidentMemoryMB();
    // (a long one says where its time went: parse with the early units / walk / resolve / print, ms)
    NSString *phases = ms > 3000 ? [engine callFunction:@"JSFix.phases" arguments:@[]] : nil;
    NSString *phaseText = phases.length ? [NSString stringWithFormat:@" [phases %@]", phases] : @"";
    if (out && module) {
        NSString *why = [engine callFunction:@"JSFix.last" arguments:@[]];
        BRLog(@"jsfix module %@: %ld ms, %lu -> %lu bytes, %ld -> %ld MB%@%@", name, ms, (unsigned long)data.length, (unsigned long)out.length, mb0, mb1,
              [why hasPrefix:@"failed"] ? [@" " stringByAppendingString:why] : @"", phaseText);
    } else if (out) {
        NSString *note = [engine callFunction:@"JSFix.note" arguments:@[]];
        BRLog(@"jsfix %@: %ld ms, %lu -> %lu bytes, %ld -> %ld MB%@%@", name, ms, (unsigned long)data.length, (unsigned long)out.length, mb0, mb1,
              note.length ? [NSString stringWithFormat:@" (%@)", note] : @"", phaseText);
    }
    else {
        NSString *why = [engine callFunction:@"JSFix.last" arguments:@[]];
        if (![why isEqualToString:@"es5"] || ms > 200) BRLog(@"jsfix %@: unchanged after %ld ms (%@), %ld -> %ld MB", name, ms, why ?: @"?", mb0, mb1);
    }
    [BRMemory setActivity:nil forKey:activityKey];
    // given up for lack of memory (see jsfix.js MEMORY_FLOOR_MB): not remembered, a later visit lowers it; nor is a run
    // that did not answer at all (its context went away: "unchanged" was kept for good)
    if (!out || module) {
        NSString *last = [engine callFunction:@"JSFix.last" arguments:@[]] ?: @"";
        if (!last.length || [last rangeOfString:@"memory"].location != NSNotFound) {
            BRLog(@"jsfix %@: gave up, %@ (%ld MB available)", name, last.length ? @"the iPad is short of memory" : @"the transpiler did not answer", [BRMemory availableMB]);
            engine.lastNoRoom = YES;
            [engine releaseContextNow];
            return out;
        }
        // (nothing to keep but a script the engine takes as it is: "unchanged" after a failure was kept for good, and
        // the page got the ES2020 text on every visit - IKEA's recommendation chunks)
        if (!out && ![last isEqualToString:@"es5"]) {
            BRLog(@"jsfix %@: not lowered (%@), not remembered", name, last);
            engine.lastNoRoom = YES;   // (nor is the text as it came cached: see rewriteData)
            return nil;
        }
    }
    NSData *store = out ?: [NSData data];
    [_transpiled setObject:store forKey:key cost:store.length + 64];
    if (!private) {
        [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
        [store writeToFile:path atomically:YES];
        BRNoteTranspiledWrite(store.length);
    }
    if (data.length > 200000) { [engine collectGarbage]; [BRJSEngine returnFreeMemory]; }
    // a parse tree of a big script leaves the heap large: the whole VM goes once the page's scripts are through
    // (acorn and jsfix.js load again in about 0.4 s; most scripts come from the cache above anyway)
    [engine releaseWhenIdleFor:BRTranspilerIdleRelease aboveMB:0];
    return out;
}

- (void)forgetTranspiledScript:(NSData *)data
{
    if (!data.length) return;
    NSString *key = [NSString stringWithFormat:@"%@-%@", BRTextKey(data, nil), BRTranspileTag()];
    [_transpiled removeObjectForKey:key];
    [[NSFileManager defaultManager] removeItemAtPath:[BRTranspiledDirectory() stringByAppendingPathComponent:[key stringByAppendingPathExtension:@"js"]] error:NULL];
}

// A lowered chunk that keeps factories for later starts with /*br-lazy:N:<base>*/ and needs their texts: YES when
// they are all there (touched as recently used, the cache prunes by age) or when it keeps none.
+ (BOOL)lazyPartsPresentIn:(NSData *)lowered
{
    static const char mark[] = "/*br-lazy:";
    if (lowered.length < sizeof(mark) + 4 || memcmp(lowered.bytes, mark, sizeof(mark) - 1) != 0) return YES;
    char head[64] = { 0 };
    memcpy(head, (const char *)lowered.bytes + sizeof(mark) - 1, MIN(sizeof(head) - 1, lowered.length - (sizeof(mark) - 1)));
    char *colon = NULL;
    long count = strtol(head, &colon, 10);
    char *close = colon && *colon == ':' ? strstr(colon, "*/") : NULL;
    if (!close || count <= 0) return NO;
    NSString *base = [[NSString alloc] initWithBytes:colon + 1 length:(NSUInteger)(close - colon - 1) encoding:NSASCIIStringEncoding];
    if (!base.length) return NO;
    NSFileManager *fm = [NSFileManager defaultManager];
    NSDictionary *now = @{ NSFileModificationDate: [NSDate date] };
    for (long i = 0; i < count; i++) if (![fm setAttributes:now ofItemAtPath:BRLazyPartPath(base, i) error:NULL]) return NO;
    return YES;
}

// A document whose big inline scripts were set aside names them in <!--br-inline:a,b--> (before the page state and
// manifest comments at its end): YES when their texts are all there (touched as recently used) or when it has none.
+ (BOOL)inlineScriptsPresentIn:(NSData *)doc
{
    static const char mark[] = "<!--br-inline:";
    if (doc.length < sizeof(mark)) return YES;
    NSRange m = [doc rangeOfData:[NSData dataWithBytesNoCopy:(void *)mark length:sizeof(mark) - 1 freeWhenDone:NO] options:NSDataSearchBackwards range:NSMakeRange(0, doc.length)];
    if (m.location == NSNotFound) return YES;
    NSUInteger from = m.location + m.length, room = MIN((NSUInteger)4096, doc.length - from);
    NSRange close = [doc rangeOfData:[NSData dataWithBytesNoCopy:(void *)"-->" length:3 freeWhenDone:NO] options:0 range:NSMakeRange(from, room)];
    if (close.location == NSNotFound) return NO;
    NSString *list = [[NSString alloc] initWithBytes:(const char *)doc.bytes + from length:close.location - from encoding:NSASCIIStringEncoding];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSDictionary *now = @{ NSFileModificationDate: [NSDate date] };
    for (NSString *name in [list componentsSeparatedByString:@","]) {
        NSString *path = BRInlineScriptPath(name);
        if (!path || ![fm setAttributes:now ofItemAtPath:path error:NULL]) return NO;
    }
    return YES;
}

+ (NSData *)inlineScriptNamed:(NSString *)name
{
    NSString *path = BRInlineScriptPath(name);
    NSData *text = path ? [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL] : nil;
    if (!text) BRLog(@"Inline script %@: its text is gone", name ?: @"?");
    return text;
}

// the transpiler's queue: the texts of the kept factories ("[[start,end],...]" in UTF-16 units of text); how many
- (NSUInteger)storeLazyParts:(NSString *)json ofText:(NSString *)text base:(NSString *)base
{
    NSArray *parts = json.length ? [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL] : nil;
    if (![parts isKindOfClass:[NSArray class]] || !parts.count) return 0;
    [[NSFileManager defaultManager] createDirectoryAtPath:BRTranspiledDirectory() withIntermediateDirectories:YES attributes:nil error:NULL];
    NSUInteger n = 0;
    for (NSArray *p in parts) {
        if (![p isKindOfClass:[NSArray class]] || p.count != 2) return 0;
        NSUInteger start = [p[0] unsignedIntegerValue], end = [p[1] unsignedIntegerValue];
        if (end <= start || end > text.length) return 0;
        @autoreleasepool {
            NSData *d = [[text substringWithRange:NSMakeRange(start, end - start)] dataUsingEncoding:NSUTF8StringEncoding];
            if (!d || ![d writeToFile:BRLazyPartPath(base, (long)n) atomically:YES]) return 0;
            BRNoteTranspiledWrite(d.length);
        }
        n++;
    }
    return n;
}

- (NSData *)lazyModuleForBase:(NSString *)base index:(NSInteger)index
{
    NSString *path = BRLazyPartPath(base, (long)index);
    NSData *src = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL];
    if (!src) { BRLog(@"Lazy factory %@/%ld: its text is gone", base, (long)index); return nil; }
    [[NSFileManager defaultManager] setAttributes:@{ NSFileModificationDate: [NSDate date] } ofItemAtPath:path error:NULL];
    NSMutableData *wrapped = [NSMutableData dataWithCapacity:src.length + 32];
    [wrapped appendBytes:"var __br_lazyValue=(" length:20];
    [wrapped appendData:src];
    [wrapped appendBytes:"\n);" length:3];
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"https://ios6-browser.invalid/lazy/%@/%ld.js", base, (long)index]];
    __block NSData *out = nil;
    __block BOOL noRoom = NO;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    BRJSEngine *engine = [self scriptEngineFor:wrapped.length urgent:YES];
    [engine performAsync:^{
        @autoreleasepool { out = [self transpiledScript:wrapped charset:@"utf-8" url:url module:NO engine:engine]; noRoom = engine.lastNoRoom; }
        dispatch_semaphore_signal(done);
    }];
    BOOL finished = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(240 * NSEC_PER_SEC))) == 0;
    BRLog(@"Lazy factory %@/%ld (%lu KB) asked for by the page: %@ after %ld ms", base, (long)index, (unsigned long)(src.length >> 10),
          !finished ? @"still lowering" : noRoom ? @"no room to lower it" : out ? @"lowered" : @"sent as it is", (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000));
    // (without room the page gets a factory that says so, not megabytes its engine cannot parse)
    if (!finished || noRoom) return [@"var __br_lazyValue=function(){throw new Error(\"This part of the page did not fit in the iPad's memory\")};" dataUsingEncoding:NSUTF8StringEncoding];
    return out ?: wrapped;
}

- (NSData *)loweredPageScript:(NSData *)text failed:(BOOL *)failed
{
    // (a host of its own for the log: not ios6-browser.invalid, whose lazy factories skip the plan and the pieces)
    NSURL *url = [NSURL URLWithString:@"https://inserted-script.invalid/text.js"];
    __block NSData *out = nil;
    __block BOOL noRoom = NO, bad = NO;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    BRJSEngine *engine = [self scriptEngineFor:text.length urgent:YES];
    [engine performAsync:^{
        @autoreleasepool {
            out = [self transpiledScript:text charset:@"utf-8" url:url module:NO engine:engine];
            noRoom = engine.lastNoRoom;
            // (nothing back: the text needs nothing, or it failed, which the transpiler says when it just ran)
            if (!out && *[self jsfixFlagFor:engine]) {
                NSString *last = [engine callFunction:@"JSFix.last" arguments:@[]] ?: @"";
                bad = [last hasPrefix:@"failed"];
            }
        }
        dispatch_semaphore_signal(done);
    }];
    BOOL finished = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(120 * NSEC_PER_SEC))) == 0;
    long ms = (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000);
    if (ms > 300) BRLog(@"Inserted script (%lu KB) lowered for the page: %@ after %ld ms", (unsigned long)(text.length >> 10),
                        !finished ? @"still lowering" : noRoom ? @"no room" : bad ? @"failed" : out ? @"lowered" : @"needs nothing", ms);
    if (failed) *failed = !finished || noRoom || bad;
    return finished ? out : nil;
}

// (here the rewriter's code is compiled and warm: a page's own copy loads, compiles and runs it three times as slowly -
// Didomi's 64 KB consent styles took 0.74 s on idnes.cz - and the same styles come back on every visit)
- (NSData *)runtimeStyleResult:(NSData *)request
{
    if (request.length < 8) { BRLog(@"Inserted style: no text came (%lu bytes)", (unsigned long)request.length); return nil; }
    NSString *key = [NSString stringWithFormat:@"css-%@-%@-%@", BRTextKey(request, nil), BRRewriterTag(), BRTranspileTag()];
    NSString *path = [BRTranspiledDirectory() stringByAppendingPathComponent:[key stringByAppendingPathExtension:@"js"]];
    BOOL private = [BRSettings privateMode];
    NSData *cached = [_transpiled objectForKey:key];
    if (!cached && !private) {
        cached = [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL];
        if (cached) {
            [[NSFileManager defaultManager] setAttributes:@{ NSFileModificationDate: [NSDate date] } ofItemAtPath:path error:NULL];
            [_transpiled setObject:cached forKey:key cost:cached.length];
        }
    }
    if (cached.length) return cached;
    // (not behind a stylesheet or document of the page: the page would wait longer than doing it itself)
    BRJSEngine *engine = [BRJSEngine shared];
    if (engine.pending > 0) { BRLog(@"Inserted style (%lu KB) left to the page: the rewriter has %ld jobs", (unsigned long)(request.length >> 10), (long)engine.pending); return nil; }
    __block NSData *out = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    [engine performAsync:^{
        @autoreleasepool {
            NSArray *args = [NSJSONSerialization JSONObjectWithData:request options:0 error:NULL];
            BOOL ok = [args isKindOfClass:[NSArray class]] && args.count == 3;
            for (NSUInteger i = 0; ok && i < 3; i++) ok = [args[i] isKindOfClass:[NSString class]];
            NSString *result = ok && [self ensureLoaded] ? [engine callFunction:@"CSSFix.run" arguments:@[@"css", args[0], args[1], args[2]]] : nil;
            if (result.length) out = [result dataUsingEncoding:NSUTF8StringEncoding];
            else BRLog(@"Inserted style (%lu KB): %@", (unsigned long)(request.length >> 10), ok ? @"the rewriter gave nothing" : @"not a [css, vars, options] request");
        }
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC))) != 0) return nil;
    long ms = (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000);
    if (ms > 100) BRLog(@"Inserted style (%lu KB) rewritten for the page in %ld ms", (unsigned long)(request.length >> 10), ms);
    if (!out) return nil;
    [_transpiled setObject:out forKey:key cost:out.length + 64];
    if (!private) {
        [[NSFileManager defaultManager] createDirectoryAtPath:BRTranspiledDirectory() withIntermediateDirectories:YES attributes:nil error:NULL];
        [out writeToFile:path atomically:YES];
        BRNoteTranspiledWrite(out.length);
    }
    return out;
}

+ (void)cancelPendingWork
{
    g_workGeneration++;
}

+ (NSString *)rewriterTag
{
    return BRRewriterTag();
}

+ (void)runTranspileTest:(NSDictionary *)params
{
    BRJSEngine *engine = [BRJSEngine transpiler];
    [engine performAsync:^{
        @autoreleasepool {
            NSString *report;
            NSString *input = params[@"input"] ?: @"", *opts = [params[@"opts"] length] ? params[@"opts"] : @"{}";
            BOOL readable = [[NSFileManager defaultManager] isReadableFileAtPath:input];
            [engine releaseContextNow];   // a fresh heap for the measurement
            long mb0 = (long)BRResidentMemoryMB();
            NSBundle *b = [NSBundle mainBundle];
            NSString *uniPath = [b pathForResource:@"unicode-props" ofType:@"js" inDirectory:@"js"];
            NSString *acornPath = [b pathForResource:@"acorn" ofType:@"js" inDirectory:@"js"] ?: [b pathForResource:@"acorn" ofType:@"js"];
            NSString *fixPath = [params[@"jsfix"] length] ? params[@"jsfix"] : [b pathForResource:@"jsfix" ofType:@"js"];
            NSString *uni = uniPath ? [NSString stringWithContentsOfFile:uniPath encoding:NSUTF8StringEncoding error:NULL] : nil;
            NSString *acorn = acornPath ? [NSString stringWithContentsOfFile:acornPath encoding:NSUTF8StringEncoding error:NULL] : nil;
            NSString *fix = fixPath ? [NSString stringWithContentsOfFile:fixPath encoding:NSUTF8StringEncoding error:NULL] : nil;
            if (!readable || !acorn || !fix) {
                report = [NSString stringWithFormat:@"jsfix test: cannot read %@", !readable ? input : !acorn ? @"acorn.js" : fixPath];
            } else {
                if (uni.length) [engine evaluateScript:uni sourceName:@"unicode-props.js"];
                [engine evaluateScript:acorn sourceName:@"acorn.js"];
                [engine evaluateScript:fix sourceName:@"jsfix.js"];
                [engine evaluateScript:@"var __brStats = function () { return JSON.stringify(JSFix.stats); };" sourceName:@"stats.js"];
                long mb1 = (long)BRResidentMemoryMB();
                // the peak from a sampling thread (the run itself is one call)
                __block long peak = mb1;
                dispatch_semaphore_t stop = dispatch_semaphore_create(0), stopped = dispatch_semaphore_create(0);
                dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0), ^{
                    for (;;) {
                        long m = (long)BRResidentMemoryMB();
                        if (m > peak) peak = m;
                        if (!dispatch_semaphore_wait(stop, dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC))) break;
                    }
                    dispatch_semaphore_signal(stopped);
                });
                long ms, mb2;
                NSUInteger inLength, outLength;
                NSString *last, *stats;
                @autoreleasepool {   // (the input and output strings go before the last measurements)
                    NSString *text = [NSString stringWithContentsOfFile:input encoding:NSUTF8StringEncoding error:NULL] ?: @"";
                    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
                    NSString *out = [engine callFunction:@"JSFix.run" arguments:@[text, opts]];
                    ms = (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000);
                    dispatch_semaphore_signal(stop);
                    dispatch_semaphore_wait(stopped, DISPATCH_TIME_FOREVER);
                    mb2 = (long)BRResidentMemoryMB();
                    last = [engine callFunction:@"JSFix.last" arguments:@[]] ?: @"?";
                    stats = [engine callFunction:@"__brStats" arguments:@[]] ?: @"?";
                    inLength = text.length;
                    outLength = out.length;
                }
                [engine collectGarbage];
                long mb3 = (long)BRResidentMemoryMB();
                [engine releaseContextNow];
                long mb4 = (long)BRResidentMemoryMB();
                report = [NSString stringWithFormat:@"jsfix test %@ (%@, jsfix %@): %ld ms, %lu -> %lu chars (%@); resident %ld MB, with jsfix loaded %ld, "
                          "peak %ld (+%ld), after the run %ld, after GC %ld, context released %ld; stats %@",
                          input.lastPathComponent, opts, fixPath.lastPathComponent, ms, (unsigned long)inLength, (unsigned long)outLength, last,
                          mb0, mb1, peak, peak - mb1, mb2, mb3, mb4, stats];
            }
            [report writeToFile:[NSTemporaryDirectory() stringByAppendingPathComponent:@"eval.txt"] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
            BRLog(@"%@", report);
        }
    }];
}

+ (NSString *)rewriteTag
{
    static NSString *tag;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *path = [[NSBundle mainBundle] pathForResource:@"cssfix" ofType:@"js"];
        NSData *d = path ? [NSData dataWithContentsOfFile:path] : nil;
        unsigned long crc = crc32(0L, Z_NULL, 0);
        if (d.length) crc = crc32(crc, (const Bytef *)d.bytes, (uInt)d.length);
        // (the last part: how stored text is tagged; 2 = bodies kept as they came carry a tag of their own, see
        // BRURLProtocol BRRawCacheTag, which drops the untagged ones stored before)
        tag = [NSString stringWithFormat:@"%08lx-%@-2", crc, BRTranspileTag()];
    });
    return tag;
}

+ (void)forgetCachedResults
{
    BRCSSRewriter *r = [self shared];
    [r->_transpiled removeAllObjects];   // (NSCache is thread safe)
}

+ (void)pruneTranspiledCache
{
    // (one at a time: at launch, and again whenever more was written meanwhile, see BRNoteTranspiledWrite)
    static BOOL running;
    @synchronized ([BRCSSRewriter class]) {
        if (running) return;
        running = YES;
    }
    BRPruneTranspiled();
    @synchronized ([BRCSSRewriter class]) { running = NO; }
}

static void BRPruneTranspiled(void)
{
    NSString *dir = BRTranspiledDirectory(), *suffix = [NSString stringWithFormat:@"-%@.js", BRTranspileTag()];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSArray *names = [fm contentsOfDirectoryAtPath:dir error:NULL];
    NSMutableArray *items = [NSMutableArray array];
    unsigned long long total = 0;
    for (NSString *n in names) {
        NSString *p = [dir stringByAppendingPathComponent:n];
        if (![n hasSuffix:suffix]) { [fm removeItemAtPath:p error:NULL]; continue; }   // an older transpiler's output
        NSDictionary *a = [fm attributesOfItemAtPath:p error:NULL];
        if (!a) continue;
        total += [a fileSize];
        [items addObject:@[p, [a fileModificationDate] ?: [NSDate distantPast], @([a fileSize])]];
    }
    // (every lowering saved is seconds on the next visit, but the flash is the user's: 200 MB, half of it when the device
    // has less than 1 GB free)
    NSDictionary *fs = [fm attributesOfFileSystemForPath:NSHomeDirectory() error:NULL];
    unsigned long long freeBytes = fs[NSFileSystemFreeSize] ? [fs[NSFileSystemFreeSize] unsignedLongLongValue] : ~0ULL;
    const unsigned long long limit = (freeBytes < 1024ull * 1024 * 1024 ? 100ull : 200ull) * 1024 * 1024;
    if (total <= limit) return;
    [items sortUsingComparator:^NSComparisonResult(NSArray *x, NSArray *y) { return [x[1] compare:y[1]]; }];
    for (NSArray *it in items) {
        if (total <= limit * 3 / 4) break;
        [fm removeItemAtPath:it[0] error:NULL];
        total -= [it[2] unsignedLongLongValue];
    }
}

- (BOOL)available
{
    return [BRJSEngine shared].available && !_loadFailed;
}

// engine queue only
- (BOOL)ensureLoaded
{
    if (_loaded) return YES;
    if (_loadFailed) return NO;
    BRJSEngine *engine = [BRJSEngine shared];
    if (!engine.available) { _loadFailed = YES; return NO; }
    NSString *path = [[NSBundle mainBundle] pathForResource:@"cssfix" ofType:@"js"];
    NSString *script = path ? [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL] : nil;
    if (!script.length) {
        BRLog(@"cssfix.js is missing from the bundle");
        _loadFailed = YES;
        return NO;
    }
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    if (![engine evaluateScript:script sourceName:@"cssfix.js"]) { _loadFailed = YES; return NO; }
    NSString *probe = [engine callFunction:@"CSSFix.run" arguments:@[@"css", @".a{display:flex}", @"{}"]];
    if (!probe.length) { BRLog(@"cssfix.js self test failed"); _loadFailed = YES; return NO; }
    _loaded = YES;
    BRLog(@"cssfix.js loaded in %ld ms", (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000));
    return YES;
}

static NSString *BRPageKey(NSURL *url)
{
    NSString *s = url.absoluteString ?: @"";
    NSRange hash = [s rangeOfString:@"#"];
    return hash.location == NSNotFound ? s : [s substringToIndex:hash.location];
}

// engine queue only
- (NSMutableDictionary *)varsForPage:(NSString *)key create:(BOOL)create
{
    @synchronized (self) {   // the manifest endpoint reads them from other threads
        NSMutableDictionary *vars = _pageVars[key];
        if (!vars && create) {
            vars = [NSMutableDictionary dictionary];
            _pageVars[key] = vars;
            [_pageOrder addObject:key];
            while (_pageOrder.count > BRMaxPagesRemembered) {
                [_pageVars removeObjectForKey:_pageOrder[0]];
                [_pageOrder removeObjectAtIndex:0];
            }
        }
        return vars;
    }
}

+ (NSString *)polyfillURLString
{
    [self polyfillBundle];
    return g_polyfillURL ?: @"/__br_polyfills.js";
}

+ (NSData *)polyfillBundle
{
    static NSData *bundle;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableData *d = [NSMutableData data];
        NSBundle *b = [NSBundle mainBundle];
        // (debugging switch: the page shim logs the real errors of callbacks and promises, see shims-extra.js)
        if ([[NSUserDefaults standardUserDefaults] boolForKey:@"BRDebugJSErrors"]) [d appendData:[@"window.__brDebugErrors=true;\n" dataUsingEncoding:NSUTF8StringEncoding]];
        // (the page shim's load timing and error reports go to the log only on a developer's device, where BRLog writes:
        // elsewhere the brlog: handler drops them, and they would cost every page a timer and hidden frames for nothing)
        if (BRDebugEnabled()) [d appendData:[@"window.__brDebugLog=true;\n" dataUsingEncoding:NSUTF8StringEncoding]];
        // (jsfix-helpers: the transpiler's runtime helpers as globals, for lowered code a page keeps as text and runs
        // later, see tools/gen-helpers.js)
        // (page-prelude first: it keeps MutationObservers from holding left pages in memory, see the file)
        for (NSString *name in @[@"page-prelude", @"core-js-custom", @"regenerator-runtime", @"jsfix-helpers", @"fetch", @"intersection-observer", @"resize-observer", @"picturefill",
                                 @"dialog-polyfill", @"object-fit-images", @"shims", @"regexp-shim", @"shims-extra"]) {
            NSString *path = [b pathForResource:name ofType:@"js" inDirectory:@"js"];
            if (!path) path = [b pathForResource:name ofType:@"js"];
            NSData *part = path ? [NSData dataWithContentsOfFile:path] : nil;
            if (!part.length) { BRLog(@"polyfill %@.js missing", name); continue; }
            [d appendData:[[NSString stringWithFormat:@"\n;/* %@ */\n", name] dataUsingEncoding:NSUTF8StringEncoding]];
            [d appendData:part];
            [d appendData:[@"\n;\n" dataUsingEncoding:NSUTF8StringEncoding]];
        }
        bundle = d;
        unsigned long crc = crc32(0L, Z_NULL, 0);
        crc = crc32(crc, (const Bytef *)d.bytes, (uInt)d.length);
        g_polyfillURL = [NSString stringWithFormat:@"/__br_polyfills-%08lx.js", crc];
        BRLog(@"Polyfill bundle assembled: %lu KB (%@)", (unsigned long)(d.length / 1024), g_polyfillURL);
    });
    return bundle;
}

+ (NSData *)workerPolyfills
{
    static NSData *bundle;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableData *d = [NSMutableData data];
        for (NSString *name in @[@"core-js-custom", @"regenerator-runtime", @"jsfix-helpers", @"fetch", @"worker-shims", @"regexp-shim"]) {
            NSString *path = [[NSBundle mainBundle] pathForResource:name ofType:@"js" inDirectory:@"js"];
            if (!path) path = [[NSBundle mainBundle] pathForResource:name ofType:@"js"];
            NSData *part = path ? [NSData dataWithContentsOfFile:path] : nil;
            if (!part.length) continue;
            [d appendData:part];
            [d appendData:[@"\n;\n" dataUsingEncoding:NSUTF8StringEncoding]];
        }
        bundle = d;
    });
    return bundle;
}

- (void)rewriteData:(NSData *)data kind:(NSString *)kind charset:(NSString *)charset pageURL:(NSURL *)pageURL
          mainFrame:(BOOL)mainFrame completion:(BRRewriteCompletion)completion
{
    [self rewriteData:data kind:kind charset:charset pageURL:pageURL sourceURL:nil mainFrame:mainFrame completion:completion];
}

- (void)rewriteData:(NSData *)data kind:(NSString *)kind charset:(NSString *)charset pageURL:(NSURL *)pageURL
          sourceURL:(NSURL *)sourceURL mainFrame:(BOOL)mainFrame completion:(BRRewriteCompletion)completion
{
    if (!completion) return;
    if ([kind isEqualToString:@"js"] || [kind isEqualToString:@"jsmodule"]) {
        // scripts on a transpiler engine (see scriptEngineFor:): stylesheets and documents do not wait behind them
        BOOL module = [kind isEqualToString:@"jsmodule"];
        NSUInteger generation = g_workGeneration;
        BRJSEngine *engine = [self scriptEngineFor:data.length urgent:NO];
        [engine performAsync:^{
            @autoreleasepool {
                if (generation != g_workGeneration) { completion(data, charset, NO); return; }   // (the page load was stopped)
                engine.lastNoRoom = NO;
                NSData *lowered = [BRSettings transpileEnabled] ? [self transpiledScript:data charset:charset url:sourceURL module:module engine:engine] : nil;
                // (a script left as it is for lack of memory is not cached as it is: base.js of YouTube stayed broken; nor
                // is a module's failure for lack of it: IKEA's agent module failed from the cache on every visit)
                if (lowered) completion(lowered, @"utf-8", !engine.lastNoRoom);
                else completion(data, charset, !engine.lastNoRoom);
            }
        }];
        return;
    }
    NSUInteger generation = g_workGeneration;
    [[BRJSEngine shared] performAsync:^{
        @autoreleasepool {
            if (generation != g_workGeneration) { completion(data, charset, NO); return; }   // (the page load was stopped)
            // (big documents and stylesheets wait for room like scripts, but are always rewritten)
            if (data.length > 256 * 1024)
                [BRMemory waitForAvailableMB:BRRoomFloorMB + (long)(data.length * BRRoomPerMBDocument / (1024 * 1024)) timeout:15
                                      reason:[NSString stringWithFormat:@"rewriting %@ (%lu KB)", kind, (unsigned long)(data.length >> 10)] engine:[BRJSEngine shared]];
            [BRMemory setActivity:[NSString stringWithFormat:@"rewriting %@ %@ (%lu KB)", kind, (sourceURL ?: pageURL).lastPathComponent ?: @"",
                                   (unsigned long)(data.length >> 10)] forKey:@"css"];
            NSData *outData = [self rewrittenData:data kind:kind charset:charset pageURL:pageURL mainFrame:mainFrame];
            [BRMemory setActivity:nil forKey:@"css"];
            [[BRJSEngine shared] releaseWhenIdleFor:BRRewriterIdleRelease aboveMB:BRRewriterIdleReleaseAboveMB];
            if (outData) completion(outData, @"utf-8", YES);
            else completion(data, charset, NO);   // (the rewriter failed this time: not cached as it is)
        }
    }];
}

// the rewriter's engine queue only: the rewritten document or stylesheet in UTF-8, nil to keep the original
- (NSData *)rewrittenData:(NSData *)data kind:(NSString *)kind charset:(NSString *)charset pageURL:(NSURL *)pageURL mainFrame:(BOOL)mainFrame
{
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    NSString *used = nil;
    if (![self ensureLoaded]) return nil;
    if (data.length > 200000 && [[NSUserDefaults standardUserDefaults] boolForKey:@"BRDumpRewriteInputs"]) {
        // debugging: big inputs as they came from the network, Caches/rewrite-inputs/<host>-<length>.<kind>
        NSString *dir = [[NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:@"rewrite-inputs"];
        [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
        [data writeToFile:[dir stringByAppendingPathComponent:[NSString stringWithFormat:@"%@-%lu.%@", pageURL.host ?: @"page", (unsigned long)data.length, kind]] atomically:NO];
    }
    NSString *declared = charset.length ? charset : BRSniffCharset(data, kind);
    NSString *text = BRDecode(data, declared, &used);
    if (!text) return nil;
    NSString *pageKey = BRPageKey(pageURL);
    NSMutableDictionary *vars = [self varsForPage:pageKey create:YES];
    NSString *varsJSON = @"{}";
    NSData *j = nil;
    @synchronized (self) { if (vars.count) j = [NSJSONSerialization dataWithJSONObject:vars options:0 error:NULL]; }
    if (j) varsJSON = [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding] ?: @"{}";
    NSString *optionsJSON = @"{}";
    {
        NSMutableDictionary *opts = [@{ @"pageURL": pageURL.absoluteString ?: @"", @"viewportWidth": @(g_viewportWidth),
                                        @"devicePixelRatio": @(g_devicePixelRatio) } mutableCopy];
        @synchronized ([BRCSSRewriter class]) {
            opts[@"viewportPortrait"] = @[ @(g_viewPortrait.width), @(g_viewPortrait.height) ];
            opts[@"viewportLandscape"] = @[ @(g_viewLandscape.width), @(g_viewLandscape.height) ];
            opts[@"orientation"] = g_landscape ? @"landscape" : @"portrait";
        }
        if ([kind isEqualToString:@"html"] && mainFrame) opts[@"mainFrame"] = @YES;
        // iframes (mostly ads and widgets) do not get the 500 KB bundle: memory on a 512 MB device
        if ([kind isEqualToString:@"html"] && mainFrame && [BRSettings jsFixEnabled]) opts[@"polyfillURL"] = [BRCSSRewriter polyfillURLString];
        if ([kind isEqualToString:@"html"] && [BRSettings hideCookieBanners]) opts[@"hideCookieBanners"] = @YES;
        // inline scripts in ES2015+ syntax: lowered by the transpiler in the same context (one too big for that goes
        // to the network layer as a script file; its text is kept on disk, so not in private mode)
        if ([kind isEqualToString:@"html"] && [BRSettings transpileEnabled] && [self ensureJSFixIn:[BRJSEngine shared]]) {
            opts[@"transpile"] = @YES;
            if (![BRSettings privateMode]) opts[@"externalScripts"] = @YES;
        }
        NSData *oj = [NSJSONSerialization dataWithJSONObject:opts options:0 error:NULL];
        if (oj) optionsJSON = [[NSString alloc] initWithData:oj encoding:NSUTF8StringEncoding] ?: @"{}";
    }
    NSString *result = [[BRJSEngine shared] callFunction:@"CSSFix.run" arguments:@[kind, text, varsJSON, optionsJSON]];
    if (!result.length) return nil;
    NSDictionary *parsed = [NSJSONSerialization JSONObjectWithData:[result dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
    NSString *out = [parsed isKindOfClass:[NSDictionary class]] ? parsed[@"out"] : nil;
    if (![out isKindOfClass:[NSString class]]) return nil;
    // the inline scripts set aside: the page asks for them as /__br_inline-<name>.js (see BRURLProtocol). The name the
    // file and the document get is made here, the BRTextKey of the text cssfix.js gave: the files are shared by every
    // site, and the quick hash cssfix.js names them by a page could match with a script of its own.
    NSArray *external = parsed[@"external"];
    if ([external isKindOfClass:[NSArray class]] && external.count) {
        [[NSFileManager defaultManager] createDirectoryAtPath:BRTranspiledDirectory() withIntermediateDirectories:YES attributes:nil error:NULL];
        NSMutableArray *given = [NSMutableArray array], *named = [NSMutableArray array];
        for (NSArray *e in external) {
            BOOL ok = [e isKindOfClass:[NSArray class]] && e.count == 2 && [e[0] isKindOfClass:[NSString class]] && [e[1] isKindOfClass:[NSString class]];
            NSString *script = ok ? e[1] : nil;
            NSData *d = [script dataUsingEncoding:NSUTF8StringEncoding];
            NSString *name = d ? BRTextKey(d, nil) : nil, *path = name ? BRInlineScriptPath(name) : nil;
            NSString *was = ok ? [NSString stringWithFormat:@"/__br_inline-%@.js", e[0]] : nil;
            NSString *now = name ? [NSString stringWithFormat:@"/__br_inline-%@.js", name] : nil;
            // (the text names its own address in its first lines, to take its src away: see fixScripts)
            NSRange own = path && was ? [script rangeOfString:was] : NSMakeRange(NSNotFound, 0);
            d = own.location != NSNotFound ? [[script stringByReplacingCharactersInRange:own withString:now] dataUsingEncoding:NSUTF8StringEncoding] : nil;
            if (!d || ![d writeToFile:path atomically:YES]) { BRLog(@"cssfix: an inline script could not be set aside, the document stays as it was"); return nil; }
            BRNoteTranspiledWrite(d.length);
            BRLog(@"cssfix: inline script of %lu KB set aside as %@", (unsigned long)(d.length >> 10), name);
            out = [out stringByReplacingOccurrencesOfString:[NSString stringWithFormat:@" src=\"%@\"", was] withString:[NSString stringWithFormat:@" src=\"%@\"", now]];
            [given addObject:e[0]];
            [named addObject:name];
        }
        // (and in the list at the document's end, see inlineScriptsPresentIn)
        NSString *list = [NSString stringWithFormat:@"<!--br-inline:%@-->", [given componentsJoinedByString:@","]];
        NSRange at = [out rangeOfString:list options:NSBackwardsSearch];
        if (at.location == NSNotFound) { BRLog(@"cssfix: the list of the inline scripts set aside is missing, the document stays as it was"); return nil; }
        out = [out stringByReplacingCharactersInRange:at withString:[NSString stringWithFormat:@"<!--br-inline:%@-->", [named componentsJoinedByString:@","]]];
    }
    external = nil;
    NSDictionary *newVars = parsed[@"vars"];
    NSArray *scoped = parsed[@"scoped"];
    @synchronized (self) {
        if ([newVars isKindOfClass:[NSDictionary class]] && newVars.count) {
            for (NSString *name in newVars) {
                id value = newVars[name];
                if ([value isKindOfClass:[NSString class]] && ![name isEqualToString:@" scoped"]) vars[name] = value;
            }
        }
        // custom properties resolved per element at run time, for the page's later documents (" scoped" is
        // not a property name, so it cannot clash with one)
        if ([scoped isKindOfClass:[NSArray class]] && scoped.count) {
            NSMutableOrderedSet *names = [NSMutableOrderedSet orderedSetWithArray:[vars[@" scoped"] ?: @"" componentsSeparatedByString:@" "]];
            for (id n in scoped) if ([n isKindOfClass:[NSString class]]) [names addObject:n];
            [names removeObject:@""];
            vars[@" scoped"] = [names.array componentsJoinedByString:@" "];
        }
    }
    NSData *outData = [out dataUsingEncoding:NSUTF8StringEncoding];
    BRLog(@"cssfix %@ %ld ms: %lu -> %lu bytes (%@, %lu vars)", kind, (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000),
          (unsigned long)data.length, (unsigned long)outData.length, used ?: @"?", (unsigned long)vars.count);
    if (data.length > 200000) [[BRJSEngine shared] collectGarbage];
    return outData;
}

@end
