#import <Foundation/Foundation.h>

// User preferences (NSUserDefaults) and a few fixed URLs.
@interface BRSettings : NSObject

// Run once at launch, before anything reads the defaults (+initialize runs it too, so the first use of the class does
// it at the latest): forgets developer switches a new build must not inherit, and puts the normal cookie jar back when
// private browsing ended without its cleanup (a crash, a damaged preferences file).
+ (void)prepareAtLaunch;
// "Reset settings": every preference of the app back to its default; tabs, bookmarks, history and passwords stay
+ (void)resetAll;
// "Clear cookies": the jar and every copy put aside for private browsing (in private browsing the normal session's
// cookies waiting for its end, so it ends with an empty jar)
+ (void)clearAllCookies;

+ (BOOL)verifyTLS;                       // default YES
+ (void)setVerifyTLS:(BOOL)verify;       // a change also drops TLS sessions and kept-alive connections
+ (BOOL)adBlockEnabled;                  // default YES
+ (void)setAdBlockEnabled:(BOOL)enabled;
+ (BOOL)adBlockDisabledForHost:(NSString *)host;        // per-site exception ("allow ads on this site")
+ (void)setAdBlockDisabled:(BOOL)disabled forHost:(NSString *)host;
+ (BOOL)cssFixEnabled;                   // default YES: rewrite modern CSS for the old engine
+ (void)setCSSFixEnabled:(BOOL)enabled;
+ (BOOL)jsFixEnabled;                    // default YES: JavaScript polyfills injected into pages
+ (void)setJSFixEnabled:(BOOL)enabled;
+ (BOOL)transpileEnabled;                // default YES: scripts in ES2015+ syntax are lowered to ES5 (jsfix.js)
+ (void)setTranspileEnabled:(BOOL)enabled;
// 0 = iPad with iOS 6 (the engine's own identity), 1 = desktop Safari 6, 2 = a current iPad (Safari 17);
// per host only: 3 = iPhone with iOS 6 (sites too heavy for the iPad), 4 = a current iPhone
+ (NSInteger)userAgentMode;
+ (void)setUserAgentMode:(NSInteger)mode;
+ (NSString *)userAgentOverride;         // nil for mode 0
+ (NSString *)userAgentModeTitle:(NSInteger)mode;
// Per-site identity (Safari's "request desktop website"): overrides the global mode for one host
+ (NSInteger)userAgentModeForHost:(NSString *)host;
+ (void)setUserAgentMode:(NSInteger)mode forHost:(NSString *)host;   // -1 removes the override
+ (NSString *)userAgentOverrideForURL:(NSURL *)url;                  // nil when the engine's own identity applies
// a site that closed the app for lack of memory (or sent a script too big for it) gets the phone version (mode 3) for
// a month; YES when the host was not noted yet (never in private browsing, which adds no site to the list)
+ (BOOL)noteHostTooHeavy:(NSString *)host;
+ (BOOL)lighterVersionForHost:(NSString *)host;

+ (BOOL)darkTheme;                       // default NO
+ (void)setDarkTheme:(BOOL)dark;

// 0 = DuckDuckGo Lite, 1 = Google, 2 = Bing, 3 = Seznam, 4 = custom template with %s
+ (NSInteger)searchEngine;
+ (void)setSearchEngine:(NSInteger)engine;
+ (NSString *)searchEngineTitle:(NSInteger)engine;
+ (NSInteger)searchEngineCount;
+ (NSString *)customSearchTemplate;      // e.g. https://search.example.com/?q=%s (nil when none)
+ (void)setCustomSearchTemplate:(NSString *)urlTemplate;

+ (NSInteger)textSizePercent;            // 100 = the page's own size
+ (void)setTextSizePercent:(NSInteger)percent;

// Private browsing: no history, no cache writes, an empty cookie jar of its own; the normal session's cookies come
// back when it is switched off. Per-site choices made meanwhile (ads, identity) are kept in memory only. A change also
// drops TLS sessions, kept-alive connections and Basic auth logins. NO when private browsing could not start: the
// normal cookies could not be put aside on disk (no room), and nothing changed.
+ (BOOL)privateMode;
+ (BOOL)setPrivateMode:(BOOL)enabled;

+ (BOOL)searchSuggestions;               // default YES: address bar text goes to the search engine while typing
+ (void)setSearchSuggestions:(BOOL)on;

+ (BOOL)doNotTrack;                      // default NO: sends DNT: 1 and Sec-GPC: 1
+ (void)setDoNotTrack:(BOOL)enabled;
+ (BOOL)blockThirdPartyCookies;          // default YES (like Safari): cookies only for the site shown in the address bar
+ (void)setBlockThirdPartyCookies:(BOOL)enabled;
+ (BOOL)loadImages;                      // default YES; off = data saver, images are served blank
+ (void)setLoadImages:(BOOL)enabled;
+ (BOOL)hideCookieBanners;               // default YES: known consent dialogs are hidden by injected CSS
+ (void)setHideCookieBanners:(BOOL)enabled;
+ (BOOL)pagesDark;                       // default NO: pages are shown inverted (dark) through a CSS filter
+ (void)setPagesDark:(BOOL)enabled;

+ (NSURL *)searchURLForQuery:(NSString *)query;
+ (NSURL *)homeURL;                      // the chosen home page, or the bundled start page
+ (BOOL)isHomeURL:(NSURL *)url;          // the bundled start page (address bar stays empty for it)
+ (NSString *)homePageURLString;         // nil = the bundled start page
+ (void)setHomePageURLString:(NSString *)urlString;

@end
