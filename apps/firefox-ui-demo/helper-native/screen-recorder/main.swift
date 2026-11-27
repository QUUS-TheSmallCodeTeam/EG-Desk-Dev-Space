// egdesk-screen-recorder (temporary name), round d lane L44.
// Records ONLY the windows owned by one process (the EG-Desk Firefox main PID): ScreenCaptureKit with SCContentFilter(display:including:windows).
// Windows of any other app are not in the filter, so they never reach a frame, even when they sit in front of EG-Desk.
// Order is the contract's: capture -> scope (filter) -> mask (CVPixelBuffer, in place) -> encode (AVAssetWriter H.264 MP4).
// The video is the main display's size (points * scale); everything but the included windows is empty. Mask boxes are display points.
// stdin: {"mask":[{"x":..,"y":..,"w":..,"h":..}],"rev":N} (JSON line) or "q". SIGINT/SIGTERM also stop and finalize the file.
// stdout: one JSON line per event: started, windows, progress, mask, stopped, error. Exit 0 on a finished file, 1 on error, 2 on usage.
import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreVideo

func emit(_ obj: [String: Any]) {
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: d, encoding: .utf8) {
        FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
    }
}
func fail(_ reason: String, _ detail: String = "", code: Int32 = 1) -> Never {
    emit(["event": "error", "reason": reason, "detail": detail]); exit(code)
}

var pidArg: Int32 = 0, outPath = "", fps = 5, maxSec = 0, scale = 1.0
do {
    var i = 1; let a = CommandLine.arguments
    while i < a.count {
        let k = a[i]; let v: String? = i + 1 < a.count ? a[i + 1] : nil
        switch k {
        case "--pid": pidArg = Int32(v ?? "") ?? 0
        case "--out": outPath = v ?? ""
        case "--fps": fps = Int(v ?? "") ?? 0
        case "--max-sec": maxSec = Int(v ?? "") ?? -1
        case "--scale": scale = Double(v ?? "") ?? 0
        default: fail("usage", "unknown argument \(k)", code: 2)
        }
        i += 2
    }
    if pidArg <= 1 || outPath.isEmpty || fps < 1 || fps > 30 || maxSec < 0 || scale < 0.1 || scale > 2 {
        fail("usage", "--pid <pid> --out <file.mp4> [--fps 1-30] [--max-sec N] [--scale 0.1-2]", code: 2)
    }
}

struct Box { var x: Double, y: Double, w: Double, h: Double }

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let pid: Int32, outURL: URL, fps: Int, scale: Double
    var stream: SCStream?
    var display: SCDisplay?
    var writer: AVAssetWriter?
    var input: AVAssetWriterInput?
    var sessionStarted = false
    let lock = NSLock()
    var boxes: [Box] = []; var rev = 0
    var frames = 0, masked = 0, windowIds: [CGWindowID] = [], stopping = false
    var firstFrameAt: Date?
    let queue = DispatchQueue(label: "egdesk.recorder.frames")

    init(pid: Int32, out: URL, fps: Int, scale: Double) { self.pid = pid; outURL = out; self.fps = fps; self.scale = scale }

    /// Windows of the pid only; the display holding most of their area. nil when the pid has no capturable window.
    func pick(_ content: SCShareableContent) -> (SCDisplay, [SCWindow])? {
        let mine = content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen && $0.frame.width >= 40 && $0.frame.height >= 40 }
        if mine.isEmpty { return nil }
        var best: (SCDisplay, CGFloat)? = nil
        for d in content.displays {
            let area = mine.reduce(CGFloat(0)) { s, w in let r = w.frame.intersection(d.frame); return s + (r.isNull ? 0 : r.width * r.height) }
            if area > 0 && (best == nil || area > best!.1) { best = (d, area) }
        }
        guard let d = (best?.0 ?? content.displays.first) else { return nil }
        return (d, mine.filter { !$0.frame.intersection(d.frame).isNull })
    }

    func start() async {
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
        catch { fail("screen-recording-permission", "SCShareableContent failed: \(error.localizedDescription). Allow Screen Recording for the app that runs this tool (System Settings > Privacy & Security > Screen & System Audio Recording).") }
        guard let (d, wins) = pick(content) else { fail("no-window", "process \(pid) has no on-screen window") }
        display = d; windowIds = wins.map { $0.windowID }.sorted()
        let pxW = Int((Double(d.width) * scale).rounded()) & ~1, pxH = Int((Double(d.height) * scale).rounded()) & ~1
        let cfg = SCStreamConfiguration()
        cfg.width = pxW; cfg.height = pxH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true; cfg.queueDepth = 5
        do {
            try? FileManager.default.removeItem(at: outURL)
            let w = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
            let settings: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: pxW, AVVideoHeightKey: pxH,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 3_000_000, AVVideoExpectedSourceFrameRateKey: fps, AVVideoMaxKeyFrameIntervalKey: fps * 2, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel]]
            let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            inp.expectsMediaDataInRealTime = true
            w.add(inp); w.movieFragmentInterval = CMTime(value: 5, timescale: 1)
            guard w.startWriting() else { fail("writer", w.error?.localizedDescription ?? "startWriting failed") }
            writer = w; input = inp
        } catch { fail("writer", error.localizedDescription) }
        let filter = SCContentFilter(display: d, including: wins)
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        stream = s
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try await s.startCapture()
        } catch { fail("screen-recording-permission", "startCapture failed: \(error.localizedDescription)") }
        emit(["event": "started", "pid": Int(pid), "windows": wins.count, "windowIds": windowIds.map { Int($0) }, "display": ["width": d.width, "height": d.height], "video": ["width": pxW, "height": pxH], "fps": fps, "scale": scale, "out": outURL.path])
        Task { await self.watch() }
        Task { await self.noFrameGuard() }
    }

    /// Every second: new or closed windows of the pid (dialogs) change the filter. Never adds another process's window.
    func watch() async {
        var tick = 0
        while !stopping {
            try? await Task.sleep(nanoseconds: 1_000_000_000); tick += 1
            if stopping { break }
            if let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false), let d = display,
               let wins = Optional(content.windows.filter({ $0.owningApplication?.processID == pid && $0.isOnScreen && $0.frame.width >= 40 && $0.frame.height >= 40 && !$0.frame.intersection(d.frame).isNull })) {
                let ids = wins.map { $0.windowID }.sorted()
                if ids != windowIds && !wins.isEmpty {
                    let refreshed = content.displays.first(where: { $0.displayID == d.displayID }) ?? d
                    do { try await stream?.updateContentFilter(SCContentFilter(display: refreshed, including: wins)); windowIds = ids; emit(["event": "windows", "count": wins.count, "windowIds": ids.map { Int($0) }]) }
                    catch { emit(["event": "error", "reason": "filter-update", "detail": error.localizedDescription, "fatal": false]) }
                } else if wins.isEmpty && !windowIds.isEmpty { windowIds = []; emit(["event": "windows", "count": 0, "windowIds": []]) }
            }
            if tick % 5 == 0 { let (f, m, r) = counts(); emit(["event": "progress", "frames": f, "maskedFrames": m, "maskRev": r, "windows": windowIds.count]) }
        }
    }

    /// A recording that never gets a frame is a failure, not an empty file.
    func noFrameGuard() async {
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        let (f, _, _) = counts()
        if f == 0 && !stopping { await finish(error: "no-frames", detail: "no frame within 6 s (permission denied, or the process windows are not drawn)") }
    }

    func setMask(_ list: [Box], rev r: Int) { lock.lock(); boxes = list; rev = r; lock.unlock(); emit(["event": "mask", "rev": r, "boxes": list.count]) }

    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid, let inp = input, let w = writer, !stopping else { return }
        guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = arr.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        lock.lock(); let list = boxes; lock.unlock()
        if !list.isEmpty {
            CVPixelBufferLockBaseAddress(pb, [])
            if let base = CVPixelBufferGetBaseAddress(pb) {
                let bw = CVPixelBufferGetWidth(pb), bh = CVPixelBufferGetHeight(pb), stride = CVPixelBufferGetBytesPerRow(pb)
                for b in list {
                    let x0 = max(0, Int((b.x * scale).rounded(.down))), y0 = max(0, Int((b.y * scale).rounded(.down)))
                    let x1 = min(bw, Int(((b.x + b.w) * scale).rounded(.up))), y1 = min(bh, Int(((b.y + b.h) * scale).rounded(.up)))
                    if x1 <= x0 || y1 <= y0 { continue }
                    for y in y0..<y1 { let row = base.advanced(by: y * stride + x0 * 4); for i in 0..<((x1 - x0) * 4) { row.storeBytes(of: i % 4 == 3 ? 255 : 0, toByteOffset: i, as: UInt8.self) } }
                }
            }
            CVPixelBufferUnlockBaseAddress(pb, [])
        }
        if !sessionStarted { w.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sb)); sessionStarted = true; firstFrameAt = Date() }
        if inp.isReadyForMoreMediaData, w.status == .writing {
            if inp.append(sb) { lock.lock(); frames += 1; if !list.isEmpty { masked += 1 }; lock.unlock() }
        }
    }

    func stream(_ s: SCStream, didStopWithError error: Error) { Task { await self.finish(error: "stream-stopped", detail: error.localizedDescription) } }

    var finishing = false
    func counts() -> (Int, Int, Int) { lock.lock(); defer { lock.unlock() }; return (frames, masked, rev) }
    func beginFinish() -> Bool { lock.lock(); defer { lock.unlock() }; if finishing { return false }; finishing = true; stopping = true; return true }
    func finish(error: String? = nil, detail: String = "") async {
        if !beginFinish() { return }
        try? await stream?.stopCapture()
        queue.sync {}
        input?.markAsFinished()
        if let w = writer, sessionStarted { await w.finishWriting() } else { writer?.cancelWriting(); try? FileManager.default.removeItem(at: outURL) }
        let (f, m, r) = counts()
        if error == nil && f == 0 { emit(["event": "error", "reason": "no-frames", "detail": "stopped before any frame was written", "frames": 0]); exit(1) }
        if let e = error { emit(["event": "error", "reason": e, "detail": detail, "frames": f]); exit(1) }
        if writer?.status == .failed { emit(["event": "error", "reason": "writer", "detail": writer?.error?.localizedDescription ?? "", "frames": f]); exit(1) }
        emit(["event": "stopped", "frames": f, "maskedFrames": m, "maskRev": r, "out": outURL.path]); exit(0)
    }
}

let rec = Recorder(pid: pidArg, out: URL(fileURLWithPath: outPath), fps: fps, scale: scale)
setbuf(stdout, nil)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { Task { await rec.finish() } }
    src.resume()
    signalSources.append(src)
}
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t == "q" { Task { await rec.finish() }; return }
        guard t.hasPrefix("{"), let d = t.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let m = o["mask"] as? [[String: Any]] else { continue }
        let list = m.compactMap { e -> Box? in
            guard let x = (e["x"] as? NSNumber)?.doubleValue, let y = (e["y"] as? NSNumber)?.doubleValue, let w = (e["w"] as? NSNumber)?.doubleValue, let h = (e["h"] as? NSNumber)?.doubleValue else { return nil }
            return Box(x: x, y: y, w: w, h: h)
        }
        rec.setMask(list, rev: (o["rev"] as? NSNumber)?.intValue ?? 0)
    }
    Task { await rec.finish() }   // stdin closed: the parent is gone, finish the file
}
if maxSec > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(maxSec)) { Task { await rec.finish() } } }
Task { await rec.start() }
dispatchMain()
