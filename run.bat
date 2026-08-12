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

REM Start Express proxy server in a new window
start "Node Server" cmd /k "cd /d "%~dp0" && node server.js"

REM Give server a moment to start, then open browser
timeout /t 2 > nul
start "" "http://127.0.0.1:3000/index.html"

REM Keep this console open for logs / manual stop
echo.
echo Server started (in separate window). Press any key to exit this launcher.
pause