#import "KDFiles.h"
#import "BRCommon.h"

static const NSInteger KDNotFound = 404, KDExists = 409, KDNotAllowed = 403, KDFailed = 400;

// the query's parameters, decoded
static NSDictionary *KDQuery(NSURL *url)
{
    NSMutableDictionary *q = [NSMutableDictionary dictionary];
    for (NSString *pair in [url.query ?: @"" componentsSeparatedByString:@"&"]) {
        NSRange eq = [pair rangeOfString:@"="];
        if (eq.location == NSNotFound) { if (pair.length) q[pair] = @""; continue; }
        NSString *key = [pair substringToIndex:eq.location];
        NSString *value = [[[pair substringFromIndex:eq.location + 1] stringByReplacingOccurrencesOfString:@"+" withString:@" "]
                           stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
        if (key.length && value) q[key] = value;
    }
    return q;
}

// a request's body: HTTPBody, or what its stream gives (WebKit sends some bodies as a stream)
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

static NSData *KDJSON(id object)
{
    return [NSJSONSerialization dataWithJSONObject:object options:0 error:NULL] ?: [NSData data];
}

static NSNumber *KDMillis(NSDate *date)
{
    return @((long long)([date timeIntervalSince1970] * 1000));
}

@implementation KDFiles

+ (NSString *)rootDirectory
{
    return [[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject] stringByStandardizingPath];
}

// a path of the page ("/a/b", inside Documents) as a file path; nil when it leads out of Documents
+ (NSString *)filePathFor:(NSString *)path
{
    if (![path hasPrefix:@"/"]) return nil;
    NSString *root = [self rootDirectory];
    NSString *file = [[root stringByAppendingPathComponent:path] stringByStandardizingPath];
    if (![file isEqualToString:root] && ![file hasPrefix:[root stringByAppendingString:@"/"]]) return nil;
    return file;
}

+ (dispatch_queue_t)queue
{
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ queue = dispatch_queue_create("com.samcejko.kodium.files", DISPATCH_QUEUE_SERIAL); });
    return queue;
}

+ (void)performOperation:(NSString *)operation request:(NSURLRequest *)request completion:(KDFilesCompletion)completion
{
    NSDictionary *q = KDQuery(request.URL);
    NSData *body = [operation isEqualToString:@"write"] ? KDBody(request) : nil;   // (read on the loading thread, as WebKit gave it)
    dispatch_async([self queue], ^{
        @autoreleasepool {
            NSString *file = [self filePathFor:q[@"path"] ?: @""];
            if (!file) { completion(KDNotAllowed, nil, nil); return; }
            [self perform:operation file:file query:q body:body completion:completion];
        }
    });
}

+ (void)perform:(NSString *)op file:(NSString *)file query:(NSDictionary *)q body:(NSData *)body completion:(KDFilesCompletion)completion
{
    NSFileManager *fm = [NSFileManager defaultManager];
    BOOL dir = NO, exists = [fm fileExistsAtPath:file isDirectory:&dir];
    NSError *error = nil;

    if ([op isEqualToString:@"stat"]) {
        if (!exists) { completion(KDNotFound, nil, nil); return; }
        NSDictionary *a = [fm attributesOfItemAtPath:file error:NULL];
        completion(200, KDJSON(@{ @"type": @(dir ? 2 : 1), @"size": @([a fileSize]), @"mtime": KDMillis([a fileModificationDate] ?: [NSDate date]),
                                   @"ctime": KDMillis([a fileCreationDate] ?: [a fileModificationDate] ?: [NSDate date]) }), @"application/json");
        return;
    }
    if ([op isEqualToString:@"list"]) {
        if (!exists) { completion(KDNotFound, nil, nil); return; }
        if (!dir) { completion(KDFailed, nil, nil); return; }
        NSMutableArray *entries = [NSMutableArray array];
        for (NSString *name in [fm contentsOfDirectoryAtPath:file error:NULL]) {
            BOOL sub = NO;
            [fm fileExistsAtPath:[file stringByAppendingPathComponent:name] isDirectory:&sub];
            [entries addObject:@[name, @(sub ? 2 : 1)]];
        }
        completion(200, KDJSON(entries), @"application/json");
        return;
    }
    if ([op isEqualToString:@"read"]) {
        if (!exists) { completion(KDNotFound, nil, nil); return; }
        if (dir) { completion(KDFailed, nil, nil); return; }
        NSData *data = [NSData dataWithContentsOfFile:file options:NSDataReadingMappedIfSafe error:&error];
        completion(data ? 200 : KDFailed, data, @"application/octet-stream");
        return;
    }
    if ([op isEqualToString:@"write"]) {
        BOOL create = [q[@"create"] isEqualToString:@"1"], overwrite = [q[@"overwrite"] isEqualToString:@"1"];
        if (exists && dir) { completion(KDFailed, nil, nil); return; }
        if (!exists && !create) { completion(KDNotFound, nil, nil); return; }
        if (exists && !overwrite) { completion(KDExists, nil, nil); return; }
        BOOL parentDir = NO;
        if (![fm fileExistsAtPath:[file stringByDeletingLastPathComponent] isDirectory:&parentDir] || !parentDir) { completion(KDNotFound, nil, nil); return; }
        BOOL ok = [body ?: [NSData data] writeToFile:file options:NSDataWritingAtomic error:&error];
        if (!ok) BRLog(@"Writing %@ failed: %@", file.lastPathComponent, error.localizedDescription);
        completion(ok ? 200 : KDFailed, nil, nil);
        return;
    }
    if ([op isEqualToString:@"mkdir"]) {
        if (exists) { completion(KDExists, nil, nil); return; }
        BOOL ok = [fm createDirectoryAtPath:file withIntermediateDirectories:NO attributes:nil error:&error];
        completion(ok ? 200 : ([fm fileExistsAtPath:[file stringByDeletingLastPathComponent]] ? KDFailed : KDNotFound), nil, nil);
        return;
    }
    if ([op isEqualToString:@"delete"]) {
        if (!exists) { completion(KDNotFound, nil, nil); return; }
        if ([file isEqualToString:[self rootDirectory]]) { completion(KDNotAllowed, nil, nil); return; }
        if (dir && ![q[@"recursive"] isEqualToString:@"1"] && [[fm contentsOfDirectoryAtPath:file error:NULL] count]) { completion(KDFailed, nil, nil); return; }
        BOOL ok = [fm removeItemAtPath:file error:&error];
        completion(ok ? 200 : KDFailed, nil, nil);
        return;
    }
    if ([op isEqualToString:@"rename"]) {
        NSString *to = [self filePathFor:q[@"to"] ?: @""];
        if (!to || [file isEqualToString:[self rootDirectory]]) { completion(KDNotAllowed, nil, nil); return; }
        if (!exists) { completion(KDNotFound, nil, nil); return; }
        if ([fm fileExistsAtPath:to]) {
            if (![q[@"overwrite"] isEqualToString:@"1"]) { completion(KDExists, nil, nil); return; }
            [fm removeItemAtPath:to error:NULL];
        }
        BOOL ok = [fm moveItemAtPath:file toPath:to error:&error];
        completion(ok ? 200 : KDFailed, nil, nil);
        return;
    }
    completion(KDFailed, nil, nil);
}

@end
