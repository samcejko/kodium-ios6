#import <Foundation/Foundation.h>

// The app's own site - the VS Code workbench built into Resources/site - at https://kodium.invalid/ (a host that never
// resolves). Documents and stylesheets go through Surfari's rewriters like any page (the polyfills, modern CSS for the
// iOS 6 engine; a rewritten stylesheet is kept in Caches/kodium-site until the app or the rewriter changes). Scripts are
// served as they are: they were lowered to ES5 when the app was built (web/tools/lower.mjs). /__kd/fs/ is the app's
// Documents folder (KDFiles). What the engine answers on a page's own host (/__br_polyfills-<crc>.js,
// /__br_inline-<name>.js) stays with BRURLProtocol. https://preview.kodium.invalid/ is the Documents as a web site of
// its own, for the preview of a page. /__kd/app/share?path=<path in Documents>&x=&y=&w=&h= asks the app to share a file
// (KDShareFileNotification on the main thread, with the query as userInfo). /__kd/app/idle tells that the workbench has
// had no input for a while (BRJSEngine collectPageGarbageIfOver:).
extern NSString * const KDShareFileNotification;

@interface KDSiteProtocol : NSURLProtocol

+ (void)registerProtocol;
+ (NSURL *)startURL;   // the workbench page

@end
