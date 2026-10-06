#import <Foundation/Foundation.h>

// Blocking TLS 1.2 client socket on top of mbedTLS. One instance per connection, used from a
// single worker thread; -cancel may be called from any thread to abort a blocking read.
// Verified handshakes are remembered per host so later connections can resume the session.
@interface BRTLSSocket : NSObject

+ (void)warmUp;                 // parses the CA bundle on a background queue
+ (BOOL)caBundleAvailable;
+ (NSInteger)caCertificateCount;

// Every remembered TLS session is forgotten (certificate verification switched, private mode entered or left): a
// resumed session skips the certificate exchange, and ties the new identity to the old one.
+ (void)flushSessionCache;

// Names of this device itself: localhost, *.localhost and loopback addresses, also in the old numeric forms the
// resolver takes (127.1, 2130706433, 0x7f.1). A host name that is not one never connects to a loopback address
// (DNS rebinding onto the device's own services).
+ (BOOL)isLoopbackHost:(NSString *)host;
// A port the app itself listens on (the media proxy): no connection of the network layer goes there, whatever the name.
+ (void)reserveLoopbackPort:(int)port;
// Sockets get increasing serial numbers when made: the connection pool drops those made before closeAllConnections.
+ (uint32_t)latestSerial;

@property (nonatomic) BOOL plain;   // YES = no TLS, raw TCP (http://)
@property (nonatomic, readonly) uint32_t serial;
@property (nonatomic, readonly) BOOL verified;   // a TLS connection whose certificate was checked

- (BOOL)connectToHost:(NSString *)host port:(int)port verify:(BOOL)verify
     connectTimeoutMs:(int)connectMs readTimeoutMs:(int)readMs error:(NSError **)error;
- (BOOL)writeData:(NSData *)data error:(NSError **)error;
// Returns > 0 bytes read, 0 on EOF, -1 on error (error set).
- (NSInteger)readIntoBuffer:(void *)buffer maxLength:(NSUInteger)maxLength error:(NSError **)error;
- (void)cancel;
- (void)close;

// Keep-alive support
@property (nonatomic, readonly) BOOL isConnected;
- (BOOL)isLikelyAlive;                       // idle socket still open and nothing pending from the peer
- (void)setReadTimeoutMs:(uint32_t)ms;       // applies to subsequent reads

// For a relay that waits on several sockets at once (poll): the TCP descriptor, and whether bytes the TLS layer
// already took from it wait to be read (poll does not see those). The descriptor is -1 until the TCP connection exists
// and stays set after a failed TLS handshake until close: a relay tells by it where a connect failed.
@property (nonatomic, readonly) int fileDescriptor;
- (BOOL)hasBufferedData;

@property (nonatomic, readonly) NSString *cipherSuite;
@property (nonatomic, readonly) NSString *tlsVersion;

@end
