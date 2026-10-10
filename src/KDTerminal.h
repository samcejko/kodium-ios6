#import <Foundation/Foundation.h>

// The terminal panel's shells (web/src/terminal.ts). iOS's sandbox lets Kodium - an app of /var/mobile/Applications -
// start no process: the package Kodium Shell (shell/) has launchd start kodium-shelld for each connection to
// 127.0.0.1:47070, which runs a login shell on a pseudo terminal. A session here is such a connection. The page asks
// https://kodium.invalid/__kd/term/<operation>:
//   open?cols=&rows=&cwd=<a path of the workbench, "/Documents/...">   {"id": n}; 503 when the package is not installed
//   read?id=     the shell's output since the last read (bytes); waits up to 20 s for some: 204 when none came,
//                410 once the shell ended and all was read
//   write?id=    the request's body to the shell; resize?id=&cols=&rows=; close?id=
// The token the daemon wants is new at every start of the app, in Library/Kodium/shell.token (prepareToken).
typedef void (^KDTerminalCompletion)(NSInteger status, NSData *body, NSString *contentType);

@interface KDTerminal : NSObject

+ (void)prepareToken;
+ (void)performOperation:(NSString *)operation request:(NSURLRequest *)request completion:(KDTerminalCompletion)completion;

@end
