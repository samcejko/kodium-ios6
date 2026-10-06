#import <UIKit/UIKit.h>

// The whole screen below the status bar: one web view with the VS Code workbench (KDSiteProtocol's site). It answers the
// page shim's requests to the app (the clipboard, links to open, the log) and keeps the engine told of the view's size.
@interface KDWorkbenchViewController : UIViewController <UIWebViewDelegate, UIDocumentInteractionControllerDelegate>

- (NSString *)evaluateJavaScript:(NSString *)code;   // in the workbench page (developer commands)
// A file another app gave Kodium ("Open in Kodium"), already in Documents ("/name.ext"): the workbench opens it once it
// is up (the app may have been started for it).
- (void)openReceivedFile:(NSString *)path;
// The on-screen keyboard over the editor without a tap (developer commands: the key bar, typing tests)
- (void)showKeyboard;

@end
