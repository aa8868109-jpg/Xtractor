@echo off
chcp 65001 >nul
title Xtractor - Smart Attendance System

echo ========================================
echo تطبيق الحضور الذكي Xtractor
echo ========================================
echo.
echo جاري تشغيل الخادم...
echo.

cd /d "%~dp0"
echo Server started (in separate window). Press any key to exit this launcher.
REM Ensure .env exists (create from example if available)
if not exist "%~dp0.env" (
	if exist "%~dp0.env.example" (
		copy "%~dp0.env.example" "%~dp0.env" >nul
		echo Created .env from .env.example. Please edit .env to add AIRTABLE_API_KEY and PROTECTION_API_KEY as needed.
	) else (
		echo Warning: .env not found. Create .env with AIRTABLE_API_KEY and PROTECTION_API_KEY before starting.
	)
)

REM Install dependencies if node_modules missing
if not exist "%~dp0node_modules" (
	echo Installing npm dependencies (this may take a moment)...
	pushd "%~dp0"
	npm install --no-audit --no-fund > install.log 2>&1
	if %ERRORLEVEL% NEQ 0 (
		echo npm install failed. Check install.log for details.
	)
	popd
)

REM Start Express proxy server in the current window so errors remain visible
echo Starting Node server in this window (press Ctrl+C to stop)...

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
	echo ERROR: Node.js not found in PATH. Install Node.js and try again.
	pause
	exit /b 1
)

if not exist "node_modules" (
	echo Installing npm dependencies (this may take a moment)...
	npm install --no-audit --no-fund
	if %ERRORLEVEL% NEQ 0 (
		echo npm install failed. Check the output above.
		pause
		exit /b 1
	)
)

cd /d "%~dp0"
echo Launching server (logs printed below)...
node server.js

echo.
echo Server process exited with code %ERRORLEVEL%.
echo Check server.log or the console output above for errors.
pause
