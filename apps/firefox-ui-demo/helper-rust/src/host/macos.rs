//! macOS observation for host-observe. Read-only AppKit / CoreGraphics calls;
//! nothing here posts input, captures pixels, writes accessibility attributes
//! or asks for a permission.
//!
//! Portions adapted from trycua/cua libs/cua-driver/rust (MIT License,
//! Copyright (c) 2025 Cua AI, Inc.), crates/platform-macos/src/:
//! - apps/mod.rs enumerate_running_apps / frontmost_pid: one walk over
//!   NSWorkspace.runningApplications, skip terminated and pid <= 0, keep the
//!   activation policy. Its note that this array is a cache AppKit refreshes
//!   on the main run loop is why run() keeps the main run loop turning.
//! - windows.rs enumerate_windows / get_bounds_num: CGWindowListCopyWindowInfo
//!   dictionary parsing with CFGetTypeID checks; non-finite bounds become 0.
//! - focus_steal.rs install_observer / handle_activation: the
//!   didActivateApplication observer on a private serial NSOperationQueue,
//!   reading userInfo[NSWorkspaceApplicationKey].
//! - permissions/status.rs: preflight-only probes; CGWindowList returning
//!   windows is not evidence of the Screen Recording grant (only titles are
//!   gated), so titles are read only when the preflight says yes.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::time::Duration;

use block2::RcBlock;
use core_foundation::base::{CFGetTypeID, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopRunResult};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowNumber,
    kCGWindowOwnerName, kCGWindowOwnerPID,
};
use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2_app_kit::{
    NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace, NSWorkspaceApplicationKey,
    NSWorkspaceDidActivateApplicationNotification, NSWorkspaceDidLaunchApplicationNotification,
    NSWorkspaceDidTerminateApplicationNotification,
};
use objc2_foundation::{NSNotification, NSOperationQueue, NSString};

use super::protocol::{
    bounded_text, AppInfo, AppRef, CaptureQuery, CaptureResult, ElementsQuery, ElementsResult, HostEvent, ObserveError, Observer, Permissions, ServiceStatus, WindowBounds, WindowInfo,
    WindowList, WindowQuery, MAX_APPS, MAX_WINDOWS, SERVICE_BUNDLE_ID,
};
use super::{mono_ms, HostObserveArgs, ServiceTracker};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // Boolean (unsigned char). No prompt: only AXIsProcessTrustedWithOptions
    // with kAXTrustedCheckOptionPrompt asks, and it is not called here.
    fn AXIsProcessTrusted() -> u8;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // C99 bool. Preflight only; the Request variants are never called.
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGPreflightListenEventAccess() -> bool;
}

pub(super) fn screen_recording_preflight() -> bool {
    // SAFETY: no arguments, no side effects beyond reading TCC state.
    unsafe { CGPreflightScreenCaptureAccess() }
}

pub struct MacObserver {
    bundled: bool,
    content: bool,
}

impl MacObserver {
    pub fn new(content: bool) -> Self {
        let bundled = std::env::current_exe()
            .map(|path| path.to_string_lossy().contains(".app/Contents/MacOS/"))
            .unwrap_or(false);
        MacObserver { bundled, content }
    }
}

fn app_ref(app: &NSRunningApplication) -> AppRef {
    // SAFETY: NSRunningApplication properties are documented thread-safe
    // (returned atomically); `app` is a live object for this call.
    unsafe {
        AppRef {
            bundle_id: app.bundleIdentifier().map(|value| bounded_text(&value.to_string())),
            pid: app.processIdentifier(),
            name: app.localizedName().map(|value| bounded_text(&value.to_string())),
        }
    }
}

fn service_status() -> ServiceStatus {
    autoreleasepool(|_| {
        let bundle_id = NSString::from_str(SERVICE_BUNDLE_ID);
        // SAFETY: class method with a valid NSString argument; each element
        // is a live NSRunningApplication retained by the array.
        unsafe {
            let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_id);
            let mut pids = Vec::new();
            for index in 0..running.count() {
                let app = running.objectAtIndex(index);
                if !app.isTerminated() && app.processIdentifier() > 0 {
                    pids.push(app.processIdentifier());
                }
            }
            ServiceStatus::new(pids)
        }
    })
}

pub(super) type RawDict = CFDictionary<*const c_void, *const c_void>;

pub(super) fn raw_value(dict: &RawDict, key: CFStringRef) -> Option<*const c_void> {
    dict.find(key as *const c_void).map(|value| *value).filter(|value| !value.is_null())
}

pub(super) fn number(dict: &RawDict, key: CFStringRef) -> Option<CFNumber> {
    let value = raw_value(dict, key)?;
    // SAFETY: value is a live CF object owned by the dictionary; the type id
    // check makes the wrap correct.
    unsafe { (CFGetTypeID(value) == CFNumber::type_id()).then(|| CFNumber::wrap_under_get_rule(value as _)) }
}

pub(super) fn text(dict: &RawDict, key: CFStringRef) -> Option<String> {
    let value = raw_value(dict, key)?;
    // SAFETY: as in number().
    unsafe {
        (CFGetTypeID(value) == CFString::type_id())
            .then(|| bounded_text(&CFString::wrap_under_get_rule(value as _).to_string()))
    }
}

pub(super) fn flag(dict: &RawDict, key: CFStringRef) -> bool {
    raw_value(dict, key)
        // SAFETY: as in number().
        .map(|value| unsafe {
            CFGetTypeID(value) == CFBoolean::type_id() && bool::from(CFBoolean::wrap_under_get_rule(value as _))
        })
        .unwrap_or(false)
}

pub(super) fn bounds(dict: &RawDict) -> WindowBounds {
    // SAFETY: kCGWindowBounds is an immutable framework constant.
    let inner = raw_value(dict, unsafe { kCGWindowBounds }).and_then(|value| unsafe {
        (CFGetTypeID(value) == RawDict::type_id()).then(|| RawDict::wrap_under_get_rule(value as _))
    });
    let coordinate = |name: &'static str| -> f64 {
        let Some(inner) = inner.as_ref() else { return 0.0 };
        let key = CFString::from_static_string(name);
        number(inner, key.as_concrete_TypeRef())
            .and_then(|value| value.to_f64())
            .filter(|value| value.is_finite())
            .unwrap_or(0.0)
    };
    WindowBounds { x: coordinate("X"), y: coordinate("Y"), width: coordinate("Width"), height: coordinate("Height") }
}

impl Observer for MacObserver {
    fn apps(&self) -> Vec<AppInfo> {
        autoreleasepool(|_| {
            let mut apps = Vec::new();
            // SAFETY: sharedWorkspace/runningApplications are thread-safe
            // reads; every element is retained by the returned array.
            unsafe {
                let running = NSWorkspace::sharedWorkspace().runningApplications();
                for index in 0..running.count() {
                    if apps.len() >= MAX_APPS {
                        break;
                    }
                    let app = running.objectAtIndex(index);
                    if app.isTerminated() || app.processIdentifier() <= 0 {
                        continue;
                    }
                    let policy = match app.activationPolicy() {
                        NSApplicationActivationPolicy::Regular => "regular",
                        NSApplicationActivationPolicy::Accessory => "accessory",
                        _ => continue,
                    };
                    let reference = app_ref(&app);
                    apps.push(AppInfo {
                        bundle_id: reference.bundle_id,
                        pid: reference.pid,
                        name: reference.name,
                        active: app.isActive(),
                        policy,
                    });
                }
            }
            apps
        })
    }

    fn frontmost(&self) -> Option<AppRef> {
        // SAFETY: thread-safe read of the shared workspace.
        autoreleasepool(|_| unsafe { NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app_ref(&app)) })
    }

    fn windows(&self, query: WindowQuery) -> WindowList {
        let permitted = screen_recording_preflight();
        let read_titles = query.titles && permitted;
        let titles = match (query.titles, permitted) {
            (false, _) => "not-requested",
            (true, false) => "omitted-no-permission",
            (true, true) => "included",
        };
        let options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        let Some(array) = copy_window_info(options, kCGNullWindowID) else {
            return WindowList { windows: Vec::new(), titles, truncated: false };
        };
        let mut windows = Vec::new();
        let mut truncated = false;
        for item in array.iter() {
            let item: *const c_void = *item;
            // SAFETY: array elements are live CF objects for the array's life.
            if item.is_null() || unsafe { CFGetTypeID(item) } != RawDict::type_id() {
                continue;
            }
            // SAFETY: type checked above; get rule keeps the array's ownership.
            let dict = unsafe { RawDict::wrap_under_get_rule(item as _) };
            // SAFETY (all statics below): immutable framework constants.
            let layer = number(&dict, unsafe { kCGWindowLayer }).and_then(|value| value.to_i64()).unwrap_or(0) as i32;
            if layer != 0 && !query.all_layers {
                continue;
            }
            if windows.len() >= MAX_WINDOWS {
                truncated = true;
                break;
            }
            let Some(window_id) = number(&dict, unsafe { kCGWindowNumber })
                .and_then(|value| value.to_i64())
                .and_then(|value| u32::try_from(value).ok())
            else {
                continue;
            };
            let pid = number(&dict, unsafe { kCGWindowOwnerPID }).and_then(|value| value.to_i64()).unwrap_or(0) as i32;
            windows.push(WindowInfo {
                window_id,
                pid,
                owner_name: text(&dict, unsafe { kCGWindowOwnerName }),
                layer,
                on_screen: flag(&dict, unsafe { kCGWindowIsOnscreen }),
                bounds: bounds(&dict),
                title: if read_titles { text(&dict, unsafe { kCGWindowName }) } else { None },
            });
        }
        WindowList { windows, titles, truncated }
    }

    fn permissions(&self) -> Permissions {
        // SAFETY: argument-less TCC preflight reads; none of them prompts.
        unsafe {
            Permissions {
                accessibility: AXIsProcessTrusted() != 0,
                screen_recording: CGPreflightScreenCaptureAccess(),
                input_monitoring: CGPreflightListenEventAccess(),
                requested: false,
                screen_locked: super::macos_content::session_blocked(),
                bundled: self.bundled,
            }
        }
    }

    fn service(&self) -> ServiceStatus {
        service_status()
    }

    fn content_enabled(&self) -> bool {
        self.content
    }

    fn capture(&self, query: &CaptureQuery) -> Result<CaptureResult, ObserveError> {
        if !self.content {
            return Err(ObserveError::observe_only());
        }
        autoreleasepool(|_| super::macos_content::capture(query))
    }

    fn read_elements(&self, query: &ElementsQuery) -> Result<ElementsResult, ObserveError> {
        if !self.content {
            return Err(ObserveError::observe_only());
        }
        autoreleasepool(|_| super::macos_content::read_elements(query))
    }
}

/// userInfo[NSWorkspaceApplicationKey] of a workspace notification.
///
/// SAFETY: `note` must be a workspace application notification delivered by
/// AppKit, whose NSWorkspaceApplicationKey value is an NSRunningApplication.
unsafe fn notification_app(note: &NSNotification) -> Option<AppRef> {
    let info = note.userInfo()?;
    let pointer: *mut AnyObject = msg_send![&*info, objectForKey: NSWorkspaceApplicationKey];
    if pointer.is_null() {
        return None;
    }
    Some(app_ref(&*(pointer as *const NSRunningApplication)))
}

type EventSender = SyncSender<(u64, HostEvent)>;

fn report_service_change(tracker: &ServiceTracker, events: &EventSender) {
    if let Some(change) = tracker.observe(service_status()) {
        let _ = events.try_send((mono_ms(), HostEvent::ServiceChanged(change)));
    }
}

/// Activation, launch and terminate observers on a private serial queue, so
/// delivery does not depend on which thread posts (cua focus_steal.rs). They
/// live for the whole process, so the tokens and queue are intentionally kept.
fn install_workspace_observers(events: EventSender, tracker: Arc<ServiceTracker>) {
    autoreleasepool(|_| {
        // SAFETY: shared workspace, its notification center and a fresh queue
        // are valid for the process; the blocks are 'static and only send on
        // a SyncSender (Send + Sync); `note` is valid for the block call.
        unsafe {
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            let queue = NSOperationQueue::new();
            queue.setMaxConcurrentOperationCount(1);

            let activation_events = events.clone();
            let activation = RcBlock::new(move |note: NonNull<NSNotification>| {
                if let Some(app) = notification_app(note.as_ref()) {
                    let _ = activation_events.try_send((mono_ms(), HostEvent::AppActivated(app)));
                }
            });
            std::mem::forget(center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                Some(&queue),
                &activation,
            ));

            let lifecycle = RcBlock::new(move |note: NonNull<NSNotification>| {
                let is_service = notification_app(note.as_ref())
                    .and_then(|app| app.bundle_id)
                    .is_some_and(|bundle_id| bundle_id == SERVICE_BUNDLE_ID);
                if is_service {
                    report_service_change(&tracker, &events);
                }
            });
            for name in [NSWorkspaceDidLaunchApplicationNotification, NSWorkspaceDidTerminateApplicationNotification] {
                std::mem::forget(center.addObserverForName_object_queue_usingBlock(Some(name), None, Some(&queue), &lifecycle));
            }
            std::mem::forget(queue);
        }
    });
}

pub fn run(args: HostObserveArgs) -> i32 {
    let observer = Arc::new(MacObserver::new(args.observe_content));
    let (events, receiver) = sync_channel::<(u64, HostEvent)>(256);
    if let Err(code) = super::launch(&args, observer, receiver) {
        return code;
    }

    let tracker = Arc::new(ServiceTracker::new());
    tracker.observe(service_status());
    install_workspace_observers(events.clone(), Arc::clone(&tracker));
    let interval = Duration::from_millis(args.service_poll_ms);
    std::thread::spawn(move || loop {
        std::thread::sleep(interval);
        report_service_change(&tracker, &events);
    });

    // The main run loop keeps AppKit's running-application cache and the
    // workspace notifications current. It may have no sources yet, in which
    // case RunInMode returns at once; sleep briefly instead of spinning.
    loop {
        // SAFETY: kCFRunLoopDefaultMode is an immutable framework constant.
        let result = CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_secs(1), false);
        if result == CFRunLoopRunResult::Finished {
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}
