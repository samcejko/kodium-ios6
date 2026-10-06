#import <Foundation/Foundation.h>

// WebP images (not supported by iOS 6) are decoded with libwebp and re-encoded as PNG before WebKit sees them.
@interface BRImageConverter : NSObject

+ (BOOL)looksLikeWebP:(NSData *)data;
+ (NSData *)pngDataFromWebP:(NSData *)data;    // nil when the data is not WebP or cannot be decoded
// JPEG for opaque stills, PNG otherwise; *mimeType tells which (nil result: not WebP or undecodable)
+ (NSData *)imageDataFromWebP:(NSData *)data mimeType:(NSString **)mimeType;
// a JPEG or opaque PNG far bigger than the screen, as a JPEG of 1600 px on its long side; nil when it stays as it is
+ (NSData *)downscaledImageData:(NSData *)data mimeType:(NSString **)mimeType;

@end
