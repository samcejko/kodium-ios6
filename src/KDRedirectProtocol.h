#import <Foundation/Foundation.h>

// Open VSX answers its asset addresses (https://open-vsx.org/vscode/asset/..., /api/<extension>/file/...: an
// extension's readme, changelog, icon, manifest) with a redirect to its content host, openvsx.eclipsecontent.org - and
// the iOS 6 engine refuses a cross-origin request that is redirected (CORS redirects came with a later WebKit): the
// extension's page failed with "Network request failed", the gallery showed no icons. These requests are made here
// instead, the redirects followed, and the page gets the final answer as the answer to what it asked. (The extensions'
// code comes from /vscode/unpkg/ without a redirect: that stays with the engine, which lowers it to ES5.)
@interface KDRedirectProtocol : NSURLProtocol

+ (void)registerProtocol;

@end
