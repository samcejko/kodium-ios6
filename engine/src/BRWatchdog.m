#import "BRWatchdog.h"
#import "BRCommon.h"
#import "BRMemory.h"

#include <execinfo.h>
#include <pthread.h>
#include <signal.h>
#include <dlfcn.h>
#include <string.h>
#include <mach/mach.h>

static const NSTimeInterval BRWatchdogInterval = 2.0;     // how often the main thread is pinged
static const NSTimeInterval BRWatchdogPatience = 6.0;     // silence before a backtrace is taken
static const NSTimeInterval BRWatchdogSlowLoad = 12.0;    // a page load longer than this gets WebThread samples
static const NSTimeInterval BRWatchdogSampleEvery = 10.0;
static const int BRWatchdogMaxFrames = 48;

static pthread_t g_mainThread;
static void *g_frames[BRWatchdogMaxFrames];
static volatile int g_frameCount = -1;                    // -1: no capture pending, >= 0: captured
static volatile CFAbsoluteTime g_loadingSince = 0;        // 0 when no page is loading

static void BRWatchdogSignalHandler(int sig)
{
    // runs on the signalled thread (async-signal-unsafe calls are avoided here; formatting happens elsewhere)
    g_frameCount = backtrace(g_frames, BRWatchdogMaxFrames);
}

pthread_t BRFindThreadNamed(const char *name)
{
    thread_act_array_t threads = NULL;
    mach_msg_type_number_t count = 0;
    if (task_threads(mach_task_self(), &threads, &count) != KERN_SUCCESS) return NULL;
    pthread_t found = NULL;
    for (mach_msg_type_number_t i = 0; i < count; i++) {
        pthread_t p = pthread_from_mach_thread_np(threads[i]);
        if (p && !found) {
            char buf[64] = { 0 };
            if (pthread_getname_np(p, buf, sizeof(buf)) == 0 && strcmp(buf, name) == 0) found = p;
        }
        mach_port_deallocate(mach_task_self(), threads[i]);
    }
    vm_deallocate(mach_task_self(), (vm_address_t)threads, count * sizeof(thread_t));
    return found;
}

NSString *BRThreadNames(void)
{
    thread_act_array_t threads = NULL;
    mach_msg_type_number_t count = 0;
    if (task_threads(mach_task_self(), &threads, &count) != KERN_SUCCESS) return @"(no threads)";
    NSMutableArray *names = [NSMutableArray array];
    for (mach_msg_type_number_t i = 0; i < count; i++) {
        pthread_t p = pthread_from_mach_thread_np(threads[i]);
        char buf[64] = { 0 };
        if (!p) [names addObject:@"(no pthread)"];
        else if (pthread_getname_np(p, buf, sizeof(buf)) != 0) [names addObject:@"(no name)"];
        else [names addObject:[NSString stringWithFormat:@"'%s'", buf]];
        mach_port_deallocate(mach_task_self(), threads[i]);
    }
    vm_deallocate(mach_task_self(), (vm_address_t)threads, count * sizeof(thread_t));
    return [names componentsJoinedByString:@", "];
}

@implementation BRWatchdog

+ (void)setPageLoading:(BOOL)loading
{
    if (loading && !g_loadingSince) [BRMemory resetPeak];
    [BRMemory setPageLoading:loading];
    g_loadingSince = loading ? (g_loadingSince ?: CFAbsoluteTimeGetCurrent()) : 0;
}

// Sends the capture signal to `thread` and returns the formatted frames (nil when nothing came back).
+ (NSString *)sampleThread:(pthread_t)thread
{
    if (!thread) return nil;
    g_frameCount = -1;
    if (pthread_kill(thread, SIGUSR2) != 0) return nil;
    for (int i = 0; i < 50 && g_frameCount < 0; i++) [NSThread sleepForTimeInterval:0.02];
    if (g_frameCount < 0) return nil;
    void *frames[BRWatchdogMaxFrames];
    int count = g_frameCount;
    memcpy(frames, g_frames, sizeof(void *) * (size_t)count);
    return [self formatFrames:frames count:count];
}

+ (void)start
{
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_mainThread = pthread_self();
        struct sigaction sa;
        memset(&sa, 0, sizeof(sa));
        sa.sa_handler = BRWatchdogSignalHandler;
        sigemptyset(&sa.sa_mask);
        sigaction(SIGUSR2, &sa, NULL);
        NSThread *t = [[NSThread alloc] initWithTarget:self selector:@selector(run) object:nil];
        t.name = @"com.samcejko.browser.watchdog";
        [t start];
    });
}

+ (NSString *)formatFrames:(void **)frames count:(int)count
{
    NSMutableString *s = [NSMutableString string];
    for (int i = 0; i < count; i++) {
        Dl_info info;
        const char *image = "?";
        const char *symbol = NULL;
        unsigned long offset = 0;
        if (dladdr(frames[i], &info) && info.dli_fname) {
            const char *slash = strrchr(info.dli_fname, '/');
            image = slash ? slash + 1 : info.dli_fname;
            if (info.dli_sname) {
                symbol = info.dli_sname;
                offset = (unsigned long)((char *)frames[i] - (char *)info.dli_saddr);
            }
        }
        if (symbol) [s appendFormat:@"\n  %2d %-22s %s + %lu", i, image, symbol, offset];
        else [s appendFormat:@"\n  %2d %-22s %p", i, image, frames[i]];
    }
    return s;
}

+ (void)run
{
    @autoreleasepool {
        __block CFAbsoluteTime lastPong = CFAbsoluteTimeGetCurrent();
        BOOL reported = NO;
        CFAbsoluteTime lastWebSample = 0;
        int webSamples = 0;
        for (;;) {
            [NSThread sleepForTimeInterval:BRWatchdogInterval];
            dispatch_async(dispatch_get_main_queue(), ^{ lastPong = CFAbsoluteTimeGetCurrent(); });
            // slow page loads: what is the WebThread doing?
            CFAbsoluteTime loadingSince = g_loadingSince;
            if (!loadingSince) {
                webSamples = 0;
            } else if (CFAbsoluteTimeGetCurrent() - loadingSince > BRWatchdogSlowLoad && CFAbsoluteTimeGetCurrent() - lastWebSample > BRWatchdogSampleEvery && webSamples < 8) {
                lastWebSample = CFAbsoluteTimeGetCurrent();
                webSamples++;
                NSString *frames = [self sampleThread:BRFindThreadNamed("WebThread")];
                BRLog(@"Page loading for %ld s, WebThread sample %d:%@", (long)(lastWebSample - loadingSince), webSamples, frames ?: @" (no backtrace)");
            }
            CFAbsoluteTime silence = CFAbsoluteTimeGetCurrent() - lastPong;
            if (silence < BRWatchdogPatience) {
                reported = NO;
                continue;
            }
            if (reported) continue;   // one report per stall (plus a second one 30 s later)
            reported = YES;
            g_frameCount = -1;
            pthread_kill(g_mainThread, SIGUSR2);
            for (int i = 0; i < 50 && g_frameCount < 0; i++) [NSThread sleepForTimeInterval:0.02];
            if (g_frameCount < 0) {
                BRLog(@"Main thread silent for %ld s (no backtrace)", (long)silence);
                continue;
            }
            void *frames[BRWatchdogMaxFrames];
            int count = g_frameCount;
            memcpy(frames, g_frames, sizeof(void *) * (size_t)count);
            BRLog(@"Main thread silent for %ld s, backtrace:%@", (long)silence, [self formatFrames:frames count:count]);
            // a second sample tells whether it is stuck in one place or grinding through work
            [NSThread sleepForTimeInterval:3.0];
            g_frameCount = -1;
            pthread_kill(g_mainThread, SIGUSR2);
            for (int i = 0; i < 50 && g_frameCount < 0; i++) [NSThread sleepForTimeInterval:0.02];
            if (g_frameCount >= 0) {
                count = g_frameCount;
                memcpy(frames, g_frames, sizeof(void *) * (size_t)count);
                BRLog(@"Second sample:%@", [self formatFrames:frames count:count]);
            }
        }
    }
}

@end
