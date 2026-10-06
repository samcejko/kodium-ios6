#import "BRSettings.h"
#import "BRTLSSocket.h"
#import "BRConnectionPool.h"
#import "BRURLProtocol.h"
#import "BRCommon.h"

static NSString * const BRVerifyTLSKey = @"BRVerifyTLS";
static NSString * const BRLastBuildKey = @"BRLastBuild";               // CFBundleVersion of the last launch
static NSString * const BRLegacyCookieSnapshotKey = @"BRPrivateCookieSnapshot";   // where builds before 1.0 kept it
static NSString * const BRCookieRestoredAtKey = @"BRCookieBackupRestoredAt";      // when private browsing last ended

// TLS sessions are resumed without a certificate check and kept-alive connections were opened under the old rules:
// neither may outlive a change of verification or of private browsing (a resumed session ticket would also tie the
// private session to the normal one)
static void BRForgetConnections(void)
{
    [BRTLSSocket flushSessionCache];
    [BRConnectionPool closeAllConnections];
}

// the app's own defaults (not the registration or global domains)
static NSDictionary *BRAppDefaults(void)
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    NSString *bundleId = [[NSBundle mainBundle] bundleIdentifier];
    NSDictionary *domain = bundleId.length ? [d persistentDomainForName:bundleId] : nil;
    return domain ?: [d dictionaryRepresentation];
}

#pragma mark - Private browsing cookie jar

// Private browsing gets an empty jar; the normal session's cookies wait in memory and in this file until it ends, so
// that a crash or a kill by iOS in between cannot lose them (prepareAtLaunch puts them back). Library, not the
// preferences plist: they are login cookies, session-only ones included, and the plist is rewritten all the time.
static NSString *BRCookieBackupPath(void)
{
    NSString *library = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) firstObject];
    return [library stringByAppendingPathComponent:@"surfari-cookie-backup.plist"];
}

static NSArray *g_cookieBackup;   // the same cookies in memory while private browsing is on (main thread)

// The jar's own file. CFNetwork writes it some time after a change, not at once: a kill before that brings the jar
// back as the file last had it.
static NSString *BRCookieJarPath(void)
{
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Cookies/Cookies.binarycookies"];
}

static NSDate *BRFileModificationDate(NSString *path)
{
    id date = [[NSFileManager defaultManager] attributesOfItemAtPath:path error:NULL][NSFileModificationDate];
    return [date isKindOfClass:[NSDate class]] ? date : nil;
}

// plist-safe properties of every cookie in the jar (NSHTTPCookie cannot be archived on iOS 6); the caller holds
// BRCookieLock
static NSArray *BRCookieSnapshot(NSHTTPCookieStorage *jar)
{
    NSMutableArray *snapshot = [NSMutableArray array];
    for (NSHTTPCookie *c in jar.cookies) {
        NSDictionary *all = c.properties;
        NSMutableDictionary *props = [NSMutableDictionary dictionary];
        for (NSString *k in all) {
            id v = all[k];
            if ([v isKindOfClass:[NSString class]] || [v isKindOfClass:[NSNumber class]] || [v isKindOfClass:[NSDate class]]) props[k] = v;
            else if ([v isKindOfClass:[NSURL class]]) props[k] = [(NSURL *)v absoluteString] ?: @"";
        }
        // the absolute expiry stays; a Max-Age would start counting again when the cookie comes back
        if (props[NSHTTPCookieExpires]) [props removeObjectForKey:NSHTTPCookieMaximumAge];
        [snapshot addObject:props];
    }
    return snapshot;
}

static NSHTTPCookie *BRCookieFromSnapshot(id entry)
{
    if (![entry isKindOfClass:[NSDictionary class]]) return nil;
    NSDictionary *props = entry;
    NSMutableDictionary *p = [props mutableCopy];
    for (NSString *k in props) {
        // (builds before 1.0 kept dates as { date: seconds since 1970 })
        id v = props[k];
        if ([v isKindOfClass:[NSDictionary class]] && v[@"date"]) p[k] = [NSDate dateWithTimeIntervalSince1970:[v[@"date"] doubleValue]];
    }
    return [NSHTTPCookie cookieWithProperties:p];
}

static void BRRestoreCookies(NSHTTPCookieStorage *jar, NSArray *snapshot)
{
    for (id entry in snapshot) {
        NSHTTPCookie *c = BRCookieFromSnapshot(entry);
        if (c) [jar setCookie:c];
    }
}

static NSString *BRCookieIdentity(NSHTTPCookie *c)
{
    return [NSString stringWithFormat:@"%@\n%@\n%@\n%@", c.name, c.domain, c.path, c.value];
}

// Takes out of the jar the cookies of the snapshot that are still there unchanged; the number taken out. The caller
// holds BRCookieLock.
static NSUInteger BRRemoveSnapshotCookies(NSHTTPCookieStorage *jar, NSArray *snapshot)
{
    NSMutableSet *saved = [NSMutableSet set];
    for (id entry in snapshot) {
        NSHTTPCookie *c = BRCookieFromSnapshot(entry);
        if (c) [saved addObject:BRCookieIdentity(c)];
    }
    NSUInteger removed = 0;
    for (NSHTTPCookie *c in [jar.cookies copy]) {
        if (![saved containsObject:BRCookieIdentity(c)]) continue;
        [jar deleteCookie:c];
        removed++;
    }
    return removed;
}

static void BREmptyJar(NSHTTPCookieStorage *jar)
{
    for (NSHTTPCookie *c in [jar.cookies copy]) [jar deleteCookie:c];
}

static BOOL BRWriteCookieBackup(NSArray *snapshot)
{
    NSData *data = [NSPropertyListSerialization dataWithPropertyList:snapshot ?: @[] format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
    // (unreadable while the device is locked; the app only reads it on a switch in Settings or at a launch)
    return data && [data writeToFile:BRCookieBackupPath() options:NSDataWritingAtomic | NSDataWritingFileProtectionComplete error:NULL];
}

// nil when there is no backup; *unreadable = YES when the file exists but cannot be read now (it stays for a later
// attempt). A damaged file reads as no cookies.
static NSArray *BRReadCookieBackup(BOOL *unreadable)
{
    *unreadable = NO;
    NSString *path = BRCookieBackupPath();
    if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return nil;
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (!data) {
        *unreadable = YES;
        return nil;
    }
    id list = [NSPropertyListSerialization propertyListWithData:data options:NSPropertyListImmutable format:NULL error:NULL];
    return [list isKindOfClass:[NSArray class]] ? list : @[];
}

static void BRDropCookieBackup(void)
{
    [[NSFileManager defaultManager] removeItemAtPath:BRCookieBackupPath() error:NULL];
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    if ([d objectForKey:BRCookieRestoredAtKey]) {
        [d removeObjectForKey:BRCookieRestoredAtKey];
        [d synchronize];
    }
}

// When private browsing ends the backup goes back into the jar in memory, but the file stays until the jar's own file
// has been written after that: a kill in between would otherwise leave the private session's cookies (or an empty
// jar) as the normal ones, with the backup gone. File times have whole seconds here, hence the 2 s.
static BOOL BRJarSavedSinceRestore(void)
{
    id restored = [[NSUserDefaults standardUserDefaults] objectForKey:BRCookieRestoredAtKey];
    NSDate *saved = BRFileModificationDate(BRCookieJarPath());
    return [restored isKindOfClass:[NSDate class]] && saved && [saved timeIntervalSinceDate:restored] >= 2;
}

// (main thread; also when the app goes to the background and comes back, so the backup does not wait for a launch)
static void BRSettleCookieBackup(void)
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    if ([d boolForKey:@"BRPrivateMode"] || ![d objectForKey:BRCookieRestoredAtKey]) return;
    if (BRJarSavedSinceRestore()) BRDropCookieBackup();
}

static void BRRecoverCookieJar(void)
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSHTTPCookieStorage *jar = [NSHTTPCookieStorage sharedHTTPCookieStorage];
    BOOL private = [d boolForKey:@"BRPrivateMode"];
    NSArray *legacy = [d arrayForKey:BRLegacyCookieSnapshotKey];
    if (legacy) {
        // an update while private browsing was on: earlier builds kept the snapshot in the preferences and the normal
        // cookies in the jar as well - the file takes them over and the private session goes on with an empty jar
        if ([fm fileExistsAtPath:BRCookieBackupPath()] || BRWriteCookieBackup(legacy)) {
            [d removeObjectForKey:BRLegacyCookieSnapshotKey];
            [d synchronize];
            if (private) {
                @synchronized (BRCookieLock()) { BREmptyJar(jar); }
            }
        }
    }
    BOOL unreadable = NO;
    if (private) {
        // The jar emptied when private browsing started may not have reached its file before iOS closed the app: the
        // normal session's cookies would then be back in it. Those still the same as in the backup go; the private
        // session's own stay until it is switched off, like its tabs.
        NSArray *snapshot = BRReadCookieBackup(&unreadable);
        if (!snapshot.count) return;
        NSUInteger removed = 0;
        @synchronized (BRCookieLock()) { removed = BRRemoveSnapshotCookies(jar, snapshot); }
        if (removed) BRLog(@"Private browsing: %lu cookies of the normal session were back in the jar, taken out", (unsigned long)removed);
        return;
    }
    if (![fm fileExistsAtPath:BRCookieBackupPath()]) {
        BRDropCookieBackup();
        return;
    }
    // private browsing ended and the jar's file was written since: it holds the normal session again
    if (BRJarSavedSinceRestore()) {
        BRDropCookieBackup();
        return;
    }
    // Otherwise it ended without its cleanup, or iOS closed the app before the jar reached its file: the backup goes
    // back once more. (Then it goes for good - should the jar's file be somewhere else, every launch would undo the
    // cookies of the one before.)
    NSArray *snapshot = BRReadCookieBackup(&unreadable);
    if (!snapshot) return;
    @synchronized (BRCookieLock()) {
        BREmptyJar(jar);
        BRRestoreCookies(jar, snapshot);
    }
    BRDropCookieBackup();
    BRLog(@"Private browsing had not ended cleanly: %lu cookies of the normal session put back", (unsigned long)snapshot.count);
}

#pragma mark - Launch and reset

// Switches for debugging (set over SSH with the debug key) that change how the engine runs or write page data to disk:
// a new build starts without them, unless this device holds the debug key. (Not BRDebugEnabled(): the BRDebugLog
// default alone turns that on, and it is one of these switches - a stale or planted one would keep them all.)
static BOOL BRIsDeveloperKey(NSString *key)
{
    return [key hasPrefix:@"BRDebug"] || [key hasPrefix:@"BRDump"] || [key hasPrefix:@"BRDev"]
        || [key isEqualToString:@"BRJSCMode"] || [key isEqualToString:@"BRMemoryReliefMB"];
}

static void BRForgetDeveloperKeysAfterUpdate(void)
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    NSString *build = [[NSBundle mainBundle] infoDictionary][@"CFBundleVersion"] ?: @"";
    if ([[d stringForKey:BRLastBuildKey] isEqualToString:build]) return;
    if (!BRDebugKey()) {
        for (NSString *key in [BRAppDefaults() allKeys]) {
            if ([key isKindOfClass:[NSString class]] && BRIsDeveloperKey(key)) [d removeObjectForKey:key];
        }
    }
    [d setObject:build forKey:BRLastBuildKey];
    [d synchronize];
}

@implementation BRSettings

+ (void)initialize
{
    if (self == [BRSettings class]) [self prepareAtLaunch];
}

+ (void)prepareAtLaunch
{
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        BRForgetDeveloperKeysAfterUpdate();
        BRRecoverCookieJar();
        // (checked again when the app goes to the background and when it comes back - the jar's file is written
        // meanwhile as a rule - so a backup kept after private browsing ended does not wait for the next launch)
        for (NSString *name in @[UIApplicationDidEnterBackgroundNotification, UIApplicationWillEnterForegroundNotification]) {
            [[NSNotificationCenter defaultCenter] addObserverForName:name object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
                BRSettleCookieBackup();
            }];
        }
    });
}

+ (void)resetAll
{
    // (the normal cookies come back first; private browsing is a setting like the others)
    [self setPrivateMode:NO];
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    [d synchronize];
    // Every key of ours goes (they all start with BR: settings, per-site choices, what was learned about heavy sites,
    // debugging switches), except what the user made rather than chose: the open tabs, the one-time default
    // bookmarks (they would be added again), the "never save a password here" sites (the passwords are in the
    // keychain, "Forget site passwords" clears both), plus the crash marker of the page loading now, the count of runs
    // that ended on screen (the safe start; without it one crash would go uncounted), the HTTP cache size chosen at
    // launch (a switch starts the cache over), the build check, the one-time update of the kept logins and when private
    // browsing last ended (its cookie backup may still be waiting for the jar's file). Bookmarks and history are files
    // of their own. Keys of the frameworks (WebKit*, Apple*, NS*) are theirs.
    NSSet *keep = [NSSet setWithObjects:@"BRTabs", @"BRCurrentTab", @"BRDefaultBookmarksCreated", @"BRPasswordNever", @"BRLoadingURL",
                   @"BRForegroundExits", @"BRSmallHTTPCache", @"BRPasswordsHTTPSOnly", BRLastBuildKey, BRCookieRestoredAtKey, nil];
    for (NSString *key in [BRAppDefaults() allKeys]) {
        if ([key isKindOfClass:[NSString class]] && [key hasPrefix:@"BR"] && ![keep containsObject:key]) [d removeObjectForKey:key];
    }
    [d synchronize];
    // (certificate verification is back on)
    BRForgetConnections();
}

+ (void)clearAllCookies
{
    @synchronized (BRCookieLock()) { BREmptyJar([NSHTTPCookieStorage sharedHTTPCookieStorage]); }
    // The normal session's cookies waiting for the end of private browsing go too (it then ends with an empty jar),
    // and so does a backup still kept after it ended: either would bring back what the user cleared.
    if ([self privateMode]) g_cookieBackup = @[];
    BRDropCookieBackup();
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    if ([d objectForKey:BRLegacyCookieSnapshotKey]) {
        [d removeObjectForKey:BRLegacyCookieSnapshotKey];
        [d synchronize];
    }
}

+ (BOOL)verifyTLS
{
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:BRVerifyTLSKey];
    return v ? [v boolValue] : YES;
}

+ (void)setVerifyTLS:(BOOL)verify
{
    BOOL was = [self verifyTLS];
    [[NSUserDefaults standardUserDefaults] setBool:verify forKey:BRVerifyTLSKey];
    [[NSUserDefaults standardUserDefaults] synchronize];
    if (was == verify) return;
    BRForgetConnections();
    // what was fetched without verification may come from anyone in the middle: it does not stay in the cache
    if (verify) [[NSURLCache sharedURLCache] removeAllCachedResponses];
}

+ (BOOL)adBlockEnabled
{
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:@"BRAdBlock"];
    return v ? [v boolValue] : YES;
}

+ (void)setAdBlockEnabled:(BOOL)enabled
{
    [[NSUserDefaults standardUserDefaults] setBool:enabled forKey:@"BRAdBlock"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (BOOL)cssFixEnabled
{
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:@"BRCSSFix"];
    return v ? [v boolValue] : YES;
}

+ (void)setCSSFixEnabled:(BOOL)enabled
{
    [[NSUserDefaults standardUserDefaults] setBool:enabled forKey:@"BRCSSFix"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (BOOL)jsFixEnabled
{
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:@"BRJSFix"];
    return v ? [v boolValue] : YES;
}

+ (void)setJSFixEnabled:(BOOL)enabled
{
    [[NSUserDefaults standardUserDefaults] setBool:enabled forKey:@"BRJSFix"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (BOOL)transpileEnabled
{
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:@"BRTranspile"];
    return v ? [v boolValue] : YES;
}

+ (void)setTranspileEnabled:(BOOL)enabled
{
    [[NSUserDefaults standardUserDefaults] setBool:enabled forKey:@"BRTranspile"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (NSInteger)userAgentMode
{
    NSInteger m = [[NSUserDefaults standardUserDefaults] integerForKey:@"BRUserAgentMode"];
    return (m >= 0 && m <= 2) ? m : 0;
}

+ (void)setUserAgentMode:(NSInteger)mode
{
    [[NSUserDefaults standardUserDefaults] setInteger:mode forKey:@"BRUserAgentMode"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (NSString *)userAgentOverride
{
    return [self userAgentStringForMode:[self userAgentMode]];
}

+ (NSString *)userAgentModeTitle:(NSInteger)mode
{
    switch (mode) {
        case 1: return L(@"Desktop (Safari 6)");
        case 2: return L(@"Modern iPad (Safari 17)");
        case 3: return L(@"iPhone with iOS 6 (lighter pages)");
        case 4: return L(@"Modern iPhone (Safari 17)");
    }
    return L(@"iPad with iOS 6");
}

static NSString *BRHostKey(NSString *host)
{
    NSString *h = [host lowercaseString] ?: @"";
    if ([h hasPrefix:@"www."]) h = [h substringFromIndex:4];
    return h;
}

// Choices made for a site in private browsing (ads allowed, another identity) stay in memory and end with it: the
// lists in the preferences would keep the sites visited. They come before those lists; the network threads read them.
static NSMutableDictionary *g_privateSiteChoices;   // @"ads <host>" / @"ua <host>" -> NSNumber
static volatile BOOL g_hasPrivateSiteChoices;       // (so that ordinary requests never take the lock)

static id BRPrivateSiteChoicesLock(void)
{
    static id lock;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ lock = [[NSObject alloc] init]; });
    return lock;
}

static NSNumber *BRPrivateSiteChoice(NSString *name)
{
    NSNumber *value = nil;
    @synchronized (BRPrivateSiteChoicesLock()) { value = g_privateSiteChoices[name]; }
    return value;
}

static void BRSetPrivateSiteChoice(NSString *name, NSNumber *value)
{
    @synchronized (BRPrivateSiteChoicesLock()) {
        if (!g_privateSiteChoices) g_privateSiteChoices = [NSMutableDictionary dictionary];
        g_privateSiteChoices[name] = value;
        g_hasPrivateSiteChoices = YES;
    }
}

static void BRForgetPrivateSiteChoices(void)
{
    @synchronized (BRPrivateSiteChoicesLock()) {
        g_privateSiteChoices = nil;
        g_hasPrivateSiteChoices = NO;
    }
}

+ (BOOL)adBlockDisabledForHost:(NSString *)host
{
    NSString *key = BRHostKey(host);
    if (!key.length) return NO;
    NSNumber *choice = g_hasPrivateSiteChoices ? BRPrivateSiteChoice([@"ads " stringByAppendingString:key]) : nil;
    if (choice) return [choice boolValue];
    return [[[NSUserDefaults standardUserDefaults] dictionaryForKey:@"BRAdBlockHosts"][key] boolValue];
}

+ (void)setAdBlockDisabled:(BOOL)disabled forHost:(NSString *)host
{
    NSString *key = BRHostKey(host);
    if (!key.length) return;
    if ([self privateMode]) {
        BRSetPrivateSiteChoice([@"ads " stringByAppendingString:key], @(disabled));
        return;
    }
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    NSMutableDictionary *hosts = [[d dictionaryForKey:@"BRAdBlockHosts"] mutableCopy] ?: [NSMutableDictionary dictionary];
    if (disabled) hosts[key] = @YES; else [hosts removeObjectForKey:key];
    [d setObject:hosts forKey:@"BRAdBlockHosts"];
    [d synchronize];
}

// Sites that refuse the iOS 6 identity outright but render (well enough) as a current iPad
static NSInteger BRBuiltInUserAgentMode(NSString *hostKey)
{
    // Google search answers "your browser is no longer supported" to Safari 6; the modern page renders its results
    if ([hostKey hasPrefix:@"google."] || [hostKey rangeOfString:@".google."].location != NSNotFound) return 2;
    return -1;
}

+ (NSInteger)defaultUserAgentModeForHost:(NSString *)host
{
    NSInteger global = [self userAgentMode];
    if (global != 0) return global;
    NSInteger builtIn = BRBuiltInUserAgentMode(BRHostKey(host));
    if (builtIn >= 0) return builtIn;
    return [self lighterVersionForHost:host] ? 3 : global;
}

// Sites too heavy for the iPad: iOS closed the app while one was loading, or it sent a script no iPad 2 can take.
// For a month they are asked for the version a phone gets (YouTube's desktop channel pages - 1.9 MB of HTML and a
// 10.8 MB script - against m.youtube.com).
static const NSTimeInterval BRLighterVersionDays = 30;

+ (BOOL)lighterVersionForHost:(NSString *)host
{
    NSString *key = BRHostKey(host);
    if (!key.length) return NO;
    NSNumber *since = [[NSUserDefaults standardUserDefaults] dictionaryForKey:@"BRLighterHosts"][key];
    return since && [[NSDate date] timeIntervalSince1970] - since.doubleValue < BRLighterVersionDays * 86400;
}

+ (BOOL)noteHostTooHeavy:(NSString *)host
{
    NSString *key = BRHostKey(host);
    // (private browsing adds no site to the list on disk, whoever asks)
    if (!key.length || [self privateMode] || [self lighterVersionForHost:host]) return NO;
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    NSMutableDictionary *hosts = [[d dictionaryForKey:@"BRLighterHosts"] mutableCopy] ?: [NSMutableDictionary dictionary];
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    for (NSString *k in [hosts allKeys]) if (now - [hosts[k] doubleValue] >= BRLighterVersionDays * 86400) [hosts removeObjectForKey:k];
    hosts[key] = @(now);
    [d setObject:hosts forKey:@"BRLighterHosts"];
    [d synchronize];
    return YES;
}

+ (NSInteger)userAgentModeForHost:(NSString *)host
{
    NSString *key = BRHostKey(host);
    // (-1 from private browsing: back to the default there, whatever the list says)
    NSNumber *m = g_hasPrivateSiteChoices ? BRPrivateSiteChoice([@"ua " stringByAppendingString:key]) : nil;
    if (!m) m = [[NSUserDefaults standardUserDefaults] dictionaryForKey:@"BRUserAgentHosts"][key];
    if (m && [m integerValue] >= 0 && [m integerValue] <= 4) return [m integerValue];
    return [self defaultUserAgentModeForHost:host];
}

+ (void)setUserAgentMode:(NSInteger)mode forHost:(NSString *)host
{
    NSString *key = BRHostKey(host);
    if (!key.length) return;
    if ([self privateMode]) {
        NSInteger choice = (mode < 0 || mode == [self defaultUserAgentModeForHost:host]) ? -1 : mode;
        BRSetPrivateSiteChoice([@"ua " stringByAppendingString:key], @(choice));
        return;
    }
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    NSMutableDictionary *overrides = [[d dictionaryForKey:@"BRUserAgentHosts"] mutableCopy] ?: [NSMutableDictionary dictionary];
    if (mode < 0 || mode == [self defaultUserAgentModeForHost:host]) [overrides removeObjectForKey:key];
    else overrides[key] = @(mode);
    [d setObject:overrides forKey:@"BRUserAgentHosts"];
    [d synchronize];
}

+ (NSString *)userAgentStringForMode:(NSInteger)mode
{
    switch (mode) {
        case 1:   // Safari 6 on OS X: the same engine generation, servers send pages the engine can render
            return @"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) AppleWebKit/536.30.1 (KHTML, like Gecko) Version/6.0.5 Safari/536.30.1";
        case 2:   // a current iPad: modern pages, which may or may not survive the old engine
            return @"Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
        case 3:   // an iPhone of the same generation: the lighter pages servers send phones
            return @"Mozilla/5.0 (iPhone; CPU iPhone OS 6_1_2 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10B146 Safari/8536.25";
        case 4:   // a current iPhone (a phone page that refused the old one)
            return @"Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
    }
    return nil;
}

+ (NSString *)userAgentOverrideForURL:(NSURL *)url
{
    return [self userAgentStringForMode:[self userAgentModeForHost:url.host]];
}

+ (BOOL)darkTheme
{
    return [[NSUserDefaults standardUserDefaults] boolForKey:@"BRDarkTheme"];
}

+ (void)setDarkTheme:(BOOL)dark
{
    [[NSUserDefaults standardUserDefaults] setBool:dark forKey:@"BRDarkTheme"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (NSInteger)searchEngine
{
    NSInteger e = [[NSUserDefaults standardUserDefaults] integerForKey:@"BRSearchEngine"];
    return (e >= 0 && e < [self searchEngineCount]) ? e : 0;
}

+ (void)setSearchEngine:(NSInteger)engine
{
    [[NSUserDefaults standardUserDefaults] setInteger:engine forKey:@"BRSearchEngine"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (NSString *)searchEngineTitle:(NSInteger)engine
{
    switch (engine) {
        case 1: return @"Google";
        case 2: return @"Bing";
        case 3: return @"Seznam";
        case 4: {
            NSString *host = [NSURL URLWithString:[self customSearchTemplate] ?: @""].host;
            return host.length ? host : L(@"Custom");
        }
    }
    return @"DuckDuckGo";
}

+ (NSInteger)searchEngineCount
{
    return 5;
}

+ (NSString *)customSearchTemplate
{
    NSString *t = [[NSUserDefaults standardUserDefaults] stringForKey:@"BRCustomSearch"];
    return ([t rangeOfString:@"%s"].location != NSNotFound && [[NSURL URLWithString:[t stringByReplacingOccurrencesOfString:@"%s" withString:@"x"]].scheme.lowercaseString hasPrefix:@"http"]) ? t : nil;
}

+ (void)setCustomSearchTemplate:(NSString *)urlTemplate
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    if (urlTemplate.length) [d setObject:urlTemplate forKey:@"BRCustomSearch"];
    else [d removeObjectForKey:@"BRCustomSearch"];
    [d synchronize];
}

+ (NSInteger)textSizePercent
{
    NSInteger p = [[NSUserDefaults standardUserDefaults] integerForKey:@"BRTextSizePercent"];
    return (p >= 50 && p <= 300) ? p : 100;
}

+ (void)setTextSizePercent:(NSInteger)percent
{
    [[NSUserDefaults standardUserDefaults] setInteger:percent forKey:@"BRTextSizePercent"];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (BOOL)privateMode
{
    return [[NSUserDefaults standardUserDefaults] boolForKey:@"BRPrivateMode"];
}

+ (BOOL)setPrivateMode:(BOOL)enabled
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    if (enabled == [self privateMode]) return YES;
    // Only the cookies are isolated. The HTTP cache and WebKit's own storage (localStorage, WebSQL, the application
    // cache, its disk image cache) are shared with normal browsing and cannot be split per mode in UIWebView: private
    // pages only never write to the HTTP cache (BRURLProtocol), and it is emptied when private browsing ends. Cookies
    // that sites set meanwhile do reach the jar's file on disk; they are thrown away when it is switched off.
    // Every step leaves a state the next launch repairs (BRRecoverCookieJar): the switch is stored before the jar
    // changes, and the backup file stays until the jar's own file holds the normal cookies again.
    NSHTTPCookieStorage *jar = [NSHTTPCookieStorage sharedHTTPCookieStorage];
    if (enabled) {
        BOOL saved = NO;
        @synchronized (BRCookieLock()) {
            // The file first: emptying the jar must never be what loses the normal session. Without room for it
            // private browsing does not start - cookies kept in memory only would not survive iOS closing the app.
            NSArray *snapshot = BRCookieSnapshot(jar);
            saved = BRWriteCookieBackup(snapshot);
            if (saved) {
                g_cookieBackup = snapshot;
                [d setBool:YES forKey:@"BRPrivateMode"];
                [d removeObjectForKey:BRCookieRestoredAtKey];
                [d synchronize];
                BREmptyJar(jar);
            }
        }
        if (!saved) {
            BRLog(@"Private browsing not started: the cookie backup could not be written");
            return NO;
        }
    } else {
        BOOL unreadable = NO;
        NSArray *snapshot = g_cookieBackup;
        if (!snapshot) snapshot = BRReadCookieBackup(&unreadable);
        if (!snapshot && !unreadable) snapshot = [d arrayForKey:BRLegacyCookieSnapshotKey];
        // the switch goes with the moment of the restore (see BRJarSavedSinceRestore); a backup that cannot be read
        // now gets none: the next launch puts it back whatever the jar holds
        [d setBool:NO forKey:@"BRPrivateMode"];
        if (unreadable) [d removeObjectForKey:BRCookieRestoredAtKey];
        else [d setObject:[NSDate date] forKey:BRCookieRestoredAtKey];
        [d synchronize];
        @synchronized (BRCookieLock()) {
            BREmptyJar(jar);
            BRRestoreCookies(jar, snapshot);
        }
        g_cookieBackup = nil;
        if ([d objectForKey:BRLegacyCookieSnapshotKey]) {
            [d removeObjectForKey:BRLegacyCookieSnapshotKey];
            [d synchronize];
        }
        // Nothing to wait for without the jar's file (not written yet, or kept elsewhere) or without a backup file
        // (cleared): it all goes now. Otherwise BRSettleCookieBackup or the next launch removes the backup.
        BOOL backupFile = [[NSFileManager defaultManager] fileExistsAtPath:BRCookieBackupPath()];
        if (!unreadable && (!backupFile || !BRFileModificationDate(BRCookieJarPath()))) BRDropCookieBackup();
        [[NSURLCache sharedURLCache] removeAllCachedResponses];
    }
    BRForgetPrivateSiteChoices();
    // logins typed into Basic auth dialogs are per session too
    [BRURLProtocol forgetCredentials];
    BRForgetConnections();
    [[NSNotificationCenter defaultCenter] postNotificationName:@"BRPrivateModeDidChangeNotification" object:nil];
    return YES;
}

static BOOL BRBoolSetting(NSString *key, BOOL fallback)
{
    id v = [[NSUserDefaults standardUserDefaults] objectForKey:key];
    return v ? [v boolValue] : fallback;
}

static void BRSetBoolSetting(NSString *key, BOOL value)
{
    [[NSUserDefaults standardUserDefaults] setBool:value forKey:key];
    [[NSUserDefaults standardUserDefaults] synchronize];
}

+ (BOOL)doNotTrack { return BRBoolSetting(@"BRDoNotTrack", NO); }
+ (void)setDoNotTrack:(BOOL)enabled { BRSetBoolSetting(@"BRDoNotTrack", enabled); }
+ (BOOL)blockThirdPartyCookies { return BRBoolSetting(@"BRBlockThirdPartyCookies", YES); }
+ (void)setBlockThirdPartyCookies:(BOOL)enabled { BRSetBoolSetting(@"BRBlockThirdPartyCookies", enabled); }
+ (BOOL)loadImages { return BRBoolSetting(@"BRLoadImages", YES); }
+ (void)setLoadImages:(BOOL)enabled { BRSetBoolSetting(@"BRLoadImages", enabled); }
+ (BOOL)hideCookieBanners { return BRBoolSetting(@"BRHideCookieBanners", YES); }
+ (void)setHideCookieBanners:(BOOL)enabled { BRSetBoolSetting(@"BRHideCookieBanners", enabled); }
+ (BOOL)pagesDark { return BRBoolSetting(@"BRPagesDark", NO); }
+ (void)setPagesDark:(BOOL)enabled { BRSetBoolSetting(@"BRPagesDark", enabled); }
+ (BOOL)searchSuggestions { return BRBoolSetting(@"BRSearchSuggestions", YES); }
+ (void)setSearchSuggestions:(BOOL)on { BRSetBoolSetting(@"BRSearchSuggestions", on); }

+ (NSURL *)searchURLForQuery:(NSString *)query
{
    NSString *q = (__bridge_transfer NSString *)CFURLCreateStringByAddingPercentEscapes(
        kCFAllocatorDefault, (__bridge CFStringRef)(query ?: @""), NULL, CFSTR("!*'();:@&=+$,/?%#[]"), kCFStringEncodingUTF8);
    NSString *base;
    switch ([self searchEngine]) {
        case 1: base = @"https://www.google.com/search?q="; break;
        case 2: base = @"https://www.bing.com/search?q="; break;
        case 3: base = @"https://search.seznam.cz/?q="; break;
        case 4: {
            NSString *t = [self customSearchTemplate];
            if (t) return [NSURL URLWithString:[t stringByReplacingOccurrencesOfString:@"%s" withString:q ?: @""]];
            base = @"https://lite.duckduckgo.com/lite/?q=";
            break;
        }
        default: base = @"https://lite.duckduckgo.com/lite/?q="; break;
    }
    return [NSURL URLWithString:[base stringByAppendingString:q ?: @""]];
}

+ (NSString *)homePageURLString
{
    NSString *s = [[NSUserDefaults standardUserDefaults] stringForKey:@"BRHomePage"];
    return [[NSURL URLWithString:s ?: @""].scheme.lowercaseString hasPrefix:@"http"] ? s : nil;
}

+ (void)setHomePageURLString:(NSString *)urlString
{
    NSUserDefaults *d = [NSUserDefaults standardUserDefaults];
    if (urlString.length) [d setObject:urlString forKey:@"BRHomePage"];
    else [d removeObjectForKey:@"BRHomePage"];
    [d synchronize];
}

+ (NSURL *)homeURL
{
    NSString *custom = [self homePageURLString];
    if (custom) return [NSURL URLWithString:custom];
    return [[NSBundle mainBundle] URLForResource:@"home" withExtension:@"html"];
}

+ (BOOL)isHomeURL:(NSURL *)url
{
    return url != nil && [url isFileURL] && [[url lastPathComponent] isEqualToString:@"home.html"];
}

@end
