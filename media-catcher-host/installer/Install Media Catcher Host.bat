@echo off
rem Double-click installer for the Media Catcher host.
rem Runs the bootstrap: ensures Python + ffmpeg, installs the host, registers it with Firefox.
title Media Catcher Host - Install
echo Installing the Media Catcher host...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1"
echo.
pause
