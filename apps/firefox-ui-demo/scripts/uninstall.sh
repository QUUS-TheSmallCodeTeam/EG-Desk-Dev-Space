#!/usr/bin/env bash
set -euo pipefail

echo
echo "=== EG-Desk firefox-ui-demo uninstaller ==="
echo

CURRENT_OS="$(uname -s)"
TARGET_USER="${SUDO_USER:-$(id -un)}"

resolve_home_dir() {
  local user="$1"
  case "$CURRENT_OS" in
    Darwin)
      dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | awk '{print $2}'
      ;;
    Linux)
      if command -v getent >/dev/null 2>&1; then
        getent passwd "$user" | cut -d: -f6
      else
        local expanded
        expanded="$(eval echo "~$user")"
        if [[ "$expanded" == "~$user" ]]; then
          return 1
        fi
        echo "$expanded"
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

TARGET_HOME="$(resolve_home_dir "$TARGET_USER")"
if [[ -z "$TARGET_HOME" ]] || [[ ! -d "$TARGET_HOME" ]]; then
  echo "[ERROR] 사용자 홈 디렉터리를 확인할 수 없습니다: $TARGET_USER"
  exit 1
fi

case "$CURRENT_OS" in
  Darwin)
    if [[ -d "/Applications/Firefox.app/Contents/Resources" ]]; then
      FF_INSTALL="/Applications/Firefox.app/Contents/Resources"
    elif [[ -d "$TARGET_HOME/Applications/Firefox.app/Contents/Resources" ]]; then
      FF_INSTALL="$TARGET_HOME/Applications/Firefox.app/Contents/Resources"
    fi
    FF_PROFILES_ROOT="$TARGET_HOME/Library/Application Support/Firefox/Profiles"
    ;;
  Linux)
    for cand in /usr/lib/firefox /opt/firefox /usr/lib64/firefox; do
      [[ -d "$cand" ]] && FF_INSTALL="$cand" && break
    done
    FF_PROFILES_ROOT="$TARGET_HOME/.mozilla/firefox"
    ;;
  *)
    echo "[ERROR] Unsupported OS"
    exit 1
    ;;
esac

if [[ -z "${FF_INSTALL:-}" ]] || [[ ! -d "$FF_INSTALL" ]]; then
  echo "[ERROR] Firefox 인스톨 디렉터리를 찾을 수 없습니다."
  exit 1
fi

if [[ ! -w "$FF_INSTALL" ]] && [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERROR] sudo ./uninstall.sh"
  exit 1
fi

FF_PROFILE=""
for d in "$FF_PROFILES_ROOT"/*.default-release "$FF_PROFILES_ROOT"/*.default; do
  [[ -d "$d" ]] && FF_PROFILE="$d" && break
done

echo "[step] Removing bootstrap ..."
rm -f "$FF_INSTALL/config.js"
rm -f "$FF_INSTALL/defaults/pref/config-prefs.js"

if [[ -n "$FF_PROFILE" ]]; then
  echo "[step] Removing chrome/ overlays from: $FF_PROFILE"
  rm -rf "$FF_PROFILE/chrome/utils"
  rm -f "$FF_PROFILE/chrome/JS/eg-desk-"*.uc.js
  rm -f "$FF_PROFILE/chrome/CSS/eg-desk-"*.uc.css
  rm -f "$FF_PROFILE/chrome/userChrome.css"
fi

echo
echo "=== Uninstall complete ==="
