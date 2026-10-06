#import <Foundation/Foundation.h>

// The app's own site - the VS Code workbench built into Resources/site - at https://kodium.invalid/ (a host that never
// resolves). Documents and stylesheets go through Surfari's rewriters like any page (the polyfills, modern CSS for the
// iOS 6 engine; a rewritten stylesheet is kept in Caches/kodium-site until the app or the rewriter changes). Scripts are
// served as they are: they were lowered to ES5 when the app was built (web/tools/lower.mjs). /__kd/fs/ is the app's
// Documents folder (KDFiles). What the engine answers on a page's own host (/__br_polyfills-<crc>.js,
// /__br_inline-<name>.js) stays with BRURLProtocol.
@interface KDSiteProtocol : NSURLProtocol

+ (void)registerProtocol;
+ (NSURL *)startURL;   // the workbench page

@end
