#import <Foundation/Foundation.h>

// Host based ad and tracker blocking. The domain lists (Resources/adblock-base.txt, bundled, and adblock-oisd.txt,
// fetched at build time; one domain per line) are matched against the request host and all of its parent domains.
@interface BRAdBlock : NSObject

+ (void)warmUp;                                  // loads the list on a background queue
+ (BOOL)shouldBlockHost:(NSString *)host;
+ (NSUInteger)domainCount;

+ (void)noteBlockedRequest;
+ (NSUInteger)blockedRequestCount;               // total since launch

// Google's tag scripts (gtm.js, gtag/js: 400-700 KB each, a minute of lowering on the iPad) also come from the site's
// own host under an invented path (rohlik.cz/ta1w/...). They are recognised by their first lines and their directory
// is then answered with the stub straight away (remembered, 64 at most).
+ (BOOL)isTagManagerScript:(NSData *)body;
+ (void)noteTagScriptAtURL:(NSURL *)url;
+ (BOOL)isKnownTagScriptURL:(NSURL *)url;
+ (BOOL)isTagManagerHost:(NSString *)host;       // googletagmanager.com, google-analytics.com
// What a blocked tag script is answered with: the callbacks a page hands to the tags run at once (dataLayer
// eventCallback, gtag event_callback, ga hitCallback) and the anti-flicker hiding ends, as uBlock Origin's stubs do.
+ (NSData *)tagScriptStub;

@end
