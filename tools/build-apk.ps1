<#
  Builds the Chhaperia ERP Android app.

      powershell -ExecutionPolicy Bypass -File tools/build-apk.ps1
      powershell -ExecutionPolicy Bypass -File tools/build-apk.ps1 -Release

  Expects a JDK 17, the Android SDK and a Gradle distribution under the
  toolchain directory below. None of them are on PATH deliberately -- this
  machine has no system-wide Java, and putting one there would be a change
  to the laptop rather than to this project.
#>
param(
  [switch]$Release,
  [string]$Toolchain = "C:\Users\Kavithayappa\androidtools"
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $repo 'android'

$jdk = (Get-ChildItem "$Toolchain\jdk-*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $jdk) { throw "No JDK under $Toolchain. See android/README.md." }
$sdk = Join-Path $Toolchain 'sdk'
if (-not (Test-Path "$sdk\platforms")) { throw "No Android SDK under $sdk. See android/README.md." }
$gradle = (Get-ChildItem "$Toolchain\gradle-*" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $gradle) { throw "No Gradle under $Toolchain. See android/README.md." }

$env:JAVA_HOME = $jdk.FullName
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:PATH = "$($jdk.FullName)\bin;$env:PATH"

# Gradle finds the SDK through this file; it is generated rather than committed
# because it holds an absolute path that is true only on this machine.
Set-Content -Path (Join-Path $proj 'local.properties') -Encoding utf8 `
  -Value ("sdk.dir=" + $sdk.Replace('\', '\\'))

$task = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
Write-Output "building $task ..."
& "$($gradle.FullName)\bin\gradle.bat" -p $proj $task --no-daemon --console=plain
if ($LASTEXITCODE -ne 0) { throw "gradle $task failed with exit code $LASTEXITCODE" }

$variant = if ($Release) { 'release' } else { 'debug' }
$apk = Get-ChildItem "$proj\app\build\outputs\apk\$variant\*.apk" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $apk) { throw "build reported success but produced no APK" }

$size = [math]::Round($apk.Length / 1MB, 2)
Write-Output ""
Write-Output "APK: $($apk.FullName)"
Write-Output "size: $size MB"
