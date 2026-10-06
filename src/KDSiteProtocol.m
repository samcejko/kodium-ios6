#import "KDSiteProtocol.h"
#import "KDFiles.h"
#import "BRCSSRewriter.h"
#import "BRCommon.h"

static NSString * const KDSiteHost = @"kodium.invalid";

static NSString *KDContentType(NSString *extension)
{
    static NSDictionary *types;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        types = @{ @"html": @"text/html; charset=utf-8", @"js": @"text/javascript; charset=utf-8", @"css": @"text/css; charset=utf-8",
                   @"json": @"application/json; charset=utf-8", @"txt": @"text/plain; charset=utf-8", @"svg": @"image/svg+xml",
                   @"png": @"image/png", @"gif": @"image/gif", @"ttf": @"font/ttf", @"wasm": @"application/wasm", @"mp3": @"audio/mpeg" };
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

+ (BOOL)canInitWithRequest:(NSURLRequest *)request
{
    NSURL *url = request.URL;
    NSString *scheme = [url.scheme lowercaseString];
    if (!([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"])) return NO;
    if (![[url.host lowercaseString] isEqualToString:KDSiteHost]) return NO;
    return ![url.path hasPrefix:@"/__br_"];
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
