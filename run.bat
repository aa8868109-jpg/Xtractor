@echo off
chcp 65001 >nul
title Xtractor - Smart Attendance System

echo ========================================
echo  تطبيق الحضور الذكي Xtractor
echo ========================================
echo.
echo جاري تشغيل الخادم...
echo.

cd /d "%~dp0"

REM فتح الموقع في المتصفح
start http://localhost:8000

REM تشغيل خادم Python
python -m http.server 8000

pause
