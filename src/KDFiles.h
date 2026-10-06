#import <Foundation/Foundation.h>

// The files of the app's Documents folder (shared through iTunes, UIFileSharingEnabled) for the workbench: the page asks
// https://kodium.invalid/__kd/fs/<operation>?path=<path inside Documents> (web/src/files.ts, a VS Code file system
// provider for file:///Documents). Operations: stat and list (JSON), read (the bytes), write (the request's body; create=1,
// overwrite=1), mkdir, delete (recursive=1), rename (path, to, overwrite=1). Errors are statuses the page maps to VS Code's:
// 404 not found, 409 exists, 403 not allowed, 400 anything else. One operation at a time, off the loading thread.
// root=userdata is VS Code's user data instead (vscode-userdata:/User/settings.json and the like), in
// Library/Application Support/Kodium/userdata: out of the user's files, and out of Caches, which iOS may empty.
typedef void (^KDFilesCompletion)(NSInteger status, NSData *body, NSString *contentType);

@interface KDFiles : NSObject

+ (NSString *)rootDirectory;   // Documents of the app's home
+ (NSString *)rootDirectoryNamed:(NSString *)name;   // "userdata", or Documents for anything else
+ (void)performOperation:(NSString *)operation request:(NSURLRequest *)request completion:(KDFilesCompletion)completion;

@end
