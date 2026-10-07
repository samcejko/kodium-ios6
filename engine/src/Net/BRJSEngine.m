#import "BRJSEngine.h"
#import "BRCommon.h"
#import "BRMemory.h"

#include <dlfcn.h>
#include <libkern/OSAtomic.h>
#include <malloc/malloc.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <pthread.h>
#include <fcntl.h>
#include <stddef.h>
#include <sys/mman.h>
#include <unistd.h>

// JavaScriptCore C API, resolved at runtime (no link-time dependency on the framework path).
typedef void *JSCtx;
typedef void *JSStr;
typedef const void *JSVal;
typedef void *JSObj;

static JSCtx (*p_JSGlobalContextCreate)(void *cls);
// (optional) a context group per engine: without one this JavaScriptCore may give every context of an app that does
// not link it the same shared VM, which two threads must not use at once
static void *(*p_JSContextGroupCreate)(void);
static void (*p_JSContextGroupRelease)(void *group);
static JSCtx (*p_JSGlobalContextCreateInGroup)(void *group, void *cls);
static void (*p_JSGlobalContextRelease)(JSCtx ctx);
static JSVal (*p_JSEvaluateScript)(JSCtx ctx, JSStr script, JSObj thisObject, JSStr sourceURL, int startingLineNumber, JSVal *exception);
static JSStr (*p_JSStringCreateWithCFString)(CFStringRef string);
static CFStringRef (*p_JSStringCopyCFString)(CFAllocatorRef alloc, JSStr string);
static void (*p_JSStringRelease)(JSStr string);
static JSStr (*p_JSValueToStringCopy)(JSCtx ctx, JSVal value, JSVal *exception);
static bool (*p_JSValueIsString)(JSCtx ctx, JSVal value);
static bool (*p_JSValueIsUndefined)(JSCtx ctx, JSVal value);
static bool (*p_JSValueIsNull)(JSCtx ctx, JSVal value);
static JSVal (*p_JSValueMakeString)(JSCtx ctx, JSStr string);
static JSVal (*p_JSValueMakeUndefined)(JSCtx ctx);
static JSObj (*p_JSContextGetGlobalObject)(JSCtx ctx);
static void (*p_JSObjectSetProperty)(JSCtx ctx, JSObj object, JSStr propertyName, JSVal value, unsigned attributes, JSVal *exception);
static JSVal (*p_JSObjectGetProperty)(JSCtx ctx, JSObj object, JSStr propertyName, JSVal *exception);
static JSObj (*p_JSValueToObject)(JSCtx ctx, JSVal value, JSVal *exception);
static void (*p_JSGarbageCollect)(JSCtx ctx);
// (optional) native functions for scripts: __brAvailableMB() lets the transpiler give up before iOS runs out of memory
typedef JSVal (*BRJSNativeFn)(JSCtx ctx, JSObj function, JSObj thisObject, size_t argc, const JSVal argv[], JSVal *exception);
static JSObj (*p_JSObjectMakeFunctionWithCallback)(JSCtx ctx, JSStr name, BRJSNativeFn callback);
static JSVal (*p_JSValueMakeNumber)(JSCtx ctx, double number);
// WTF::releaseFastMallocFreeMemory(): JavaScriptCore's malloc (shared with WebCore) keeps freed pages for reuse; a
// big transpile leaves ~45 MB of them resident after its heap is gone
static void (*p_releaseFastMallocFreeMemory)(void);

static void *BRLookup(void *handle, const char *name)
{
    void *sym = dlsym(RTLD_DEFAULT, name);
    if (!sym && handle) sym = dlsym(handle, name);
    return sym;
}

static BOOL BRResolveJSC(void)
{
    static BOOL resolved = NO;
    static BOOL tried = NO;
    if (tried) return resolved;
    tried = YES;
    void *handle = NULL;
    if (!dlsym(RTLD_DEFAULT, "JSEvaluateScript")) {
        const char *paths[] = {
            "/System/Library/PrivateFrameworks/JavaScriptCore.framework/JavaScriptCore",
            "/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore",
        };
        for (int i = 0; i < 2 && !handle; i++) handle = dlopen(paths[i], RTLD_NOW);
        if (!handle) {
            BRLog(@"JavaScriptCore not found: %s", dlerror() ?: "?");
            return NO;
        }
    }
#define RESOLVE(name) do { p_##name = BRLookup(handle, #name); if (!p_##name) { BRLog(@"JavaScriptCore symbol missing: %s", #name); return NO; } } while (0)
    RESOLVE(JSGlobalContextCreate);
    RESOLVE(JSGlobalContextRelease);
    RESOLVE(JSEvaluateScript);
    RESOLVE(JSStringCreateWithCFString);
    RESOLVE(JSStringCopyCFString);
    RESOLVE(JSStringRelease);
    RESOLVE(JSValueToStringCopy);
    RESOLVE(JSValueIsString);
    RESOLVE(JSValueIsUndefined);
    RESOLVE(JSValueIsNull);
    RESOLVE(JSValueMakeString);
    RESOLVE(JSValueMakeUndefined);
    RESOLVE(JSContextGetGlobalObject);
    RESOLVE(JSObjectSetProperty);
    RESOLVE(JSObjectGetProperty);
    RESOLVE(JSValueToObject);
    RESOLVE(JSGarbageCollect);
#undef RESOLVE
    p_JSContextGroupCreate = BRLookup(handle, "JSContextGroupCreate");
    p_JSContextGroupRelease = BRLookup(handle, "JSContextGroupRelease");
    p_JSObjectMakeFunctionWithCallback = BRLookup(handle, "JSObjectMakeFunctionWithCallback");
    p_JSValueMakeNumber = BRLookup(handle, "JSValueMakeNumber");
    p_releaseFastMallocFreeMemory = BRLookup(handle, "_ZN3WTF27releaseFastMallocFreeMemoryEv");
    if (!p_releaseFastMallocFreeMemory) BRLog(@"WTF::releaseFastMallocFreeMemory not found");
    p_JSGlobalContextCreateInGroup = BRLookup(handle, "JSGlobalContextCreateInGroup");
    resolved = YES;
    return YES;
}

NSString * const BRJSEngineDidResetNotification = @"BRJSEngineDidResetNotification";

static JSVal BRAvailableMBCallback(JSCtx ctx, JSObj function, JSObj thisObject, size_t argc, const JSVal argv[], JSVal *exception)
{
    return p_JSValueMakeNumber(ctx, (double)[BRMemory availableMB]);
}

@implementation BRJSEngine {
    NSThread *_thread;
    NSCondition *_condition;
    NSMutableArray *_queue;
    JSCtx _ctx;
    void *_group;       // this engine's context group (its VM and heap)
    BOOL _available;
    NSUInteger _uses;   // engine thread: counts evaluations, so an idle release can tell whether it was used since
    volatile int32_t _pendingCount;   // blocks queued or running
}
@synthesize lastNoRoom = _lastNoRoom;

+ (instancetype)shared
{
    static BRJSEngine *engine;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ engine = [[BRJSEngine alloc] initWithName:@"com.samcejko.browser.js"]; });
    return engine;
}

+ (instancetype)transpiler
{
    static BRJSEngine *engine;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ engine = [[BRJSEngine alloc] initWithName:@"com.samcejko.browser.js2"]; });
    return engine;
}

+ (instancetype)transpiler2
{
    static BRJSEngine *engine;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ engine = [[BRJSEngine alloc] initWithName:@"com.samcejko.browser.js3"]; });
    return engine;
}

- (NSInteger)pending
{
    return _pendingCount;
}

- (instancetype)initWithName:(NSString *)name
{
    self = [super init];
    if (self) {
        _available = BRResolveJSC();
        _condition = [[NSCondition alloc] init];
        _queue = [NSMutableArray array];
        _thread = [[NSThread alloc] initWithTarget:self selector:@selector(threadMain) object:nil];
        _thread.name = name;
        _thread.stackSize = 16 * 1024 * 1024;   // Babel's traversal recurses far deeper than the 512 KB default allows
        [_thread start];
    }
    return self;
}

- (void)threadMain
{
    // (the name as the system knows it too, so the sampler finds the thread: surfari:profile?key=...&thread=js)
    const char *threadName = _thread.name.UTF8String;
    if (threadName) pthread_setname_np(threadName);
    for (;;) {
        dispatch_block_t block = nil;
        [_condition lock];
        while (!_queue.count) [_condition wait];
        block = _queue[0];
        [_queue removeObjectAtIndex:0];
        [_condition unlock];
        @autoreleasepool {
            block();
        }
        OSAtomicDecrement32(&_pendingCount);
    }
}

- (BOOL)available
{
    return _available;
}

- (void)performAsync:(dispatch_block_t)block
{
    if (!block) return;
    OSAtomicIncrement32(&_pendingCount);
    [_condition lock];
    [_queue addObject:[block copy]];
    [_condition signal];
    [_condition unlock];
}

- (void)performSync:(dispatch_block_t)block
{
    if (!block) return;
    if ([NSThread currentThread] == _thread) {
        block();
        return;
    }
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [self performAsync:^{
        block();
        dispatch_semaphore_signal(done);
    }];
    dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
}

- (void)resetContext
{
    [self performAsync:^{ [self releaseContext:@"reset"]; }];
}

- (void)releaseContextNow
{
    [self releaseContext:@"requested"];
}

- (void)releaseWhenIdleFor:(NSTimeInterval)seconds aboveMB:(long)minimumMB
{
    NSUInteger uses = _uses;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_LOW, 0), ^{
        [self performAsync:^{
            if (uses != _uses || !_ctx) return;   // used again in the meantime (that use schedules its own release)
            if (minimumMB > 0 && BRResidentMemoryMB() < minimumMB) return;
            [self releaseContext:@"idle"];
        }];
    });
}

// engine thread
- (void)releaseContext:(NSString *)why
{
    if (!_ctx) return;
    long before = (long)BRResidentMemoryMB();
    // the group goes first: releasing the context then drops the last reference to the VM, which destroys the whole
    // heap at once (with the group kept, the context's objects are only garbage the heap holds on to)
    if (_group && p_JSContextGroupRelease) {
        p_JSContextGroupRelease(_group);
        _group = NULL;
    }
    p_JSGlobalContextRelease(_ctx);
    _ctx = NULL;
    long released = (long)BRResidentMemoryMB();
    if (p_releaseFastMallocFreeMemory) p_releaseFastMallocFreeMemory();
    size_t relief = malloc_zone_pressure_relief(NULL, 0);
    BRLog(@"JavaScript context %@ released (%@): %ld -> %ld MB, free malloc pages returned (%ld MB): %ld MB", _thread.name, why, before, released,
          (long)(relief >> 20), (long)BRResidentMemoryMB());
    [[NSNotificationCenter defaultCenter] postNotificationName:BRJSEngineDidResetNotification object:self];
}

+ (void)returnFreeMemory
{
    if (BRResolveJSC() && p_releaseFastMallocFreeMemory) p_releaseFastMallocFreeMemory();
    // (this JavaScriptCore may allocate through the system malloc: its free pages go back only on request)
    malloc_zone_pressure_relief(NULL, 0);
}

// The engine's tiers: the interpreter, the baseline JIT and the optimizing JIT for hot code. Their switches are
// JavaScriptCore's global JSC::Options (exported; JSC::initializeThreading sets the defaults once, and they are read
// whenever a function is compiled). The optimizing JIT of this engine miscompiles some of today's minified code
// (rohlik.cz: e[l++]+e[l++] read the same character twice and the page fell over; the interpreter alone got it right).
// BRJSCMode: 0 all tiers, 1 no optimizing JIT (the default: page loads measured the same, lowering scripts ~10 %
// slower, and a miscompiled transpiler would even spoil the cache), 2 the interpreter only (debugging; regular
// expressions keep their JIT).
static const NSInteger BRJSCDefaultMode = 1;

// A symbol of a loaded library that dlsym does not see (not exported): from the library's own symbol table, which the
// system's shared cache keeps mapped. name as in the table (with the leading underscore).
static void *BRFindLocalSymbol(const char *library, const char *name)
{
    uint32_t count = _dyld_image_count();
    for (uint32_t i = 0; i < count; i++) {
        const char *path = _dyld_get_image_name(i);
        if (!path || !strstr(path, library)) continue;
        const struct mach_header *mh = _dyld_get_image_header(i);
        intptr_t slide = _dyld_get_image_vmaddr_slide(i);
        if (!mh || mh->magic != MH_MAGIC) return NULL;
        const struct load_command *lc = (const struct load_command *)(mh + 1);
        const struct symtab_command *symtab = NULL;
        const struct segment_command *linkedit = NULL;
        for (uint32_t c = 0; c < mh->ncmds; c++) {
            if (lc->cmd == LC_SYMTAB) symtab = (const struct symtab_command *)lc;
            else if (lc->cmd == LC_SEGMENT && strcmp(((const struct segment_command *)lc)->segname, SEG_LINKEDIT) == 0) linkedit = (const struct segment_command *)lc;
            lc = (const struct load_command *)((const char *)lc + lc->cmdsize);
        }
        if (!symtab || !linkedit) return NULL;
        uintptr_t base = (uintptr_t)linkedit->vmaddr + slide - linkedit->fileoff;
        const struct nlist *syms = (const struct nlist *)(base + symtab->symoff);
        const char *strings = (const char *)(base + symtab->stroff);
        for (uint32_t s = 0; s < symtab->nsyms; s++) {
            uint32_t at = syms[s].n_un.n_strx;
            if (!at || at >= symtab->strsize || (syms[s].n_type & N_STAB) || (syms[s].n_type & N_TYPE) != N_SECT) continue;
            if (strcmp(strings + at, name) == 0) return (void *)(uintptr_t)(syms[s].n_value + slide + ((syms[s].n_desc & N_ARM_THUMB_DEF) ? 1 : 0));
        }
        return NULL;
    }
    return NULL;
}

// The system's shared cache on iOS 6 keeps the local symbols of its libraries apart, in a part of the cache file that
// is not mapped: read from the file (only that part is mapped, read-only, for the lookup). names -> found[] (the
// addresses in this process, NULL when not found).
struct BRCacheHeader { char magic[16]; uint32_t mappingOffset, mappingCount, imagesOffset, imagesCount; uint64_t dyldBaseAddress,
    codeSignatureOffset, codeSignatureSize, slideInfoOffset, slideInfoSize, localSymbolsOffset, localSymbolsSize; uint8_t uuid[16]; };
struct BRCacheMapping { uint64_t address, size, fileOffset; uint32_t maxProt, initProt; };
struct BRCacheLocalInfo { uint32_t nlistOffset, nlistCount, stringsOffset, stringsSize, entriesOffset, entriesCount; };
struct BRCacheLocalEntry { uint32_t dylibOffset, nlistStartIndex, nlistCount; };

static void BRFindCacheLocalSymbols(const char *library, const char *const names[], void *found[], int count)
{
    for (int k = 0; k < count; k++) found[k] = NULL;
    const struct mach_header *mh = NULL;
    intptr_t slide = 0;
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
        const char *path = _dyld_get_image_name(i);
        if (path && strstr(path, library)) { mh = _dyld_get_image_header(i); slide = _dyld_get_image_vmaddr_slide(i); break; }
    }
    if (!mh) return;
    const char *files[] = { "/System/Library/Caches/com.apple.dyld/dyld_shared_cache_armv7s", "/System/Library/Caches/com.apple.dyld/dyld_shared_cache_armv7" };
    for (int f = 0; f < 2; f++) {
        int fd = open(files[f], O_RDONLY);
        if (fd < 0) continue;
        struct BRCacheHeader h;
        struct BRCacheMapping m;
        BOOL ok = pread(fd, &h, sizeof(h), 0) == (ssize_t)sizeof(h) && strncmp(h.magic, "dyld_v1", 7) == 0 &&
                  h.mappingOffset >= offsetof(struct BRCacheHeader, uuid) && h.localSymbolsOffset && h.localSymbolsSize &&
                  pread(fd, &m, sizeof(m), h.mappingOffset) == (ssize_t)sizeof(m);
        uint64_t unslid = (uint64_t)((uintptr_t)mh - slide);
        if (!ok || unslid < m.address || unslid >= m.address + m.size) { close(fd); continue; }
        uint32_t dylibOffset = (uint32_t)(unslid - m.address + m.fileOffset);
        long page = sysconf(_SC_PAGESIZE);
        off_t start = (off_t)(h.localSymbolsOffset & ~(uint64_t)(page - 1));
        size_t length = (size_t)(h.localSymbolsSize + (h.localSymbolsOffset - (uint64_t)start));
        void *map = mmap(NULL, length, PROT_READ, MAP_PRIVATE, fd, start);
        close(fd);
        if (map == MAP_FAILED) return;
        const char *chunk = (const char *)map + (h.localSymbolsOffset - (uint64_t)start);
        const struct BRCacheLocalInfo *info = (const struct BRCacheLocalInfo *)chunk;
        const struct BRCacheLocalEntry *entries = (const struct BRCacheLocalEntry *)(chunk + info->entriesOffset);
        for (uint32_t e = 0; e < info->entriesCount; e++) {
            if (entries[e].dylibOffset != dylibOffset) continue;
            const struct nlist *syms = (const struct nlist *)(chunk + info->nlistOffset) + entries[e].nlistStartIndex;
            const char *strings = chunk + info->stringsOffset;
            for (uint32_t s = 0; s < entries[e].nlistCount && entries[e].nlistStartIndex + s < info->nlistCount; s++) {
                uint32_t at = syms[s].n_un.n_strx;
                if (!at || at >= info->stringsSize || (syms[s].n_type & N_STAB) || (syms[s].n_type & N_TYPE) != N_SECT) continue;
                // (a Thumb function's address carries bit 0, as dlsym gives it: a data symbol's never does)
                for (int k = 0; k < count; k++) if (!found[k] && strcmp(strings + at, names[k]) == 0) found[k] = (void *)(uintptr_t)(syms[s].n_value + slide + ((syms[s].n_desc & N_ARM_THUMB_DEF) ? 1 : 0));
            }
            break;
        }
        munmap(map, length);
        return;
    }
}

// JavaScriptCore's symbols by name (with the leading underscore): exported, in the library's symbol table, or among
// the shared cache's local symbols
static void BRFindJSCSymbols(const char *const names[], void *found[], int count)
{
    static const char *library = "/JavaScriptCore.framework/JavaScriptCore";
    BOOL missing = NO;
    for (int k = 0; k < count; k++) {
        found[k] = dlsym(RTLD_DEFAULT, names[k] + 1);
        if (!found[k]) found[k] = BRFindLocalSymbol(library, names[k]);
        if (!found[k]) missing = YES;
    }
    if (!missing) return;
    void *local[8] = { NULL };
    if (count > 8) return;
    BRFindCacheLocalSymbols(library, names, local, count);
    for (int k = 0; k < count; k++) if (!found[k]) found[k] = local[k];
}

+ (void)applyEngineTiers
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    NSInteger mode = [d objectForKey:@"BRJSCMode"] ? [d integerForKey:@"BRJSCMode"] : BRJSCDefaultMode;
    void (*initialize)(void) = (void (*)(void))dlsym(RTLD_DEFAULT, "_ZN3JSC19initializeThreadingEv");
    const char *names[] = { "__ZN3JSC7Options44maximumOptimizationCandidateInstructionCountE", "__ZN3JSC7Options26thresholdForJITAfterWarmUpE",
                            "__ZN3JSC7Options19thresholdForJITSoonE" };
    void *found[3];
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    BRFindJSCSymbols(names, found, 3);
    unsigned *candidates = (unsigned *)found[0];
    int32_t *jitAfterWarmUp = (int32_t *)found[1], *jitSoon = (int32_t *)found[2];
    long ms = (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000);
    if (!initialize || !candidates || !jitAfterWarmUp || !jitSoon) {
        BRLog(@"JavaScriptCore tiers: the engine's switches were not found (%d%d%d%d, %ld ms), all tiers stay", !!initialize, !!candidates, !!jitAfterWarmUp, !!jitSoon, ms);
        return;
    }
    initialize();
    unsigned oldCandidates = *candidates;
    int32_t oldWarmUp = *jitAfterWarmUp, oldSoon = *jitSoon;
    // (the engine's own defaults are there, or these are not the switches: nothing is written then)
    if (oldCandidates < 100 || oldCandidates > 1000000 || oldWarmUp < 1 || oldWarmUp > 100000 || oldSoon < 1 || oldSoon > 100000) {
        BRLog(@"JavaScriptCore tiers: unexpected values (%u, %d, %d), all tiers stay", oldCandidates, oldWarmUp, oldSoon);
        return;
    }
    if (mode >= 1) *candidates = 0;   // no function is small enough for the optimizing JIT
    if (mode >= 2) { *jitAfterWarmUp = INT32_MAX; *jitSoon = INT32_MAX; }   // (the maximum: never)
    // BRJSCWarmUp: the interpreter's count before the baseline JIT takes a function (an entry counts 15, a loop's
    // round 1; JavaScriptCore's own 100), for experiments. (Kodium's workbench typed slower with 30: JavaScriptCore
    // throws compiled code away every minute, and there was more to compile again.)
    NSInteger warmUp = [d integerForKey:@"BRJSCWarmUp"];
    if (mode < 2 && warmUp > 0 && warmUp < 100000) { *jitAfterWarmUp = (int32_t)warmUp; if (*jitSoon > (int32_t)warmUp) *jitSoon = (int32_t)warmUp; }
    BRLog(@"JavaScriptCore tiers: mode %ld (optimizing JIT for functions up to %u -> %u instructions, baseline JIT after %d -> %d runs; %ld ms)",
          (long)mode, oldCandidates, *candidates, oldWarmUp, *jitAfterWarmUp, ms);
}

// The pages' compiled code kept (BRJSCKeepCode). JavaScriptCore throws the compiled code of every function away at a
// garbage collection a minute after it last did (Heap::collect: now - m_lastCodeDiscardTime > 60 s), and each function
// is parsed and compiled again when it next runs: Kodium's first action after a pause took 0.4-0.5 s longer (a switch
// of editors 1.8 s instead of 1.3). The time of the last discard is a field of the heap of WebCore's JSGlobalData (the
// pages'): it is moved forward every 20 s, on the WebThread between scripts, while memory is not short; when memory
// gets critical the code is thrown away at once (Heap::discardAllCompiledCode, which waits for no script to run), as
// JavaScriptCore would have. The offsets are read from the engine's own code - Heap::collect takes the address of the
// time ("addw rX, r4, #offset") right before it calls WTF::currentTime, Heap::discardAllCompiledCode reads the
// JSGlobalData from the heap first ("ldr.w rX, [r0, #offset]"), and the heap is the member of the JSGlobalData that
// points back to it - so an engine whose code differs is left alone. (Hooking FunctionExecutable::discardCode instead
// crashed: code blocks of the functions it skipped stayed referenced by stale ones.)
typedef void (*BRWebThreadRunFn)(void (^block)(void));
static double *g_lastCodeDiscard;
static void *g_codeHeap;
static void (*g_discardAllCompiledCode)(void *heap);
static double (*g_currentTime)(void);
static BOOL g_codeKeptFound, g_codeThrownForMemory;
static NSTimer *g_codeKeeper;

static const uint16_t *BRThumbCode(void *function)
{
    return (const uint16_t *)((uintptr_t)function & ~(uintptr_t)1);
}

// Heap::collect: "addw rX, r4, #imm" followed by "bl WTF::currentTime", in its first 64 halfword pairs -> imm
static int BRDiscardTimeOffset(void *collect, void *currentTime)
{
    const uint16_t *code = BRThumbCode(collect);
    uintptr_t target = (uintptr_t)currentTime & ~(uintptr_t)1;
    for (int i = 0; i + 4 <= 128; i++) {
        uint16_t hw1 = code[i], hw2 = code[i + 1];
        if ((hw1 & 0xfbff) != 0xf204 || (hw2 & 0x8000)) continue;   // ADDW Rd, R4, #imm12
        int imm = (((hw1 >> 10) & 1) << 11) | (((hw2 >> 12) & 7) << 8) | (hw2 & 0xff);
        uint16_t b1 = code[i + 2], b2 = code[i + 3];
        if ((b1 & 0xf800) != 0xf000 || (b2 & 0xd000) != 0xd000) continue;   // BL
        int32_t S = (b1 >> 10) & 1, J1 = (b2 >> 13) & 1, J2 = (b2 >> 11) & 1;
        int32_t I1 = !(J1 ^ S), I2 = !(J2 ^ S);
        int32_t offset = (S << 24) | (I1 << 23) | (I2 << 22) | ((b1 & 0x3ff) << 12) | ((b2 & 0x7ff) << 1);
        if (S) offset -= 1 << 25;
        if ((uintptr_t)(code + i + 2) + 4 + offset == target) return imm;
    }
    return -1;
}

// Heap::discardAllCompiledCode: "ldr.w rX, [r0, #imm]" among its first instructions -> imm (the heap's JSGlobalData)
static int BRHeapGlobalDataOffset(void *discardAll)
{
    const uint16_t *code = BRThumbCode(discardAll);
    for (int i = 0; i + 2 <= 8; i++) if (code[i] == 0xf8d0) return code[i + 1] & 0xfff;
    return -1;
}

// WebThread: finds the clock (once)
static BOOL BRFindCodeClock(void)
{
    static BOOL tried;
    if (tried) return g_codeKeptFound;
    tried = YES;
    void *(*commonGlobalData)(void) = (void *(*)(void))dlsym(RTLD_DEFAULT, "_ZN7WebCore15JSDOMWindowBase18commonJSGlobalDataEv");
    g_currentTime = (double (*)(void))dlsym(RTLD_DEFAULT, "_ZN3WTF11currentTimeEv");
    g_discardAllCompiledCode = (void (*)(void *))dlsym(RTLD_DEFAULT, "_ZN3JSC4Heap22discardAllCompiledCodeEv");
    const char *names[] = { "__ZN3JSC4Heap7collectENS0_11SweepToggleE" };
    void *collect[1];
    BRFindJSCSymbols(names, collect, 1);
    if (!commonGlobalData || !g_currentTime || !g_discardAllCompiledCode || !collect[0]) {
        BRLog(@"JavaScriptCore code kept: the engine's functions were not found (%d%d%d%d)", !!commonGlobalData, !!g_currentTime, !!g_discardAllCompiledCode, !!collect[0]);
        return NO;
    }
    int timeOffset = BRDiscardTimeOffset(collect[0], (void *)g_currentTime), dataOffset = BRHeapGlobalDataOffset((void *)g_discardAllCompiledCode);
    char *globalData = (char *)commonGlobalData();
    double now = g_currentTime();
    int heapOffset = -1;
    // (the heap's members that point back to the JSGlobalData too - its handle and weak sets - are told apart by the
    // clock: a recent time where the heap's would be, set when the heap was made or code was last thrown away)
    if (globalData && timeOffset > 0 && timeOffset < 8192 && dataOffset > 0 && dataOffset < 8192)
        for (int x = 0; x < 1024; x += 4) {
            if (*(char **)(globalData + x + dataOffset) != globalData) continue;
            double t = *(double *)(globalData + x + timeOffset);
            if (t > now - 7 * 86400 && t < now + 60) { heapOffset = x; break; }
        }
    if (heapOffset < 0) {
        BRLog(@"JavaScriptCore code kept: the engine's code is not the expected one (time %d, data %d), left alone", timeOffset, dataOffset);
        return NO;
    }
    double *discardClock = (double *)(globalData + heapOffset + timeOffset);
    g_codeHeap = globalData + heapOffset;
    g_lastCodeDiscard = discardClock;
    g_codeKeptFound = YES;
    BRLog(@"JavaScriptCore code kept: heap at +%d, clock at +%d (last discard %.0f s ago)", heapOffset, timeOffset, now - *discardClock);
    return YES;
}

+ (void)keepPageCode
{
    if (g_codeKeeper || ![[NSUserDefaults standardUserDefaults] boolForKey:@"BRJSCKeepCode"]) return;
    g_codeKeeper = [NSTimer scheduledTimerWithTimeInterval:20 target:self selector:@selector(keepPageCodeNow:) userInfo:nil repeats:YES];
}

+ (void)keepPageCodeNow:(NSTimer *)timer
{
    static BRWebThreadRunFn run;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ run = (BRWebThreadRunFn)dlsym(RTLD_DEFAULT, "WebThreadRun"); });
    if (!run) { [g_codeKeeper invalidate]; return; }
    BOOL critical = [BRMemory level] >= BRMemoryLevelCritical;
    run(^{
        if (!BRFindCodeClock()) {
            dispatch_async(dispatch_get_main_queue(), ^{ [g_codeKeeper invalidate]; });
            return;
        }
        if (critical) {
            if (!g_codeThrownForMemory) {
                g_codeThrownForMemory = YES;
                g_discardAllCompiledCode(g_codeHeap);
                *g_lastCodeDiscard = g_currentTime();
                BRLog(@"JavaScriptCore code kept: memory is short, the pages' compiled code thrown away");
            }
            return;
        }
        g_codeThrownForMemory = NO;
        *g_lastCodeDiscard = g_currentTime();
    });
}

// A bare JavaScriptCore context has no console, timers or globalThis; libraries expect them.
static NSString * const BRContextPrelude =
@"var globalThis = this; var self = this;"
@"var console = (function () { var c = {}, names = ['log','info','warn','error','debug','trace','dir','dirxml','table','group','groupEnd','groupCollapsed','time','timeEnd','timeLog','count','assert'];"
@"  for (var i = 0; i < names.length; i++) c[names[i]] = function () {}; return c; })();"
@"var setTimeout = function () { return 0; }, clearTimeout = function () {}, setInterval = setTimeout, clearInterval = clearTimeout;"
@"var queueMicrotask = function (f) { try { f(); } catch (e) {} };"
// RegExp constructor shim: the 2012 engine rejects the u, y and s flags; strip them with best-effort pattern rewrites
@"(function () { var Native = RegExp; try { new Native('a', 'u'); return; } catch (e) {}"
@"  function fromCodePoint(cp) { if (cp <= 0xFFFF) return '\\\\u' + ('0000' + cp.toString(16)).slice(-4); cp -= 0x10000;"
@"    return '\\\\u' + (0xD800 + (cp >> 10)).toString(16) + '\\\\u' + (0xDC00 + (cp & 0x3FF)).toString(16); }"
@"  var Shim = function RegExp(pattern, flags) {"
@"    if (pattern instanceof Native) { if (flags === undefined) return new Native(pattern); pattern = pattern.source; }"
@"    var f = flags === undefined ? '' : String(flags), src = String(pattern);"
@"    if (f.indexOf('u') >= 0) { f = f.replace(/u/g, ''); src = src.replace(/\\\\u\\{([0-9a-fA-F]+)\\}/g, function (m, h) { return fromCodePoint(parseInt(h, 16)); }); }"
@"    if (f.indexOf('s') >= 0) { f = f.replace(/s/g, ''); src = src.replace(/\\\\.|\\[(?:\\\\.|[^\\]])*\\]|\\./g, function (m) { return m === '.' ? '[\\\\s\\\\S]' : m; }); }"
@"    if (f.indexOf('y') >= 0) f = f.replace(/y/g, '');"
@"    if (f.indexOf('d') >= 0) f = f.replace(/d/g, '');"
@"    return new Native(src, f);"
@"  };"
@"  Shim.prototype = Native.prototype; Native.prototype.constructor = Shim;"
@"  RegExp = Shim;"
@"})();"
// natives that polyfill libraries like to replace with slow JavaScript versions; restored after each library load
@"var __brNatives = { JSON: { stringify: JSON.stringify, parse: JSON.parse },"
@"  String: { replace: String.prototype.replace, split: String.prototype.split, match: String.prototype.match, search: String.prototype.search,"
@"            trim: String.prototype.trim, indexOf: String.prototype.indexOf, slice: String.prototype.slice, toLowerCase: String.prototype.toLowerCase, charAt: String.prototype.charAt, charCodeAt: String.prototype.charCodeAt },"
@"  RegExp: { exec: RegExp.prototype.exec, test: RegExp.prototype.test, toString: RegExp.prototype.toString },"
@"  Array: { sort: Array.prototype.sort, slice: Array.prototype.slice, splice: Array.prototype.splice, concat: Array.prototype.concat, filter: Array.prototype.filter,"
@"           map: Array.prototype.map, forEach: Array.prototype.forEach, reduce: Array.prototype.reduce, reduceRight: Array.prototype.reduceRight, indexOf: Array.prototype.indexOf,"
@"           lastIndexOf: Array.prototype.lastIndexOf, join: Array.prototype.join, reverse: Array.prototype.reverse, some: Array.prototype.some, every: Array.prototype.every,"
@"           push: Array.prototype.push, unshift: Array.prototype.unshift },"
@"  Number: { toFixed: Number.prototype.toFixed, toPrecision: Number.prototype.toPrecision }, Function: { bind: Function.prototype.bind },"
@"  Object: { toString: Object.prototype.toString }, global: { parseInt: parseInt, parseFloat: parseFloat } };"
@"function __brRestoreNatives() {"
@"  var n = __brNatives, k;"
@"  for (k in n.JSON) JSON[k] = n.JSON[k];"
@"  for (k in n.String) String.prototype[k] = n.String[k];"
@"  for (k in n.RegExp) RegExp.prototype[k] = n.RegExp[k];"
@"  for (k in n.Array) Array.prototype[k] = n.Array[k];"
@"  for (k in n.Number) Number.prototype[k] = n.Number[k];"
@"  Object.prototype.toString = n.Object.toString;"
@"  parseInt = n.global.parseInt; parseFloat = n.global.parseFloat;"
@"  __brInstallJSHelpers();"
@"}"
// Contexts made through the C API get a tiny native-to-JS re-entry limit (16 levels) in this JSC. Callback
// based natives (forEach, map, replace with a function, sort with a comparator, bound functions) each count
// as a re-entry, so Babel's recursive traversal overflows. Pure JavaScript versions call back directly.
@"function __brInstallJSHelpers() {"
@"  var AP = Array.prototype, SP = String.prototype;"
@"  function len(o) { return o.length >>> 0; }"
@"  AP.forEach = function (cb, t) { var n = len(this); for (var i = 0; i < n; i++) if (i in this) cb.call(t, this[i], i, this); };"
@"  AP.map = function (cb, t) { var n = len(this), out = new Array(n); for (var i = 0; i < n; i++) if (i in this) out[i] = cb.call(t, this[i], i, this); return out; };"
@"  AP.filter = function (cb, t) { var n = len(this), out = []; for (var i = 0; i < n; i++) if (i in this) { var v = this[i]; if (cb.call(t, v, i, this)) out.push(v); } return out; };"
@"  AP.some = function (cb, t) { var n = len(this); for (var i = 0; i < n; i++) if (i in this && cb.call(t, this[i], i, this)) return true; return false; };"
@"  AP.every = function (cb, t) { var n = len(this); for (var i = 0; i < n; i++) if (i in this && !cb.call(t, this[i], i, this)) return false; return true; };"
@"  AP.reduce = function (cb, init) { var n = len(this), i = 0, acc; if (arguments.length >= 2) acc = init; else { while (i < n && !(i in this)) i++; if (i >= n) throw new TypeError('Reduce of empty array with no initial value'); acc = this[i++]; } for (; i < n; i++) if (i in this) acc = cb(acc, this[i], i, this); return acc; };"
@"  AP.reduceRight = function (cb, init) { var i = len(this) - 1, acc; if (arguments.length >= 2) acc = init; else { while (i >= 0 && !(i in this)) i--; if (i < 0) throw new TypeError('Reduce of empty array with no initial value'); acc = this[i--]; } for (; i >= 0; i--) if (i in this) acc = cb(acc, this[i], i, this); return acc; };"
@"  var nativeSort = __brNatives.Array.sort;"
@"  AP.sort = function (cmp) {"
@"    if (typeof cmp !== 'function') return nativeSort.call(this);"
@"    var n = len(this), a = new Array(n), tmp = new Array(n), i;"
@"    for (i = 0; i < n; i++) a[i] = this[i];"
@"    for (var w = 1; w < n; w *= 2) {"
@"      for (var lo = 0; lo < n; lo += 2 * w) {"
@"        var mid = Math.min(lo + w, n), hi = Math.min(lo + 2 * w, n), l = lo, r = mid, k = lo;"
@"        while (l < mid && r < hi) { if (cmp(a[l], a[r]) <= 0) tmp[k++] = a[l++]; else tmp[k++] = a[r++]; }"
@"        while (l < mid) tmp[k++] = a[l++]; while (r < hi) tmp[k++] = a[r++];"
@"      }"
@"      var sw = a; a = tmp; tmp = sw;"
@"    }"
@"    for (i = 0; i < n; i++) this[i] = a[i];"
@"    return this;"
@"  };"
@"  var nativeReplace = __brNatives.String.replace;"
@"  SP.replace = function (search, replacer) {"
@"    if (typeof replacer !== 'function') return nativeReplace.call(this, search, replacer);"
@"    var str = String(this), m, args;"
@"    if (!(search instanceof RegExp)) { search = String(search); var idx = str.indexOf(search); if (idx < 0) return str; return str.slice(0, idx) + String(replacer(search, idx, str)) + str.slice(idx + search.length); }"
@"    if (search.global) {"
@"      var out = '', last = 0; search.lastIndex = 0;"
@"      while ((m = search.exec(str)) !== null) {"
@"        args = m.slice(0); args.push(m.index, str);"
@"        out += str.slice(last, m.index) + String(replacer.apply(null, args));"
@"        last = m.index + m[0].length;"
@"        if (m[0] === '') { if (search.lastIndex >= str.length) break; search.lastIndex++; }"
@"      }"
@"      search.lastIndex = 0;"
@"      return out + str.slice(last);"
@"    }"
@"    m = search.exec(str); if (!m) return str;"
@"    args = m.slice(0); args.push(m.index, str);"
@"    return str.slice(0, m.index) + String(replacer.apply(null, args)) + str.slice(m.index + m[0].length);"
@"  };"
@"  if (typeof __brJSBind === 'function') Function.prototype.bind = __brJSBind;"
@"}"
// closure based bind: calls into a bound function are plain JavaScript calls
@"var __brJSBind = function bind(thisArg) {"
@"  var fn = this, bound = Array.prototype.slice.call(arguments, 1);"
@"  if (typeof fn !== 'function') throw new TypeError('Bind must be called on a function');"
@"  var F = function () { var args = bound.concat(Array.prototype.slice.call(arguments));"
@"    if (this instanceof F) { var obj = Object.create(fn.prototype || Object.prototype); var r = fn.apply(obj, args); return (r !== null && typeof r === 'object') || typeof r === 'function' ? r : obj; }"
@"    return fn.apply(thisArg, args); };"
@"  if (fn.prototype) F.prototype = fn.prototype;"
@"  return F;"
@"};"
@"__brInstallJSHelpers();";

- (BOOL)ensureContext
{
    if (!_available) return NO;
    if (!_ctx) {
        if (p_JSContextGroupCreate && p_JSGlobalContextCreateInGroup) {
            if (!_group) _group = p_JSContextGroupCreate();
            _ctx = _group ? p_JSGlobalContextCreateInGroup(_group, NULL) : NULL;
        }
        if (!_ctx) _ctx = p_JSGlobalContextCreate(NULL);
        if (!_ctx) {
            BRLog(@"JSGlobalContextCreate failed");
            return NO;
        }
        [self evaluateScript:BRContextPrelude sourceName:@"prelude.js"];
        if (p_JSObjectMakeFunctionWithCallback && p_JSValueMakeNumber) {
            JSStr name = p_JSStringCreateWithCFString(CFSTR("__brAvailableMB"));
            JSObj fn = p_JSObjectMakeFunctionWithCallback(_ctx, name, BRAvailableMBCallback);
            JSVal exc = NULL;
            if (fn) p_JSObjectSetProperty(_ctx, p_JSContextGetGlobalObject(_ctx), name, (JSVal)fn, 0, &exc);
            p_JSStringRelease(name);
        }
    }
    return YES;
}

- (NSString *)stringFromValue:(JSVal)value
{
    if (!value) return nil;
    JSVal exc = NULL;
    JSStr s = p_JSValueToStringCopy(_ctx, value, &exc);
    if (!s) return nil;
    CFStringRef cf = p_JSStringCopyCFString(kCFAllocatorDefault, s);
    p_JSStringRelease(s);
    return cf ? (__bridge_transfer NSString *)cf : nil;
}

- (void)logException:(JSVal)exception context:(NSString *)what
{
    NSString *text = [self stringFromValue:exception] ?: @"?";
    NSString *stack = nil;
    JSVal exc2 = NULL;
    JSObj obj = p_JSValueToObject(_ctx, exception, &exc2);
    if (obj) {
        JSStr name = p_JSStringCreateWithCFString(CFSTR("stack"));
        JSVal v = p_JSObjectGetProperty(_ctx, obj, name, &exc2);
        p_JSStringRelease(name);
        if (v && !p_JSValueIsUndefined(_ctx, v)) stack = [self stringFromValue:v];
    }
    if (stack.length > 1200) stack = [stack substringToIndex:1200];
    BRLog(@"JavaScript exception in %@: %@%@%@", what, text.length > 300 ? [text substringToIndex:300] : text, stack.length ? @"\n" : @"", stack ?: @"");
}

- (BOOL)evaluateScript:(NSString *)script sourceName:(NSString *)name
{
    _uses++;
    if (![self ensureContext] || !script) return NO;
    JSStr src = p_JSStringCreateWithCFString((__bridge CFStringRef)script);
    JSStr url = p_JSStringCreateWithCFString((__bridge CFStringRef)(name ?: @"script"));
    JSVal exc = NULL;
    p_JSEvaluateScript(_ctx, src, NULL, url, 1, &exc);
    p_JSStringRelease(src);
    p_JSStringRelease(url);
    if (exc) {
        [self logException:exc context:name ?: @"script"];
        return NO;
    }
    return YES;
}

- (NSString *)callFunction:(NSString *)function arguments:(NSArray *)arguments
{
    _uses++;
    if (![self ensureContext] || !function.length) return nil;
    JSObj global = p_JSContextGetGlobalObject(_ctx);
    NSMutableString *call = [NSMutableString stringWithFormat:@"%@(", function];
    for (NSUInteger i = 0; i < arguments.count; i++) {
        NSString *argName = [NSString stringWithFormat:@"__brArg%lu", (unsigned long)i];
        id arg = arguments[i];
        BOOL isNull = [arg isKindOfClass:[NSNull class]];
        if (!isNull) {
            JSStr s = p_JSStringCreateWithCFString((__bridge CFStringRef)[arg description]);
            JSVal value = p_JSValueMakeString(_ctx, s);
            p_JSStringRelease(s);
            JSStr pn = p_JSStringCreateWithCFString((__bridge CFStringRef)argName);
            JSVal exc = NULL;
            p_JSObjectSetProperty(_ctx, global, pn, value, 0, &exc);
            p_JSStringRelease(pn);
        }
        if (i) [call appendString:@","];
        [call appendString:isNull ? @"null" : argName];
    }
    [call appendString:@")"];
    JSStr src = p_JSStringCreateWithCFString((__bridge CFStringRef)call);
    JSVal exc = NULL;
    JSVal result = p_JSEvaluateScript(_ctx, src, NULL, NULL, 1, &exc);
    p_JSStringRelease(src);
    // drop the argument strings again so the context does not keep large inputs alive
    for (NSUInteger i = 0; i < arguments.count; i++) {
        JSStr pn = p_JSStringCreateWithCFString((__bridge CFStringRef)[NSString stringWithFormat:@"__brArg%lu", (unsigned long)i]);
        JSVal e2 = NULL;
        p_JSObjectSetProperty(_ctx, global, pn, p_JSValueMakeUndefined(_ctx), 0, &e2);
        p_JSStringRelease(pn);
    }
    if (exc) {
        [self logException:exc context:function];
        return nil;
    }
    if (!result || p_JSValueIsUndefined(_ctx, result) || p_JSValueIsNull(_ctx, result)) return nil;
    return [self stringFromValue:result];
}

- (void)collectGarbage
{
    if (_ctx) p_JSGarbageCollect(_ctx);
}

@end
