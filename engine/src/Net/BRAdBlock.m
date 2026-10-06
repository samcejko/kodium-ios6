#import "BRAdBlock.h"
#import "BRCommon.h"

#include <libkern/OSAtomic.h>

#include <stdlib.h>
#include <string.h>

// The domains as C strings in one buffer, their offsets sorted: a lookup is a binary search. (OISD's list brought
// 57 000 domains; as an NSSet of strings they took some 6 MB of the iPad's memory, here about 1.3.)
static char *g_buf = NULL;
static uint32_t *g_offs = NULL;
static NSUInteger g_count = 0;
static dispatch_once_t g_once;
static volatile int32_t g_blocked = 0;

static int BRCompareDomainOffsets(const void *a, const void *b)
{
    return strcmp(g_buf + *(const uint32_t *)a, g_buf + *(const uint32_t *)b);
}

static void BRLoadDomains(void)
{
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    NSMutableData *buf = [NSMutableData data], *offs = [NSMutableData data];
    // (adblock-base: bundled, the project's own; adblock-oisd: OISD small, "block, don't break", fetched at build time)
    for (NSString *name in @[@"adblock-base", @"adblock-oisd"]) {
        NSString *path = [[NSBundle mainBundle] pathForResource:name ofType:@"txt"];
        NSData *data = path ? [NSData dataWithContentsOfFile:path options:NSDataReadingMappedIfSafe error:NULL] : nil;
        const char *p = data.bytes, *end = p + data.length;
        while (p && p < end) {
            const char *nl = memchr(p, '\n', (size_t)(end - p));
            const char *lineEnd = nl ?: end, *s = p;
            p = nl ? nl + 1 : end;
            while (s < lineEnd && (*s == ' ' || *s == '\t')) s++;
            const char *e = lineEnd;
            while (e > s && (e[-1] == '\r' || e[-1] == ' ' || e[-1] == '\t')) e--;
            if (s >= e || *s == '#' || *s == '!') continue;
            // hosts-file style lines ("0.0.0.0 domain") are tolerated
            const char *sp = memchr(s, ' ', (size_t)(e - s));
            if (sp) { s = sp + 1; while (s < e && *s == ' ') s++; }
            size_t len = (size_t)(e - s);
            if (len < 3 || len > 253 || !memchr(s, '.', len) || (len == 9 && !strncmp(s, "localhost", 9))) continue;
            uint32_t at = (uint32_t)buf.length;
            [offs appendBytes:&at length:sizeof(at)];
            char lower[256];
            for (size_t i = 0; i < len; i++) { char c = s[i]; lower[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }
            lower[len] = 0;
            [buf appendBytes:lower length:len + 1];
        }
    }
    NSUInteger n = offs.length / sizeof(uint32_t);
    char *b = malloc(buf.length ?: 1);
    uint32_t *o = malloc((n ?: 1) * sizeof(uint32_t));
    if (!b || !o) { free(b); free(o); return; }
    memcpy(b, buf.bytes, buf.length);
    memcpy(o, offs.bytes, n * sizeof(uint32_t));
    g_buf = b;
    qsort(o, n, sizeof(uint32_t), BRCompareDomainOffsets);
    // (the same domain in two lists once)
    NSUInteger kept = 0;
    for (NSUInteger i = 0; i < n; i++) if (!kept || strcmp(b + o[i], b + o[kept - 1])) o[kept++] = o[i];
    g_offs = o;
    g_count = kept;
    BRLog(@"Ad block list loaded: %lu domains (%lu KB) in %ld ms", (unsigned long)kept, (unsigned long)((buf.length + kept * 4) >> 10),
          (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000));
}

static BOOL BRHasDomain(const char *d)
{
    NSUInteger lo = 0, hi = g_count;
    while (lo < hi) {
        NSUInteger mid = (lo + hi) / 2;
        int c = strcmp(g_buf + g_offs[mid], d);
        if (c == 0) return YES;
        if (c < 0) lo = mid + 1; else hi = mid;
    }
    return NO;
}

@implementation BRAdBlock

+ (void)ensureLoaded
{
    dispatch_once(&g_once, ^{ BRLoadDomains(); });
}

+ (void)warmUp
{
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_LOW, 0), ^{
        [BRAdBlock ensureLoaded];
    });
}

+ (NSUInteger)domainCount
{
    [self ensureLoaded];
    return g_count;
}

+ (BOOL)shouldBlockHost:(NSString *)host
{
    if (!host.length) return NO;
    [self ensureLoaded];
    if (!g_count) return NO;
    char h[256];
    if (![[host lowercaseString] getCString:h maxLength:sizeof(h) encoding:NSUTF8StringEncoding]) return NO;
    // the host and each parent domain, never a bare TLD
    for (const char *d = h; d; ) {
        if (!strchr(d, '.')) return NO;
        if (BRHasDomain(d)) return YES;
        const char *dot = strchr(d, '.');
        d = dot ? dot + 1 : NULL;
    }
    return NO;
}

+ (void)noteBlockedRequest
{
    OSAtomicIncrement32(&g_blocked);
}

+ (NSUInteger)blockedRequestCount
{
    return (NSUInteger)g_blocked;
}

+ (BOOL)isTagManagerScript:(NSData *)body
{
    if (body.length < 200) return NO;
    NSUInteger n = MIN(body.length, (NSUInteger)600);
    NSString *head = [[NSString alloc] initWithBytes:body.bytes length:n encoding:NSISOLatin1StringEncoding];
    NSRange copyright = [head rangeOfString:@"// Copyright 2012 Google Inc. All rights reserved."];
    return copyright.location != NSNotFound && copyright.location < 16 && [head rangeOfString:@"\"resource\""].location != NSNotFound;
}

static NSString * const BRTagGatewaysKey = @"BRTagGateways";

// the path as written (NSURL's path drops a trailing slash), without query and fragment
static NSString *BRRawPath(NSURL *url)
{
    NSString *s = url.absoluteString ?: @"";
    NSRange scheme = [s rangeOfString:@"://"];
    if (scheme.location == NSNotFound) return url.path ?: @"";
    NSUInteger from = scheme.location + 3;
    NSRange slash = [s rangeOfString:@"/" options:0 range:NSMakeRange(from, s.length - from)];
    if (slash.location == NSNotFound) return @"/";
    NSString *rest = [s substringFromIndex:slash.location];
    NSRange end = [rest rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"?#"]];
    return end.location == NSNotFound ? rest : [rest substringToIndex:end.location];
}

// host + directory of the script: "www.rohlik.cz/ta1w/" (never a whole host)
static NSString *BRTagDirectory(NSURL *url)
{
    NSString *path = BRRawPath(url);
    NSRange slash = [path rangeOfString:@"/" options:NSBackwardsSearch];
    if (slash.location == NSNotFound || slash.location == 0 || !url.host.length) return nil;
    return [[NSString stringWithFormat:@"%@%@", url.host, [path substringToIndex:slash.location + 1]] lowercaseString];
}

static NSMutableArray *BRTagGateways(void)
{
    static NSMutableArray *list;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSArray *saved = [[NSUserDefaults standardUserDefaults] arrayForKey:BRTagGatewaysKey];
        list = [NSMutableArray arrayWithArray:[saved isKindOfClass:[NSArray class]] ? saved : @[]];
    });
    return list;
}

+ (void)noteTagScriptAtURL:(NSURL *)url
{
    NSString *dir = BRTagDirectory(url);
    if (!dir) return;
    NSArray *snapshot = nil;
    @synchronized (self) {
        NSMutableArray *list = BRTagGateways();
        if ([list containsObject:dir]) return;
        [list addObject:dir];
        while (list.count > 64) [list removeObjectAtIndex:0];
        snapshot = [list copy];
    }
    [[NSUserDefaults standardUserDefaults] setObject:snapshot forKey:BRTagGatewaysKey];
    BRLog(@"Ad block: Google tag scripts served from %@ (answered with the stub from now on)", dir);
}

+ (BOOL)isKnownTagScriptURL:(NSURL *)url
{
    NSString *s = [[NSString stringWithFormat:@"%@%@", url.host ?: @"", BRRawPath(url)] lowercaseString];
    @synchronized (self) {
        for (NSString *dir in BRTagGateways()) if ([s hasPrefix:dir]) return YES;
    }
    return NO;
}

+ (BOOL)isTagManagerHost:(NSString *)host
{
    NSString *h = [host lowercaseString] ?: @"";
    for (NSString *d in @[@"googletagmanager.com", @"google-analytics.com"])
        if ([h isEqualToString:d] || [h hasSuffix:[@"." stringByAppendingString:d]]) return YES;
    return NO;
}

+ (NSData *)tagScriptStub
{
    static NSData *stub;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *js =
        @"(function(){var w=window,noop=function(){};"
        @"var later=function(f){setTimeout(function(){try{f()}catch(e){}},1)};"
        @"var settle=function(o){if(!o||typeof o!=='object')return;"
        @"if(typeof o.eventCallback==='function'){later(o.eventCallback);o.eventCallback=noop}"
        @"if(typeof o.hitCallback==='function'){later(o.hitCallback);o.hitCallback=noop}"
        @"var last=typeof o.length==='number'&&o.length>0?o[o.length-1]:null;"
        @"if(last&&typeof last==='object'&&typeof last.event_callback==='function'){later(last.event_callback);last.event_callback=noop}};"
        @"var dl=w.dataLayer;"
        @"if(dl&&typeof dl==='object'){"
        @"if(dl.hide&&typeof dl.hide.end==='function'){try{dl.hide.end()}catch(e){}dl.hide.end=noop}"
        @"if(typeof dl.push==='function'&&!dl.push.__brStub){var push=dl.push,p=function(){for(var i=0;i<arguments.length;i++)settle(arguments[i]);return push.apply(this,arguments)};"
        @"p.__brStub=true;dl.push=p;for(var k=0;k<dl.length;k++)settle(dl[k])}}"
        @"if(typeof w.ga==='function'&&w.ga.q&&!w.ga.loaded){var q=w.ga.q;w.ga=function(){settle(arguments[arguments.length-1])};w.ga.loaded=true;"
        @"for(var j=0;j<q.length;j++){var a=q[j];if(a&&a.length)settle(a[a.length-1])}}"
        @"try{var h=document.documentElement;h.className=h.className.replace(/\\basync-hide\\b/g,'')}catch(e){}"
        @"})();";
        stub = [js dataUsingEncoding:NSUTF8StringEncoding];
    });
    return stub;
}

@end
