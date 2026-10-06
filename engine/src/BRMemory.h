#import <Foundation/Foundation.h>

@class BRJSEngine, CALayer;

// How much memory the whole iPad has left (iOS kills the frontmost app when the system runs short, whatever the app
// itself uses: other processes and the graphics memory of big pages count too).
typedef NS_ENUM(NSInteger, BRMemoryLevel) {
    BRMemoryLevelNormal = 0,
    BRMemoryLevelTight,        // heavy work waits for relief first
    BRMemoryLevelCritical,     // everything that can be freed is freed
    BRMemoryLevelEmergency,    // new requests wait too (holdLoad:): the page loads slower, nothing is stopped
};
// posted on the main thread when the page itself has filled the iPad (relief frees nothing, iOS is about to close
// the app): the page should be loaded again from scratch, which drops its heap (better than the app being closed)
extern NSString * const BRMemoryReloadNotification;
// posted on the main thread when the page's graphics (composited layers) eat the memory: the page should be drawn
// without accelerated compositing
extern NSString * const BRMemoryGraphicsNotification;

// Memory diagnostics and early relief. The 512 MB iPad 2 kills the app at about 330 MB resident, and iOS warns
// only a few megabytes before that, so heavy pages die before the warning handler can free anything.
@interface BRMemory : NSObject

// What a background engine is busy with, reported next to memory jumps (any thread; nil when done). One slot per
// key, since the rewriter and the transpiler work at the same time.
+ (void)setActivity:(NSString *)activity forKey:(NSString *)key;
+ (NSString *)activity;

// Starts the sampler thread (every 2 s, every 0.5 s while a page loads or memory is short): logs jumps, tracks the
// peak of the current page, asks the main thread for relief when the process crosses BRMemoryReliefMB (0 = off) or
// the system runs short, and as the last resort holds new requests (holdLoad:) until memory is back. The levels by
// what the system has available can be set in the app's defaults before: BRMemoryTightMB (100), BRMemoryCriticalMB
// (70: relief), BRMemoryEmergencyMB (55: requests wait), and how often WebKit's numbers are logged, BRMemoryReportSeconds.
+ (void)start;
// A page's new request while the iPad is nearly out of memory: `start` runs later (on the sampler thread), when
// memory is back, or one after another after a while even if it is not. The page loads slower instead of being
// stopped (which also ended its running scripts) or the app being closed by iOS. NO when nothing needs to wait
// (`start` is not kept). Any thread.
+ (BOOL)holdLoad:(dispatch_block_t)start;
+ (void)resetPeak;
+ (long)peakMB;

// Main thread: WebKit's own numbers (JavaScript heap of the pages, FastMalloc, memory cache).
+ (NSString *)webKitReport;

// Main thread: the pages' objects by kind, the most frequent first, and the protected ones (walks the whole heap:
// for diagnosis only, surfari:mem?key=<debug key>&types=1).
+ (NSString *)webKitTypesReport;

// Frees what can be freed without losing the page (both script engines, page garbage, WebKit's memory cache and free
// lists) and logs what it gained. Any thread: the work happens on the engines' threads and the WebThread.
+ (void)relieve:(NSString *)reason;

// Free + inactive + purgeable memory of the whole system (any thread), and the level it means.
+ (long)availableMB;
+ (BRMemoryLevel)level;
// Background threads: heavy work asks for room first. Returns at once when `needMB` are available; otherwise frees
// what it can (the calling engine's heap at once, the rest through relief) and waits up to `timeout` seconds for the
// system to catch up (the page loads slower instead of the app being killed). YES when the room is there.
+ (BOOL)waitForAvailableMB:(long)needMB timeout:(NSTimeInterval)timeout reason:(NSString *)reason engine:(BRJSEngine *)engine;
// The watchdog tells whether a page is loading (memory is sampled more often then).
+ (void)setPageLoading:(BOOL)loading;
// Whether the page is drawn with accelerated compositing (the browser switches it off for heavy pages); any thread.
+ (void)setCompositing:(BOOL)on;
+ (BOOL)compositing;

// The web view's layer: the graphics memory of the page (document tiles and composited layers, drawn by the GPU
// outside the app's resident memory) is estimated from the layers under it. Main thread.
+ (void)watchLayer:(CALayer *)layer;
// "N layers (M drawn), X MB" plus the biggest ones; the WebThread or a thread holding the web lock.
+ (NSString *)layerNumbers;

@end
