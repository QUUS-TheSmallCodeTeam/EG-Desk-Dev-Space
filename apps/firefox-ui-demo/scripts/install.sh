#!/usr/bin/env bash
# ==============================================================
#  EG-Desk firefox-ui-demo - macOS/Linux installer
# ==============================================================
set -euo pipefail

echo
echo "=== EG-Desk firefox-ui-demo installer ==="
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OVERLAY_DIR="$REPO_ROOT/overlay"
TMP_CLONE="$(mktemp -d -t egdesk-fx-autoconfig.XXXXXX)"
CURRENT_OS="$(uname -s)"
TARGET_USER="${SUDO_USER:-$(id -un)}"

cleanup() {
  rm -rf "$TMP_CLONE"
}

trap cleanup EXIT

# -------- fx-autoconfig 고정 (RT-01·02) --------
# 설치할 때마다 다른 로더가 깔리지 않도록 커밋 하나를 받고, 복사할 파일 8개를
# SHA-256으로 확인한다. 하나라도 다르면 Firefox 폴더를 건드리기 전에 멈춘다.
# 값을 바꿀 때는 install.bat 과 scripts/verify-clean-profile-boot.mjs 의
# FX_AUTOCONFIG_PIN 도 함께 바꾼다(verify-clean-profile-boot.test.mjs 가 세 곳을 대조한다).
# EGDESK_FX_AUTOCONFIG_URL 로 받을 곳(사내 mirror 등)만 바꿀 수 있고, 커밋·해시 확인은 그대로다.
FXAC_URL="${EGDESK_FX_AUTOCONFIG_URL:-https://github.com/MrOtherGuy/fx-autoconfig.git}"
FXAC_COMMIT="dfdab5684faffc112b76ccb1d8cab7f75da0102c" # 2026-07-23, MPL-2.0
FXAC_SHA256="
program/config.js 80dc421264a3ea04275e1724b7b57234f89254e9582a6c17e9a911b65c3aa6d7
program/defaults/pref/config-prefs.js 6bfd2ed139d18ff5178e0fc62a3b4058540ddbeba3adc912c0d69edb70c17ece
profile/chrome/utils/boot.sys.mjs 1f0b37d765c7b10b963a465a62a420059e334a18b6b48bd8c09059837e676106
profile/chrome/utils/chrome.manifest d80557b7bdd46f91f0d249f25f1bf66ed83f8c9e620cd0c9334029e4826924d0
profile/chrome/utils/fs.sys.mjs 1d6302c5484dc914e43685740937f1d89908099f835e53f532338822c31b08af
profile/chrome/utils/module_loader.mjs e7fca8757159751df080e5cbfcd27b508d98c5cdfd6434ea14247832418d1f63
profile/chrome/utils/uc_api.sys.mjs dc7547aecbaac67da94b54e353f8e306a0ca01b2a461e106cc88c63a2e210cac
profile/chrome/utils/utils.sys.mjs 3fb7c9799864ee01428722939f324acea1e6065cb63a9298e7bbc59e5adbd96a
"
FXAC_UTILS="boot.sys.mjs chrome.manifest fs.sys.mjs module_loader.mjs uc_api.sys.mjs utils.sys.mjs"

usage() {
  cat <<'USAGE'
사용법:
  sudo ./install.sh                 EG-Desk overlay 와 고정된 fx-autoconfig 로더를 설치
  ./install.sh --check-loader       로더만 받아 커밋·SHA-256을 확인하고 끝냄 (Firefox·프로필은 건드리지 않음)
USAGE
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# 지정 커밋만 얕게 받는다. 서버가 커밋 지정 받기를 거절하면 전체 기록을 받은 뒤 그 커밋으로 간다.
# core.autocrlf=false 로 받아 저장소의 바이트 그대로 둔다(해시 비교가 OS 설정에 흔들리지 않게).
fetch_pinned_loader() {
  local dest="$1" actual
  command -v git >/dev/null 2>&1 || { echo "[ERROR] git 이 PATH 에 없습니다."; return 1; }
  git -c init.defaultBranch=main init -q "$dest" || { echo "[ERROR] 임시 저장소를 만들 수 없습니다: $dest"; return 1; }
  git -C "$dest" config core.autocrlf false
  git -C "$dest" remote add origin "$FXAC_URL"
  echo "[step] Fetching MrOtherGuy/fx-autoconfig at ${FXAC_COMMIT:0:7} ..."
  if ! GIT_TERMINAL_PROMPT=0 git -C "$dest" fetch -q --depth=1 origin "$FXAC_COMMIT" >/dev/null 2>&1; then
    echo "[info] 커밋 지정 받기를 쓸 수 없어 전체 기록을 받습니다 ..."
    GIT_TERMINAL_PROMPT=0 git -C "$dest" fetch -q origin >/dev/null 2>&1 \
      || { echo "[ERROR] fx-autoconfig 를 받지 못했습니다 (네트워크 또는 $FXAC_URL 확인)."; return 1; }
  fi
  git -C "$dest" -c advice.detachedHead=false checkout -q "$FXAC_COMMIT" >/dev/null 2>&1 \
    || { echo "[ERROR] 고정 커밋 $FXAC_COMMIT 을 찾을 수 없습니다."; return 1; }
  actual="$(git -C "$dest" rev-parse HEAD)"
  if [[ "$actual" != "$FXAC_COMMIT" ]]; then
    echo "[ERROR] fx-autoconfig 커밋이 고정값과 다릅니다: $actual (기대값 $FXAC_COMMIT)"
    return 1
  fi
}

verify_pinned_loader() {
  local dir="$1" rel expected actual listing
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    echo "[ERROR] SHA-256 도구(sha256sum 또는 shasum)가 없어 로더를 확인할 수 없습니다."
    return 1
  fi
  while read -r rel expected; do
    [[ -n "$rel" ]] || continue
    if [[ ! -f "$dir/$rel" ]] || [[ -L "$dir/$rel" ]]; then
      echo "[ERROR] 고정 로더 파일이 없습니다: $rel"
      return 1
    fi
    actual="$(sha256_of "$dir/$rel")"
    if [[ "$actual" != "$expected" ]]; then
      echo "[ERROR] 로더 파일 SHA-256 이 고정값과 다릅니다: $rel"
      echo "        받은 값 $actual"
      echo "        고정값 $expected"
      return 1
    fi
  done <<EOF
$FXAC_SHA256
EOF
  # profile/chrome 에 통째로 복사하는 utils 폴더에는 확인한 6개 파일만 있어야 한다.
  listing="$(ls -A "$dir/profile/chrome/utils" | LC_ALL=C sort | tr '\n' ' ')"
  if [[ "$listing" != "$FXAC_UTILS " ]]; then
    echo "[ERROR] 로더 utils 폴더 구성이 고정값과 다릅니다: $listing"
    return 1
  fi
  echo "[info] fx-autoconfig ${FXAC_COMMIT:0:7} (2026-07-23) 확인: 파일 8개 SHA-256 일치"
}

case "${1:-}" in
  "") ;;
  --check-loader)
    fetch_pinned_loader "$TMP_CLONE"
    verify_pinned_loader "$TMP_CLONE"
    echo "[ok] 로더 확인만 했습니다. Firefox 설치 폴더와 프로필은 바꾸지 않았습니다."
    exit 0
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "[ERROR] 알 수 없는 옵션: $1"
    usage
    exit 2
    ;;
esac

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

# -------- Firefox 인스톨 디렉터리 탐지 --------
FF_INSTALL=""
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
    if [[ -d "/usr/lib/firefox" ]]; then
      FF_INSTALL="/usr/lib/firefox"
    elif [[ -d "/opt/firefox" ]]; then
      FF_INSTALL="/opt/firefox"
    elif [[ -d "/usr/lib64/firefox" ]]; then
      FF_INSTALL="/usr/lib64/firefox"
    fi
    FF_PROFILES_ROOT="$TARGET_HOME/.mozilla/firefox"
    ;;
  *)
    echo "[ERROR] Unsupported OS: $CURRENT_OS"
    exit 1
    ;;
esac

if [[ -z "$FF_INSTALL" ]] || [[ ! -d "$FF_INSTALL" ]]; then
  echo "[ERROR] Firefox 인스톨 디렉터리를 찾을 수 없습니다."
  echo "        macOS: /Applications/Firefox.app/Contents/Resources"
  echo "               $TARGET_HOME/Applications/Firefox.app/Contents/Resources"
  echo "        Linux: /usr/lib/firefox, /opt/firefox, /usr/lib64/firefox"
  exit 1
fi
echo "[info] Firefox install: $FF_INSTALL"
echo "[info] Target user: $TARGET_USER"

# -------- 프로필 탐지 --------
if [[ ! -d "$FF_PROFILES_ROOT" ]]; then
  echo "[ERROR] Firefox 프로필 루트 없음: $FF_PROFILES_ROOT"
  echo "        Firefox 를 한 번 이상 실행해 프로필 생성."
  exit 1
fi

FF_PROFILE=""
for d in "$FF_PROFILES_ROOT"/*.default-release "$FF_PROFILES_ROOT"/*.default; do
  if [[ -d "$d" ]]; then
    FF_PROFILE="$d"
    break
  fi
done

if [[ -z "$FF_PROFILE" ]]; then
  echo "[ERROR] default-release / default 프로필 없음."
  exit 1
fi
echo "[info] Firefox profile: $FF_PROFILE"

# -------- git 확인 --------
command -v git >/dev/null 2>&1 || {
  echo "[ERROR] git 이 PATH 에 없습니다."
  exit 1
}

# -------- 권한 체크 (시스템 Firefox 인스톨일 때만 sudo 필요) --------
if [[ ! -w "$FF_INSTALL" ]] && [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERROR] Firefox 인스톨 디렉터리에 쓰기 권한이 없습니다: $FF_INSTALL"
  echo "        sudo ./install.sh"
  exit 1
fi

# -------- fx-autoconfig 받기 (고정 커밋 + SHA-256 확인) --------
# 확인에 실패하면 아래 복사 단계 전에 멈춘다.
fetch_pinned_loader "$TMP_CLONE"
verify_pinned_loader "$TMP_CLONE"

# -------- bootstrap → 인스톨 디렉터리 --------
echo "[step] Installing bootstrap into Firefox install dir ..."
cp "$TMP_CLONE/program/config.js" "$FF_INSTALL/"
mkdir -p "$FF_INSTALL/defaults/pref"
cp "$TMP_CLONE/program/defaults/pref/config-prefs.js" "$FF_INSTALL/defaults/pref/"

# -------- loader + overlay → 프로필 chrome/ --------
echo "[step] Installing loader into profile/chrome ..."
mkdir -p "$FF_PROFILE/chrome/JS" "$FF_PROFILE/chrome/CSS" "$FF_PROFILE/chrome/resources"
cp -R "$TMP_CLONE/profile/chrome/utils" "$FF_PROFILE/chrome/"

echo "[step] Copying EG-Desk overlay ..."
cp "$OVERLAY_DIR"/JS/*.uc.js "$FF_PROFILE/chrome/JS/"
cp "$OVERLAY_DIR"/CSS/*.uc.css "$FF_PROFILE/chrome/CSS/"
cp -R "$OVERLAY_DIR"/resources/. "$FF_PROFILE/chrome/resources/"

# -------- userChrome.css (CSS import) --------
USERCHROME="$FF_PROFILE/chrome/userChrome.css"
{
  echo "/* Auto-generated by EG-Desk installer */"
  for f in "$FF_PROFILE"/chrome/CSS/*.uc.css; do
    name="$(basename "$f")"
    echo "@import url(\"CSS/$name\");"
  done
} > "$USERCHROME"

# -------- 소유권 복구 (root 가 만든 파일을 user 프로필로) --------
chown -R "$TARGET_USER" "$FF_PROFILE/chrome" 2>/dev/null || true

cat <<EOF

=== Install complete ===

설치한 로더: fx-autoconfig ${FXAC_COMMIT:0:7} (2026-07-23 고정, SHA-256 확인)

Firefox 를 완전히 종료하고 다시 실행한 뒤:
  1) about:config 에서 toolkit.legacyUserProfileCustomizations.stylesheets = true
  2) about:support 에서 "Clear startup cache..." 버튼 클릭
  3) Firefox 재시작

화면 상단에 분홍색 EG-DESK UI ACTIVE 배너 + 좌측 사이드바가 보이면 성공.

제거: sudo ./uninstall.sh
EOF
