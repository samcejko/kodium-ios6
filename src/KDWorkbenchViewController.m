#import "KDWorkbenchViewController.h"
#import "KDSiteProtocol.h"
#import "KDFiles.h"
#import "KDKeyBar.h"
#import "BRCSSRewriter.h"
#import "BRURLProtocol.h"
#import "BRCommon.h"

// what follows "<scheme>:" in a request of the page shim, percent-decoded
static NSString *KDShimArgument(NSURL *url)
{
    NSString *s = url.absoluteString ?: @"";
    NSUInteger skip = MIN(s.length, url.scheme.length + 1);
    NSString *raw = [s substringFromIndex:skip];
    return [raw stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding] ?: raw;
}

@interface KDWorkbenchViewController ()
@property (nonatomic, strong) UIWebView *webView;
@property (nonatomic, strong) UILabel *messageLabel;
@property (nonatomic) CGFloat keyboardHeight;   // how much of the view the on-screen keyboard covers
@property (nonatomic, strong) NSMutableArray *receivedFiles;   // paths in Documents the workbench is still to open
@property (nonatomic, strong) NSTimer *receiveTimer;
@property (nonatomic) NSInteger receiveAttempts;
@property (nonatomic, strong) UIDocumentInteractionController *sharing;   // (alive while the system sends the file)
@end

@implementation KDWorkbenchViewController

- (void)loadView
{
    UIColor *ground = [UIColor colorWithRed:0.12 green:0.12 blue:0.12 alpha:1];
    UIView *root = [[UIView alloc] initWithFrame:[[UIScreen mainScreen] applicationFrame]];
    root.backgroundColor = ground;
    root.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;

    UIWebView *web = [[UIWebView alloc] initWithFrame:root.bounds];
    web.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    web.delegate = self;
    web.scalesPageToFit = NO;                         // the workbench is laid out for the view, 1:1
    web.dataDetectorTypes = UIDataDetectorTypeNone;
    web.keyboardDisplayRequiresUserAction = YES;      // the keyboard comes with a tap into the editor, not at start
    web.backgroundColor = ground;
    web.opaque = YES;
    web.scrollView.scrollEnabled = NO;                // the workbench scrolls its own parts
    web.scrollView.bounces = NO;
    [root addSubview:web];
    self.webView = web;

    // (shown only when the workbench cannot load)
    UILabel *label = [[UILabel alloc] initWithFrame:CGRectInset(root.bounds, 40, 40)];
    label.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    label.backgroundColor = [UIColor clearColor];
    label.textColor = [UIColor colorWithWhite:0.8 alpha:1];
    label.font = [UIFont systemFontOfSize:17];
    label.textAlignment = NSTextAlignmentCenter;
    label.numberOfLines = 0;
    label.hidden = YES;
    [root addSubview:label];
    self.messageLabel = label;
    self.view = root;
}

- (void)viewDidLoad
{
    [super viewDidLoad];
    [self noteSize];
    NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
    [nc addObserver:self selector:@selector(keyboardWillChange:) name:UIKeyboardWillShowNotification object:nil];
    [nc addObserver:self selector:@selector(keyboardWillChange:) name:UIKeyboardWillHideNotification object:nil];
    // (WebKit scrolls to the caret once the keyboard is up, before the workbench has laid itself out again)
    [nc addObserver:self selector:@selector(layoutWebView) name:UIKeyboardDidShowNotification object:nil];
    [nc addObserver:self selector:@selector(shareRequested:) name:KDShareFileNotification object:nil];
    // the row of keys above the keyboard: its keys go to the workbench (web/src/keybar.ts)
    __weak KDWorkbenchViewController *weakSelf = self;
    [KDKeyBar installWithHandler:^(NSString *key) { [weakSelf sendKey:key]; }];
    [self.webView loadRequest:[NSURLRequest requestWithURL:[KDSiteProtocol startURL]]];
}

- (void)dealloc
{
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)viewDidLayoutSubviews
{
    [super viewDidLayoutSubviews];
    [self layoutWebView];
    [self noteSize];
}

// The on-screen keyboard: the web view ends above it, and the workbench lays itself out in what is left (the editor
// keeps its cursor in view) - instead of WebKit pushing the whole page up under the status bar to show the caret.
// (A split or undocked keyboard of the iPad does not reach the bottom: it covers nothing that way.)
- (void)keyboardWillChange:(NSNotification *)note
{
    CGFloat covered = 0;
    if ([note.name isEqualToString:UIKeyboardWillShowNotification]) {
        CGRect bounds = self.view.bounds;
        CGRect kb = [self.view convertRect:[note.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue] fromView:nil];
        if (CGRectGetMaxY(kb) >= CGRectGetMaxY(bounds) - 1) covered = MAX(0, CGRectGetMaxY(bounds) - CGRectGetMinY(kb));
    }
    if (covered == self.keyboardHeight) return;
    self.keyboardHeight = covered;
    [self layoutWebView];
}

- (void)layoutWebView
{
    CGRect frame = self.view.bounds;
    frame.size.height = MAX(100, frame.size.height - self.keyboardHeight);
    if (!CGRectEqualToRect(self.webView.frame, frame)) self.webView.frame = frame;
    self.webView.scrollView.contentOffset = CGPointZero;
}

// viewport units in the rewritten stylesheets become pixels of the view (the whole view: not less while the keyboard
// is up)
- (void)noteSize
{
    CGRect b = self.view.bounds;
    [BRCSSRewriter noteWebViewSize:b.size landscape:b.size.width > b.size.height];
}

- (NSString *)evaluateJavaScript:(NSString *)code
{
    return [self.webView stringByEvaluatingJavaScriptFromString:code ?: @""] ?: @"";
}

- (void)showKeyboard
{
    self.webView.keyboardDisplayRequiresUserAction = NO;
    // (the editor keeps its text area focused without a keyboard: focusing it again does nothing, it is left first)
    [self evaluateJavaScript:@"(function () { var t = document.querySelector('.editor-instance .monaco-editor textarea');"
                              " if (!t) return; t.blur(); setTimeout(function () { t.focus(); }, 100); })()"];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        self.webView.keyboardDisplayRequiresUserAction = YES;
    });
}

- (void)sendKey:(NSString *)key
{
    NSData *json = [NSJSONSerialization dataWithJSONObject:@[key ?: @""] options:0 error:NULL];
    NSString *arg = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : nil;
    if (arg) [self evaluateJavaScript:[NSString stringWithFormat:@"window.__kd_key && window.__kd_key(%@[0])", arg]];
}

#pragma mark - Files in and out

- (void)openReceivedFile:(NSString *)path
{
    if (!path.length) return;
    if (!self.receivedFiles) self.receivedFiles = [NSMutableArray array];
    [self.receivedFiles addObject:path];
    self.receiveAttempts = 0;
    [self deliverReceivedFiles];
}

// The workbench answers "ok" once it can open files (web/src/share.ts): until then the files wait, asked again every
// second for two minutes (the start takes about twenty seconds).
- (void)deliverReceivedFiles
{
    [self.receiveTimer invalidate];
    self.receiveTimer = nil;
    while (self.receivedFiles.count) {
        NSData *json = [NSJSONSerialization dataWithJSONObject:@[self.receivedFiles[0]] options:0 error:NULL];
        NSString *arg = json ? [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] : nil;
        if (!arg) { [self.receivedFiles removeObjectAtIndex:0]; continue; }
        NSString *answer = [self evaluateJavaScript:[NSString stringWithFormat:@"window.__kd_receive ? window.__kd_receive(%@[0]) : ''", arg]];
        if (![answer isEqualToString:@"ok"]) break;
        [self.receivedFiles removeObjectAtIndex:0];
    }
    if (self.receivedFiles.count && self.receiveAttempts++ < 120) {
        self.receiveTimer = [NSTimer scheduledTimerWithTimeInterval:1 target:self selector:@selector(deliverReceivedFiles) userInfo:nil repeats:NO];
    }
}

// Share... of the workbench (KDShareFileNotification): the system's menu for a file of Documents - Open In..., Mail,
// Print, Copy - pointing at what the page asked from (the explorer's row, the tab), else at the top of the view
- (void)shareRequested:(NSNotification *)note
{
    NSDictionary *q = note.userInfo;
    NSString *file = [KDFiles filePathFor:q[@"path"] ?: @"" root:[KDFiles rootDirectory]];
    BOOL directory = NO;
    if (!file || ![[NSFileManager defaultManager] fileExistsAtPath:file isDirectory:&directory] || directory) return;
    CGRect rect = CGRectMake([q[@"x"] floatValue], [q[@"y"] floatValue], [q[@"w"] floatValue], [q[@"h"] floatValue]);
    CGRect anchor = (rect.size.width > 0 && rect.size.height > 0) ? [self.view convertRect:rect fromView:self.webView]
                                                                  : CGRectMake(CGRectGetMidX(self.view.bounds) - 1, 30, 2, 2);
    UIDocumentInteractionController *menu = [UIDocumentInteractionController interactionControllerWithURL:[NSURL fileURLWithPath:file]];
    menu.delegate = self;
    self.sharing = menu;
    if (![menu presentOptionsMenuFromRect:anchor inView:self.view animated:YES]) {
        self.sharing = nil;
        [[[UIAlertView alloc] initWithTitle:nil message:L(@"No app can take this file.") delegate:nil
                          cancelButtonTitle:L(@"OK") otherButtonTitles:nil] show];
    }
}

- (UIViewController *)documentInteractionControllerViewControllerForPreview:(UIDocumentInteractionController *)controller
{
    return self;
}

- (UIInterfaceOrientationMask)supportedInterfaceOrientations
{
    return BRIsPad() ? UIInterfaceOrientationMaskAll : UIInterfaceOrientationMaskAllButUpsideDown;
}

- (BOOL)shouldAutorotate
{
    return YES;
}

#pragma mark - UIWebViewDelegate

- (BOOL)webView:(UIWebView *)webView shouldStartLoadWithRequest:(NSURLRequest *)request navigationType:(UIWebViewNavigationType)navigationType
{
    NSURL *url = request.URL;
    NSString *scheme = [url.scheme lowercaseString];
    // The page shim's requests to the app (addresses of hidden frames, see shims-extra.js sendToApp). The workbench is
    // the app's own page, so they need no tap of the user's first, as they do in Surfari.
    if ([scheme isEqualToString:@"brlog"]) {
        BRLog(@"Page: %@", KDShimArgument(url));
        return NO;
    }
    if ([scheme isEqualToString:@"brcopy"]) {
        NSString *text = KDShimArgument(url);
        if (text.length) [UIPasteboard generalPasteboard].string = text;
        return NO;
    }
    if ([scheme isEqualToString:@"brevict"]) {
        [BRURLProtocol evictCachedScript:KDShimArgument(url)];
        return NO;
    }
    if ([scheme isEqualToString:@"brtab"]) {
        // window.open, a link with target=_blank: web pages open outside (Surfari when it is there, else Safari)
        [self openOutside:[NSURL URLWithString:KDShimArgument(url)]];
        return NO;
    }
    if ([scheme hasPrefix:@"br"]) return NO;   // (the browser's own: share, print, saved logins)
    // Frames of extensions and previews load in the page; the page itself stays the workbench: a link the user followed
    // to the web opens outside, and a page in a frame that would take the whole view (top.location = ...) is stopped.
    BOOL wholeView = [request.mainDocumentURL isEqual:url];
    if ([scheme isEqualToString:@"about"] || [scheme isEqualToString:@"data"] || [scheme isEqualToString:@"blob"]) return !wholeView;
    if ([[url.host lowercaseString] isEqualToString:[KDSiteProtocol startURL].host]) return YES;
    if (wholeView) {
        if (navigationType == UIWebViewNavigationTypeLinkClicked) [self openOutside:url];
        return NO;
    }
    return YES;
}

- (void)openOutside:(NSURL *)target
{
    NSString *scheme = [target.scheme lowercaseString];
    if (!([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) || !target.host.length) return;
    NSURL *surfari = [NSURL URLWithString:[@"surfari:" stringByAppendingString:target.absoluteString]];
    UIApplication *app = [UIApplication sharedApplication];
    if (surfari && [app canOpenURL:surfari]) [app openURL:surfari];
    else [app openURL:target];
}

- (void)webView:(UIWebView *)webView didFailLoadWithError:(NSError *)error
{
    if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled) return;
    // (only the workbench page itself: a frame of an extension that fails is the extension's business)
    NSString *failed = error.userInfo[NSURLErrorFailingURLStringErrorKey];
    if (failed && ![failed isEqualToString:[KDSiteProtocol startURL].absoluteString]) return;
    BRLog(@"The workbench did not load: %@", error);
    self.messageLabel.text = [NSString stringWithFormat:@"%@\n\n%@", L(@"The editor could not be loaded."), error.localizedDescription ?: @""];
    self.messageLabel.hidden = NO;
}

@end
