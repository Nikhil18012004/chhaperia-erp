<#
============================================================
 Chhaperia ERP — put the server on THIS Windows machine

   powershell -ExecutionPolicy Bypass -File deploy\local\setup-windows.ps1

 One script, safe to run again. It:
   1. checks Node 18+ and MySQL 8 are installed (and says how to get them)
   2. creates THIS project's database and an account fenced to it
   3. writes .env — keeping the secrets already in it, if any
   4. installs the backend dependencies
   5. optionally opens port 4000 to the factory LAN  (-OpenFirewall, admin)
   6. optionally starts the ERP at every logon        (-AutoStart)
   7. starts the server and prints the address the floor should use

 WHY THIS MACHINE AND NOT A CLOUD SERVER
 Two features run on the server's own Windows desktop: BarTender label
 printing launches bartend.exe, and the TDS booklet is converted to PDF by
 Word itself. Move the server to Linux or to a cloud host and both stop
 working — silently, in the TDS case. The ERP belongs on the machine that
 has BarTender and Word, which is this one.

 That is also why -AutoStart registers a task at LOGON and not at boot: a
 task started at boot runs in session 0, with no desktop, and BarTender's
 window would open where nobody can see it.
============================================================
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [int]    $Port         = 4000,
  [string] $MySqlHost    = "127.0.0.1",
  [int]    $MySqlPort    = 3306,
  [string] $Database     = "chhaperia_erp",
  [string] $AppUser      = "chhaperia",
  [switch] $OpenFirewall,   # needs an elevated shell
  [switch] $AutoStart,      # register the logon task
  [switch] $NoStart         # set everything up, do not launch
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

function Say  ($m) { Write-Host "  $m" }
function Head ($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host ""; Write-Host "  x $m" -ForegroundColor Red; exit 1 }

function Random-Hex ([int]$bytes) {
  $b = New-Object byte[] $bytes
  ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString("x2") })
}

function Is-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

Head "Chhaperia ERP — local server setup"
Say  "project: $Root"

# ---- 1. the two things that must already be here ----------------------
Head "1. Checking what is installed"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die ("Node.js is not installed. Get the LTS build:`n" +
       "      winget install OpenJS.NodeJS.LTS`n" +
       "    then open a NEW window and run this script again.")
}
$nodeVer = (& node -v) -replace '^v',''
if ([int]($nodeVer.Split('.')[0]) -lt 18) { Die "Node $nodeVer is too old — the ERP needs 18 or newer." }
Say "Node $nodeVer"

# mysql.exe: on PATH, or in the usual install folder
$mysqlExe = (Get-Command mysql.exe -ErrorAction SilentlyContinue).Source
if (-not $mysqlExe) {
  $mysqlExe = Get-ChildItem "C:\Program Files\MySQL\MySQL Server *\bin\mysql.exe" -ErrorAction SilentlyContinue |
              Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $mysqlExe) {
  Die ("MySQL is not installed on this machine. Install MySQL 8.4 LTS —`n" +
       "    https://dev.mysql.com/downloads/installer/  (choose 'Server only')`n" +
       "    Remember the root password you set; this script asks for it once.`n" +
       "    If MySQL is on a DIFFERENT machine, re-run with -MySqlHost <its address>.")
}
Say "MySQL client: $mysqlExe"

# ---- 2. this project's database, and an account fenced to it ----------
Head "2. The database this project owns"

$envPath = Join-Path $Root ".env"
$existing = @{}
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { $existing[$Matches[1]] = $Matches[2].Trim() }
  }
  Say ".env already here — its password and secret will be kept, not rotated"
}

# Rotating either of these on a re-run would lock the plant out of its own
# database and log every user out, so an existing value always wins.
$appPassword = if ($existing["CHHAPERIA_DB_PASSWORD"]) { $existing["CHHAPERIA_DB_PASSWORD"] } else { Random-Hex 18 }
$authSecret  = if ($existing["AUTH_SECRET"])           { $existing["AUTH_SECRET"] }           else { Random-Hex 32 }

Write-Host ""
$rootSecure = Read-Host "  MySQL root password (typed once, never written to disk)" -AsSecureString
$rootBstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($rootSecure)
$rootPlain  = [Runtime.InteropServices.Marshal]::PtrToStringAuto($rootBstr)

# The account may create and drop the two scratch schemas the test suite uses
# (chh_smoke_… / chh_http_…) and may touch NOTHING else on this server. If the
# ERP is ever misconfigured to point at another application's database, MySQL
# itself refuses it — not just the app's own guard.
$sql = @"
CREATE DATABASE IF NOT EXISTS ``$Database`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
CREATE USER IF NOT EXISTS '$AppUser'@'localhost' IDENTIFIED BY '$appPassword';
ALTER USER '$AppUser'@'localhost' IDENTIFIED BY '$appPassword';
GRANT ALL PRIVILEGES ON ``$Database``.* TO '$AppUser'@'localhost';
GRANT ALL PRIVILEGES ON ``chh\_smoke\_%``.* TO '$AppUser'@'localhost';
GRANT ALL PRIVILEGES ON ``chh\_http\_%``.* TO '$AppUser'@'localhost';
FLUSH PRIVILEGES;
"@

# MYSQL_PWD rather than -p on the command line: a password in an argument is
# visible to anything that can list processes on this machine.
$env:MYSQL_PWD = $rootPlain
try {
  $sql | & $mysqlExe "-u" "root" "-h" $MySqlHost "-P" $MySqlPort "--protocol=TCP" 2>&1 | ForEach-Object { Say $_ }
  if ($LASTEXITCODE -ne 0) { Die "MySQL refused those statements. Wrong root password, or the server is not running." }
} finally {
  # The root password never touches disk and does not outlive this block.
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
  $rootPlain = $null
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($rootBstr)
}
Say "database '$Database' ready; account '$AppUser' can reach it and nothing else"

# ---- 3. the project's own configuration -------------------------------
Head "3. Writing .env (this project's configuration, never committed)"

$envText = @"
# Chhaperia ERP — THIS machine's configuration. Never commit this file.
# Written by deploy\local\setup-windows.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm').
CHHAPERIA_DB_HOST=$MySqlHost
CHHAPERIA_DB_PORT=$MySqlPort
CHHAPERIA_DB_USER=$AppUser
CHHAPERIA_DB_PASSWORD=$appPassword
CHHAPERIA_DB_NAME=$Database
# Signs every login token. Changing it logs everyone out.
AUTH_SECRET=$authSecret
PORT=$Port
"@
[System.IO.File]::WriteAllText($envPath, $envText, (New-Object System.Text.UTF8Encoding($false)))
# Readable by this account only — it holds the database password and the
# token-signing secret.
& icacls $envPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
Say ".env written and locked to $($env:USERNAME)"

# ---- 4. dependencies ---------------------------------------------------
Head "4. Installing backend dependencies"
& npm install --prefix backend --omit=dev
if ($LASTEXITCODE -ne 0) { Die "npm install failed." }

# ---- 5. the factory LAN ------------------------------------------------
if ($OpenFirewall) {
  Head "5. Opening port $Port to the factory LAN"
  if (-not (Is-Admin)) {
    Warn "Not an administrator — skipped. Re-run an elevated shell with -OpenFirewall."
  } else {
    $ruleName = "Chhaperia ERP (LAN)"
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    # Private/Domain only: the office network, never a public hotspot.
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Port -Profile Private,Domain | Out-Null
    Say "inbound TCP $Port allowed on private and domain networks"
  }
}

# ---- 6. start it every time this account logs on -----------------------
if ($AutoStart) {
  Head "6. Starting the ERP at every logon"
  # AT LOGON, not at boot, and NOT as SYSTEM: BarTender has to be able to open
  # its window on this user's desktop, and a task started at boot runs in
  # session 0 where no desktop exists.
  $taskName = "Chhaperia ERP"
  $action   = New-ScheduledTaskAction -Execute $node.Source `
                -Argument "backend\src\server.js" -WorkingDirectory $Root
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Chhaperia ERP server (LAN)" -RunLevel Limited | Out-Null
  Say "registered '$taskName' — it starts when $($env:USERNAME) logs on"
}

# ---- 7. the address the floor types ------------------------------------
Head "Where the floor finds it"
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
       Select-Object -ExpandProperty IPAddress
Say "on this machine : http://localhost:$Port/"
foreach ($ip in $ips) { Say "from the floor  : http://${ip}:$Port/" }
Warn "That address changes if the network does. A fixed IP or a DHCP reservation for this machine saves retyping it into every tablet."
Write-Host ""
Warn "The eight seeded accounts start as <username>@123 (admin/admin@123). Change them before anyone else is on the network."

if (-not $NoStart) {
  Head "Starting the server — Ctrl+C stops it"
  & node backend\src\server.js
} else {
  Head "Done. Start it with:  npm start"
}
