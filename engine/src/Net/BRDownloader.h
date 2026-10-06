#import <Foundation/Foundation.h>

extern NSString * const BRDownloadsDidChangeNotification;

typedef void (^BRDownloadCompletion)(NSString *path, NSError *error);

// Saves files WebKit cannot display (archives, packages, documents for other apps) into
// Documents/Downloads through the app's own HTTP stack.
@interface BRDownloader : NSObject

+ (instancetype)shared;

- (void)downloadURL:(NSURL *)url completion:(BRDownloadCompletion)completion;
- (BOOL)isDownloading:(NSURL *)url;

+ (NSString *)downloadsDirectory;
+ (NSArray *)downloadedFiles;            // dictionaries: name, path, size (NSNumber), date (NSDate); newest first
+ (BOOL)removeDownloadAtPath:(NSString *)path;
+ (NSString *)formattedSize:(long long)bytes;

@end
