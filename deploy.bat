@echo off
title Vercel Deploy Tool

echo ==============================
echo   Xtractor Deploy Started...
echo ==============================
echo.

cd /d "%~dp0"

echo Uploading project to Vercel...
echo.
rem Check for vercel CLI and install if missing
where vercel >nul 2>&1
if errorlevel 1 (
	echo Vercel CLI not found. Installing globally (may require admin)...
	npm install -g vercel
)

rem Show .env keys (if present) and guide user to add them to Vercel env
if exist .env (
	echo Found .env file. Listing keys to add to Vercel (production scope):
	for /f "usebackq tokens=1* delims==" %%A in (".env") do (
		if not "%%A"=="" echo   %%A
	)
	echo.
	echo Tip: run `vercel env add <NAME> production` for each variable above.
	echo Or add them in the Vercel dashboard under Project -> Settings -> Environment Variables.
	echo.
	timeout /t 2 >nul
)

rem Install dependencies if package.json exists
if exist package.json (
	echo Installing npm dependencies...
	npm install
)

rem Deploy (non-interactive) to Vercel
echo Deploying to Vercel (production)...
vercel --prod --confirm

echo.
echo ==============================
echo   Deploy Finished
echo ==============================
pause