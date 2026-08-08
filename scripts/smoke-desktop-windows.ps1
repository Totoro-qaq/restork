[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NsisInstaller,

    [Parameter(Mandatory = $true)]
    [string]$MsiInstaller,

    [string]$ArtifactDirectory = (Join-Path $env:RUNNER_TEMP 'restork-windows-e2e'),

    [switch]$RequireAuthenticode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BundleIdentifier = 'io.github.totoro-qaq.restork'
$DiagnosticsPath = Join-Path $env:LOCALAPPDATA "$BundleIdentifier\logs\desktop-events.jsonl"
$UserDataPath = Join-Path $env:APPDATA $BundleIdentifier
$SuccessExitCodes = @(0, 3010)

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($null -eq $resolved -or -not (Test-Path -LiteralPath $resolved.Path -PathType Leaf)) {
        throw "$Label was not found: $Path"
    }
    return $resolved.Path
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Condition,

        [int]$TimeoutSeconds = 30,

        [int]$PollMilliseconds = 250
    )

    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (& $Condition) {
            return $true
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
    return $false
}

function Invoke-CheckedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$ArgumentList = @(),

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru
    if ($SuccessExitCodes -notcontains $process.ExitCode) {
        throw "$Label failed with exit code $($process.ExitCode)"
    }
}

function Assert-Authenticode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not $RequireAuthenticode) {
        return
    }
    $signature = Get-AuthenticodeSignature -FilePath $Path
    if ($signature.Status -ne 'Valid') {
        throw "Authenticode validation failed for $Path with status $($signature.Status)"
    }
}

function Get-RestorkRegistryEntries {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    $entries = @()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }
        $entries += @(
            Get-ItemProperty -Path "$root\*" -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -eq 'Restork' } |
                Select-Object DisplayName, DisplayVersion, InstallLocation, DisplayIcon,
                    UninstallString, QuietUninstallString, PSChildName
        )
    }
    return @($entries)
}

function Resolve-RestorkExecutable {
    $candidates = [Collections.Generic.List[string]]::new()
    foreach ($entry in @(Get-RestorkRegistryEntries)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.InstallLocation)) {
            $candidates.Add((Join-Path ([string]$entry.InstallLocation) 'Restork.exe'))
            $candidates.Add((Join-Path ([string]$entry.InstallLocation) 'restork.exe'))
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$entry.DisplayIcon)) {
            $iconPath = ([string]$entry.DisplayIcon).Trim('"') -replace ',\d+$', ''
            $candidates.Add($iconPath)
        }
    }

    $knownRoots = @(
        (Join-Path $env:LOCALAPPDATA 'Restork'),
        (Join-Path $env:ProgramFiles 'Restork')
    )
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $knownRoots += (Join-Path ${env:ProgramFiles(x86)} 'Restork')
    }
    foreach ($root in $knownRoots) {
        $candidates.Add((Join-Path $root 'Restork.exe'))
        $candidates.Add((Join-Path $root 'restork.exe'))
    }

    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    throw 'The installed Restork executable could not be resolved from the registry or bounded install locations.'
}

function Get-DiagnosticLineCount {
    if (-not (Test-Path -LiteralPath $DiagnosticsPath -PathType Leaf)) {
        return 0
    }
    return @(Get-Content -LiteralPath $DiagnosticsPath).Count
}

function Test-NewDiagnosticEvent {
    param(
        [Parameter(Mandatory = $true)]
        [int]$StartLine,

        [Parameter(Mandatory = $true)]
        [string]$Event
    )

    if (-not (Test-Path -LiteralPath $DiagnosticsPath -PathType Leaf)) {
        return $false
    }
    $newLines = @(Get-Content -LiteralPath $DiagnosticsPath | Select-Object -Skip $StartLine)
    return $null -ne ($newLines | Where-Object { $_ -match ('"event":"' + [Regex]::Escape($Event) + '"') } | Select-Object -First 1)
}

function Get-OwnedCoreProcess {
    param(
        [Parameter(Mandatory = $true)]
        [int]$DesktopProcessId
    )

    return @(
        Get-CimInstance Win32_Process -Filter "Name = 'restorkd.exe'" -ErrorAction SilentlyContinue |
            Where-Object { [int]$_.ParentProcessId -eq $DesktopProcessId }
    )
}

function Save-Diagnostics {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DestinationDirectory
    )

    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    if (Test-Path -LiteralPath $DiagnosticsPath -PathType Leaf) {
        Copy-Item -LiteralPath $DiagnosticsPath -Destination (Join-Path $DestinationDirectory 'desktop-events.jsonl') -Force
    }
    @(Get-RestorkRegistryEntries) |
        ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $DestinationDirectory 'uninstall-registry.json') -Encoding utf8
    @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -in @('Restork.exe', 'restork.exe', 'restorkd.exe') } |
            Select-Object Name, ProcessId, ParentProcessId, ExecutablePath
    ) |
        ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $DestinationDirectory 'processes.json') -Encoding utf8
}

function Invoke-Install {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('nsis', 'msi')]
        [string]$Kind,

        [Parameter(Mandatory = $true)]
        [string]$InstallerPath,

        [Parameter(Mandatory = $true)]
        [string]$CaseDirectory
    )

    if ($Kind -eq 'nsis') {
        Invoke-CheckedProcess -FilePath $InstallerPath -ArgumentList @('/S') -Label 'NSIS install'
        return
    }
    $installLog = Join-Path $CaseDirectory 'msi-install.log'
    Invoke-CheckedProcess -FilePath 'msiexec.exe' -ArgumentList @(
        '/i', ('"' + $InstallerPath + '"'), '/qn', '/norestart',
        '/L*V', ('"' + $installLog + '"')
    ) -Label 'MSI install'
}

function Invoke-Uninstall {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('nsis', 'msi')]
        [string]$Kind,

        [Parameter(Mandatory = $true)]
        [string]$InstallerPath,

        [Parameter(Mandatory = $true)]
        [string]$CaseDirectory
    )

    if ($Kind -eq 'nsis') {
        $uninstaller = Join-Path $env:LOCALAPPDATA 'Restork\uninstall.exe'
        if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
            throw "NSIS uninstaller was not found: $uninstaller"
        }
        Invoke-CheckedProcess -FilePath $uninstaller -ArgumentList @('/S') -Label 'NSIS uninstall'
        return
    }
    $uninstallLog = Join-Path $CaseDirectory 'msi-uninstall.log'
    Invoke-CheckedProcess -FilePath 'msiexec.exe' -ArgumentList @(
        '/x', ('"' + $InstallerPath + '"'), '/qn', '/norestart',
        '/L*V', ('"' + $uninstallLog + '"')
    ) -Label 'MSI uninstall'
}

function Test-InstallerLifecycle {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('nsis', 'msi')]
        [string]$Kind,

        [Parameter(Mandatory = $true)]
        [string]$InstallerPath
    )

    $caseDirectory = Join-Path $ArtifactDirectory $Kind
    New-Item -ItemType Directory -Force -Path $caseDirectory | Out-Null
    $desktopProcess = $null
    $installed = $false
    $uninstalled = $false
    $executable = $null
    $coreProcessId = $null
    $sentinel = Join-Path $UserDataPath "clean-machine-$Kind-sentinel.txt"

    try {
        Assert-Authenticode -Path $InstallerPath
        $diagnosticStartLine = Get-DiagnosticLineCount
        Invoke-Install -Kind $Kind -InstallerPath $InstallerPath -CaseDirectory $caseDirectory
        $installed = $true

        $executable = Resolve-RestorkExecutable
        $desktopProcess = Start-Process -FilePath $executable -PassThru

        $ready = Wait-Until -TimeoutSeconds 45 -Condition {
            $desktopProcess.Refresh()
            if ($desktopProcess.HasExited) {
                throw "Restork exited before becoming ready during the $Kind lifecycle test."
            }
            return (Test-NewDiagnosticEvent -StartLine $diagnosticStartLine -Event 'browser_session_stored')
        }
        if (-not $ready) {
            throw "Restork did not complete Core readiness and browser pairing for the $Kind package."
        }

        $ownedCore = @(Get-OwnedCoreProcess -DesktopProcessId $desktopProcess.Id)
        if ($ownedCore.Count -ne 1) {
            throw "Expected exactly one restorkd.exe owned by Restork.exe; observed $($ownedCore.Count)."
        }
        $coreProcessId = [int]$ownedCore[0].ProcessId

        Stop-Process -Id $desktopProcess.Id -Force
        if (-not (Wait-Until -TimeoutSeconds 15 -Condition {
            return $null -eq (Get-Process -Id $coreProcessId -ErrorAction SilentlyContinue)
        })) {
            throw "The owned Core process $coreProcessId survived its desktop owner."
        }

        New-Item -ItemType Directory -Force -Path $UserDataPath | Out-Null
        Set-Content -LiteralPath $sentinel -Value 'preserve' -Encoding ascii
        Invoke-Uninstall -Kind $Kind -InstallerPath $InstallerPath -CaseDirectory $caseDirectory
        $uninstalled = $true

        if (-not (Wait-Until -TimeoutSeconds 15 -Condition {
            return -not (Test-Path -LiteralPath $executable -PathType Leaf)
        })) {
            throw "$Kind uninstall left the application executable behind: $executable"
        }
        if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) {
            throw "$Kind uninstall removed user data without an explicit preservation choice."
        }

        return [PSCustomObject]@{
            package = $Kind
            executable = $executable
            desktop_process_id = $desktopProcess.Id
            core_process_id = $coreProcessId
            ready_event = 'browser_session_stored'
            core_reclaimed = $true
            executable_removed = $true
            user_data_preserved = $true
        }
    }
    finally {
        if ($null -ne $desktopProcess -and -not $desktopProcess.HasExited) {
            Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
        }
        if ($null -ne $coreProcessId) {
            Stop-Process -Id $coreProcessId -Force -ErrorAction SilentlyContinue
        }
        Save-Diagnostics -DestinationDirectory $caseDirectory
        if ($installed -and -not $uninstalled) {
            try {
                Invoke-Uninstall -Kind $Kind -InstallerPath $InstallerPath -CaseDirectory $caseDirectory
            }
            catch {
                $_ | Out-String | Set-Content -LiteralPath (Join-Path $caseDirectory 'cleanup-error.txt') -Encoding utf8
            }
        }
    }
}

$NsisInstaller = Resolve-ExistingFile -Path $NsisInstaller -Label 'NSIS installer'
$MsiInstaller = Resolve-ExistingFile -Path $MsiInstaller -Label 'MSI installer'
New-Item -ItemType Directory -Force -Path $ArtifactDirectory | Out-Null

try {
    $results = @(
        Test-InstallerLifecycle -Kind 'nsis' -InstallerPath $NsisInstaller
        Test-InstallerLifecycle -Kind 'msi' -InstallerPath $MsiInstaller
    )
    $report = [PSCustomObject]@{
        schema_version = 1
        status = 'passed'
        windows_version = [Environment]::OSVersion.VersionString
        results = $results
    }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ArtifactDirectory 'report.json') -Encoding utf8
    Write-Host 'Windows clean-machine smoke passed for NSIS and MSI: install, launch, Core ownership, owner-loss cleanup, uninstall, and user-data preservation.'
}
catch {
    $_ | Out-String | Set-Content -LiteralPath (Join-Path $ArtifactDirectory 'failure.txt') -Encoding utf8
    throw
}
