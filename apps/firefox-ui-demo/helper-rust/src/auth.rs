//! Shared-secret checks for helper-rust's local endpoints.
//!
//! - The WebSocket terminal (default mode) accepts a connection only when it
//!   presents the run's token, compared in constant time.
//! - host-observe accepts one Unix-socket client that presents the run's
//!   nonce, compared the same way (see host/server.rs).

use rand::RngCore;

/// Byte-wise equality whose running time depends only on the two lengths,
/// never on where the first differing byte is.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let len = a.len().max(b.len());
    let mut diff: usize = a.len() ^ b.len();
    for index in 0..len {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        diff |= usize::from(left ^ right);
    }
    std::hint::black_box(diff) == 0
}

/// 32 random bytes from the OS, hex encoded (64 characters).
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A token or nonce we are willing to compare against: 16..=256 characters of
/// URL/header-safe text, so it never needs escaping in a header or a line.
pub fn valid_secret(value: &str) -> bool {
    (16..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'+' | b'/' | b'='))
}

/// Which token the WebSocket terminal uses for this run.
#[derive(Debug, PartialEq, Eq)]
pub struct TerminalToken {
    pub value: String,
    /// true when neither the environment nor --token named one; the token is
    /// then reported once on the ready line for the parent that started us.
    pub generated: bool,
    /// true when it came from --token (visible to other local users in `ps`).
    pub from_argv: bool,
}

/// EGDESK_HELPER_TOKEN wins over --token; with neither, a fresh secret.
pub fn resolve_terminal_token(flag: &str, env: Option<&str>) -> Result<TerminalToken, String> {
    let env = env.filter(|value| !value.is_empty());
    let (value, from_argv) = match (env, flag.is_empty()) {
        (Some(value), _) => (value.to_string(), false),
        (None, false) => (flag.to_string(), true),
        (None, true) => {
            return Ok(TerminalToken { value: generate_secret(), generated: true, from_argv: false });
        }
    };
    if !valid_secret(&value) {
        return Err("the terminal token must be 16-256 characters of [A-Za-z0-9-_.~+/=]".to_string());
    }
    Ok(TerminalToken { value, generated: false, from_argv })
}

/// Subprotocol a browser offers alongside `egdesk.token.<token>`; the server
/// selects it so the token itself is never echoed back.
pub const WS_SUBPROTOCOL: &str = "egdesk.v1";
const WS_TOKEN_PREFIX: &str = "egdesk.token.";

#[derive(Debug, PartialEq, Eq)]
pub enum WsAuth {
    /// Accept; when Some, answer with this Sec-WebSocket-Protocol.
    Accepted { subprotocol: Option<&'static str> },
    Rejected,
}

/// The WebSocket handshake carries the token either as
/// `Authorization: Bearer <token>` (Node, native clients) or, for a browser
/// that cannot set headers, as the subprotocol list
/// `egdesk.v1, egdesk.token.<token>`.
pub fn authorize_ws(authorization: Option<&str>, protocols: Option<&str>, expected: &str) -> WsAuth {
    let expected = expected.as_bytes();
    if let Some(value) = authorization {
        let value = value.trim();
        // get(..7) is None when byte 7 is inside a multi-byte character.
        if value.len() > 7 && value.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer ")) {
            return if constant_time_eq(value[7..].trim().as_bytes(), expected) {
                WsAuth::Accepted { subprotocol: None }
            } else {
                WsAuth::Rejected
            };
        }
        return WsAuth::Rejected;
    }
    if let Some(list) = protocols {
        let offered: Vec<&str> = list.split(',').map(str::trim).collect();
        let offers_version = offered.contains(&WS_SUBPROTOCOL);
        let presented = offered.iter().find_map(|item| item.strip_prefix(WS_TOKEN_PREFIX));
        if let (true, Some(token)) = (offers_version, presented) {
            if constant_time_eq(token.as_bytes(), expected) {
                return WsAuth::Accepted { subprotocol: Some(WS_SUBPROTOCOL) };
            }
        }
    }
    WsAuth::Rejected
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn constant_time_eq_matches_plain_equality() {
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(TOKEN.as_bytes(), TOKEN.as_bytes()));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abcd", b"abc"));
        assert!(!constant_time_eq(b"", b"a"));
        // A shared prefix with trailing zero bytes is still different.
        assert!(!constant_time_eq(b"abc", b"abc\0"));
    }

    #[test]
    fn generated_secrets_are_valid_and_distinct() {
        let first = generate_secret();
        let second = generate_secret();
        assert_eq!(first.len(), 64);
        assert!(valid_secret(&first));
        assert_ne!(first, second);
    }

    #[test]
    fn token_source_order_is_env_then_flag_then_generated() {
        let from_env = resolve_terminal_token("flag-token-0123456789", Some(TOKEN)).unwrap();
        assert_eq!(from_env, TerminalToken { value: TOKEN.into(), generated: false, from_argv: false });
        let from_flag = resolve_terminal_token(TOKEN, None).unwrap();
        assert!(from_flag.from_argv && !from_flag.generated);
        let empty_env = resolve_terminal_token(TOKEN, Some("")).unwrap();
        assert!(empty_env.from_argv);
        let generated = resolve_terminal_token("", None).unwrap();
        assert!(generated.generated && valid_secret(&generated.value));
        assert!(resolve_terminal_token("short", None).is_err());
        assert!(resolve_terminal_token("has space in the token value", None).is_err());
    }

    #[test]
    fn bearer_header_must_match() {
        assert_eq!(authorize_ws(Some(&format!("Bearer {TOKEN}")), None, TOKEN), WsAuth::Accepted { subprotocol: None });
        assert_eq!(authorize_ws(Some(&format!("bearer   {TOKEN} ")), None, TOKEN), WsAuth::Accepted { subprotocol: None });
        assert_eq!(authorize_ws(Some("Bearer wrong-token-value-000000"), None, TOKEN), WsAuth::Rejected);
        assert_eq!(authorize_ws(Some(&format!("Basic {TOKEN}")), None, TOKEN), WsAuth::Rejected);
        // A wrong Authorization header is not rescued by a right subprotocol.
        let protocols = format!("{WS_SUBPROTOCOL}, egdesk.token.{TOKEN}");
        assert_eq!(authorize_ws(Some("Bearer nope-nope-nope-nope"), Some(&protocols), TOKEN), WsAuth::Rejected);
    }

    #[test]
    fn subprotocol_token_needs_the_version_protocol() {
        let good = format!("{WS_SUBPROTOCOL}, egdesk.token.{TOKEN}");
        assert_eq!(authorize_ws(None, Some(&good), TOKEN), WsAuth::Accepted { subprotocol: Some(WS_SUBPROTOCOL) });
        let no_version = format!("egdesk.token.{TOKEN}");
        assert_eq!(authorize_ws(None, Some(&no_version), TOKEN), WsAuth::Rejected);
        let wrong = format!("{WS_SUBPROTOCOL}, egdesk.token.{}", "f".repeat(32));
        assert_eq!(authorize_ws(None, Some(&wrong), TOKEN), WsAuth::Rejected);
        assert_eq!(authorize_ws(None, None, TOKEN), WsAuth::Rejected);
    }
}
