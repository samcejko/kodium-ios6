#import "BRMediaProxy.h"
#import "BRHTTPRequest.h"
#import "BRTLSSocket.h"
#import "BRSettings.h"
#import "BRCommon.h"

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <poll.h>
#include <CommonCrypto/CommonDigest.h>
#include <Security/SecRandom.h>

static const NSUInteger BRMediaProxyMaxEntries = 4000;   // (an HLS stream registers every segment it lists)
static const NSUInteger BRWebSocketMaxEntries = 200;     // (handed out, not yet connected)
static const NSUInteger BRMaxPlaylistBytes = 4 * 1024 * 1024;   // (a playlist is rewritten in memory)
static volatile uint16_t g_proxyPort;                    // (0 until the server listens; see isProxyURL:)

@interface BRMediaProxy ()
@property (nonatomic) int listenFD;
@property (nonatomic) uint16_t port;
@property (nonatomic, strong) NSMutableDictionary *entries;      // token -> @[url, page url, key in tokensByURL]
@property (nonatomic, strong) NSMutableDictionary *tokensByURL;  // "<page URL> <media URL>" -> token
@property (nonatomic, strong) NSMutableArray *order;             // tokens, oldest first
@property (nonatomic, strong) NSMutableDictionary *wsEntries;    // token -> @[url, page url]
@property (nonatomic, strong) NSMutableArray *wsOrder;
@end

// 128 random bits as hex: each address handed out has its own (a page that learns one learns nothing of the others,
// unlike one secret with numbered entries)
static NSString *BRRandomToken(void)
{
    uint8_t b[16];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof(b), b) != 0) {
        for (size_t i = 0; i < sizeof(b); i++) b[i] = (uint8_t)arc4random_uniform(256);
    }
    char hex[33];
    for (size_t i = 0; i < sizeof(b); i++) snprintf(hex + i * 2, 3, "%02x", b[i]);
    return [[NSString alloc] initWithBytes:hex length:32 encoding:NSASCIIStringEncoding];
}

// the ports browsers never connect to (WebKit's list): WebCore checks only the proxy's own address
static BOOL BRPortAllowed(int port)
{
    static const int blocked[] = { 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 77, 79, 87, 95, 101, 102,
        103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 139, 143, 179, 389, 465, 512, 513, 514, 515, 526, 530, 531, 532,
        540, 556, 563, 587, 601, 636, 993, 995, 2049, 3659, 4045, 6000, 6665, 6666, 6667, 6668, 6669 };
    if (port <= 0 || port > 65535) return NO;
    for (size_t i = 0; i < sizeof(blocked) / sizeof(blocked[0]); i++) if (blocked[i] == port) return NO;
    return YES;
}

// What the proxies relay to: the web, never this device (its own services, the proxy itself) nor a blocked port
static BOOL BRRelayTargetAllowed(NSURL *url, BOOL webSocket)
{
    NSString *scheme = [url.scheme lowercaseString];
    BOOL secure = [scheme isEqualToString:webSocket ? @"wss" : @"https"], plain = [scheme isEqualToString:webSocket ? @"ws" : @"http"];
    if ((!secure && !plain) || !url.host.length || [BRTLSSocket isLoopbackHost:url.host]) return NO;
    return BRPortAllowed(url.port ? url.port.intValue : (secure ? 443 : 80));
}

// The page's address for the media server as browsers send it by default (strict-origin-when-cross-origin): all of it
// to the page's own origin, the origin alone to others, nothing from https to plain http (a page URL can hold tokens)
static NSString *BRRefererFor(NSURL *page, NSURL *target)
{
    NSString *ps = [page.scheme lowercaseString], *ts = [target.scheme lowercaseString];
    if (!page.host.length || !([ps isEqualToString:@"http"] || [ps isEqualToString:@"https"])) return nil;
    if ([ps isEqualToString:@"https"] && ![ts isEqualToString:@"https"]) return nil;
    int pp = page.port ? page.port.intValue : ([ps isEqualToString:@"https"] ? 443 : 80);
    int tp = target.port ? target.port.intValue : ([ts isEqualToString:@"https"] ? 443 : 80);
    if ([ps isEqualToString:ts] && pp == tp && [[page.host lowercaseString] isEqualToString:[target.host lowercaseString]]) {
        NSString *s = page.absoluteString;
        NSRange hash = [s rangeOfString:@"#"];
        return hash.location == NSNotFound ? s : [s substringToIndex:hash.location];
    }
    NSString *host = [page.host rangeOfString:@":"].location != NSNotFound ? [NSString stringWithFormat:@"[%@]", page.host] : page.host;
    return page.port ? [NSString stringWithFormat:@"%@://%@:%@/", ps, host, page.port] : [NSString stringWithFormat:@"%@://%@/", ps, host];
}

// the media type of a Content-Type value: lowercase, without parameters
static NSString *BRBareMediaType(NSString *value)
{
    NSString *t = [value lowercaseString] ?: @"";
    NSRange semi = [t rangeOfString:@";"];
    if (semi.location != NSNotFound) t = [t substringToIndex:semi.location];
    return [t stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
}

// The types the proxy passes on as they come: audio and video, the playlists of HLS and DASH, WebVTT subtitles, bytes
// of no stated kind. Any other type goes as application/octet-stream - its origin, 127.0.0.1, never serves a page, a
// script or data as such - but the bytes still go: servers label stream parts oddly (a key as text/plain or
// application/pgp-keys, a .ts part as text/plain from a type map), and a refused key stops the whole stream. WebKit
// never loads the proxy's address (BRURLProtocol refuses it), and every answer carries nosniff.
static BOOL BRIsMediaType(NSString *type)
{
    if ([type hasPrefix:@"audio/"] || [type hasPrefix:@"video/"]) return YES;
    static NSSet *types;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        types = [NSSet setWithObjects:@"application/vnd.apple.mpegurl", @"application/x-mpegurl", @"application/mpegurl", @"application/dash+xml",
                 @"application/octet-stream", @"binary/octet-stream", @"application/mp4", @"application/ogg", @"text/vtt", nil];
    });
    return [types containsObject:type];
}

static NSString *BRBase64(const unsigned char *p, size_t n)
{
    static const char *T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    NSMutableString *s = [NSMutableString stringWithCapacity:(n + 2) / 3 * 4];
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)p[i] << 16 | (i + 1 < n ? (uint32_t)p[i + 1] << 8 : 0) | (i + 2 < n ? (uint32_t)p[i + 2] : 0);
        [s appendFormat:@"%c%c%c%c", T[(v >> 18) & 63], T[(v >> 12) & 63], i + 1 < n ? T[(v >> 6) & 63] : '=', i + 2 < n ? T[v & 63] : '='];
    }
    return s;
}

// Sec-WebSocket-Accept for a Sec-WebSocket-Key (RFC 6455)
static NSString *BRWebSocketAccept(NSString *key)
{
    NSData *d = [[key stringByAppendingString:@"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"] dataUsingEncoding:NSASCIIStringEncoding];
    unsigned char digest[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(d.bytes, (CC_LONG)d.length, digest);
    return BRBase64(digest, sizeof(digest));
}

// The lines of a request or response head: the first line's words, and the headers with lowercase names (Set-Cookie
// values collected apart)
static NSDictionary *BRParseHead(NSData *head, NSArray **firstLine, NSMutableArray *setCookies)
{
    NSString *text = [[NSString alloc] initWithData:head encoding:NSISOLatin1StringEncoding] ?: @"";
    NSArray *lines = [text componentsSeparatedByString:@"\r\n"];
    if (firstLine) *firstLine = [lines.firstObject componentsSeparatedByString:@" "];
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    for (NSUInteger i = 1; i < lines.count; i++) {
        NSRange colon = [lines[i] rangeOfString:@":"];
        if (colon.location == NSNotFound) continue;
        NSString *name = [[lines[i] substringToIndex:colon.location] lowercaseString];
        NSString *value = [[lines[i] substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if ([name isEqualToString:@"set-cookie"]) { [setCookies addObject:value]; continue; }
        headers[name] = value;
    }
    return headers;
}

// (cookies go with the media request only to the page's own site when third-party cookies are blocked, as in
// BRURLProtocol: the registrable domain is the last two labels)
static BOOL BRMediaSameSite(NSURL *a, NSURL *b)
{
    NSString *ha = [a.host lowercaseString], *hb = [b.host lowercaseString];
    if (!ha.length || !hb.length || [ha isEqualToString:hb]) return YES;
    NSArray *pa = [ha componentsSeparatedByString:@"."], *pb = [hb componentsSeparatedByString:@"."];
    if (pa.count < 2 || pb.count < 2) return NO;
    return [pa[pa.count - 1] isEqualToString:pb[pb.count - 1]] && [pa[pa.count - 2] isEqualToString:pb[pb.count - 2]];
}

static BOOL BRSendAll(int fd, const void *bytes, size_t length)
{
    const char *p = bytes;
    while (length > 0) {
        ssize_t n = send(fd, p, length, 0);
        if (n < 0) { if (errno == EINTR) continue; return NO; }
        if (n == 0) return NO;
        p += n;
        length -= (size_t)n;
    }
    return YES;
}

static BOOL BRSendString(int fd, NSString *s)
{
    NSData *d = [s dataUsingEncoding:NSISOLatin1StringEncoding allowLossyConversion:YES];
    return BRSendAll(fd, d.bytes, d.length);
}

static NSString *BRReasonPhrase(NSInteger status)
{
    switch (status) {
        case 200: return @"OK";
        case 206: return @"Partial Content";
        case 304: return @"Not Modified";
        case 400: return @"Bad Request";
        case 403: return @"Forbidden";
        case 404: return @"Not Found";
        case 416: return @"Range Not Satisfiable";
        case 502: return @"Bad Gateway";
        default: return @"Status";
    }
}

// the response head for the player: the headers of the file (the length only when the body is passed as it came).
// Nothing of the proxy is for another origin (no Access-Control-Allow-Origin), nor to be taken for another type.
static NSString *BRResponseHead(NSInteger status, NSDictionary *headers, BOOL keepLength)
{
    NSMutableString *s = [NSMutableString stringWithFormat:@"HTTP/1.1 %ld %@\r\n", (long)status, BRReasonPhrase(status)];
    NSArray *names = @[@[@"content-type", @"Content-Type"], @[@"content-length", @"Content-Length"], @[@"content-range", @"Content-Range"],
                       @[@"accept-ranges", @"Accept-Ranges"], @[@"last-modified", @"Last-Modified"], @[@"etag", @"ETag"],
                       @[@"cache-control", @"Cache-Control"], @[@"expires", @"Expires"]];
    for (NSArray *n in names) {
        NSString *v = headers[n[0]];
        if (!v.length || ([n[0] isEqualToString:@"content-length"] && !keepLength)) continue;
        [s appendFormat:@"%@: %@\r\n", n[1], v];
    }
    [s appendString:@"X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"];
    return s;
}

// a status without a body (refusals, and the errors of the server asked: no error page goes to the player)
static NSString *BRBareResponse(NSInteger status)
{
    return [NSString stringWithFormat:@"HTTP/1.1 %ld %@\r\nContent-Length: 0\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
            (long)status, BRReasonPhrase(status)];
}

// No secure socket came of it (the server's certificate refused, or the TLS connection failed once it existed - see
// relayWebSocket): WebCore's handshake is answered and the socket closed at once with reason "tls", which the page shims
// turn into what a failed TLS handshake gives the page (an error, close 1015). (The shims never try the engine's own
// socket - the system's old TLS and root store - once the app gave a relay address, however the relay fails.) The code
// is 4015, of the private range: WebCore fails a socket whose close frame carries the reserved 1015 (RFC 6455 7.4.1),
// and the page would see 1006 without the reason.
static void BRWebSocketCloseForTLS(int fd, NSDictionary *client)
{
    NSMutableString *reply = [NSMutableString stringWithFormat:@"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %@\r\n",
                              BRWebSocketAccept(client[@"sec-websocket-key"])];
    // (a protocol WebCore asked for is named back: no engine may take the answer for a failed handshake)
    NSString *protocols = client[@"sec-websocket-protocol"];
    NSString *first = protocols.length ? [[[protocols componentsSeparatedByString:@","] firstObject] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] : nil;
    if (first.length) [reply appendFormat:@"Sec-WebSocket-Protocol: %@\r\n", first];
    [reply appendString:@"\r\n"];
    static const unsigned char frame[] = { 0x88, 0x05, 0x0F, 0xAF, 't', 'l', 's' };   // FIN + close, 5 bytes: 4015, "tls"
    if (!BRSendString(fd, reply) || !BRSendAll(fd, frame, sizeof(frame))) return;
    // (WebCore answers with a close frame of its own: waited for briefly, so that the socket closes cleanly)
    struct timeval tv = { 2, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    unsigned char buf[256];
    recv(fd, buf, sizeof(buf), 0);
}

@implementation BRMediaProxy

+ (instancetype)shared
{
    static BRMediaProxy *proxy;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        proxy = [[BRMediaProxy alloc] init];
        [proxy startServer];
    });
    return proxy;
}

+ (BOOL)isProxyURL:(NSURL *)url
{
    uint16_t port = g_proxyPort;
    return port && url.port && url.port.intValue == (int)port && [BRTLSSocket isLoopbackHost:url.host];
}

- (void)startServer
{
    self.entries = [NSMutableDictionary dictionary];
    self.tokensByURL = [NSMutableDictionary dictionary];
    self.order = [NSMutableArray array];
    self.wsEntries = [NSMutableDictionary dictionary];
    self.wsOrder = [NSMutableArray array];
    self.listenFD = -1;
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd < 0) { BRLog(@"Media proxy: no socket (%d)", errno); return; }
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_len = sizeof(addr);
    addr.sin_family = AF_INET;
    addr.sin_port = 0;   // (any free port)
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t length = sizeof(addr);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(fd, 32) != 0 || getsockname(fd, (struct sockaddr *)&addr, &length) != 0) {
        BRLog(@"Media proxy: cannot listen (%d)", errno);
        close(fd);
        return;
    }
    self.port = ntohs(addr.sin_port);
    self.listenFD = fd;
    g_proxyPort = self.port;
    // (the app's own network layer never connects here, by whatever name: the player and WebCore are the clients)
    [BRTLSSocket reserveLoopbackPort:self.port];
    [NSThread detachNewThreadSelector:@selector(acceptLoop) toTarget:self withObject:nil];
    BRLog(@"Media proxy listening on 127.0.0.1:%u", self.port);
}

- (NSString *)proxyURLStringForURL:(NSURL *)url pageURL:(NSURL *)pageURL
{
    if (self.listenFD < 0 || !url.absoluteString.length || !BRRelayTargetAllowed(url, NO)) return nil;
    NSString *token;
    @synchronized (self) {
        // (one address per file and page: a live playlist names the same parts again and again)
        NSString *key = [NSString stringWithFormat:@"%@ %@", pageURL.absoluteString ?: @"", url.absoluteString];
        token = self.tokensByURL[key];
        if (!token) {
            token = BRRandomToken();
            self.entries[token] = @[url, pageURL ?: url, key];
            self.tokensByURL[key] = token;
            [self.order addObject:token];
            while (self.order.count > BRMediaProxyMaxEntries) {
                NSString *old = self.order[0];
                NSArray *e = self.entries[old];
                if (e) [self.tokensByURL removeObjectForKey:e[2]];
                [self.entries removeObjectForKey:old];
                [self.order removeObjectAtIndex:0];
            }
        }
    }
    // (the last part of the path keeps the kind of file for the player: .m3u8, .mp4)
    NSString *last = url.lastPathComponent.length && ![url.lastPathComponent isEqualToString:@"/"] ? url.lastPathComponent : @"media";
    last = [last stringByAddingPercentEscapesUsingEncoding:NSUTF8StringEncoding] ?: @"media";
    return [NSString stringWithFormat:@"http://127.0.0.1:%u/%@/%@", self.port, token, last];
}

- (NSString *)webSocketURLStringForURL:(NSURL *)url pageURL:(NSURL *)pageURL
{
    if (self.listenFD < 0 || !BRRelayTargetAllowed(url, YES)) return nil;
    NSString *token = BRRandomToken();
    @synchronized (self) {
        self.wsEntries[token] = @[url, pageURL ?: url];
        [self.wsOrder addObject:token];
        while (self.wsOrder.count > BRWebSocketMaxEntries) {
            [self.wsEntries removeObjectForKey:self.wsOrder[0]];
            [self.wsOrder removeObjectAtIndex:0];
        }
    }
    return [NSString stringWithFormat:@"ws://127.0.0.1:%u/%@", self.port, token];
}

// (taken: one connection per token)
- (NSArray *)webSocketEntryForPath:(NSString *)path
{
    NSArray *parts = [path componentsSeparatedByString:@"/"];   // "", token
    if (parts.count != 2 || ![parts[1] length]) return nil;
    @synchronized (self) {
        NSArray *entry = self.wsEntries[parts[1]];
        if (entry) { [self.wsEntries removeObjectForKey:parts[1]]; [self.wsOrder removeObject:parts[1]]; }
        return entry;
    }
}

- (NSArray *)entryForPath:(NSString *)path
{
    NSArray *parts = [path componentsSeparatedByString:@"/"];   // "", token, name
    if (parts.count < 3 || ![parts[1] length]) return nil;
    @synchronized (self) { return self.entries[parts[1]]; }
}

// Only requests for this address: a load of another name that resolves here (DNS rebinding) names that one. (No Host
// at all is no engine's request: WebCore, the player and the app's network layer all send one.)
- (BOOL)hostAllowed:(NSString *)host
{
    if (!host) return YES;
    NSString *h = [host lowercaseString];
    return [h isEqualToString:@"127.0.0.1"] || [h isEqualToString:[NSString stringWithFormat:@"127.0.0.1:%u", self.port]];
}

- (void)acceptLoop
{
    @autoreleasepool { [[NSThread currentThread] setName:@"BRMediaProxy"]; }
    for (;;) {
        @autoreleasepool {
            int c = accept(self.listenFD, NULL, NULL);
            if (c < 0) {
                if (errno != EINTR) usleep(200000);
                continue;
            }
            int on = 1;
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
            [NSThread detachNewThreadSelector:@selector(serveConnection:) toTarget:self withObject:@(c)];
        }
    }
}

- (void)serveConnection:(NSNumber *)socketNumber
{
    @autoreleasepool {
        int fd = socketNumber.intValue;
        [[NSThread currentThread] setName:@"BRMediaProxy connection"];
        struct timeval tv = { 30, 0 };
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        NSMutableData *buffer = [NSMutableData data];
        NSData *blank = [@"\r\n\r\n" dataUsingEncoding:NSASCIIStringEncoding];
        NSRange end = NSMakeRange(NSNotFound, 0);
        char chunk[4096];
        while (buffer.length < 32768) {
            ssize_t n = recv(fd, chunk, sizeof(chunk), 0);
            if (n <= 0) break;
            [buffer appendBytes:chunk length:(NSUInteger)n];
            end = [buffer rangeOfData:blank options:0 range:NSMakeRange(0, buffer.length)];
            if (end.location != NSNotFound) break;
        }
        if (end.location == NSNotFound) { close(fd); return; }
        NSString *head = [[NSString alloc] initWithData:[buffer subdataWithRange:NSMakeRange(0, end.location)] encoding:NSISOLatin1StringEncoding];
        NSArray *lines = [head componentsSeparatedByString:@"\r\n"];
        NSArray *requestLine = [lines.firstObject componentsSeparatedByString:@" "];
        NSString *method = requestLine.count >= 2 ? [requestLine[0] uppercaseString] : nil;
        NSMutableDictionary *headers = [NSMutableDictionary dictionary];
        for (NSUInteger i = 1; i < lines.count; i++) {
            NSRange colon = [lines[i] rangeOfString:@":"];
            if (colon.location == NSNotFound) continue;
            headers[[[lines[i] substringToIndex:colon.location] lowercaseString]] =
                [[lines[i] substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        }
        if (![self hostAllowed:headers[@"host"]]) {
            BRSendString(fd, BRBareResponse(403));
            close(fd);
            return;
        }
        NSArray *socketEntry = requestLine.count >= 2 && [method isEqualToString:@"GET"] ? [self webSocketEntryForPath:requestLine[1]] : nil;
        if (socketEntry) {
            NSUInteger after = end.location + end.length;
            NSData *early = after < buffer.length ? [buffer subdataWithRange:NSMakeRange(after, buffer.length - after)] : nil;
            [self relayWebSocket:socketEntry headers:headers early:early to:fd];
            close(fd);
            return;
        }
        NSArray *entry = requestLine.count >= 2 ? [self entryForPath:requestLine[1]] : nil;
        if (!entry || !([method isEqualToString:@"GET"] || [method isEqualToString:@"HEAD"])) {
            BRSendString(fd, BRBareResponse(404));
            close(fd);
            return;
        }
        [self relayEntry:entry method:method headers:headers to:fd];
        close(fd);
    }
}

// One request of the player, through the app's network layer: redirects followed here (to web addresses only), the
// body passed on as it comes (a player that lets go ends the request), an HLS playlist rewritten first. Only media
// types go to the player (another goes as bytes of no stated kind, see BRIsMediaType), an error status without its page.
- (void)relayEntry:(NSArray *)entry method:(NSString *)method headers:(NSDictionary *)playerHeaders to:(int)fd
{
    NSURL *url = entry[0], *page = entry[1];
    for (int hop = 0; hop < 6; hop++) {
        NSMutableDictionary *h = [NSMutableDictionary dictionary];
        h[@"Accept"] = playerHeaders[@"accept"] ?: @"*/*";
        if (playerHeaders[@"range"]) h[@"Range"] = playerHeaders[@"range"];
        if (playerHeaders[@"if-range"]) h[@"If-Range"] = playerHeaders[@"if-range"];
        NSString *referer = page && ![page isEqual:url] ? BRRefererFor(page, url) : nil;
        if (referer) h[@"Referer"] = referer;
        if (![BRSettings blockThirdPartyCookies] || BRMediaSameSite(url, page)) {
            NSArray *cookies = nil;
            @synchronized (BRCookieLock()) { cookies = [[NSHTTPCookieStorage sharedHTTPCookieStorage] cookiesForURL:url]; }
            NSString *cookie = cookies.count ? [NSHTTPCookie requestHeaderFieldsWithCookies:cookies][@"Cookie"] : nil;
            if (cookie.length) h[@"Cookie"] = cookie;
        }
        BRHTTPRequest *r = [[BRHTTPRequest alloc] initWithMethod:method URL:url];
        r.headers = h;
        r.verifyTLS = [BRSettings verifyTLS];
        r.highPriority = YES;   // (a stream holds its connection for minutes: none of the page's connection slots)
        r.connectTimeout = 20;
        r.readTimeout = 60;
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block NSURL *redirect = nil;
        __block BOOL playlist = NO, headSent = NO, broken = NO, tooBig = NO;
        __block NSInteger playlistStatus = 200;
        __block NSDictionary *playlistHeaders = nil;
        NSMutableData *collected = [NSMutableData data];
        __weak BRHTTPRequest *weakR = r;
        r.onHeaders = ^(NSInteger status, NSDictionary *hdrs) {
            NSString *location = hdrs[@"location"];
            if (status >= 300 && status < 400 && status != 304 && location.length) {
                redirect = [[NSURL URLWithString:location relativeToURL:url] absoluteURL];
                return;
            }
            NSString *type = BRBareMediaType(hdrs[@"content-type"]);
            BOOL ok = status >= 200 && status < 300;
            // (the playlist's text stays here: what the player gets is the rewritten one, of the playlist type)
            playlist = ok && ([type rangeOfString:@"mpegurl"].location != NSNotFound || [[url.path lowercaseString] hasSuffix:@".m3u8"]);
            if (playlist) { playlistStatus = status; playlistHeaders = hdrs; return; }
            headSent = YES;
            if (!ok) BRSendString(fd, BRBareResponse(status));
            else {
                NSString *encoding = [hdrs[@"content-encoding"] lowercaseString] ?: @"";
                BOOL keepLength = !encoding.length || [encoding isEqualToString:@"identity"];
                NSMutableDictionary *media = [hdrs mutableCopy];
                if (!BRIsMediaType(type)) media[@"content-type"] = @"application/octet-stream";   // (none, or not media's)
                if (BRSendString(fd, BRResponseHead(status, media, keepLength))) return;
            }
            // (nothing more goes to the player: an error status has no body here)
            broken = YES;
            [weakR cancel];
        };
        r.onData = ^(NSData *data) {
            if (redirect || broken) return;
            if (playlist) {
                if (collected.length + data.length > BRMaxPlaylistBytes) { tooBig = broken = YES; [weakR cancel]; return; }
                [collected appendData:data];
                return;
            }
            if (!BRSendAll(fd, data.bytes, data.length)) { broken = YES; [weakR cancel]; }
        };
        r.onComplete = ^(NSError *error) { dispatch_semaphore_signal(done); };
        [r start];
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        if (redirect && !broken) {
            if (!BRRelayTargetAllowed(redirect, NO)) {
                BRLog(@"Media proxy: redirect of %@ to an address it does not relay to", url.host);
                BRSendString(fd, BRBareResponse(403));
                return;
            }
            url = redirect;
            continue;
        }
        if (tooBig) {
            BRSendString(fd, BRBareResponse(502));
            return;
        }
        if (playlist && !broken) {
            NSString *text = [[NSString alloc] initWithData:collected encoding:NSUTF8StringEncoding] ?: [[NSString alloc] initWithData:collected encoding:NSISOLatin1StringEncoding] ?: @"";
            NSData *body = [[self rewritePlaylist:text baseURL:url pageURL:page] dataUsingEncoding:NSUTF8StringEncoding];
            NSMutableDictionary *hh = [playlistHeaders mutableCopy] ?: [NSMutableDictionary dictionary];
            hh[@"content-type"] = @"application/vnd.apple.mpegurl";
            hh[@"content-length"] = [NSString stringWithFormat:@"%lu", (unsigned long)body.length];
            [hh removeObjectForKey:@"content-range"];
            if (BRSendString(fd, BRResponseHead(playlistStatus == 206 ? 200 : playlistStatus, hh, YES)) && ![method isEqualToString:@"HEAD"]) BRSendAll(fd, body.bytes, body.length);
            return;
        }
        if (!headSent && !broken) BRSendString(fd, BRBareResponse(502));
        return;
    }
    BRSendString(fd, BRBareResponse(502));   // (redirected too often)
}

// One WebSocket of the page: the real one opened through the app's network layer, then WebCore's handshake answered,
// then the bytes passed both ways on this thread (poll on both sockets; the TLS socket is used from this thread only).
- (void)relayWebSocket:(NSArray *)entry headers:(NSDictionary *)client early:(NSData *)early to:(int)fd
{
    NSURL *url = entry[0], *page = entry[1];
    NSString *key = client[@"sec-websocket-key"];
    if (!key.length || ![[client[@"upgrade"] lowercaseString] isEqualToString:@"websocket"]) {
        BRSendString(fd, BRBareResponse(400));
        return;
    }
    if (!BRRelayTargetAllowed(url, YES)) {   // (as the entry was made; this device's own services never)
        BRSendString(fd, BRBareResponse(403));
        return;
    }
    BOOL secure = [[url.scheme lowercaseString] isEqualToString:@"wss"], verify = [BRSettings verifyTLS];
    int port = url.port ? url.port.intValue : (secure ? 443 : 80);
    NSString *host = url.host;
    // A checked wss:// socket that fails once the connection to the server exists closes with "tls" (see
    // BRWebSocketCloseForTLS): an attacker on the way who cannot pass the certificate check can still send an alert,
    // garble the certificate, or go silent. Failures before the connection (the name, the TCP connect) and a refusal the
    // server itself sent through the checked TLS answer 502; the page shims give the page an error and a close for both,
    // with no second try over the system's TLS.
    BOOL guarded = secure && verify;
    // (the same address as http(s), for the cookie jar)
    NSURL *httpURL = [NSURL URLWithString:[(secure ? @"https" : @"http") stringByAppendingString:[url.absoluteString substringFromIndex:url.scheme.length]]] ?: url;
    BRTLSSocket *up = [[BRTLSSocket alloc] init];
    up.plain = !secure;
    NSError *error = nil;
    if (![up connectToHost:host port:port verify:verify connectTimeoutMs:20000 readTimeoutMs:20000 error:&error]) {
        BRLog(@"WebSocket proxy: %@ failed: %@", host, error.localizedDescription);
        BOOL certificate = [error.domain isEqualToString:BRErrorDomain] && error.code == BRErrorCertificate;
        // (the descriptor stays set until close once the TCP connection was made: the TLS handshake failed or timed out)
        if (certificate || (guarded && up.fileDescriptor >= 0)) BRWebSocketCloseForTLS(fd, client);
        else BRSendString(fd, BRBareResponse(502));
        [up close];
        return;
    }
    // the request target: path and query as written, no fragment
    NSString *abs = url.absoluteString;
    NSRange schemeEnd = [abs rangeOfString:@"://"];
    NSString *rest = schemeEnd.location == NSNotFound ? abs : [abs substringFromIndex:schemeEnd.location + 3];
    NSRange slash = [rest rangeOfString:@"/"], query = [rest rangeOfString:@"?"];
    NSString *target = slash.location != NSNotFound && (query.location == NSNotFound || slash.location < query.location) ? [rest substringFromIndex:slash.location] :
        query.location != NSNotFound ? [@"/" stringByAppendingString:[rest substringFromIndex:query.location]] : @"/";
    NSRange hash = [target rangeOfString:@"#"];
    if (hash.location != NSNotFound) target = [target substringToIndex:hash.location];
    unsigned char nonce[16];
    for (int i = 0; i < 16; i++) nonce[i] = (unsigned char)arc4random_uniform(256);
    NSString *upKey = BRBase64(nonce, sizeof(nonce));
    BOOL defaultPort = (secure && port == 443) || (!secure && port == 80);
    NSMutableString *req = [NSMutableString stringWithFormat:@"GET %@ HTTP/1.1\r\nHost: %@\r\n", target, defaultPort ? host : [NSString stringWithFormat:@"%@:%d", host, port]];
    [req appendFormat:@"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %@\r\n", upKey];
    // (the page's own Origin, as WebCore sent it - the page's, not the proxy's: servers check it; no extensions, so the
    // frames stay as WebCore makes them)
    NSString *origin = client[@"origin"] ?: client[@"sec-websocket-origin"];
    if (origin.length) [req appendFormat:@"Origin: %@\r\n", origin];
    if (client[@"sec-websocket-protocol"]) [req appendFormat:@"Sec-WebSocket-Protocol: %@\r\n", client[@"sec-websocket-protocol"]];
    [req appendFormat:@"User-Agent: %@\r\n", [BRSettings userAgentOverrideForURL:httpURL] ?: [BRHTTPRequest defaultUserAgent]];
    if (client[@"accept-language"]) [req appendFormat:@"Accept-Language: %@\r\n", client[@"accept-language"]];
    [req appendString:@"Pragma: no-cache\r\nCache-Control: no-cache\r\n"];
    BOOL cookiesAllowed = ![BRSettings blockThirdPartyCookies] || BRMediaSameSite(url, page);
    if (cookiesAllowed) {
        NSArray *cookies = nil;
        @synchronized (BRCookieLock()) { cookies = [[NSHTTPCookieStorage sharedHTTPCookieStorage] cookiesForURL:httpURL]; }
        NSString *cookie = cookies.count ? [NSHTTPCookie requestHeaderFieldsWithCookies:cookies][@"Cookie"] : nil;
        if (cookie.length) [req appendFormat:@"Cookie: %@\r\n", cookie];
    }
    [req appendString:@"\r\n"];
    if (![up writeData:[req dataUsingEncoding:NSUTF8StringEncoding] error:&error]) {
        BRLog(@"WebSocket proxy: %@ handshake not sent: %@", host, error.localizedDescription);
        if (guarded) BRWebSocketCloseForTLS(fd, client);
        else BRSendString(fd, BRBareResponse(502));
        [up close];
        return;
    }
    // the server's answer
    NSMutableData *acc = [NSMutableData data];
    NSData *blank = [@"\r\n\r\n" dataUsingEncoding:NSASCIIStringEncoding];
    NSRange headEnd = NSMakeRange(NSNotFound, 0);
    unsigned char buf[16384];
    while (acc.length < 65536) {
        NSInteger n = [up readIntoBuffer:buf maxLength:sizeof(buf) error:&error];
        if (n <= 0) break;
        [acc appendBytes:buf length:(NSUInteger)n];
        headEnd = [acc rangeOfData:blank options:0 range:NSMakeRange(0, acc.length)];
        if (headEnd.location != NSNotFound) break;
    }
    NSArray *status = nil;
    NSMutableArray *setCookies = [NSMutableArray array];
    NSDictionary *answer = headEnd.location != NSNotFound ? BRParseHead([acc subdataWithRange:NSMakeRange(0, headEnd.location)], &status, setCookies) : nil;
    if (!answer || status.count < 2 || ![status[1] isEqualToString:@"101"] ||
        ![answer[@"sec-websocket-accept"] isEqualToString:BRWebSocketAccept(upKey)]) {
        BRLog(@"WebSocket proxy: %@ refused (%@)", host, status.count >= 2 ? status[1] : (error.localizedDescription ?: @"no answer"));
        // (no answer is the connection failing, see above; an answer is the server's own refusal)
        if (guarded && !answer) BRWebSocketCloseForTLS(fd, client);
        else BRSendString(fd, BRBareResponse(502));
        [up close];
        return;
    }
    if (cookiesAllowed && setCookies.count) {
        NSHTTPCookieStorage *jar = [NSHTTPCookieStorage sharedHTTPCookieStorage];
        for (NSString *value in setCookies) {
            NSArray *cookies = [NSHTTPCookie cookiesWithResponseHeaderFields:@{ @"Set-Cookie": value } forURL:httpURL];
            if (cookies.count) { @synchronized (BRCookieLock()) { [jar setCookies:cookies forURL:httpURL mainDocumentURL:page ?: httpURL]; } }
        }
    }
    // WebCore's handshake answered
    NSMutableString *reply = [NSMutableString stringWithFormat:@"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %@\r\n", BRWebSocketAccept(key)];
    if (answer[@"sec-websocket-protocol"]) [reply appendFormat:@"Sec-WebSocket-Protocol: %@\r\n", answer[@"sec-websocket-protocol"]];
    [reply appendString:@"\r\n"];
    NSUInteger after = headEnd.location + headEnd.length;
    BOOL ok = BRSendString(fd, reply) && (after >= acc.length || BRSendAll(fd, (const char *)acc.bytes + after, acc.length - after));
    if (ok && early.length) ok = [up writeData:early error:NULL];
    BRLog(@"WebSocket proxy: %@ open (%@)", host, secure ? (up.tlsVersion ?: @"TLS") : @"plain");
    // (a record that started arriving is complete within this; between frames the sockets wait in poll)
    [up setReadTimeoutMs:15000];
    // (a pool per round: a socket stays open for hours, and what a round autoreleases must not pile up till then)
    while (ok) {
        @autoreleasepool {
            if ([up hasBufferedData]) {
                NSInteger n = [up readIntoBuffer:buf maxLength:sizeof(buf) error:NULL];
                if (n <= 0 || !BRSendAll(fd, buf, (size_t)n)) ok = NO;
                continue;
            }
            struct pollfd p[2] = { { fd, POLLIN, 0 }, { up.fileDescriptor, POLLIN, 0 } };
            int r = poll(p, 2, 60000);
            if (r < 0) { if (errno != EINTR) ok = NO; continue; }
            if (r == 0) continue;
            if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) {
                ssize_t n = recv(fd, buf, sizeof(buf), 0);
                if (n <= 0 || ![up writeData:[NSData dataWithBytesNoCopy:buf length:(NSUInteger)n freeWhenDone:NO] error:NULL]) { ok = NO; continue; }
            }
            if (p[1].revents & (POLLIN | POLLHUP | POLLERR)) {
                NSInteger n = [up readIntoBuffer:buf maxLength:sizeof(buf) error:NULL];
                if (n <= 0 || !BRSendAll(fd, buf, (size_t)n)) ok = NO;
            }
        }
    }
    BRLog(@"WebSocket proxy: %@ closed", host);
    [up close];
}

// Every URI of an HLS playlist (media lines, URI="..." of keys, maps, renditions) as an absolute proxy URL.
- (NSString *)rewritePlaylist:(NSString *)text baseURL:(NSURL *)base pageURL:(NSURL *)page
{
    NSRegularExpression *uriAttr = [NSRegularExpression regularExpressionWithPattern:@"URI=\"([^\"]+)\"" options:0 error:NULL];
    NSMutableArray *out = [NSMutableArray array];
    for (NSString *line in [text componentsSeparatedByCharactersInSet:[NSCharacterSet newlineCharacterSet]]) {
        NSString *t = [line stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (!t.length) continue;
        if ([t hasPrefix:@"#"]) {
            NSMutableString *m = [t mutableCopy];
            NSArray *found = [uriAttr matchesInString:t options:0 range:NSMakeRange(0, t.length)];
            for (NSTextCheckingResult *r in [found reverseObjectEnumerator]) {
                NSURL *abs = [[NSURL URLWithString:[t substringWithRange:[r rangeAtIndex:1]] relativeToURL:base] absoluteURL];
                NSString *proxied = abs ? [self proxyURLStringForURL:abs pageURL:page] : nil;
                if (proxied) [m replaceCharactersInRange:[r rangeAtIndex:1] withString:proxied];
            }
            [out addObject:m];
            continue;
        }
        NSURL *abs = [[NSURL URLWithString:t relativeToURL:base] absoluteURL];
        [out addObject:(abs ? [self proxyURLStringForURL:abs pageURL:page] : nil) ?: t];
    }
    return [[out componentsJoinedByString:@"\n"] stringByAppendingString:@"\n"];
}

@end
