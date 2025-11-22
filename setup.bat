@echo off
REM EG-DESK External References Setup Script for Windows

echo Setting up EG-DESK external references...

cd "references"

REM Function-like approach using labels
call :clone_or_update "https://github.com/eclipse-theia/theia.git" "theia" "theia" "Theia Framework"
call :clone_or_update "https://github.com/microsoft/playwright.git" "playwright" "playwright" "Playwright Testing"
call :clone_or_update "https://github.com/puppeteer/puppeteer.git" "puppeteer" "puppeteer" "Puppeteer Automation"
call :clone_or_update "https://github.com/google-gemini/gemini-cli.git" "gemini-cli" "gemini-cli" "Google Gemini CLI"
call :clone_or_update "https://github.com/deta/surf.git" "surf" "surf" "Deta Surf Browser"

REM Clone infinite-canvas into subfolder
if not exist "infinite-canvas" mkdir "infinite-canvas"
cd "infinite-canvas"

if exist "infinite-canvas" (
    echo Re-cloning Infinite Canvas ensuring depth 1...
    rmdir /s /q "infinite-canvas"
) else (
    echo Cloning Infinite Canvas shallow...
)

git clone --depth 1 https://github.com/emilefokkema/infinite-canvas.git infinite-canvas
cd ..

cd ..

echo External references setup complete!
echo.
echo Updated repositories:
echo    - references\theia\theia\ (~54MB)
echo    - references\playwright\playwright\ (~100MB)
echo    - references\puppeteer\puppeteer\ (~20MB)
echo    - references\gemini-cli\gemini-cli\ (~10MB)
echo    - references\surf\surf\ (~15MB)
echo    - references\infinite-canvas\infinite-canvas\ (~2MB)
echo.
echo To update references later, run: setup.bat

goto :eof

:clone_or_update
setlocal
set "URL=%~1"
set "PARENT_DIR=%~2"
set "REPO_DIR=%~3"
set "NAME=%~4"

REM Check if parent directory exists, create if not
if not exist "%PARENT_DIR%" mkdir "%PARENT_DIR%"

REM Navigate to parent directory
cd "%PARENT_DIR%"

REM Always delete and re-clone the git repo to ensure depth 1
if exist "%REPO_DIR%" (
    echo Re-cloning %NAME% ensuring depth 1...
    rmdir /s /q "%REPO_DIR%"
) else (
    echo Cloning %NAME% shallow...
)

git clone --depth 1 "%URL%" "%REPO_DIR%"
cd ..

endlocal
goto :eof
