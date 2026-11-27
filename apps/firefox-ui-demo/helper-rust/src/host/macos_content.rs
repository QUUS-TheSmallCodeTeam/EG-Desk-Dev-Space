//! macOS side of B1 (window capture + accessibility read). Only reachable when
//! the helper runs with --observe-content (macos.rs MacObserver::content).
//!
//! APIs, all read-only and public:
//! - CGWindowListCopyWindowInfo: find the one window by id and verify its
//!   owner pid (a changed owner or a layer other than 0 is refused);
//! - AXUIElementCreateApplication / AXUIElementCopyAttributeValue /
//!   AXUIElementCopyMultipleAttributeValues / AXValueGetValue: read the window's
//!   accessibility tree. No AXUIElementSetAttributeValue, no AXUIElementPerformAction,
//!   no private `_AXUIElementGetWindow`: the accessibility window is matched to
//!   the CGWindow by frame (and title), and refused when that is not unique;
//! - CGWindowListCreateImage with kCGWindowListOptionIncludingWindow: only that
//!   window's pixels, not what covers it, nominal resolution;
//! - a CGBitmapContext that scales the image, paints black over the sensitive
//!   regions and encodes JPEG through ImageIO (no pixel buffer leaves this
//!   process unmasked).
//! Neither capture nor read asks for a permission: both need
//! AXIsProcessTrusted and (capture) CGPreflightScreenCaptureAccess to be true
//! already, else permission_missing names what is missing. The permissions
//! belong to the process macOS holds responsible for this helper (see
//! Permissions.bundled in protocol.rs).

use std::cell::OnceCell;
use std::ffi::c_void;

use core_foundation::array::CFArray;
use core_foundation::base::{CFGetTypeID, CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::base::{kCGBitmapByteOrder32Little, kCGImageAlphaNoneSkipFirst};
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::{CGContext, CGInterpolationQuality};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImage;
use core_graphics::window::{
    copy_window_info, create_image, kCGNullWindowID, kCGWindowImageBoundsIgnoreFraming, kCGWindowImageNominalResolution,
    kCGWindowLayer, kCGWindowListExcludeDesktopElements, kCGWindowListOptionIncludingWindow, kCGWindowListOptionOnScreenOnly,
    kCGWindowName, kCGWindowNumber, kCGWindowOwnerPID,
};
use foreign_types::ForeignType;

use super::macos::{bounds, flag, number, screen_recording_preflight, text, RawDict};
use super::observe::{
    base64_encode, distinct_reasons, geometry_revision, mask_pixels, match_window_frame, shrink_edge, target_size, walk_deadline,
    walk_tree, AxNode, CaptureFrame, CaptureImage, CaptureQuery, CaptureResult, ElementsQuery, ElementsResult, FrameMatch,
    MaskSummary, NodeAttrs, ObserveError, PxRect, Rect, WindowRef, MAX_CHILDREN, MAX_JPEG_BYTES,
};

type AxRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AxRef;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementCopyAttributeValue(element: AxRef, attribute: CFStringRef, value: *mut *const c_void) -> i32;
    fn AXUIElementCopyMultipleAttributeValues(element: AxRef, attributes: *const c_void, options: u32, values: *mut *const c_void) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AxRef, timeout_seconds: f32) -> i32;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetType(value: *const c_void) -> u32;
    fn AXValueGetValue(value: *const c_void, kind: u32, out: *mut c_void) -> u8;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> *const c_void;
}

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    static kCGImageDestinationLossyCompressionQuality: CFStringRef;
    fn CGImageDestinationCreateWithData(data: *mut c_void, uti: CFStringRef, count: usize, options: *const c_void) -> *mut c_void;
    fn CGImageDestinationAddImage(destination: *mut c_void, image: *const c_void, properties: *const c_void);
    fn CGImageDestinationFinalize(destination: *mut c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataCreateMutable(allocator: *const c_void, capacity: isize) -> *mut c_void;
    fn CFDataGetLength(data: *const c_void) -> isize;
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
    fn CFRelease(object: *const c_void);
}

const AX_VALUE_CGPOINT: u32 = 1;
const AX_VALUE_CGSIZE: u32 = 2;
const AX_VALUE_ERROR: u32 = 5;
const AX_MESSAGING_TIMEOUT_SECONDS: f32 = 0.5;
const JPEG_QUALITY: f64 = 0.7;
/// Attribute order of the one batched read per element.
const BATCH: [&str; 13] = [
    "AXRole", "AXSubrole", "AXRoleDescription", "AXTitle", "AXDescription", "AXPlaceholderValue", "AXIdentifier", "AXHelp",
    "AXEnabled", "AXFocused", "AXPosition", "AXSize", "AXChildren",
];
const B_CHILDREN: usize = 12;

/// kAXErrorAttributeUnsupported, kAXErrorNoValue, kAXErrorNotImplemented: the
/// element simply has no such attribute.
fn is_missing(code: i32) -> bool {
    matches!(code, -25205 | -25212 | -25208)
}

/// Whether the login session's screen is locked, or the session is not on the console (fast user switching). In either state accessibility
/// answers with placeholders (every window of an app reads as an application element without a frame) and CGWindowListCreateImage
/// cannot see the windows, so a read would only produce a misleading "no such window". Unknown (no session dictionary) counts as usable.
pub(super) fn session_blocked() -> bool {
    // SAFETY: Copy rule: we own the returned dictionary (or null); keys are CFStrings and values are checked CFBooleans (flag()).
    unsafe {
        let raw = CGSessionCopyCurrentDictionary();
        if raw.is_null() {
            return false;
        }
        let dict = RawDict::wrap_under_create_rule(raw as _);
        let locked_key = CFString::new("CGSSessionScreenIsLocked");
        let console_key = CFString::new("kCGSSessionOnConsoleKey");
        let on_console_present = dict.find(console_key.as_concrete_TypeRef() as *const c_void).is_some();
        flag(&dict, locked_key.as_concrete_TypeRef()) || (on_console_present && !flag(&dict, console_key.as_concrete_TypeRef()))
    }
}

fn require_session() -> Result<(), ObserveError> {
    if session_blocked() {
        return Err(ObserveError::new("screen_locked", "The Mac's screen is locked (or this user session is not on the console), so no window can be read"));
    }
    Ok(())
}

fn ax_failed(code: i32) -> ObserveError {
    ObserveError::new("ax_failed", format!("Reading the accessibility tree failed (AXError {code})"))
}

struct AxEl {
    el: CFType,
    batch: OnceCell<Result<Vec<Option<CFType>>, i32>>,
}

fn is_ax_error_value(value: &CFType) -> bool {
    let ptr = value.as_CFTypeRef();
    // SAFETY: type id checked before AXValueGetType is called on it.
    unsafe { CFGetTypeID(ptr) == AXValueGetTypeID() && AXValueGetType(ptr) == AX_VALUE_ERROR }
}

fn ax_struct<T: Default>(value: &CFType, kind: u32) -> Option<T> {
    let ptr = value.as_CFTypeRef();
    let mut out = T::default();
    // SAFETY: the type id and AXValue type are checked, and `out` is a plain
    // struct of the size AXValueGetValue writes for `kind`.
    unsafe {
        if CFGetTypeID(ptr) != AXValueGetTypeID() || AXValueGetType(ptr) != kind {
            return None;
        }
        (AXValueGetValue(ptr, kind, &mut out as *mut T as *mut c_void) != 0).then_some(out)
    }
}

#[derive(Default)]
struct Pt {
    x: f64,
    y: f64,
}
#[derive(Default)]
struct Sz {
    width: f64,
    height: f64,
}

fn elements_of(value: &CFType) -> Vec<AxEl> {
    let ptr = value.as_CFTypeRef();
    // SAFETY: the array's type id is checked; every item is type-checked as an
    // AXUIElement before it is retained.
    unsafe {
        if CFGetTypeID(ptr) != CFArray::<*const c_void>::type_id() {
            return Vec::new();
        }
        let array: CFArray<*const c_void> = CFArray::wrap_under_get_rule(ptr as _);
        array
            .iter()
            .take(MAX_CHILDREN + 1)
            .filter_map(|item| {
                let item: *const c_void = *item;
                (!item.is_null() && CFGetTypeID(item) == AXUIElementGetTypeID()).then(|| AxEl::new(CFType::wrap_under_get_rule(item)))
            })
            .collect()
    }
}

impl AxEl {
    fn new(el: CFType) -> AxEl {
        AxEl { el, batch: OnceCell::new() }
    }

    fn attr(&self, name: &str) -> Result<Option<CFType>, i32> {
        let key = CFString::new(name);
        let mut out: *const c_void = std::ptr::null();
        // SAFETY: a live AXUIElement, a live CFString and a valid out pointer.
        let code = unsafe { AXUIElementCopyAttributeValue(self.el.as_CFTypeRef(), key.as_concrete_TypeRef(), &mut out) };
        match code {
            0 if out.is_null() => Ok(None),
            // SAFETY: Copy rule: we own the returned object.
            0 => Ok(Some(unsafe { CFType::wrap_under_create_rule(out) })),
            c if is_missing(c) => Ok(None),
            c => Err(c),
        }
    }

    /// One IPC for all of BATCH.
    fn batch(&self) -> &Result<Vec<Option<CFType>>, i32> {
        self.batch.get_or_init(|| {
            let keys: Vec<CFString> = BATCH.iter().map(|name| CFString::new(name)).collect();
            let list = CFArray::from_CFTypes(&keys);
            let mut out: *const c_void = std::ptr::null();
            // SAFETY: a live element, a CFArray of CFStrings, options 0 (errors stay in place as AXError values), a valid out pointer.
            let code = unsafe { AXUIElementCopyMultipleAttributeValues(self.el.as_CFTypeRef(), list.as_concrete_TypeRef() as _, 0, &mut out) };
            if code != 0 || out.is_null() {
                return Err(if code == 0 { -25200 } else { code });
            }
            // SAFETY: Copy rule: we own the array; its items are CF objects.
            let array: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(out as _) };
            let mut values = Vec::with_capacity(BATCH.len());
            for item in array.iter() {
                let item: *const c_void = *item;
                // SAFETY: items live as long as the array; get rule retains them.
                let value = (!item.is_null()).then(|| unsafe { CFType::wrap_under_get_rule(item) });
                values.push(value.filter(|v| !is_ax_error_value(v)));
            }
            Ok(values)
        })
    }

    fn batched(&self, index: usize) -> Option<&CFType> {
        self.batch().as_ref().ok()?.get(index)?.as_ref()
    }

    fn batched_string(&self, index: usize) -> Option<String> {
        self.batched(index)?.downcast::<CFString>().map(|s| s.to_string())
    }

    fn frame(&self) -> Option<Rect> {
        let position = ax_struct::<Pt>(self.batched(10)?, AX_VALUE_CGPOINT)?;
        let size = ax_struct::<Sz>(self.batched(11)?, AX_VALUE_CGSIZE)?;
        let rect = Rect::new(position.x, position.y, size.width, size.height);
        rect.is_finite().then_some(rect)
    }
}

impl AxNode for AxEl {
    fn attrs(&self) -> NodeAttrs {
        NodeAttrs {
            role: self.batched_string(0),
            subrole: self.batched_string(1),
            role_description: self.batched_string(2),
            title: self.batched_string(3),
            description: self.batched_string(4),
            placeholder: self.batched_string(5),
            identifier: self.batched_string(6),
            help: self.batched_string(7),
            enabled: self.batched(8).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from),
            focused: self.batched(9).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from),
            frame: self.frame(),
        }
    }

    fn value(&self) -> Option<String> {
        let value = self.attr("AXValue").ok()??;
        if let Some(string) = value.downcast::<CFString>() {
            return Some(string.to_string());
        }
        if let Some(number) = value.downcast::<CFNumber>() {
            return number.to_f64().map(|n| if n.fract() == 0.0 && n.abs() < 1e15 { format!("{}", n as i64) } else { format!("{n}") });
        }
        value.downcast::<CFBoolean>().map(|b| bool::from(b).to_string())
    }

    fn children(&self) -> Result<Vec<AxEl>, ()> {
        match self.batch() {
            Err(_) => Err(()),
            Ok(_) => Ok(self.batched(B_CHILDREN).map(elements_of).unwrap_or_default()),
        }
    }
}

struct Located {
    bounds: Rect,
    title: Option<String>,
}

fn locate(window_id: u32, pid: i32) -> Result<Located, ObserveError> {
    let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let array = copy_window_info(options, kCGNullWindowID).ok_or_else(|| ObserveError::new("capture_failed", "The window list could not be read"))?;
    for item in array.iter() {
        let item: *const c_void = *item;
        // SAFETY: array elements are live CF objects for the array's life.
        if item.is_null() || unsafe { CFGetTypeID(item) } != RawDict::type_id() {
            continue;
        }
        // SAFETY: type checked above.
        let dict = unsafe { RawDict::wrap_under_get_rule(item as _) };
        // SAFETY (statics): immutable framework constants.
        let id = number(&dict, unsafe { kCGWindowNumber }).and_then(|v| v.to_i64()).and_then(|v| u32::try_from(v).ok());
        if id != Some(window_id) {
            continue;
        }
        let owner = number(&dict, unsafe { kCGWindowOwnerPID }).and_then(|v| v.to_i64()).unwrap_or(0);
        if owner != i64::from(pid) {
            return Err(ObserveError::new("window_changed", "That window now belongs to a different process"));
        }
        let layer = number(&dict, unsafe { kCGWindowLayer }).and_then(|v| v.to_i64()).unwrap_or(0);
        if layer != 0 {
            return Err(ObserveError::new("window_not_found", "That is not an ordinary application window"));
        }
        let b = bounds(&dict);
        let rect = Rect::new(b.x, b.y, b.width, b.height);
        if !rect.is_finite() || rect.width < 1.0 || rect.height < 1.0 {
            return Err(ObserveError::new("window_not_found", "That window has no size"));
        }
        let title = if screen_recording_preflight() { text(&dict, unsafe { kCGWindowName }) } else { None };
        return Ok(Located { bounds: rect, title });
    }
    Err(ObserveError::new("window_not_found", "No on-screen window with that id"))
}

fn require(accessibility: bool, screen: bool) -> Result<(), ObserveError> {
    // SAFETY: argument-less TCC preflight reads; neither prompts.
    let (ax, sr) = unsafe { (AXIsProcessTrusted() != 0, screen_recording_preflight()) };
    let mut missing = Vec::new();
    if accessibility && !ax {
        missing.push("accessibility");
    }
    if screen && !sr {
        missing.push("screenRecording");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(ObserveError::new("permission_missing", format!("macOS has not granted this process: {}", missing.join(", "))))
    }
}

fn ax_window(pid: i32, target: &Located) -> Result<AxEl, ObserveError> {
    // SAFETY: plain call; null means the pid cannot be addressed.
    let raw = unsafe { AXUIElementCreateApplication(pid) };
    if raw.is_null() {
        return Err(ObserveError::new("ax_failed", "That application cannot be read through accessibility"));
    }
    // SAFETY: Create rule: we own the application element.
    let app = AxEl::new(unsafe { CFType::wrap_under_create_rule(raw) });
    // SAFETY: live element; bounds how long one unresponsive application can hold the helper.
    unsafe { AXUIElementSetMessagingTimeout(app.el.as_CFTypeRef(), AX_MESSAGING_TIMEOUT_SECONDS) };
    let windows = match app.attr("AXWindows") {
        Ok(Some(value)) => elements_of(&value),
        Ok(None) => Vec::new(),
        Err(code) => return Err(ax_failed(code)),
    };
    let candidates: Vec<(Option<Rect>, Option<String>)> = windows
        .iter()
        .map(|window| {
            let attrs = window.attrs();
            (attrs.frame, attrs.title)
        })
        .collect();
    match match_window_frame(&target.bounds, target.title.as_deref(), &candidates) {
        Ok(index) => Ok(windows.into_iter().nth(index).expect("index from the same list")),
        Err(FrameMatch::NoWindows) => Err(ObserveError::new("ax_unavailable", "The app lists no windows through accessibility")),
        Err(FrameMatch::NoFrames) => Err(ObserveError::new("ax_unavailable", "The app lists windows through accessibility but none has a position or size (locked screen, or the app has not built its accessibility tree)")),
        Err(FrameMatch::None) => Err(ObserveError::new("window_mismatch", "No accessibility window has this window's frame")),
        Err(FrameMatch::Ambiguous) => Err(ObserveError::new("ambiguous_window", "More than one window has that frame; it cannot be told apart safely")),
    }
}

fn jpeg_bytes(image: &CGImage) -> Result<Vec<u8>, ObserveError> {
    let failed = || ObserveError::new("encode_failed", "The image could not be encoded");
    let uti = CFString::new("public.jpeg");
    let quality = CFDictionary::from_CFType_pairs(&[(
        // SAFETY: immutable framework constant.
        unsafe { CFString::wrap_under_get_rule(kCGImageDestinationLossyCompressionQuality) },
        CFNumber::from(JPEG_QUALITY),
    )]);
    // SAFETY: the destination writes into `data`; both are released below, in
    // every path, after the bytes are copied out.
    unsafe {
        let data = CFDataCreateMutable(std::ptr::null(), 0);
        if data.is_null() {
            return Err(failed());
        }
        let destination = CGImageDestinationCreateWithData(data, uti.as_concrete_TypeRef(), 1, std::ptr::null());
        if destination.is_null() {
            CFRelease(data);
            return Err(failed());
        }
        CGImageDestinationAddImage(destination, image.as_ptr() as *const c_void, quality.as_concrete_TypeRef() as *const c_void);
        let done = CGImageDestinationFinalize(destination);
        let bytes = if done {
            let length = usize::try_from(CFDataGetLength(data)).unwrap_or(0);
            let pointer = CFDataGetBytePtr(data);
            (length > 0 && !pointer.is_null()).then(|| std::slice::from_raw_parts(pointer, length).to_vec())
        } else {
            None
        };
        CFRelease(destination);
        CFRelease(data);
        bytes.ok_or_else(failed)
    }
}

/// Scales `image` to width×height, paints black over `masks` (output pixels,
/// top-left origin) and encodes JPEG. The mask is drawn after the image, so
/// the encoded bytes never contain the masked pixels.
fn render_jpeg(image: &CGImage, width: u32, height: u32, masks: &[PxRect]) -> Result<Vec<u8>, ObserveError> {
    let space = CGColorSpace::create_device_rgb();
    let context = CGContext::create_bitmap_context(
        None,
        width as usize,
        height as usize,
        8,
        width as usize * 4,
        &space,
        kCGImageAlphaNoneSkipFirst | kCGBitmapByteOrder32Little,
    );
    context.set_interpolation_quality(CGInterpolationQuality::CGInterpolationQualityHigh);
    let full = CGRect::new(&CGPoint::new(0.0, 0.0), &CGSize::new(f64::from(width), f64::from(height)));
    context.draw_image(full, image);
    context.set_rgb_fill_color(0.0, 0.0, 0.0, 1.0);
    for mask in masks {
        // CGContext's origin is the bottom-left corner.
        let flipped_y = f64::from(height) - (mask.y + mask.height);
        context.fill_rect(CGRect::new(&CGPoint::new(mask.x, flipped_y), &CGSize::new(mask.width, mask.height)));
    }
    let masked = context.create_image().ok_or_else(|| ObserveError::new("encode_failed", "The image could not be drawn"))?;
    jpeg_bytes(&masked)
}

fn window_ref(window_id: u32, pid: i32, bounds: Rect) -> WindowRef {
    WindowRef { window_id, pid, bounds }
}

pub fn read_elements(query: &ElementsQuery) -> Result<ElementsResult, ObserveError> {
    require(true, false)?;
    require_session()?;
    let located = locate(query.window_id, query.pid)?;
    let root = ax_window(query.pid, &located)?;
    let walk = walk_tree(&root, &located.bounds, walk_deadline());
    Ok(ElementsResult {
        window: window_ref(query.window_id, query.pid, located.bounds),
        truncated: walk.truncated,
        complete: walk.complete,
        sensitive_omitted: walk.sensitive_count,
        geometry_revision: geometry_revision(query.window_id, &located.bounds),
        elements: walk.elements,
    })
}

pub fn capture(query: &CaptureQuery) -> Result<CaptureResult, ObserveError> {
    // Masking needs the accessibility tree, so capture needs both permissions and refuses without either.
    require(true, true)?;
    require_session()?;
    let located = locate(query.window_id, query.pid)?;
    let root = ax_window(query.pid, &located)?;
    let walk = walk_tree(&root, &located.bounds, walk_deadline());
    if !walk.complete || walk.unframed_sensitive > 0 {
        return Err(ObserveError::new(
            "mask_unavailable",
            "Sensitive fields in this window could not be checked completely, so no image was made",
        ));
    }
    let null_rect = CGRect::new(&CGPoint::new(f64::INFINITY, f64::INFINITY), &CGSize::new(0.0, 0.0));
    let image = create_image(
        null_rect,
        kCGWindowListOptionIncludingWindow,
        query.window_id,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution,
    )
    .ok_or_else(|| ObserveError::new("capture_failed", "The window image could not be made"))?;
    // The masks were placed from the frame read before the image: if the window moved meanwhile they may be off.
    let after = locate(query.window_id, query.pid)?;
    if !after.bounds.close_to(&located.bounds, 1.0) {
        return Err(ObserveError::new("window_changed", "The window moved or resized during the capture"));
    }
    let (image_width, image_height) = (image.width(), image.height());
    if image_width == 0 || image_height == 0 {
        return Err(ObserveError::new("capture_failed", "The window image is empty"));
    }
    let mut edge = query.max_edge;
    loop {
        let (width, height) = target_size(image_width, image_height, edge);
        let masks = mask_pixels(&walk.regions, &located.bounds, width, height);
        let jpeg = render_jpeg(&image, width, height, &masks)?;
        if jpeg.len() <= MAX_JPEG_BYTES {
            return Ok(CaptureResult {
                frame: CaptureFrame {
                    window_id: query.window_id,
                    width,
                    height,
                    scale: f64::from(width) / located.bounds.width,
                    geometry_revision: geometry_revision(query.window_id, &located.bounds),
                },
                image: CaptureImage { mime: "image/jpeg", data: base64_encode(&jpeg) },
                masked: MaskSummary { count: masks.len(), reasons: distinct_reasons(&walk.regions) },
                window: window_ref(query.window_id, query.pid, located.bounds),
            });
        }
        edge = shrink_edge(edge).ok_or_else(|| ObserveError::new("encode_failed", "The image is too large even at the smallest size"))?;
    }
}
