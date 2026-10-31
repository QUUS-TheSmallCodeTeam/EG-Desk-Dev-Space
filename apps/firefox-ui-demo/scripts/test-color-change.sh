#!/bin/bash
# EGDesk 개발 루틴 테스트: canvas 배경색 변경 → Firefox 재시작 → 스크린샷

PROFILE_LEAF="egtc3irr.egdesk.default-release"
PROFILE="$HOME/Library/Application Support/Firefox/Profiles/$PROFILE_LEAF"
OVERLAY="$PROFILE/chrome/JS/eg-desk-surface.uc.js"
FIREFOX="$HOME/Applications/Firefox.app/Contents/MacOS/firefox"
STARTUP_CACHE="$PROFILE/startupCache"
# 이 프로필의 컴파일된 모듈 캐시는 프로필이 아니라 로컬 Caches 폴더에 있다.
LOCAL_PROFILE="$HOME/Library/Caches/Firefox/Profiles/$PROFILE_LEAF"

echo "[1] 색상 변경: #F5F3EF → #E8F4FD (연한 파란색)"
sed -i '' "s/#F5F3EF/#E8F4FD/g" "$OVERLAY"
grep -n "#E8F4FD" "$OVERLAY" | head -5

echo "[2] Firefox 종료"
pkill -x firefox 2>/dev/null || true
sleep 1

echo "[3] Startup cache 클리어"
rm -rf "$STARTUP_CACHE"
if [[ -d "$LOCAL_PROFILE" && ! -L "$LOCAL_PROFILE" ]]; then
  rm -rf "$LOCAL_PROFILE/startupCache"
fi

echo "[4] Firefox 재시작 (EGDesk 프로필)"
"$FIREFOX" -profile "$PROFILE" --no-remote &
sleep 5

echo "[5] 스크린샷 캡처"
screencapture -t png /tmp/egdesk_after_change.png
cp /tmp/egdesk_after_change.png "$HOME/Projects/EG-Desk-Dev-Space/egdesk_after_change.png"
echo "완료: egdesk_after_change.png"
