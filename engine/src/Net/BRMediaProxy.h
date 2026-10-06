#import <Foundation/Foundation.h>

// The media player of iOS 6 loads audio and video with the system's own network stack, which cannot talk to servers
// that offer only current TLS ciphers (developer.mozilla.org's videos: error 4, while the page itself loads through
// the app's network layer). This small HTTP server on 127.0.0.1 hands such media to the player through the app's
// network layer instead: when a media element fails, the page shim asks /mediaproxy (BRURLProtocol) for a proxy URL
// and plays that. Range requests pass through (seeking); HLS playlists are rewritten so that their parts come
// through the proxy too. Every URL handed out has a random token of its own, so only what the app handed out is
// served, and only as media: a type that is not media's (audio, video, playlists, subtitles) goes as
// application/octet-stream with nosniff, never as a page, a script or data an engine could run or read. The player is
// the only client: WebKit's own loads of the proxy's address are refused (BRURLProtocol, see isProxyURL:), and so is
// any request that names another host (DNS rebinding).
@interface BRMediaProxy : NSObject

+ (instancetype)shared;

// YES for a URL on the proxy's own port of this device (any scheme): such a load does not come from the player. Never
// starts the server.
+ (BOOL)isProxyURL:(NSURL *)url;

// http://127.0.0.1:<port>/<token>/<last path component>, or nil when the server could not start or the URL is no web
// address (this device's own names, ports browsers never use)
- (NSString *)proxyURLStringForURL:(NSURL *)url pageURL:(NSURL *)pageURL;

// WebSockets have the same trouble: WebCore opens wss:// with the system's TLS, which knows neither today's ciphers
// nor today's root certificates (Let's Encrypt), so most secure sockets failed. The page shim asks /wsproxy
// (BRURLProtocol) for ws://127.0.0.1:<port>/<token> instead; the server here answers WebCore's handshake,
// opens the real socket through the app's TLS (the page's Origin and protocols, the site's cookies) and passes the
// frames through untouched (WebCore masks what it sends, as a client must). One use per token. When the app's TLS
// refuses the server's certificate, or (certificates checked) a wss:// connection fails once it exists, the socket
// opens and closes at once with reason "tls" (code 4015: WebCore refuses a close frame with the reserved 1015; the
// shims give the page 1015). The shims never try the system's TLS once they have a relay address.
- (NSString *)webSocketURLStringForURL:(NSURL *)url pageURL:(NSURL *)pageURL;

@end
