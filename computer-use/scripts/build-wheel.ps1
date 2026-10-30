# Build the wheel and print the sha256 the installer constant needs.
#
#   pwsh ./scripts/build-wheel.ps1
#
# Produces dist/computeruse_mcp-<version>-py3-none-any.whl, prints its size and
# sha256 (paste that into WHEEL_SHA256 in the installer), and does NOT publish
# anything. Packaging is a release step gated on a human.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        $uv = "uv"
    } else {
        $candidates = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\*\Scripts\uv.exe" -ErrorAction SilentlyContinue
        if (-not $candidates) {
            Write-Error "uv not found. Install it with: winget install astral-sh.uv"
            exit 1
        }
        $uv = $candidates[-1].FullName
    }

    & $uv build
    if ($LASTEXITCODE -ne 0) { Write-Error "uv build failed ($LASTEXITCODE)"; exit 1 }

    $wheel = Get-ChildItem "dist\*.whl" | Sort-Object LastWriteTime | Select-Object -Last 1
    if (-not $wheel) { Write-Error "no wheel in dist/"; exit 1 }

    $hash = (Get-FileHash $wheel.FullName -Algorithm SHA256).Hash.ToLower()
    Write-Host ""
    Write-Host "wheel:  $($wheel.FullName)"
    Write-Host "bytes:  $($wheel.Length)"
    Write-Host "sha256: $hash"
    Write-Host ""
    Write-Host "Installer constants:"
    Write-Host "  WHEEL_NAME   = $($wheel.Name)"
    Write-Host "  WHEEL_SHA256 = $hash"
} finally {
    Pop-Location
}
