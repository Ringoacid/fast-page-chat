param([switch]$DeleteData)
$ErrorActionPreference = 'Stop'
$basePath = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'FastPageChat'))
$appPath = [IO.Path]::GetFullPath((Join-Path $basePath 'app'))
$dataPath = [IO.Path]::GetFullPath((Join-Path $basePath 'data'))
foreach ($target in @($appPath, $dataPath)) {
  if (-not $target.StartsWith($basePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe uninstall path.' }
}
$tokenPath = Join-Path $dataPath 'connection-key.txt'
if (Test-Path -LiteralPath $tokenPath) {
  $token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
  $health = $null
  try { $health = Invoke-RestMethod 'http://127.0.0.1:4318/health' -Headers @{Authorization="Bearer $token"} -TimeoutSec 2 } catch { }
  if ($health -and $health.app -eq 'fast-page-chat' -and $health.protocolVersion -eq 1) {
    Invoke-RestMethod -Method Post 'http://127.0.0.1:4318/shutdown' -Headers @{Authorization="Bearer $token"} -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
    Start-Sleep -Milliseconds 800
  }
}
$registry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fastpagechat.bridge'
if (Test-Path -LiteralPath $registry) {
  $registered = (Get-Item -LiteralPath $registry).GetValue('')
  if ($registered -eq (Join-Path $appPath 'native-host.json')) { Remove-Item -LiteralPath $registry -Force }
}
if (Test-Path -LiteralPath $appPath) { Remove-Item -LiteralPath $appPath -Recurse -Force }
if ($DeleteData -and (Test-Path -LiteralPath $dataPath)) { Remove-Item -LiteralPath $dataPath -Recurse -Force }
Write-Output 'Removed the helper. Browser history is managed separately in the extension.'
