@echo off
setlocal
REM One-click setup for the BarTender PC. Downloads the print helper from the
REM ERP laptop, and puts a "Print Stickers" button on the desktop.
set BASE1=http://10.60.136.246:4000/assets/docs
set BASE2=http://10.79.73.208:4000/assets/docs

mkdir C:\ChhaperiaLabels 2>nul
curl -s -f -o C:\ChhaperiaLabels\print-stickers.bat %BASE1%/print-stickers.bat
if not exist C:\ChhaperiaLabels\print-stickers.bat curl -s -f -o C:\ChhaperiaLabels\print-stickers.bat %BASE2%/print-stickers.bat
curl -s -f -o C:\ChhaperiaLabels\print-stickers.ps1 %BASE1%/print-stickers.ps1
if not exist C:\ChhaperiaLabels\print-stickers.ps1 curl -s -f -o C:\ChhaperiaLabels\print-stickers.ps1 %BASE2%/print-stickers.ps1

if not exist C:\ChhaperiaLabels\print-stickers.ps1 (
  echo.
  echo  Could not reach the ERP laptop. Make sure it is switched on and on the
  echo  same network, then double-click this file again.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Print Stickers.lnk'); $s.TargetPath='C:\ChhaperiaLabels\print-stickers.bat'; $s.WorkingDirectory='C:\ChhaperiaLabels'; $s.Save()"

echo.
echo  DONE. A "Print Stickers" button is now on this desktop.
echo.
echo  How to use, every time:
echo    1. In the ERP press the BarTender button on a purchase order.
echo    2. Double-click "Print Stickers" on the desktop.
echo.
echo  The very first time, it will ask you to design your sticker once in
echo  BarTender and save it into C:\ChhaperiaLabels - it tells you exactly how.
echo.
pause
