#!/usr/bin/env bash
set -euo pipefail

echo
echo "=== EG-Desk firefox-ui-demo uninstaller ==="
echo

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERROR] sudo ./uninstall.sh"
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    FF_INSTALL="/Applications/Firefox.app/Contents/Resources"
    FF_PROFILES_ROOT="$HOME/Library/Application Support/Firefox/Profiles"
    ;;
  Linux)
    for cand in /usr/lib/firefox /opt/firefox /usr/lib64/firefox; do
      [[ -d "$cand" ]] && FF_INSTALL="$cand" && break
    done
    FF_PROFILES_ROOT="${SUDO_USER:+/home/$SUDO_USER}/.mozilla/firefox"
    [[ -z "$FF_PROFILES_ROOT" ]] && FF_PROFILES_ROOT="$HOME/.mozilla/firefox"
    ;;
  *)
    echo "[ERROR] Unsupported OS"
    exit 1
    ;;
esac

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
