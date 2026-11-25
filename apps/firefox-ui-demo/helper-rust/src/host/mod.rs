//! `egdesk-helper host-observe`: the observation-only first stage of
//! EG-Desk's own Mac host helper (owner decision D-C1 2026-10-24: Rust,
//! merged with the RT-04 helper; D-C4: observe first, no OS input).
//!
//! What it reports (docs/references/rea-mechanism-adoption.md 4장 맥1·맥8·맥10):
//! front-app activations (NSWorkspace notification), running apps
//! (bundleId·pid·name), on-screen windows (number·bounds·owner pid; titles only
//! when asked and Screen Recording preflight is true), permission preview
//! (AXIsProcessTrusted, CGPreflightScreenCaptureAccess,
//! CGPreflightListenEventAccess — never a request) and whether
//! com.openai.sky.CUAService is running.
//!
//! What it never does in this stage: post input, capture pixels, write
//! accessibility attributes, open System Settings or ask for a permission.
//!
//! Process contract (parent = helper/egdesk-host-agent.mjs):
//! 1. The parent makes a 0700 directory, picks <dir>/<name>.sock and spawns
//!    `egdesk-helper host-observe --socket <path>` without a shell, stdio piped.
//! 2. The parent writes {"v":1,"nonce":"<hex>"} + "\n" to stdin and keeps
//!    stdin open; stdin EOF means the parent is gone and the helper exits.
//! 3. The helper binds the socket (0600) and prints one ready line on stdout:
//!    {"v":1,"type":"ready","pid":N,"socket":"<path>"}.
//! 4. The parent connects and sends hello with the nonce (host/protocol.rs).
//!    After that one client the socket file is removed; heartbeat silence
//!    (--heartbeat-timeout-ms), EOF or a protocol violation ends the run.

pub mod observe;
pub mod protocol;
#[cfg(unix)]
pub mod server;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_content;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use protocol::ServiceStatus;

#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum NonceFrom {
    /// First stdin line {"v":1,"nonce":"..."} (default; nothing in argv or env).
    Stdin,
    /// EGDESK_HOST_NONCE (for a LaunchServices start, e.g. `open --env`).
    Env,
}

#[derive(clap::ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentLiveness {
    /// Exit when stdin reaches EOF (default).
    Stdin,
    /// Heartbeat only (no stdin pipe, e.g. a LaunchServices start).
    None,
}

#[derive(clap::Args, Debug, Clone)]
pub struct HostObserveArgs {
    /// Unix socket path inside a 0700 directory owned by this user.
    #[arg(long)]
    pub socket: PathBuf,
    #[arg(long, value_enum, default_value_t = NonceFrom::Stdin)]
    pub nonce_from: NonceFrom,
    #[arg(long, value_enum, default_value_t = ParentLiveness::Stdin)]
    pub parent_liveness: ParentLiveness,
    /// Exit when no client has said hello by then.
    #[arg(long, default_value_t = 10_000)]
    pub connect_timeout_ms: u64,
    /// Exit when the client sends nothing (pings included) for this long.
    #[arg(long, default_value_t = 5_000)]
    pub heartbeat_timeout_ms: u64,
    /// How often to re-check com.openai.sky.CUAService besides launch/terminate notifications.
    #[arg(long, default_value_t = 2_000)]
    pub service_poll_ms: u64,
    /// B1: also answer capture (one window, sensitive fields masked) and
    /// readElements (that window's accessibility tree). Off: observe_only.
    #[arg(long, default_value_t = false)]
    pub observe_content: bool,
}

impl HostObserveArgs {
    pub fn validate(&self) -> Result<(), String> {
        let within = |name: &str, value: u64, min: u64, max: u64| {
            if (min..=max).contains(&value) {
                Ok(())
            } else {
                Err(format!("--{name} must be between {min} and {max}"))
            }
        };
        within("connect-timeout-ms", self.connect_timeout_ms, 500, 120_000)?;
        within("heartbeat-timeout-ms", self.heartbeat_timeout_ms, 500, 60_000)?;
        within("service-poll-ms", self.service_poll_ms, 250, 60_000)
    }
}

fn process_start() -> Instant {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *START.get_or_init(Instant::now)
}

/// Milliseconds since this helper started (monotonic). Events carry it as
/// monoMs; hello.ok and pong carry the current value so the client can map
/// it onto its own clock.
pub fn mono_ms() -> u64 {
    u64::try_from(process_start().elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Remembers the last reported service state so only changes become events.
pub struct ServiceTracker {
    last: Mutex<Option<ServiceStatus>>,
}

impl ServiceTracker {
    pub fn new() -> Self {
        ServiceTracker { last: Mutex::new(None) }
    }

    /// The first observation sets the baseline (the snapshot reports it);
    /// later ones return Some only when running or the pid set changed.
    pub fn observe(&self, status: ServiceStatus) -> Option<ServiceStatus> {
        let mut last = self.last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match last.as_ref() {
            None => {
                *last = Some(status);
                None
            }
            Some(previous) if *previous == status => None,
            Some(_) => {
                *last = Some(status.clone());
                Some(status)
            }
        }
    }
}

impl Default for ServiceTracker {
    fn default() -> Self {
        Self::new()
    }
}

pub fn run_observe(args: HostObserveArgs) -> i32 {
    process_start();
    if let Err(message) = args.validate() {
        eprintln!("host-observe: {message}");
        return 2;
    }
    #[cfg(target_os = "macos")]
    {
        macos::run(args)
    }
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("host-observe: only available on macOS");
        2
    }
}

/// Unix part shared by the platform entry: nonce, socket, ready line, the
/// stdin watch and the server thread. Returns once those threads run; the
/// caller then owns the main thread (the macOS run loop). Every exit path
/// removes the socket file it bound and ends the process.
#[cfg(unix)]
pub(crate) fn launch(
    args: &HostObserveArgs,
    observer: std::sync::Arc<dyn protocol::Observer>,
    events: std::sync::mpsc::Receiver<(u64, protocol::HostEvent)>,
) -> Result<(), i32> {
    use std::io::{BufReader, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use server::{ExitReason, LineRead};

    server::check_socket_path(&args.socket).map_err(|message| {
        eprintln!("host-observe: {message}");
        2
    })?;
    let connect_timeout = Duration::from_millis(args.connect_timeout_ms);
    let parent_gone = Arc::new(AtomicBool::new(false));
    // Read (and drop) an environment nonce before any other thread exists.
    let env_nonce = (args.nonce_from == NonceFrom::Env).then(|| {
        let value = std::env::var("EGDESK_HOST_NONCE").ok();
        std::env::remove_var("EGDESK_HOST_NONCE");
        value
    });

    // stdin: optional nonce line first, then (optionally) wait for EOF.
    let (nonce_tx, nonce_rx) = mpsc::channel::<Option<String>>();
    let read_nonce = args.nonce_from == NonceFrom::Stdin;
    let watch_eof = args.parent_liveness == ParentLiveness::Stdin;
    if read_nonce || watch_eof {
        let parent_gone = Arc::clone(&parent_gone);
        std::thread::spawn(move || {
            let mut stdin = BufReader::new(std::io::stdin());
            if read_nonce {
                let nonce = match server::read_bounded_line(&mut stdin, protocol::MAX_NONCE_LINE) {
                    Ok(LineRead::Line(line)) => protocol::parse_nonce_line(&line),
                    _ => None,
                };
                let valid = nonce.is_some();
                let _ = nonce_tx.send(nonce);
                if !valid {
                    return; // the main thread reports the missing nonce and exits 2
                }
            }
            if watch_eof {
                let mut sink = [0u8; 256];
                loop {
                    match std::io::Read::read(stdin.get_mut(), &mut sink) {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
                parent_gone.store(true, Ordering::SeqCst);
                finish(None, ExitReason::ParentGone);
            }
        });
    }
    let nonce = if read_nonce {
        nonce_rx.recv_timeout(connect_timeout).ok().flatten()
    } else {
        env_nonce.flatten().filter(|value| crate::auth::valid_secret(value))
    };
    let Some(nonce) = nonce else {
        eprintln!("host-observe: no valid run nonce was given");
        return Err(2);
    };

    let (listener, identity) = server::bind_socket(&args.socket).map_err(|error| {
        eprintln!("host-observe: bind failed: {error}");
        7
    })?;
    remember_socket(identity.clone());
    let ready = serde_json::json!({
        "v": protocol::PROTOCOL_VERSION, "type": "ready", "pid": std::process::id(),
        "socket": identity.path().to_string_lossy(),
    });
    {
        let mut stdout = std::io::stdout().lock();
        if writeln!(stdout, "{ready}").and_then(|_| stdout.flush()).is_err() {
            identity.remove();
            return Err(7);
        }
    }

    let accept = server::AcceptConfig {
        nonce,
        deadline: Instant::now() + connect_timeout,
        hello_timeout: Duration::from_millis(protocol::HELLO_TIMEOUT_MS),
        expected_uid: server::effective_uid(),
        max_failures: protocol::MAX_AUTH_FAILURES,
    };
    let serve = server::ServeConfig {
        heartbeat_timeout: Duration::from_millis(args.heartbeat_timeout_ms),
        pid: std::process::id(),
    };
    std::thread::spawn(move || {
        let client = match server::accept_client(&listener, &accept, &parent_gone) {
            Ok(client) => client,
            Err(reason) => finish(Some(&identity), reason),
        };
        // One client per run: nobody else can connect from here on.
        drop(listener);
        identity.remove();
        let reason = server::serve_client(client, observer, events, process_start(), &serve);
        finish(None, reason);
    });
    Ok(())
}

#[cfg(unix)]
fn remember_socket(identity: server::SocketIdentity) {
    if let Ok(mut slot) = bound_socket().lock() {
        *slot = Some(identity);
    }
}

#[cfg(unix)]
fn bound_socket() -> &'static Mutex<Option<server::SocketIdentity>> {
    static SOCKET: std::sync::OnceLock<Mutex<Option<server::SocketIdentity>>> = std::sync::OnceLock::new();
    SOCKET.get_or_init(|| Mutex::new(None))
}

/// Removes the socket this run bound (if it is still ours) and exits.
#[cfg(unix)]
fn finish(identity: Option<&server::SocketIdentity>, reason: server::ExitReason) -> ! {
    if let Some(identity) = identity {
        identity.remove();
    }
    if let Ok(slot) = bound_socket().lock() {
        if let Some(identity) = slot.as_ref() {
            identity.remove();
        }
    }
    eprintln!("host-observe: exit ({})", reason.label());
    std::process::exit(reason.code())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> HostObserveArgs {
        HostObserveArgs {
            socket: PathBuf::from("/tmp/x.sock"),
            nonce_from: NonceFrom::Stdin,
            parent_liveness: ParentLiveness::Stdin,
            connect_timeout_ms: 10_000,
            heartbeat_timeout_ms: 5_000,
            service_poll_ms: 2_000,
            observe_content: false,
        }
    }

    #[test]
    fn argument_ranges() {
        assert!(args().validate().is_ok());
        assert!(HostObserveArgs { heartbeat_timeout_ms: 10, ..args() }.validate().is_err());
        assert!(HostObserveArgs { connect_timeout_ms: 500_000, ..args() }.validate().is_err());
        assert!(HostObserveArgs { service_poll_ms: 0, ..args() }.validate().is_err());
    }

    #[test]
    fn service_tracker_reports_only_changes() {
        let tracker = ServiceTracker::new();
        assert_eq!(tracker.observe(ServiceStatus::new(vec![])), None);
        assert_eq!(tracker.observe(ServiceStatus::new(vec![])), None);
        let started = tracker.observe(ServiceStatus::new(vec![42])).unwrap();
        assert!(started.running);
        assert_eq!(tracker.observe(ServiceStatus::new(vec![42])), None);
        let restarted = tracker.observe(ServiceStatus::new(vec![43])).unwrap();
        assert_eq!(restarted.pids, vec![43]);
        assert!(!tracker.observe(ServiceStatus::new(vec![])).unwrap().running);
    }

    #[test]
    fn mono_clock_moves_forward() {
        let first = mono_ms();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(mono_ms() >= first + 4);
    }
}
