# Start Docker Desktop on Windows when it keeps crashing with
#   "initializing Inference manager ... remove ...\Docker\run\dockerInference: The file cannot be accessed by the system"
#   "initializing Secrets Engine ... remove ...\docker-secrets-engine\engine.sock: The file cannot be accessed by the system"
# On this machine Docker Desktop cannot delete its own leftover unix-socket files on restart, so every
# start after a stop crashes into the "Quit / Reset to factory defaults" dialog. Do NOT pick reset.
# Moving the two socket folders aside before starting avoids the crash. Nothing is deleted.
$ErrorActionPreference = "Stop"

Get-Process -Name "Docker Desktop", "com.docker.backend", "com.docker.build" -ErrorAction SilentlyContinue |
    Stop-Process -Force -Confirm:$false
Start-Sleep -Seconds 2

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$aside = Join-Path $env:LOCALAPPDATA "docker-stale-sockets\$stamp"
foreach ($dir in @((Join-Path $env:LOCALAPPDATA "Docker\run"), (Join-Path $env:LOCALAPPDATA "docker-secrets-engine"))) {
    if (Test-Path $dir) {
        New-Item -ItemType Directory -Force -Path $aside | Out-Null
        $target = Join-Path $aside ((Split-Path $dir -Parent | Split-Path -Leaf) + "_" + (Split-Path $dir -Leaf))
        Move-Item -Path $dir -Destination $target
        "moved $dir -> $target"
    }
}

Start-Process -FilePath "C:\Program Files\Docker\Docker\Docker Desktop.exe"
for ($i = 0; $i -lt 36; $i++) {
    Start-Sleep -Seconds 5
    $v = wsl.exe -d Ubuntu -- bash -c 'docker compose version --short 2>/dev/null'
    if ($LASTEXITCODE -eq 0 -and $v) { "Docker is up and Ubuntu can use it (compose $v) after ~$(($i + 1) * 5)s"; exit 0 }
}
"Docker did not become usable from Ubuntu within 3 minutes"
exit 1
