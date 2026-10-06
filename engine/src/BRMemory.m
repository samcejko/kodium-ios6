#import "BRMemory.h"
#import "BRCommon.h"
#import "BRJSEngine.h"

#import <QuartzCore/QuartzCore.h>
#import <objc/message.h>
#include <dlfcn.h>
#include <mach/mach.h>
#include <unistd.h>

NSString * const BRMemoryGraphicsNotification = @"BRMemoryGraphicsNotification";
NSString * const BRMemoryReloadNotification = @"BRMemoryReloadNotification";
// The very last resort: below this much available for BRReloadAfter seconds while the app holds more than
// BRResidentReloadMB and relief frees nothing, the page is loaded again (at most once in BRReloadPause seconds).
// iOS closed the app at 31-40 MB available after a long YouTube session (page JS heap 95 MB, 1.6 million objects).
static const long BRAvailReloadMB = 36, BRResidentReloadMB = 250;
static const NSTimeInterval BRReloadAfter = 4, BRReloadPause = 120;
static CFAbsoluteTime g_reloadCriticalSince, g_lastReload;
// relief (see relieve:): running, when, and what the last one freed
static BOOL g_reliefRunning;
static CFAbsoluteTime g_reliefStarted, g_reliefEnded;
static long g_reliefGainMB = 100, g_reliefEndAvailable;

// Levels by what the whole system has available (free + inactive + purgeable). Measured on the iPad 2 (512 MB):
// with nothing open about 220-250 MB are available, iOS warns at 40-60 MB and kills the frontmost app at 15-25 MB
// (memory can drop 15 MB in a few seconds while a big script is lowered, so the last resort starts well above that).
// An app can set them (BRMemoryTightMB, BRMemoryCriticalMB, BRMemoryEmergencyMB in its registered defaults, read at
// +start): one whose page holds what it holds - an editor, not a page that keeps loading - gains next to nothing from
// relief, whose full garbage collection also throws away all the compiled code the page then compiles again.
static long BRAvailTightMB = 100, BRAvailCriticalMB = 70, BRAvailEmergencyMB = 55;
// how often WebKit's numbers are logged with a jump at most (counting the page's objects walks its whole heap on the
// WebThread); BRMemoryReportSeconds
static CFAbsoluteTime BRMemoryReportEvery = 10;
static volatile BOOL g_pageLoading;
static CFAbsoluteTime g_loadEnded;
static CFAbsoluteTime g_lastGraphics;
// The last resort: at the emergency level new requests wait (holdLoad:) until the critical level is left again, a
// few per sample then (all at once would bring the shortage back); after BRHoldPatience seconds they go one by one
// anyway, every BRHoldTrickle seconds, so that a page whose own memory never goes down still gets on. It used to stop
// the page load, which also ended the page's running scripts (YouTube and Google broke).
static const NSTimeInterval BRHoldPatience = 30, BRHoldTrickle = 1.5;
static const NSUInteger BRHoldReleasePerSample = 4;
static volatile BOOL g_holding;
static NSMutableArray *g_heldLoads;
static NSUInteger g_heldTotal;
static CFAbsoluteTime g_holdSince, g_lastTrickle;
// The page's graphics are too big when its layers hold this much (estimated; a normal page has 2-12 MB, one that
// runs away grows by 50 MB a second: 41 -> 268 MB in 5 s on CNN) or there are this many of them (a composited video
// or fixed box makes everything painted over it a layer too: 469 on CNN), less when the system is short, or when
// this much memory went in a few seconds without the app's resident memory growing (GPU memory is not resident).
static const long BRLayersMB = 32, BRLayersTightMB = 16, BRLayersCriticalMB = 8, BRLayersDrawnMax = 150, BRUnexplainedDropMB = 60;

static NSMutableDictionary *g_activities;
static long g_lastLoggedMB;
static long g_lastLoggedAvailable = -1;
static long g_lastLoggedLayerMB;
static long g_peakMB;
static CFAbsoluteTime g_lastRelief;
static CFAbsoluteTime g_lastReport;
static __weak CALayer *g_watchedLayer;

static const long BRMemoryLogStepMB = 24;         // a jump this big gets a log line
static const long BRMemoryLogDropMB = 40;         // and so does a drop of the system's available memory this big
static const long BRMemoryReportFromMB = 160;     // jumps above this also log WebKit's numbers
static const long BRMemoryDefaultReliefMB = 240;

// Calls into WebKit from the main thread need the web thread lock (UIKit takes it the same way; it is released at
// the end of the main run loop cycle). Taking it waits for the page's JavaScript, up to seconds on a heavy page, so
// the regular work goes to the WebThread itself with WebThreadRun instead.
static void BRWebLock(void)
{
    static void (*lockFn)(void);
    static dispatch_once_t once;
    dispatch_once(&once, ^{ lockFn = (void (*)(void))dlsym(RTLD_DEFAULT, "WebThreadLock"); });
    if (lockFn) lockFn();
}

typedef void (*BRWebThreadRunFn)(void (^block)(void));

static BRWebThreadRunFn BRWebThreadRun(void)
{
    static BRWebThreadRunFn fn;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ fn = (BRWebThreadRunFn)dlsym(RTLD_DEFAULT, "WebThreadRun"); });
    return fn;
}

static id BRCallClass(NSString *className, NSString *selectorName)
{
    Class cls = NSClassFromString(className);
    SEL sel = NSSelectorFromString(selectorName);
    if (!cls || ![cls respondsToSelector:sel]) return nil;
    return ((id (*)(id, SEL))objc_msgSend)(cls, sel);
}

static BOOL BRCallClassVoid(NSString *className, NSString *selectorName)
{
    Class cls = NSClassFromString(className);
    SEL sel = NSSelectorFromString(selectorName);
    if (!cls || ![cls respondsToSelector:sel]) return NO;
    ((void (*)(id, SEL))objc_msgSend)(cls, sel);
    return YES;
}

@implementation BRMemory

+ (void)setActivity:(NSString *)activity forKey:(NSString *)key
{
    if (!key) return;
    @synchronized (self) {
        if (!g_activities) g_activities = [NSMutableDictionary dictionary];
        if (activity.length) g_activities[key] = [activity copy];
        else [g_activities removeObjectForKey:key];
    }
}

+ (NSString *)activity
{
    @synchronized (self) {
        return g_activities.count ? [[g_activities allValues] componentsJoinedByString:@" + "] : nil;
    }
}

+ (void)resetPeak
{
    @synchronized (self) { g_peakMB = (long)BRResidentMemoryMB(); }
}

+ (long)peakMB
{
    @synchronized (self) { return MAX(g_peakMB, (long)BRResidentMemoryMB()); }
}

+ (long)reliefThresholdMB
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    return [d objectForKey:@"BRMemoryReliefMB"] ? (long)[d integerForKey:@"BRMemoryReliefMB"] : BRMemoryDefaultReliefMB;
}

+ (long)availableMB
{
    static host_t host;
    static vm_size_t page;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ host = mach_host_self(); page = 4096; host_page_size(host, &page); });
    vm_statistics_data_t vm;
    mach_msg_type_number_t count = HOST_VM_INFO_COUNT;
    if (host_statistics(host, HOST_VM_INFO, (host_info_t)&vm, &count) != KERN_SUCCESS) return 1000;
    uint64_t pages = (uint64_t)vm.free_count + vm.inactive_count + vm.purgeable_count;
    return (long)(pages * page / (1024 * 1024));
}

+ (BRMemoryLevel)levelFor:(long)available
{
    if (available < BRAvailEmergencyMB) return BRMemoryLevelEmergency;
    if (available < BRAvailCriticalMB) return BRMemoryLevelCritical;
    if (available < BRAvailTightMB) return BRMemoryLevelTight;
    return BRMemoryLevelNormal;
}

+ (BRMemoryLevel)level
{
    return [self levelFor:[self availableMB]];
}

+ (void)setPageLoading:(BOOL)loading
{
    if (!loading && g_pageLoading) g_loadEnded = CFAbsoluteTimeGetCurrent();
    g_pageLoading = loading;
}

static volatile BOOL g_compositing = YES;
+ (void)setCompositing:(BOOL)on { g_compositing = on; }
+ (BOOL)compositing { return g_compositing; }

// loading, or its scripts are still settling (lazy images, ads and players come in right after the load)
static BOOL BRPageBusy(void)
{
    return g_pageLoading || CFAbsoluteTimeGetCurrent() - g_loadEnded < 20;
}

+ (BOOL)waitForAvailableMB:(long)needMB timeout:(NSTimeInterval)timeout reason:(NSString *)reason engine:(BRJSEngine *)engine
{
    long available = [self availableMB];
    if (available >= needMB) return YES;
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    BRLog(@"Memory: %@ waits for %ld MB (%ld available)", reason, needMB, available);
    if (engine) [engine releaseContextNow];   // the calling engine's own heap (this is its thread)
    CFAbsoluteTime lastRelief = 0;
    while ([NSDate timeIntervalSinceReferenceDate] - t0 < timeout) {
        if (CFAbsoluteTimeGetCurrent() - lastRelief > 4) {
            lastRelief = CFAbsoluteTimeGetCurrent();
            [self relieve:@"waiting"];
        }
        usleep(250000);
        available = [self availableMB];
        if (available >= needMB) break;
    }
    BOOL ok = available >= needMB;
    BRLog(@"Memory: %@ %@ after %ld ms (%ld MB available)", reason, ok ? @"goes on" : @"stopped waiting",
          (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000), available);
    return ok;
}

// its own thread: every 2 s, every 0.5 s while a page loads or memory is short
+ (void)start
{
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
        if ([d objectForKey:@"BRMemoryTightMB"]) BRAvailTightMB = (long)[d integerForKey:@"BRMemoryTightMB"];
        if ([d objectForKey:@"BRMemoryCriticalMB"]) BRAvailCriticalMB = (long)[d integerForKey:@"BRMemoryCriticalMB"];
        if ([d objectForKey:@"BRMemoryEmergencyMB"]) BRAvailEmergencyMB = (long)[d integerForKey:@"BRMemoryEmergencyMB"];
        if ([d objectForKey:@"BRMemoryReportSeconds"]) BRMemoryReportEvery = [d doubleForKey:@"BRMemoryReportSeconds"];
        NSThread *t = [[NSThread alloc] initWithTarget:self selector:@selector(run) object:nil];
        t.name = @"com.samcejko.browser.memory";
        [t start];
    });
}

+ (void)run
{
    for (;;) {
        @autoreleasepool {
            BRMemoryLevel level = [self sample];
            usleep(BRPageBusy() || level >= BRMemoryLevelTight || g_holding ? 500000 : 2000000);
        }
    }
}

typedef struct { long layers, drawn, tiled; double bytes; } BRLayerTally;

static void BRTallyLayers(CALayer *layer, BRLayerTally *t, NSMutableArray *big, int depth)
{
    if (depth > 200) return;
    t->layers++;
    CGSize size = layer.bounds.size;
    BOOL tiled = [layer isKindOfClass:[CATiledLayer class]];   // (draws only the tiles in view: not counted)
    if (layer.contents || tiled) {
        CGFloat scale = layer.contentsScale > 0 ? layer.contentsScale : 1;
        double bytes = (double)size.width * size.height * scale * scale * 4;
        if (tiled) t->tiled++;
        else { t->drawn++; t->bytes += bytes; }
        if (big && bytes >= 2 * 1024 * 1024)
            [big addObject:@[@(bytes), [NSString stringWithFormat:@"%@ %.0fx%.0f%@", NSStringFromClass([layer class]), size.width, size.height, tiled ? @" tiled" : @""]]];
    }
    // (sublayers is the layer's own array on iOS 6, not a copy: WebKit changing the tree meanwhile ended the app
    // with "Collection <CALayerArray> was mutated while being enumerated"; a copy, and see layerTally)
    NSArray *subs = [layer.sublayers copy];
    for (CALayer *sub in subs) BRTallyLayers(sub, t, big, depth + 1);
}

// the layers under the watched layer with their backing store estimated from the size (4 bytes a pixel); layers -1
// when the tree changed while it was walked (no numbers this time)
+ (BRLayerTally)layerTally:(NSMutableArray *)big
{
    BRLayerTally t = { 0, 0, 0, 0 };
    CALayer *root = g_watchedLayer;
    @try {
        if (root) BRTallyLayers(root, &t, big, 0);
    } @catch (NSException *e) {
        t = (BRLayerTally){ -1, 0, 0, 0 };
    }
    return t;
}

typedef struct { CFAbsoluteTime t; long available, resident; } BRMemorySample;
static BRMemorySample g_history[16];
static unsigned g_historyCount;

// the memory thread: how much the system lost in the last few seconds beyond what the app's resident memory grew (MB)
static long BRUnexplainedDrop(CFAbsoluteTime now, long available, long mb)
{
    long worst = 0;
    for (unsigned i = 0; i < MIN(g_historyCount, 16u); i++) {
        BRMemorySample s = g_history[i];
        if (now - s.t > 6) continue;
        long gone = s.available - available - MAX(mb - s.resident, 0);
        if (gone > worst) worst = gone;
    }
    g_history[g_historyCount++ % 16] = (BRMemorySample){ now, available, mb };
    return worst;
}

+ (BRMemoryLevel)sample
{
    long mb = (long)BRResidentMemoryMB();
    if (mb <= 0) return BRMemoryLevelNormal;
    long available = [self availableMB];
    BRMemoryLevel level = [self levelFor:available];
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    // the page's graphics: estimated from its layers (CALayer reads are safe from any thread)
    long layerMB = -1, drawn = 0;
    if (g_watchedLayer) {
        @autoreleasepool { BRLayerTally t = [self layerTally:nil]; if (t.layers >= 0) { layerMB = (long)(t.bytes / 1048576); drawn = t.drawn; } }
    }
    long unexplained = BRUnexplainedDrop(now, available, mb);
    long last;
    BOOL jump, drop;
    @synchronized (self) {
        if (mb > g_peakMB) g_peakMB = mb;
        last = g_lastLoggedMB;
        // (the system can run short while the app itself hardly grows: the graphics memory of a page is not resident)
        if (available > g_lastLoggedAvailable) g_lastLoggedAvailable = available;   // a drop counts from the recent high
        drop = g_lastLoggedAvailable - available >= BRMemoryLogDropMB;
        jump = labs(mb - last) >= BRMemoryLogStepMB || drop || (layerMB >= 0 && labs(layerMB - g_lastLoggedLayerMB) >= BRMemoryLogStepMB / 2);
        if (jump) { g_lastLoggedMB = mb; g_lastLoggedAvailable = available; if (layerMB >= 0) g_lastLoggedLayerMB = layerMB; }
    }
    if (jump) {
        NSString *what = [self activity];
        NSString *graphics = layerMB >= 0 ? [NSString stringWithFormat:@", layers %ld MB (%ld drawn)", layerMB, drawn] : @"";
        if (unexplained >= 24) graphics = [graphics stringByAppendingFormat:@", %ld MB gone outside the app", unexplained];
        BRLog(@"Memory %ld MB (%@%ld), %ld MB available%@%@%@", mb, mb >= last ? @"+" : @"-", labs(mb - last), available, graphics,
              what.length ? @", busy: " : @"", what ?: @"");
        BRWebThreadRunFn run = BRWebThreadRun();
        if (run && (mb >= BRMemoryReportFromMB || drop) && CFAbsoluteTimeGetCurrent() - g_lastReport > BRMemoryReportEvery) {
            g_lastReport = CFAbsoluteTimeGetCurrent();
            run(^{ BRLog(@"Memory report: %@", [BRMemory webKitNumbers]); });
        }
    }
    // graphics: the page is drawn without composited layers (slower animations, flat 3D) before it gets the app killed
    BOOL heavy = layerMB >= BRLayersMB || drawn >= BRLayersDrawnMax ||
                 (level >= BRMemoryLevelTight && (layerMB >= BRLayersTightMB || unexplained >= BRUnexplainedDropMB)) ||
                 (level >= BRMemoryLevelCritical && layerMB >= BRLayersCriticalMB);
    if (heavy && now - g_lastGraphics > 10) {
        g_lastGraphics = now;
        BRLog(@"Memory: the page's graphics are too big (%ld MB available, %ld layers drawn, %ld MB, %ld MB gone outside the app)", available, drawn, layerMB, unexplained);
        dispatch_async(dispatch_get_main_queue(), ^{ [[NSNotificationCenter defaultCenter] postNotificationName:BRMemoryGraphicsNotification object:nil]; });
    }
    // relief: when the app itself is big, or earlier when the system is short (then more often)
    long threshold = [self reliefThresholdMB];
    BOOL big = threshold > 0 && mb >= threshold;
    if ((big && now - g_lastRelief > 20) || (level >= BRMemoryLevelCritical && now - g_lastRelief > 6)) {
        g_lastRelief = now;
        NSString *why = level >= BRMemoryLevelCritical ? [NSString stringWithFormat:@"%ld MB available", available] : [NSString stringWithFormat:@"%ld MB", mb];
        dispatch_async(dispatch_get_main_queue(), ^{ [BRMemory relieve:why]; });
    }
    // the last resort: new requests wait until memory is back (relief above frees what it can meanwhile)
    if (!g_holding && level == BRMemoryLevelEmergency) {
        @synchronized (self) { g_holding = YES; g_holdSince = now; g_lastTrickle = now; g_heldTotal = 0; }
        BRLog(@"Memory emergency: %ld MB available, %ld MB used: new requests wait until memory is back", available, mb);
        if (now - g_lastRelief > 3) {
            g_lastRelief = now;
            dispatch_async(dispatch_get_main_queue(), ^{ [BRMemory relieve:@"requests wait"]; });
        }
    }
    if (g_holding) {
        NSUInteger waiting, total;
        @synchronized (self) { waiting = g_heldLoads.count; total = g_heldTotal; }
        if (available >= BRAvailCriticalMB) {
            [self releaseHeld:BRHoldReleasePerSample];
            BOOL done = NO;
            @synchronized (self) { if (!g_heldLoads.count) { g_holding = NO; done = YES; } }
            if (done) BRLog(@"Memory back (%ld MB available): %lu requests waited, %ld s", available, (unsigned long)total, (long)(now - g_holdSince));
        } else if (waiting && now - g_holdSince > BRHoldPatience && now - g_lastTrickle >= BRHoldTrickle) {
            g_lastTrickle = now;
            [self releaseHeld:1];
        }
    }
    // the very last resort, on a page that is not loading: its own heap has filled the iPad and relief frees nothing
    BOOL useless;
    @synchronized (self) { useless = !g_reliefRunning && g_reliefGainMB < 4 && now - g_reliefEnded < 60; }
    if (available < BRAvailReloadMB && mb > BRResidentReloadMB && useless && !g_pageLoading) {
        if (!g_reloadCriticalSince) g_reloadCriticalSince = now;
        if (now - g_reloadCriticalSince >= BRReloadAfter && now - g_lastReload > BRReloadPause) {
            g_lastReload = now;
            g_reloadCriticalSince = 0;
            BRLog(@"Memory: %ld MB available, the page holds %ld MB and relief frees nothing: loaded again before iOS closes the app", available, mb);
            dispatch_async(dispatch_get_main_queue(), ^{ [[NSNotificationCenter defaultCenter] postNotificationName:BRMemoryReloadNotification object:nil]; });
        }
    } else g_reloadCriticalSince = 0;
    return level;
}

+ (BOOL)holdLoad:(dispatch_block_t)start
{
    if (!g_holding || !start) return NO;
    @synchronized (self) {
        if (!g_holding) return NO;
        if (!g_heldLoads) g_heldLoads = [NSMutableArray array];
        [g_heldLoads addObject:[start copy]];
        g_heldTotal++;
    }
    return YES;
}

// the sampler thread: the oldest held requests go on
+ (void)releaseHeld:(NSUInteger)count
{
    NSMutableArray *go = [NSMutableArray array];
    @synchronized (self) {
        while (go.count < count && g_heldLoads.count) {
            [go addObject:g_heldLoads[0]];
            [g_heldLoads removeObjectAtIndex:0];
        }
    }
    for (dispatch_block_t start in go) start();
}

// the WebThread, or a thread holding the web lock
+ (NSString *)webKitNumbers
{
    NSMutableString *s = [NSMutableString stringWithFormat:@"resident %ld MB", (long)BRResidentMemoryMB()];
    NSDictionary *m = BRCallClass(@"WebCoreStatistics", @"memoryStatistics");
    if ([m isKindOfClass:[NSDictionary class]]) {
        long heap = [m[@"JavaScriptHeapSize"] longValue] >> 20, heapFree = [m[@"JavaScriptFreeSize"] longValue] >> 20;
        long committed = [m[@"FastMallocCommittedVMBytes"] longValue] >> 20, freeList = [m[@"FastMallocFreeListBytes"] longValue] >> 20;
        long jit = [m[@"JavaScriptJITSize"] longValue] >> 20;
        [s appendFormat:@", page JS heap %ld MB (+%ld free), FastMalloc %ld MB (%ld free), JIT %ld MB", heap, heapFree, committed, freeList, jit];
    }
    Class stats = NSClassFromString(@"WebCoreStatistics");
    SEL countSel = NSSelectorFromString(@"javaScriptObjectsCount");
    if (stats && [stats respondsToSelector:countSel]) [s appendFormat:@", %lu JS objects", (unsigned long)((size_t (*)(id, SEL))objc_msgSend)(stats, countSel)];
    SEL globalsSel = NSSelectorFromString(@"javaScriptGlobalObjectsCount");
    if (stats && [stats respondsToSelector:globalsSel]) [s appendFormat:@" in %lu globals", (unsigned long)((size_t (*)(id, SEL))objc_msgSend)(stats, globalsSel)];
    // WebCache statistics: counts, sizes, live sizes, decoded sizes (one dictionary each, keyed by resource type)
    NSArray *list = BRCallClass(@"WebCache", @"statistics");
    if ([list isKindOfClass:[NSArray class]] && list.count >= 4 && [list[0] isKindOfClass:[NSDictionary class]] &&
        [list[1] isKindOfClass:[NSDictionary class]] && [list[3] isKindOfClass:[NSDictionary class]]) {
        NSDictionary *count = list[0], *size = list[1], *decoded = list[3];
        [s appendFormat:@", memory cache: %ld images %ld MB (decoded %ld MB), CSS %ld KB, scripts %ld KB",
         [count[@"Images"] longValue], [size[@"Images"] longValue] >> 20, [decoded[@"Images"] longValue] >> 20,
         [size[@"CSS"] longValue] >> 10, [size[@"JavaScript"] longValue] >> 10];
    }
    NSString *layers = [self layerNumbers];
    if (layers.length) [s appendFormat:@", %@", layers];
    NSString *what = [self activity];
    if (what.length) [s appendFormat:@", busy: %@", what];
    return s;
}

+ (void)watchLayer:(CALayer *)layer
{
    g_watchedLayer = layer;
}

+ (NSString *)layerNumbers
{
    if (!g_watchedLayer) return nil;
    NSMutableArray *big = [NSMutableArray array];
    BRLayerTally t = [self layerTally:big];
    [big sortUsingComparator:^NSComparisonResult(NSArray *a, NSArray *b) { return [b[0] compare:a[0]]; }];
    NSMutableString *s = [NSMutableString stringWithFormat:@"%ld layers (%ld drawn, %ld tiled) %.0f MB", t.layers, t.drawn, t.tiled, t.bytes / 1048576.0];
    if (big.count) {
        NSMutableArray *names = [NSMutableArray array];
        for (NSUInteger i = 0; i < big.count && i < 4; i++) [names addObject:big[i][1]];
        [s appendFormat:@" (%lu over 2 MB: %@)", (unsigned long)big.count, [names componentsJoinedByString:@", "]];
    }
    return s;
}

+ (NSString *)webKitReport
{
    BRWebLock();
    return [self webKitNumbers];
}

// "name count, name count, ..." of a counted set, the most frequent first
static NSString *BRTopCounts(id set, NSUInteger limit)
{
    if (![set isKindOfClass:[NSCountedSet class]]) return @"?";
    NSCountedSet *counts = set;
    NSArray *names = [[counts allObjects] sortedArrayUsingComparator:^NSComparisonResult(id a, id b) {
        NSUInteger ca = [counts countForObject:a], cb = [counts countForObject:b];
        return ca > cb ? NSOrderedAscending : ca < cb ? NSOrderedDescending : NSOrderedSame;
    }];
    NSMutableArray *parts = [NSMutableArray array];
    for (NSUInteger i = 0; i < names.count && i < limit; i++)
        [parts addObject:[NSString stringWithFormat:@"%@ %lu", names[i], (unsigned long)[counts countForObject:names[i]]]];
    return [parts componentsJoinedByString:@", "];
}

+ (NSString *)webKitTypesReport
{
    BRWebLock();
    Class stats = NSClassFromString(@"WebCoreStatistics");
    if (!stats) return @"";
    NSMutableString *s = [NSMutableString string];
    SEL protectedSel = NSSelectorFromString(@"javaScriptProtectedObjectsCount");
    SEL protectedGlobalsSel = NSSelectorFromString(@"javaScriptProtectedGlobalObjectsCount");
    SEL protectedTypesSel = NSSelectorFromString(@"javaScriptProtectedObjectTypeCounts");
    SEL typesSel = NSSelectorFromString(@"javaScriptObjectTypeCounts");
    if ([stats respondsToSelector:protectedSel])
        [s appendFormat:@"protected %lu", (unsigned long)((size_t (*)(id, SEL))objc_msgSend)(stats, protectedSel)];
    if ([stats respondsToSelector:protectedGlobalsSel])
        [s appendFormat:@" (%lu globals)", (unsigned long)((size_t (*)(id, SEL))objc_msgSend)(stats, protectedGlobalsSel)];
    if ([stats respondsToSelector:protectedTypesSel])
        [s appendFormat:@": %@", BRTopCounts(((id (*)(id, SEL))objc_msgSend)(stats, protectedTypesSel), 12)];
    if ([stats respondsToSelector:typesSel])
        [s appendFormat:@"\ntypes: %@", BRTopCounts(((id (*)(id, SEL))objc_msgSend)(stats, typesSel), 40)];
    return s;
}

// A relief that freed next to nothing is not repeated for a while (unless the system lost 10 MB more meanwhile):
// its garbage collection holds the page for 0.5-1 s, and on a page whose own heap fills the iPad (YouTube after a
// while: 95 MB, 1.6 million objects) it ran every 1-2 s, the page stalled and was killed all the same.
+ (void)relieve:(NSString *)reason
{
    long before = (long)BRResidentMemoryMB(), availableBefore = [self availableMB];
    CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
    BOOL forced = [reason isEqualToString:@"requested"];
    @synchronized (self) {
        if (g_reliefRunning && !forced && now - g_reliefStarted < 20) return;
        NSTimeInterval pause = g_reliefGainMB < 4 ? 30 : 2;
        if (!forced && now - g_reliefEnded < pause && availableBefore > g_reliefEndAvailable - 10) return;
        g_reliefRunning = YES;
        g_reliefStarted = now;
    }
    // our script engines: whole heaps, recreated on the next use (0.3 to 0.5 s each)
    [[BRJSEngine transpiler] resetContext];
    [[BRJSEngine transpiler2] resetContext];
    [[BRJSEngine shared] resetContext];
    // the pages' garbage, the resources no page uses and the decoded copies of images (redecoded when painted; the
    // iOS variant keeps the application caches that +empty would delete), then WebKit's free lists back to the system
    void (^webkit)(void) = ^{
        NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
        BRCallClassVoid(@"WebCoreStatistics", @"garbageCollectJavaScriptObjects");
        BRCallClassVoid(@"WebCache", @"emptyInMemoryResources");
        BRCallClassVoid(@"WebCoreStatistics", @"returnFreeMemoryToSystem");
        long after = (long)BRResidentMemoryMB(), availableAfter = [BRMemory availableMB];
        @synchronized ([BRMemory class]) {
            g_reliefRunning = NO;
            g_reliefEnded = CFAbsoluteTimeGetCurrent();
            g_reliefGainMB = MAX(before - after, availableAfter - availableBefore);
            g_reliefEndAvailable = availableAfter;
        }
        BRLog(@"Memory relief (%@): %ld -> %ld MB, %ld MB available, WebKit part %ld ms; %@", reason, before, after,
              availableAfter, (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000), [BRMemory webKitNumbers]);
    };
    BRWebThreadRunFn run = BRWebThreadRun();
    if (run) run(webkit);
    else if ([NSThread isMainThread]) { BRWebLock(); webkit(); }
    else dispatch_async(dispatch_get_main_queue(), ^{ BRWebLock(); webkit(); });
}

@end
