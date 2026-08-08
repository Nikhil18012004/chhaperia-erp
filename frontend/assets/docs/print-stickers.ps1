# Chhaperia ERP -> BarTender bridge. Runs on the PC that has BarTender.
# The ERP's BarTender button downloads a fresh sticker CSV into this PC's
# Downloads folder; this script parks it at ONE FIXED path the label
# template binds to, then opens the template in BarTender.
$ErrorActionPreference = "SilentlyContinue"
$fixedDir = "C:\ChhaperiaLabels"
New-Item -ItemType Directory -Force $fixedDir | Out-Null

$dl = (New-Object -ComObject Shell.Application).NameSpace("shell:Downloads").Self.Path
$newest = Get-ChildItem (Join-Path $dl "*stickers*.csv") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newest) {
  Copy-Item $newest.FullName (Join-Path $fixedDir "stickers.csv") -Force
  # clear the strays so "stickers (3).csv" copies never pile up or confuse
  Get-ChildItem (Join-Path $dl "*stickers*.csv") | Remove-Item -Force
  Write-Host ("Sticker data updated from " + $newest.Name)
} elseif (-not (Test-Path (Join-Path $fixedDir "stickers.csv"))) {
  Write-Host "No sticker file found in Downloads."
  Write-Host "In the ERP press the BarTender button first (it downloads the CSV), then run this again."
  pause
  exit
}

$btw = Get-ChildItem (Join-Path $fixedDir "*.btw") | Select-Object -First 1
if ($btw) {
  Start-Process $btw.FullName
} else {
  Write-Host ("Sticker data is ready at " + $fixedDir + "\stickers.csv")
  Write-Host ""
  Write-Host "ONE-TIME SETUP still needed:"
  Write-Host ("  1. Open BarTender and design your raw-material sticker.")
  Write-Host ("  2. Connect its data source: Text File -> " + $fixedDir + "\stickers.csv")
  Write-Host ("     (tick 'first row contains field names').")
  Write-Host ("  3. Save the label as a .btw INTO " + $fixedDir)
  Write-Host "After that this button opens your label automatically every time."
  pause
}
