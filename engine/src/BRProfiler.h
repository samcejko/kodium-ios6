#import <Foundation/Foundation.h>

// Where a thread's time goes: the thread is stopped for a moment every few milliseconds and its stack walked, and the
// samples are summed up by kind of work (JavaScript, style, layout, painting, garbage collection...) and by function.
// For pages that keep the engine busy far longer than a desktop browser does (seznam.cz: 43 s in one DOMContentLoaded
// listener that takes 0.4 s on a desktop).
@interface BRProfiler : NSObject

// Samples the thread named `name` ("WebThread": WebCore and JavaScript) for `seconds` on a thread of its own;
// `completion` gets the report on the main queue (nil when the thread was not found or a profile is running).
+ (void)profileThreadNamed:(NSString *)name seconds:(NSTimeInterval)seconds completion:(void (^)(NSString *report))completion;

// Names for addresses ("0x39c63180,0x39c63096 ..." in any separators) as the profiler finds them: one line per
// address, "address  library  function". For crash reports of the same boot (WebCore crashes name no functions).
+ (NSString *)symbolicate:(NSString *)list;

@end
