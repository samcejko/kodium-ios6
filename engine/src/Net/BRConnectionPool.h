#import <Foundation/Foundation.h>

@class BRTLSSocket;

// Idle keep-alive connections, keyed by "scheme://host:port". Sockets are handed out most recently
// used first, checked for liveness, and dropped after an idle timeout.
@interface BRConnectionPool : NSObject

+ (instancetype)shared;

// Every idle connection is closed, and those in use now are not taken back afterwards (certificate verification
// switched, private mode entered or left: no connection of before carries on).
+ (void)closeAllConnections;

- (BRTLSSocket *)checkoutSocketForKey:(NSString *)key;      // nil when nothing usable is idle
- (void)checkinSocket:(BRTLSSocket *)socket forKey:(NSString *)key;
- (void)drain;                                              // closes every idle connection (memory warning, background)

@property (nonatomic, readonly) NSUInteger idleCount;
@property (nonatomic, readonly) NSUInteger reuseCount;      // statistics: sockets handed out since launch

@end
