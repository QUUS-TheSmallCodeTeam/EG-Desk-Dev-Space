//! host-observe line protocol (version 1). One JSON object per line, UTF-8,
//! each inbound line at most MAX_INBOUND_LINE bytes.
//!
//! Client → helper
//!   {"type":"hello","v":1,"nonce":"<run nonce>"}            first line, within HELLO_TIMEOUT
//!   {"type":"ping","seq":N}                                  heartbeat; any line resets the deadline
//!   {"id":"r1","type":"snapshot"}                           apps + frontmost + windows + permissions + service
//!   {"id":"r2","type":"listApps"}
//!   {"id":"r3","type":"listWindows","allLayers":false,"titles":false}
//!   {"id":"r4","type":"permissions"}                        preflight only, never a request/prompt
//!   {"id":"r5","type":"service"}                            com.openai.sky.CUAService running?
//!   {"id":"r6","type":"shutdown"}
//! Helper → client
//!   {"type":"hello.ok","v":1,"pid":..,"monoMs":T,"mode":"observe","capabilities":{..},"heartbeatTimeoutMs":..}
//!   {"type":"hello.rejected","code":"bad_nonce"|"bad_hello"|"peer_uid"}
//!   {"type":"pong","seq":N,"monoMs":T}
//!   {"type":"result","id":"r1","ok":true,"result":{..}}
//!   {"type":"result","id":"r1","ok":false,"code":"observe_only"|"bad_request","message":".."}
//!   {"type":"event","event":"app.activated","seq":N,"monoMs":T,"app":{bundleId,pid,name}}
//!   {"type":"event","event":"service.changed","seq":N,"monoMs":T,"service":{bundleId,running,pids}}
//!
//! Observation only: there is no request that posts input, captures pixels or
//! writes accessibility attributes. Any other request type is answered with
//! observe_only. No typed text, key, coordinate or window content is read.

use serde::Serialize;
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_INBOUND_LINE: usize = 16 * 1024;
pub const MAX_NONCE_LINE: usize = 512;
pub const HELLO_TIMEOUT_MS: u64 = 2_000;
pub const MAX_AUTH_FAILURES: u32 = 5;
pub const MAX_REQUEST_ID: usize = 64;
pub const MAX_APPS: usize = 512;
pub const MAX_WINDOWS: usize = 1_000;
pub const MAX_TEXT: usize = 256;
pub const SERVICE_BUNDLE_ID: &str = "com.openai.sky.CUAService";

/// Truncates on a character boundary so names never split a code point.
pub fn bounded_text(value: &str) -> String {
    if value.len() <= MAX_TEXT {
        return value.to_string();
    }
    let mut end = MAX_TEXT;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRef {
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub name: Option<String>,
    pub active: bool,
    /// "regular" (Dock app) or "accessory" (menu-bar/agent app).
    pub policy: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub window_id: u32,
    pub pid: i32,
    pub owner_name: Option<String>,
    pub layer: i32,
    pub on_screen: bool,
    pub bounds: WindowBounds,
    /// Only when the request asked for titles and Screen Recording preflight is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WindowQuery {
    pub all_layers: bool,
    pub titles: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowList {
    pub windows: Vec<WindowInfo>,
    /// "included" | "not-requested" | "omitted-no-permission"
    pub titles: &'static str,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub accessibility: bool,
    pub screen_recording: bool,
    pub input_monitoring: bool,
    /// Always false: host-observe only previews (Preflight); it never asks.
    pub requested: bool,
    /// Whether this process runs from inside a .app bundle. When false, macOS
    /// attributes these grants to the process that launched us (for example
    /// the terminal or EG-Desk itself), not to an EG-Desk Host Agent.app.
    pub bundled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub bundle_id: &'static str,
    pub running: bool,
    pub pids: Vec<i32>,
}

impl ServiceStatus {
    pub fn new(mut pids: Vec<i32>) -> Self {
        pids.sort_unstable();
        pids.dedup();
        pids.truncate(16);
        ServiceStatus { bundle_id: SERVICE_BUNDLE_ID, running: !pids.is_empty(), pids }
    }
}

/// What the platform layer provides. macOS: host/macos.rs. Tests: a fake.
pub trait Observer: Send + Sync {
    fn apps(&self) -> Vec<AppInfo>;
    fn frontmost(&self) -> Option<AppRef>;
    fn windows(&self, query: WindowQuery) -> WindowList;
    fn permissions(&self) -> Permissions;
    fn service(&self) -> ServiceStatus;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEvent {
    AppActivated(AppRef),
    ServiceChanged(ServiceStatus),
}

impl HostEvent {
    pub fn to_line(&self, seq: u64, mono_ms: u64) -> String {
        let value = match self {
            HostEvent::AppActivated(app) => json!({
                "type": "event", "event": "app.activated", "seq": seq, "monoMs": mono_ms, "app": app,
            }),
            HostEvent::ServiceChanged(service) => json!({
                "type": "event", "event": "service.changed", "seq": seq, "monoMs": mono_ms, "service": service,
            }),
        };
        value.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestKind {
    Snapshot,
    ListApps,
    ListWindows(WindowQuery),
    Permissions,
    Service,
    Shutdown,
    /// Anything else, including every input, capture or AX-write name.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    Hello { nonce: String },
    Ping { seq: u64 },
    Request { id: String, kind: RequestKind },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    NotJson,
    BadShape(&'static str),
}

fn request_id(value: &Value) -> Result<String, ProtocolError> {
    match value.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() && id.len() <= MAX_REQUEST_ID && id.bytes().all(|b| b.is_ascii_graphic()) => {
            Ok(id.to_string())
        }
        _ => Err(ProtocolError::BadShape("id")),
    }
}

pub fn parse_inbound(line: &str) -> Result<Inbound, ProtocolError> {
    let value: Value = serde_json::from_str(line).map_err(|_| ProtocolError::NotJson)?;
    let object = value.as_object().ok_or(ProtocolError::BadShape("object"))?;
    let kind = object.get("type").and_then(Value::as_str).ok_or(ProtocolError::BadShape("type"))?;
    match kind {
        "hello" => {
            if object.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
                return Err(ProtocolError::BadShape("v"));
            }
            let nonce = object.get("nonce").and_then(Value::as_str).ok_or(ProtocolError::BadShape("nonce"))?;
            Ok(Inbound::Hello { nonce: nonce.to_string() })
        }
        "ping" => {
            let seq = object.get("seq").and_then(Value::as_u64).ok_or(ProtocolError::BadShape("seq"))?;
            Ok(Inbound::Ping { seq })
        }
        _ => {
            let id = request_id(&value)?;
            let flag = |name: &str| object.get(name).and_then(Value::as_bool).unwrap_or(false);
            let kind = match kind {
                "snapshot" => RequestKind::Snapshot,
                "listApps" => RequestKind::ListApps,
                "listWindows" => RequestKind::ListWindows(WindowQuery { all_layers: flag("allLayers"), titles: flag("titles") }),
                "permissions" => RequestKind::Permissions,
                "service" => RequestKind::Service,
                "shutdown" => RequestKind::Shutdown,
                _ => RequestKind::Unsupported,
            };
            Ok(Inbound::Request { id, kind })
        }
    }
}

/// The run's nonce line on stdin: {"v":1,"nonce":"..."}.
pub fn parse_nonce_line(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line.trim_end()).ok()?;
    if value.get("v").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
        return None;
    }
    let nonce = value.get("nonce").and_then(Value::as_str)?;
    crate::auth::valid_secret(nonce).then(|| nonce.to_string())
}

/// monoMs (milliseconds since the helper started) lets the client map event
/// monoMs onto its own clock: at = clientNow - (monoMs_now - event.monoMs).
pub fn hello_ok(pid: u32, heartbeat_timeout_ms: u64, mono_ms: u64) -> String {
    json!({
        "type": "hello.ok",
        "v": PROTOCOL_VERSION,
        "pid": pid,
        "monoMs": mono_ms,
        "mode": "observe",
        "capabilities": { "observe": true, "input": false, "capture": false, "accessibility": false },
        "heartbeatTimeoutMs": heartbeat_timeout_ms,
    })
    .to_string()
}

pub fn hello_rejected(code: &str) -> String {
    json!({ "type": "hello.rejected", "code": code }).to_string()
}

pub fn pong(seq: u64, mono_ms: u64) -> String {
    json!({ "type": "pong", "seq": seq, "monoMs": mono_ms }).to_string()
}

fn ok(id: &str, result: Value) -> String {
    json!({ "type": "result", "id": id, "ok": true, "result": result }).to_string()
}

pub fn failure(id: Option<&str>, code: &str, message: &str) -> String {
    json!({ "type": "result", "id": id, "ok": false, "code": code, "message": message }).to_string()
}

/// Answers one request. The bool is true for shutdown.
pub fn answer(observer: &dyn Observer, id: &str, kind: &RequestKind) -> (String, bool) {
    let line = match kind {
        RequestKind::Snapshot => ok(
            id,
            json!({
                "apps": observer.apps(),
                "frontmost": observer.frontmost(),
                "windows": observer.windows(WindowQuery::default()),
                "permissions": observer.permissions(),
                "service": observer.service(),
            }),
        ),
        RequestKind::ListApps => ok(id, json!({ "apps": observer.apps(), "frontmost": observer.frontmost() })),
        RequestKind::ListWindows(query) => ok(id, json!(observer.windows(*query))),
        RequestKind::Permissions => ok(id, json!(observer.permissions())),
        RequestKind::Service => ok(id, json!(observer.service())),
        RequestKind::Shutdown => return (ok(id, json!({ "stopping": true })), true),
        RequestKind::Unsupported => failure(
            Some(id),
            "observe_only",
            "This helper only observes: no input, capture or accessibility actions",
        ),
    };
    (line, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_and_ping_parse() {
        assert_eq!(
            parse_inbound(r#"{"type":"hello","v":1,"nonce":"abc"}"#),
            Ok(Inbound::Hello { nonce: "abc".into() })
        );
        assert_eq!(parse_inbound(r#"{"type":"hello","v":2,"nonce":"abc"}"#), Err(ProtocolError::BadShape("v")));
        assert_eq!(parse_inbound(r#"{"type":"ping","seq":7}"#), Ok(Inbound::Ping { seq: 7 }));
        assert_eq!(parse_inbound("not json"), Err(ProtocolError::NotJson));
        assert_eq!(parse_inbound("[1]"), Err(ProtocolError::BadShape("object")));
    }

    #[test]
    fn requests_need_a_bounded_id_and_unknown_types_are_unsupported() {
        assert_eq!(
            parse_inbound(r#"{"id":"r1","type":"listWindows","titles":true}"#),
            Ok(Inbound::Request { id: "r1".into(), kind: RequestKind::ListWindows(WindowQuery { all_layers: false, titles: true }) })
        );
        assert_eq!(
            parse_inbound(r#"{"id":"r2","type":"click","x":1,"y":2}"#),
            Ok(Inbound::Request { id: "r2".into(), kind: RequestKind::Unsupported })
        );
        assert_eq!(parse_inbound(r#"{"type":"snapshot"}"#), Err(ProtocolError::BadShape("id")));
        let long = format!(r#"{{"id":"{}","type":"snapshot"}}"#, "x".repeat(MAX_REQUEST_ID + 1));
        assert_eq!(parse_inbound(&long), Err(ProtocolError::BadShape("id")));
        assert_eq!(parse_inbound(r#"{"id":"a b","type":"snapshot"}"#), Err(ProtocolError::BadShape("id")));
    }

    #[test]
    fn nonce_line_is_versioned_and_validated() {
        let nonce = "a".repeat(64);
        assert_eq!(parse_nonce_line(&format!("{{\"v\":1,\"nonce\":\"{nonce}\"}}\n")), Some(nonce.clone()));
        assert_eq!(parse_nonce_line(&format!("{{\"v\":2,\"nonce\":\"{nonce}\"}}")), None);
        assert_eq!(parse_nonce_line(r#"{"v":1,"nonce":"short"}"#), None);
        assert_eq!(parse_nonce_line("garbage"), None);
    }

    #[test]
    fn bounded_text_keeps_whole_characters() {
        let name = "가".repeat(200); // 600 bytes
        let cut = bounded_text(&name);
        assert!(cut.len() <= MAX_TEXT);
        assert!(cut.chars().all(|c| c == '가'));
        assert_eq!(bounded_text("Finder"), "Finder");
    }

    #[test]
    fn events_serialize_with_seq_and_clock() {
        let line = HostEvent::AppActivated(AppRef { bundle_id: Some("com.apple.finder".into()), pid: 42, name: Some("Finder".into()) })
            .to_line(3, 1500);
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["event"], "app.activated");
        assert_eq!(value["seq"], 3);
        assert_eq!(value["monoMs"], 1500);
        assert_eq!(value["app"]["bundleId"], "com.apple.finder");
        let service = HostEvent::ServiceChanged(ServiceStatus::new(vec![9, 9, 3])).to_line(4, 1600);
        let value: Value = serde_json::from_str(&service).unwrap();
        assert_eq!(value["service"], json!({ "bundleId": SERVICE_BUNDLE_ID, "running": true, "pids": [3, 9] }));
    }

    #[test]
    fn hello_ok_says_observe_only() {
        let value: Value = serde_json::from_str(&hello_ok(10, 5000, 12)).unwrap();
        assert_eq!(value["monoMs"], 12);
        assert_eq!(value["mode"], "observe");
        assert_eq!(value["capabilities"]["input"], false);
        assert_eq!(value["capabilities"]["capture"], false);
        assert_eq!(value["heartbeatTimeoutMs"], 5000);
    }
}
