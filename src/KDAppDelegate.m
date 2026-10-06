#import "KDAppDelegate.h"
#import "KDWorkbenchViewController.h"
#import "KDSiteProtocol.h"
#import "BRURLProtocol.h"
#import "BRHTTPRequest.h"
#import "BRSettings.h"
#import "BRTLSSocket.h"
#import "BRCSSRewriter.h"
#import "BRJSEngine.h"
#import "BRMemory.h"
#import "BRCommon.h"

@implementation KDAppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
    // Surfari's engine, started the way Surfari starts it (engine/src): its settings before any request, the script
    // engine's tiers before any script is compiled
    [BRSettings prepareAtLaunch];
    NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
    BRLog(@"Kodium %@ (%@) starting on %@ (iOS %@)", info[@"CFBundleShortVersionString"] ?: @"?", info[@"CFBundleVersion"] ?: @"?",
          [UIDevice currentDevice].model, [UIDevice currentDevice].systemVersion);
    [BRJSEngine applyEngineTiers];

    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    // An HTTP cache for what comes from the network (the extension gallery), small: the workbench itself is in the app.
    // Its bodies are stored after rewriting, so a new rewriter starts a new cache.
    NSString *cacheName = [NSString stringWithFormat:@"kodium-cache-%@", [BRCSSRewriter rewriterTag]];
    [NSURLCache setSharedURLCache:[[BRURLCache alloc] initWithMemoryCapacity:2 * 1024 * 1024 diskCapacity:50 * 1024 * 1024 diskPath:cacheName]];
    [[NSHTTPCookieStorage sharedHTTPCookieStorage] setCookieAcceptPolicy:NSHTTPCookieAcceptPolicyAlways];
    // memory on a 512 MB device: no back/forward page cache, big images decoded through the disk cache
    [defaults setBool:NO forKey:@"WebKitUsesPageCachePreferenceKey"];
    [defaults setBool:YES forKey:@"WebKitDiskImageCacheEnabled"];
    // (the inspector's backend only on a developer's device, see BRDebugEnabled)
    if (BRDebugEnabled()) [defaults setBool:YES forKey:@"WebKitDeveloperExtras"];
    else [defaults removeObjectForKey:@"WebKitDeveloperExtras"];
    // navigator.userAgent: the identity the network layer sends. The browser's ad blocking and cookie banner hiding have
    // nothing to do in an editor (and no lists in this app).
    [defaults registerDefaults:@{ @"UserAgent": [BRSettings userAgentOverride] ?: [BRHTTPRequest defaultUserAgent],
                                  @"BRAdBlock": @NO, @"BRHideCookieBanners": @NO }];

    // Every http/https load goes through the engine's TLS stack and rewriters; the app's own site
    // (https://kodium.invalid/) through KDSiteProtocol, registered last so that it is asked first.
    [BRURLProtocol registerProtocol];
    [KDSiteProtocol registerProtocol];
    [BRMemory start];
    [BRTLSSocket warmUp];
    [BRCSSRewriter warmUp];

    self.window = [[UIWindow alloc] initWithFrame:[[UIScreen mainScreen] bounds]];
    self.window.rootViewController = [[KDWorkbenchViewController alloc] init];
    self.window.backgroundColor = [UIColor blackColor];
    [self.window makeKeyAndVisible];
    [application setStatusBarStyle:UIStatusBarStyleBlackOpaque animated:NO];
    return YES;
}

- (void)applicationDidReceiveMemoryWarning:(UIApplication *)application
{
    BRLog(@"Memory warning at %.0f MB, %ld MB available", BRResidentMemoryMB(), (long)[BRMemory availableMB]);
    [BRMemory relieve:@"memory warning"];   // the engine's script engines (made again on the next use), caches
}

@end
