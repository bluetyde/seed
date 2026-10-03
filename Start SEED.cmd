@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 goto folder_error
where node.exe >nul 2>&1
if errorlevel 1 goto prerequisites
where npm.cmd >nul 2>&1
if errorlevel 1 goto prerequisites
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto prerequisites
if not exist "node_modules\.bin\tsc.cmd" goto setup
if not exist "node_modules\.bin\electron.cmd" goto setup
goto launch

:setup
echo SEED needs to install its dependencies before the first launch.
echo This uses the package lockfile and may need an Internet connection.
set "seed_install="
set /p "seed_install=Install now? [Y/N]: "
if /i not "%seed_install%"=="Y" goto declined
call npm.cmd ci --include=dev --no-audit --no-fund
if errorlevel 1 goto install_error

:launch
call npm.cmd start
if errorlevel 1 goto start_error
popd
exit /b 0

:prerequisites
echo SEED requires Node.js 24 or newer, including npm, on PATH.
echo Install Node.js, then reopen this launcher.
goto failed

:install_error
echo SEED dependency setup failed. Review the error above and try again.
goto failed

:start_error
echo SEED could not start or exited with an error. Review the output above.
echo If dependencies changed after an update, run npm ci --include=dev in this folder.
goto failed

:declined
echo Setup cancelled. Run this launcher again when ready to install.
goto failed

:folder_error
echo SEED could not open its application folder.
pause
exit /b 1

:failed
pause
popd
exit /b 1
