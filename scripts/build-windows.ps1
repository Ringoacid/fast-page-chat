param([switch]$SkipDownload)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lock = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $project 'installer\runtime-lock.json') | ConvertFrom-Json
$version = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json).version
$output = Join-Path $project 'dist'
$cache = Join-Path $project '.build-cache'
$stage = Join-Path $output ('windows-' + [Guid]::NewGuid().ToString('N'))
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force -Path $cache,$app,(Join-Path $app 'runtime'),(Join-Path $app 'licenses') | Out-Null
foreach ($item in @(@{name='node';spec=$lock.node},@{name='codex';spec=$lock.codex})) {
  $archive = Join-Path $cache ($item.name + '-' + $item.spec.version + '.zip')
  if (-not (Test-Path -LiteralPath $archive)) {
    if ($SkipDownload) { throw "Missing runtime archive: $archive" }
    Invoke-WebRequest -Uri $item.spec.url -OutFile $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.spec.sha256) { throw "Checksum mismatch for $($item.name)." }
  $unpacked = Join-Path $stage ($item.name + '-unpacked')
  Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
  if ($item.name -eq 'node') {
    Copy-Item -LiteralPath (Join-Path $unpacked ('node-v' + $lock.node.version + '-win-x64\node.exe')) -Destination (Join-Path $app 'runtime\node.exe')
    Copy-Item -LiteralPath (Join-Path $unpacked ('node-v' + $lock.node.version + '-win-x64\LICENSE')) -Destination (Join-Path $app 'licenses\NODE-LICENSE.txt')
  } else {
    $binary = Get-ChildItem -LiteralPath $unpacked -Recurse -File | Where-Object Name -EQ 'codex-x86_64-pc-windows-msvc.exe' | Select-Object -First 1
    if (-not $binary) { throw 'Codex executable was not found in the verified archive.' }
    Copy-Item -LiteralPath $binary.FullName -Destination (Join-Path $app 'runtime\codex.exe')
  }
}
foreach ($dir in @('server','extension')) { Copy-Item -LiteralPath (Join-Path $project $dir) -Destination (Join-Path $app $dir) -Recurse }
# Only the distributable receives a stable public key. The working source keeps
# its existing unpacked ID, so upgrading this checkout does not hide old history.
$extensionIdentity = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $project 'installer\extension-identity.json') | ConvertFrom-Json
$extensionManifestPath = Join-Path $app 'extension\manifest.json'
$extensionManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $extensionManifestPath | ConvertFrom-Json
$extensionManifest | Add-Member -MemberType NoteProperty -Name key -Value $extensionIdentity.key -Force
[IO.File]::WriteAllText($extensionManifestPath, ($extensionManifest | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
New-Item -ItemType Directory -Force -Path (Join-Path $app 'installer') | Out-Null
foreach ($file in @('extension-identity.json','runtime-lock.json')) { Copy-Item -LiteralPath (Join-Path $project ('installer\' + $file)) -Destination (Join-Path $app ('installer\' + $file)) }
foreach ($file in @('LICENSE','THIRD_PARTY_NOTICES.md','package.json')) { Copy-Item -LiteralPath (Join-Path $project $file) -Destination (Join-Path $app $file) }
foreach ($file in @('CODEX-LICENSE.txt','CODEX-NOTICE.txt')) { Copy-Item -LiteralPath (Join-Path $project ('installer\licenses\' + $file)) -Destination (Join-Path $app ('licenses\' + $file)) }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is required on the build machine.' }
& $compiler /nologo /target:exe /optimize+ ("/out:" + (Join-Path $app 'FastPageChatHost.exe')) (Join-Path $project 'installer\NativeHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native host compilation failed.' }
foreach ($file in @('install.ps1','uninstall.ps1')) { Copy-Item -LiteralPath (Join-Path $project ('installer\' + $file)) -Destination (Join-Path $stage $file) }
$payload = Join-Path $stage 'payload.zip'
Compress-Archive -LiteralPath $app,(Join-Path $stage 'install.ps1'),(Join-Path $stage 'uninstall.ps1') -DestinationPath $payload
$setup = Join-Path $output ("FastPageChat-$version-windows-x64-Setup.exe")
& $compiler /nologo /target:winexe /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll ("/resource:$payload,payload.zip") ("/out:$setup") (Join-Path $project 'installer\Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$extensionZip = Join-Path $output ("fast-page-chat-$version-extension.zip")
Compress-Archive -Path (Join-Path $app 'extension\*') -DestinationPath $extensionZip -Force
$checksums = @($setup,$extensionZip) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($_) }
[IO.File]::WriteAllLines((Join-Path $output "SHA256SUMS-$version.txt"), $checksums, (New-Object Text.UTF8Encoding($false)))
Write-Output "Built $setup"
Write-Output "Staging retained for verification: $stage"
