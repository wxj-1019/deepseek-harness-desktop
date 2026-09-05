# Smoke-test one built DSH Desktop installer: silent-install it into a throwaway
# directory, launch the app, and require the real host window (not the recovery
# assistant) to survive the renderer boot-health window. Exit 0 = pass.
#
# Usage: powershell -File smoke-install.ps1 -Installer <path-to-Setup.exe> [-WorkDir <dir>]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$WorkDir = (Join-Path $env:TEMP ("dsh-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8)))
)

$ErrorActionPreference = 'Stop'
$installerItem = Get-Item $Installer
if ($installerItem -eq $null) { throw "installer not found: $Installer" }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$installDir = Join-Path $WorkDir 'app'
$appExe = Join-Path $installDir 'DSH Desktop.exe'

# Dump the desktop's own logs (the fastest signal for a failed Host startup).
function Dump-DesktopLogs {
  $candidates = @(
    (Join-Path $env:APPDATA 'DSH Desktop\logs'),
    (Join-Path $env:APPDATA 'DSH Desktop')
  )
  foreach ($dir in $candidates) {
    if (Test-Path $dir) {
      Write-Host "[smoke][logs] --- $dir ---"
      Get-ChildItem $dir -Filter '*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 2 | ForEach-Object {
        Write-Host "[smoke][logs] $($_.Name) (last writes):"
        Get-Content $_.FullName -Tail 50 -ErrorAction SilentlyContinue |
          ForEach-Object { Write-Host "[smoke][logs]   $_" }
      }
      return
    }
  }
  Write-Host "[smoke][logs] no desktop log directory found under APPDATA"
}

Write-Host "[smoke] installer: $($installerItem.FullName)"
Write-Host "[smoke] install dir: $installDir"

# 1. Silent install into the throwaway directory. NSIS /D must be the last
#    argument and unquoted even when the path contains spaces.
$setup = Start-Process -FilePath $installerItem.FullName -ArgumentList "/S", "/D=$installDir" -Wait -PassThru
Write-Host "[smoke] installer exit code: $($setup.ExitCode)"
if ($setup.ExitCode -ne 0) { throw "installer exited with $($setup.ExitCode)" }
if (-not (Test-Path $appExe)) { throw "app executable was not installed at $appExe" }
$version = (Get-Item $appExe).VersionInfo.ProductVersion
Write-Host "[smoke] installed version: $version"

# 2. Launch the app with an isolated user-data home so runs never share state.
$home_dir = Join-Path $WorkDir 'home'
New-Item -ItemType Directory -Force -Path $home_dir | Out-Null
$env:DSH_DESKTOP_SMOKE = '1'
$app = Start-Process -FilePath $appExe -WorkingDirectory $installDir -PassThru
Write-Host "[smoke] app pid: $($app.Id)"

# 3. Probe for up to 60 seconds: the host process must stay alive and a real
#    main window (not the recovery assistant) must appear.
$deadline = (Get-Date).AddSeconds(60)
$mainWindow = $null
$recoverySeen = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  $alive = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
  if ($alive -eq $null) {
    throw "app process exited before reporting a window (crashed or failed boot)"
  }
  $windows = Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -ne '' }
  $recovery = $windows | Where-Object { $_.MainWindowTitle -like '*Recovery*' }
  if ($recovery) { $recoverySeen = $true }
  $mainWindow = $windows | Where-Object { $_.MainWindowTitle -notlike '*Recovery*' } |
    Select-Object -First 1
  if ($mainWindow -ne $null) { break }
}

if ($mainWindow -eq $null) {
  Dump-DesktopLogs
  if ($recoverySeen) {
    throw "recovery assistant appeared instead of the main window (Host startup failed)"
  }
  throw "no main window appeared within 60s"
}
Write-Host "[smoke] main window: '$($mainWindow.MainWindowTitle)'"

# 4. Give the renderer a moment, require the process tree to still be alive,
#    then tear everything down.
Start-Sleep -Seconds 10
$stillAlive = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
if ($stillAlive -eq $null) { throw "app process exited after the window appeared" }
Write-Host "[smoke] app survived post-boot settle"

Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "[smoke] PASS"
exit 0
