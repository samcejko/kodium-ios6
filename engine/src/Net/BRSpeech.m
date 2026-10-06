#import "BRSpeech.h"
#import "BRCommon.h"
#import <objc/message.h>
#import <objc/runtime.h>
#include <dlfcn.h>

// VSSpeechSynthesizer (iOS 6 VoiceServices, private): the selectors are called through objc_msgSend with explicit
// signatures and the return values of the setters and start/stop calls are ignored (they return an NSError or nothing).
// Everything runs on a thread of its own with a run loop: the engine talks to the voiced daemon and may wait for it,
// which must never hold up the main thread (UIWebView waits for the main thread in turn).
static NSString * const BRVoiceServicesPath = @"/System/Library/PrivateFrameworks/VoiceServices.framework/VoiceServices";
static NSString * const BRVoiceResourcesPath = @"/System/Library/PrivateFrameworks/VoiceServices.framework/TTSResources";
static const NSUInteger BRMaxSpeechEvents = 400;

@implementation BRSpeech {
    NSThread *_thread;
    Class _synthClass;
    BOOL _loaded;
    float _defaultRate, _defaultPitch, _defaultVolume;
    NSArray *_languages;
    NSData *_info;                    // cached infoJSON
    NSMutableArray *_events;          // guarded by @synchronized (self)
    NSInteger _seq;
    // one synthesizer per utterance (speech thread only): its delegate callbacks then belong to that utterance
    id _current;
    NSMutableArray *_live;
    NSMutableDictionary *_ids;        // synthesizer pointer -> utterance id
    NSMutableDictionary *_starts;     // synthesizer pointer -> start time
}

+ (instancetype)shared
{
    static BRSpeech *s;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        s = [[BRSpeech alloc] init];
        [s perform:^{ [s loadEngine]; }];
    });
    return s;
}

- (instancetype)init
{
    self = [super init];
    if (self) {
        _events = [NSMutableArray array];
        _live = [NSMutableArray array];
        _ids = [NSMutableDictionary dictionary];
        _starts = [NSMutableDictionary dictionary];
        _defaultRate = 1; _defaultPitch = 1; _defaultVolume = 1;
        _thread = [[NSThread alloc] initWithTarget:self selector:@selector(threadMain) object:nil];
        _thread.name = @"BRSpeech";
        [_thread start];
    }
    return self;
}

- (void)threadMain
{
    @autoreleasepool {
        // a port keeps the run loop alive between the blocks performed on it
        [[NSRunLoop currentRunLoop] addPort:[NSMachPort port] forMode:NSDefaultRunLoopMode];
        while (YES) {
            @autoreleasepool { [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate distantFuture]]; }
        }
    }
}

- (void)runBlock:(dispatch_block_t)block { block(); }

- (void)perform:(dispatch_block_t)block
{
    [self performSelector:@selector(runBlock:) onThread:_thread withObject:[block copy] waitUntilDone:NO];
}

- (BOOL)available
{
    @synchronized (self) { return _synthClass != nil; }
}

static float BRFloatGetter(id obj, SEL sel, float fallback)
{
    if (![obj respondsToSelector:sel]) return fallback;
    float v = ((float (*)(id, SEL))objc_msgSend)(obj, sel);
    return (v > 0 && v < 1000) ? v : fallback;
}

// language codes of a collection the engine returned (strings, or objects / dictionaries with a language)
static NSArray *BRLanguageCodes(id value)
{
    NSMutableArray *out = [NSMutableArray array];
    id list = value;
    if ([value isKindOfClass:[NSSet class]]) list = [value allObjects];
    else if ([value isKindOfClass:[NSOrderedSet class]]) list = [value array];
    else if ([value isKindOfClass:[NSDictionary class]]) list = [value allKeys];
    if (![list isKindOfClass:[NSArray class]]) return out;
    for (id item in list) {
        NSString *code = nil;
        if ([item isKindOfClass:[NSString class]]) code = item;
        else if ([item isKindOfClass:[NSDictionary class]]) code = item[@"language"] ?: item[@"languageCode"];
        else if ([item respondsToSelector:NSSelectorFromString(@"languageCode")]) code = ((id (*)(id, SEL))objc_msgSend)(item, NSSelectorFromString(@"languageCode"));
        if ([code isKindOfClass:[NSString class]] && code.length && ![out containsObject:code]) [out addObject:code];
    }
    return out;
}

// speech thread
- (void)loadEngine
{
    if (_loaded) return;
    _loaded = YES;
    NSMutableArray *voices = [NSMutableArray array];
    BRLog(@"speech: loading VoiceServices");
    if (dlopen(BRVoiceServicesPath.fileSystemRepresentation, RTLD_LAZY)) {
        Class cls = NSClassFromString(@"VSSpeechSynthesizer");
        if (cls && [cls instancesRespondToSelector:NSSelectorFromString(@"startSpeakingString:withLanguageCode:")]) {
            SEL langs = NSSelectorFromString(@"availableLanguageCodes");
            id codes = [cls respondsToSelector:langs] ? ((id (*)(id, SEL))objc_msgSend)(cls, langs) : nil;
            _languages = BRLanguageCodes(codes);
            BRLog(@"speech: availableLanguageCodes -> %@ (%lu)", NSStringFromClass([codes class]), (unsigned long)_languages.count);
            @synchronized (self) { _synthClass = cls; }
        }
    }
    // the installed voices are folders of the framework (one per language), whatever the engine reports
    if (!_languages.count) {
        NSMutableArray *dirs = [NSMutableArray array];
        for (NSString *name in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:BRVoiceResourcesPath error:NULL] ?: @[]) {
            if ([name rangeOfString:@"-"].location != NSNotFound && [name rangeOfString:@"."].location == NSNotFound) [dirs addObject:name];
        }
        _languages = [dirs sortedArrayUsingSelector:@selector(compare:)];
    }
    if (!_synthClass) BRLog(@"speech: VoiceServices is not available");
    NSArray *preferred = [NSLocale preferredLanguages];
    NSString *systemLang = preferred.count ? preferred[0] : @"en";
    NSLocale *display = [NSLocale currentLocale];
    BOOL defaultTaken = NO;
    for (NSString *code in _languages) {
        NSString *tag = [code stringByReplacingOccurrencesOfString:@"_" withString:@"-"];
        NSString *name = [display displayNameForKey:NSLocaleIdentifier value:[tag stringByReplacingOccurrencesOfString:@"-" withString:@"_"]] ?: tag;
        BOOL isDefault = !defaultTaken && [[tag lowercaseString] hasPrefix:[[systemLang substringToIndex:MIN((NSUInteger)2, systemLang.length)] lowercaseString]];
        if (isDefault) defaultTaken = YES;
        [voices addObject:@{ @"lang": tag, @"name": name, @"default": @(isDefault) }];
    }
    NSDictionary *info = @{ @"available": @(_synthClass != nil), @"voices": voices, @"rate": @(_defaultRate), @"pitch": @(_defaultPitch), @"volume": @(_defaultVolume) };
    NSData *json = [NSJSONSerialization dataWithJSONObject:info options:0 error:NULL];
    @synchronized (self) { _info = json; }
    BRLog(@"speech: %lu voices", (unsigned long)voices.count);
}

- (NSData *)infoJSON
{
    @synchronized (self) {
        if (_info) return _info;
    }
    return [@"{\"available\":false,\"loading\":true,\"voices\":[]}" dataUsingEncoding:NSUTF8StringEncoding];
}

#pragma mark - Events

- (void)addEvent:(NSString *)type utterance:(NSString *)uid charIndex:(NSInteger)charIndex elapsed:(NSTimeInterval)elapsed
{
    if (!uid) return;
    @synchronized (self) {
        _seq++;
        [_events addObject:@{ @"seq": @(_seq), @"id": uid, @"type": type, @"char": @(charIndex), @"elapsed": @(round(elapsed * 1000) / 1000) }];
        while (_events.count > BRMaxSpeechEvents) [_events removeObjectAtIndex:0];
    }
}

- (NSData *)eventsJSONSince:(NSInteger)since
{
    NSMutableArray *out = [NSMutableArray array];
    @synchronized (self) {
        for (NSDictionary *e in _events) if ([e[@"seq"] integerValue] > since) [out addObject:e];
    }
    return [NSJSONSerialization dataWithJSONObject:out options:0 error:NULL] ?: [@"[]" dataUsingEncoding:NSUTF8StringEncoding];
}

static NSValue *BRKey(id synth) { return [NSValue valueWithNonretainedObject:synth]; }

- (NSString *)idOf:(id)synth { @synchronized (self) { return _ids[BRKey(synth)]; } }
- (NSTimeInterval)elapsedOf:(id)synth { NSNumber *t; @synchronized (self) { t = _starts[BRKey(synth)]; } return t ? [NSDate timeIntervalSinceReferenceDate] - t.doubleValue : 0; }

- (void)forget:(id)synth
{
    if (!synth) return;
    @synchronized (self) {
        [_ids removeObjectForKey:BRKey(synth)];
        [_starts removeObjectForKey:BRKey(synth)];
        [_live removeObject:synth];
        if (synth == _current) _current = nil;
    }
}

#pragma mark - Speaking (requests arrive on the network threads and are carried out on the speech thread)

// "cs" -> "cs-CZ" among the installed voices; nil when none fits (the engine then speaks the system language)
- (NSString *)languageCodeFor:(NSString *)lang
{
    if (!lang.length) return nil;
    NSString *want = [[lang stringByReplacingOccurrencesOfString:@"_" withString:@"-"] lowercaseString];
    NSString *primary = [want componentsSeparatedByString:@"-"][0], *prefixMatch = nil;
    for (NSString *code in _languages) {
        NSString *c = [[code stringByReplacingOccurrencesOfString:@"_" withString:@"-"] lowercaseString];
        if ([c isEqualToString:want]) return code;
        if (!prefixMatch && [c hasPrefix:[primary stringByAppendingString:@"-"]]) prefixMatch = code;
    }
    return prefixMatch;
}

- (void)speak:(NSString *)text utteranceId:(NSString *)uid lang:(NSString *)lang rate:(float)rate pitch:(float)pitch volume:(float)volume
{
    [self perform:^{
        [self loadEngine];
        if (!self->_synthClass || !uid.length) { [self addEvent:@"error" utterance:uid charIndex:0 elapsed:0]; return; }
        if (self->_current) [self stopSynth:self->_current];
        id synth = [[self->_synthClass alloc] init];
        if (!synth) { [self addEvent:@"error" utterance:uid charIndex:0 elapsed:0]; return; }
        ((void (*)(id, SEL, id))objc_msgSend)(synth, NSSelectorFromString(@"setDelegate:"), self);
        // the Web Speech API scales are relative to normal speech: the engine's own defaults are "normal"
        float r = MAX(0.1f, MIN(10.0f, rate > 0 ? rate : 1));
        float p = MAX(0.0f, MIN(2.0f, pitch >= 0 ? pitch : 1));
        float v = MAX(0.0f, MIN(1.0f, volume >= 0 ? volume : 1));
        SEL setRate = NSSelectorFromString(@"setRate:"), setPitch = NSSelectorFromString(@"setPitch:"), setVolume = NSSelectorFromString(@"setVolume:");
        if (r != 1 && [synth respondsToSelector:setRate]) {
            float base = BRFloatGetter(synth, NSSelectorFromString(@"rate"), 1);
            ((void (*)(id, SEL, float))objc_msgSend)(synth, setRate, base * r);
        }
        if (p != 1 && [synth respondsToSelector:setPitch]) {
            float base = BRFloatGetter(synth, NSSelectorFromString(@"pitch"), 1);
            ((void (*)(id, SEL, float))objc_msgSend)(synth, setPitch, MAX(0.05f, base * p));
        }
        if (v != 1 && [synth respondsToSelector:setVolume]) ((void (*)(id, SEL, float))objc_msgSend)(synth, setVolume, v);
        @synchronized (self) {
            self->_ids[BRKey(synth)] = uid;
            self->_starts[BRKey(synth)] = @([NSDate timeIntervalSinceReferenceDate]);
            [self->_live addObject:synth];
            self->_current = synth;
        }
        NSString *code = [self languageCodeFor:lang];
        [self addEvent:@"start" utterance:uid charIndex:0 elapsed:0];
        if (!text.length) { [self addEvent:@"end" utterance:uid charIndex:0 elapsed:0]; [self forget:synth]; return; }
        BRLog(@"speech: speaking %lu chars (%@)", (unsigned long)text.length, code ?: @"system language");
        ((void (*)(id, SEL, id, id))objc_msgSend)(synth, NSSelectorFromString(@"startSpeakingString:withLanguageCode:"), text, code);
        BRLog(@"speech: started");
    }];
}

- (void)stopSynth:(id)synth
{
    SEL stop = NSSelectorFromString(@"stopSpeakingAtNextBoundary:");
    if ([synth respondsToSelector:stop]) ((void (*)(id, SEL, int))objc_msgSend)(synth, stop, 0);
    // the utterance ends now for the page (the engine's own callback follows and is then ignored)
    NSString *uid = [self idOf:synth];
    if (uid) [self addEvent:@"end" utterance:uid charIndex:0 elapsed:[self elapsedOf:synth]];
    @synchronized (self) {
        [_ids removeObjectForKey:BRKey(synth)];
        if (synth == _current) _current = nil;
    }
}

- (void)cancel
{
    [self perform:^{ if (self->_current) [self stopSynth:self->_current]; }];
}

- (void)pause
{
    [self perform:^{
        id synth = self->_current;
        SEL sel = NSSelectorFromString(@"pauseSpeakingAtNextBoundary:");
        if (!synth || ![synth respondsToSelector:sel]) return;
        ((void (*)(id, SEL, int))objc_msgSend)(synth, sel, 1);   // at the next word
        [self addEvent:@"pause" utterance:[self idOf:synth] charIndex:0 elapsed:[self elapsedOf:synth]];
    }];
}

- (void)resume
{
    [self perform:^{
        id synth = self->_current;
        SEL sel = NSSelectorFromString(@"continueSpeaking");
        if (!synth || ![synth respondsToSelector:sel]) return;
        ((void (*)(id, SEL))objc_msgSend)(synth, sel);
        [self addEvent:@"resume" utterance:[self idOf:synth] charIndex:0 elapsed:[self elapsedOf:synth]];
    }];
}

#pragma mark - VSSpeechSynthesizer delegate (any thread)

- (void)speechSynthesizer:(id)synth willSpeakRangeOfSpeechString:(NSRange)range
{
    [self addEvent:@"boundary" utterance:[self idOf:synth] charIndex:(NSInteger)range.location elapsed:[self elapsedOf:synth]];
}

- (void)speechSynthesizer:(id)synth didFinishSpeaking:(BOOL)finished withError:(id)error
{
    NSString *uid = [self idOf:synth];
    if (uid) [self addEvent:(error ? @"error" : @"end") utterance:uid charIndex:0 elapsed:[self elapsedOf:synth]];
    [self forget:synth];
}

- (void)speechSynthesizer:(id)synth didFinishSpeaking:(BOOL)finished phonemesSpoken:(id)phonemes withError:(id)error
{
    [self speechSynthesizer:synth didFinishSpeaking:finished withError:error];
}

@end
