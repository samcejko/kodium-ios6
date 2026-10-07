#import "KDAppDelegate.h"
#import "KDWorkbenchViewController.h"
#import "KDSiteProtocol.h"
#import "KDRedirectProtocol.h"
#import "KDFiles.h"
#import "BRURLProtocol.h"
#import "BRHTTPRequest.h"
#import "BRSettings.h"
#import "BRTLSSocket.h"
#import "BRCSSRewriter.h"
#import "BRJSEngine.h"
#import "BRMemory.h"
#import "BRProfiler.h"
#import "BRCommon.h"
#import <objc/message.h>
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
//   mem, mem?relieve=1      WebKit's memory numbers (after freeing what can be freed), to tmp/eval.txt; types=1 adds
//                           the page's objects by kind (walks the whole heap); discard=1 throws the compiled code away
//                           (what keeping it costs: the log)
//   profile?secs=<s>&thread=<name>   samples a thread (default WebThread), to tmp/profile.txt
//   reload                  loads the workbench again
//   receive?file=<path>     takes a file of the app's home as another app's file ("Open in Kodium")
//   keyboard                the on-screen keyboard over the editor, as after a tap into it
//   jsprofile               WebKit's JavaScript profiler on (console.profile/profileEnd -> console.profiles), to tmp/eval.txt
- (BOOL)application:(UIApplication *)application openURL:(NSURL *)url sourceApplication:(NSString *)sourceApplication annotation:(id)annotation
{
    // "Open in Kodium" from another app (Mail, Safari, Dropbox...): the file comes into Documents and opens
    if (url.isFileURL) {
        NSString *path = [self takeReceivedFile:url];
        if (path) [(KDWorkbenchViewController *)self.window.rootViewController openReceivedFile:path];
        return path != nil;
    }
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
        if ([q[@"discard"] isEqualToString:@"1"]) [self discardCompiledCode];
        NSString *report = [q[@"types"] isEqualToString:@"1"] ? [[BRMemory webKitReport] stringByAppendingFormat:@"\n%@", [BRMemory webKitTypesReport]]
                                                               : [BRMemory webKitReport];
        NSString *budget = [BRJSEngine pageHeapReport];
        if (budget) report = [report stringByAppendingFormat:@", %@", budget];
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
    if ([command isEqualToString:@"keyboard"]) {
        [workbench showKeyboard];
        return YES;
    }
    if ([command isEqualToString:@"jsprofile"]) {
        KDWriteResult(@"eval.txt", [workbench enableJavaScriptProfiling] ? @"profiling on" : @"no profiling switch");
        return YES;
    }
    if ([command isEqualToString:@"receive"]) {
        NSString *file = q[@"file"];
        if (![file hasPrefix:[NSHomeDirectory() stringByAppendingString:@"/"]]) return NO;
        NSString *path = [self takeReceivedFile:[NSURL fileURLWithPath:file]];
        if (path) [workbench openReceivedFile:path];
        return YES;
    }
    BRLog(@"Unknown command %@", command);
    return NO;
}

// A file another app gave: iOS puts it into Documents/Inbox, where the app may read and delete but not write. It goes
// to Documents itself, the workspace, under a name of its own ("name 2.ext" when the name is taken); the path in
// Documents ("/name.ext"), nil when it could not be taken.
- (NSString *)takeReceivedFile:(NSURL *)url
{
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *source = url.path;
    if (!source.length || ![fm fileExistsAtPath:source]) return nil;
    NSString *documents = [KDFiles rootDirectory];
    NSString *name = [source lastPathComponent];
    NSString *stem = [name stringByDeletingPathExtension], *extension = [name pathExtension];
    NSString *target = [documents stringByAppendingPathComponent:name];
    for (NSInteger n = 2; [fm fileExistsAtPath:target] && n < 1000; n++) {
        NSString *other = [NSString stringWithFormat:@"%@ %ld", stem, (long)n];
        target = [documents stringByAppendingPathComponent:extension.length ? [other stringByAppendingPathExtension:extension] : other];
    }
    NSError *error = nil;
    if (![fm moveItemAtPath:source toPath:target error:&error] && ![fm copyItemAtPath:source toPath:target error:&error]) {
        BRLog(@"Receiving %@ failed: %@", name, error.localizedDescription);
        return nil;
    }
    // (iOS made the Inbox for these: it goes once empty, not to show in the explorer)
    NSString *inbox = [documents stringByAppendingPathComponent:@"Inbox"];
    if ([[fm contentsOfDirectoryAtPath:inbox error:NULL] count] == 0) [fm removeItemAtPath:inbox error:NULL];
    BRLog(@"Received %@ from another app", [target lastPathComponent]);
    return [@"/" stringByAppendingString:[target lastPathComponent]];
}

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
    // Surfari's engine, started the way Surfari starts it (engine/src): its settings before any request, the script
    // engine's tiers before any script is compiled
    [BRSettings prepareAtLaunch];
    NSDictionary *info = [[NSBundle mainBundle] infoDictionary];
    BRLog(@"Kodium %@ (%@) starting on %@ (iOS %@)", info[@"CFBundleShortVersionString"] ?: @"?", info[@"CFBundleVersion"] ?: @"?",
          [UIDevice currentDevice].model, [UIDevice currentDevice].systemVersion);
    // (the engine's own JIT thresholds: compiling sooner - BRJSCWarmUp 30 - made typing slower on the iPad 2)
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
    // The engine's memory relief is a full garbage collection (0.3-0.5 s that the page stands still) which also throws
    // away all the compiled code - the workbench then compiles again whatever it runs next (a tenth of the time of
    // switching tabs went into that) - and the workbench holds what it holds: relief freed next to nothing, and with
    // the iPad's 50-70 MB left it came every few seconds. It comes only when the system is about to close the app
    // (iOS warns at 40-60 MB available and closes it at 15-25), not for the app's own size; requests to the network
    // wait at 30 MB. WebKit's numbers in the log (they count every object of the page) every two minutes at most.
    [defaults registerDefaults:@{ @"UserAgent": [BRSettings userAgentOverride] ?: [BRHTTPRequest defaultUserAgent],
                                  @"BRAdBlock": @NO, @"BRHideCookieBanners": @NO, @"BRMemoryReliefMB": @0,
                                  @"BRMemoryTightMB": @60, @"BRMemoryCriticalMB": @40, @"BRMemoryEmergencyMB": @30,
                                  @"BRMemoryReportSeconds": @120, @"BRJSCKeepCode": @YES }];

    // Every http/https load goes through the engine's TLS stack and rewriters; the app's own site
    // (https://kodium.invalid/) through KDSiteProtocol, registered last so that it is asked first.
    [BRURLProtocol registerProtocol];
    [KDSiteProtocol registerProtocol];
    // (Open VSX's assets, which redirect: see KDRedirectProtocol)
    [KDRedirectProtocol registerProtocol];
    [BRMemory start];
    // Light relief: every 20 s while the app holds more than 200 MB, the memory WebKit's allocator keeps free (27 MB of
    // it once the workbench had worked a while) goes back to the system - no garbage collection, which the engine's
    // relief does (it throws away the compiled code with it), so the iPad keeps room before the engine or iOS act
    [NSTimer scheduledTimerWithTimeInterval:20 target:self selector:@selector(returnFreeMemory) userInfo:nil repeats:YES];
    // The workbench's compiled code stays while memory allows: JavaScriptCore throws all of it away a minute after it
    // last did, and the first action after a pause compiled again whatever it ran (a switch of editors 1.8 s instead
    // of 1.3). Surfari's engine keeps it (BRJSCKeepCode) and throws it away itself when memory gets critical (40 MB).
    [BRJSEngine keepPageCode];
    // The workbench's garbage is collected in the user's pauses (web/prelude/vsc-prelude.js asks, KDSiteProtocol
    // /__kd/app/idle), and JavaScriptCore's own timer, which collected in the middle of every second switch of editors
    // (0.3-0.6 s), is kept quiet
    [BRJSEngine collectPageGarbageInPauses];
    [BRTLSSocket warmUp];
    [BRCSSRewriter warmUp];

    self.window = [[UIWindow alloc] initWithFrame:[[UIScreen mainScreen] bounds]];
    self.window.rootViewController = [[KDWorkbenchViewController alloc] init];
    self.window.backgroundColor = [UIColor blackColor];
    [self.window makeKeyAndVisible];
    [application setStatusBarStyle:UIStatusBarStyleBlackOpaque animated:NO];
    return YES;
}

- (void)returnFreeMemory
{
    if (BRResidentMemoryMB() < 200) return;
    static void (*run)(void (^)(void));
    if (!run) run = (void (*)(void (^)(void)))dlsym(RTLD_DEFAULT, "WebThreadRun");
    Class stats = NSClassFromString(@"WebCoreStatistics");
    SEL giveBack = NSSelectorFromString(@"returnFreeMemoryToSystem");
    if (!run || ![stats respondsToSelector:giveBack]) return;
    run(^{ ((void (*)(id, SEL))objc_msgSend)(stats, giveBack); });
}

// (diagnosis: what keeping the compiled code costs - kodium:mem?discard=1 throws it away, and WebKit's free memory back
// to the system; the log says the resident memory before and after)
- (void)discardCompiledCode
{
    void (*run)(void (^)(void)) = (void (*)(void (^)(void)))dlsym(RTLD_DEFAULT, "WebThreadRun");
    if (!run) return;
    long before = (long)BRResidentMemoryMB();
    run(^{
        BOOL done = [BRJSEngine discardPageCode];
        Class stats = NSClassFromString(@"WebCoreStatistics");
        SEL giveBack = NSSelectorFromString(@"returnFreeMemoryToSystem");
        if ([stats respondsToSelector:giveBack]) ((void (*)(id, SEL))objc_msgSend)(stats, giveBack);
        BRLog(@"Compiled code %@: %ld -> %ld MB", done ? @"thrown away" : @"not found", before, (long)BRResidentMemoryMB());
    });
}

- (void)applicationDidReceiveMemoryWarning:(UIApplication *)application
{
    BRLog(@"Memory warning at %.0f MB, %ld MB available", BRResidentMemoryMB(), (long)[BRMemory availableMB]);
    [BRMemory relieve:@"memory warning"];   // the engine's script engines (made again on the next use), caches
}

@end
