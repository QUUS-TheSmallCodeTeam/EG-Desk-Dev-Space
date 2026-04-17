@echo off
REM Wrapper: runs install.bat and captures output to install.log
cd /d "%~dp0"
call install.bat > install.log 2>&1
echo.>> install.log
echo EXIT_CODE=%ERRORLEVEL% >> install.log
exit /b %ERRORLEVEL%
