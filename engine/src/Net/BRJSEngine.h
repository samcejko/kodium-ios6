#import <Foundation/Foundation.h>

// Posted on the engine thread after the context was thrown away (memory pressure); libraries must reload.
extern NSString * const BRJSEngineDidResetNotification;

// A JavaScriptCore context on a dedicated thread with a large stack (Babel recurses deeply), reached
// through the C API which is looked up with dlsym (JavaScriptCore is a private framework on iOS 6 but
// already loaded by UIKit/WebKit). Used for the CSS rewriter and the JavaScript transpiler.
@interface BRJSEngine : NSObject

+ (instancetype)shared;
// A second engine (own thread and context) for lowering scripts, so that stylesheets and documents are not held up
// behind a large script (the iPad 2 has two cores).
+ (instancetype)transpiler;
// A third one, for scripts that would otherwise wait behind the transpiler's work (see BRCSSRewriter scriptEngineFor:)
+ (instancetype)transpiler2;

@property (nonatomic, readonly) BOOL available;
// (the rewriter's: its last lowering on this engine was given up for lack of memory; engine thread)
@property (atomic) BOOL lastNoRoom;
// blocks queued or running (any thread)
@property (atomic, readonly) NSInteger pending;

// Runs `block` on the engine thread (serially).
- (void)performSync:(dispatch_block_t)block;
- (void)performAsync:(dispatch_block_t)block;

// The following must be called on the engine thread (inside performSync/performAsync).
- (BOOL)evaluateScript:(NSString *)script sourceName:(NSString *)name;
// Calls a global function or dotted path (e.g. "CSSFix.run") with string arguments; returns the result as a string.
- (NSString *)callFunction:(NSString *)function arguments:(NSArray *)arguments;
- (void)collectGarbage;

// Throws the whole context and its heap away; it is recreated on the next use (any thread).
- (void)resetContext;
// The same at once (engine thread).
- (void)releaseContextNow;
// Gives JavaScriptCore's free malloc pages back to the system (any thread; releasing a context does it too).
+ (void)returnFreeMemory;
// Main thread, at launch before any script runs: which of the engine's compilers pages and engines use (BRJSCMode),
// and how soon the baseline JIT takes a function (BRJSCWarmUp).
+ (void)applyEngineTiers;
// Main thread: keeps the compiled code of the pages' scripts while memory allows, if BRJSCKeepCode is set (JavaScriptCore
// throws it away a minute after it last did, and the next action compiles everything again; see BRJSEngine.m).
+ (void)keepPageCode;
// Any thread: the pages' garbage collected now (on the WebThread, between scripts) when at least `bytes` were allocated
// since the last collection - so that the collection JavaScriptCore would run anyway (its timer: some seconds after a
// few megabytes, 11 s after 5 MB; or at once when the allocations reach the heap's size) comes while the user pauses,
// not in the middle of their next action (0.3-0.6 s). Needs keepPageCode (which finds the heap).
+ (void)collectPageGarbageIfAllocated:(size_t)bytes;
// "X of Y MB allocated since the last collection (Z ms)", or nil (the WebThread or a thread holding the web lock)
+ (NSString *)pageHeapReport;
// The WebThread, between scripts: the pages' compiled code thrown away now (memory relief; JavaScriptCore compiles
// again what runs next). NO when keepPageCode found no heap.
+ (BOOL)discardPageCode;
// Engine thread: the same once the engine has not been used for `seconds` and the process is above `minimumMB`
// resident (0 = always). Heavy work leaves the heap large, which the other engines and the pages then lack.
- (void)releaseWhenIdleFor:(NSTimeInterval)seconds aboveMB:(long)minimumMB;

@end
