@echo off
title PM Bridge Watcher
powershell -NoLogo -ExecutionPolicy Bypass -File "%~dp0watcher.ps1"
pause
