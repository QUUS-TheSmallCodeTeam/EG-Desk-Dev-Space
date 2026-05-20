#!/bin/bash
PROFILE="$HOME/Library/Application Support/Firefox/Profiles/egtc3irr.egdesk.default-release"

cat > "$PROFILE/user.js" << 'PREFS'
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.remote-port", 6000);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-host", "127.0.0.1");
user_pref("marionette.enabled", true);
user_pref("marionette.port", 2828);
PREFS

echo "user.js 작성 완료:"
cat "$PROFILE/user.js"
