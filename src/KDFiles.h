#import <Foundation/Foundation.h>

// The files of the app's Documents folder (shared through iTunes, UIFileSharingEnabled) for the workbench: the page asks
// https://kodium.invalid/__kd/fs/<operation>?path=<path inside Documents> (web/src/files.ts, a VS Code file system
// provider for file:///Documents). Operations: stat and list (JSON), read (the bytes), write (the request's body; create=1,
// overwrite=1), mkdir, delete (recursive=1), rename (path, to, overwrite=1). Errors are statuses the page maps to VS Code's:
// 404 not found, 409 exists, 403 not allowed, 400 anything else. One operation at a time, off the loading thread.
typedef void (^KDFilesCompletion)(NSInteger status, NSData *body, NSString *contentType);

@interface KDFiles : NSObject

+ (NSString *)rootDirectory;   // Documents of the app's home
+ (void)performOperation:(NSString *)operation request:(NSURLRequest *)request completion:(KDFilesCompletion)completion;

@end
