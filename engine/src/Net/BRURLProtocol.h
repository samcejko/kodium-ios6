#import <Foundation/Foundation.h>

// NSURLProtocol that serves every http/https request of the app (including all UIWebView loads)
// through BRHTTPRequest, i.e. through our own TLS stack. Handles cookies, redirects and a simple
// HTTP cache on top of NSURLCache.
// Posted on the main thread while a page loads: userInfo page (URL string), started and finished (NSNumber).
extern NSString * const BRPageProgressNotification;
// Posted on the main thread when the HTML of a page (main frame) is about to reach WebKit: userInfo url (NSURL),
// bytes and videos (NSNumber: its size and its <video> elements, what makes a page heavy to draw).
extern NSString * const BRPageDocumentNotification;
// Posted on the main thread when a page loads a script too big for the iPad (past the rewrite limit): userInfo url
// (the page's NSURL) and script (NSURL)
extern NSString * const BRPageTooHeavyNotification;

// Asked on the main thread when a server wants HTTP Basic authentication. The completion may be called
// from any thread; nil user means cancelled.
typedef void (^BRAuthenticationHandler)(NSString *host, NSString *realm, void (^completion)(NSString *user, NSString *password));

@interface BRURLProtocol : NSURLProtocol

+ (void)registerProtocol;
+ (void)setAuthenticationHandler:(BRAuthenticationHandler)handler;
+ (void)forgetCredentials;                    // session credentials (Basic auth) are dropped
+ (NSString *)activeRequestsReport;           // requests WebKit started and has not stopped: age, state, URL

// What the last main document told us (for the lock icon and download detection)
+ (NSURL *)lastMainDocumentURL;
+ (NSString *)lastMainDocumentTLSInfo;       // "TLSv1.2 TLS-ECDHE-..." or nil for plain http
+ (NSString *)lastMainDocumentContentType;
+ (void)evictCachedScript:(NSString *)urlString;   // a script the page could not parse: its cached copy goes (once per URL)
// Responses to keep wait in memory until no cache lookup waits (see BRStoreLater): dropped when the cache is emptied
// (BRURLCache), so that nothing of before comes back
+ (void)dropPendingCacheStores;

@end

// The shared URL cache: NSURLCache that also forgets the responses still waiting to be written when it is emptied
@interface BRURLCache : NSURLCache

@end
