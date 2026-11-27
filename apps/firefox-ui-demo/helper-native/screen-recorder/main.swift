// egdesk-screen-recorder (temporary name), round d lane L44.
// Records ONLY the windows owned by one process (the EG-Desk Firefox main PID): ScreenCaptureKit with SCContentFilter(display:including:windows).
// Windows of any other app are not in the filter, so they never reach a frame, even when they sit in front of EG-Desk.
// Order is the contract's: capture -> scope (filter) -> mask (CVPixelBuffer, in place) -> encode (AVAssetWriter H.264 MP4).
// The video is the main display's size (points * scale); everything but the included windows is empty. Mask boxes are display points.
// stdin: {"mask":[{"x":..,"y":..,"w":..,"h":..}],"rev":N} (JSON line) or "q". SIGINT/SIGTERM also stop and finalize the file.
// A writer that fails (round d lane L45) never ends the recording silently: the failure (domain, code, underlying error) is emitted as 'segment-closed',
// and the next frame opens a NEW segment file (<out>, <out base>.s2.mp4, ...). Events 'segment' / 'segment-closed' list every part.
// stdout: one JSON line per event: started, windows, progress, mask, segment, segment-closed, stopped, error. Exit 0 on a finished file, 1 on error, 2 on usage.
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
    var segIndex = 0, segFrames = 0, segW = 0, segH = 0, segOpenedAt = Date(), lastPTS = CMTime.invalid, firstPTS = CMTime.invalid
    var pxW = 0, pxH = 0, droppedBusy = 0, droppedOrder = 0, segmentFailures = 0
    let segGroup = DispatchGroup()
    let segmentMaxSec = 60.0
    var lastCloseReason = ""
    var recent: [String] = []   // last frames (pts ms since segment start, delta ms, content rect, scale): kept with a failure so its cause can be read
    let lock = NSLock()
    var boxes: [Box] = []; var rev = 0
    var frames = 0, masked = 0, windowIds: [CGWindowID] = [], stopping = false
    var firstFrameAt: Date?
    let startedAt = Date()
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
        self.pxW = pxW; self.pxH = pxH
        if let why = openSegment(width: pxW, height: pxH, reason: "start") { fail("writer", why) }
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

    /// Full description of an AVFoundation error: domain, code, reason and the underlying NSError chain.
    func describe(_ e: Error?) -> [String: Any] {
        guard let e = e else { return ["localized": "unknown (no error object)"] }
        var out: [String: Any] = [:]
        var cur: NSError? = e as NSError; var chain: [[String: Any]] = []
        while let n = cur, chain.count < 4 {
            var item: [String: Any] = ["domain": n.domain, "code": n.code, "localized": n.localizedDescription]
            if let r = n.localizedFailureReason { item["reason"] = r }
            chain.append(item); cur = n.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        out["localized"] = e.localizedDescription; out["chain"] = chain
        if let f = chain.first { out["domain"] = f["domain"]; out["code"] = f["code"] }
        return out
    }
    func segmentURL(_ i: Int) -> URL {
        if i <= 1 { return outURL }
        let base = outURL.deletingPathExtension().lastPathComponent
        return outURL.deletingLastPathComponent().appendingPathComponent("\(base).s\(i).mp4")
    }
    /// Opens a new segment file. Returns nil on success, or the reason text. Called on the frame queue (and once from start()).
    func openSegment(width: Int, height: Int, reason: String) -> String? {
        segIndex += 1
        let url = segmentURL(segIndex)
        do {
            try? FileManager.default.removeItem(at: url)
            let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
            let settings: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 3_000_000, AVVideoExpectedSourceFrameRateKey: fps, AVVideoMaxKeyFrameIntervalKey: fps * 2, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel]]
            let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            inp.expectsMediaDataInRealTime = true
            w.add(inp); // NO movieFragmentInterval: with fragmented MP4 the writer failed every 10-35 s with AVFoundation -11800 / OSStatus -16341 on a
            // live ScreenCaptureKit feed (measured round d L45: 4 failures in 100 s; 0 in 75 s without it). Crash safety comes from short segments instead.
            guard w.startWriting() else { return "startWriting failed: \(describe(w.error))" }
            writer = w; input = inp; sessionStarted = false; segFrames = 0; segW = width; segH = height; segOpenedAt = Date(); firstPTS = .invalid
            emit(["event": "segment", "index": segIndex, "file": url.path, "reason": reason, "width": width, "height": height, "atMs": Int(Date().timeIntervalSince(startedAt) * 1000)])
            return nil
        } catch { return "\(describe(error))" }
    }
    /// Closes the current segment (failed or not) and reports it with the real error content.
    func closeSegment(reason: String, error: [String: Any]? = nil) {
        guard let w = writer, let inp = input else { return }
        let idx = segIndex, url = segmentURL(segIndex), n = segFrames, opened = segOpenedAt, started = sessionStarted
        let failed = w.status == .failed
        let err: [String: Any]? = error ?? (failed ? describe(w.error) : nil)
        writer = nil; input = nil; sessionStarted = false
        let recentAtClose = recent; recent = []; lastCloseReason = reason
        let lastMs = lastPTS.isValid && firstPTS.isValid ? Int((lastPTS - firstPTS).seconds * 1000) : 0
        func report() {
            var ev: [String: Any] = ["event": "segment-closed", "index": idx, "file": url.path, "frames": n, "reason": reason, "durationMs": lastMs,
                "startMs": Int(opened.timeIntervalSince(startedAt) * 1000), "endMs": Int(Date().timeIntervalSince(startedAt) * 1000), "ok": err == nil && w.status != .failed]
            if err != nil || w.status == .failed { ev["recentFrames"] = recentAtClose }
            if let e = err { ev["error"] = e; if let l = e["localized"] { ev["detail"] = l } }
            if w.status == .failed && err == nil { ev["error"] = describe(w.error); ev["ok"] = false }
            emit(ev)
        }
        if failed || !started {
            if !started { w.cancelWriting(); try? FileManager.default.removeItem(at: url) }
            report(); return
        }
        inp.markAsFinished()
        segGroup.enter()
        w.finishWriting { report(); self.segGroup.leave() }
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
        guard type == .screen, sb.isValid, !stopping else { return }
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
        // Frame size changed (display mode switch): a writer is fixed-size, so continue in a new segment.
        let fw = CVPixelBufferGetWidth(pb), fh = CVPixelBufferGetHeight(pb)
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        // A failed writer is reported with its real error, then the recording continues in a new segment file.
        if let cw = writer, cw.status == .failed || cw.status == .cancelled { segmentFailures += 1; closeSegment(reason: "writer-failed") }
        if writer != nil && (fw != segW || fh != segH) { closeSegment(reason: "frame-size-changed"); lastPTS = .invalid }
        // A non-fragmented MP4 only becomes playable when closed, so a long recording is cut into parts of at most segmentMaxSec: a killed tool loses at most one part.
        if writer != nil && sessionStarted && Date().timeIntervalSince(segOpenedAt) >= segmentMaxSec { closeSegment(reason: "roll") }
        if writer == nil {
            if let why = openSegment(width: fw, height: fh, reason: segIndex == 0 ? "start" : (lastCloseReason == "roll" ? "roll" : "continue-after-failure")) { emit(["event": "error", "reason": "writer", "detail": why, "fatal": false]); return }
        }
        guard let w2 = writer, let inp2 = input else { return }
        // Timestamps must rise inside a segment.
        if lastPTS.isValid && CMTimeCompare(pts, lastPTS) <= 0 && sessionStarted { droppedOrder += 1; return }
        if !sessionStarted { w2.startSession(atSourceTime: pts); sessionStarted = true; firstPTS = pts; if firstFrameAt == nil { firstFrameAt = Date() } }
        do {
            let a = arr.first
            let cr = (a?[.contentRect] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
            let dr = (a?[.dirtyRects] as? [NSDictionary])?.count ?? -1
            let sc = (a?[.scaleFactor] as? NSNumber)?.doubleValue ?? 0
            let dt = lastPTS.isValid ? Int((pts - lastPTS).seconds * 1000) : 0
            recent.append("t=\(firstPTS.isValid ? Int((pts - firstPTS).seconds * 1000) : 0) dt=\(dt) cr=\(cr.map { "\(Int($0.width))x\(Int($0.height))" } ?? "-") dirty=\(dr) sc=\(sc) buf=\(fw)x\(fh)")
            if recent.count > 10 { recent.removeFirst() }
        }
        guard w2.status == .writing else { return }
        if !inp2.isReadyForMoreMediaData { droppedBusy += 1; return }
        if inp2.append(sb) {
            lastPTS = pts
            lock.lock(); frames += 1; segFrames += 1; if !list.isEmpty { masked += 1 }; lock.unlock()
        } else {
            // append refused: the writer has failed. Say why now, then continue in a new segment on the next frame.
            segmentFailures += 1
            closeSegment(reason: "append-failed", error: describe(w2.error))
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
        queue.sync { closeSegment(reason: error == nil ? "stop" : "stop-error") }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in segGroup.notify(queue: .global()) { c.resume() } }
        let (f, m, r) = counts()
        if error == nil && f == 0 { emit(["event": "error", "reason": "no-frames", "detail": "stopped before any frame was written", "frames": 0]); exit(1) }
        if let e = error { emit(["event": "error", "reason": e, "detail": detail, "frames": f]); exit(1) }
        emit(["event": "stopped", "segments": segIndex, "segmentFailures": segmentFailures, "droppedBusy": droppedBusy, "droppedOrder": droppedOrder, "frames": f, "maskedFrames": m, "maskRev": r, "out": outURL.path]); exit(0)
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
