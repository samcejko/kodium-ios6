#import <Foundation/Foundation.h>
#include <pthread.h>

// A thread of this process by its name ("WebThread"), NULL when there is none.
pthread_t BRFindThreadNamed(const char *name);
// the names of all threads of the app, for the log (a thread the sampler did not find)
NSString *BRThreadNames(void);

// Logs a backtrace of the main thread whenever it stops servicing its run loop for several
// seconds (pages that freeze the engine are otherwise impossible to diagnose without a debugger).
@interface BRWatchdog : NSObject

+ (void)start;

// The browser tells the watchdog when a page load starts and ends; long loads get the WebThread
// (where UIWebView runs WebCore and JavaScript) sampled every few seconds.
+ (void)setPageLoading:(BOOL)loading;

@end
