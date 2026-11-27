//! host-observe's Unix-socket endpoint: one authenticated client per run.
//!
//! Portions adapted from trycua/cua libs/cua-driver/rust (MIT License,
//! Copyright (c) 2025 Cua AI, Inc.): crates/cua-driver/src/serve.rs
//! (secure_local_socket 0600, socket_identity / remove_owned_socket dev+ino
//! check, authenticate_unix_peer/uid before any request is parsed,
//! wait_for_parent_stdin_eof). Pattern only, no code: open-computer-use
//! (MIT, Copyright (c) 2026 Leo) MacOSAppAgentProxy.swift AppAgentSocketListener
//! (chmod S_IRUSR|S_IWUSR after bind) and AppAgentConnection's disconnect
//! watch.
//!
//! Rules this file enforces:
//! - The socket lives in a directory owned by this uid with no group/other
//!   access (the parent made it 0700); the socket itself is chmod 0600.
//! - A connection from another uid is closed before a byte is read.
//! - The first line must be hello with this run's nonce (constant-time
//!   compare) within HELLO_TIMEOUT_MS; MAX_AUTH_FAILURES bad tries end the run.
//! - After the first good hello the listener is closed and the socket file
//!   removed, so nobody else can connect; when that client goes away (EOF,
//!   heartbeat silence, oversized line) the run ends.

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::protocol::{self, HostEvent, Inbound, Observer, MAX_INBOUND_LINE};
use crate::auth::constant_time_eq;

/// Longest path macOS accepts in sockaddr_un.sun_path (104 bytes with NUL).
pub const MAX_SOCKET_PATH: usize = 103;
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const ACCEPT_POLL: Duration = Duration::from_millis(20);
const EVENT_POLL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    ClientClosed,
    ShutdownRequested,
    ParentGone,
    HeartbeatLost,
    ConnectTimeout,
    AuthFailures,
    Protocol,
    Io,
}

impl ExitReason {
    pub fn code(self) -> i32 {
        match self {
            ExitReason::ClientClosed | ExitReason::ShutdownRequested | ExitReason::ParentGone => 0,
            ExitReason::AuthFailures => 3,
            ExitReason::HeartbeatLost => 4,
            ExitReason::ConnectTimeout => 5,
            ExitReason::Protocol => 6,
            ExitReason::Io => 7,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ExitReason::ClientClosed => "client-closed",
            ExitReason::ShutdownRequested => "shutdown-requested",
            ExitReason::ParentGone => "parent-gone",
            ExitReason::HeartbeatLost => "heartbeat-lost",
            ExitReason::ConnectTimeout => "connect-timeout",
            ExitReason::AuthFailures => "auth-failures",
            ExitReason::Protocol => "protocol",
            ExitReason::Io => "io",
        }
    }
}

pub fn effective_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// The socket path must be absolute, short enough for sun_path, not yet
/// exist, and sit in a real directory owned by us with mode & 0o077 == 0.
pub fn check_socket_path(path: &Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    if !path.is_absolute() {
        return Err("socket path must be absolute".into());
    }
    let bytes = path.as_os_str().as_bytes();
    if bytes.len() > MAX_SOCKET_PATH || bytes.contains(&0) {
        return Err(format!("socket path must be at most {MAX_SOCKET_PATH} bytes"));
    }
    if path.file_name().is_none() {
        return Err("socket path needs a file name".into());
    }
    let parent = path.parent().ok_or("socket path needs a parent directory")?;
    let meta = std::fs::symlink_metadata(parent).map_err(|e| format!("socket directory: {e}"))?;
    if !meta.file_type().is_dir() {
        return Err("socket directory must be a real directory (not a symlink)".into());
    }
    if meta.uid() != effective_uid() {
        return Err("socket directory must be owned by this user".into());
    }
    if meta.mode() & 0o077 != 0 {
        return Err("socket directory must not be readable or writable by group or others (0700)".into());
    }
    match std::fs::symlink_metadata(path) {
        Ok(_) => Err("socket path already exists; the parent removes stale sockets before starting us".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("socket path: {error}")),
    }
}

/// The bound socket file, identified by device and inode so cleanup never
/// removes a file someone else put at the same path later.
#[derive(Debug, Clone)]
pub struct SocketIdentity {
    path: PathBuf,
    dev: u64,
    ino: u64,
}

impl SocketIdentity {
    pub fn remove(&self) {
        if let Ok(meta) = std::fs::symlink_metadata(&self.path) {
            if meta.dev() == self.dev && meta.ino() == self.ino {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn bind_socket(path: &Path) -> io::Result<(UnixListener, SocketIdentity)> {
    let listener = UnixListener::bind(path)?;
    let secured = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .and_then(|_| std::fs::symlink_metadata(path));
    match secured {
        Ok(meta) => Ok((listener, SocketIdentity { path: path.to_path_buf(), dev: meta.dev(), ino: meta.ino() })),
        Err(error) => {
            let _ = std::fs::remove_file(path);
            Err(error)
        }
    }
}

pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: the fd is a live connected Unix socket owned by `stream`; uid
    // and gid are valid out-pointers for the duration of the call.
    let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    if result == 0 {
        Ok(uid)
    } else {
        Err(io::Error::last_os_error())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum LineRead {
    Line(String),
    Eof,
    TooLong,
    NotUtf8,
    TimedOut,
}

/// Reads one '\n'-terminated line of at most `max` bytes (without the
/// newline). A read timeout set on the socket surfaces as TimedOut.
pub fn read_bounded_line<R: BufRead>(reader: &mut R, max: usize) -> io::Result<LineRead> {
    let mut line: Vec<u8> = Vec::new();
    loop {
        let available = match reader.fill_buf() {
            Ok(buffer) => buffer,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                return Ok(LineRead::TimedOut)
            }
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(LineRead::Eof);
        }
        if let Some(position) = available.iter().position(|byte| *byte == b'\n') {
            if line.len() + position > max {
                return Ok(LineRead::TooLong);
            }
            line.extend_from_slice(&available[..position]);
            reader.consume(position + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(match String::from_utf8(line) {
                Ok(text) => LineRead::Line(text),
                Err(_) => LineRead::NotUtf8,
            });
        }
        let length = available.len();
        if line.len() + length > max {
            return Ok(LineRead::TooLong);
        }
        line.extend_from_slice(available);
        reader.consume(length);
    }
}

fn write_line(writer: &Mutex<UnixStream>, line: &str) -> io::Result<()> {
    let mut stream = writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut bytes = Vec::with_capacity(line.len() + 1);
    bytes.extend_from_slice(line.as_bytes());
    bytes.push(b'\n');
    stream.write_all(&bytes)?;
    stream.flush()
}

pub struct AcceptConfig {
    pub nonce: String,
    pub deadline: Instant,
    pub hello_timeout: Duration,
    pub expected_uid: u32,
    pub max_failures: u32,
}

/// An authenticated connection: the reader keeps whatever the client sent
/// right after hello.
pub struct Client {
    pub reader: BufReader<UnixStream>,
    pub writer: UnixStream,
}

fn authenticate(stream: UnixStream, config: &AcceptConfig) -> Result<Client, (&'static str, UnixStream)> {
    match peer_uid(&stream) {
        Ok(uid) if uid == config.expected_uid => {}
        _ => return Err(("peer_uid", stream)),
    }
    if stream.set_nonblocking(false).is_err() || stream.set_read_timeout(Some(config.hello_timeout)).is_err() {
        return Err(("bad_hello", stream));
    }
    let writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return Err(("bad_hello", stream)),
    };
    let mut reader = BufReader::new(stream);
    let code = match read_bounded_line(&mut reader, MAX_INBOUND_LINE) {
        Ok(LineRead::Line(text)) => match protocol::parse_inbound(&text) {
            Ok(Inbound::Hello { nonce }) if constant_time_eq(nonce.as_bytes(), config.nonce.as_bytes()) => {
                return Ok(Client { reader, writer });
            }
            Ok(Inbound::Hello { .. }) => "bad_nonce",
            _ => "bad_hello",
        },
        Ok(LineRead::TimedOut) => "hello_timeout",
        _ => "bad_hello",
    };
    Err((code, writer))
}

/// Waits for the one client of this run. Returns ConnectTimeout at the
/// deadline, AuthFailures after too many bad tries, ParentGone if `stop` is set.
pub fn accept_client(listener: &UnixListener, config: &AcceptConfig, stop: &AtomicBool) -> Result<Client, ExitReason> {
    listener.set_nonblocking(true).map_err(|_| ExitReason::Io)?;
    let mut failures = 0u32;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Err(ExitReason::ParentGone);
        }
        if Instant::now() >= config.deadline {
            return Err(ExitReason::ConnectTimeout);
        }
        match listener.accept() {
            Ok((stream, _)) => match authenticate(stream, config) {
                Ok(client) => return Ok(client),
                Err((code, mut stream)) => {
                    // A foreign uid gets nothing; a same-uid caller learns why.
                    if code != "peer_uid" {
                        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
                        let _ = stream.write_all(format!("{}\n", protocol::hello_rejected(code)).as_bytes());
                    }
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                    failures += 1;
                    eprintln!("host-observe: rejected a connection ({code})");
                    if failures >= config.max_failures {
                        return Err(ExitReason::AuthFailures);
                    }
                }
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(ACCEPT_POLL),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(ExitReason::Io),
        }
    }
}

pub struct ServeConfig {
    pub heartbeat_timeout: Duration,
    pub pid: u32,
}

/// Milliseconds since `start`, saturating.
pub fn elapsed_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Serves the authenticated client until it leaves. `events` carries
/// (monoMs at observation, event); they are numbered in send order.
pub fn serve_client(
    client: Client,
    observer: Arc<dyn Observer>,
    events: Receiver<(u64, HostEvent)>,
    start: Instant,
    config: &ServeConfig,
) -> ExitReason {
    let Client { mut reader, writer } = client;
    if writer.set_write_timeout(Some(WRITE_TIMEOUT)).is_err()
        || reader.get_ref().set_read_timeout(Some(config.heartbeat_timeout)).is_err()
    {
        return ExitReason::Io;
    }
    let shutdown_handle = match writer.try_clone() {
        Ok(handle) => handle,
        Err(_) => return ExitReason::Io,
    };
    let writer = Arc::new(Mutex::new(writer));
    if write_line(&writer, &protocol::hello_ok_with(config.pid, config.heartbeat_timeout.as_millis() as u64, elapsed_ms(start), observer.content_enabled())).is_err() {
        return ExitReason::Io;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let forwarder = {
        let writer = Arc::clone(&writer);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            let mut seq = 0u64;
            while !stop.load(Ordering::SeqCst) {
                match events.recv_timeout(EVENT_POLL) {
                    Ok((mono_ms, event)) => {
                        seq += 1;
                        if write_line(&writer, &event.to_line(seq, mono_ms)).is_err() {
                            // The reader sees the shutdown as EOF or an error.
                            let _ = shutdown_handle.shutdown(std::net::Shutdown::Both);
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
    };

    let reason = loop {
        let line = match read_bounded_line(&mut reader, MAX_INBOUND_LINE) {
            Ok(LineRead::Line(line)) => line,
            Ok(LineRead::Eof) => break ExitReason::ClientClosed,
            Ok(LineRead::TimedOut) => break ExitReason::HeartbeatLost,
            Ok(LineRead::TooLong) | Ok(LineRead::NotUtf8) => break ExitReason::Protocol,
            Err(_) => break ExitReason::Io,
        };
        let (reply, shutdown) = match protocol::parse_inbound(&line) {
            Ok(Inbound::Ping { seq }) => (protocol::pong(seq, elapsed_ms(start)), false),
            Ok(Inbound::Request { id, kind }) => protocol::answer(observer.as_ref(), &id, &kind),
            Ok(Inbound::Hello { .. }) => (protocol::failure(None, "bad_request", "already authenticated"), false),
            Err(_) => (protocol::failure(None, "bad_request", "not a valid request line"), false),
        };
        if write_line(&writer, &reply).is_err() {
            break ExitReason::Io;
        }
        if shutdown {
            break ExitReason::ShutdownRequested;
        }
    };
    stop.store(true, Ordering::SeqCst);
    let _ = forwarder.join();
    reason
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::protocol::{AppInfo, AppRef, Permissions, ServiceStatus, WindowList, WindowQuery};
    use serde_json::Value;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc::sync_channel;

    struct FakeObserver;
    impl Observer for FakeObserver {
        fn apps(&self) -> Vec<AppInfo> {
            vec![AppInfo { bundle_id: Some("com.apple.finder".into()), pid: 1, name: Some("Finder".into()), active: true, policy: "regular" }]
        }
        fn frontmost(&self) -> Option<AppRef> {
            Some(AppRef { bundle_id: Some("com.apple.finder".into()), pid: 1, name: Some("Finder".into()) })
        }
        fn windows(&self, query: WindowQuery) -> WindowList {
            WindowList { windows: vec![], titles: if query.titles { "omitted-no-permission" } else { "not-requested" }, truncated: false }
        }
        fn permissions(&self) -> Permissions {
            Permissions { accessibility: false, screen_recording: false, input_monitoring: false, requested: false, screen_locked: false, bundled: false }
        }
        fn service(&self) -> ServiceStatus {
            ServiceStatus::new(vec![])
        }
    }

    fn private_dir() -> PathBuf {
        let base = std::env::temp_dir().join(format!("egdh-{}-{}", std::process::id(), &crate::auth::generate_secret()[..8]));
        std::fs::create_dir(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        base
    }

    const NONCE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn config(deadline_ms: u64) -> AcceptConfig {
        AcceptConfig {
            nonce: NONCE.into(),
            deadline: Instant::now() + Duration::from_millis(deadline_ms),
            hello_timeout: Duration::from_millis(500),
            expected_uid: effective_uid(),
            max_failures: 2,
        }
    }

    fn send(stream: &mut UnixStream, line: &str) {
        stream.write_all(format!("{line}\n").as_bytes()).unwrap();
    }

    fn recv(reader: &mut BufReader<UnixStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or(Value::Null)
    }

    #[test]
    fn socket_path_rules() {
        let dir = private_dir();
        assert!(check_socket_path(&dir.join("h.sock")).is_ok());
        assert!(check_socket_path(Path::new("relative.sock")).is_err());
        let long = dir.join("x".repeat(120));
        assert!(check_socket_path(&long).is_err());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check_socket_path(&dir.join("h.sock")).unwrap_err().contains("0700"));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (listener, identity) = bind_socket(&dir.join("h.sock")).unwrap();
        let mode = std::fs::symlink_metadata(identity.path()).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert!(check_socket_path(&dir.join("h.sock")).unwrap_err().contains("already exists"));
        drop(listener);
        identity.remove();
        assert!(!dir.join("h.sock").exists());
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn identity_cleanup_leaves_a_replaced_file_alone() {
        let dir = private_dir();
        let path = dir.join("h.sock");
        let (_listener, identity) = bind_socket(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"someone else").unwrap();
        identity.remove();
        assert!(path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bounded_lines() {
        let mut ok = BufReader::new(&b"{\"a\":1}\r\nrest"[..]);
        assert_eq!(read_bounded_line(&mut ok, 64).unwrap(), LineRead::Line("{\"a\":1}".into()));
        assert_eq!(read_bounded_line(&mut ok, 64).unwrap(), LineRead::Eof);
        let mut long = BufReader::with_capacity(4, &b"0123456789\n"[..]);
        assert_eq!(read_bounded_line(&mut long, 8).unwrap(), LineRead::TooLong);
        let mut bad = BufReader::new(&b"\xff\xfe\n"[..]);
        assert_eq!(read_bounded_line(&mut bad, 8).unwrap(), LineRead::NotUtf8);
    }

    #[test]
    fn wrong_nonce_is_rejected_then_the_right_client_is_served() {
        let dir = private_dir();
        let path = dir.join("h.sock");
        let (listener, identity) = bind_socket(&path).unwrap();
        let stop = AtomicBool::new(false);
        let client_path = path.clone();
        let client = std::thread::spawn(move || {
            let mut bad = UnixStream::connect(&client_path).unwrap();
            send(&mut bad, &format!(r#"{{"type":"hello","v":1,"nonce":"{}"}}"#, "f".repeat(64)));
            let mut bad_reader = BufReader::new(bad.try_clone().unwrap());
            assert_eq!(recv(&mut bad_reader)["code"], "bad_nonce");

            let mut good = UnixStream::connect(&client_path).unwrap();
            // hello and a ping in one write: the ping must not be lost.
            good.write_all(format!("{{\"type\":\"hello\",\"v\":1,\"nonce\":\"{NONCE}\"}}\n{{\"type\":\"ping\",\"seq\":1}}\n").as_bytes()).unwrap();
            let mut reader = BufReader::new(good.try_clone().unwrap());
            let hello = recv(&mut reader);
            assert_eq!(hello["type"], "hello.ok");
            assert_eq!(hello["capabilities"]["input"], false);
            assert_eq!(recv(&mut reader)["type"], "pong");
            let event = recv(&mut reader);
            assert_eq!(event["event"], "app.activated");
            assert_eq!(event["seq"], 1);
            assert_eq!(event["monoMs"], 77);
            send(&mut good, r#"{"id":"r1","type":"snapshot"}"#);
            let snapshot = recv(&mut reader);
            assert_eq!(snapshot["ok"], true);
            assert_eq!(snapshot["result"]["frontmost"]["bundleId"], "com.apple.finder");
            assert_eq!(snapshot["result"]["permissions"]["requested"], false);
            send(&mut good, r#"{"id":"r2","type":"click","x":10,"y":10}"#);
            let refused = recv(&mut reader);
            assert_eq!(refused["ok"], false);
            assert_eq!(refused["code"], "observe_only");
            send(&mut good, r#"{"id":"r3","type":"shutdown"}"#);
            assert_eq!(recv(&mut reader)["result"]["stopping"], true);
        });
        let accepted = accept_client(&listener, &config(5_000), &stop).unwrap();
        drop(listener);
        identity.remove();
        let (tx, rx) = sync_channel(8);
        tx.send((77, HostEvent::AppActivated(AppRef { bundle_id: Some("com.apple.Safari".into()), pid: 5, name: Some("Safari".into()) }))).unwrap();
        let reason = serve_client(accepted, Arc::new(FakeObserver), rx, Instant::now(), &ServeConfig { heartbeat_timeout: Duration::from_secs(5), pid: 1 });
        client.join().unwrap();
        assert_eq!(reason, ExitReason::ShutdownRequested);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn too_many_bad_hellos_end_the_run() {
        let dir = private_dir();
        let path = dir.join("h.sock");
        let (listener, _identity) = bind_socket(&path).unwrap();
        let stop = AtomicBool::new(false);
        let client_path = path.clone();
        let client = std::thread::spawn(move || {
            for _ in 0..2 {
                let mut stream = UnixStream::connect(&client_path).unwrap();
                send(&mut stream, r#"{"type":"ping","seq":1}"#);
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
            }
        });
        assert_eq!(accept_client(&listener, &config(5_000), &stop).err(), Some(ExitReason::AuthFailures));
        client.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_client_before_the_deadline_is_a_connect_timeout() {
        let dir = private_dir();
        let (listener, _identity) = bind_socket(&dir.join("h.sock")).unwrap();
        let stop = AtomicBool::new(false);
        assert_eq!(accept_client(&listener, &config(100), &stop).err(), Some(ExitReason::ConnectTimeout));
        stop.store(true, Ordering::SeqCst);
        assert_eq!(accept_client(&listener, &config(5_000), &stop).err(), Some(ExitReason::ParentGone));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn heartbeat_silence_and_eof_end_the_session() {
        for (silent, expected) in [(true, ExitReason::HeartbeatLost), (false, ExitReason::ClientClosed)] {
            let dir = private_dir();
            let path = dir.join("h.sock");
            let (listener, _identity) = bind_socket(&path).unwrap();
            let stop = AtomicBool::new(false);
            let client_path = path.clone();
            let client = std::thread::spawn(move || {
                let mut stream = UnixStream::connect(&client_path).unwrap();
                send(&mut stream, &format!(r#"{{"type":"hello","v":1,"nonce":"{NONCE}"}}"#));
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                assert_eq!(recv(&mut reader)["type"], "hello.ok");
                if silent {
                    std::thread::sleep(Duration::from_millis(600));
                } else {
                    stream.shutdown(std::net::Shutdown::Both).unwrap();
                }
            });
            let accepted = accept_client(&listener, &config(5_000), &stop).unwrap();
            let (_tx, rx) = sync_channel(1);
            let reason = serve_client(accepted, Arc::new(FakeObserver), rx, Instant::now(), &ServeConfig { heartbeat_timeout: Duration::from_millis(250), pid: 1 });
            assert_eq!(reason, expected);
            client.join().unwrap();
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[test]
    fn oversized_line_is_a_protocol_violation() {
        let dir = private_dir();
        let path = dir.join("h.sock");
        let (listener, _identity) = bind_socket(&path).unwrap();
        let stop = AtomicBool::new(false);
        let client_path = path.clone();
        let client = std::thread::spawn(move || {
            let mut stream = UnixStream::connect(&client_path).unwrap();
            send(&mut stream, &format!(r#"{{"type":"hello","v":1,"nonce":"{NONCE}"}}"#));
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            assert_eq!(recv(&mut reader)["type"], "hello.ok");
            let _ = stream.write_all(&vec![b'x'; MAX_INBOUND_LINE + 10]);
            let _ = stream.write_all(b"\n");
        });
        let accepted = accept_client(&listener, &config(5_000), &stop).unwrap();
        let (_tx, rx) = sync_channel(1);
        let reason = serve_client(accepted, Arc::new(FakeObserver), rx, Instant::now(), &ServeConfig { heartbeat_timeout: Duration::from_secs(5), pid: 1 });
        assert_eq!(reason, ExitReason::Protocol);
        client.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
