[CmdletBinding()]
param([switch]$Cpu, [switch]$Probe, [switch]$FirefoxBridge)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$state = Join-Path $PSScriptRoot 'data'
$keyPath = Join-Path $state 'connection-code.txt'
$bridgePath = Join-Path $PSScriptRoot 'firefox-bridge.bat'

if ($FirefoxBridge) {
    # Firefox frames each UTF-8 JSON message with a 32-bit byte length.
    $request = '{"protocol":1}'
    $reader = [IO.BinaryReader]::new([Console]::OpenStandardInput())
    if ($reader.ReadInt32() -ne $request.Length) { return }
    if ([Text.Encoding]::UTF8.GetString($reader.ReadBytes($request.Length)) -cne $request) { return }
    $reply = @{ protocol = 1 }
    if ((Test-Path -LiteralPath $keyPath -PathType Leaf) -and (Get-Item -LiteralPath $keyPath).Length -le 128) {
        $code = ([string](Get-Content -LiteralPath $keyPath -Raw)).Trim()
        if ($code -match '^[a-fA-F0-9]{64}\z') { $reply.token = $code }
    }
    $payload = [Text.Encoding]::UTF8.GetBytes(($reply | ConvertTo-Json -Compress))
    $writer = [IO.BinaryWriter]::new([Console]::OpenStandardOutput())
    $writer.Write([int]$payload.Length)
    $writer.Write($payload)
    $writer.Flush()
    return
}
$modelName = 'PageLingo-Translate-1.8B-v0.2.2-Q5_K_M.gguf'
$modelHash = '8f8734198ad9332db97101de3ae7216daa3b59218522c4e0beebdfb4999924cc'
$modelAlias = 'pagelingo-mt-v0.2.2-q5km'
$port = 18731
$modelsUrl = "http://127.0.0.1:$port/v1/models"
$model = Join-Path $workspace "models\pagelingo-hymt-1.8b-v0.2.2-gguf\$modelName"
if (-not (Test-Path -LiteralPath $model -PathType Leaf)) {
    $model = Join-Path $PSScriptRoot $modelName
}
$vulkanAvailable = Test-Path -LiteralPath (Join-Path $env:WINDIR 'System32\vulkan-1.dll') -PathType Leaf

if ($Probe) {
    Write-Output ([PSCustomObject]@{
        ModelFound = (Test-Path -LiteralPath $model -PathType Leaf)
        VulkanLoader = $vulkanAvailable
        FirefoxBridgePresent = (Test-Path -LiteralPath $bridgePath -PathType Leaf)
        Endpoint = $modelsUrl
    } | ConvertTo-Json -Compress)
    return
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'This launcher uses the Windows x64 llama.cpp binaries.'
}
if (-not (Test-Path -LiteralPath $model -PathType Leaf)) {
    throw "Model not found. Put $modelName beside this launcher or in the project model directory."
}
if ((Get-Item -LiteralPath $model).Length -ne 1298755616 -or (Get-FileHash -LiteralPath $model -Algorithm SHA256).Hash -ne $modelHash) {
    throw 'The GGUF file does not match the supported PageLingo MT release.'
}

New-Item -ItemType Directory -Path $state -Force | Out-Null
if (-not (Test-Path -LiteralPath $keyPath)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $value = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    [IO.File]::WriteAllText($keyPath, $value, [Text.Encoding]::ASCII)
}
$key = (Get-Content -LiteralPath $keyPath -Raw).Trim()
if ($key -notmatch '^[a-fA-F0-9]{64}\z') {
    throw 'The connection-code file is invalid.'
}
$headers = @{ Authorization = "Bearer $key" }

function Register-FirefoxBridge {
    if (-not (Test-Path -LiteralPath $bridgePath -PathType Leaf)) { throw 'firefox-bridge.bat is missing from the launcher folder.' }
    $hostName = 'org.pagelingo.mt'
    $manifestPath = Join-Path $state "$hostName.json"
    $manifest = @{
        name = $hostName
        description = 'PageLingo MT local connection'
        path = $bridgePath
        type = 'stdio'
        allowed_extensions = @('pagelingo@kerberos255')
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($manifestPath, $manifest)
    $registration = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
    New-Item -Path $registration -Force | Out-Null
    Set-Item -LiteralPath $registration -Value $manifestPath
}

function Test-Ready {
    try {
        $reply = Invoke-RestMethod -Uri $modelsUrl -Headers $headers -TimeoutSec 2 -MaximumRedirection 0
        return @($reply.data | Where-Object { $_.id -eq $modelAlias }).Count -gt 0
    } catch { return $false }
}

function Get-Binary([string]$backend) {
    $target = Join-Path $state "llama-b11785-$backend"
    $binary = Join-Path $target 'llama-server.exe'
    $verified = Join-Path $target 'archive.sha256'
    $hash = @{
        cpu = 'c59e0d3e31e096b728b94e943d3ca60df42912c34cba33489d520daab775c6fd'
        vulkan = '77445cf9d79347a23cf78775d513913798bd173a1168de192a41454dc8e10e67'
    }[$backend]
    if ((Test-Path -LiteralPath $binary -PathType Leaf) -and (Test-Path -LiteralPath $verified -PathType Leaf) -and
        (Get-Content -LiteralPath $verified -Raw).Trim() -eq $hash) { return $binary }
    $asset = "llama-b11785-bin-win-$backend-x64.zip"
    $zip = Join-Path $state ('download-' + [Guid]::NewGuid().ToString('N') + '.zip')
    try {
        Write-Host "Downloading official llama.cpp $backend runtime..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/ggml-org/llama.cpp/releases/download/b11785/$asset" -OutFile $zip -TimeoutSec 180
        if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $hash) { throw 'llama.cpp archive SHA-256 mismatch.' }
        Expand-Archive -LiteralPath $zip -DestinationPath $target -Force
        if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'llama-server.exe is missing from its archive.' }
        [IO.File]::WriteAllText($verified, $hash, [Text.Encoding]::ASCII)
        return $binary
    } finally {
        if (Test-Path -LiteralPath $zip -PathType Leaf) { Remove-Item -LiteralPath $zip }
    }
}

function Start-Backend([string]$backend) {
    $exe = Get-Binary $backend
    $gpu = $backend -eq 'vulkan'
    $slots = if ($gpu) { 4 } else { 1 }
    $layers = if ($gpu) { 999 } else { 0 }
    $threads = [Math]::Max(1, [Math]::Min(8, [Math]::Floor([Environment]::ProcessorCount / 2)))
    $stdout = Join-Path $state "$backend-output.log"
    $stderr = Join-Path $state "$backend-errors.log"
    $args = @(
        '-m', ('"' + $model + '"'), '--alias', $modelAlias, '--api-key-file', ('"' + $keyPath + '"'),
        '--host', '127.0.0.1', '--port', $port, '-np', $slots, '-c', ($slots * 3072),
        '-t', $threads, '-ngl', $layers, '--fit', 'off', '--cache-ram', '0',
        '--no-webui', '--no-warmup', '--log-colors', 'off'
    )
    $process = Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory (Split-Path -Parent $exe) -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    try {
        $deadline = (Get-Date).AddSeconds(120)
        while ((Get-Date) -lt $deadline -and -not $process.HasExited) {
            if (Test-Ready) {
                $offload = if ($gpu) {
                    Select-String -LiteralPath @($stderr, $stdout) -Pattern 'offloaded\s+[1-9]\d*\s*/\s*\d+\s+layers\s+to\s+GPU' | Select-Object -First 1
                }
                if ($gpu -and -not $offload) { throw 'Vulkan started without offloading model layers.' }
                if ($offload) { Write-Host $offload.Line.Trim() }
                Write-Host "READY ($backend) http://127.0.0.1:$port"
                Write-Host 'In PageLingo settings, select Translation Engines > Local acceleration > Connect.'
                Write-Host 'Keep this window running while using PageLingo MT. Ctrl+C stops the service.'
                $process.WaitForExit()
                if ($process.ExitCode -ne 0) { throw "llama.cpp exited with code $($process.ExitCode). See $stderr" }
                return
            }
            Start-Sleep -Milliseconds 500
        }
        throw "llama.cpp did not become ready. See $stderr"
    } finally {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    }
}

Register-FirefoxBridge
if (Test-Ready) {
    Write-Host "PageLingo MT is already running at http://127.0.0.1:$port"
    Write-Host 'In PageLingo settings, select Translation Engines > Local acceleration > Connect.'
    return
}
if (-not $Cpu -and $vulkanAvailable) {
    try {
        Start-Backend 'vulkan'
        return
    } catch {
        Write-Host "Vulkan is unavailable. Starting CPU. $($_.Exception.Message)"
    }
}
Start-Backend 'cpu'
