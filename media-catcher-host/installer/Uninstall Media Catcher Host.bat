@echo off
title Media Catcher Host - Uninstall
echo Removing the Media Catcher host...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\MediaCatcher\Host\bootstrap.ps1" -Uninstall
echo.
pause
