@echo off
setlocal enabledelayedexpansion
REM EG-DESK Project References Setup for Windows
REM Mirrors setup.sh: registry TSV lookup, project-refs.txt, manifest generation.
REM Usage: setup.bat [--update | --check | --add name url [--tags t] [--desc d] | --edit name [--tags t] [--desc d] | --remove name]

set "SCRIPT_DIR=%~dp0"
set "REF_DIR=%SCRIPT_DIR%references"
set "REGISTRY=%USERPROFILE%\.claude\reference-registry.tsv"
set "PROJECT_REFS=%REF_DIR%\project-refs.txt"
set "MANIFEST=%REF_DIR%\manifest.tsv"
set "NOTES_DIR=%USERPROFILE%\.claude\reference-notes"
set "CLAUDE_DIR=%USERPROFILE%\.claude"
set "MAX_CLONE_SIZE_KB=512000"

REM ─── Parse arguments ───
set "ACTION="
set "ADD_NAME="
set "ADD_URL="
set "ADD_TAGS="
set "ADD_DESC="
set "EDIT_NAME="
set "REMOVE_NAME="

if "%~1"=="" goto :default_action
if "%~1"=="--update" set "ACTION=update" & goto :run_action
if "%~1"=="--check" set "ACTION=check" & goto :run_action
if "%~1"=="--help" goto :show_help
if "%~1"=="-h" goto :show_help

if "%~1"=="--add" (
    set "ACTION=add"
    set "ADD_NAME=%~2"
    set "ADD_URL=%~3"
    shift & shift & shift
    :parse_add_opts
    if "%~1"=="" goto :run_action
    if "%~1"=="--tags" set "ADD_TAGS=%~2" & shift & shift & goto :parse_add_opts
    if "%~1"=="--desc" set "ADD_DESC=%~2" & shift & shift & goto :parse_add_opts
    shift & goto :parse_add_opts
)

if "%~1"=="--add-global" (
    set "ACTION=add-global"
    set "ADD_NAME=%~2"
    set "ADD_URL=%~3"
    shift & shift & shift
    :parse_addg_opts
    if "%~1"=="" goto :run_action
    if "%~1"=="--tags" set "ADD_TAGS=%~2" & shift & shift & goto :parse_addg_opts
    if "%~1"=="--desc" set "ADD_DESC=%~2" & shift & shift & goto :parse_addg_opts
    shift & goto :parse_addg_opts
)

if "%~1"=="--edit" (
    set "ACTION=edit"
    set "EDIT_NAME=%~2"
    shift & shift
    :parse_edit_opts
    if "%~1"=="" goto :run_action
    if "%~1"=="--tags" set "ADD_TAGS=%~2" & shift & shift & goto :parse_edit_opts
    if "%~1"=="--desc" set "ADD_DESC=%~2" & shift & shift & goto :parse_edit_opts
    shift & goto :parse_edit_opts
)

if "%~1"=="--remove" (
    set "ACTION=remove"
    set "REMOVE_NAME=%~2"
    goto :run_action
)

goto :default_action

:show_help
echo Usage: setup.bat [options]
echo.
echo Options:
echo   (no args)      Clone/pull references + generate manifest
echo   --update       Git pull all cloned references
echo   --check        Show reference health status
echo   --add ^<name^> ^<url^> --tags ^<t^> --desc ^<d^>   Add a reference (clone + project + registry)
echo   --add-global ^<name^> ^<url^> --tags ^<t^> --desc ^<d^>   Registry only (no clone)
echo   --edit ^<name^> --tags ^<t^> --desc ^<d^>        Edit registry metadata
echo   --remove ^<name^>   Remove from this project (registry unchanged)
goto :eof

REM ─── Actions ───
:run_action

if "%ACTION%"=="check" goto :action_check
if "%ACTION%"=="update" goto :action_update
if "%ACTION%"=="add" goto :action_add
if "%ACTION%"=="add-global" goto :action_add_global
if "%ACTION%"=="edit" goto :action_edit
if "%ACTION%"=="remove" goto :action_remove

:default_action
echo Setting up EG-DESK references...
echo.

REM Sync ~/.claude registry
call :sync_claude_registry

REM Process each ref in project-refs.txt
if not exist "%PROJECT_REFS%" (
    echo    ERROR: %PROJECT_REFS% not found
    exit /b 1
)
for /f "usebackq tokens=* eol=#" %%r in ("%PROJECT_REFS%") do (
    set "REF_NAME=%%r"
    REM Trim whitespace
    for /f "tokens=*" %%t in ("!REF_NAME!") do set "REF_NAME=%%t"
    if not "!REF_NAME!"=="" call :process_ref "!REF_NAME!"
)

call :generate_manifest
call :check_health
call :check_orphans
goto :eof

:action_check
call :check_health
call :check_orphans
goto :eof

:action_update
echo Updating references...
call :sync_claude_registry
for /f "usebackq tokens=* eol=#" %%r in ("%PROJECT_REFS%") do (
    set "REF_NAME=%%r"
    for /f "tokens=*" %%t in ("!REF_NAME!") do set "REF_NAME=%%t"
    if not "!REF_NAME!"=="" call :update_ref "!REF_NAME!"
)
call :generate_manifest
call :check_health
goto :eof

:action_add
if "%ADD_NAME%"=="" (
    echo ERROR: Usage: setup.bat --add ^<name^> ^<url^> --tags ^<tags^> --desc ^<description^>
    exit /b 1
)
if "%ADD_URL%"=="" (
    echo ERROR: Usage: setup.bat --add ^<name^> ^<url^> --tags ^<tags^> --desc ^<description^>
    exit /b 1
)
echo Adding %ADD_NAME%...

REM Clone if not exists
if not exist "%REF_DIR%\%ADD_NAME%" (
    echo    Cloning %ADD_NAME%...
    git clone --depth 1 "%ADD_URL%" "%REF_DIR%\%ADD_NAME%" || (
        echo    ERROR: Clone failed
        exit /b 1
    )
)

REM Add to project-refs.txt
findstr /x "%ADD_NAME%" "%PROJECT_REFS%" >nul 2>&1 || echo %ADD_NAME%>>"%PROJECT_REFS%"

REM Upsert registry
findstr /c:"	%ADD_NAME%	" "%REGISTRY%" >nul 2>&1 || (
    echo %ADD_URL%	%ADD_NAME%	git	%ADD_TAGS%	%ADD_DESC%>>"%REGISTRY%"
)

call :push_claude_registry "add %ADD_NAME%"
call :generate_manifest
echo    Done: %ADD_NAME% added
goto :eof

:action_add_global
if "%ADD_NAME%"=="" (
    echo ERROR: Usage: setup.bat --add-global ^<name^> ^<url^> --tags ^<tags^> --desc ^<description^>
    exit /b 1
)
echo Adding %ADD_NAME% to global registry only...
findstr /c:"	%ADD_NAME%	" "%REGISTRY%" >nul 2>&1 || (
    echo %ADD_URL%	%ADD_NAME%	git	%ADD_TAGS%	%ADD_DESC%>>"%REGISTRY%"
)
call :push_claude_registry "add-global %ADD_NAME%"
echo    Done: %ADD_NAME% added to registry (not cloned)
goto :eof

:action_edit
if "%EDIT_NAME%"=="" (
    echo ERROR: Usage: setup.bat --edit ^<name^> --tags ^<tags^> --desc ^<description^>
    exit /b 1
)
echo Editing %EDIT_NAME% in global registry...

REM Find and replace line in registry (simplified: rewrite whole file)
set "FOUND=0"
if exist "%REGISTRY%.tmp" del "%REGISTRY%.tmp"
for /f "usebackq tokens=1,2,3,4,5 delims=	" %%a in ("%REGISTRY%") do (
    if "%%b"=="%EDIT_NAME%" (
        set "FOUND=1"
        set "NEW_TAGS=%ADD_TAGS%"
        set "NEW_DESC=%ADD_DESC%"
        if "!NEW_TAGS!"=="" set "NEW_TAGS=%%d"
        if "!NEW_DESC!"=="" set "NEW_DESC=%%e"
        echo %%a	%%b	%%c	!NEW_TAGS!	!NEW_DESC!>>"%REGISTRY%.tmp"
    ) else (
        echo %%a	%%b	%%c	%%d	%%e>>"%REGISTRY%.tmp"
    )
)
if "%FOUND%"=="0" (
    echo    ERROR: %EDIT_NAME% not found in registry
    if exist "%REGISTRY%.tmp" del "%REGISTRY%.tmp"
    exit /b 1
)
move /y "%REGISTRY%.tmp" "%REGISTRY%" >nul
call :push_claude_registry "edit %EDIT_NAME%"
call :generate_manifest
echo    Done: %EDIT_NAME% updated
goto :eof

:action_remove
if "%REMOVE_NAME%"=="" (
    echo ERROR: Usage: setup.bat --remove ^<name^>
    exit /b 1
)
echo Removing %REMOVE_NAME% from this project...

REM Remove from project-refs.txt
if exist "%PROJECT_REFS%" (
    findstr /v /x "%REMOVE_NAME%" "%PROJECT_REFS%" > "%PROJECT_REFS%.tmp" 2>nul
    move /y "%PROJECT_REFS%.tmp" "%PROJECT_REFS%" >nul
)

REM Remove folder
if exist "%REF_DIR%\%REMOVE_NAME%" (
    rmdir /s /q "%REF_DIR%\%REMOVE_NAME%"
    echo    Deleted references\%REMOVE_NAME%\
)

call :generate_manifest
echo    Done: %REMOVE_NAME% removed (registry unchanged)
goto :eof

REM ─── Subroutines ───

:sync_claude_registry
if exist "%CLAUDE_DIR%\.git" (
    echo    Syncing ~/.claude registry...
    pushd "%CLAUDE_DIR%"
    git pull --rebase 2>nul || echo    WARNING: ~/.claude git pull failed
    popd
)
goto :eof

:push_claude_registry
if exist "%CLAUDE_DIR%\.git" (
    pushd "%CLAUDE_DIR%"
    git add reference-registry.tsv 2>nul
    git commit -m "registry: %~1" 2>nul
    git pull --rebase 2>nul
    git push 2>nul || echo    WARNING: ~/.claude git push failed
    popd
)
goto :eof

:process_ref
set "R_NAME=%~1"
call :lookup_registry "%R_NAME%"
if "!REG_URL!"=="" (
    echo    WARNING: %R_NAME% not in registry, skipping
    goto :eof
)
if "!REG_TYPE!"=="git" (
    if exist "%REF_DIR%\%R_NAME%\.git" (
        echo    OK: %R_NAME% (exists)
    ) else if not "!REG_URL!"=="" (
        echo    Cloning %R_NAME%...
        git clone --depth 1 "!REG_URL!" "%REF_DIR%\%R_NAME%" 2>nul || echo    ERROR: %R_NAME% clone failed
    )
) else if "!REG_TYPE!"=="docs" (
    if exist "%REF_DIR%\%R_NAME%" (
        echo    OK: %R_NAME% (docs, exists)
    ) else (
        mkdir "%REF_DIR%\%R_NAME%"
        echo    Created: %R_NAME% (docs — add files manually)
    )
)
goto :eof

:update_ref
set "R_NAME=%~1"
call :lookup_registry "%R_NAME%"
if "!REG_URL!"=="" goto :eof
if "!REG_TYPE!"=="git" (
    if exist "%REF_DIR%\%R_NAME%\.git" (
        echo    Pulling %R_NAME%...
        pushd "%REF_DIR%\%R_NAME%"
        git pull 2>nul || echo    WARNING: %R_NAME% pull failed
        popd
    )
)
goto :eof

:lookup_registry
set "REG_URL="
set "REG_NAME="
set "REG_TYPE="
set "REG_TAGS="
set "REG_DESC="
if not exist "%REGISTRY%" goto :eof
for /f "usebackq tokens=1,2,3,4,5 delims=	" %%a in ("%REGISTRY%") do (
    set "LINE_START=%%a"
    if not "!LINE_START:~0,1!"=="#" (
        if "%%b"=="%~1" (
            set "REG_URL=%%a"
            set "REG_NAME=%%b"
            set "REG_TYPE=%%c"
            set "REG_TAGS=%%d"
            set "REG_DESC=%%e"
            goto :eof
        )
    )
)
goto :eof

:generate_manifest
echo # Auto-generated by setup.bat — do not edit manually> "%MANIFEST%"
echo # Source: ~/.claude/reference-registry.tsv>> "%MANIFEST%"
echo # Format: name^<TAB^>type^<TAB^>tags^<TAB^>description^<TAB^>status^<TAB^>has_note>> "%MANIFEST%"

if not exist "%PROJECT_REFS%" goto :eof
for /f "usebackq tokens=* eol=#" %%r in ("%PROJECT_REFS%") do (
    set "M_NAME=%%r"
    for /f "tokens=*" %%t in ("!M_NAME!") do set "M_NAME=%%t"
    if not "!M_NAME!"=="" call :manifest_entry "!M_NAME!"
)
goto :eof

:manifest_entry
call :lookup_registry "%~1"
if "!REG_NAME!"=="" goto :eof

set "STATUS=not-cloned"
if "!REG_TYPE!"=="git" (
    if exist "%REF_DIR%\%~1\.git" set "STATUS=cloned"
) else if "!REG_TYPE!"=="docs" (
    if exist "%REF_DIR%\%~1" set "STATUS=present"
)

set "HAS_NOTE=no"
if exist "%NOTES_DIR%\%~1.md" set "HAS_NOTE=yes"

echo !REG_NAME!	!REG_TYPE!	!REG_TAGS!	!REG_DESC!	!STATUS!	!HAS_NOTE!>>"%MANIFEST%"
goto :eof

:check_health
echo.
echo Reference Health Check
echo =========================
set "HEALTHY=0"
set "MISSING=0"
if not exist "%PROJECT_REFS%" goto :health_done
for /f "usebackq tokens=* eol=#" %%r in ("%PROJECT_REFS%") do (
    set "H_NAME=%%r"
    for /f "tokens=*" %%t in ("!H_NAME!") do set "H_NAME=%%t"
    if not "!H_NAME!"=="" call :health_entry "!H_NAME!"
)
:health_done
echo.
echo    Healthy: %HEALTHY% ^| Missing: %MISSING%
goto :eof

:health_entry
call :lookup_registry "%~1"
if "!REG_NAME!"=="" (
    echo    WARNING: %~1 not in registry
    goto :eof
)
if "!REG_TYPE!"=="git" (
    if exist "%REF_DIR%\%~1\.git" (
        echo    OK: %~1 (git)
        set /a HEALTHY+=1
    ) else (
        echo    MISSING: %~1 (not cloned)
        set /a MISSING+=1
    )
) else if "!REG_TYPE!"=="docs" (
    if exist "%REF_DIR%\%~1" (
        echo    OK: %~1 (docs)
        set /a HEALTHY+=1
    ) else (
        echo    MISSING: %~1 (docs, missing)
        set /a MISSING+=1
    )
)
goto :eof

:check_orphans
if not exist "%REF_DIR%" goto :eof
for /d %%d in ("%REF_DIR%\*") do (
    set "DIR_NAME=%%~nxd"
    set "IS_REF=0"
    if exist "%PROJECT_REFS%" (
        findstr /x "!DIR_NAME!" "%PROJECT_REFS%" >nul 2>&1 && set "IS_REF=1"
    )
    if "!IS_REF!"=="0" (
        echo    WARNING: references\!DIR_NAME!\ is not in project-refs.txt
        echo       Remove: setup.bat --remove !DIR_NAME!
        echo       Keep:   Add '!DIR_NAME!' to references\project-refs.txt
    )
)
goto :eof
