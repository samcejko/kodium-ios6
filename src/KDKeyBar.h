#import <UIKit/UIKit.h>

// The row of keys above the on-screen keyboard while the workbench is typed in: what writing code needs and the iPad's
// keyboard has on its second and third pages or not at all - Tab, the arrows, brackets and the like, undo and redo.
// It takes the place of WebKit's own bar there (Previous, Next, Done: for the fields of a form), and looks like the
// keyboard's keys. A key gives its name to onKey ("tab", "left", "{", ...): KDWorkbenchViewController hands it to the
// workbench (web/src/keybar.ts).
@interface KDKeyBar : UIView

@property (nonatomic, copy) void (^onKey)(NSString *key);

// The bar in place of WebKit's for every web view of the app (once, at the start)
+ (void)installWithHandler:(void (^)(NSString *key))handler;

@end
