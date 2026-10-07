#import "KDKeyBar.h"
#import "BRCommon.h"
#import <objc/runtime.h>
#import <QuartzCore/QuartzCore.h>

static const CGFloat KDBarHeight = 52, KDKeyHeight = 40, KDKeyWidth = 46, KDGap = 6;

static KDKeyBar *KDSharedBar;
static IMP KDWebAccessory;   // WebKit's own inputAccessoryView, for when there is no bar

static UIView *KDInputAccessoryView(id self, SEL _cmd)
{
    if (KDSharedBar) return KDSharedBar;
    return KDWebAccessory ? ((UIView *(*)(id, SEL))KDWebAccessory)(self, _cmd) : nil;
}

// A key cap of the iOS 6 keyboard: white to light grey, rounded, a dark edge below (pressed: grey)
static UIImage *KDKeyImage(BOOL pressed)
{
    CGFloat w = 13, h = KDKeyHeight;
    UIGraphicsBeginImageContextWithOptions(CGSizeMake(w, h), NO, 0);
    CGContextRef ctx = UIGraphicsGetCurrentContext();
    UIBezierPath *edge = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0, 1, w, h - 1) cornerRadius:5];
    [[UIColor colorWithWhite:0.36 alpha:0.9] setFill];
    [edge fill];
    UIBezierPath *cap = [UIBezierPath bezierPathWithRoundedRect:CGRectMake(0, 0, w, h - 1) cornerRadius:5];
    CGContextSaveGState(ctx);
    [cap addClip];
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGFloat top = pressed ? 0.70 : 1.0, bottom = pressed ? 0.60 : 0.87;
    CGFloat comps[] = { top, top, top, 1, bottom, bottom, bottom + 0.02, 1 };
    CGGradientRef gradient = CGGradientCreateWithColorComponents(space, comps, NULL, 2);
    CGContextDrawLinearGradient(ctx, gradient, CGPointZero, CGPointMake(0, h), 0);
    CGGradientRelease(gradient);
    CGColorSpaceRelease(space);
    CGContextRestoreGState(ctx);
    UIImage *image = UIGraphicsGetImageFromCurrentImageContext();
    UIGraphicsEndImageContext();
    return [image resizableImageWithCapInsets:UIEdgeInsetsMake(8, 6, 8, 6)];
}

@interface KDKeyBar ()
@property (nonatomic, strong) UIScrollView *row;
@property (nonatomic, strong) NSTimer *repeat;
@property (nonatomic, copy) NSString *held;
@property (nonatomic) BOOL repeated;
@end

@implementation KDKeyBar

+ (void)installWithHandler:(void (^)(NSString *key))handler
{
    if (KDSharedBar) { KDSharedBar.onKey = handler; return; }
    Class browser = NSClassFromString(@"UIWebBrowserView");
    SEL sel = @selector(inputAccessoryView);
    Method m = browser ? class_getInstanceMethod(browser, sel) : NULL;
    if (!m) { BRLog(@"Key bar: no UIWebBrowserView inputAccessoryView, not installed"); return; }
    KDSharedBar = [[KDKeyBar alloc] initWithFrame:CGRectMake(0, 0, 768, KDBarHeight)];
    KDSharedBar.onKey = handler;
    // (the class's own method replaced, or one of its own added where it inherits it: never the superclass's)
    IMP previous = method_getImplementation(m);
    if (class_addMethod(browser, sel, (IMP)KDInputAccessoryView, method_getTypeEncoding(m))) KDWebAccessory = previous;
    else KDWebAccessory = method_setImplementation(class_getInstanceMethod(browser, sel), (IMP)KDInputAccessoryView);
}

// name, what the key shows (nil: the name itself)
+ (NSArray *)keys
{
    // (suggest: the editor's suggestions and snippets where the caret is, as Ctrl+Space - the on-screen keyboard has none)
    return @[ @[@"tab", L(@"tab")], @[@"suggest", L(@"suggest")], @[@"left", @"←"], @[@"right", @"→"], @[@"up", @"↑"], @[@"down", @"↓"],
              @[@"{"], @[@"}"], @[@"("], @[@")"], @[@"["], @[@"]"], @[@"<"], @[@">"], @[@"="], @[@";"], @[@":"], @[@"\""], @[@"'"],
              @[@"/"], @[@"\\"], @[@"|"], @[@"&"], @[@"!"], @[@"?"], @[@"+"], @[@"-"], @[@"*"], @[@"_"], @[@"$"], @[@"#"],
              @[@"%"], @[@"`"], @[@"~"], @[@"^"], @[@"@"], @[@"undo", L(@"undo")], @[@"redo", L(@"redo")] ];
}

- (instancetype)initWithFrame:(CGRect)frame
{
    if (!(self = [super initWithFrame:frame])) return nil;
    self.autoresizingMask = UIViewAutoresizingFlexibleWidth;
    // (the keyboard's grey, a darker line at the top where it meets the page)
    CAGradientLayer *ground = [CAGradientLayer layer];
    ground.colors = @[(id)[UIColor colorWithRed:0.80 green:0.81 blue:0.84 alpha:1].CGColor,
                      (id)[UIColor colorWithRed:0.67 green:0.69 blue:0.73 alpha:1].CGColor];
    ground.frame = self.bounds;
    ground.name = @"ground";
    [self.layer addSublayer:ground];
    UIView *line = [[UIView alloc] initWithFrame:CGRectMake(0, 0, frame.size.width, 1)];
    line.autoresizingMask = UIViewAutoresizingFlexibleWidth;
    line.backgroundColor = [UIColor colorWithRed:0.47 green:0.49 blue:0.53 alpha:1];
    [self addSubview:line];

    UIScrollView *row = [[UIScrollView alloc] initWithFrame:self.bounds];
    row.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    row.showsHorizontalScrollIndicator = NO;
    row.alwaysBounceHorizontal = YES;
    row.delaysContentTouches = NO;
    [self addSubview:row];
    self.row = row;

    UIImage *up = KDKeyImage(NO), *down = KDKeyImage(YES);
    CGFloat x = KDGap;
    for (NSArray *key in [KDKeyBar keys]) {
        NSString *name = key[0], *title = key.count > 1 ? key[1] : key[0];
        CGFloat width = title.length > 1 ? MAX(KDKeyWidth, 18 + 11 * title.length) : KDKeyWidth;
        UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
        b.frame = CGRectMake(x, (KDBarHeight - KDKeyHeight) / 2 + 1, width, KDKeyHeight);
        [b setBackgroundImage:up forState:UIControlStateNormal];
        [b setBackgroundImage:down forState:UIControlStateHighlighted];
        [b setTitle:title forState:UIControlStateNormal];
        [b setTitleColor:[UIColor colorWithWhite:0.18 alpha:1] forState:UIControlStateNormal];
        [b setTitleShadowColor:[UIColor whiteColor] forState:UIControlStateNormal];
        b.titleLabel.shadowOffset = CGSizeMake(0, 1);
        b.titleLabel.font = title.length > 1 ? [UIFont boldSystemFontOfSize:16] : [UIFont systemFontOfSize:22];
        b.accessibilityLabel = name;
        [b addTarget:self action:@selector(keyDown:) forControlEvents:UIControlEventTouchDown];
        [b addTarget:self action:@selector(keyUp:) forControlEvents:UIControlEventTouchUpInside];
        [b addTarget:self action:@selector(keyLeft:) forControlEvents:UIControlEventTouchUpOutside | UIControlEventTouchCancel | UIControlEventTouchDragExit];
        objc_setAssociatedObject(b, @selector(keyDown:), name, OBJC_ASSOCIATION_COPY_NONATOMIC);
        [row addSubview:b];
        x += width + KDGap;
    }
    row.contentSize = CGSizeMake(x, KDBarHeight);
    return self;
}

- (void)layoutSubviews
{
    [super layoutSubviews];
    for (CALayer *layer in self.layer.sublayers) if ([layer.name isEqualToString:@"ground"]) layer.frame = self.bounds;
    // (the keys centred when they fit, as on a wide landscape keyboard)
    CGFloat spare = self.bounds.size.width - self.row.contentSize.width;
    self.row.contentInset = UIEdgeInsetsMake(0, spare > 0 ? floor(spare / 2) : 0, 0, 0);
}

// A key goes when the finger lifts, as the keyboard's do (a finger that moves the row on sends nothing); an arrow held
// goes on and on
- (void)keyDown:(UIButton *)button
{
    [self.repeat invalidate];
    self.repeat = nil;
    self.held = objc_getAssociatedObject(button, @selector(keyDown:));
    self.repeated = NO;
    if ([@[@"left", @"right", @"up", @"down"] containsObject:self.held ?: @""]) {
        self.repeat = [NSTimer scheduledTimerWithTimeInterval:0.45 target:self selector:@selector(startRepeating) userInfo:nil repeats:NO];
    }
}

- (void)startRepeating
{
    self.repeated = YES;
    [self repeatKey];
    self.repeat = [NSTimer scheduledTimerWithTimeInterval:0.08 target:self selector:@selector(repeatKey) userInfo:nil repeats:YES];
}

- (void)repeatKey
{
    if (self.held && self.onKey) self.onKey(self.held);
}

- (void)keyUp:(UIButton *)button
{
    NSString *name = self.held;
    BOOL repeated = self.repeated;
    [self keyLeft:button];
    if (name && !repeated && self.onKey) self.onKey(name);
}

- (void)keyLeft:(UIButton *)button
{
    [self.repeat invalidate];
    self.repeat = nil;
    self.held = nil;
    self.repeated = NO;
}

@end
