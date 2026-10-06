#import "BRDownloader.h"
#import "BRHTTPRequest.h"
#import "BRSettings.h"
#import "BRCommon.h"

NSString * const BRDownloadsDidChangeNotification = @"BRDownloadsDidChangeNotification";

@interface BRDownloader ()
@property (nonatomic, strong) NSMutableDictionary *active;   // url string -> BRHTTPRequest
@end

@implementation BRDownloader

+ (instancetype)shared
{
    static BRDownloader *d;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ d = [[BRDownloader alloc] init]; });
    return d;
}

- (instancetype)init
{
    self = [super init];
    if (self) _active = [NSMutableDictionary dictionary];
    return self;
}

+ (NSString *)downloadsDirectory
{
    NSString *docs = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
    NSString *dir = [docs stringByAppendingPathComponent:@"Downloads"];
    [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:NULL];
    return dir;
}

+ (NSString *)formattedSize:(long long)bytes
{
    if (bytes < 1024) return [NSString stringWithFormat:@"%lld B", bytes];
    if (bytes < 1024 * 1024) return [NSString stringWithFormat:@"%lld KB", bytes / 1024];
    return [NSString stringWithFormat:@"%.1f MB", bytes / (1024.0 * 1024.0)];
}

+ (NSArray *)downloadedFiles
{
    NSString *dir = [self downloadsDirectory];
    NSFileManager *fm = [NSFileManager defaultManager];
    NSMutableArray *files = [NSMutableArray array];
    for (NSString *name in [fm contentsOfDirectoryAtPath:dir error:NULL]) {
        if ([name hasPrefix:@"."] || [name hasSuffix:@".part"]) continue;
        NSString *path = [dir stringByAppendingPathComponent:name];
        NSDictionary *attrs = [fm attributesOfItemAtPath:path error:NULL];
        if ([attrs.fileType isEqualToString:NSFileTypeDirectory]) continue;
        [files addObject:@{ @"name": name, @"path": path, @"size": @(attrs.fileSize), @"date": attrs.fileModificationDate ?: [NSDate date] }];
    }
    [files sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [b[@"date"] compare:a[@"date"]]; }];
    return files;
}

+ (BOOL)removeDownloadAtPath:(NSString *)path
{
    BOOL ok = [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
    if (ok) [[NSNotificationCenter defaultCenter] postNotificationName:BRDownloadsDidChangeNotification object:nil];
    return ok;
}

- (BOOL)isDownloading:(NSURL *)url
{
    return url.absoluteString && self.active[url.absoluteString] != nil;
}

// A safe file name from Content-Disposition or the URL, unique within the downloads folder.
static NSString *BRFileNameForDownload(NSURL *url, NSDictionary *headers)
{
    NSString *name = nil;
    NSString *disposition = headers[@"content-disposition"];
    if (disposition.length) {
        NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:@"filename\\*?=\\s*(?:UTF-8'')?\"?([^\";]+)\"?" options:NSRegularExpressionCaseInsensitive error:NULL];
        NSTextCheckingResult *m = [re firstMatchInString:disposition options:0 range:NSMakeRange(0, disposition.length)];
        if (m && m.numberOfRanges > 1) name = [[disposition substringWithRange:[m rangeAtIndex:1]] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
    }
    if (!name.length) name = [[url.path lastPathComponent] stringByReplacingPercentEscapesUsingEncoding:NSUTF8StringEncoding];
    if (!name.length || [name isEqualToString:@"/"]) name = url.host ?: @"download";
    name = [[name componentsSeparatedByCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"/\\:*?\"<>|\n\r\t"]] componentsJoinedByString:@"_"];
    if ([name hasPrefix:@"."]) name = [@"_" stringByAppendingString:name];
    if (name.length > 120) name = [name substringFromIndex:name.length - 120];
    if (![name pathExtension].length) {
        NSString *ctype = [headers[@"content-type"] lowercaseString] ?: @"";
        NSString *ext = [ctype hasPrefix:@"application/zip"] ? @"zip" : [ctype hasPrefix:@"application/pdf"] ? @"pdf" :
                        [ctype hasPrefix:@"image/png"] ? @"png" : [ctype hasPrefix:@"image/jpeg"] ? @"jpg" : [ctype hasPrefix:@"text/plain"] ? @"txt" : nil;
        if (ext) name = [name stringByAppendingPathExtension:ext];
    }
    NSString *dir = [BRDownloader downloadsDirectory];
    NSString *candidate = name;
    NSString *stem = [name stringByDeletingPathExtension], *ext = [name pathExtension];
    for (int i = 2; [[NSFileManager defaultManager] fileExistsAtPath:[dir stringByAppendingPathComponent:candidate]] && i < 1000; i++) {
        candidate = ext.length ? [NSString stringWithFormat:@"%@ (%d).%@", stem, i, ext] : [NSString stringWithFormat:@"%@ (%d)", stem, i];
    }
    return candidate;
}

- (void)downloadURL:(NSURL *)url completion:(BRDownloadCompletion)completion
{
    if (!url || [self isDownloading:url]) return;
    BRLog(@"Download started: %@", url.absoluteString);
    BRHTTPRequest *r = [[BRHTTPRequest alloc] initWithMethod:@"GET" URL:url];
    r.verifyTLS = [BRSettings verifyTLS];
    r.highPriority = YES;
    r.readTimeout = 120;
    r.unlimitedDecodedSize = YES;   // written to a file: no limit on gzip/deflate/br output
    NSArray *cookies = nil;
    @synchronized (BRCookieLock()) { cookies = [[NSHTTPCookieStorage sharedHTTPCookieStorage] cookiesForURL:url]; }
    NSMutableDictionary *headers = [NSMutableDictionary dictionary];
    if (cookies.count) headers[@"Cookie"] = [NSHTTPCookie requestHeaderFieldsWithCookies:cookies][@"Cookie"] ?: @"";
    headers[@"Accept"] = @"*/*";
    r.headers = headers;
    self.active[url.absoluteString] = r;

    __block NSFileHandle *handle = nil;
    __block NSString *partPath = nil;
    __block NSString *finalPath = nil;
    __block long long received = 0;
    __block NSInteger status = 0;
    // (alive inside onComplete: the request keeps itself alive until onComplete returns)
    __weak BRHTTPRequest *weakR = r;
    r.onHeaders = ^(NSInteger st, NSDictionary *hdrs) {
        status = st;
        if (st < 200 || st >= 300) return;
        NSString *name = BRFileNameForDownload(url, hdrs);
        finalPath = [[BRDownloader downloadsDirectory] stringByAppendingPathComponent:name];
        partPath = [finalPath stringByAppendingString:@".part"];
        [[NSFileManager defaultManager] createFileAtPath:partPath contents:nil attributes:nil];
        handle = [NSFileHandle fileHandleForWritingAtPath:partPath];
    };
    r.onData = ^(NSData *chunk) {
        if (!handle) return;
        [handle writeData:chunk];
        received += chunk.length;
    };
    r.onComplete = ^(NSError *error) {
        [handle closeFile];
        handle = nil;
        NSError *result = error;
        if (!result && (status < 200 || status >= 300)) result = BRMakeError(BRErrorBadResponse, [NSString stringWithFormat:L(@"Unexpected response: %@"), [NSString stringWithFormat:@"HTTP %ld", (long)status]]);
        // (cut off by a closed or reset connection: never saved as if it were the whole file)
        if (!result && weakR.bodyTruncated) result = BRMakeError(BRErrorConnectionLost, L(@"Connection lost."));
        if (!result && (!partPath || ![[NSFileManager defaultManager] moveItemAtPath:partPath toPath:finalPath error:NULL])) {
            result = BRMakeError(BRErrorNetwork, L(@"The file could not be saved."));
        }
        if (result && partPath) [[NSFileManager defaultManager] removeItemAtPath:partPath error:NULL];
        BRLog(@"Download %@: %@ (%lld bytes)%@", result ? @"failed" : @"finished", url.absoluteString, received, result ? [NSString stringWithFormat:@": %@", result.localizedDescription] : @"");
        dispatch_async(dispatch_get_main_queue(), ^{
            [self.active removeObjectForKey:url.absoluteString];
            [[NSNotificationCenter defaultCenter] postNotificationName:BRDownloadsDidChangeNotification object:nil];
            if (completion) completion(result ? nil : finalPath, result);
        });
    };
    [r start];
}

@end
