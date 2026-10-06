#import <UIKit/UIKit.h>

// The whole screen below the status bar: one web view with the VS Code workbench (KDSiteProtocol's site). It answers the
// page shim's requests to the app (the clipboard, links to open, the log) and keeps the engine told of the view's size.
@interface KDWorkbenchViewController : UIViewController <UIWebViewDelegate>

- (NSString *)evaluateJavaScript:(NSString *)code;   // in the workbench page (developer commands)

@end
