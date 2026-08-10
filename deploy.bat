@echo off
setlocal
title Vercel Deploy Tool

echo ==============================
echo   Xtractor Deploy Started...
echo ==============================
echo.

cd /d "%~dp0"

where npx >nul 2>&1
if errorlevel 1 (
    echo Node.js / npx was not found. Install Node.js first.
    pause
    exit /b 1
)

echo Uploading project to Vercel...
echo.

if defined VERCEL_TOKEN (
    echo Using Vercel token from environment variable.
    npx vercel --prod --confirm --token "%VERCEL_TOKEN%"
) else (
    echo No VERCEL_TOKEN detected. Vercel may prompt for login.
    npx vercel --prod --confirm
)

if errorlevel 1 (
    echo.
    echo Deployment failed.
    echo Make sure you are logged in to Vercel or set VERCEL_TOKEN.
    pause
    exit /b %errorlevel%
)

echo.
echo ==============================
echo   Deploy Finished
echo ==============================
pause