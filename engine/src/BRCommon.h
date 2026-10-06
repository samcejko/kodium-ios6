// Shared macros and constants. Everything here must be iOS 6.0 safe.
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

// Any API newer than the iOS 6.0 deployment target is a hard error in files that include this header.
#pragma clang diagnostic error "-Wunguarded-availability"

#define L(key) NSLocalizedString((key), nil)
#define BRIsPad() (UI_USER_INTERFACE_IDIOM() == UIUserInterfaceIdiomPad)

// Developer mode. The debug key is the trimmed content of Library/surfari-debug-key in the app's home (put there over
// SSH): nil when the file is absent or holds fewer than 16 characters. Read again on every call (it is needed rarely).
// FOUNDATION_EXPORT: C linkage for the Objective-C++ files that use BRLog too.
FOUNDATION_EXPORT NSString *BRDebugKey(void);
// YES when that file exists or the BRDebugLog default is set; decided once per run.
FOUNDATION_EXPORT BOOL BRDebugEnabled(void);

// The system log only on a developer's device: on iOS 6 any app can read it, and the lines carry addresses and titles
// of the pages visited. The arguments are not even evaluated otherwise.
#define BRLog(fmt, ...) do { if (BRDebugEnabled()) NSLog((@"[Surfari] " fmt), ##__VA_ARGS__); } while (0)

extern NSString * const BRErrorDomain;

// NSError codes in BRErrorDomain
enum {
    BRErrorNetwork        = -1,
    BRErrorTLS            = -2,
    BRErrorCertificate    = -3,
    BRErrorTimeout        = -4,
    BRErrorCancelled      = -5,
    BRErrorBadResponse    = -6,
    BRErrorDNS            = -7,
    BRErrorConnect        = -8,
    BRErrorConnectionLost = -9,
};

NSError *BRMakeError(NSInteger code, NSString *message);

// Maps a BRErrorDomain error to the NSURLErrorDomain code WebKit understands; other domains pass through.
NSError *BRURLErrorFromError(NSError *error, NSURL *url);

// Escapes &, <, >, " and ' for inclusion in HTML.
NSString *BRHTMLEscape(NSString *string);

// Resident memory of this process in megabytes (for logging).
double BRResidentMemoryMB(void);

// Internationalised host names: "háčky.cz" -> "xn--hky-lma8e.cz" (RFC 3492 punycode per label, NFKC + lower case).
// ASCII-only input is returned unchanged.
NSString *BRIDNAEncodeHost(NSString *host);

// Standard base64 of arbitrary data (iOS 6 has no public NSData API for it).
NSString *BRBase64Encode(NSData *data);
// The reverse (also the URL-safe alphabet; whitespace skipped, stops at '=').
NSData *BRBase64Decode(NSString *string);

// Our reads and writes of the shared cookie jar hold this lock (@synchronized): the iOS 6 jar (CFNetwork) crashed
// when requests of a loading page read and stored cookies from several threads at once.
id BRCookieLock(void);
