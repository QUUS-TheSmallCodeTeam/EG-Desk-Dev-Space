@echo off
setlocal enabledelayedexpansion

echo.
echo === EG-Desk firefox-ui-demo uninstaller ===
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 관리자 권한 필요.
  exit /b 1
)

set "FF_INSTALL="
if exist "C:\Program Files\Mozilla Firefox\firefox.exe" set "FF_INSTALL=C:\Program Files\Mozilla Firefox"
if exist "C:\Program Files (x86)\Mozilla Firefox\firefox.exe" set "FF_INSTALL=C:\Program Files (x86)\Mozilla Firefox"

if "!FF_INSTALL!"=="" (
  echo [ERROR] Firefox 인스톨 디렉터리 없음.
  exit /b 1
)

set "FF_PROFILES=%APPDATA%\Mozilla\Firefox\Profiles"
set "FF_PROFILE="
for /d %%D in ("!FF_PROFILES!\*.default-release") do set "FF_PROFILE=%%D"
if "!FF_PROFILE!"=="" for /d %%D in ("!FF_PROFILES!\*.default") do set "FF_PROFILE=%%D"

echo [step] Removing bootstrap from Firefox install dir ...
del /f /q "!FF_INSTALL!\config.js" 2>nul
del /f /q "!FF_INSTALL!\defaults\pref\config-prefs.js" 2>nul

if not "!FF_PROFILE!"=="" (
  echo [step] Removing chrome/ from profile: !FF_PROFILE!
  rmdir /s /q "!FF_PROFILE!\chrome\utils" 2>nul
  del /f /q "!FF_PROFILE!\chrome\JS\eg-desk-*.uc.js" 2>nul
  del /f /q "!FF_PROFILE!\chrome\CSS\eg-desk-*.uc.css" 2>nul
  del /f /q "!FF_PROFILE!\chrome\userChrome.css" 2>nul
)

echo.
echo === Uninstall complete ===
echo Firefox 를 재시작하면 기본 UI 로 돌아갑니다.
endlocal
