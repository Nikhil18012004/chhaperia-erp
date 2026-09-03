@echo off
REM ============================================================
REM  Chhaperia ERP - start the server on this machine.
REM  Double-click this file, or pin a shortcut to it on the desktop.
REM  The window stays open: closing it stops the ERP.
REM ============================================================
setlocal
cd /d "%~dp0..\.."
title Chhaperia ERP - server (closing this window stops it)

if not exist ".env" (
  echo.
  echo   This machine has not been set up yet.
  echo   Run this once, from this folder:
  echo.
  echo     powershell -ExecutionPolicy Bypass -File deploy\local\setup-windows.ps1
  echo.
  pause
  exit /b 1
)

node backend\src\server.js
echo.
echo   The server stopped. The message above says why.
pause
