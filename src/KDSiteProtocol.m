#import "KDSiteProtocol.h"
#import "KDFiles.h"
#import "BRCSSRewriter.h"
#import "BRCommon.h"
#import "BRJSEngine.h"
#include <dlfcn.h>

NSString * const KDShareFileNotification = @"KDShareFileNotification";

// (when the engine's keeper of the compiled code started, and whether the warm-up had the start's code thrown away)
static CFAbsoluteTime g_codeKeeperStarted;
static BOOL g_startCodeThrown;

static NSString * const KDSiteHost = @"kodium.invalid";
// the app's Documents as a web site of its own, for the preview of a page (web/src/preview.ts)
static NSString * const KDPreviewHost = @"preview.kodium.invalid";

static NSString *KDContentType(NSString *extension)
{
    static NSDictionary *types;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        types = @{ @"html": @"text/html; charset=utf-8", @"htm": @"text/html; charset=utf-8", @"xhtml": @"application/xhtml+xml; charset=utf-8",
                   @"js": @"text/javascript; charset=utf-8", @"mjs": @"text/javascript; charset=utf-8", @"css": @"text/css; charset=utf-8",
                   @"json": @"application/json; charset=utf-8", @"txt": @"text/plain; charset=utf-8", @"md": @"text/plain; charset=utf-8",
                   @"xml": @"application/xml; charset=utf-8", @"csv": @"text/csv; charset=utf-8", @"svg": @"image/svg+xml",
                   @"png": @"image/png", @"gif": @"image/gif", @"jpg": @"image/jpeg", @"jpeg": @"image/jpeg", @"webp": @"image/webp",
                   @"ico": @"image/x-icon", @"ttf": @"font/ttf", @"otf": @"font/otf", @"woff": @"font/woff", @"woff2": @"font/woff2",
                   @"wasm": @"application/wasm", @"mp3": @"audio/mpeg", @"m4a": @"audio/mp4", @"wav": @"audio/wav",
                   @"mp4": @"video/mp4", @"mov": @"video/quicktime", @"pdf": @"application/pdf" };
    });
    return types[[extension lowercaseString]] ?: @"application/octet-stream";
}

static NSString *KDStylesheetCacheDirectory(void)
{
    return [[NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES) firstObject] stringByAppendingPathComponent:@"kodium-site"];
}

@interface KDSiteProtocol ()
@property (nonatomic, strong) NSThread *clientThread;
@property (nonatomic, strong) NSArray *clientModes;
@property (atomic) BOOL stopped;
@end

@implementation KDSiteProtocol

+ (void)registerProtocol
{
    [NSURLProtocol registerClass:self];
}

+ (NSURL *)startURL
{
    return [NSURL URLWithString:[NSString stringWithFormat:@"https://%@/index.html", KDSiteHost]];
}

+ (void)noteCodeKeeperStarted
{
    g_codeKeeperStarted = CFAbsoluteTimeGetCurrent();
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request
{
    NSURL *url = request.URL;
    NSString *scheme = [url.scheme lowercaseString];
    if (!([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"])) return NO;
    NSString *host = [url.host lowercaseString];
    if (![host isEqualToString:KDSiteHost] && ![host isEqualToString:KDPreviewHost]) return NO;
    return ![url.path hasPrefix:@"/__br_"];   // (the engine's own: its polyfills, which it serves itself)
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request
{
    return request;
}

// Resources/site/<path of the URL>; nil for anything else (no way out of the folder with ..)
+ (NSString *)filePathForURL:(NSURL *)url
{
    NSString *root = [[[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"site"] stringByStandardizingPath];
    NSString *path = url.path.length > 1 ? url.path : @"/index.html";
    NSString *file = [[root stringByAppendingPathComponent:path] stringByStandardizingPath];
    if (![file hasPrefix:[root stringByAppendingString:@"/"]]) return nil;
    BOOL directory = NO;
    if (![[NSFileManager defaultManager] fileExistsAtPath:file isDirectory:&directory] || directory) return nil;
    return file;
}

#pragma mark - Client thread

// The NSURLProtocolClient is talked to on the thread that called -startLoading, in the run loop modes of that time
// (as BRURLProtocol does).
- (void)performOnClientThread:(dispatch_block_t)block
{
    if (!self.clientThread || !block) return;
    [self performSelector:@selector(kd_runBlock:) onThread:self.clientThread withObject:[block copy] waitUntilDone:NO modes:self.clientModes];
}

- (void)kd_runBlock:(dispatch_block_t)block
{
    if (!self.stopped) block();
}

#pragma mark - Loading

- (void)startLoading
{
    self.clientThread = [NSThread currentThread];
    NSString *mode = [[NSRunLoop currentRunLoop] currentMode];
    NSMutableArray *modes = [NSMutableArray arrayWithObject:NSDefaultRunLoopMode];
    if (mode.length && ![mode isEqualToString:NSDefaultRunLoopMode]) [modes addObject:mode];
    self.clientModes = modes;

    NSURL *url = self.request.URL;
    if ([[url.host lowercaseString] isEqualToString:KDPreviewHost]) {
        [self servePreview];
        return;
    }
    // the workbench's Share... (web/src/share.ts): the view controller shows the system's menu
    if ([url.path isEqualToString:@"/__kd/app/share"]) {
        NSMutableDictionary *q = [NSMutableDictionary dictionary];
        for (NSString *pair in [url.query ?: @"" componentsSeparatedByString:@"&"]) {
            NSRange eq = [pair rangeOfString:@"="];
            if (eq.location == NSNotFound) continue;
            NSString *value = [[pair substringFromIndex:eq.location + 1] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
            if (value) q[[pair substringToIndex:eq.location]] = value;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            [[NSNotificationCenter defaultCenter] postNotificationName:KDShareFileNotification object:nil userInfo:q];
        });
        [self deliverData:[NSData data] type:@"text/plain" status:200];
        return;
    }
    // the workbench has had no input for a while (web/prelude/vsc-prelude.js): the garbage collection JavaScriptCore
    // would run some seconds later - in the middle of the next action, as often as not - comes now, once 4 MB were
    // allocated since the last one (Surfari's engine)
    if ([url.path isEqualToString:@"/__kd/app/idle"]) {
        [BRJSEngine collectPageGarbageIfAllocated:4 * 1024 * 1024];
        [self deliverData:[NSData data] type:@"text/plain" status:200];
        return;
    }
    // The warm-up behind the splash (web/src/warmup.ts) asks between its steps: the start's compiled code thrown away now.
    // Surfari's engine keeps the pages' code (BRJSEngine keepPageCode) once the start's is gone - which it sees at its
    // second tick, the first being 20 s after launch: thrown away by JavaScriptCore at a collection a minute after the
    // start, or by the engine at 75 s, and the warm-up's code went with it (its first actions as slow as without it).
    // Thrown away after the first tick (2 s to spare), what the warm-up compiles from then on is what is kept.
    // "later" before that, "done" once thrown away, "no" when the engine keeps no code.
    if ([url.path isEqualToString:@"/__kd/app/keepcode"]) {
        void (*run)(void (^)(void)) = (void (*)(void (^)(void)))dlsym(RTLD_DEFAULT, "WebThreadRun");
        NSString *answer = g_startCodeThrown ? @"done" : !run || !g_codeKeeperStarted ? @"no"
                         : CFAbsoluteTimeGetCurrent() - g_codeKeeperStarted < 22 ? @"later" : nil;
        if (answer) {
            [self deliverData:[answer dataUsingEncoding:NSUTF8StringEncoding] type:@"text/plain" status:200];
            return;
        }
        g_startCodeThrown = YES;
        // (on the WebThread between scripts, as the engine does it)
        run(^{
            BOOL done = [BRJSEngine discardPageCode];
            BRLog(@"Warm-up: the start's compiled code %@", done ? @"thrown away, the warm-up's is kept" : @"not found");
            [self performOnClientThread:^{
                [self deliverData:[(done ? @"done" : @"no") dataUsingEncoding:NSUTF8StringEncoding] type:@"text/plain" status:200];
            }];
        });
        return;
    }
    // the files of the app's Documents (KDFiles)
    if ([url.path hasPrefix:@"/__kd/fs/"]) {
        [KDFiles performOperation:[url.path substringFromIndex:9] request:self.request completion:^(NSInteger status, NSData *body, NSString *type) {
            [self performOnClientThread:^{ [self deliverData:body ?: [NSData data] type:type ?: @"text/plain" status:status]; }];
        }];
        return;
    }
    NSString *file = [KDSiteProtocol filePathForURL:url];
    if (!file) {
        BRLog(@"Not in the app's site: %@", url.path);
        [self.client URLProtocol:self didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorFileDoesNotExist
                                                                      userInfo:@{ NSURLErrorFailingURLStringErrorKey: url.absoluteString ?: @"" }]];
        return;
    }
    NSString *extension = [[file pathExtension] lowercaseString];
    BRCSSRewriter *rewriter = [BRCSSRewriter shared];
    if ([extension isEqualToString:@"html"] && rewriter.available) {
        [self serveRewritten:[NSData dataWithContentsOfFile:file] kind:@"html"];
        return;
    }
    if ([extension isEqualToString:@"css"] && rewriter.available) {
        [self serveStylesheet:file];
        return;
    }
    // scripts (ES5 already), fonts, pictures: as they are, and mapped rather than read (the workbench is 17 MB)
    NSData *data = [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:NULL];
    [self deliverData:data ?: [NSData data] type:KDContentType(extension)];
}

- (void)stopLoading
{
    self.stopped = YES;
}

// The app's Documents as a web site of its own (https://preview.kodium.invalid/<path>), for the preview of a page the
// user writes (web/src/preview.ts): another origin than the workbench's, so that the page cannot reach into the
// workbench. Its documents, stylesheets and scripts go through the engine's rewriters as a web site's do in Surfari
// (modern scripts lowered, modern CSS rewritten, the polyfills in the page); a folder is its index.html.
- (void)servePreview
{
    NSURL *url = self.request.URL;
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *file = [KDFiles filePathFor:url.path.length ? url.path : @"/" root:[KDFiles rootDirectory]];
    BOOL directory = NO;
    if (file && [fm fileExistsAtPath:file isDirectory:&directory] && directory) file = [file stringByAppendingPathComponent:@"index.html"];
    if (!file || ![fm fileExistsAtPath:file isDirectory:&directory] || directory) {
        NSString *path = [[url.path ?: @"" stringByReplacingOccurrencesOfString:@"&" withString:@"&amp;"] stringByReplacingOccurrencesOfString:@"<" withString:@"&lt;"];
        NSString *page = [NSString stringWithFormat:@"<!DOCTYPE html><meta charset=\"utf-8\"><title>404</title>"
                          "<p style=\"font:14px sans-serif;color:#777;margin:20px\">404: %@</p>", path];
        NSData *body = [page dataUsingEncoding:NSUTF8StringEncoding];
        [self performOnClientThread:^{ [self deliverData:body type:KDContentType(@"html") status:404]; }];
        return;
    }
    NSString *extension = [[file pathExtension] lowercaseString];
    NSData *data = [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:NULL] ?: [NSData data];
    NSString *kind = ([extension isEqualToString:@"html"] || [extension isEqualToString:@"htm"]) ? @"html"
                   : [extension isEqualToString:@"css"] ? @"css"
                   : ([extension isEqualToString:@"js"] || [extension isEqualToString:@"mjs"]) ? @"js" : nil;
    BRCSSRewriter *rewriter = [BRCSSRewriter shared];
    if (!kind || !rewriter.available || !data.length) {
        [self performOnClientThread:^{ [self deliverData:data type:KDContentType(extension)]; }];
        return;
    }
    // the page a stylesheet or script is for: the document that asked for it (the engine keeps a page's variables and
    // rules by its address, and the page's shim asks for them by it)
    BOOL document = [kind isEqualToString:@"html"];
    NSURL *referer = [NSURL URLWithString:[self.request valueForHTTPHeaderField:@"Referer"] ?: @""];
    NSURL *page = (!document && [[referer.host lowercaseString] isEqualToString:KDPreviewHost]) ? referer : url;
    [rewriter rewriteData:data kind:kind charset:@"utf-8" pageURL:page sourceURL:url mainFrame:document
               completion:^(NSData *output, NSString *charset, BOOL keep) {
        if (self.stopped) return;
        NSData *body = output ?: data;
        if (![kind isEqualToString:@"js"]) {
            [rewriter registerManifestInData:body pageURL:page sourceURL:url];
            body = [BRCSSRewriter dataWithoutManifest:body];
        }
        [self performOnClientThread:^{ [self deliverData:body type:KDContentType(extension)]; }];
    }];
}

// A document or stylesheet through the engine's rewriter; its manifest (the rules the page shim evaluates) goes to the
// engine for this page, WebKit gets the text without it
- (void)serveRewritten:(NSData *)data kind:(NSString *)kind
{
    NSURL *url = self.request.URL;
    NSURL *page = self.request.mainDocumentURL ?: url;
    BOOL mainFrame = !self.request.mainDocumentURL || [url isEqual:self.request.mainDocumentURL];
    [[BRCSSRewriter shared] rewriteData:data kind:kind charset:@"utf-8" pageURL:page sourceURL:url mainFrame:mainFrame
                             completion:^(NSData *output, NSString *charset, BOOL keep) {
        if (self.stopped) return;
        [self deliverRewritten:output ?: data kind:kind];
    }];
}

// A stylesheet that the build rewrote already (it starts with /*kodium:rewritten*/, see web/tools/assemble-site.mjs)
// is served as it is; any other is rewritten once and kept (the 650 KB of the workbench take seconds on the iPad): by
// the file's size and date, the rewriter's checksum and the app's build
- (void)serveStylesheet:(NSString *)file
{
    NSData *head = [[NSFileHandle fileHandleForReadingAtPath:file] readDataOfLength:20];
    if ([head isEqualToData:[@"/*kodium:rewritten*/" dataUsingEncoding:NSUTF8StringEncoding]]) {
        [self deliverRewritten:[NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:NULL] ?: [NSData data] kind:@"css"];
        return;
    }
    NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:file error:NULL];
    NSString *build = [[NSBundle mainBundle] infoDictionary][@"CFBundleVersion"] ?: @"0";
    NSString *stem = [[file lastPathComponent] stringByDeletingPathExtension];
    NSString *name = [NSString stringWithFormat:@"%@-%llu-%.0f-%@-%@.css", stem, [attributes fileSize],
                      [[attributes fileModificationDate] timeIntervalSince1970], [BRCSSRewriter rewriterTag], build];
    NSString *dir = KDStylesheetCacheDirectory();
    NSString *cached = [dir stringByAppendingPathComponent:name];
    NSData *kept = [NSData dataWithContentsOfFile:cached options:NSDataReadingMappedIfSafe error:NULL];
    if (kept.length) {
        [self deliverRewritten:kept kind:@"css"];
        return;
    }
    NSData *data = [NSData dataWithContentsOfFile:file];
    NSURL *url = self.request.URL;
    NSURL *page = self.request.mainDocumentURL ?: url;
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    [[BRCSSRewriter shared] rewriteData:data kind:@"css" charset:@"utf-8" pageURL:page sourceURL:url mainFrame:NO
                             completion:^(NSData *output, NSString *charset, BOOL keep) {
        BRLog(@"Stylesheet %@ rewritten in %.1f s", stem, [NSDate timeIntervalSinceReferenceDate] - t0);
        if (output && keep) {
            NSFileManager *fm = [NSFileManager defaultManager];
            [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
            // (copies of another build or rewriter go)
            NSString *prefix = [stem stringByAppendingString:@"-"];
            for (NSString *old in [fm contentsOfDirectoryAtPath:dir error:NULL]) {
                if ([old hasPrefix:prefix] && ![old isEqualToString:name]) [fm removeItemAtPath:[dir stringByAppendingPathComponent:old] error:NULL];
            }
            [output writeToFile:cached atomically:YES];
        }
        if (self.stopped) return;
        [self deliverRewritten:output ?: data kind:@"css"];
    }];
}

- (void)deliverRewritten:(NSData *)data kind:(NSString *)kind
{
    NSURL *url = self.request.URL;
    [[BRCSSRewriter shared] registerManifestInData:data pageURL:self.request.mainDocumentURL ?: url sourceURL:url];
    NSData *body = [BRCSSRewriter dataWithoutManifest:data];
    NSString *type = KDContentType([kind isEqualToString:@"css"] ? @"css" : @"html");
    [self performOnClientThread:^{ [self deliverData:body type:type]; }];
}

// client thread
- (void)deliverData:(NSData *)body type:(NSString *)type
{
    [self deliverData:body type:type status:200];
}

- (void)deliverData:(NSData *)body type:(NSString *)type status:(NSInteger)status
{
    NSDictionary *fields = @{ @"Content-Type": type, @"Content-Length": [NSString stringWithFormat:@"%lu", (unsigned long)body.length],
                              @"Cache-Control": @"no-store", @"Access-Control-Allow-Origin": @"*" };
    NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:fields];
    [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageNotAllowed];
    if (body.length) [self.client URLProtocol:self didLoadData:body];
    [self.client URLProtocolDidFinishLoading:self];
}

@end
