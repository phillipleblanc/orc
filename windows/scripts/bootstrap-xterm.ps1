# Downloads checksum-pinned xterm.js packages for the app's terminal page into -Destination.
# Runs on Windows PowerShell 5.1. The core build is the one the runtime's @xterm/headless matches
# (slim/frontend/package.json), so snapshots replay exactly.
param([Parameter(Mandatory = $true)][string]$Destination)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$packages = @(
    @{ Name = 'xterm';           Url = 'https://registry.npmjs.org/@xterm/xterm/-/xterm-6.1.0-beta.302.tgz';
       Integrity = 'yTlcgFDNe0ZE7U1RA1JX9oZkVOE8gKvLLh55tMHrS3/ZHkJCOWHlC0mFt3GYyWChSQ1XF+VY0iIme7ZktSaMRA==';
       Files = @('lib/xterm.js', 'css/xterm.css', 'LICENSE') },
    @{ Name = 'addon-unicode11'; Url = 'https://registry.npmjs.org/@xterm/addon-unicode11/-/addon-unicode11-0.10.0-beta.299.tgz';
       Integrity = 'BShRMWsKqoHs9fm0L96zjC4Du5L19bvmdZffm5LPKLbVWUAZj7cjjbpXuFU9FsITIJlvjTqeNfq1vulv60zRDA==';
       Files = @('lib/addon-unicode11.js') },
    @{ Name = 'addon-webgl';     Url = 'https://registry.npmjs.org/@xterm/addon-webgl/-/addon-webgl-0.20.0-beta.298.tgz';
       Integrity = '65jZWGSV3nu2jVyc/r2H31Q+oXnDX8IhcSquREVlDjqmfOINXhAufBj2zcK6BCgYT0jrdx7y64VFgVcQ3vAkRA==';
       Files = @('lib/addon-webgl.js') }
)

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('orc-xterm-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $Destination | Out-Null
try {
    foreach ($package in $packages) {
        $dir = Join-Path $work $package.Name
        New-Item -ItemType Directory -Force $dir | Out-Null
        $archive = Join-Path $dir 'package.tgz'
        Invoke-WebRequest -UseBasicParsing -Uri $package.Url -OutFile $archive
        $sha = [System.Security.Cryptography.SHA512]::Create()
        $actual = [Convert]::ToBase64String($sha.ComputeHash([System.IO.File]::ReadAllBytes($archive)))
        if ($actual -ne $package.Integrity) { throw "Checksum mismatch for $($package.Url)" }
        & tar.exe -xzf $archive -C $dir
        if ($LASTEXITCODE -ne 0) { throw "Cannot extract $archive" }
        foreach ($file in $package.Files) {
            $name = Split-Path $file -Leaf
            if ($name -eq 'LICENSE') { $name = "LICENSE-$($package.Name)" }
            Copy-Item (Join-Path $dir ('package/' + $file)) (Join-Path $Destination $name) -Force
        }
        Write-Host "xterm.js: $($package.Name) verified"
    }
}
finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
