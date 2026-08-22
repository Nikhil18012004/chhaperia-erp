<#
  Puts Chhaperia ERP on AWS, or updates what is already there.

      powershell -ExecutionPolicy Bypass -File deploy/aws/deploy.ps1
      powershell -ExecutionPolicy Bypass -File deploy/aws/deploy.ps1 -DomainName erp.chhaperia.in
      powershell -ExecutionPolicy Bypass -File deploy/aws/deploy.ps1 -AdminCidr 49.207.xx.xx/32

  Safe to run again: CloudFormation works out the difference. Re-running after
  a failed first attempt is the normal way to continue.
#>
param(
  [string]$StackName   = "chhaperia-erp",
  [string]$Region      = "ap-south-1",     # Mumbai -- nearest to Doddaballapur, and the data stays in India
  [string]$DomainName  = "",               # empty = a free sslip.io name, still with a real certificate
  [string]$AdminCidr   = "0.0.0.0/0",      # narrow to the factory's public IP when you know it
  [string]$InstanceType = "t3.small",
  [string]$RepoUrl     = "",
  [string]$RepoBranch  = "main",
  [string]$GitHubToken = "",               # required while the repository is private
  [switch]$Delete
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tpl  = Join-Path $PSScriptRoot 'chhaperia-erp.yaml'

# The CLI is not on PATH on this machine -- it was unpacked, not installed.
$aws = @(
  'C:\Program Files\Amazon\AWSCLIV2\aws.exe',
  'C:\Users\Kavithayappa\awscli\Amazon\AWSCLIV2\aws.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $aws) { $aws = (Get-Command aws -ErrorAction SilentlyContinue).Source }
if (-not $aws) { throw "No AWS CLI found. Install it, or unpack it with: msiexec /a awscli.msi /qn TARGETDIR=C:\Users\<you>\awscli" }

function Aws { & $aws @args }

# ---- 1. are we actually talking to an account? ----
# NOTE: no `2>&1` on any aws call. In Windows PowerShell, redirecting a native
# program's stderr wraps each line in an ErrorRecord, which with
# ErrorActionPreference=Stop aborts the script on a command that actually
# succeeded. The exit code is the thing to test, so test that.
Write-Output "checking credentials ..."
$ErrorActionPreference = 'Continue'
$who = Aws sts get-caller-identity --region $Region --output json
$rc = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($rc -ne 0) {
  Write-Output ""
  Write-Output "AWS is not configured on this machine. Nothing has been created."
  Write-Output "Set it up once with:"
  Write-Output "    & '$aws' configure"
  Write-Output "and give it an Access Key ID, Secret Access Key, and region $Region."
  throw "no AWS credentials"
}
$acct = ($who | ConvertFrom-Json).Account
Write-Output "  account $acct, region $Region"

if ($Delete) {
  Write-Output "deleting stack $StackName -- the database has DeletionProtection on and will refuse until you turn it off."
  Aws cloudformation delete-stack --stack-name $StackName --region $Region
  Aws cloudformation wait stack-delete-complete --stack-name $StackName --region $Region
  Write-Output "deleted."
  return
}

# ---- 2. which repository should the instance clone? ----
if (-not $RepoUrl) {
  Push-Location $repo
  # `git config` exits non-zero when the key is unset, which is not an error
  # worth stopping for -- the check below says it better.
  try { $RepoUrl = (git config --get remote.origin.url | Select-Object -First 1) } catch { $RepoUrl = "" }
  Pop-Location
  if (-not $RepoUrl) { throw "Could not read the git remote -- pass -RepoUrl explicitly." }
}
# the instance clones over https and unauthenticated, so a private repo needs a
# token in the URL or the clone fails silently into a dead service
if ($RepoUrl -match '^git@|^ssh://') {
  $RepoUrl = $RepoUrl -replace '^git@([^:]+):', 'https://$1/'
}
Write-Output "  repo $RepoUrl ($RepoBranch)"

# A private repository cloned without a token fails ON THE INSTANCE, long after
# CloudFormation has reported success -- you get a stack that built and a site
# that never answers. Find out here instead, while nothing has been created.
if (-not $GitHubToken -and $RepoUrl -match '^https://github\.com/') {
  $ErrorActionPreference = 'Continue'
  $probe = $null
  try {
    $api = ($RepoUrl -replace '^https://github\.com/', 'https://api.github.com/repos/') -replace '\.git$', ''
    $probe = Invoke-WebRequest -Uri $api -TimeoutSec 15 -UseBasicParsing
  } catch { $probe = $null }
  $ErrorActionPreference = 'Stop'
  if (-not $probe) {
    Write-Output ""
    Write-Output "  This repository is private (or unreachable) and no -GitHubToken was given."
    Write-Output "  The instance would clone nothing and the site would never answer."
    Write-Output ""
    Write-Output "  Make a fine-grained token with read access to it at"
    Write-Output "    https://github.com/settings/personal-access-tokens/new"
    Write-Output "  then re-run with:  -GitHubToken github_pat_..."
    throw "private repository needs -GitHubToken"
  }
}

# ---- 3. deploy ----
Write-Output "deploying $StackName ... (first run takes ~12 minutes; the database is most of it)"
Aws cloudformation deploy `
  --region $Region `
  --stack-name $StackName `
  --template-file $tpl `
  --capabilities CAPABILITY_IAM `
  --parameter-overrides `
    "DomainName=$DomainName" `
    "AdminCidr=$AdminCidr" `
    "InstanceType=$InstanceType" `
    "RepoUrl=$RepoUrl" `
    "RepoBranch=$RepoBranch" `
    "GitHubToken=$GitHubToken" `
  --no-fail-on-empty-changeset
if ($LASTEXITCODE -ne 0) {
  Write-Output ""
  Write-Output "Deploy failed. The reason is usually the last few events:"
  Aws cloudformation describe-stack-events --stack-name $StackName --region $Region `
    --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" `
    --output text | Select-Object -First 10
  throw "cloudformation deploy failed"
}

# ---- 4. what came out ----
$outs = Aws cloudformation describe-stacks --stack-name $StackName --region $Region `
  --query "Stacks[0].Outputs" --output json | ConvertFrom-Json
$get = { param($k) ($outs | Where-Object { $_.OutputKey -eq $k }).OutputValue }
$url = & $get 'Url'
$ip  = & $get 'PublicIp'

Write-Output ""
Write-Output "stack is up. Waiting for the app to answer -- the instance still has to"
Write-Output "install Node, clone the repo and get a certificate (~3 more minutes)."

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 15
  try {
    $r = Invoke-WebRequest -Uri "$url/api/health" -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { Write-Output "  ...not yet ($($i+1))" }
}

Write-Output ""
Write-Output "================================================================"
if ($ok) {
  Write-Output "  Chhaperia ERP is live:  $url"
} else {
  Write-Output "  The stack built, but the app has not answered yet."
  Write-Output "  URL:  $url"
  Write-Output "  Look at what the instance did:"
  Write-Output "    $(& $get 'ShellCommand')"
  Write-Output "    sudo tail -100 /var/log/chhaperia-setup.log"
}
Write-Output "  Public IP: $ip   (point your own DNS A record here)"
Write-Output "================================================================"
Write-Output ""
Write-Output "  DO THIS NOW, BEFORE TELLING ANYONE THE ADDRESS:"
Write-Output "  the eight seeded accounts still have their default passwords"
Write-Output "  (<username>@123). On the open internet that is an unlocked door."
Write-Output "  Sign in as admin, change it, then change every other account in"
Write-Output "  Users & Access."
Write-Output ""
Write-Output "  Consider also re-running with -AdminCidr <factory-ip>/32 so only"
Write-Output "  the works can reach it at all."
