//! B1 window content observation, platform-neutral part (owner decision D-C1
//! 2026-10-24, D-C4 observe first; this round's B1 = capture one window +
//! read its accessibility elements, never any input).
//!
//! What lives here is everything that can be tested without macOS: request
//! limits, the accessibility tree walk (generic over [`AxNode`]), which
//! elements count as sensitive, the pixel mask arithmetic, matching an
//! accessibility window to a CGWindow by frame, scaling and base64. The
//! macOS calls (CGWindowListCreateImage, AXUIElement, ImageIO) are in
//! macos_content.rs and only feed this module.
//!
//! Protection rules implemented here (docs: reports/l6-u1b.md):
//! - password fields (AXSecureTextField) and text entries whose label,
//!   description, placeholder, identifier or help names a secret (password,
//!   one-time code, card number, ...) are masked in the pixels and their value
//!   is never read;
//! - a web area whose content cannot be read is masked as a whole;
//! - fail closed: if the tree could not be read completely (node, depth or
//!   time budget, a failed read) or a sensitive element has no frame, there is
//!   no image at all (mask_unavailable).

use serde::Serialize;
use std::time::Instant;

pub const MAX_ELEMENTS: usize = 400;
pub const MAX_WALK_NODES: usize = 6_000;
pub const MAX_DEPTH: usize = 24;
pub const MAX_CHILDREN: usize = 500;
pub const MAX_LABEL: usize = 120;
pub const MAX_VALUE: usize = 200;
pub const WALK_BUDGET_MS: u64 = 3_000;
pub const MIN_EDGE: u32 = 256;
pub const DEFAULT_EDGE: u32 = 1_280;
pub const MAX_EDGE: u32 = 2_048;
/// Keeps the base64 reply under the supervisor's 1 MiB inbound line limit.
pub const MAX_JPEG_BYTES: usize = 600 * 1024;
pub const MASK_PAD_POINTS: f64 = 3.0;
pub const FRAME_TOLERANCE: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }
    pub fn right(&self) -> f64 {
        self.x + self.width
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }
    pub fn is_finite(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite()) && self.width >= 0.0 && self.height >= 0.0
    }
    pub fn close_to(&self, other: &Rect, tolerance: f64) -> bool {
        (self.x - other.x).abs() <= tolerance
            && (self.y - other.y).abs() <= tolerance
            && (self.width - other.width).abs() <= tolerance
            && (self.height - other.height).abs() <= tolerance
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObserveError {
    pub code: &'static str,
    pub message: String,
}

impl ObserveError {
    pub fn new(code: &'static str, message: impl Into<String>) -> ObserveError {
        ObserveError { code, message: message.into() }
    }
    pub fn observe_only() -> ObserveError {
        ObserveError::new("observe_only", "This helper only observes: capture and accessibility reads are off, and there is no input")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureQuery {
    pub window_id: u32,
    pub pid: i32,
    pub max_edge: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementsQuery {
    pub window_id: u32,
    pub pid: i32,
}

#[derive(Debug, Clone, Default)]
pub struct NodeAttrs {
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub role_description: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub placeholder: Option<String>,
    pub identifier: Option<String>,
    pub help: Option<String>,
    pub enabled: Option<bool>,
    pub focused: Option<bool>,
    pub frame: Option<Rect>,
}

/// One accessibility element. `children` is Err only when the read really
/// failed; an element without children (attribute unsupported or no value)
/// is Ok(empty).
pub trait AxNode: Sized {
    fn attrs(&self) -> NodeAttrs;
    /// The element's value. Called only for an element that is not sensitive,
    /// so a secret's value is never read into this process.
    fn value(&self) -> Option<String>;
    fn children(&self) -> Result<Vec<Self>, ()>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub index: String,
    pub depth: usize,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Absent for a sensitive element: its value is never read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sensitive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub focused: bool,
    /// Window points, origin = the window's top-left corner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaskRegion {
    pub rect: Rect,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Default)]
pub struct Walk {
    pub elements: Vec<Element>,
    pub regions: Vec<MaskRegion>,
    /// More elements existed than MAX_ELEMENTS.
    pub truncated: bool,
    /// The whole tree was read within the budgets.
    pub complete: bool,
    /// Sensitive elements that have no frame (cannot be masked).
    pub unframed_sensitive: usize,
    pub sensitive_count: usize,
    pub nodes: usize,
}

fn clean(value: &str, max: usize) -> String {
    let mut text: String = value.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if text.len() > max {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text.trim().to_string()
}

fn non_empty(value: &Option<String>, max: usize) -> Option<String> {
    value.as_deref().map(|v| clean(v, max)).filter(|v| !v.is_empty())
}

const ENTRY_ROLES: [&str; 5] = ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField", "AXSearchField"];
const PHRASES: [&str; 22] = [
    "password", "passcode", "passwd", "secret", "token", "api key", "apikey", "one-time", "one time code", "verification code",
    "security code", "card number", "credit card", "social security", "비밀번호", "암호", "패스워드", "인증번호", "보안코드",
    "카드번호", "주민등록", "비번",
];
const WHOLE_WORDS: [&str; 5] = ["pin", "otp", "cvv", "cvc", "ssn"];

/// Whether a label-like text names a secret.
pub fn names_a_secret(text: &str) -> bool {
    let lower = text.to_lowercase();
    if PHRASES.iter().any(|phrase| lower.contains(phrase)) {
        return true;
    }
    lower.split(|c: char| !c.is_alphanumeric()).any(|word| WHOLE_WORDS.contains(&word))
}

/// Some(reason) when the element is sensitive.
pub fn sensitive_reason(attrs: &NodeAttrs) -> Option<&'static str> {
    let subrole = attrs.subrole.as_deref().unwrap_or("");
    let role = attrs.role.as_deref().unwrap_or("");
    let description = attrs.role_description.as_deref().unwrap_or("").to_lowercase();
    if subrole == "AXSecureTextField" || role == "AXSecureTextField" || description.contains("secure") {
        return Some("secure_field");
    }
    if ENTRY_ROLES.contains(&role) {
        let hints = [&attrs.title, &attrs.description, &attrs.placeholder, &attrs.identifier, &attrs.help];
        if hints.iter().filter_map(|hint| hint.as_deref()).any(names_a_secret) {
            return Some("sensitive_hint");
        }
    }
    None
}

const STRUCTURAL: [&str; 8] = ["AXGroup", "AXUnknown", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXScrollArea", "AXSplitter", "AXMatte"];

fn interesting(attrs: &NodeAttrs, label: &Option<String>, value: &Option<String>) -> bool {
    let role = attrs.role.as_deref().unwrap_or("");
    if role.is_empty() {
        return false;
    }
    label.is_some() || value.is_some() || !STRUCTURAL.contains(&role)
}

fn relative(frame: &Option<Rect>, window: &Rect) -> Option<Rect> {
    let frame = frame.as_ref().filter(|f| f.is_finite())?;
    let round = |v: f64| (v * 10.0).round() / 10.0;
    Some(Rect::new(round(frame.x - window.x), round(frame.y - window.y), round(frame.width), round(frame.height)))
}

/// Walks the tree below `root` (pre-order). Everything it cannot be sure it
/// saw sets `complete` to false; callers that need masks then refuse.
pub fn walk_tree<N: AxNode>(root: &N, window: &Rect, deadline: Instant) -> Walk {
    let mut walk = Walk { complete: true, ..Walk::default() };
    let mut stack: Vec<(N, usize)> = Vec::new();
    if !step_inner(root, 0, window, deadline, &mut walk, &mut stack) {
        return walk;
    }
    while let Some((node, depth)) = stack.pop() {
        if !step_inner(&node, depth, window, deadline, &mut walk, &mut stack) {
            break;
        }
    }
    walk
}

fn step_inner<N: AxNode>(node: &N, depth: usize, window: &Rect, deadline: Instant, walk: &mut Walk, stack: &mut Vec<(N, usize)>) -> bool {
    if walk.nodes >= MAX_WALK_NODES || Instant::now() >= deadline {
        walk.complete = false;
        return false;
    }
    walk.nodes += 1;
    let attrs = node.attrs();
    let reason = sensitive_reason(&attrs);
    let role = attrs.role.clone().unwrap_or_default();
    let label = non_empty(&attrs.title, MAX_LABEL)
        .or_else(|| non_empty(&attrs.description, MAX_LABEL))
        .or_else(|| non_empty(&attrs.placeholder, MAX_LABEL))
        .or_else(|| non_empty(&attrs.help, MAX_LABEL));
    if let Some(reason) = reason {
        walk.sensitive_count += 1;
        match attrs.frame.filter(|f| f.is_finite()) {
            Some(rect) => walk.regions.push(MaskRegion { rect, reason }),
            None => walk.unframed_sensitive += 1,
        }
    }
    let value = if reason.is_some() { None } else { non_empty(&node.value(), MAX_VALUE) };
    let web_area = role == "AXWebArea";
    let frame = attrs.frame.filter(|f| f.is_finite());
    let mut web_unreadable = false;
    let children = if depth >= MAX_DEPTH {
        walk.complete = false;
        Vec::new()
    } else {
        match node.children() {
            Ok(children) => {
                web_unreadable = web_area && children.is_empty();
                children
            }
            Err(()) => {
                // An unreadable web area is hidden as a whole; any other failed read could hide a secret.
                if web_area && frame.is_some() {
                    web_unreadable = true;
                } else {
                    walk.complete = false;
                }
                Vec::new()
            }
        }
    };
    if web_unreadable {
        match frame {
            Some(rect) => walk.regions.push(MaskRegion { rect, reason: "web_unreadable" }),
            None => walk.complete = false,
        }
    }
    if interesting(&attrs, &label, &value) {
        if walk.elements.len() < MAX_ELEMENTS {
            walk.elements.push(Element {
                index: format!("e{}", walk.nodes),
                depth,
                role,
                subrole: attrs.subrole.clone().filter(|s| !s.is_empty()),
                label,
                value,
                sensitive: reason.is_some(),
                enabled: attrs.enabled,
                focused: attrs.focused == Some(true),
                rect: relative(&attrs.frame, window),
            });
        } else {
            walk.truncated = true;
        }
    }
    if children.len() > MAX_CHILDREN {
        walk.complete = false;
    }
    for child in children.into_iter().take(MAX_CHILDREN).rev() {
        stack.push((child, depth + 1));
    }
    true
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PxRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Mask regions (window points) → output pixels (top-left origin), padded and
/// clipped to the image; regions outside the window are dropped.
pub fn mask_pixels(regions: &[MaskRegion], window: &Rect, out_width: u32, out_height: u32) -> Vec<PxRect> {
    if window.width <= 0.0 || window.height <= 0.0 || out_width == 0 || out_height == 0 {
        return Vec::new();
    }
    let sx = f64::from(out_width) / window.width;
    let sy = f64::from(out_height) / window.height;
    let (w, h) = (f64::from(out_width), f64::from(out_height));
    regions
        .iter()
        .filter_map(|region| {
            let r = &region.rect;
            let left = ((r.x - MASK_PAD_POINTS - window.x) * sx).max(0.0);
            let top = ((r.y - MASK_PAD_POINTS - window.y) * sy).max(0.0);
            let right = ((r.right() + MASK_PAD_POINTS - window.x) * sx).min(w);
            let bottom = ((r.bottom() + MASK_PAD_POINTS - window.y) * sy).min(h);
            (right > left && bottom > top).then(|| PxRect { x: left, y: top, width: right - left, height: bottom - top })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameMatch {
    /// The application exposes no windows through accessibility at all.
    NoWindows,
    /// It lists windows but none has a readable frame (the tree is not really there: a locked screen, an app that has not built its tree).
    NoFrames,
    /// Windows with frames exist, none is this window's frame.
    None,
    Ambiguous,
}

/// Which accessibility window is the CGWindow `target`: the one whose frame is
/// within tolerance. Several equal frames (stacked windows) are told apart by
/// title when both titles are known; still not exactly one → Ambiguous.
pub fn match_window_frame(target: &Rect, target_title: Option<&str>, candidates: &[(Option<Rect>, Option<String>)]) -> Result<usize, FrameMatch> {
    if candidates.is_empty() {
        return Err(FrameMatch::NoWindows);
    }
    if candidates.iter().all(|candidate| candidate.0.is_none()) {
        return Err(FrameMatch::NoFrames);
    }
    let near: Vec<usize> = (0..candidates.len()).filter(|&i| candidates[i].0.as_ref().is_some_and(|frame| frame.close_to(target, FRAME_TOLERANCE))).collect();
    match near.len() {
        0 => Err(FrameMatch::None),
        1 => Ok(near[0]),
        _ => {
            let Some(title) = target_title.filter(|t| !t.is_empty()) else { return Err(FrameMatch::Ambiguous) };
            let same: Vec<usize> = near.into_iter().filter(|&i| candidates[i].1.as_deref() == Some(title)).collect();
            if same.len() == 1 {
                Ok(same[0])
            } else {
                Err(FrameMatch::Ambiguous)
            }
        }
    }
}

/// Output size for an image of `width`×`height` whose long edge is limited to
/// `max_edge`; never upscales.
pub fn target_size(width: usize, height: usize, max_edge: u32) -> (u32, u32) {
    let long = width.max(height) as f64;
    let factor = if long <= f64::from(max_edge) { 1.0 } else { f64::from(max_edge) / long };
    let scale = |v: usize| ((v as f64 * factor).round() as u32).max(1);
    (scale(width), scale(height))
}

/// Next smaller long edge after a JPEG that was too large.
pub fn shrink_edge(edge: u32) -> Option<u32> {
    let next = edge / 4 * 3;
    (next >= MIN_EDGE).then_some(next)
}

/// A number that changes whenever the window moves, resizes or is another window.
pub fn geometry_revision(window_id: u32, bounds: &Rect) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    let mut feed = |value: i64| {
        for byte in value.to_le_bytes() {
            hash ^= u32::from(byte);
            hash = hash.wrapping_mul(0x0100_0193);
        }
    };
    feed(i64::from(window_id));
    for v in [bounds.x, bounds.y, bounds.width, bounds.height] {
        feed(v.round() as i64);
    }
    hash
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFrame {
    pub window_id: u32,
    pub width: u32,
    pub height: u32,
    /// Output pixels per window point.
    pub scale: f64,
    pub geometry_revision: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaptureImage {
    pub mime: &'static str,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MaskSummary {
    pub count: usize,
    pub reasons: Vec<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub frame: CaptureFrame,
    pub image: CaptureImage,
    pub masked: MaskSummary,
    pub window: WindowRef,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRef {
    pub window_id: u32,
    pub pid: i32,
    pub bounds: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementsResult {
    pub window: WindowRef,
    pub elements: Vec<Element>,
    pub truncated: bool,
    pub complete: bool,
    pub sensitive_omitted: usize,
    pub geometry_revision: u32,
}

pub fn distinct_reasons(regions: &[MaskRegion]) -> Vec<&'static str> {
    let mut reasons: Vec<&'static str> = Vec::new();
    for region in regions {
        if !reasons.contains(&region.reason) {
            reasons.push(region.reason);
        }
    }
    reasons
}

pub fn walk_deadline() -> Instant {
    Instant::now() + std::time::Duration::from_millis(WALK_BUDGET_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Fake {
        attrs: NodeAttrs,
        value: Option<String>,
        value_reads: std::rc::Rc<std::cell::Cell<usize>>,
        kids: Result<Vec<Fake>, ()>,
    }
    impl AxNode for Fake {
        fn attrs(&self) -> NodeAttrs {
            self.attrs.clone()
        }
        fn value(&self) -> Option<String> {
            self.value_reads.set(self.value_reads.get() + 1);
            self.value.clone()
        }
        fn children(&self) -> Result<Vec<Fake>, ()> {
            self.kids.clone()
        }
    }
    fn node(role: &str, kids: Vec<Fake>) -> Fake {
        Fake { attrs: NodeAttrs { role: Some(role.into()), frame: Some(Rect::new(110.0, 120.0, 50.0, 20.0)), ..NodeAttrs::default() }, value: None, value_reads: Default::default(), kids: Ok(kids) }
    }
    fn labeled(mut n: Fake, label: &str) -> Fake {
        n.attrs.title = Some(label.into());
        n
    }
    fn window() -> Rect {
        Rect::new(100.0, 100.0, 800.0, 600.0)
    }
    fn far() -> Instant {
        Instant::now() + std::time::Duration::from_secs(30)
    }

    #[test]
    fn secure_fields_and_secret_labels_are_sensitive() {
        let mut secure = NodeAttrs { role: Some("AXTextField".into()), subrole: Some("AXSecureTextField".into()), ..NodeAttrs::default() };
        assert_eq!(sensitive_reason(&secure), Some("secure_field"));
        secure.subrole = None;
        secure.role = Some("AXSecureTextField".into());
        assert_eq!(sensitive_reason(&secure), Some("secure_field"));
        let entry = |label: &str| NodeAttrs { role: Some("AXTextField".into()), placeholder: Some(label.into()), ..NodeAttrs::default() };
        for label in ["Password", "새 비밀번호", "Enter your PIN", "One-time code", "Card number", "API key", "OTP"] {
            assert_eq!(sensitive_reason(&entry(label)), Some("sensitive_hint"), "{label}");
        }
        for label in ["Shipping address", "Pineapple", "Search", "Name"] {
            assert_eq!(sensitive_reason(&entry(label)), None, "{label}");
        }
        // a button named Password is not an entry
        let button = NodeAttrs { role: Some("AXButton".into()), title: Some("Password".into()), ..NodeAttrs::default() };
        assert_eq!(sensitive_reason(&button), None);
    }

    #[test]
    fn walk_masks_sensitive_and_never_reads_their_value() {
        let mut pw = labeled(node("AXTextField", vec![]), "Password");
        pw.value = Some("hunter2".into());
        let pw_reads = pw.value_reads.clone();
        let mut name = labeled(node("AXTextField", vec![]), "Name");
        name.value = Some("Kim".into());
        let tree = node("AXWindow", vec![node("AXGroup", vec![name, pw, labeled(node("AXButton", vec![]), "Sign in")])]);
        let walk = walk_tree(&tree, &window(), far());
        assert!(walk.complete);
        assert_eq!(walk.sensitive_count, 1);
        assert_eq!(walk.regions.len(), 1);
        assert_eq!(walk.unframed_sensitive, 0);
        let secret = walk.elements.iter().find(|e| e.sensitive).unwrap();
        assert_eq!(secret.value, None);
        assert!(!serde_json::to_string(&walk.elements).unwrap().contains("hunter2"));
        assert_eq!(pw_reads.get(), 0, "a sensitive element's value is never read");
        let name = walk.elements.iter().find(|e| e.label.as_deref() == Some("Name")).unwrap();
        assert_eq!(name.value.as_deref(), Some("Kim"));
        assert_eq!(name.rect, Some(Rect::new(10.0, 20.0, 50.0, 20.0)));
        // the unlabeled structural group is not listed
        assert!(walk.elements.iter().all(|e| e.role != "AXGroup"));
    }

    #[test]
    fn sensitive_without_a_frame_cannot_be_masked() {
        let mut pw = node("AXSecureTextField", vec![]);
        pw.attrs.frame = None;
        let walk = walk_tree(&node("AXWindow", vec![pw]), &window(), far());
        assert_eq!(walk.unframed_sensitive, 1);
        assert!(walk.regions.is_empty());
    }

    #[test]
    fn unreadable_web_area_is_masked_as_a_whole() {
        let empty = node("AXWebArea", vec![]);
        let walk = walk_tree(&node("AXWindow", vec![empty]), &window(), far());
        assert!(walk.complete);
        assert_eq!(distinct_reasons(&walk.regions), vec!["web_unreadable"]);
        let mut failing = node("AXWebArea", vec![]);
        failing.kids = Err(());
        let walk = walk_tree(&node("AXWindow", vec![failing]), &window(), far());
        assert!(walk.complete);
        assert_eq!(walk.regions.len(), 1);
        // any other failed read may hide a secret: incomplete
        let mut bad = node("AXGroup", vec![]);
        bad.kids = Err(());
        let walk = walk_tree(&node("AXWindow", vec![bad]), &window(), far());
        assert!(!walk.complete);
    }

    #[test]
    fn budgets_make_the_walk_incomplete() {
        let mut deep = node("AXButton", vec![]);
        for _ in 0..(MAX_DEPTH + 3) {
            deep = node("AXGroup", vec![deep]);
        }
        assert!(!walk_tree(&deep, &window(), far()).complete);
        let wide = node("AXWindow", (0..(MAX_ELEMENTS + 50)).map(|_| labeled(node("AXButton", vec![]), "B")).collect());
        let walk = walk_tree(&wide, &window(), far());
        assert_eq!(walk.elements.len(), MAX_ELEMENTS);
        assert!(walk.truncated);
        assert!(walk.complete, "an output cap alone does not hide anything from the mask scan");
        let expired = walk_tree(&wide, &window(), Instant::now() - std::time::Duration::from_secs(1));
        assert!(!expired.complete);
        assert!(expired.elements.is_empty());
    }

    #[test]
    fn mask_pixels_scale_pad_and_clip() {
        let region = MaskRegion { rect: Rect::new(110.0, 120.0, 100.0, 20.0), reason: "secure_field" };
        let px = mask_pixels(&[region.clone()], &window(), 400, 300); // 0.5 px per point
        assert_eq!(px.len(), 1);
        assert_eq!(px[0], PxRect { x: 3.5, y: 8.5, width: 53.0, height: 13.0 });
        let edge = MaskRegion { rect: Rect::new(95.0, 95.0, 20.0, 20.0), reason: "secure_field" };
        let clipped = mask_pixels(&[edge], &window(), 800, 600);
        assert_eq!(clipped[0].x, 0.0);
        assert_eq!(clipped[0].y, 0.0);
        let outside = MaskRegion { rect: Rect::new(2000.0, 2000.0, 10.0, 10.0), reason: "secure_field" };
        assert!(mask_pixels(&[outside], &window(), 800, 600).is_empty());
        assert!(mask_pixels(&[region], &Rect::new(0.0, 0.0, 0.0, 0.0), 10, 10).is_empty());
    }

    #[test]
    fn window_frames_match_one_or_refuse() {
        let target = Rect::new(100.0, 100.0, 800.0, 600.0);
        let cands = vec![(Some(Rect::new(0.0, 0.0, 50.0, 50.0)), None), (Some(Rect::new(101.0, 99.5, 800.0, 601.0)), Some("A".into()))];
        assert_eq!(match_window_frame(&target, None, &cands), Ok(1));
        assert_eq!(match_window_frame(&target, None, &cands[..1]), Err(FrameMatch::None));
        // U3: no accessibility windows, or windows without a frame, are told apart from a frame that does not match
        assert_eq!(match_window_frame(&target, None, &[]), Err(FrameMatch::NoWindows));
        assert_eq!(match_window_frame(&target, None, &[(None, Some("A".into())), (None, None)]), Err(FrameMatch::NoFrames));
        assert_eq!(match_window_frame(&target, None, &[(None, None), (Some(target), None)]), Ok(1));
        let twins = vec![(Some(target), Some("A".into())), (Some(target), Some("B".into()))];
        assert_eq!(match_window_frame(&target, None, &twins), Err(FrameMatch::Ambiguous));
        assert_eq!(match_window_frame(&target, Some("B"), &twins), Ok(1));
        assert_eq!(match_window_frame(&target, Some("C"), &twins), Err(FrameMatch::Ambiguous));
        let same_title = vec![(Some(target), Some("A".into())), (Some(target), Some("A".into()))];
        assert_eq!(match_window_frame(&target, Some("A"), &same_title), Err(FrameMatch::Ambiguous));
    }

    #[test]
    fn sizes_shrink_and_never_upscale() {
        assert_eq!(target_size(2560, 1440, 1280), (1280, 720));
        assert_eq!(target_size(800, 600, 1280), (800, 600));
        assert_eq!(target_size(600, 1200, 600), (300, 600));
        assert_eq!(shrink_edge(1280), Some(960));
        assert_eq!(shrink_edge(300), None);
    }

    #[test]
    fn base64_matches_the_standard_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd, 0xfc]), "//79/A==");
    }

    #[test]
    fn geometry_revision_changes_with_the_window() {
        let a = Rect::new(10.0, 10.0, 300.0, 200.0);
        assert_eq!(geometry_revision(5, &a), geometry_revision(5, &a));
        assert_ne!(geometry_revision(5, &a), geometry_revision(6, &a));
        assert_ne!(geometry_revision(5, &a), geometry_revision(5, &Rect::new(10.0, 10.0, 301.0, 200.0)));
    }
}
