@echo off
REM EG-DESK External References Setup Script for Windows

echo 🚀 Setting up EG-DESK external references...

cd ideas&external_references

REM Function-like approach using labels
call :clone_or_update "https://github.com/eclipse-theia/theia.git" "theia" "Theia Framework"
call :clone_or_update "https://github.com/microsoft/playwright.git" "playwright" "Playwright Testing"
call :clone_or_update "https://github.com/puppeteer/puppeteer.git" "puppeteer" "Puppeteer Automation"
call :clone_or_update "https://github.com/google-gemini/gemini-cli.git" "gemini-cli" "Google Gemini CLI"

REM Clone infinite-canvas into subfolder
if exist "infinite-canvas\infinite-canvas-master" (
    echo 📦 Updating infinite-canvas...
    cd infinite-canvas\infinite-canvas-master
    git pull --depth 1
    cd ..\..
) else (
    echo 📥 Cloning infinite-canvas ^(shallow^)...
    mkdir infinite-canvas
    cd infinite-canvas
    git clone --depth 1 https://github.com/emilefokkema/infinite-canvas.git infinite-canvas-master
    cd ..
)

cd ..

echo ✅ External references setup complete!
echo.
echo 📂 Cloned repositories:
echo    - ideas&external_references\theia\ (~54MB)
echo    - ideas&external_references\playwright\ (~100MB)
echo    - ideas&external_references\puppeteer\ (~20MB)
echo    - ideas&external_references\gemini-cli\ (~10MB)
echo    - ideas&external_references\infinite-canvas\infinite-canvas-master\ (~2MB)
echo.
echo 💡 To update references later, run: setup.bat

goto :eof

:clone_or_update
setlocal
set URL=%~1
set DIR=%~2
set NAME=%~3

if exist "%DIR%" (
    echo 📦 Updating %NAME%...
    cd %DIR%
    git pull --depth 1
    cd ..
) else (
    echo 📥 Cloning %NAME% (shallow)...
    git clone --depth 1 %URL% %DIR%
)
endlocal
goto :eof
