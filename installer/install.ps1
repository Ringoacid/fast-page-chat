param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'FastPageChat\app'),
  [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'FastPageChat\data'),
  [string]$ExtensionId = '',
  [switch]$NoRegister
)
$ErrorActionPreference = 'Stop'
$payload = Join-Path $PSScriptRoot 'app'
if (-not (Test-Path -LiteralPath (Join-Path $payload 'runtime\node.exe'))) { throw 'The installation package is incomplete.' }
if (-not $ExtensionId) { $ExtensionId = (Get-Content -Raw -LiteralPath (Join-Path $payload 'installer\extension-identity.json') | ConvertFrom-Json).extensionId }
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Invalid Chrome extension ID.' }
$installPath = [IO.Path]::GetFullPath($InstallRoot)
$dataPath = [IO.Path]::GetFullPath($DataRoot)
if ($installPath -eq [IO.Path]::GetPathRoot($installPath) -or $installPath -eq $dataPath -or $dataPath.StartsWith($installPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Application and user data directories must be separate.' }
# Stop only a bridge that proves possession of this installation's secret.
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
New-Item -ItemType Directory -Path $installPath -Force | Out-Null
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
# Restrict authentication files to the current Windows account and SYSTEM.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $dataPath -AclObject $acl
Get-ChildItem -LiteralPath $payload -Force | Copy-Item -Destination $installPath -Recurse -Force
$manifest = @{name='com.fastpagechat.bridge';description='Fast Page Chat local connection';path=(Join-Path $installPath 'FastPageChatHost.exe');type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")}
$manifestFile = Join-Path $installPath 'native-host.json'
[IO.File]::WriteAllText($manifestFile, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $installPath 'runtime-data-path.txt'), $dataPath, (New-Object Text.UTF8Encoding($false)))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall.ps1') -Destination (Join-Path $installPath 'uninstall.ps1') -Force
if (-not $NoRegister) {
  $registry = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.fastpagechat.bridge'
  New-Item -Path $registry -Force | Out-Null
  Set-Item -LiteralPath $registry -Value $manifestFile
}
Write-Output 'Fast Page Chat installed. Open the extension and choose Connect.'
