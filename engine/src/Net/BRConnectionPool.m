#import "BRConnectionPool.h"
#import "BRTLSSocket.h"
#import "BRSettings.h"
#import "BRCommon.h"

static const NSTimeInterval BRIdleTimeout = 25;     // most servers drop idle connections after 5 to 60 s
static const NSUInteger BRMaxIdlePerKey = 6;
static const NSUInteger BRMaxIdleTotal = 24;

@interface BRPooledConnection : NSObject
@property (nonatomic, strong) BRTLSSocket *socket;
@property (nonatomic) NSTimeInterval lastUsed;
@end

@implementation BRPooledConnection
@end

@implementation BRConnectionPool {
    NSMutableDictionary *_idle;     // key -> NSMutableArray<BRPooledConnection>
    NSUInteger _count;
    NSUInteger _reuses;
    uint32_t _firstSerial;          // sockets made before this one (see closeAllConnections) are not taken back
}

+ (instancetype)shared
{
    static BRConnectionPool *pool;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ pool = [[BRConnectionPool alloc] init]; });
    return pool;
}

- (instancetype)init
{
    self = [super init];
    if (self) _idle = [NSMutableDictionary dictionary];
    return self;
}

// Must be called with the lock held. Moves expired connections into `dead`.
- (void)pruneLocked:(NSMutableArray *)dead
{
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    NSMutableArray *emptyKeys = [NSMutableArray array];
    for (NSString *key in _idle) {
        NSMutableArray *list = _idle[key];
        for (NSInteger i = (NSInteger)list.count - 1; i >= 0; i--) {
            BRPooledConnection *c = list[(NSUInteger)i];
            if (now - c.lastUsed > BRIdleTimeout) {
                [dead addObject:c.socket];
                [list removeObjectAtIndex:(NSUInteger)i];
                _count--;
            }
        }
        if (!list.count) [emptyKeys addObject:key];
    }
    [_idle removeObjectsForKeys:emptyKeys];
}

- (BRTLSSocket *)checkoutSocketForKey:(NSString *)key
{
    if (!key) return nil;
    // (one made while certificates were not checked is no connection for a request that checks them)
    BOOL verifying = [BRSettings verifyTLS];
    NSMutableArray *dead = [NSMutableArray array];
    BRTLSSocket *result = nil;
    @synchronized (self) {
        [self pruneLocked:dead];
        NSMutableArray *list = _idle[key];
        while (list.count && !result) {
            BRPooledConnection *c = [list lastObject];
            [list removeLastObject];
            _count--;
            BOOL fits = c.socket.plain || c.socket.verified || !verifying;
            if (fits && [c.socket isLikelyAlive]) result = c.socket;
            else [dead addObject:c.socket];
        }
        if (result) _reuses++;
    }
    for (BRTLSSocket *s in dead) [s close];
    return result;
}

- (void)checkinSocket:(BRTLSSocket *)socket forKey:(NSString *)key
{
    if (!socket || !key) return;
    NSMutableArray *dead = [NSMutableArray array];
    @synchronized (self) {
        [self pruneLocked:dead];
        NSMutableArray *list = _idle[key];
        if (!list) {
            list = [NSMutableArray array];
            _idle[key] = list;
        }
        if (socket.serial < _firstSerial || list.count >= BRMaxIdlePerKey || _count >= BRMaxIdleTotal) {
            [dead addObject:socket];
        } else {
            BRPooledConnection *c = [[BRPooledConnection alloc] init];
            c.socket = socket;
            c.lastUsed = [NSDate timeIntervalSinceReferenceDate];
            [list addObject:c];
            _count++;
        }
    }
    for (BRTLSSocket *s in dead) [s close];
}

- (void)drain
{
    NSMutableArray *dead = [NSMutableArray array];
    @synchronized (self) {
        for (NSString *key in _idle) {
            for (BRPooledConnection *c in _idle[key]) [dead addObject:c.socket];
        }
        [_idle removeAllObjects];
        _count = 0;
    }
    for (BRTLSSocket *s in dead) [s close];
    if (dead.count) BRLog(@"Connection pool drained (%lu closed)", (unsigned long)dead.count);
}

+ (void)closeAllConnections
{
    BRConnectionPool *pool = [self shared];
    // (the requests under way give their sockets back when they finish: those are closed then, see checkinSocket)
    @synchronized (pool) { pool->_firstSerial = [BRTLSSocket latestSerial] + 1; }
    [pool drain];
}

- (NSUInteger)idleCount
{
    @synchronized (self) { return _count; }
}

- (NSUInteger)reuseCount
{
    @synchronized (self) { return _reuses; }
}

@end
