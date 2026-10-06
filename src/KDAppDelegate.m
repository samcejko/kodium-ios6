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
#import "BRProfiler.h"
#import "BRCommon.h"
#include <dlfcn.h>

// Same length and same bytes, compared in constant time
static BOOL KDSameSecret(NSString *a, NSString *b)
{
    NSData *x = [a dataUsingEncoding:NSUTF8StringEncoding], *y = [b dataUsingEncoding:NSUTF8StringEncoding];
    if (!x.length || x.length != y.length) return NO;
    const uint8_t *p = x.bytes, *q = y.bytes;
    uint8_t diff = 0;
    for (NSUInteger i = 0; i < x.length; i++) diff |= p[i] ^ q[i];
    return diff == 0;
}

// The parameters of a kodium: link (after the ?), decoded
static NSDictionary *KDLinkQuery(NSString *target)
{
    NSMutableDictionary *q = [NSMutableDictionary dictionary];
    NSRange qm = [target rangeOfString:@"?"];
    if (qm.location == NSNotFound) return q;
    for (NSString *pair in [[target substringFromIndex:qm.location + 1] componentsSeparatedByString:@"&"]) {
        NSRange eq = [pair rangeOfString:@"="];
        if (eq.location == NSNotFound) continue;
        NSString *k = [pair substringToIndex:eq.location];
        if (!q[k]) q[k] = [[pair substringFromIndex:eq.location + 1] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding] ?: @"";
    }
    return q;
}

static void KDWriteResult(NSString *name, NSString *text)
{
    [text ?: @"" writeToFile:[NSTemporaryDirectory() stringByAppendingPathComponent:name] atomically:YES encoding:NSUTF8StringEncoding error:NULL];
}

@implementation KDAppDelegate

// Developer commands over SSH, as Surfari has them: `uiopen 'kodium:<command>?key=<debug key>&...'`, only with the debug
// key on the device (Library/surfari-debug-key, see BRCommon) and only with it as the link's first key=; anything else
// is ignored without a trace. Results go to the app's tmp/ and to the log.
//   eval?js=<code>          the workbench page's answer, to tmp/eval.txt
//   snapshot / screen       the screen to tmp/screen.png (drawn from the layers / the system's own grab)
//   mem, mem?relieve=1      WebKit's memory numbers (after freeing what can be freed), to tmp/eval.txt
//   profile?secs=<s>&thread=<name>   samples a thread (default WebThread), to tmp/profile.txt
//   reload                  loads the workbench again
- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url sourceApplication:(NSString *)sourceApplication annotation:(id)annotation
{
    if (![[url.scheme lowercaseString] isEqualToString:@"kodium"]) return NO;
    NSString *s = url.absoluteString ?: @"";
    NSString *target = [s substringFromIndex:MIN(s.length, url.scheme.length + 1)];
    while ([target hasPrefix:@"/"]) target = [target substringFromIndex:1];
    NSString *expected = BRDebugKey();
    NSDictionary *q = KDLinkQuery(target);
    if (!expected || !q[@"key"] || !KDSameSecret(q[@"key"], expected)) return NO;
    NSRange qm = [target rangeOfString:@"?"];
    NSString *command = qm.location == NSNotFound ? target : [target substringToIndex:qm.location];
    KDWorkbenchViewController *workbench = (KDWorkbenchViewController *)self.window.rootViewController;

    if ([command isEqualToString:@"eval"]) {
        NSString *result = [workbench evaluateJavaScript:q[@"js"] ?: @""];
        KDWriteResult(@"eval.txt", result);
        BRLog(@"eval (%lu chars): %@", (unsigned long)result.length, result.length > 600 ? [result substringToIndex:600] : result);
        return YES;
    }
    if ([command isEqualToString:@"snapshot"] || [command isEqualToString:@"screen"]) {
        UIImage *image = nil;
        if ([command isEqualToString:@"screen"]) {
            CGImageRef (*grab)(void) = (CGImageRef (*)(void))dlsym(RTLD_DEFAULT, "UIGetScreenImage");
            CGImageRef shot = grab ? grab() : NULL;
            if (shot) { image = [UIImage imageWithCGImage:shot]; CGImageRelease(shot); }
        } else {
            CGSize size = [UIScreen mainScreen].bounds.size;
            UIGraphicsBeginImageContextWithOptions(size, YES, 1.0);
            CGContextRef ctx = UIGraphicsGetCurrentContext();
            for (UIWindow *w in [UIApplication sharedApplication].windows) {
                if (w.hidden || w.alpha <= 0) continue;
                CGContextSaveGState(ctx);
                CGContextTranslateCTM(ctx, w.frame.origin.x, w.frame.origin.y);
                [w.layer renderInContext:ctx];
                CGContextRestoreGState(ctx);
            }
            image = UIGraphicsGetImageFromCurrentImageContext();
            UIGraphicsEndImageContext();
        }
        NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:@"screen.png"];
        BOOL ok = image && [UIImagePNGRepresentation(image) writeToFile:path atomically:YES];
        BRLog(@"%@ %@: %@", command, ok ? @"written to" : @"failed for", path);
        return YES;
    }
    if ([command isEqualToString:@"mem"]) {
        if ([q[@"relieve"] isEqualToString:@"1"]) [BRMemory relieve:@"requested"];
        NSString *report = [BRMemory webKitReport];
        KDWriteResult(@"eval.txt", report);
        BRLog(@"Memory report: %@", report);
        return YES;
    }
    if ([command isEqualToString:@"profile"]) {
        NSInteger secs = q[@"secs"] ? MAX(1, MIN(120, [q[@"secs"] integerValue])) : 20;
        NSString *thread = q[@"thread"];
        if (!thread.length) thread = @"WebThread";
        BRLog(@"Profiling the %@ thread for %ld s", thread, (long)secs);
        [BRProfiler profileThreadNamed:thread seconds:secs completion:^(NSString *report) {
            KDWriteResult(@"profile.txt", report ?: @"(no profile: no such thread, or one is running)");
            BRLog(@"Profile: %@", report.length > 1500 ? [report substringToIndex:1500] : report);
        }];
        return YES;
    }
    if ([command isEqualToString:@"reload"]) {
        [workbench evaluateJavaScript:@"location.reload()"];
        return YES;
    }
    BRLog(@"Unknown command %@", command);
    return NO;
}

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
    // nothing to do in an editor (and no lists in this app). The engine's memory relief (a full garbage collection,
    // 0.4-1 s that the page stands still) comes when the app passes 290 MB instead of Surfari's 240, which the workbench
    // passes all the time: while typing it came every 20 s. (When the system itself runs short it still comes.)
    [defaults registerDefaults:@{ @"UserAgent": [BRSettings userAgentOverride] ?: [BRHTTPRequest defaultUserAgent],
                                  @"BRAdBlock": @NO, @"BRHideCookieBanners": @NO, @"BRMemoryReliefMB": @290 }];

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
