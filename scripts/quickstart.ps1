[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int]$Port = 0,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RestorkArguments
)

$ErrorActionPreference = 'Stop'
$restorkRoot = Split-Path -Parent $PSScriptRoot

if ($env:RESTORK_PORT) {
    $parsedPort = 0
    if (-not [int]::TryParse($env:RESTORK_PORT, [ref]$parsedPort) -or $parsedPort -lt 0 -or $parsedPort -gt 65535) {
        throw 'RESTORK_PORT must be an integer from 0 to 65535.'
    }
    $Port = $parsedPort
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Restork needs Rust via rustup. Install the x86_64-pc-windows-msvc toolchain from https://rustup.rs. / Restork 需要通过 rustup 安装 x86_64-pc-windows-msvc 工具链。'
}

Push-Location $restorkRoot
try {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        & node scripts/windows-toolchain.mjs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } else {
        $rustcDetails = (& rustc -vV) -join "`n"
        $hostLine = ($rustcDetails -split "`n" | Where-Object { $_ -like 'host: *' } | Select-Object -First 1)
        $hostTriple = if ($hostLine) { $hostLine.Substring(6).Trim() } else { '' }
        if ($hostTriple -notmatch '^(x86_64|aarch64)-pc-windows-msvc$' -or $env:CARGO_BUILD_TARGET -match 'pc-windows-(gnu|gnullvm)') {
            throw @"
Restork stopped before compiling because Windows is not using MSVC Rust.
Restork 已在编译前停止：Windows 当前没有使用 MSVC Rust。
Do not install as.exe, dlltool, or MinGW. Run:
不要继续安装 as.exe、dlltool 或 MinGW，请执行：
  rustup toolchain install 1.97.1-x86_64-pc-windows-msvc --profile minimal
  rustup default 1.97.1-x86_64-pc-windows-msvc
  rustup override unset
  Remove-Item Env:CARGO_BUILD_TARGET -ErrorAction SilentlyContinue
"@
        }
    }

    if (Get-Command npm -ErrorAction SilentlyContinue) {
        Write-Host 'Building the Dashboard… / 正在构建 Dashboard…'
        & npm --prefix dashboard ci --silent
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & npm --prefix dashboard run build --silent
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } else {
        Write-Warning 'npm is unavailable; using the committed Dashboard bundle. / 未找到 npm，将使用仓库内已构建的 Dashboard。'
    }

    Write-Host 'Building the Restork Core… / 正在构建 Restork Core…'
    & cargo build --release --locked --manifest-path rust/Cargo.toml -p restorkd
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host ''
    Write-Host 'Open the Dashboard URL below and enter the Web pairing code.'
    Write-Host '请打开下方 Dashboard 地址并输入 Web 配对码；按 Ctrl-C 停止。'
    $binary = Join-Path $restorkRoot 'rust/target/release/restorkd.exe'
    & $binary serve --port $Port @RestorkArguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
