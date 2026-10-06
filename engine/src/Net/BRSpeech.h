#import <Foundation/Foundation.h>

// Speech synthesis for the page's speechSynthesis API (and the read-aloud feature), on the system's own voices: the
// private VoiceServices framework (VSSpeechSynthesizer, what VoiceOver speaks with on iOS 6), loaded at run time.
// The page shim talks to it through https://ios6-browser.invalid/speech/... (see BRURLProtocol): it speaks one
// utterance at a time and polls for the start / word boundary / end events. Thread safe.
@interface BRSpeech : NSObject

+ (instancetype)shared;

@property (nonatomic, readonly) BOOL available;

// JSON: {"available": bool, "voices": [{"lang", "name", "default"}], "rate", "pitch", "volume"} (the engine's defaults)
- (NSData *)infoJSON;

// Starts speaking `text` (stopping whatever was being spoken). rate/pitch/volume follow the Web Speech API scales
// (1 = normal for rate and pitch, 0..1 for volume); lang is a BCP 47 tag or nil for the system language.
- (void)speak:(NSString *)text utteranceId:(NSString *)uid lang:(NSString *)lang rate:(float)rate pitch:(float)pitch volume:(float)volume;
- (void)cancel;
- (void)pause;
- (void)resume;

// JSON array of the events after `since`: [{"seq", "id", "type": "start"|"boundary"|"end"|"error"|"pause"|"resume", "char", "elapsed"}]
- (NSData *)eventsJSONSince:(NSInteger)since;

@end
