# Builds Orc for Windows and installs it for the current user, in %LOCALAPPDATA%\Programs\Orc with a Start menu
# shortcut. Run it again to update. Close Orc first; it is not stopped for you. Runs on Windows PowerShell 5.1.
param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Orc'))

$ErrorActionPreference = 'Stop'
$windows = Split-Path $PSScriptRoot
$output = Join-Path $windows 'out\install\'

$running = Get-Process Orc -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Destination, [StringComparison]::OrdinalIgnoreCase) }
if ($running) { throw "Orc is running from $Destination. Close it, then run this again." }
# The copy mirrors the build into the destination, so it must be Orc's own folder.
if ((Test-Path $Destination) -and (Get-ChildItem $Destination -Force | Select-Object -First 1) -and -not (Test-Path (Join-Path $Destination 'Orc.exe'))) {
    throw "$Destination is not empty and holds no Orc.exe; choose an empty folder or an earlier install."
}

$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
if (-not $dotnet) { $dotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe' }
& $dotnet build (Join-Path $windows 'src\Orc.App\Orc.App.csproj') -c Release -nologo -v q "-p:BaseOutputPath=$output"
if ($LASTEXITCODE -ne 0) { throw 'The build failed.' }
$app = Join-Path $output 'Release\net10.0-windows10.0.26100.0\win-x64'

New-Item -ItemType Directory -Force $Destination | Out-Null
robocopy $app $Destination /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the app to $Destination failed (robocopy $LASTEXITCODE)." }

$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Orc.lnk'
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
$link.TargetPath = Join-Path $Destination 'Orc.exe'
$link.WorkingDirectory = $Destination
$link.IconLocation = Join-Path $Destination 'Assets\AppIcon.ico'
$link.Description = 'View and drive the Orc sessions on your Mac'
$link.Save()
"Installed Orc in $Destination, with a Start menu shortcut."
# Robocopy's codes below 8 mean success.
exit 0
