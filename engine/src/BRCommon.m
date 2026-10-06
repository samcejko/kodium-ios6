#import "BRCommon.h"

#include <mach/mach.h>

NSString * const BRErrorDomain = @"SurfariErrorDomain";

static NSString *BRDebugKeyPath(void)
{
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/surfari-debug-key"];
}

NSString *BRDebugKey(void)
{
    NSString *text = [NSString stringWithContentsOfFile:BRDebugKeyPath() encoding:NSUTF8StringEncoding error:NULL];
    text = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    return text.length >= 16 ? text : nil;
}

BOOL BRDebugEnabled(void)
{
    // (every BRLog asks, from any thread: one file check per run)
    static BOOL enabled;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        enabled = [[NSFileManager defaultManager] fileExistsAtPath:BRDebugKeyPath()]
                  || [[NSUserDefaults standardUserDefaults] boolForKey:@"BRDebugLog"];
    });
    return enabled;
}

double BRResidentMemoryMB(void)
{
    struct task_basic_info info;
    mach_msg_type_number_t count = TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), TASK_BASIC_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) return 0;
    return (double)info.resident_size / (1024.0 * 1024.0);
}

NSError *BRMakeError(NSInteger code, NSString *message)
{
    if (!message) message = @"Unknown error";
    return [NSError errorWithDomain:BRErrorDomain code:code userInfo:@{ NSLocalizedDescriptionKey: message }];
}

NSError *BRURLErrorFromError(NSError *error, NSURL *url)
{
    if (!error) return nil;
    if (![error.domain isEqualToString:BRErrorDomain]) return error;
    NSInteger code;
    switch (error.code) {
        case BRErrorDNS:            code = NSURLErrorCannotFindHost; break;
        case BRErrorConnect:        code = NSURLErrorCannotConnectToHost; break;
        case BRErrorTimeout:        code = NSURLErrorTimedOut; break;
        case BRErrorTLS:            code = NSURLErrorSecureConnectionFailed; break;
        case BRErrorCertificate:    code = NSURLErrorServerCertificateUntrusted; break;
        case BRErrorCancelled:      code = NSURLErrorCancelled; break;
        case BRErrorBadResponse:    code = NSURLErrorBadServerResponse; break;
        case BRErrorConnectionLost: code = NSURLErrorNetworkConnectionLost; break;
        default:                    code = NSURLErrorUnknown; break;
    }
    NSMutableDictionary *info = [NSMutableDictionary dictionary];
    info[NSLocalizedDescriptionKey] = error.localizedDescription ?: @"";
    if (url) {
        info[NSURLErrorFailingURLErrorKey] = url;
        info[NSURLErrorFailingURLStringErrorKey] = url.absoluteString ?: @"";
    }
    info[NSUnderlyingErrorKey] = error;
    return [NSError errorWithDomain:NSURLErrorDomain code:code userInfo:info];
}

#pragma mark - IDNA (punycode)

// RFC 3492 encoder over Unicode code points; returns nil on overflow.
static NSString *BRPunycodeEncode(const uint32_t *input, NSUInteger length)
{
    const uint32_t base = 36, tmin = 1, tmax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128;
    NSMutableString *out = [NSMutableString string];
    uint32_t n = initialN, delta = 0, bias = initialBias;
    NSUInteger basicCount = 0;
    for (NSUInteger j = 0; j < length; j++) {
        if (input[j] < 0x80) { [out appendFormat:@"%c", (char)input[j]]; basicCount++; }
    }
    NSUInteger handled = basicCount;
    if (basicCount) [out appendString:@"-"];
    while (handled < length) {
        uint32_t m = 0xFFFFFFFF;
        for (NSUInteger j = 0; j < length; j++) if (input[j] >= n && input[j] < m) m = input[j];
        if ((uint64_t)(m - n) * (handled + 1) > 0xFFFFFFFF - delta) return nil;
        delta += (m - n) * (uint32_t)(handled + 1);
        n = m;
        for (NSUInteger j = 0; j < length; j++) {
            if (input[j] < n) { if (++delta == 0) return nil; }
            if (input[j] == n) {
                uint32_t q = delta;
                for (uint32_t k = base; ; k += base) {
                    uint32_t t = k <= bias ? tmin : (k >= bias + tmax ? tmax : k - bias);
                    if (q < t) break;
                    uint32_t digit = t + (q - t) % (base - t);
                    [out appendFormat:@"%c", (char)(digit < 26 ? 'a' + digit : '0' + digit - 26)];
                    q = (q - t) / (base - t);
                }
                [out appendFormat:@"%c", (char)(q < 26 ? 'a' + q : '0' + q - 26)];
                // adapt bias
                uint32_t d = delta;
                d = (handled == basicCount) ? d / damp : d / 2;
                d += d / (uint32_t)(handled + 1);
                uint32_t k2 = 0;
                while (d > ((base - tmin) * tmax) / 2) { d /= base - tmin; k2 += base; }
                bias = k2 + (base - tmin + 1) * d / (d + skew);
                delta = 0;
                handled++;
            }
        }
        delta++;
        n++;
    }
    return out;
}

NSString *BRIDNAEncodeHost(NSString *host)
{
    if (!host.length || [host canBeConvertedToEncoding:NSASCIIStringEncoding]) return host;
    NSMutableArray *labels = [NSMutableArray array];
    for (NSString *label in [host componentsSeparatedByString:@"."]) {
        if ([label canBeConvertedToEncoding:NSASCIIStringEncoding]) { [labels addObject:label]; continue; }
        NSString *mapped = [[label precomposedStringWithCompatibilityMapping] lowercaseString];
        NSData *utf32 = [mapped dataUsingEncoding:NSUTF32LittleEndianStringEncoding];
        NSString *encoded = utf32.length ? BRPunycodeEncode((const uint32_t *)utf32.bytes, utf32.length / 4) : nil;
        if (!encoded.length) return host;   // give up: the URL will fail like before
        [labels addObject:[@"xn--" stringByAppendingString:encoded]];
    }
    return [labels componentsJoinedByString:@"."];
}

NSString *BRBase64Encode(NSData *data)
{
    static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const uint8_t *bytes = data.bytes;
    NSUInteger length = data.length;
    NSMutableString *out = [NSMutableString stringWithCapacity:(length + 2) / 3 * 4];
    for (NSUInteger i = 0; i < length; i += 3) {
        uint32_t v = (uint32_t)bytes[i] << 16;
        if (i + 1 < length) v |= (uint32_t)bytes[i + 1] << 8;
        if (i + 2 < length) v |= bytes[i + 2];
        [out appendFormat:@"%c%c", table[(v >> 18) & 63], table[(v >> 12) & 63]];
        [out appendFormat:@"%c", i + 1 < length ? table[(v >> 6) & 63] : '='];
        [out appendFormat:@"%c", i + 2 < length ? table[v & 63] : '='];
    }
    return out;
}

id BRCookieLock(void)
{
    static id lock;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ lock = [NSObject new]; });
    return lock;
}

NSData *BRBase64Decode(NSString *string)
{
    NSData *ascii = [string dataUsingEncoding:NSASCIIStringEncoding allowLossyConversion:YES];
    const uint8_t *in = ascii.bytes;
    NSUInteger length = ascii.length;
    NSMutableData *out = [NSMutableData dataWithCapacity:length / 4 * 3 + 3];
    uint32_t acc = 0;
    int bits = 0;
    for (NSUInteger i = 0; i < length; i++) {
        uint8_t c = in[i], v;
        if (c >= 'A' && c <= 'Z') v = c - 'A';
        else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
        else if (c >= '0' && c <= '9') v = c - '0' + 52;
        else if (c == '+' || c == '-') v = 62;
        else if (c == '/' || c == '_') v = 63;
        else if (c == '=') break;
        else continue;   // whitespace and line breaks
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            uint8_t byte = (uint8_t)(acc >> bits);
            [out appendBytes:&byte length:1];
        }
    }
    return out;
}

NSString *BRHTMLEscape(NSString *string)
{
    if (!string) return @"";
    NSMutableString *s = [string mutableCopy];
    [s replaceOccurrencesOfString:@"&" withString:@"&amp;" options:0 range:NSMakeRange(0, s.length)];
    [s replaceOccurrencesOfString:@"<" withString:@"&lt;" options:0 range:NSMakeRange(0, s.length)];
    [s replaceOccurrencesOfString:@">" withString:@"&gt;" options:0 range:NSMakeRange(0, s.length)];
    [s replaceOccurrencesOfString:@"\"" withString:@"&quot;" options:0 range:NSMakeRange(0, s.length)];
    [s replaceOccurrencesOfString:@"'" withString:@"&#39;" options:0 range:NSMakeRange(0, s.length)];
    return s;
}
