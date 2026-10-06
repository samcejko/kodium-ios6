#import "BRProfiler.h"
#import "BRWatchdog.h"
#import "BRCommon.h"
#import <objc/runtime.h>

#include <mach/mach.h>
#include <mach-o/dyld.h>
#include <mach-o/loader.h>
#include <mach-o/nlist.h>
#include <libkern/OSAtomic.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

extern char *__cxa_demangle(const char *mangled, char *buffer, size_t *length, int *status);

static const int BRProfileDepth = 64;
static const useconds_t BRProfileEvery = 4000;   // µs between samples (with the walk: about 200 a second)
static volatile int32_t g_profiling = 0;

// ---- The system libraries' local symbols: dladdr names them "<redacted>" in the shared cache, whose file keeps them in
// a part that is not mapped (BRJSEngine.m finds the engine's switches the same way)
struct BRPCacheHeader { char magic[16]; uint32_t mappingOffset, mappingCount, imagesOffset, imagesCount; uint64_t dyldBaseAddress,
    codeSignatureOffset, codeSignatureSize, slideInfoOffset, slideInfoSize, localSymbolsOffset, localSymbolsSize; uint8_t uuid[16]; };
struct BRPCacheMapping { uint64_t address, size, fileOffset; uint32_t maxProt, initProt; };
struct BRPCacheLocalInfo { uint32_t nlistOffset, nlistCount, stringsOffset, stringsSize, entriesOffset, entriesCount; };
struct BRPCacheLocalEntry { uint32_t dylibOffset, nlistStartIndex, nlistCount; };

static int BRCompareAddress(const void *a, const void *b)
{
    uintptr_t x = *(const uintptr_t *)a, y = *(const uintptr_t *)b;
    return x < y ? -1 : x > y;
}

// names[i] = the symbol (as in the table, mangled) that starts at wanted[i] (sorted, slid, even addresses) in the
// library whose header is mh; names not found stay NSNull
static void BRLocalSymbolNames(const struct mach_header *mh, intptr_t slide, const uintptr_t *wanted, NSUInteger count, NSMutableArray *names)
{
    const char *files[] = { "/System/Library/Caches/com.apple.dyld/dyld_shared_cache_armv7s", "/System/Library/Caches/com.apple.dyld/dyld_shared_cache_armv7" };
    for (int f = 0; f < 2; f++) {
        int fd = open(files[f], O_RDONLY);
        if (fd < 0) continue;
        struct BRPCacheHeader h;
        struct BRPCacheMapping m;
        BOOL ok = pread(fd, &h, sizeof(h), 0) == (ssize_t)sizeof(h) && strncmp(h.magic, "dyld_v1", 7) == 0 &&
                  h.mappingOffset >= offsetof(struct BRPCacheHeader, uuid) && h.localSymbolsOffset && h.localSymbolsSize &&
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
        const struct BRPCacheLocalInfo *info = (const struct BRPCacheLocalInfo *)chunk;
        const struct BRPCacheLocalEntry *entries = (const struct BRPCacheLocalEntry *)(chunk + info->entriesOffset);
        for (uint32_t e = 0; e < info->entriesCount; e++) {
            if (entries[e].dylibOffset != dylibOffset) continue;
            const struct nlist *syms = (const struct nlist *)(chunk + info->nlistOffset) + entries[e].nlistStartIndex;
            const char *strings = chunk + info->stringsOffset;
            for (uint32_t s = 0; s < entries[e].nlistCount && entries[e].nlistStartIndex + s < info->nlistCount; s++) {
                uint32_t at = syms[s].n_un.n_strx;
                if (!at || at >= info->stringsSize || (syms[s].n_type & N_STAB) || (syms[s].n_type & N_TYPE) != N_SECT) continue;
                uintptr_t addr = ((uintptr_t)syms[s].n_value + (uintptr_t)slide) & ~(uintptr_t)1;
                uintptr_t *hit = bsearch(&addr, wanted, count, sizeof(uintptr_t), BRCompareAddress);
                NSString *found = hit && names[(NSUInteger)(hit - wanted)] == [NSNull null] ? @(strings + at) : nil;
                if (found) names[(NSUInteger)(hit - wanted)] = found;
            }
            break;
        }
        munmap(map, length);
        return;
    }
}

// "WebCore::RenderBlock::layoutBlock" from "__ZN7WebCore11RenderBlock11layoutBlockEbNS_10LayoutUnitE" (no parameters)
static NSString *BRReadableName(const char *raw)
{
    if (!raw) return @"?";
    const char *name = raw;
    char *demangled = NULL;
    if (strncmp(raw, "__Z", 3) == 0) {
        int status = 0;
        demangled = __cxa_demangle(raw + 1, NULL, NULL, &status);
        if (demangled && status == 0) name = demangled;
    } else if (raw[0] == '_') {
        name = raw + 1;
    }
    // (up to the parameter list, outside template arguments)
    size_t len = strlen(name), cut = len;
    int depth = 0;
    for (size_t i = 0; i < len; i++) {
        if (name[i] == '<') depth++;
        else if (name[i] == '>' && depth) depth--;
        else if (name[i] == '(' && depth == 0 && i > 0) { cut = i; break; }
    }
    if (cut > 140) cut = 140;
    NSString *s = [[NSString alloc] initWithBytes:name length:cut encoding:NSUTF8StringEncoding] ?: @"?";
    free(demangled);
    return s;
}

static BOOL BRHasAny(NSString *s, NSArray *parts)
{
    for (NSString *p in parts) if ([s rangeOfString:p].location != NSNotFound) return YES;
    return NO;
}

// The kind of work a frame does, nil when it tells nothing (run loops, event dispatch: a deeper frame decides)
static NSString *BRKindOf(NSString *image, NSString *name, BOOL top)
{
    if (!image) return @"JavaScript";   // (no library: code the JIT made)
    if (top && BRHasAny(name, @[@"mach_msg_trap", @"__psynch_cvwait", @"semaphore_wait", @"semaphore_timedwait", @"__semwait_signal", @"kevent", @"__select"])) return @"waiting";
    if (top && [name hasPrefix:@"__psynch_mutexwait"]) return @"waiting for a lock";
    if ([image isEqualToString:@"JavaScriptCore"]) {
        if (BRHasAny(name, @[@"JSC::Heap::", @"SlotVisitor", @"MarkStack", @"MarkedSpace", @"MarkedBlock", @"MarkedAllocator", @"CopiedSpace", @"CopiedBlock",
                             @"GCActivityCallback", @"IncrementalSweeper", @"WeakSet", @"WeakBlock", @"HandleSet", @"ConservativeRoots", @"JSC::Heap"])) return @"garbage collection";
        if (BRHasAny(name, @[@"Yarr"])) return @"regular expressions";
        if (BRHasAny(name, @[@"JSC::Parser", @"JSC::Lexer", @"ASTBuilder", @"SyntaxChecker", @"BytecodeGenerator", @"JSC::JIT::", @"LinkBuffer", @"::compile",
                             @"UnlinkedCodeBlock", @"CodeBlock::CodeBlock", @"DFG::", @"FunctionExecutable::", @"ProgramExecutable::", @"EvalExecutable::",
                             @"ParserArena", @"ScopeNode", @"FunctionBodyNode"])) return @"JavaScript compiling";
        return @"JavaScript";
    }
    if ([image isEqualToString:@"WebCore"]) {
        if (BRHasAny(name, @[@"StyleResolver", @"CSSStyleSelector", @"SelectorChecker", @"recalcStyle", @"RuleSet", @"RuleData", @"matchRules", @"styleForElement",
                             @"CSSParser", @"StyleSheet", @"StyleSharing", @"CSSComputedStyleDeclaration", @"computedStyle", @"StylePropertySet",
                             @"styleSelector", @"CSSRule", @"ElementRuleCollector", @"SelectorQuery", @"CSSSelector", @"MediaQuery"])) return @"style";
        if (BRHasAny(name, @[@"HTMLDocumentParser", @"HTMLTreeBuilder", @"HTMLTokenizer", @"HTMLConstructionSite", @"HTMLParserScheduler", @"HTMLPreloadScanner",
                             @"HTMLSourceTracker", @"HTMLInputStream", @"HTMLEntity"])) return @"HTML parsing";
        if (BRHasAny(name, @[@"paint", @"Paint", @"GraphicsContext", @"GraphicsLayer", @"RenderLayerBacking", @"RenderLayerCompositor", @"TileCache",
                             @"TiledLayer", @"WKGraphics", @"::draw", @"ImageBuffer"])) return @"painting";
        if (BRHasAny(name, @[@"layout", @"Layout", @"RenderBlock", @"RenderBox", @"RenderFlexibleBox", @"RenderDeprecatedFlexibleBox", @"RenderTable",
                             @"RenderText", @"RenderInline", @"InlineFlowBox", @"InlineBox", @"InlineTextBox", @"RootInlineBox", @"LineBreaker", @"LineWidth",
                             @"PreferredLogicalWidths", @"computeLogical", @"WebCore::Font::", @"WidthIterator", @"GlyphPage", @"SimpleFontData", @"TextRun",
                             @"RenderView", @"RenderObject", @"RenderLayer", @"RenderReplaced", @"RenderImage", @"RenderListItem", @"FloatingObject",
                             @"TextBreakIterator", @"RenderStyle"])) return @"layout";
        if (BRHasAny(name, @[@"ImageDecoder", @"ImageSource", @"BitmapImage", @"CachedImage"])) return @"images";
        if ([name hasPrefix:@"WebCore::JS"] || [name hasPrefix:@"WebCore::js"] || BRHasAny(name, @[@"WebCore::toJS", @"ScriptController", @"JSEventListener"])) return @"DOM calls";
        if (BRHasAny(name, @[@"Timer", @"EventDispatcher", @"EventTarget", @"dispatchEvent", @"EventContext", @"ScheduledAction", @"ScriptExecutionContext"])) return nil;
        return @"WebCore (other)";
    }
    if ([image isEqualToString:@"Surfari"]) return @"app";
    if (BRHasAny(image, @[@"CoreGraphics", @"QuartzCore", @"libRIP", @"IOSurface", @"libCGFreetype", @"CoreText"])) return top ? @"painting" : nil;
    if (BRHasAny(image, @[@"ImageIO", @"libjpeg", @"libpng", @"AppleJPEG"])) return @"images";
    if (BRHasAny(image, @[@"libz", @"CFNetwork", @"Security", @"libcommonCrypto", @"libcorecrypto"])) return top ? @"network and decompression" : nil;
    return nil;
}

@implementation BRProfiler

+ (void)profileThreadNamed:(NSString *)name seconds:(NSTimeInterval)seconds completion:(void (^)(NSString *report))completion
{
    // ("main": the main thread, which has no name; asked for from it)
    pthread_t target = [name isEqualToString:@"main"] ? ([NSThread isMainThread] ? pthread_self() : NULL) : BRFindThreadNamed(name.UTF8String ?: "");
    if (!target) BRLog(@"Profiler: no thread named %@ among %@", name, BRThreadNames());
    if (!target || !OSAtomicCompareAndSwap32(0, 1, &g_profiling)) {
        dispatch_async(dispatch_get_main_queue(), ^{ completion(nil); });
        return;
    }
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0), ^{
        @autoreleasepool {
            NSString *report = [self sample:target name:name seconds:seconds];
            OSAtomicCompareAndSwap32(1, 0, &g_profiling);
            dispatch_async(dispatch_get_main_queue(), ^{ completion(report); });
        }
    });
}

// The samples: the thread is suspended, its registers read and its frame chain (r7) walked within its stack, then it
// goes on. Nothing between suspend and resume may take a lock (the thread might hold it): no allocation, no logging.
+ (NSString *)sample:(pthread_t)target name:(NSString *)name seconds:(NSTimeInterval)seconds
{
    thread_t thread = pthread_mach_thread_np(target);
    uintptr_t top = (uintptr_t)pthread_get_stackaddr_np(target), bottom = top - (uintptr_t)pthread_get_stacksize_np(target);
    int capacity = (int)(seconds * 1000000.0 / BRProfileEvery) + 16;
    uintptr_t *frames = calloc((size_t)capacity * BRProfileDepth, sizeof(uintptr_t));
    uint8_t *depths = calloc((size_t)capacity, 1);
    if (!frames || !depths) { free(frames); free(depths); return nil; }
    int count = 0, failures = 0;
    CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent(), end = t0 + seconds;
    while (count < capacity && CFAbsoluteTimeGetCurrent() < end) {
        usleep(BRProfileEvery);
        if (thread_suspend(thread) != KERN_SUCCESS) { if (++failures > 20) break; continue; }   // (the thread ended)
        uintptr_t *row = frames + (size_t)count * BRProfileDepth;
        int depth = 0;
        arm_thread_state_t state;
        mach_msg_type_number_t stateCount = ARM_THREAD_STATE_COUNT;
        if (thread_get_state(thread, ARM_THREAD_STATE, (thread_state_t)&state, &stateCount) == KERN_SUCCESS) {
            row[depth++] = state.__pc;
            uintptr_t fp = state.__r[7];
            while (depth < BRProfileDepth && fp >= bottom && fp + 2 * sizeof(uintptr_t) <= top && !(fp & 3)) {
                uintptr_t next = ((uintptr_t *)fp)[0], ret = ((uintptr_t *)fp)[1];
                if (!ret) break;
                row[depth++] = ret;
                if (next <= fp) break;
                fp = next;
            }
        }
        thread_resume(thread);
        if (depth) depths[count++] = (uint8_t)depth;
    }
    NSTimeInterval took = CFAbsoluteTimeGetCurrent() - t0;
    NSString *report = [self reportForFrames:frames depths:depths count:count name:name seconds:took];
    free(frames);
    free(depths);
    return report;
}

// method implementations of the app's own classes, sorted: its binary has no symbols
+ (void)appMethods:(NSMutableData *)imps names:(NSMutableArray *)names
{
    unsigned int classCount = 0;
    const char **classes = objc_copyClassNamesForImage(_dyld_get_image_name(0), &classCount);
    NSMutableArray *pairs = [NSMutableArray array];
    for (unsigned int i = 0; i < classCount; i++) {
        Class cls = objc_getClass(classes[i]);
        if (!cls) continue;
        for (int meta = 0; meta < 2; meta++) {
            unsigned int methodCount = 0;
            Method *methods = class_copyMethodList(meta ? object_getClass(cls) : cls, &methodCount);
            for (unsigned int m = 0; m < methodCount; m++) {
                uintptr_t imp = (uintptr_t)method_getImplementation(methods[m]) & ~(uintptr_t)1;
                [pairs addObject:@[@(imp), [NSString stringWithFormat:@"%c[%s %@]", meta ? '+' : '-', classes[i], NSStringFromSelector(method_getName(methods[m]))]]];
            }
            free(methods);
        }
    }
    free(classes);
    [pairs sortUsingComparator:^NSComparisonResult(NSArray *a, NSArray *b) { return [a[0] compare:b[0]]; }];
    for (NSArray *p in pairs) {
        uintptr_t v = [p[0] unsignedLongValue];
        [imps appendBytes:&v length:sizeof(v)];
        [names addObject:p[1]];
    }
}

+ (NSString *)reportForFrames:(uintptr_t *)frames depths:(uint8_t *)depths count:(int)count name:(NSString *)threadName seconds:(NSTimeInterval)seconds
{
    if (!count) return [NSString stringWithFormat:@"%@ profile: no samples", threadName];
    // the distinct addresses
    size_t total = 0;
    for (int i = 0; i < count; i++) total += depths[i];
    uintptr_t *unique = malloc(total * sizeof(uintptr_t));
    if (!unique) return nil;
    size_t k = 0;
    for (int i = 0; i < count; i++) for (int d = 0; d < depths[i]; d++) unique[k++] = frames[(size_t)i * BRProfileDepth + d];
    qsort(unique, total, sizeof(uintptr_t), BRCompareAddress);
    size_t distinct = 0;
    for (size_t i = 0; i < total; i++) if (!distinct || unique[distinct - 1] != unique[i]) unique[distinct++] = unique[i];

    NSMutableArray *images = [NSMutableArray arrayWithCapacity:distinct], *labels = [NSMutableArray arrayWithCapacity:distinct];
    [self label:unique count:distinct images:images labels:labels];

    // per sample: the kind of work (the first frame from the top that tells), whether a script asked for it, and the
    // functions (on top, deciding, anywhere in the stack)
    // (the kind of each address, found when first needed: on top of the stack, and deeper)
    NSMutableArray *topKinds = [NSMutableArray arrayWithCapacity:distinct], *deepKinds = [NSMutableArray arrayWithCapacity:distinct];
    for (size_t i = 0; i < distinct; i++) { [topKinds addObject:[NSNull null]]; [deepKinds addObject:[NSNull null]]; }
    NSCountedSet *selfNames = [NSCountedSet set], *deciding = [NSCountedSet set], *inclusive = [NSCountedSet set];
    NSCountedSet *kindCounts = [NSCountedSet set], *scriptCounts = [NSCountedSet set];
    for (int s = 0; s < count; s++) {
        NSString *kind = nil, *decider = @"?";
        BOOL script = NO;
        NSMutableSet *seen = [NSMutableSet set];
        for (int d = 0; d < depths[s]; d++) {
            uintptr_t v = frames[(size_t)s * BRProfileDepth + d];
            size_t lo = 0, hi = distinct;
            while (lo < hi) { size_t mid = (lo + hi) / 2; if (unique[mid] < v) lo = mid + 1; else hi = mid; }
            NSString *label = labels[lo];
            if (d == 0) [selfNames addObject:label];
            if (![seen containsObject:label]) { [seen addObject:label]; [inclusive addObject:label]; }
            if (script) continue;
            NSMutableArray *cache = d == 0 ? topKinds : deepKinds;
            NSString *k = cache[lo];
            if ((id)k == [NSNull null]) {
                id image = images[lo];
                k = BRKindOf(image == [NSNull null] ? nil : image, label, d == 0) ?: @"";
                cache[lo] = k;
            }
            if (!k.length) continue;
            if (!kind) { kind = k; decider = label; }
            else if ([k isEqualToString:@"JavaScript"] || [k isEqualToString:@"DOM calls"]) script = YES;
        }
        if (!kind) kind = @"other";
        [kindCounts addObject:kind];
        if (script && ![kind isEqualToString:@"JavaScript"]) [scriptCounts addObject:kind];
        [deciding addObject:[NSString stringWithFormat:@"%@  (%@)", decider, kind]];
    }
    free(unique);

    NSMutableString *out = [NSMutableString stringWithFormat:@"%@ profile: %d samples in %.1f s (every %.1f ms)\n", threadName, count, seconds, seconds * 1000.0 / count];
    NSArray *(^ranked)(NSCountedSet *, NSUInteger) = ^NSArray *(NSCountedSet *set, NSUInteger limit) {
        NSArray *all = [set.allObjects sortedArrayUsingComparator:^NSComparisonResult(id a, id b) {
            NSUInteger x = [set countForObject:a], y = [set countForObject:b];
            return x > y ? NSOrderedAscending : x < y ? NSOrderedDescending : NSOrderedSame;
        }];
        return all.count > limit ? [all subarrayWithRange:NSMakeRange(0, limit)] : all;
    };
    [out appendString:@"by kind of work:"];
    for (NSString *kind in ranked(kindCounts, 20)) {
        NSUInteger c = [kindCounts countForObject:kind], fromScript = [scriptCounts countForObject:kind];
        [out appendFormat:@"\n  %5.1f %%  %@", 100.0 * c / count, kind];
        if (fromScript) [out appendFormat:@" (%.1f %% asked for by scripts)", 100.0 * fromScript / count];
    }
    [out appendString:@"\nfunctions that decided the kind:"];
    for (NSString *n in ranked(deciding, 40)) [out appendFormat:@"\n  %5.1f %%  %@", 100.0 * [deciding countForObject:n] / count, n];
    [out appendString:@"\non top of the stack:"];
    for (NSString *n in ranked(selfNames, 30)) [out appendFormat:@"\n  %5.1f %%  %@", 100.0 * [selfNames countForObject:n] / count, n];
    [out appendString:@"\nanywhere in the stack:"];
    for (NSString *n in ranked(inclusive, 50)) [out appendFormat:@"\n  %5.1f %%  %@", 100.0 * [inclusive countForObject:n] / count, n];
    return out;
}

// what each address of a sorted list without repeats is: dladdr, then the local symbols per library, the app's
// methods, or JIT code (one entry per address in images and labels)
+ (void)label:(const uintptr_t *)unique count:(size_t)distinct images:(NSMutableArray *)images labels:(NSMutableArray *)labels
{
    NSMutableDictionary *redacted = [NSMutableDictionary dictionary];   // library path -> NSMutableArray of @[index, start]
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];    // library path -> header address
    NSMutableData *appImps = nil;
    NSMutableArray *appNames = nil;
    const char *appPath = _dyld_get_image_name(0);
    for (size_t i = 0; i < distinct; i++) {
        uintptr_t lookup = (unique[i] & ~(uintptr_t)1) - 1;   // (a return address is after the call: the caller is before it)
        Dl_info info;
        if (!dladdr((void *)lookup, &info) || !info.dli_fname) {
            [images addObject:[NSNull null]];
            [labels addObject:@"JIT code"];
            continue;
        }
        const char *slash = strrchr(info.dli_fname, '/');
        NSString *image = @(slash ? slash + 1 : info.dli_fname);
        [images addObject:image];
        if (appPath && strcmp(info.dli_fname, appPath) == 0) {
            if (!appImps) { appImps = [NSMutableData data]; appNames = [NSMutableArray array]; [self appMethods:appImps names:appNames]; }
            const uintptr_t *imps = appImps.bytes;
            NSUInteger n = appImps.length / sizeof(uintptr_t), lo = 0, hi = n;
            while (lo < hi) { NSUInteger mid = (lo + hi) / 2; if (imps[mid] <= lookup) lo = mid + 1; else hi = mid; }
            if (lo > 0 && lookup - imps[lo - 1] < 16384) [labels addObject:appNames[lo - 1]];
            else [labels addObject:[NSString stringWithFormat:@"Surfari+0x%lx", (unsigned long)(lookup - (uintptr_t)info.dli_fbase)]];
            continue;
        }
        if (info.dli_sname && strcmp(info.dli_sname, "<redacted>") != 0) {
            [labels addObject:BRReadableName(info.dli_sname)];
            continue;
        }
        [labels addObject:[NSString stringWithFormat:@"%@+0x%lx", image, (unsigned long)(lookup - (uintptr_t)info.dli_fbase)]];
        if (!info.dli_saddr) continue;
        NSString *path = @(info.dli_fname);
        NSMutableArray *list = redacted[path] ?: (redacted[path] = [NSMutableArray array]);
        [list addObject:@[@(i), @((uintptr_t)info.dli_saddr & ~(uintptr_t)1)]];
        headers[path] = @((uintptr_t)info.dli_fbase);
    }
    for (NSString *path in redacted) {
        const struct mach_header *mh = (const struct mach_header *)[headers[path] unsignedLongValue];
        intptr_t slide = 0;
        for (uint32_t i = 0; i < _dyld_image_count(); i++) if (_dyld_get_image_header(i) == mh) { slide = _dyld_get_image_vmaddr_slide(i); break; }
        NSArray *list = redacted[path];
        NSMutableData *starts = [NSMutableData data];
        NSArray *sorted = [list sortedArrayUsingComparator:^NSComparisonResult(NSArray *a, NSArray *b) { return [a[1] compare:b[1]]; }];
        NSMutableArray *startList = [NSMutableArray array];
        for (NSArray *e in sorted) {
            uintptr_t v = [e[1] unsignedLongValue];
            if (startList.count && [startList.lastObject unsignedLongValue] == v) continue;
            [starts appendBytes:&v length:sizeof(v)];
            [startList addObject:e[1]];
        }
        NSMutableArray *names = [NSMutableArray arrayWithCapacity:startList.count];
        for (NSUInteger i = 0; i < startList.count; i++) [names addObject:[NSNull null]];
        BRLocalSymbolNames(mh, slide, starts.bytes, startList.count, names);
        NSMutableDictionary *byStart = [NSMutableDictionary dictionary];
        for (NSUInteger i = 0; i < startList.count; i++) if (names[i] != [NSNull null]) byStart[startList[i]] = BRReadableName([names[i] UTF8String]);
        for (NSArray *e in list) {
            NSString *label = byStart[e[1]];
            if (label) labels[[e[0] unsignedIntegerValue]] = label;
        }
    }
}

+ (NSString *)symbolicate:(NSString *)list
{
    NSMutableData *given = [NSMutableData data];
    NSCharacterSet *other = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEFxX"] invertedSet];
    for (NSString *token in [list componentsSeparatedByCharactersInSet:other]) {
        unsigned long long v = 0;
        if (!token.length || ![[NSScanner scannerWithString:token] scanHexLongLong:&v] || !v) continue;
        uintptr_t a = (uintptr_t)v;
        [given appendBytes:&a length:sizeof(a)];
    }
    NSUInteger n = given.length / sizeof(uintptr_t);
    if (!n) return @"(no addresses)";
    uintptr_t *unique = malloc(n * sizeof(uintptr_t));
    if (!unique) return @"(no memory)";
    memcpy(unique, given.bytes, n * sizeof(uintptr_t));
    qsort(unique, n, sizeof(uintptr_t), BRCompareAddress);
    size_t distinct = 0;
    for (size_t i = 0; i < n; i++) if (!distinct || unique[distinct - 1] != unique[i]) unique[distinct++] = unique[i];
    NSMutableArray *images = [NSMutableArray arrayWithCapacity:distinct], *labels = [NSMutableArray arrayWithCapacity:distinct];
    [self label:unique count:distinct images:images labels:labels];
    NSMutableString *out = [NSMutableString string];
    const uintptr_t *addrs = given.bytes;
    for (NSUInteger i = 0; i < n; i++) {
        size_t lo = 0, hi = distinct;
        while (lo < hi) { size_t mid = (lo + hi) / 2; if (unique[mid] < addrs[i]) lo = mid + 1; else hi = mid; }
        id image = images[lo];
        [out appendFormat:@"0x%08lx  %@  %@\n", (unsigned long)addrs[i], image == [NSNull null] ? @"?" : image, labels[lo]];
    }
    free(unique);
    return out;
}

@end
