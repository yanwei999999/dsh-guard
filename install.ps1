# dsh-guard installer (PowerShell)
#
# 1) Copies dsh-guard to ~/.dsh/tools/dsh-guard, installs its one dependency
#    (js-yaml) there with npm, and adds it to the user PATH.
# 2) Optional: installs a `dsh` function in the PowerShell $PROFILE so that
#    typing `dsh web` automatically goes through the startup watchdog.
#
# Usage:
#   .\install.ps1                      install the `dsh-guard` command only
#   .\install.ps1 -InstallProfile      also alias `dsh` so `dsh web` is guarded
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -InstallProfile
#
# Alternative (npm global install, no script needed):
#   npm install -g dsh-guard

param(
    [switch]$InstallProfile
)

$ErrorActionPreference = 'Stop'

$src  = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:USERPROFILE '.dsh\tools\dsh-guard'

Write-Host "[dsh-guard] source dir : $src"
Write-Host "[dsh-guard] install dir: $dest"

# 1) copy files
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($f in @('dsh-guard.mjs', 'dsh-guard.cmd', 'package.json', 'README.md', 'LICENSE')) {
    if (Test-Path (Join-Path $src $f)) { Copy-Item -Force (Join-Path $src $f) $dest }
}

# 2) install the dependency (js-yaml) inside the install dir
Write-Host "[dsh-guard] installing dependencies (npm) ..."
Push-Location $dest
try {
    npm install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# 3) add to the persistent user PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -and ($userPath.Split(';') -contains $dest)) {
    Write-Host "[dsh-guard] PATH already contains the install dir; skipping."
} else {
    $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $dest } else { $dest }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    $env:Path = ($env:Path.TrimEnd(';') + ';' + $dest)
    Write-Host "[dsh-guard] added to the user PATH (takes effect in a new terminal)."
}

Write-Host "[dsh-guard] installed. Usage:"
Write-Host "    dsh-guard web               guarded launch (disables the bad plugin and retries)"
Write-Host "    dsh-guard snapshot web      mark current config as known-good"
Write-Host "    dsh-guard restore web       hard roll back to the snapshot (removes plugins added after it)"
Write-Host "    dsh-guard status web        show current config vs snapshot"

# 4) optional: install a `dsh` alias in BOTH Windows PowerShell 5.1 and pwsh 7+
if ($InstallProfile) {
    $block = @'
# === dsh-guard alias (auto rollback on boot failure) ===
# Makes `dsh web` (and tui/headless) go through the startup watchdog, which
# disables the offending plugin (keeps it downloaded) when boot fails.
function global:dsh {
    if ($args.Count -ge 1 -and ($args[0] -in @('web','tui','headless'))) {
        & node (Join-Path $env:USERPROFILE '.dsh\tools\dsh-guard\dsh-guard.mjs') @args
    } else {
        & dsh.cmd @args
    }
}
'@
    $marker = '# === dsh-guard alias (auto rollback on boot failure) ==='
    $profilePaths = @(
        (Join-Path $env:USERPROFILE 'Documents\WindowsPowerShell\profile.ps1'),
        (Join-Path $env:USERPROFILE 'Documents\PowerShell\profile.ps1')
    )
    foreach ($profilePath in $profilePaths) {
        $profileDir = Split-Path -Parent $profilePath
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
        if (-not (Test-Path $profilePath)) { New-Item -ItemType File -Force -Path $profilePath | Out-Null }
        $existing = if (Test-Path $profilePath) { Get-Content -Raw -Path $profilePath } else { '' }
        if ($existing -like "*$marker*") {
            Write-Host "[dsh-guard] alias already present in $profilePath; skipping."
        } else {
            Add-Content -Path $profilePath -Value $block
            Write-Host "[dsh-guard] installed dsh alias in $profilePath."
        }
    }
    Write-Host "[dsh-guard] after reopening the terminal, `dsh web` is guarded automatically."
} else {
    Write-Host "[dsh-guard] tip: to keep typing `dsh web` instead of `dsh-guard web`, re-run with -InstallProfile."
}
