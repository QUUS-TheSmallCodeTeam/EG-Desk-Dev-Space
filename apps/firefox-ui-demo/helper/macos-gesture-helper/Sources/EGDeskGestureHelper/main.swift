import AppKit
import Foundation
import Network

private let helperPort: UInt16 = 39217

struct GesturePayload: Codable {
    let kind: String
    let seq: Int
    let tsMs: Int64
    let phase: [String]
    let momentumPhase: [String]
    let deltaX: Double
    let deltaY: Double
    let hasPreciseScrollingDeltas: Bool
}

final class SSEServer {
    private let queue = DispatchQueue(label: "egdesk.gesture-helper.sse")
    private let listener: NWListener
    private var clients: [UUID: NWConnection] = [:]
    private var keepAliveTimer: DispatchSourceTimer?

    init(port: UInt16) throws {
        listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection: connection)
        }
        listener.start(queue: queue)
        startKeepAlive()
        print("[egdesk-gesture-helper] listening on http://127.0.0.1:\(helperPort)")
    }

    func broadcast(_ payload: GesturePayload) {
        guard !clients.isEmpty else { return }
        let encoder = JSONEncoder()
        guard
            let data = try? encoder.encode(payload),
            let json = String(data: data, encoding: .utf8)
        else { return }
        let message = "event: gesture\ndata: \(json)\n\n"
        let content = Data(message.utf8)
        for (id, connection) in clients {
            connection.send(content: content, completion: .contentProcessed { [weak self] error in
                if error != nil {
                    self?.removeClient(id)
                }
            })
        }
    }

    private func handle(connection: NWConnection) {
        let clientID = UUID()
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.removeClient(clientID)
            default:
                break
            }
        }
        connection.start(queue: queue)
        receiveRequest(from: connection, clientID: clientID)
    }

    private func receiveRequest(from connection: NWConnection, clientID: UUID) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, error in
            guard let self else { return }
            if error != nil {
                connection.cancel()
                return
            }
            let request = String(data: data ?? Data(), encoding: .utf8) ?? ""
            if request.hasPrefix("GET /events ") {
                self.acceptSSE(connection: connection, clientID: clientID)
            } else if request.hasPrefix("GET /health ") {
                self.respond(
                    connection: connection,
                    status: "200 OK",
                    contentType: "application/json; charset=utf-8",
                    body: #"{"ok":true,"port":\#(helperPort)}"#
                )
            } else if request.hasPrefix("OPTIONS ") {
                self.respond(
                    connection: connection,
                    status: "204 No Content",
                    contentType: "text/plain; charset=utf-8",
                    body: ""
                )
            } else {
                self.respond(
                    connection: connection,
                    status: "404 Not Found",
                    contentType: "text/plain; charset=utf-8",
                    body: "Not found\n"
                )
            }
        }
    }

    private func acceptSSE(connection: NWConnection, clientID: UUID) {
        let headers = """
        HTTP/1.1 200 OK\r
        Content-Type: text/event-stream\r
        Cache-Control: no-cache\r
        Connection: keep-alive\r
        Access-Control-Allow-Origin: *\r
        X-Accel-Buffering: no\r
        \r
        event: ready
        data: {"ok":true}

        """
        connection.send(content: Data(headers.utf8), completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            if error != nil {
                connection.cancel()
                return
            }
            self.clients[clientID] = connection
        })
    }

    private func respond(connection: NWConnection, status: String, contentType: String, body: String) {
        let bodyData = Data(body.utf8)
        let response = """
        HTTP/1.1 \(status)\r
        Content-Type: \(contentType)\r
        Content-Length: \(bodyData.count)\r
        Access-Control-Allow-Origin: *\r
        Connection: close\r
        \r
        \(body)
        """
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func startKeepAlive() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 10, repeating: 10)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let payload = Data(":keepalive\n\n".utf8)
            for (id, connection) in self.clients {
                connection.send(content: payload, completion: .contentProcessed { [weak self] error in
                    if error != nil {
                        self?.removeClient(id)
                    }
                })
            }
        }
        keepAliveTimer = timer
        timer.resume()
    }

    private func removeClient(_ id: UUID) {
        if let connection = clients.removeValue(forKey: id) {
            connection.cancel()
        }
    }
}

final class GestureMonitor {
    private let server: SSEServer
    private var nextSequence = 0
    private var inGesture = false
    private var globalMonitor: Any?
    private var localMonitor: Any?

    init(server: SSEServer) {
        self.server = server
    }

    func start() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.handle(event)
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.handle(event)
            return event
        }
    }

    private func handle(_ event: NSEvent) {
        let phase = phaseNames(event.phase)
        let momentum = phaseNames(event.momentumPhase)
        let timestamp = Int64(Date().timeIntervalSince1970 * 1000)

        let shouldBegin = phase.contains("mayBegin") || phase.contains("began")
        let shouldEnd = phase.contains("ended") || phase.contains("cancelled")

        if shouldBegin && !inGesture {
            inGesture = true
            broadcast(kind: "gestureScrollBegin", event: event, tsMs: timestamp, phase: phase, momentumPhase: momentum)
        }

        if inGesture {
            broadcast(kind: "gestureScrollUpdate", event: event, tsMs: timestamp, phase: phase, momentumPhase: momentum)
        }

        if shouldEnd && inGesture {
            broadcast(kind: "gestureScrollEnd", event: event, tsMs: timestamp, phase: phase, momentumPhase: momentum)
            inGesture = false
        }
    }

    private func broadcast(kind: String, event: NSEvent, tsMs: Int64, phase: [String], momentumPhase: [String]) {
        nextSequence += 1
        server.broadcast(
            GesturePayload(
                kind: kind,
                seq: nextSequence,
                tsMs: tsMs,
                phase: phase,
                momentumPhase: momentumPhase,
                deltaX: event.scrollingDeltaX,
                deltaY: event.scrollingDeltaY,
                hasPreciseScrollingDeltas: event.hasPreciseScrollingDeltas
            )
        )
    }

    private func phaseNames(_ phase: NSEvent.Phase) -> [String] {
        var names: [String] = []
        if phase.contains(.mayBegin) { names.append("mayBegin") }
        if phase.contains(.began) { names.append("began") }
        if phase.contains(.stationary) { names.append("stationary") }
        if phase.contains(.changed) { names.append("changed") }
        if phase.contains(.ended) { names.append("ended") }
        if phase.contains(.cancelled) { names.append("cancelled") }
        return names
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var server: SSEServer?
    private var monitor: GestureMonitor?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let server = try SSEServer(port: helperPort)
            let monitor = GestureMonitor(server: server)
            self.server = server
            self.monitor = monitor
            server.start()
            monitor.start()
        } catch {
            fputs("[egdesk-gesture-helper] failed to start: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
