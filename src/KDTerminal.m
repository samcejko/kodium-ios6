#import "KDTerminal.h"
#import "KDFiles.h"
#import "BRCommon.h"
#import <Security/Security.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <errno.h>

static const uint16_t KDShellPort = 47070;
// (what one read hands over at most: the rest waits for the next)
static const NSUInteger KDReadMax = 256 * 1024;
// (what is kept of a shell's output nobody reads: the oldest goes beyond that)
static const NSUInteger KDKeepMax = 4 * 1024 * 1024;

static NSString *g_token;

@interface KDTermSession : NSObject
@property (nonatomic) int fd;
@property (nonatomic, strong) NSMutableData *output;
@property (nonatomic, copy) KDTerminalCompletion waiting;
@property (nonatomic, strong) dispatch_source_t reader;
@property (nonatomic, strong) dispatch_source_t timeout;
@property (nonatomic) BOOL ended;
@end

@implementation KDTermSession
@end

// one queue for every session's state and socket
static dispatch_queue_t KDQueue(void)
{
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ queue = dispatch_queue_create("com.samcejko.kodium.terminal", DISPATCH_QUEUE_SERIAL); });
    return queue;
}

static NSMutableDictionary *KDSessions(void)
{
    static NSMutableDictionary *sessions;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ sessions = [NSMutableDictionary dictionary]; });
    return sessions;
}

static NSDictionary *KDQuery(NSURL *url)
{
    NSMutableDictionary *q = [NSMutableDictionary dictionary];
    for (NSString *pair in [url.query ?: @"" componentsSeparatedByString:@"&"]) {
        NSRange eq = [pair rangeOfString:@"="];
        if (eq.location == NSNotFound) continue;
        NSString *value = [[pair substringFromIndex:eq.location + 1] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
        if (value) q[[pair substringToIndex:eq.location]] = value;
    }
    return q;
}

static NSData *KDText(NSString *text)
{
    return [text dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
}

// a request's body: HTTPBody, or what its stream gives (as KDFiles reads it)
static NSData *KDBody(NSURLRequest *request)
{
    if (request.HTTPBody) return request.HTTPBody;
    NSInputStream *stream = request.HTTPBodyStream;
    if (!stream) return [NSData data];
    NSMutableData *d = [NSMutableData data];
    [stream open];
    uint8_t buf[16384];
    for (;;) {
        NSInteger n = [stream read:buf maxLength:sizeof(buf)];
        if (n <= 0) break;
        [d appendBytes:buf length:(NSUInteger)n];
    }
    [stream close];
    return d;
}

static BOOL KDWriteAll(int fd, const uint8_t *p, size_t n)
{
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN) {
                struct pollfd pf = { fd, POLLOUT, 0 };
                if (poll(&pf, 1, 2000) <= 0) return NO;
                continue;
            }
            return NO;
        }
        p += w;
        n -= (size_t)w;
    }
    return YES;
}

@implementation KDTerminal

+ (void)prepareToken
{
    uint8_t bytes[32];
    if (SecRandomCopyBytes(kSecRandomDefault, sizeof bytes, bytes) != 0) return;
    NSMutableString *hex = [NSMutableString stringWithCapacity:64];
    for (size_t i = 0; i < sizeof bytes; i++) [hex appendFormat:@"%02x", bytes[i]];
    NSString *library = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) firstObject];
    NSString *dir = [library stringByAppendingPathComponent:@"Kodium"];
    NSFileManager *fm = [NSFileManager defaultManager];
    [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:@{ NSFilePosixPermissions: @0700 } error:NULL];
    NSString *file = [dir stringByAppendingPathComponent:@"shell.token"];
    if ([hex writeToFile:file atomically:YES encoding:NSUTF8StringEncoding error:NULL]) {
        [fm setAttributes:@{ NSFilePosixPermissions: @0600 } ofItemAtPath:file error:NULL];
        g_token = [hex copy];
    }
}

+ (void)performOperation:(NSString *)operation request:(NSURLRequest *)request completion:(KDTerminalCompletion)completion
{
    NSDictionary *q = KDQuery(request.URL);
    NSData *body = [operation isEqualToString:@"write"] ? KDBody(request) : nil;
    dispatch_async(KDQueue(), ^{
        if ([operation isEqualToString:@"open"]) [self openWith:q completion:completion];
        else {
            KDTermSession *session = KDSessions()[@([q[@"id"] integerValue])];
            if (!session) {
                completion(410, KDText(@"no such terminal"), @"text/plain");
            } else if ([operation isEqualToString:@"read"]) {
                [self read:session completion:completion];
            } else if ([operation isEqualToString:@"write"]) {
                [self send:session type:'d' payload:body];
                completion(200, [NSData data], @"text/plain");
            } else if ([operation isEqualToString:@"resize"]) {
                uint8_t size[4] = { (uint8_t)([q[@"cols"] intValue] >> 8), (uint8_t)[q[@"cols"] intValue],
                                    (uint8_t)([q[@"rows"] intValue] >> 8), (uint8_t)[q[@"rows"] intValue] };
                [self send:session type:'r' payload:[NSData dataWithBytes:size length:4]];
                completion(200, [NSData data], @"text/plain");
            } else if ([operation isEqualToString:@"close"]) {
                [self end:session];
                [KDSessions() removeObjectForKey:@([q[@"id"] integerValue])];
                completion(200, [NSData data], @"text/plain");
            } else {
                completion(400, KDText(@"unknown operation"), @"text/plain");
            }
        }
    });
}

// (queue) a connection to kodium-shelld: the header line with the token, the size and the folder; its "OK"
+ (void)openWith:(NSDictionary *)q completion:(KDTerminalCompletion)completion
{
    if (!g_token) {
        completion(500, KDText(@"no token"), @"text/plain");
        return;
    }
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_len = sizeof a;
    a.sin_family = AF_INET;
    a.sin_port = htons(KDShellPort);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (fd < 0 || connect(fd, (struct sockaddr *)&a, sizeof a) != 0) {
        if (fd >= 0) close(fd);
        completion(503, KDText(@"no shell daemon"), @"text/plain");
        return;
    }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
    // (the workbench's /Documents is the app's Documents)
    NSString *cwd = q[@"cwd"] ?: @"";
    NSString *folder = [cwd hasPrefix:@"/Documents"] ? [KDFiles filePathFor:[cwd substringFromIndex:10].length ? [cwd substringFromIndex:10] : @"/"
                                                                       root:[KDFiles rootDirectory]] : nil;
    if (!folder) folder = [KDFiles rootDirectory];
    NSString *encoded = (__bridge_transfer NSString *)CFURLCreateStringByAddingPercentEscapes(NULL, (__bridge CFStringRef)folder, NULL,
                                                                                                CFSTR(" %\n\r\t"), kCFStringEncodingUTF8);
    NSString *header = [NSString stringWithFormat:@"KODIUM1 %@ %d %d %@\n", g_token, MAX(2, [q[@"cols"] intValue]), MAX(1, [q[@"rows"] intValue]), encoded];
    NSData *headerData = KDText(header);
    char reply[64];
    size_t got = 0;
    BOOL ok = KDWriteAll(fd, headerData.bytes, headerData.length);
    while (ok && got + 1 < sizeof reply) {
        struct pollfd pf = { fd, POLLIN, 0 };
        if (poll(&pf, 1, 5000) <= 0) { ok = NO; break; }
        ssize_t r = read(fd, reply + got, 1);
        if (r <= 0) { ok = NO; break; }
        if (reply[got] == '\n') break;
        got++;
    }
    reply[got] = 0;
    if (!ok || strcmp(reply, "OK") != 0) {
        close(fd);
        BRLog(@"Terminal: the shell daemon said %s", got ? reply : "nothing");
        completion(strncmp(reply, "ERR token", 9) == 0 ? 403 : 502, KDText([NSString stringWithUTF8String:reply] ?: @"no answer"), @"text/plain");
        return;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    static NSInteger lastId;
    NSNumber *sessionId = @(++lastId);
    KDTermSession *session = [KDTermSession new];
    session.fd = fd;
    session.output = [NSMutableData data];
    session.reader = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0, KDQueue());
    __weak KDTermSession *weak = session;
    dispatch_source_set_event_handler(session.reader, ^{
        KDTermSession *s = weak;
        if (!s || s.ended) return;
        uint8_t buf[65536];
        for (;;) {
            ssize_t r = read(s.fd, buf, sizeof buf);
            if (r > 0) {
                [s.output appendBytes:buf length:(NSUInteger)r];
                continue;
            }
            if (r < 0 && errno == EINTR) continue;
            if (r < 0 && errno == EAGAIN) break;
            [self end:s];   // (the shell ended, or the daemon went)
            break;
        }
        if (s.output.length > KDKeepMax) [s.output replaceBytesInRange:NSMakeRange(0, s.output.length - KDKeepMax) withBytes:NULL length:0];
        [self answer:s];
    });
    // (the socket is closed once the source is done with it)
    dispatch_source_set_cancel_handler(session.reader, ^{ close(fd); });
    dispatch_resume(session.reader);
    KDSessions()[sessionId] = session;
    completion(200, KDText([NSString stringWithFormat:@"{\"id\":%ld}", (long)sessionId.integerValue]), @"application/json");
}

// (queue) the output gathered so far, to the read waiting; or the end
+ (void)answer:(KDTermSession *)session
{
    KDTerminalCompletion waiting = session.waiting;
    if (!waiting || (!session.output.length && !session.ended)) return;
    session.waiting = nil;
    if (session.timeout) {
        dispatch_source_cancel(session.timeout);
        session.timeout = nil;
    }
    if (session.output.length) {
        NSUInteger n = MIN(session.output.length, KDReadMax);
        NSData *chunk = [session.output subdataWithRange:NSMakeRange(0, n)];
        [session.output replaceBytesInRange:NSMakeRange(0, n) withBytes:NULL length:0];
        waiting(200, chunk, @"application/octet-stream");
    } else {
        waiting(410, KDText(@"ended"), @"text/plain");
    }
}

// (queue) a read: what there is now, else the next output (or the end), else nothing after 20 s
+ (void)read:(KDTermSession *)session completion:(KDTerminalCompletion)completion
{
    if (session.waiting) {
        // (the page asked again: the earlier one goes without anything)
        KDTerminalCompletion earlier = session.waiting;
        session.waiting = nil;
        earlier(204, [NSData data], @"text/plain");
    }
    session.waiting = completion;
    if (session.output.length || session.ended) {
        [self answer:session];
        return;
    }
    if (session.timeout) dispatch_source_cancel(session.timeout);
    session.timeout = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, KDQueue());
    dispatch_source_set_timer(session.timeout, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), DISPATCH_TIME_FOREVER, NSEC_PER_SEC);
    __weak KDTermSession *weak = session;
    dispatch_source_set_event_handler(session.timeout, ^{
        KDTermSession *s = weak;
        if (!s) return;
        if (s.timeout) {
            dispatch_source_cancel(s.timeout);
            s.timeout = nil;
        }
        KDTerminalCompletion waiting = s.waiting;
        s.waiting = nil;
        if (waiting) waiting(204, [NSData data], @"text/plain");
    });
    dispatch_resume(session.timeout);
}

// (queue) a frame for kodium-shelld: 'd' <length:2> <bytes> (input, in parts of 64 KB at most) or 'r' <size:4>
+ (void)send:(KDTermSession *)session type:(char)type payload:(NSData *)payload
{
    if (session.ended) return;
    const uint8_t *p = payload.bytes;
    NSUInteger left = payload.length;
    if (type == 'r') {
        uint8_t frame[5] = { 'r', p[0], p[1], p[2], p[3] };
        if (!KDWriteAll(session.fd, frame, 5)) [self end:session];
        return;
    }
    while (left > 0) {
        NSUInteger n = MIN(left, (NSUInteger)65535);
        uint8_t head[3] = { 'd', (uint8_t)(n >> 8), (uint8_t)n };
        if (!KDWriteAll(session.fd, head, 3) || !KDWriteAll(session.fd, p, n)) {
            [self end:session];
            return;
        }
        p += n;
        left -= n;
    }
}

// (queue) the connection closed: the daemon hangs the shell up; the output not read yet stays for the reads
+ (void)end:(KDTermSession *)session
{
    if (session.ended) return;
    session.ended = YES;
    if (session.reader) {
        dispatch_source_cancel(session.reader);   // (its cancel handler closes the socket)
        session.reader = nil;
    } else {
        close(session.fd);
    }
    [self answer:session];
}

@end
