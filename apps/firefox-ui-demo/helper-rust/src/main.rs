use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{header, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;

mod auth;
mod host;

// ─── CLI Args ───────────────────────────────────────────────────────────────

/// Without a subcommand: the WebSocket PTY terminal (JSON-RPC over
/// ws://127.0.0.1:<port>). `host-observe`: the macOS host observer.
#[derive(Parser, Debug)]
#[command(name = "egdesk-helper")]
struct Args {
    /// Port to bind (0 = OS assigns free port)
    #[arg(long, default_value = "0")]
    port: u16,

    /// Auth token for WebSocket connections. Prefer EGDESK_HELPER_TOKEN: a
    /// command-line value is visible to other local users in `ps`. With
    /// neither, a random token is generated and reported on the ready line.
    #[arg(long, default_value = "")]
    token: String,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// macOS host observer: front app, running apps, windows, permission
    /// preview, Codex computer-use service. Observation only, no OS input.
    HostObserve(host::HostObserveArgs),
}

// ─── JSON-RPC Types ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<serde_json::Value>,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize)]
struct JsonRpcNotification {
    jsonrpc: String,
    method: String,
    params: serde_json::Value,
}

// ─── PTY Session ────────────────────────────────────────────────────────────

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

type Sessions = Arc<RwLock<HashMap<String, Arc<Mutex<PtySession>>>>>;
type ClientTx = mpsc::UnboundedSender<String>;

// ─── Main ───────────────────────────────────────────────────────────────────

fn main() {
    let args = Args::parse();
    match args.command {
        Some(Command::HostObserve(options)) => std::process::exit(host::run_observe(options)),
        None => {
            let env_token = std::env::var("EGDESK_HELPER_TOKEN").ok();
            std::env::remove_var("EGDESK_HELPER_TOKEN"); // not inherited by PTY children
            let token = match auth::resolve_terminal_token(&args.token, env_token.as_deref()) {
                Ok(token) => token,
                Err(message) => {
                    eprintln!("egdesk-helper: {message}");
                    std::process::exit(2);
                }
            };
            if token.from_argv {
                eprintln!("egdesk-helper: warning: --token is visible to other local users; prefer EGDESK_HELPER_TOKEN");
            }
            let runtime = tokio::runtime::Runtime::new().expect("Failed to start the async runtime");
            runtime.block_on(run_ws_terminal(args.port, token));
        }
    }
}

/// Handshake check: the connection must present this run's token (see
/// auth::authorize_ws); otherwise it is refused with 401 before any JSON-RPC.
/// The Err type is tungstenite's handshake callback contract.
#[allow(clippy::result_large_err)]
fn authorize_handshake(request: &Request, response: Response, expected: &str) -> Result<Response, ErrorResponse> {
    let header_text = |name: header::HeaderName| request.headers().get(name).and_then(|value| value.to_str().ok());
    match auth::authorize_ws(header_text(header::AUTHORIZATION), header_text(header::SEC_WEBSOCKET_PROTOCOL), expected) {
        auth::WsAuth::Accepted { subprotocol } => {
            let mut response = response;
            if let Some(protocol) = subprotocol {
                response.headers_mut().insert(header::SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static(protocol));
            }
            Ok(response)
        }
        auth::WsAuth::Rejected => {
            let mut refusal = ErrorResponse::new(Some("unauthorized".to_string()));
            *refusal.status_mut() = StatusCode::UNAUTHORIZED;
            Err(refusal)
        }
    }
}

async fn run_ws_terminal(port: u16, token: auth::TerminalToken) {
    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr).await.expect("Failed to bind");
    let local_addr = listener.local_addr().unwrap();

    // Print ready message for chrome JS to parse (stdout). A generated token
    // is reported here once, to the parent that reads our stdout.
    let mut ready = serde_json::json!({
        "port": local_addr.port(),
        "ready": true,
        "auth": "bearer-or-subprotocol",
    });
    if token.generated {
        ready["token"] = serde_json::Value::String(token.value.clone());
    }
    println!("{}", ready);

    let sessions: Sessions = Arc::new(RwLock::new(HashMap::new()));
    let expected: Arc<str> = Arc::from(token.value.as_str());

    loop {
        let (stream, _) = match listener.accept().await {
            Ok(conn) => conn,
            Err(_) => continue,
        };
        let sessions = sessions.clone();
        let expected = Arc::clone(&expected);

        tokio::spawn(async move {
            let check = move |request: &Request, response: Response| authorize_handshake(request, response, &expected);
            let ws_stream = match accept_hdr_async(stream, check).await {
                Ok(ws) => ws,
                Err(e) => {
                    eprintln!("WebSocket handshake failed: {}", e);
                    return;
                }
            };

            let (mut ws_sender, mut ws_receiver) = ws_stream.split();

            // Channel for sending messages back to this client
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();

            // Spawn task to forward channel messages to WebSocket
            let send_task = tokio::spawn(async move {
                while let Some(msg) = rx.recv().await {
                    if ws_sender.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
            });

            // Process incoming messages
            while let Some(msg) = ws_receiver.next().await {
                let msg = match msg {
                    Ok(Message::Text(t)) => t,
                    Ok(Message::Close(_)) => break,
                    Err(_) => break,
                    _ => continue,
                };

                let request: JsonRpcRequest = match serde_json::from_str(&msg) {
                    Ok(r) => r,
                    Err(e) => {
                        let err_resp = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": null,
                            "error": { "code": -32700, "message": format!("Parse error: {}", e) }
                        });
                        let _ = tx.send(err_resp.to_string());
                        continue;
                    }
                };

                handle_request(request, &sessions, &tx).await;
            }

            send_task.abort();
        });
    }
}

// ─── Request Handler ────────────────────────────────────────────────────────

async fn handle_request(req: JsonRpcRequest, sessions: &Sessions, tx: &ClientTx) {
    let id = req.id.clone().unwrap_or(serde_json::Value::Null);

    match req.method.as_str() {
        "pty.spawn" => handle_pty_spawn(id, req.params, sessions, tx).await,
        "pty.write" => handle_pty_write(id, req.params, sessions, tx).await,
        "pty.resize" => handle_pty_resize(id, req.params, sessions, tx).await,
        "pty.kill" => handle_pty_kill(id, req.params, sessions, tx).await,
        _ => {
            send_error(tx, id, -32601, "Method not found");
        }
    }
}

async fn handle_pty_spawn(
    id: serde_json::Value,
    params: serde_json::Value,
    sessions: &Sessions,
    tx: &ClientTx,
) {
    let shell = params
        .get("shell")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| {
            if cfg!(target_os = "windows") {
                "cmd.exe"
            } else {
                "/bin/zsh"
            }
        })
        .to_string();

    let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
    let cwd = params
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(e) => {
            send_error(tx, id, -32000, &format!("Failed to open PTY: {}", e));
            return;
        }
    };

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("LC_ALL", "en_US.UTF-8");
    cmd.env("TERM", "xterm-256color");
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            send_error(tx, id, -32000, &format!("Failed to spawn: {}", e));
            return;
        }
    };

    let writer = pair.master.take_writer().unwrap();
    let mut reader = pair.master.try_clone_reader().unwrap();

    let pty_id = format!("pty-{}", &uuid::Uuid::new_v4().to_string().replace('-', "")[..12]);

    let session = Arc::new(Mutex::new(PtySession {
        writer,
        master: pair.master,
        child,
    }));

    sessions.write().await.insert(pty_id.clone(), session);

    // Spawn output reader task (blocking I/O in dedicated thread)
    let tx_clone = tx.clone();
    let pty_id_clone = pty_id.clone();
    let sessions_clone = sessions.clone();

    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        let mut incomplete = Vec::<u8>::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // PTY closed - send exit event
                    let notification = JsonRpcNotification {
                        jsonrpc: "2.0".to_string(),
                        method: "pty.exit".to_string(),
                        params: serde_json::json!({
                            "ptyId": pty_id_clone,
                            "code": 0
                        }),
                    };
                    let _ = tx_clone.send(serde_json::to_string(&notification).unwrap());
                    // Clean up session
                    let sessions = sessions_clone.clone();
                    let pty_id = pty_id_clone.clone();
                    let _ = tokio::runtime::Handle::current().block_on(async {
                        sessions.write().await.remove(&pty_id);
                    });
                    break;
                }
                Ok(n) => {
                    // Prepend any incomplete bytes from previous read
                    let chunk = if incomplete.is_empty() {
                        buf[..n].to_vec()
                    } else {
                        let mut combined = std::mem::take(&mut incomplete);
                        combined.extend_from_slice(&buf[..n]);
                        combined
                    };

                    // Find the longest valid UTF-8 prefix
                    let valid_up_to = match std::str::from_utf8(&chunk) {
                        Ok(_) => chunk.len(),
                        Err(e) => e.valid_up_to(),
                    };

                    // Save incomplete trailing bytes for next iteration
                    if valid_up_to < chunk.len() {
                        incomplete.extend_from_slice(&chunk[valid_up_to..]);
                    }

                    // Send the valid UTF-8 portion
                    if valid_up_to > 0 {
                        let data = unsafe { std::str::from_utf8_unchecked(&chunk[..valid_up_to]) }.to_string();
                        let notification = JsonRpcNotification {
                            jsonrpc: "2.0".to_string(),
                            method: "pty.output".to_string(),
                            params: serde_json::json!({
                                "ptyId": pty_id_clone,
                                "data": data
                            }),
                        };
                        if tx_clone.send(serde_json::to_string(&notification).unwrap()).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Send success response
    let response = JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: Some(serde_json::json!({ "ptyId": pty_id })),
        error: None,
    };
    let _ = tx.send(serde_json::to_string(&response).unwrap());
}

async fn handle_pty_write(
    id: serde_json::Value,
    params: serde_json::Value,
    sessions: &Sessions,
    tx: &ClientTx,
) {
    let pty_id = match params.get("ptyId").and_then(|v| v.as_str()) {
        Some(id_str) => id_str.to_string(),
        None => {
            send_error(tx, id, -32602, "Missing ptyId");
            return;
        }
    };

    let data = match params.get("data").and_then(|v| v.as_str()) {
        Some(d) => d.to_string(),
        None => {
            send_error(tx, id, -32602, "Missing data");
            return;
        }
    };

    let sessions_read = sessions.read().await;
    let session = match sessions_read.get(&pty_id) {
        Some(s) => s.clone(),
        None => {
            send_error(tx, id, -32000, "Session not found");
            return;
        }
    };
    drop(sessions_read);

    let mut session_lock = session.lock().await;
    match session_lock.writer.write_all(data.as_bytes()) {
        Ok(_) => {
            let _ = session_lock.writer.flush();
            let response = JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(serde_json::json!(null)),
                error: None,
            };
            let _ = tx.send(serde_json::to_string(&response).unwrap());
        }
        Err(e) => {
            send_error(tx, id, -32000, &format!("Write failed: {}", e));
        }
    }
}

async fn handle_pty_resize(
    id: serde_json::Value,
    params: serde_json::Value,
    sessions: &Sessions,
    tx: &ClientTx,
) {
    let pty_id = match params.get("ptyId").and_then(|v| v.as_str()) {
        Some(id_str) => id_str.to_string(),
        None => {
            send_error(tx, id, -32602, "Missing ptyId");
            return;
        }
    };

    let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
    let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;

    let sessions_read = sessions.read().await;
    let session = match sessions_read.get(&pty_id) {
        Some(s) => s.clone(),
        None => {
            send_error(tx, id, -32000, "Session not found");
            return;
        }
    };
    drop(sessions_read);

    let session_lock = session.lock().await;
    match session_lock.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(_) => {
            let response = JsonRpcResponse {
                jsonrpc: "2.0".to_string(),
                id,
                result: Some(serde_json::json!(null)),
                error: None,
            };
            let _ = tx.send(serde_json::to_string(&response).unwrap());
        }
        Err(e) => {
            send_error(tx, id, -32000, &format!("Resize failed: {}", e));
        }
    }
}

async fn handle_pty_kill(
    id: serde_json::Value,
    params: serde_json::Value,
    sessions: &Sessions,
    tx: &ClientTx,
) {
    let pty_id = match params.get("ptyId").and_then(|v| v.as_str()) {
        Some(id_str) => id_str.to_string(),
        None => {
            send_error(tx, id, -32602, "Missing ptyId");
            return;
        }
    };

    let removed = sessions.write().await.remove(&pty_id);
    if removed.is_some() {
        let response = JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(serde_json::json!(null)),
            error: None,
        };
        let _ = tx.send(serde_json::to_string(&response).unwrap());
    } else {
        send_error(tx, id, -32000, "Session not found");
    }
}

fn send_error(tx: &ClientTx, id: serde_json::Value, code: i32, message: &str) {
    let response = JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_string(),
        }),
    };
    let _ = tx.send(serde_json::to_string(&response).unwrap());
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[allow(clippy::result_large_err)]
    fn handshake(headers: &[(&str, &str)]) -> Result<Response, ErrorResponse> {
        let mut builder = Request::builder().uri("ws://127.0.0.1:1/");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        authorize_handshake(&builder.body(()).unwrap(), Response::new(()), TOKEN)
    }

    #[test]
    fn websocket_without_the_token_is_refused_with_401() {
        assert_eq!(handshake(&[]).unwrap_err().status(), StatusCode::UNAUTHORIZED);
        let wrong = handshake(&[("Authorization", "Bearer ffffffffffffffffffffffffffffffff")]);
        assert_eq!(wrong.unwrap_err().status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn websocket_with_the_token_is_accepted() {
        let bearer = handshake(&[("Authorization", &format!("Bearer {TOKEN}"))]).unwrap();
        assert!(bearer.headers().get(header::SEC_WEBSOCKET_PROTOCOL).is_none());
        let browser = handshake(&[("Sec-WebSocket-Protocol", &format!("egdesk.v1, egdesk.token.{TOKEN}"))]).unwrap();
        assert_eq!(browser.headers().get(header::SEC_WEBSOCKET_PROTOCOL).unwrap(), "egdesk.v1");
    }
}
