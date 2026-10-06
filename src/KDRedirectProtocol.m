#import "KDRedirectProtocol.h"
#import "BRHTTPRequest.h"
#import "BRSettings.h"
#import "BRCommon.h"

static const NSInteger KDMaxRedirects = 5;

// an asset address of Open VSX: /vscode/asset/<namespace>/<name>/<version>/<asset type>, or
// /api/<namespace>/<name>/<version>/file/<path>
static BOOL KDIsOpenVSXAsset(NSURL *url)
{
    NSString *scheme = [url.scheme lowercaseString];
    if (!([scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"])) return NO;
    if (![[url.host lowercaseString] isEqualToString:@"open-vsx.org"]) return NO;
    NSString *path = url.path ?: @"";
    if ([path hasPrefix:@"/vscode/asset/"]) return YES;
    NSArray *parts = [path componentsSeparatedByString:@"/"];
    return parts.count > 6 && [parts[1] isEqualToString:@"api"] && [parts[5] isEqualToString:@"file"];
}

@interface KDRedirectProtocol ()
@property (nonatomic, strong) BRHTTPRequest *http;
@property (nonatomic, strong) NSThread *clientThread;
@property (nonatomic, strong) NSArray *clientModes;
@property (atomic) BOOL stopped;
@end

@implementation KDRedirectProtocol

+ (void)registerProtocol
{
    [NSURLProtocol registerClass:self];
}

+ (BOOL)canInitWithRequest:(NSURLRequest *)request
{
    NSString *method = [request.HTTPMethod uppercaseString] ?: @"GET";
    if (!([method isEqualToString:@"GET"] || [method isEqualToString:@"HEAD"] || [method isEqualToString:@"OPTIONS"])) return NO;
    return KDIsOpenVSXAsset(request.URL);
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request
{
    return request;
}

// (the client is talked to on the thread that called -startLoading, in its run loop modes, as KDSiteProtocol does)
- (void)performOnClientThread:(dispatch_block_t)block
{
    if (!self.clientThread || !block) return;
    [self performSelector:@selector(kd_runBlock:) onThread:self.clientThread withObject:[block copy] waitUntilDone:NO modes:self.clientModes];
}

- (void)kd_runBlock:(dispatch_block_t)block
{
    if (!self.stopped) block();
}

- (void)startLoading
{
    self.clientThread = [NSThread currentThread];
    NSString *mode = [[NSRunLoop currentRunLoop] currentMode];
    NSMutableArray *modes = [NSMutableArray arrayWithObject:NSDefaultRunLoopMode];
    if (mode.length && ![mode isEqualToString:NSDefaultRunLoopMode]) [modes addObject:mode];
    self.clientModes = modes;

    // a preflight: any origin, the page's headers
    if ([[self.request.HTTPMethod uppercaseString] isEqualToString:@"OPTIONS"]) {
        NSString *asked = [self.request valueForHTTPHeaderField:@"Access-Control-Request-Headers"] ?: @"";
        [self deliverStatus:204 headers:@{ @"Access-Control-Allow-Origin": @"*", @"Access-Control-Allow-Methods": @"GET, HEAD, OPTIONS",
                                            @"Access-Control-Allow-Headers": asked, @"Access-Control-Max-Age": @"86400" } body:nil];
        return;
    }
    [self fetch:self.request.URL redirects:0];
}

- (void)stopLoading
{
    self.stopped = YES;
    [self.http cancel];
}

- (void)fetch:(NSURL *)url redirects:(NSInteger)redirects
{
    BRHTTPRequest *r = [[BRHTTPRequest alloc] initWithMethod:@"GET" URL:url];
    r.verifyTLS = [BRSettings verifyTLS];
    // (the page's own headers - Accept, X-Client-Name... - but not the transport's, nor its origin and cookies)
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    NSSet *skip = [NSSet setWithObjects:@"host", @"origin", @"referer", @"cookie", @"content-length", @"accept-encoding", @"connection", nil];
    [self.request.allHTTPHeaderFields enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSString *value, BOOL *stop) {
        if (![skip containsObject:[name lowercaseString]]) headers[name] = value;
    }];
    if (!headers[@"User-Agent"]) headers[@"User-Agent"] = [BRHTTPRequest defaultUserAgent];
    r.headers = headers;
    __weak KDRedirectProtocol *weakSelf = self;
    __weak BRHTTPRequest *weakRequest = r;   // (alive inside onComplete: a request keeps itself alive until it returns)
    r.onComplete = ^(NSError *error) {
        KDRedirectProtocol *me = weakSelf;
        BRHTTPRequest *done = weakRequest;
        if (!me || me.stopped || !done) return;
        NSInteger status = done.statusCode;
        NSString *location = done.responseHeaders[@"location"];
        if (!error && status >= 300 && status < 400 && location.length) {
            NSURL *next = [[NSURL URLWithString:location relativeToURL:url] absoluteURL];
            if (next && redirects < KDMaxRedirects) { [me fetch:next redirects:redirects + 1]; return; }
        }
        if (error) {
            BRLog(@"Open VSX asset %@ failed: %@", url.absoluteString, error.localizedDescription);
            [me performOnClientThread:^{ [me.client URLProtocol:me didFailWithError:error]; }];
            return;
        }
        NSMutableDictionary *answer = [NSMutableDictionary dictionaryWithObject:@"*" forKey:@"Access-Control-Allow-Origin"];
        for (NSString *name in @[@"content-type", @"cache-control", @"etag", @"last-modified", @"expires"]) {
            NSString *value = done.responseHeaders[name];
            if (value.length) answer[[name capitalizedString]] = value;
        }
        BOOL head = [[me.request.HTTPMethod uppercaseString] isEqualToString:@"HEAD"];
        [me deliverStatus:status headers:answer body:head ? nil : done.responseBody];
    };
    self.http = r;
    [r start];
}

- (void)deliverStatus:(NSInteger)status headers:(NSDictionary *)headers body:(NSData *)body
{
    NSMutableDictionary *fields = [headers mutableCopy];
    fields[@"Content-Length"] = [NSString stringWithFormat:@"%lu", (unsigned long)body.length];
    [self performOnClientThread:^{
        NSHTTPURLResponse *response = [[NSHTTPURLResponse alloc] initWithURL:self.request.URL statusCode:status HTTPVersion:@"HTTP/1.1" headerFields:fields];
        [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:NSURLCacheStorageAllowedInMemoryOnly];
        if (body.length) [self.client URLProtocol:self didLoadData:body];
        [self.client URLProtocolDidFinishLoading:self];
    }];
}

@end
