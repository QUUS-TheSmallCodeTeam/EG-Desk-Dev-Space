#import <Cocoa/Cocoa.h>
#import <dispatch/dispatch.h>
#import <fcntl.h>
#import <netinet/in.h>
#import <sys/socket.h>
#import <unistd.h>

static const uint16_t kHelperPort = 39217;

static BOOL egd_send_all(int fd, const void *bytes, size_t length) {
    const uint8_t *cursor = (const uint8_t *)bytes;
    size_t remaining = length;
    while (remaining > 0) {
        ssize_t sent = send(fd, cursor, remaining, 0);
        if (sent <= 0) {
            return NO;
        }
        cursor += sent;
        remaining -= (size_t)sent;
    }
    return YES;
}

static NSArray<NSString *> *egd_phase_names(NSEventPhase phase) {
    NSMutableArray<NSString *> *names = [NSMutableArray array];
    if (phase & NSEventPhaseMayBegin) [names addObject:@"mayBegin"];
    if (phase & NSEventPhaseBegan) [names addObject:@"began"];
    if (phase & NSEventPhaseStationary) [names addObject:@"stationary"];
    if (phase & NSEventPhaseChanged) [names addObject:@"changed"];
    if (phase & NSEventPhaseEnded) [names addObject:@"ended"];
    if (phase & NSEventPhaseCancelled) [names addObject:@"cancelled"];
    return names;
}

@interface EGDGestureServer : NSObject
@property(nonatomic, assign) int listenFD;
@property(nonatomic, strong) NSMutableArray<NSNumber *> *clients;
@property(nonatomic, strong) dispatch_source_t acceptSource;
@property(nonatomic, strong) dispatch_source_t keepAliveTimer;
- (BOOL)start;
- (void)broadcastJSON:(NSDictionary *)payload;
@end

@implementation EGDGestureServer

- (instancetype)init {
    self = [super init];
    if (self) {
        _listenFD = -1;
        _clients = [NSMutableArray array];
    }
    return self;
}

- (BOOL)start {
    self.listenFD = socket(AF_INET, SOCK_STREAM, 0);
    if (self.listenFD < 0) return NO;

    int reuse = 1;
    setsockopt(self.listenFD, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    fcntl(self.listenFD, F_SETFL, O_NONBLOCK);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_len = sizeof(addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons(kHelperPort);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(self.listenFD, (struct sockaddr *)&addr, sizeof(addr)) < 0) return NO;
    if (listen(self.listenFD, 16) < 0) return NO;

    self.acceptSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, self.listenFD, 0, dispatch_get_main_queue());
    __weak typeof(self) weakSelf = self;
    dispatch_source_set_event_handler(self.acceptSource, ^{
        [weakSelf acceptPendingClients];
    });
    dispatch_source_set_cancel_handler(self.acceptSource, ^{
        if (weakSelf.listenFD >= 0) close(weakSelf.listenFD);
    });
    dispatch_resume(self.acceptSource);

    self.keepAliveTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(self.keepAliveTimer, dispatch_time(DISPATCH_TIME_NOW, 10ull * NSEC_PER_SEC), 10ull * NSEC_PER_SEC, 1ull * NSEC_PER_SEC);
    dispatch_source_set_event_handler(self.keepAliveTimer, ^{
        [weakSelf sendKeepAlive];
    });
    dispatch_resume(self.keepAliveTimer);

    NSLog(@"[egdesk-gesture-helper] listening on http://127.0.0.1:%d", kHelperPort);
    return YES;
}

- (void)acceptPendingClients {
    while (true) {
        int clientFD = accept(self.listenFD, NULL, NULL);
        if (clientFD < 0) break;
        [self handleClient:clientFD];
    }
}

- (void)handleClient:(int)clientFD {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        char buffer[8192];
        ssize_t readCount = recv(clientFD, buffer, sizeof(buffer) - 1, 0);
        if (readCount <= 0) {
            close(clientFD);
            return;
        }
        buffer[readCount] = '\0';
        NSString *request = [NSString stringWithUTF8String:buffer];
        if ([request hasPrefix:@"GET /events "]) {
            NSString *headers =
                @"HTTP/1.1 200 OK\r\n"
                 "Content-Type: text/event-stream\r\n"
                 "Cache-Control: no-cache\r\n"
                 "Connection: keep-alive\r\n"
                 "Access-Control-Allow-Origin: *\r\n"
                 "X-Accel-Buffering: no\r\n"
                 "\r\n"
                 "event: ready\n"
                 "data: {\"ok\":true}\n\n";
            if (!egd_send_all(clientFD, headers.UTF8String, headers.length)) {
                close(clientFD);
                return;
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                [self.clients addObject:@(clientFD)];
            });
            return;
        }

        NSString *body = [request hasPrefix:@"GET /health "] ? @"{\"ok\":true}\n" : @"Not found\n";
        NSString *status = [request hasPrefix:@"GET /health "] ? @"200 OK" : @"404 Not Found";
        NSString *response = [NSString stringWithFormat:
            @"HTTP/1.1 %@\r\n"
             "Content-Type: text/plain; charset=utf-8\r\n"
             "Content-Length: %lu\r\n"
             "Access-Control-Allow-Origin: *\r\n"
             "Connection: close\r\n"
             "\r\n"
             "%@",
             status,
             (unsigned long)[body lengthOfBytesUsingEncoding:NSUTF8StringEncoding],
             body];
        egd_send_all(clientFD, response.UTF8String, response.length);
        close(clientFD);
    });
}

- (void)broadcastJSON:(NSDictionary *)payload {
    if (self.clients.count == 0) return;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (!jsonData) return;
    NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    NSString *message = [NSString stringWithFormat:@"event: gesture\ndata: %@\n\n", json];
    NSData *frame = [message dataUsingEncoding:NSUTF8StringEncoding];

    NSMutableArray<NSNumber *> *dead = [NSMutableArray array];
    for (NSNumber *fdNum in self.clients) {
        int fd = fdNum.intValue;
        if (!egd_send_all(fd, frame.bytes, frame.length)) {
            [dead addObject:fdNum];
            close(fd);
        }
    }
    [self.clients removeObjectsInArray:dead];
}

- (void)sendKeepAlive {
    NSData *frame = [@":keepalive\n\n" dataUsingEncoding:NSUTF8StringEncoding];
    NSMutableArray<NSNumber *> *dead = [NSMutableArray array];
    for (NSNumber *fdNum in self.clients) {
        int fd = fdNum.intValue;
        if (!egd_send_all(fd, frame.bytes, frame.length)) {
            [dead addObject:fdNum];
            close(fd);
        }
    }
    [self.clients removeObjectsInArray:dead];
}

@end

@interface EGDGestureMonitor : NSObject
@property(nonatomic, strong) EGDGestureServer *server;
@property(nonatomic, assign) NSInteger sequence;
@property(nonatomic, assign) BOOL inGesture;
@property(nonatomic, strong) id globalMonitor;
@property(nonatomic, strong) id localMonitor;
- (instancetype)initWithServer:(EGDGestureServer *)server;
- (void)start;
@end

@implementation EGDGestureMonitor

- (instancetype)initWithServer:(EGDGestureServer *)server {
    self = [super init];
    if (self) {
        _server = server;
        _sequence = 0;
        _inGesture = NO;
    }
    return self;
}

- (void)start {
    __weak typeof(self) weakSelf = self;
    self.globalMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^(NSEvent *event) {
        [weakSelf handleEvent:event];
    }];
    self.localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent * _Nullable(NSEvent * _Nonnull event) {
        [weakSelf handleEvent:event];
        return event;
    }];
}

- (void)handleEvent:(NSEvent *)event {
    NSArray<NSString *> *phase = egd_phase_names(event.phase);
    NSArray<NSString *> *momentum = egd_phase_names(event.momentumPhase);
    BOOL shouldBegin = [phase containsObject:@"mayBegin"] || [phase containsObject:@"began"];
    BOOL shouldEnd = [phase containsObject:@"ended"] || [phase containsObject:@"cancelled"];
    int64_t tsMs = (int64_t)llround([[NSDate date] timeIntervalSince1970] * 1000.0);

    if (shouldBegin && !self.inGesture) {
        self.inGesture = YES;
        [self broadcastKind:@"gestureScrollBegin" event:event timestamp:tsMs phase:phase momentum:momentum];
    }

    if (self.inGesture) {
        [self broadcastKind:@"gestureScrollUpdate" event:event timestamp:tsMs phase:phase momentum:momentum];
    }

    if (shouldEnd && self.inGesture) {
        [self broadcastKind:@"gestureScrollEnd" event:event timestamp:tsMs phase:phase momentum:momentum];
        self.inGesture = NO;
    }
}

- (void)broadcastKind:(NSString *)kind
                event:(NSEvent *)event
            timestamp:(int64_t)tsMs
                phase:(NSArray<NSString *> *)phase
             momentum:(NSArray<NSString *> *)momentum {
    self.sequence += 1;
    NSDictionary *payload = @{
        @"kind": kind,
        @"seq": @(self.sequence),
        @"tsMs": @(tsMs),
        @"phase": phase,
        @"momentumPhase": momentum,
        @"deltaX": @(event.scrollingDeltaX),
        @"deltaY": @(event.scrollingDeltaY),
        @"hasPreciseScrollingDeltas": @(event.hasPreciseScrollingDeltas),
    };
    [self.server broadcastJSON:payload];
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

        EGDGestureServer *server = [EGDGestureServer new];
        if (![server start]) {
            fprintf(stderr, "[egdesk-gesture-helper] failed to start server\n");
            return 1;
        }

        EGDGestureMonitor *monitor = [[EGDGestureMonitor alloc] initWithServer:server];
        [monitor start];
        [NSApp run];
    }
    return 0;
}
