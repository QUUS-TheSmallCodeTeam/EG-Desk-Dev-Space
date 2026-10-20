use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

const MAX_INPUT_LINE: usize = 128 * 1024;
const MAX_WRITE_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_LINE: usize = 64 * 1024;
const OUTPUT_READ_BYTES: usize = 8192;

#[derive(Clone)]
struct ShutdownWatchdog {
    armed: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}

fn enforce_shutdown_deadline(armed: &AtomicBool, done: &AtomicBool, abort: impl FnOnce()) {
    if armed.load(Ordering::Acquire) && !done.load(Ordering::Acquire) { abort(); }
}

impl ShutdownWatchdog {
    fn new() -> Self {
        Self { armed: Arc::new(AtomicBool::new(false)), done: Arc::new(AtomicBool::new(false)) }
    }
    fn arm(&self) {
        if self.armed.swap(true, Ordering::AcqRel) { return; }
        let guard = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            // This binary owns exactly one pseudoconsole. A watchdog exit is
            // failure, never a native-exit packet or invented shell exit code.
            enforce_shutdown_deadline(&guard.armed, &guard.done, || std::process::exit(1));
        });
    }
    fn complete(&self) { self.done.store(true, Ordering::Release); }
}

fn clean_pipe_eof(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::BrokenPipe
}

fn windows_bool_result(result: i32, last_error: impl FnOnce() -> io::Error) -> io::Result<()> {
    // Win32 BOOL success is nonzero; GetLastError is meaningful only on failure.
    if result != 0 { Ok(()) } else { Err(last_error()) }
}

#[cfg(windows)]
#[derive(Debug)]
struct OwnedNativeKiller(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl OwnedNativeKiller {
    fn from_child(child: &dyn portable_pty::Child) -> io::Result<Self> {
        use std::os::windows::io::BorrowedHandle;
        let raw = child.as_raw_handle().ok_or_else(||
            io::Error::new(io::ErrorKind::Unsupported, "NATIVE_HANDLE_UNAVAILABLE"))?;
        // The borrow cannot outlive child; duplicate it before child moves to wait.
        // This owns the original process object, never reopens a possibly reused PID.
        let handle = unsafe { BorrowedHandle::borrow_raw(raw) }.try_clone_to_owned()?;
        Ok(Self(handle))
    }

    fn kill(&self) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        // portable-pty 0.9.0 WinChildKiller reverses this BOOL result. Keep its
        // native Child::wait proof, but call the documented API on our own handle.
        let result = unsafe {
            windows_sys::Win32::System::Threading::TerminateProcess(self.0.as_raw_handle(), 1)
        };
        windows_bool_result(result, io::Error::last_os_error)
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Request {
    #[serde(rename = "init")]
    Init {
        v: u8,
        #[serde(rename = "shellId")]
        shell_id: String,
        cwd: String,
        cols: u16,
        rows: u16,
        env: BTreeMap<String, String>,
        #[serde(rename = "powerShellInitialization", default)]
        initialization: Option<String>,
    },
    #[serde(rename = "write")]
    Write {
        v: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        data: String,
    },
    #[serde(rename = "resize")]
    Resize {
        v: u8,
        #[serde(rename = "requestId")]
        request_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "kill")]
    Kill {
        v: u8,
        #[serde(rename = "requestId")]
        request_id: String,
    },
}

#[derive(Debug)]
struct Init {
    shell_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    env: BTreeMap<String, String>,
    initialization: Option<String>,
}

fn dimensions(cols: u16, rows: u16) -> Result<(), &'static str> {
    if (2..=1000).contains(&cols) && (1..=1000).contains(&rows) {
        Ok(())
    } else {
        Err("INVALID_TERMINAL_SIZE")
    }
}

fn windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    let unc = value.starts_with("\\\\") && value.len() > 4;
    (drive || unc) && value.len() <= 32767 && !value.contains('\0')
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

fn parse_request(line: &[u8]) -> Result<Request, &'static str> {
    if line.len() > MAX_INPUT_LINE {
        return Err("FRAME_LIMIT");
    }
    let request: Request = serde_json::from_slice(line).map_err(|_| "INVALID_REQUEST")?;
    let version = match &request {
        Request::Init { v, shell_id, cwd, cols, rows, env, initialization } => {
            dimensions(*cols, *rows)?;
            if !matches!(shell_id.as_str(), "powershell" | "cmd") || !windows_absolute(cwd) {
                return Err("INVALID_INITIALIZATION");
            }
            if env.iter().any(|(key, value)| key.is_empty() || (key.contains('=') || key.contains('\0')) || value.contains('\0')) {
                return Err("INVALID_ENVIRONMENT");
            }
            if initialization.as_ref().is_some_and(|text| text.len() > 16384 || text.contains('\0')) {
                return Err("INVALID_INITIALIZATION");
            }
            *v
        }
        Request::Write { v, request_id, data } => {
            if !valid_request_id(request_id) || data.len() > MAX_WRITE_BYTES {
                return Err("INVALID_INPUT");
            }
            *v
        }
        Request::Resize { v, request_id, cols, rows } => {
            if !valid_request_id(request_id) { return Err("INVALID_REQUEST_ID"); }
            dimensions(*cols, *rows)?;
            *v
        }
        Request::Kill { v, request_id } => {
            if !valid_request_id(request_id) { return Err("INVALID_REQUEST_ID"); }
            *v
        }
    };
    if version != 1 { return Err("PROTOCOL_VERSION"); }
    Ok(request)
}

// Inspect the borrowed buffer before copying. A missing newline cannot cause
// read_line to allocate an unbounded String.
fn read_frame<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut frame = Vec::new();
    loop {
        let (count, complete) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                return if frame.is_empty() { Ok(None) } else { Ok(Some(frame)) };
            }
            let end = available.iter().position(|b| *b == b'\n');
            let count = end.map_or(available.len(), |at| at + 1);
            if frame.len() + count > MAX_INPUT_LINE {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "FRAME_LIMIT"));
            }
            frame.extend_from_slice(&available[..count]);
            (count, end.is_some())
        };
        reader.consume(count);
        if complete {
            frame.pop();
            if frame.last() == Some(&b'\r') { frame.pop(); }
            return Ok(Some(frame));
        }
    }
}

#[derive(Default)]
struct Utf8Carry {
    pending: Vec<u8>,
}

impl Utf8Carry {
    fn feed(&mut self, input: &[u8]) -> Result<String, &'static str> {
        if input.len() > OUTPUT_READ_BYTES { return Err("OUTPUT_FRAME_LIMIT"); }
        self.pending.extend_from_slice(input);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                let text = text.to_owned();
                self.pending.clear();
                Ok(text)
            }
            Err(error) if error.error_len().is_none() => {
                let valid = error.valid_up_to();
                let text = std::str::from_utf8(&self.pending[..valid]).map_err(|_| "OUTPUT_UTF8")?.to_owned();
                self.pending.drain(..valid);
                Ok(text)
            }
            Err(_) => Err("OUTPUT_UTF8"),
        }
    }

    fn finish(&self) -> Result<(), &'static str> {
        if self.pending.is_empty() { Ok(()) } else { Err("OUTPUT_UTF8_INCOMPLETE") }
    }
}

fn env_value<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    env.iter().find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, value)| value.as_str())
}

#[derive(Debug)]
struct Shell {
    id: String,
    executable: PathBuf,
    args: Vec<String>,
}

fn resolve_shell(init: &Init, exists: impl Fn(&Path) -> bool) -> Result<Shell, &'static str> {
    let system = PathBuf::from(env_value(&init.env, "SystemRoot")
        .or_else(|| env_value(&init.env, "WINDIR")).unwrap_or("C:\\Windows"));
    let mut executable = system.join("System32").join("cmd.exe");
    let mut args = vec!["/D".to_owned()];
    if init.shell_id == "powershell" {
        executable = system.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        for variable in ["ProgramW6432", "ProgramFiles"] {
            if let Some(root) = env_value(&init.env, variable) {
                let candidate = PathBuf::from(root).join("PowerShell").join("7").join("pwsh.exe");
                if exists(&candidate) { executable = candidate; break; }
            }
        }
        args = vec!["-NoLogo".to_owned(), "-NoProfile".to_owned()];
        if let Some(script) = init.initialization.as_ref().filter(|text| !text.is_empty()) {
            args.extend(["-NoExit".to_owned(), "-Command".to_owned(), script.clone()]);
        }
    } else if let Some(comspec) = env_value(&init.env, "ComSpec") {
        if comspec.replace('/', "\\").eq_ignore_ascii_case(&executable.to_string_lossy()) {
            executable = PathBuf::from(comspec);
        }
    }
    if !exists(&executable) { return Err("TERMINAL_SHELL_UNAVAILABLE"); }
    if serde_json::to_vec(&args).map_err(|_| "INVALID_INITIALIZATION")?.len() > MAX_OUTPUT_LINE / 2 {
        return Err("INVALID_INITIALIZATION");
    }
    Ok(Shell { id: init.shell_id.clone(), executable, args })
}

fn native_environment(init: &Init, shell: &Shell) -> BTreeMap<String, String> {
    let legacy = shell.id == "cmd" || shell.executable.file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("powershell.exe"));
    let mut env: BTreeMap<_, _> = init.env.iter().filter(|(key, _)| {
        !(legacy && key.eq_ignore_ascii_case("PSModulePath"))
            && !key.eq_ignore_ascii_case("TERM") && !key.eq_ignore_ascii_case("COLORTERM")
    }).map(|(key, value)| (key.clone(), value.clone())).collect();
    env.insert("TERM".into(), "xterm-256color".into());
    env.insert("COLORTERM".into(), "truecolor".into());
    env
}

fn write_packet(writer: &mut impl Write, packet: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(packet).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "JSON_ENCODE"))?;
    if bytes.len() + 1 > MAX_OUTPUT_LINE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "OUTPUT_FRAME_LIMIT"));
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn startup_error(code: &'static str, native_created: Value) {
    let _ = write_packet(&mut io::stdout().lock(),
        &json!({"v":1,"type":"spawn-error","nativeCreated":native_created,"code":code}));
}

#[cfg(windows)]
fn run_windows(init: Init, input: BufReader<io::Stdin>) -> Result<(), &'static str> {
    use portable_pty::{native_pty_system, CommandBuilder, ExitStatus, PtySize};
    use std::sync::{atomic::{AtomicBool, Ordering}, mpsc::{self, SyncSender, TrySendError}, Arc};
    use std::thread;

    enum Event {
        Request(Request),
        InputClosed,
        InputError,
        NativeExit(Result<ExitStatus, ()>),
        OutputFailed,
    }

    #[derive(Clone)]
    struct Emitter(SyncSender<Value>);
    impl Emitter {
        fn send(&self, packet: Value) -> bool { self.0.send(packet).is_ok() }
        fn ack(&self, id: String, ok: bool, code: &'static str) {
            self.send(json!({"v":1,"type":"ack","requestId":id,"ok":ok,"code":code}));
        }
    }

    let shutdown = ShutdownWatchdog::new();
    let (events_tx, events_rx) = mpsc::sync_channel::<Event>(64);
    let input_events = events_tx.clone();
    let input_shutdown = shutdown.clone();
    thread::spawn(move || {
        let mut input = input;
        loop {
            let event = match read_frame(&mut input) {
                Ok(Some(frame)) => match parse_request(&frame) {
                    Ok(Request::Init { .. }) | Err(_) => Event::InputError,
                    Ok(request) => Event::Request(request),
                },
                Ok(None) => Event::InputClosed,
                Err(_) => Event::InputError,
            };
            let terminal = matches!(event, Event::InputClosed | Event::InputError);
            if terminal || matches!(&event, Event::Request(Request::Kill { .. })) { input_shutdown.arm(); }
            if input_events.send(event).is_err() || terminal { return; }
        }
    });


    let shell = resolve_shell(&init, Path::is_file).map_err(|code| { startup_error(code, json!(false)); code })?;
    if !Path::new(&init.cwd).is_dir() {
        startup_error("INVALID_CWD", json!(false)); return Err("INVALID_CWD");
    }
    let mut command = CommandBuilder::new(&shell.executable);
    command.args(&shell.args);
    command.cwd(&init.cwd);
    command.env_clear();
    for (key, value) in native_environment(&init, &shell) { command.env(key, value); }
    let pair = native_pty_system().openpty(PtySize { cols: init.cols, rows: init.rows, pixel_width: 0, pixel_height: 0 })
        .map_err(|_| { startup_error("CONPTY_OPEN_FAILED", json!(false)); "CONPTY_OPEN_FAILED" })?;
    let mut reader = pair.master.try_clone_reader()
        .map_err(|_| { startup_error("CONPTY_READER_FAILED", json!(false)); "CONPTY_READER_FAILED" })?;
    let mut writer = pair.master.take_writer()
        .map_err(|_| { startup_error("CONPTY_WRITER_FAILED", json!(false)); "CONPTY_WRITER_FAILED" })?;

    let (output_tx, output_rx) = mpsc::sync_channel::<Value>(64);
    let stdout_ok = Arc::new(AtomicBool::new(true));
    let output_ok = Arc::new(AtomicBool::new(true));
    let stopping = Arc::new(AtomicBool::new(false));
    let stdout_health = stdout_ok.clone();
    let stdout_events = events_tx.clone();
    let stdout_shutdown = shutdown.clone();
    let stdout_thread = thread::spawn(move || {
        let mut stdout = io::BufWriter::new(io::stdout().lock());
        for packet in output_rx {
            if write_packet(&mut stdout, &packet).is_err() {
                stdout_health.store(false, Ordering::Release);
                stdout_shutdown.arm();
                let _ = stdout_events.try_send(Event::OutputFailed);
                return Err(());
            }
        }
        stdout.flush().map_err(|_| ())
    });
    let out = Emitter(output_tx);
    let reader_out = out.clone();
    let reader_health = output_ok.clone();
    let reader_events = events_tx.clone();
    let reader_shutdown = shutdown.clone();
    // Reader remains active while the main thread drops the master/HPCON.
    // It continues draining even after stdout fails, avoiding ClosePseudoConsole deadlocks.
    let reader_thread = thread::spawn(move || {
        let mut decoder = Utf8Carry::default();
        let mut bytes = [0u8; OUTPUT_READ_BYTES];
        let mut good = true;
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => {
                    if !good { continue; }
                    match decoder.feed(&bytes[..count]) {
                        Ok(text) => {
                            if !text.is_empty() && !reader_out.send(json!({"v":1,"type":"output","data":text})) {
                                good = false;
                            }
                        }
                        Err(_) => good = false,
                    }
                    if !good {
                        reader_health.store(false, Ordering::Release);
                        reader_shutdown.arm();
                        let _ = reader_events.try_send(Event::OutputFailed);
                    }
                }
                Err(error) if clean_pipe_eof(&error) => break,
                Err(_) => { good = false; break; }
            }
        }
        good &= decoder.finish().is_ok();
        if !good {
            reader_health.store(false, Ordering::Release);
            reader_shutdown.arm();
            let _ = reader_events.try_send(Event::OutputFailed);
        }
        good
    });

    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(_) => {
            // A constructor error after a spawn attempt is ambiguous, never definite no-native.
            shutdown.arm();
            drop(writer); drop(pair);
            let _ = reader_thread.join();
            out.send(json!({"v":1,"type":"spawn-error","nativeCreated":null,"code":"NATIVE_SPAWN_UNCONFIRMED"}));
            drop(out);
            let _ = stdout_thread.join();
            return Err("NATIVE_SPAWN_UNCONFIRMED");
        }
    };
    drop(pair.slave);
    let master = pair.master;
    let pid = child.process_id();
    let killer = match OwnedNativeKiller::from_child(child.as_ref()) {
        Ok(killer) => killer,
        Err(_) => {
            // No ready/success receipt: the native child already exists. Closing
            // only this owned pseudoconsole stops its attached processes; keep
            // draining while cleanup runs and bound every blocking step.
            shutdown.arm();
            out.send(json!({"v":1,"type":"runtime-error","code":"NATIVE_HANDLE_DUPLICATION_FAILED"}));
            drop(writer);
            drop(master);
            let _ = child.wait();
            let _ = reader_thread.join();
            drop(out);
            let _ = stdout_thread.join();
            return Err("NATIVE_HANDLE_DUPLICATION_FAILED");
        }
    };
    let native_events = events_tx.clone();
    let native_shutdown = shutdown.clone();
    let wait_thread = thread::spawn(move || {
        let result = child.wait().map_err(|_| ());
        native_shutdown.arm();
        let _ = native_events.send(Event::NativeExit(result));
    });

    let (write_tx, write_rx) = mpsc::sync_channel::<(String, String)>(8);
    let writer_out = out.clone();
    let writer_stopping = stopping.clone();
    let writer_thread = thread::spawn(move || {
        for (id, data) in write_rx {
            let ok = !writer_stopping.load(Ordering::Acquire)
                && writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_ok();
            writer_out.ack(id, ok, if ok { "OK" } else { "NATIVE_WRITE_FAILED" });
        }
        // Dropping this independent input FD cannot keep the master/HPCON alive.
    });
    out.send(json!({"v":1,"type":"ready","shellId":shell.id,"transport":"conpty","usePty":true,
        "pid":pid,"shell":shell.executable.to_string_lossy(),"args":shell.args,
        "implementation":"portable-pty-0.9.0","version":env!("CARGO_PKG_VERSION"),
        "debugAssertions":cfg!(debug_assertions)}));
    let mut kill_requested = false;
    let mut protocol_ok = true;
    let status = loop {
        if !stdout_ok.load(Ordering::Acquire) || !output_ok.load(Ordering::Acquire) {
            shutdown.arm();
            protocol_ok = false;
            stopping.store(true, Ordering::Release);
            if !kill_requested { kill_requested = killer.kill().is_ok(); }
        }
        match events_rx.recv() {
            Ok(Event::NativeExit(status)) => break status,
            Ok(Event::Request(Request::Write { request_id, data, .. })) => {
                if kill_requested || stopping.load(Ordering::Acquire) {
                    out.ack(request_id, false, "SESSION_STOPPING");
                } else {
                    match write_tx.try_send((request_id, data)) {
                        Ok(()) => {}
                        Err(TrySendError::Full((id, _))) => out.ack(id, false, "INPUT_BUSY"),
                        Err(TrySendError::Disconnected((id, _))) => out.ack(id, false, "INPUT_CLOSED"),
                    }
                }
            }
            Ok(Event::Request(Request::Resize { request_id, cols, rows, .. })) => {
                let ok = !kill_requested && !stopping.load(Ordering::Acquire)
                    && master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }).is_ok();
                out.ack(request_id, ok, if ok { "OK" } else { "NATIVE_RESIZE_FAILED" });
            }
            Ok(Event::Request(Request::Kill { request_id, .. })) => {
                shutdown.arm();
                let result = if kill_requested { Ok(()) } else { killer.kill() };
                let ok = result.is_ok();
                if ok { kill_requested = true; stopping.store(true, Ordering::Release); }
                out.send(json!({"v":1,"type":"ack","requestId":request_id,"ok":ok,
                    "code":if ok { "OK" } else { "NATIVE_KILL_FAILED" },
                    "nativeErrorCode":result.err().and_then(|error| error.raw_os_error())}));
            }
            Ok(Event::InputClosed) => {
                shutdown.arm();
                stopping.store(true, Ordering::Release);
                if !kill_requested { kill_requested = killer.kill().is_ok(); }
            }
            Ok(Event::InputError) | Ok(Event::OutputFailed) => {
                shutdown.arm();
                protocol_ok = false;
                stopping.store(true, Ordering::Release);
                out.send(json!({"v":1,"type":"runtime-error","code":"TERMINAL_CHANNEL_FAILED"}));
                if !kill_requested { kill_requested = killer.kill().is_ok(); }
            }
            Ok(Event::Request(Request::Init { .. })) => unreachable!(),
            Err(_) => { protocol_ok = false; break Err(()); }
        }
    };
    // Native wait is authoritative. EOF or a kill ACK never enters the success branch.
    shutdown.arm();
    stopping.store(true, Ordering::Release);
    drop(write_tx);
    // No stdout lock is held here. The independent reader drains the final frame
    // while portable-pty drops the pseudoconsole and terminates attached descendants.
    drop(master);
    let output_drained = reader_thread.join().unwrap_or(false);
    let writer_joined = writer_thread.join().is_ok();
    let waiter_joined = wait_thread.join().is_ok();
    drop(killer);
    let valid = protocol_ok && output_drained && writer_joined && waiter_joined
        && stdout_ok.load(Ordering::Acquire);
    if valid {
        if let Ok(status) = &status {
            out.send(json!({"v":1,"type":"native-exit","nativeWaitConfirmed":true,
                "exitCode":status.exit_code(),"signal":status.signal(),
                "exitSource":"conpty-rust.native-wait"}));
        } else {
            out.send(json!({"v":1,"type":"runtime-error","code":"NATIVE_WAIT_FAILED"}));
        }
    }
    let native_confirmed = valid && status.is_ok();
    drop(out);
    let flushed = stdout_thread.join().is_ok_and(|result| result.is_ok());
    if native_confirmed && flushed {
        shutdown.complete();
        Ok(())
    } else { Err("TERMINAL_EXIT_UNCONFIRMED") }
}

fn run_stdio() -> Result<(), &'static str> {
    let mut input = BufReader::new(io::stdin());
    let first = read_frame(&mut input).map_err(|_| {
        startup_error("FRAME_LIMIT_OR_IO", json!(false)); "FRAME_LIMIT_OR_IO"
    })?;
    let request = first.ok_or_else(|| {
        startup_error("MISSING_INITIALIZATION", json!(false)); "MISSING_INITIALIZATION"
    }).and_then(|frame| parse_request(&frame).map_err(|code| {
        startup_error(code, json!(false)); code
    }))?;
    let init = match request {
        Request::Init { shell_id, cwd, cols, rows, env, initialization, .. } =>
            Init { shell_id, cwd, cols, rows, env, initialization },
        _ => { startup_error("INIT_REQUIRED", json!(false)); return Err("INIT_REQUIRED"); }
    };
    #[cfg(windows)]
    { run_windows(init, input) }
    #[cfg(not(windows))]
    { let _ = (init, input); startup_error("WINDOWS_REQUIRED", json!(false)); Err("WINDOWS_REQUIRED") }
}

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("egdesk-terminal-worker {} portable-pty 0.9.0", env!("CARGO_PKG_VERSION"));
        return std::process::ExitCode::SUCCESS;
    }
    if args != ["--stdio-worker"] {
        eprintln!("Use --stdio-worker for the explicitly owned single-session JSON-line driver");
        return std::process::ExitCode::from(2);
    }
    match run_stdio() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(code) => { eprintln!("egdesk-terminal-worker: {code}"); std::process::ExitCode::from(1) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn initialization() -> Value {
        json!({"v":1,"type":"init","shellId":"powershell","cwd":"C:\\owned fixture",
            "cols":80,"rows":24,"env":{"SystemRoot":"C:\\Windows"}})
    }

    #[test]
    fn schema_accepts_only_typed_shell_and_bounded_dimensions() {
        assert!(matches!(parse_request(&serde_json::to_vec(&initialization()).unwrap()), Ok(Request::Init { .. })));
        for (field, value) in [
            ("shellId", json!("/bin/zsh")), ("cols", json!(0)), ("rows", json!(1001)),
            ("cwd", json!("relative")), ("v", json!(2)), ("args", json!(["-Command","unwanted"])),
        ] {
            let mut init = initialization();
            init[field] = value;
            assert!(parse_request(&serde_json::to_vec(&init).unwrap()).is_err(), "{field}");
        }
    }

    #[test]
    fn input_schema_preserves_control_text_but_rejects_oversized_utf8_and_invalid_ids() {
        let good = json!({"v":1,"type":"write","requestId":"request-1","data":"\u{3}한글\r"});
        assert!(parse_request(&serde_json::to_vec(&good).unwrap()).is_ok());
        let oversized = json!({"v":1,"type":"write","requestId":"request-1",
            "data":"한".repeat(MAX_WRITE_BYTES / 3 + 1)});
        assert_eq!(parse_request(&serde_json::to_vec(&oversized).unwrap()).unwrap_err(), "INVALID_INPUT");
        for id in ["", "request\ninjection", "bad id"] {
            assert!(parse_request(&serde_json::to_vec(&json!({"v":1,"type":"kill","requestId":id})).unwrap()).is_err());
        }
    }

    #[test]
    fn frame_limit_is_enforced_before_copying_an_unterminated_line() {
        let mut input = BufReader::with_capacity(31, Cursor::new(vec![b'x'; MAX_INPUT_LINE + 1]));
        let error = read_frame(&mut input).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let mut lines = Cursor::new(b"{\"v\":1}\r\nlast");
        assert_eq!(read_frame(&mut lines).unwrap().unwrap(), b"{\"v\":1}");
        assert_eq!(read_frame(&mut lines).unwrap().unwrap(), b"last");
        assert!(read_frame(&mut lines).unwrap().is_none());
    }

    #[test]
    fn utf8_carry_preserves_every_korean_and_emoji_split_without_replacement() {
        let expected = "한글😀끝";
        for split in 0..=expected.len() {
            let mut decoder = Utf8Carry::default();
            let mut actual = decoder.feed(&expected.as_bytes()[..split]).unwrap();
            actual.push_str(&decoder.feed(&expected.as_bytes()[split..]).unwrap());
            assert_eq!(actual, expected, "split={split}");
            assert!(decoder.finish().is_ok());
        }
        let mut decoder = Utf8Carry::default();
        let actual: String = expected.as_bytes().iter().map(|byte| decoder.feed(&[*byte]).unwrap()).collect();
        assert_eq!(actual, expected);
        assert!(decoder.finish().is_ok());
    }

    #[test]
    fn incomplete_and_invalid_utf8_are_errors_not_lossy_success() {
        let mut decoder = Utf8Carry::default();
        assert_eq!(decoder.feed(&[0xf0, 0x9f]).unwrap(), "");
        assert_eq!(decoder.finish(), Err("OUTPUT_UTF8_INCOMPLETE"));
        assert_eq!(Utf8Carry::default().feed(&[0xff]), Err("OUTPUT_UTF8"));
    }

    #[test]
    fn worst_case_control_output_stays_inside_the_encoded_frame_bound() {
        let mut bytes = Vec::new();
        write_packet(&mut bytes, &json!({"v":1,"type":"output","data":"\u{1b}".repeat(OUTPUT_READ_BYTES)})).unwrap();
        assert!(bytes.len() <= MAX_OUTPUT_LINE);
        assert_eq!(bytes.last(), Some(&b'\n'));
    }

    #[test]
    fn native_environment_rebuilds_legacy_module_path_without_security_policy_edits() {
        let mut env = BTreeMap::new();
        env.insert("PSModulePath".into(), "inherited modern modules".into());
        env.insert("psmodulepath".into(), "another casing".into());
        env.insert("PSExecutionPolicyPreference".into(), "Restricted".into());
        let init = Init { shell_id:"powershell".into(), cwd:"C:\\owned".into(), cols:80, rows:24,
            env, initialization:None };
        for (id, executable) in [("powershell", "powershell.exe"), ("cmd", "cmd.exe")] {
            let shell = Shell { id:id.into(), executable:executable.into(), args:vec![] };
            let clean = native_environment(&init, &shell);
            assert!(!clean.keys().any(|key| key.eq_ignore_ascii_case("PSModulePath")));
            assert_eq!(clean["PSExecutionPolicyPreference"], "Restricted");
        }
        let modern = native_environment(&init, &Shell { id:"powershell".into(), executable:"pwsh.exe".into(), args:vec![] });
        assert_eq!(modern["PSModulePath"], "inherited modern modules");
        assert_eq!(init.env["PSModulePath"], "inherited modern modules");
    }

    #[test]
    fn unexpected_eof_is_truncation_and_not_a_clean_pipe_close() {
        assert!(clean_pipe_eof(&io::Error::new(io::ErrorKind::BrokenPipe, "pipe ended")));
        assert!(!clean_pipe_eof(&io::Error::new(io::ErrorKind::UnexpectedEof, "truncated")));
        assert!(!clean_pipe_eof(&io::Error::new(io::ErrorKind::Other, "read failed")));
    }

    #[test]
    fn win32_bool_nonzero_is_success_and_zero_preserves_the_actual_error() {
        use std::cell::Cell;
        let calls = Cell::new(0);
        for success in [1, -1, 7] {
            assert!(windows_bool_result(success, || {
                calls.set(calls.get() + 1);
                io::Error::from_raw_os_error(5)
            }).is_ok());
        }
        assert_eq!(calls.get(), 0, "success must not read stale GetLastError");
        let error = windows_bool_result(0, || {
            calls.set(calls.get() + 1);
            io::Error::from_raw_os_error(5)
        }).unwrap_err();
        assert_eq!(calls.get(), 1);
        assert_eq!(error.raw_os_error(), Some(5));
    }

    #[test]
    fn shutdown_deadline_aborts_only_when_armed_and_not_completed_without_exiting_this_test() {
        use std::cell::Cell;
        let guard = ShutdownWatchdog::new();
        let calls = Cell::new(0);
        enforce_shutdown_deadline(&guard.armed, &guard.done, || calls.set(calls.get() + 1));
        assert_eq!(calls.get(), 0);
        guard.armed.store(true, Ordering::Release);
        enforce_shutdown_deadline(&guard.armed, &guard.done, || calls.set(calls.get() + 1));
        assert_eq!(calls.get(), 1);
        guard.complete();
        enforce_shutdown_deadline(&guard.armed, &guard.done, || calls.set(calls.get() + 1));
        assert_eq!(calls.get(), 1);
    }

}
