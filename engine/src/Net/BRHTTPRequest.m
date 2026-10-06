#import "BRHTTPRequest.h"
#import "BRTLSSocket.h"
#import "BRConnectionPool.h"
#import "BRSettings.h"
#import "BRCommon.h"

#include <zlib.h>
#include <brotli/decode.h>
#include <string.h>
#include <stdlib.h>
#include <limits.h>

typedef NS_ENUM(NSInteger, BRChunkState) {
    BRChunkStateSize = 0,
    BRChunkStateData,
    BRChunkStateDataEnd,
    BRChunkStateTrailer,
    BRChunkStateDone,
};

typedef NS_ENUM(NSInteger, BRExchangeResult) {
    BRExchangeDone = 0,      // response fully received
    BRExchangeRetry,         // reused connection turned out to be dead before any response byte arrived
    BRExchangeFailed,
};

static const NSUInteger BRInflateBufferSize = 32768;
static const long BRMaxConcurrentConnections = 10;
static const uint32_t BRReusedConnectionHeaderTimeoutMs = 10000;   // stale keep-alive connections must fail fast

// What a server can make this client hold or produce. Real responses stay far below; past these a response is broken
// or hostile, and failing the request beats the jetsam kill that would follow on a 512 MB iPad.
static const NSUInteger BRMaxHeaderBlock = 64 * 1024;
static const NSUInteger BRMaxChunkLine = 8 * 1024;           // one chunk-size line (extensions included) or trailer line
static const NSUInteger BRMaxTrailer = 64 * 1024;            // all trailer lines together, like the headers
static const unsigned long long BRMaxChunkSize = 1ULL << 30; // one chunk: 1 GB
// gzip/deflate/br output. Documents, scripts, styles and data are kept whole by WebKit or the rewriter: past 64 MB of
// them the iPad is out of memory anyway. Anything else may be bigger, but not from a few MB on the wire.
// It counts all the output, not what is held: an event stream lives for hours and keeps nothing, so it has no limit
// (nor has a request with unlimitedDecodedSize, e.g. a download written to a file).
static const NSUInteger BRMaxDecodedDocument = 64 * 1024 * 1024, BRMaxDecodedOther = 128 * 1024 * 1024;
static const NSUInteger BRMaxBufferedBody = 16 * 1024 * 1024;   // a body collected in responseBody (no onData)

static unsigned long long BRDecodedLimitForType(NSString *contentType)
{
    NSString *t = [contentType lowercaseString] ?: @"";
    if ([t hasPrefix:@"text/event-stream"]) return ULLONG_MAX;
    if ([t hasPrefix:@"text/"] || [t rangeOfString:@"script"].location != NSNotFound ||
        [t rangeOfString:@"json"].location != NSNotFound || [t rangeOfString:@"xml"].location != NSNotFound) return BRMaxDecodedDocument;
    return BRMaxDecodedOther;
}

static inline int BRHexValue(uint8_t c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static dispatch_semaphore_t BRConnectionSlots(void)
{
    static dispatch_semaphore_t slots;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ slots = dispatch_semaphore_create(BRMaxConcurrentConnections); });
    return slots;
}

@interface BRHTTPRequest ()
@property (nonatomic, strong) BRTLSSocket *socket;
@property (nonatomic, strong) BRHTTPRequest *selfRetain;
@property (nonatomic) NSInteger statusCode;
@property (nonatomic, strong) NSDictionary *responseHeaders;
@property (nonatomic, strong) NSArray *responseHeaderPairs;
@property (nonatomic, strong) NSArray *setCookieHeaders;
@property (nonatomic, strong) NSData *responseBody;
@property (nonatomic) BOOL isCancelled;
@property (nonatomic) BOOL isFinished;
@property (nonatomic) BOOL decodedContentEncoding;
@property (nonatomic, copy) NSString *tlsInfo;
@property (nonatomic, strong) NSMutableData *accumulated;

// body decoding state
@property (nonatomic) BOOL chunked;
@property (nonatomic) long long contentLength;      // -1 unknown
@property (nonatomic) long long bodyReceived;       // raw (wire) body bytes
@property (nonatomic) BRChunkState chunkState;
@property (nonatomic) unsigned long long chunkRemaining;   // > 0 while in BRChunkStateData
@property (nonatomic) BOOL hasSlot;
@property (nonatomic) BOOL bodyError;
@property (nonatomic, strong) NSError *bodyFailure;        // why the body was refused (else bodyError means decoding failed)
@property (nonatomic) BOOL bodyTruncated;
@property (nonatomic) BOOL http11;
@property (nonatomic) BOOL connectionClose;         // server asked to close after this response
@property (nonatomic) BOOL noBody;                  // HEAD, 204, 304
@property (nonatomic) BOOL keepAlive;               // decided once the response is complete
@end

@implementation BRHTTPRequest {
    BrotliDecoderState *_br;  // Content-Encoding: br (https only; 15-25 % less than gzip on the wire)
    BOOL _bremoved;           // the brotli stream has ended
    z_stream _zstream;
    BOOL _zinit;
    BOOL _zactive;
    BOOL _zrawTried;          // the body was taken again as raw deflate (see deliverBodyBytes)
    unsigned long long _zproduced;    // decoded bytes so far (64 bits: an unlimited stream passes 4 GB)
    unsigned long long _decodedLimit; // the most _zproduced may reach (BRDecodedLimitForType)
    uint8_t *_zout;
    // Reads only add bytes to the receive buffer, so a search for a line end resumes where the previous one stopped
    // (rescanning from byte 0 on every 16 KB read was quadratic).
    NSUInteger _headerScan;
    NSUInteger _lineScan;
    NSUInteger _trailerBytes;
}

- (instancetype)initWithMethod:(NSString *)method URL:(NSURL *)url
{
    self = [super init];
    if (self) {
        _method = [method length] ? [method uppercaseString] : @"GET";
        _url = url;
        _connectTimeout = 20;
        _readTimeout = 60;
        _verifyTLS = YES;
        _contentLength = -1;
        _accumulated = [NSMutableData data];
    }
    return self;
}

- (void)dealloc
{
    if (_zinit) inflateEnd(&_zstream);
    if (_br) BrotliDecoderDestroyInstance(_br);
    free(_zout);
}

+ (NSString *)defaultUserAgent
{
    NSString *osv = [[UIDevice currentDevice].systemVersion stringByReplacingOccurrencesOfString:@"." withString:@"_"];
    NSString *device = BRIsPad() ? @"iPad" : @"iPhone";
    return [NSString stringWithFormat:@"Mozilla/5.0 (%@; CPU OS %@ like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/6.0 Mobile/10B146 Safari/8536.25", device, osv];
}

+ (NSString *)acceptLanguage
{
    NSArray *langs = [NSLocale preferredLanguages];
    NSMutableArray *parts = [NSMutableArray array];
    double q = 1.0;
    BOOL hasEnglish = NO;
    for (NSString *l in langs) {
        if (parts.count >= 4) break;
        if ([l hasPrefix:@"en"]) hasEnglish = YES;
        if (q >= 1.0) [parts addObject:l];
        else [parts addObject:[NSString stringWithFormat:@"%@;q=%.1f", l, q]];
        q -= 0.2;
    }
    if (!hasEnglish) [parts addObject:[NSString stringWithFormat:@"en;q=%.1f", MAX(0.1, q)]];
    return parts.count ? [parts componentsJoinedByString:@", "] : @"en";
}

- (void)start
{
    self.selfRetain = self;
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        @autoreleasepool {
            [self run];
        }
    });
}

- (void)cancel
{
    if (self.isFinished) return;
    self.isCancelled = YES;
    [self.socket cancel];
}

#pragma mark - Request

- (BOOL)isSecure
{
    return [[self.url.scheme lowercaseString] isEqualToString:@"https"];
}

- (int)port
{
    NSNumber *p = self.url.port;
    if (p) return [p intValue];
    return [self isSecure] ? 443 : 80;
}

- (NSString *)poolKey
{
    return [NSString stringWithFormat:@"%@://%@:%d", [self isSecure] ? @"https" : @"http", [self.url.host lowercaseString] ?: @"", [self port]];
}

// Path and query exactly as written in the URL (percent-encoded), without the fragment.
- (NSString *)requestTarget
{
    NSString *abs = self.url.absoluteString ?: @"/";
    NSRange schemeEnd = [abs rangeOfString:@"://"];
    NSString *rest = schemeEnd.location == NSNotFound ? abs : [abs substringFromIndex:schemeEnd.location + 3];
    NSRange slash = [rest rangeOfString:@"/"];
    NSString *target = slash.location == NSNotFound ? @"/" : [rest substringFromIndex:slash.location];
    NSRange hash = [target rangeOfString:@"#"];
    if (hash.location != NSNotFound) target = [target substringToIndex:hash.location];
    if (!target.length) target = @"/";
    return target;
}

- (NSData *)serializedRequest
{
    NSMutableString *s = [NSMutableString string];
    [s appendFormat:@"%@ %@ HTTP/1.1\r\n", self.method, [self requestTarget]];
    NSString *host = self.url.host ?: @"";
    int port = [self port];
    BOOL defaultPort = ([self isSecure] && port == 443) || (![self isSecure] && port == 80);
    [s appendFormat:@"Host: %@\r\n", defaultPort ? host : [NSString stringWithFormat:@"%@:%d", host, port]];
    NSMutableSet *given = [NSMutableSet set];
    NSString *uaOverride = [BRSettings userAgentOverrideForURL:self.url];
    for (NSString *key in self.headers) {
        NSString *lk = [key lowercaseString];
        if ([lk isEqualToString:@"host"] || [lk isEqualToString:@"content-length"] || [lk isEqualToString:@"connection"] ||
            [lk isEqualToString:@"accept-encoding"] || [lk isEqualToString:@"transfer-encoding"] || [lk isEqualToString:@"expect"] ||
            [lk isEqualToString:@"keep-alive"]) continue;
        if (uaOverride && [lk isEqualToString:@"user-agent"]) continue;
        NSString *value = [[self.headers[key] description] stringByReplacingOccurrencesOfString:@"\r" withString:@" "];
        value = [value stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
        [given addObject:lk];
        [s appendFormat:@"%@: %@\r\n", key, value];
    }
    if (uaOverride) [s appendFormat:@"User-Agent: %@\r\n", uaOverride];
    else if (![given containsObject:@"user-agent"]) [s appendFormat:@"User-Agent: %@\r\n", [BRHTTPRequest defaultUserAgent]];
    if (![given containsObject:@"accept"]) [s appendString:@"Accept: */*\r\n"];
    if (![given containsObject:@"accept-language"]) [s appendFormat:@"Accept-Language: %@\r\n", [BRHTTPRequest acceptLanguage]];
    if ([BRSettings doNotTrack] && ![given containsObject:@"dnt"]) [s appendString:@"DNT: 1\r\nSec-GPC: 1\r\n"];
    [s appendString:[self isSecure] ? @"Accept-Encoding: gzip, deflate, br\r\n" : @"Accept-Encoding: gzip, deflate\r\n"];
    [s appendString:@"Connection: keep-alive\r\n"];
    if (self.body || [self.method isEqualToString:@"POST"] || [self.method isEqualToString:@"PUT"] || [self.method isEqualToString:@"PATCH"]) {
        [s appendFormat:@"Content-Length: %lu\r\n", (unsigned long)self.body.length];
    }
    [s appendString:@"\r\n"];
    NSMutableData *d = [[s dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    if (self.body) [d appendData:self.body];
    return d;
}

#pragma mark - Completion

- (void)releaseSlot
{
    if (self.hasSlot) {
        self.hasSlot = NO;
        dispatch_semaphore_signal(BRConnectionSlots());
    }
}

- (void)finishWithError:(NSError *)error
{
    if (self.isFinished) return;
    self.isFinished = YES;
    [self.socket close];
    self.socket = nil;
    [self releaseSlot];
    if (!self.onData) self.responseBody = [self.accumulated copy];
    self.accumulated = nil;
    BRHTTPCompleteBlock done = self.onComplete;
    self.onComplete = nil;
    self.onData = nil;
    self.onHeaders = nil;
    if (done) done(error);
    self.selfRetain = nil;
}

#pragma mark - Body decoding

// The body breaks the HTTP framing or is more than this client will hold: the request fails with `message`
// (BRErrorBadResponse) and the connection is not reused. Returns YES, consumeBody's "stop here".
- (BOOL)refuseBody:(NSString *)message
{
    if (!self.bodyFailure) self.bodyFailure = BRMakeError(BRErrorBadResponse, message);
    self.bodyError = YES;
    return YES;
}

// Returns NO when the body was refused.
- (BOOL)deliverDecodedBytes:(const void *)bytes length:(NSUInteger)length
{
    if (!length) return YES;
    BRHTTPDataBlock cb = self.onData;
    if (cb) {
        cb([NSData dataWithBytes:bytes length:length]);
        return YES;
    }
    if (self.accumulated.length + length > BRMaxBufferedBody) {
        BRLog(@"Body over %lu MB refused for %@", (unsigned long)(BRMaxBufferedBody >> 20), self.url);
        [self refuseBody:L(@"The server's response is too large.")];
        return NO;
    }
    [self.accumulated appendBytes:bytes length:length];
    return YES;
}

// Counts decoded output against the limit for its type; NO (and the body refused) past it. A few MB of gzip can
// claim gigabytes (deflate packs 1000:1, brotli far more).
- (BOOL)noteDecodedBytes:(NSUInteger)produced
{
    _zproduced += produced;
    if (_zproduced <= _decodedLimit) return YES;
    BRLog(@"Decoded body over %lu MB refused for %@", (unsigned long)(_decodedLimit >> 20), self.url);
    [self refuseBody:L(@"The server's response is too large.")];
    return NO;
}

- (BOOL)setupInflate
{
    return [self setupInflateWindowBits:15 + 32];   // auto-detects gzip and zlib headers
}

- (BOOL)setupInflateWindowBits:(int)bits
{
    if (_zinit) {
        inflateEnd(&_zstream);
        _zinit = NO;
    }
    memset(&_zstream, 0, sizeof(_zstream));
    if (inflateInit2(&_zstream, bits) != Z_OK) return NO;
    _zinit = YES;
    if (!_zout) _zout = (uint8_t *)malloc(BRInflateBufferSize);
    if (!_zout) return NO;
    _zactive = YES;
    return YES;
}

// Raw body bytes from the wire (after transfer decoding). Returns NO on a content decoding error.
- (BOOL)deliverBodyBytes:(const void *)bytes length:(NSUInteger)length
{
    if (!length) return YES;
    self.bodyReceived += length;
    if (_br) {
        const uint8_t *nextIn = (const uint8_t *)bytes;
        size_t availIn = length;
        for (;;) {
            uint8_t *nextOut = _zout;
            size_t availOut = BRInflateBufferSize;
            BrotliDecoderResult r = BrotliDecoderDecompressStream(_br, &availIn, &nextIn, &availOut, &nextOut, NULL);
            NSUInteger produced = BRInflateBufferSize - availOut;
            if (produced) {
                if (![self noteDecodedBytes:produced]) return NO;
                if (![self deliverDecodedBytes:_zout length:produced]) return NO;
            }
            if (r == BROTLI_DECODER_RESULT_ERROR) {
                BRLog(@"brotli failed (%s) for %@", BrotliDecoderErrorString(BrotliDecoderGetErrorCode(_br)), self.url);
                return NO;
            }
            if (r == BROTLI_DECODER_RESULT_SUCCESS) {   // (anything after the end of the stream is ignored)
                BrotliDecoderDestroyInstance(_br);
                _br = NULL;
                _bremoved = YES;
                break;
            }
            if (r == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) break;
        }
        return YES;
    }
    if (_bremoved) return YES;
    if (!_zactive) return [self deliverDecodedBytes:bytes length:length];
    _zstream.next_in = (Bytef *)bytes;
    _zstream.avail_in = (uInt)length;
    while (_zstream.avail_in > 0) {
        _zstream.next_out = _zout;
        _zstream.avail_out = (uInt)BRInflateBufferSize;
        int rc = inflate(&_zstream, Z_NO_FLUSH);
        if (rc == Z_DATA_ERROR && !_zrawTried && _zproduced == 0 && self.bodyReceived == length) {
            // "deflate" sent raw, without the zlib header (many servers do; Seznam's h.seznam.cz): the first bytes once
            // more as raw deflate, as browsers do
            _zrawTried = YES;
            if (![self setupInflateWindowBits:-15]) return NO;
            _zstream.next_in = (Bytef *)bytes;
            _zstream.avail_in = (uInt)length;
            continue;
        }
        if (rc != Z_OK && rc != Z_STREAM_END && rc != Z_BUF_ERROR) {
            BRLog(@"inflate failed (%d) for %@", rc, self.url);
            return NO;
        }
        NSUInteger produced = BRInflateBufferSize - _zstream.avail_out;
        if (![self noteDecodedBytes:produced]) return NO;
        if (![self deliverDecodedBytes:_zout length:produced]) return NO;
        if (rc == Z_STREAM_END) {
            _zactive = NO;   // anything after the end of the stream is ignored
            break;
        }
        if (rc == Z_BUF_ERROR && produced == 0) break;   // needs more input
    }
    return YES;
}

// Returns YES when the whole body has been consumed (or refused: bodyError is set then).
- (BOOL)consumeBody:(NSMutableData *)buffer
{
    if (!self.chunked) {
        if (self.contentLength >= 0) {
            long long remaining = self.contentLength - self.bodyReceived;
            NSUInteger take = (NSUInteger)MIN((long long)buffer.length, MAX(remaining, 0));
            if (take) {
                if (![self deliverBodyBytes:buffer.bytes length:take]) { self.bodyError = YES; return YES; }
                [buffer replaceBytesInRange:NSMakeRange(0, take) withBytes:NULL length:0];
            }
            return self.bodyReceived >= self.contentLength;
        }
        if (buffer.length) {
            if (![self deliverBodyBytes:buffer.bytes length:buffer.length]) { self.bodyError = YES; return YES; }
            buffer.length = 0;
        }
        return NO;   // ends with the connection
    }
    // Chunked transfer encoding state machine. Every size and line in it is the server's word: sizes are read digit by
    // digit (strtoull took "-1" for 2^64-1, a negative count of bytes left that armv7 cut to a 4 GB read past the
    // buffer), and a line that never ends fails the request instead of growing the buffer for ever.
    for (;;) {
        const uint8_t *bytes = (const uint8_t *)buffer.bytes;
        NSUInteger len = buffer.length;
        if (self.chunkState == BRChunkStateSize || self.chunkState == BRChunkStateTrailer) {
            NSUInteger lineEnd = NSNotFound;
            for (NSUInteger i = _lineScan; i + 1 < len; i++) {
                if (bytes[i] == '\r' && bytes[i + 1] == '\n') { lineEnd = i; break; }
            }
            if (lineEnd == NSNotFound) {
                // (the last byte may be the CR of the line's end: the line itself is one shorter)
                if (len > BRMaxChunkLine + 1) return [self refuseBody:L(@"The server sent an invalid response.")];
                _lineScan = len ? len - 1 : 0;
                return NO;   // need more data
            }
            _lineScan = 0;   // the line leaves the buffer below
            if (lineEnd > BRMaxChunkLine) return [self refuseBody:L(@"The server sent an invalid response.")];
            if (self.chunkState == BRChunkStateTrailer) {
                [buffer replaceBytesInRange:NSMakeRange(0, lineEnd + 2) withBytes:NULL length:0];
                if (lineEnd == 0) { self.chunkState = BRChunkStateDone; return YES; }
                _trailerBytes += lineEnd + 2;
                if (_trailerBytes > BRMaxTrailer) return [self refuseBody:L(@"The server sent an invalid response.")];
                continue;
            }
            if (lineEnd == 0) {   // tolerate stray blank lines
                [buffer replaceBytesInRange:NSMakeRange(0, 2) withBytes:NULL length:0];
                continue;
            }
            // 1*HEXDIG, then ";" and extensions (ignored). Spaces or tabs around the digits pass as in Safari and Chrome
            // (some servers pad the size); a sign, "0x", no digits or anything else after them is refused.
            NSUInteger i = 0, digits = 0;
            unsigned long long size = 0;
            while (i < lineEnd && (bytes[i] == ' ' || bytes[i] == '\t')) i++;
            for (; i < lineEnd; i++, digits++) {
                int d = BRHexValue(bytes[i]);
                if (d < 0) break;
                size = (size << 4) | (unsigned long long)d;
                // (checked at every digit: size stays below 2^34, so the shift cannot overflow; leading zeros are fine)
                if (size > BRMaxChunkSize) return [self refuseBody:L(@"The server sent an invalid response.")];
            }
            while (i < lineEnd && (bytes[i] == ' ' || bytes[i] == '\t')) i++;
            if (!digits || (i < lineEnd && bytes[i] != ';')) return [self refuseBody:L(@"The server sent an invalid response.")];
            [buffer replaceBytesInRange:NSMakeRange(0, lineEnd + 2) withBytes:NULL length:0];
            if (size == 0) {
                self.chunkState = BRChunkStateTrailer;
                continue;
            }
            self.chunkRemaining = size;
            self.chunkState = BRChunkStateData;
            continue;
        }
        if (self.chunkState == BRChunkStateData) {
            if (len == 0) return NO;
            // (unsigned: never more than the buffer holds, and at least one byte as chunkRemaining > 0 here)
            NSUInteger take = (NSUInteger)MIN((unsigned long long)len, self.chunkRemaining);
            if (!take) return [self refuseBody:L(@"The server sent an invalid response.")];
            if (![self deliverBodyBytes:bytes length:take]) { self.bodyError = YES; return YES; }
            [buffer replaceBytesInRange:NSMakeRange(0, take) withBytes:NULL length:0];
            self.chunkRemaining -= take;
            if (self.chunkRemaining == 0) self.chunkState = BRChunkStateDataEnd;
            continue;
        }
        if (self.chunkState == BRChunkStateDataEnd) {
            if (len < 2) return NO;
            // CRLF after the chunk; anything else means the chunk was longer than its size said
            if (bytes[0] != '\r' || bytes[1] != '\n') return [self refuseBody:L(@"The server sent an invalid response.")];
            [buffer replaceBytesInRange:NSMakeRange(0, 2) withBytes:NULL length:0];
            self.chunkState = BRChunkStateSize;
            continue;
        }
        return YES; // done
    }
}

#pragma mark - Headers

// 0 = need more data, 1 = final headers parsed, 2 = interim (1xx) response skipped, -1 = error.
- (int)parseHeadersFromBuffer:(NSMutableData *)buffer error:(NSError **)error
{
    const uint8_t *bytes = (const uint8_t *)buffer.bytes;
    NSUInteger len = buffer.length;
    NSUInteger end = NSNotFound;
    for (NSUInteger i = _headerScan; i + 3 < len; i++) {
        if (bytes[i] == '\r' && bytes[i + 1] == '\n' && bytes[i + 2] == '\r' && bytes[i + 3] == '\n') { end = i; break; }
    }
    if (end == NSNotFound) {
        if (len > BRMaxHeaderBlock) {
            if (error) *error = BRMakeError(BRErrorBadResponse, L(@"The server sent an invalid response."));
            return -1;
        }
        _headerScan = len > 3 ? len - 3 : 0;   // (a CRLFCRLF may straddle this read and the next)
        return 0;
    }
    _headerScan = 0;   // the block leaves the buffer below
    NSString *head = [[NSString alloc] initWithBytes:bytes length:end encoding:NSISOLatin1StringEncoding] ?: @"";
    [buffer replaceBytesInRange:NSMakeRange(0, end + 4) withBytes:NULL length:0];
    NSArray *lines = [head componentsSeparatedByString:@"\r\n"];
    NSString *statusLine = lines.count ? lines[0] : @"";
    if (![statusLine hasPrefix:@"HTTP/"]) {
        if (error) *error = BRMakeError(BRErrorBadResponse, [NSString stringWithFormat:L(@"Unexpected response: %@"), statusLine.length > 80 ? [statusLine substringToIndex:80] : statusLine]);
        return -1;
    }
    NSArray *parts = [statusLine componentsSeparatedByString:@" "];
    NSInteger status = parts.count >= 2 ? [parts[1] integerValue] : 0;
    if (status < 100 || status > 999) {
        if (error) *error = BRMakeError(BRErrorBadResponse, [NSString stringWithFormat:L(@"Unexpected response: %@"), statusLine]);
        return -1;
    }
    if (status < 200) return 2;   // 100 Continue, 103 Early Hints: the real headers follow

    self.http11 = [statusLine hasPrefix:@"HTTP/1.1"];
    NSMutableArray *pairs = [NSMutableArray array];
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    NSMutableArray *cookies = [NSMutableArray array];
    for (NSUInteger i = 1; i < lines.count; i++) {
        NSString *line = lines[i];
        NSRange colon = [line rangeOfString:@":"];
        if (colon.location == NSNotFound || colon.location == 0) continue;
        NSString *name = [[line substringToIndex:colon.location] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        NSString *value = [[line substringFromIndex:colon.location + 1] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
        if (!name.length) continue;
        [pairs addObject:@[name, value]];
        NSString *lname = [name lowercaseString];
        if ([lname isEqualToString:@"set-cookie"]) {
            [cookies addObject:value];
            continue;
        }
        NSString *existing = headers[lname];
        headers[lname] = existing ? [NSString stringWithFormat:@"%@, %@", existing, value] : value;
    }
    self.statusCode = status;
    self.responseHeaders = headers;
    self.responseHeaderPairs = pairs;
    self.setCookieHeaders = cookies;
    NSString *connection = [headers[@"connection"] lowercaseString] ?: @"";
    self.connectionClose = [connection rangeOfString:@"close"].location != NSNotFound || (!self.http11 && [connection rangeOfString:@"keep-alive"].location == NSNotFound);
    NSString *te = [headers[@"transfer-encoding"] lowercaseString];
    self.chunked = te && [te rangeOfString:@"chunked"].location != NSNotFound;
    NSString *cl = headers[@"content-length"];
    self.contentLength = (cl && !self.chunked) ? [cl longLongValue] : -1;
    self.noBody = [self.method isEqualToString:@"HEAD"] || status == 204 || status == 304;
    _decodedLimit = self.unlimitedDecodedSize ? ULLONG_MAX : BRDecodedLimitForType(headers[@"content-type"]);
    NSString *ce = [[headers[@"content-encoding"] lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    if (!self.noBody && ([ce isEqualToString:@"gzip"] || [ce isEqualToString:@"x-gzip"] || [ce isEqualToString:@"deflate"])) {
        if ([self setupInflate]) self.decodedContentEncoding = YES;
    } else if (!self.noBody && [ce isEqualToString:@"br"]) {
        if (!_zout) _zout = (uint8_t *)malloc(BRInflateBufferSize);
        _br = _zout ? BrotliDecoderCreateInstance(NULL, NULL, NULL) : NULL;
        if (_br) self.decodedContentEncoding = YES;
    }
    return 1;
}

- (void)resetResponseState
{
    self.statusCode = 0;
    self.responseHeaders = nil;
    self.responseHeaderPairs = nil;
    self.setCookieHeaders = nil;
    self.chunked = NO;
    self.contentLength = -1;
    self.bodyReceived = 0;
    self.chunkState = BRChunkStateSize;
    self.chunkRemaining = 0;
    self.bodyError = NO;
    self.bodyFailure = nil;
    self.bodyTruncated = NO;
    _zproduced = 0;
    _headerScan = 0;
    _lineScan = 0;
    _trailerBytes = 0;
    self.http11 = NO;
    self.connectionClose = NO;
    self.noBody = NO;
    self.decodedContentEncoding = NO;
    if (_zinit) { inflateEnd(&_zstream); _zinit = NO; }
    _zactive = NO;
    if (_br) { BrotliDecoderDestroyInstance(_br); _br = NULL; }
    _bremoved = NO;
}

#pragma mark - Worker

- (BRTLSSocket *)connectWithError:(NSError **)error
{
    BRTLSSocket *socket = [[BRTLSSocket alloc] init];
    socket.plain = ![self isSecure];
    if (![socket connectToHost:self.url.host port:[self port] verify:self.verifyTLS
              connectTimeoutMs:(int)(self.connectTimeout * 1000) readTimeoutMs:(int)(self.readTimeout * 1000) error:error]) {
        if (error && !*error) *error = BRMakeError(BRErrorConnect, L(@"Connection failed."));
        return nil;
    }
    return socket;
}

// Sends the request and reads the whole response on `socket`.
- (BRExchangeResult)exchangeOnSocket:(BRTLSSocket *)socket reused:(BOOL)reused error:(NSError **)error
{
    BOOL responseSeen = NO;   // any byte of a response arrived
    self.tlsInfo = [NSString stringWithFormat:@"%@ %@", socket.tlsVersion ?: @"", socket.cipherSuite ?: @""];
    NSError *err = nil;
    if (![socket writeData:[self serializedRequest] error:&err]) {
        if (reused && !self.isCancelled) return BRExchangeRetry;
        if (error) *error = err ?: BRMakeError(BRErrorConnectionLost, L(@"Sending the request failed."));
        return BRExchangeFailed;
    }
    if (reused) [socket setReadTimeoutMs:MIN(BRReusedConnectionHeaderTimeoutMs, (uint32_t)(self.readTimeout * 1000))];

    NSMutableData *buffer = [NSMutableData data];
    _headerScan = 0;   // (the scan positions belong to this buffer)
    _lineScan = 0;
    BOOL headersDone = NO;
    BOOL bodyDone = NO;
    const NSUInteger chunkSize = 16384;
    uint8_t *tmp = (uint8_t *)malloc(chunkSize);
    if (!tmp) {
        if (error) *error = BRMakeError(BRErrorNetwork, @"Out of memory");
        return BRExchangeFailed;
    }
    BRExchangeResult result = BRExchangeFailed;
    while (!bodyDone) {
        NSError *readError = nil;
        NSInteger n = [socket readIntoBuffer:tmp maxLength:chunkSize error:&readError];
        if (n < 0) {
            if (reused && !responseSeen && !self.isCancelled) { result = BRExchangeRetry; goto out; }
            if (error) *error = readError ?: BRMakeError(BRErrorConnectionLost, L(@"Connection lost."));
            goto out;
        }
        if (n == 0) {
            // EOF
            if (!headersDone) {
                if (reused && !responseSeen && !self.isCancelled) { result = BRExchangeRetry; goto out; }
                if (error) *error = BRMakeError(BRErrorBadResponse, L(@"The server closed the connection without responding."));
                goto out;
            }
            // The body ends with the connection (also for incomplete chunked / content-length bodies).
            [self consumeBody:buffer];
            if (self.bodyFailure) {   // refused framing or size (a decoding error this late is let through as before)
                if (error) *error = self.bodyFailure;
                goto out;
            }
            // Cut off: no last (0) chunk, short of Content-Length, a gzip/deflate/br stream without its end, or a
            // decoding error. A reset reads as EOF too (BRTLSSocket), so anyone on the path can cut a script short. What
            // came is still delivered as success, as browsers render it; bodyTruncated keeps it out of the cache.
            BOOL cut = self.chunked ? self.chunkState < BRChunkStateTrailer : (self.contentLength >= 0 && self.bodyReceived < self.contentLength);
            if (cut || self.bodyError || _zactive || _br) {
                self.bodyTruncated = YES;
                BRLog(@"HTTP body cut short (chunked=%d, received=%lld) for %@", self.chunked, self.bodyReceived, self.url);
            }
            self.connectionClose = YES;
            bodyDone = YES;
            break;
        }
        responseSeen = YES;
        [buffer appendBytes:tmp length:(NSUInteger)n];
        if (!headersDone) {
            NSError *hErr = nil;
            int rc = 0;
            while (!headersDone) {
                rc = [self parseHeadersFromBuffer:buffer error:&hErr];
                if (rc < 0) {
                    if (error) *error = hErr ?: BRMakeError(BRErrorBadResponse, L(@"The server sent an invalid response."));
                    goto out;
                }
                if (rc == 0) break;          // need more bytes
                if (rc == 2) continue;       // interim response, parse the next block
                headersDone = YES;
            }
            if (!headersDone) continue;
            if (reused) [socket setReadTimeoutMs:(uint32_t)(self.readTimeout * 1000)];
            NSInteger status = self.statusCode;
            BRHTTPHeadersBlock hb = self.onHeaders;
            self.onHeaders = nil;
            if (hb) hb(status, self.responseHeaders);
            if (self.isCancelled) {
                if (error) *error = BRMakeError(BRErrorCancelled, L(@"Cancelled"));
                goto out;
            }
            if (self.noBody) {
                bodyDone = YES;
                break;
            }
        }
        if ([self consumeBody:buffer]) bodyDone = YES;
        if (self.bodyError) {
            if (error) *error = self.bodyFailure ?: BRMakeError(BRErrorBadResponse, L(@"Content decoding failed."));
            goto out;
        }
    }
    // Decide whether the connection can carry another request.
    BOOL framed = self.noBody || (self.chunked && self.chunkState == BRChunkStateDone) ||
                  (!self.chunked && self.contentLength >= 0 && self.bodyReceived >= self.contentLength);
    self.keepAlive = framed && !self.connectionClose && !self.isCancelled && !self.bodyError && buffer.length == 0 && socket.isConnected;
    result = BRExchangeDone;
out:
    free(tmp);
    return result;
}

- (void)run
{
    // Limit the number of simultaneous connections (TLS handshakes are CPU heavy on this hardware).
    // The main document of a page never waits: it must not sit behind stuck subresource loads.
    if (!self.highPriority) {
        dispatch_semaphore_t slots = BRConnectionSlots();
        while (dispatch_semaphore_wait(slots, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(100 * NSEC_PER_MSEC))) != 0) {
            if (self.isCancelled) {
                [self finishWithError:BRMakeError(BRErrorCancelled, L(@"Cancelled"))];
                return;
            }
        }
        self.hasSlot = YES;
    }
    if (self.isCancelled) {
        [self finishWithError:BRMakeError(BRErrorCancelled, L(@"Cancelled"))];
        return;
    }

    NSString *key = [self poolKey];
    BRConnectionPool *pool = [BRConnectionPool shared];
    BRTLSSocket *socket = [pool checkoutSocketForKey:key];
    BOOL reused = (socket != nil);
    NSError *error = nil;
    if (!socket) {
        socket = [self connectWithError:&error];
        if (!socket) {
            [self finishWithError:error];
            return;
        }
    }
    self.socket = socket;
    if (self.isCancelled) {
        [self finishWithError:BRMakeError(BRErrorCancelled, L(@"Cancelled"))];
        return;
    }

    BOOL retried = NO;
    for (;;) {
        NSError *err = nil;
        BRExchangeResult result = [self exchangeOnSocket:socket reused:reused error:&err];
        if (result == BRExchangeRetry && !retried) {
            retried = YES;
            reused = NO;
            [socket close];
            [self resetResponseState];
            socket = [self connectWithError:&err];
            if (!socket) {
                self.socket = nil;
                [self finishWithError:err];
                return;
            }
            self.socket = socket;
            if (self.isCancelled) {
                [self finishWithError:BRMakeError(BRErrorCancelled, L(@"Cancelled"))];
                return;
            }
            continue;
        }
        if (result == BRExchangeDone) {
            if (self.keepAlive) {
                self.socket = nil;   // finishWithError must not close it
                [pool checkinSocket:socket forKey:key];
            }
            [self finishWithError:nil];
        } else {
            [self finishWithError:err ?: BRMakeError(BRErrorConnectionLost, L(@"Connection lost."))];
        }
        return;
    }
}

@end
