#import <Foundation/Foundation.h>

typedef void (^BRHTTPHeadersBlock)(NSInteger status, NSDictionary *headers);
typedef void (^BRHTTPDataBlock)(NSData *chunk);
typedef void (^BRHTTPCompleteBlock)(NSError *error);

// Minimal HTTP/1.1 client over BRTLSSocket: one request per connection, chunked transfer decoding,
// gzip/deflate content decoding. Redirects are NOT followed (the caller decides).
// All callbacks run synchronously on the worker thread that performs the request.
// Broken chunked framing, and gzip/deflate/br output past 64 MB (documents, scripts, styles, data) or 128 MB (anything
// else but text/event-stream), fail the request with BRErrorBadResponse; bodies that are not content-encoded go to
// onData without a limit.
@interface BRHTTPRequest : NSObject

- (instancetype)initWithMethod:(NSString *)method URL:(NSURL *)url;

@property (nonatomic, readonly, copy) NSString *method;
@property (nonatomic, readonly, strong) NSURL *url;
@property (nonatomic, strong) NSDictionary *headers;        // request headers; Host, Content-Length, Connection and Accept-Encoding are managed here
@property (nonatomic, strong) NSData *body;
@property (nonatomic) NSTimeInterval connectTimeout;        // seconds, default 20
@property (nonatomic) NSTimeInterval readTimeout;           // seconds, default 60
@property (nonatomic) BOOL verifyTLS;                       // default YES
@property (nonatomic) BOOL highPriority;                    // main documents: never queue behind subresource connections
@property (nonatomic) BOOL unlimitedDecodedSize;            // no gzip/deflate/br output limit: for onData consumers that keep nothing in memory (a download written to a file)

@property (nonatomic, copy) BRHTTPHeadersBlock onHeaders;   // final status and headers (1xx responses are skipped)
@property (nonatomic, copy) BRHTTPDataBlock onData;         // decoded body bytes; when nil the body is collected in responseBody (up to 16 MB, more fails the request)
@property (nonatomic, copy) BRHTTPCompleteBlock onComplete; // error is nil on success

@property (nonatomic, readonly) NSInteger statusCode;
@property (nonatomic, readonly) NSDictionary *responseHeaders;    // lowercase names, duplicates joined with ", ", Set-Cookie excluded
@property (nonatomic, readonly) NSArray *responseHeaderPairs;     // @[@[name, value], ...] in wire order, original case
@property (nonatomic, readonly) NSArray *setCookieHeaders;        // every Set-Cookie value separately
@property (nonatomic, readonly) NSData *responseBody;             // only when onData is nil
@property (nonatomic, readonly) BOOL decodedContentEncoding;      // YES when gzip/deflate/br was removed by this client
@property (nonatomic, readonly) BOOL bodyTruncated;               // the connection closed before the body's end (no last chunk, short of Content-Length, gzip/deflate/br unfinished): onComplete still reports success so what came is shown, but it must not be cached or saved as a whole file
@property (nonatomic, readonly) NSString *tlsInfo;                // "TLSv1.2 TLS-ECDHE-..." once connected
@property (nonatomic, readonly) BOOL isCancelled;
@property (nonatomic, readonly) BOOL isFinished;

+ (NSString *)defaultUserAgent;

- (void)start;
- (void)cancel;

@end
