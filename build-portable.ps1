$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$toolsDir = Join-Path $root '.build-tools'
$wv2Dir = Join-Path $toolsDir 'webview2'
$stagingDir = Join-Path $toolsDir 'staging'
$distDir = Join-Path $root 'dist'
$outExe = Join-Path $distDir 'LightDesktop.exe'

New-Item -ItemType Directory -Path $toolsDir, $wv2Dir, $distDir -Force | Out-Null

# 1. C# (.NET Framework 4.8) Derleyicisi ve Node.js Kontrolu
$cscPath = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $cscPath)) {
  throw "C# derleyicisi bulunamadi: $cscPath"
}

$nodeCmd = Get-Command 'node' -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "Node.js (node.exe) bulunamadi."
}
$nodeExe = $nodeCmd.Source

# 2. Resmi Microsoft.Web.WebView2 NuGet Bilesenleri (< 1 MB)
$coreDll = Join-Path $wv2Dir 'Microsoft.Web.WebView2.Core.dll'
$wfDll = Join-Path $wv2Dir 'Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Join-Path $wv2Dir 'WebView2Loader.dll'

if (-not ((Test-Path $coreDll) -and (Test-Path $wfDll) -and (Test-Path $loaderDll))) {
  Write-Host 'Microsoft.Web.WebView2 SDK indiriliyor (yalnizca ilk build)...'
  $nupkgPath = Join-Path $toolsDir 'wv2.nupkg'
  Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2' -OutFile $nupkgPath -UseBasicParsing
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($nupkgPath)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -eq 'lib/net462/Microsoft.Web.WebView2.Core.dll') {
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $coreDll, $true)
      } elseif ($entry.FullName -eq 'lib/net462/Microsoft.Web.WebView2.WinForms.dll') {
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $wfDll, $true)
      } elseif ($entry.FullName -eq 'runtimes/win-x64/native/WebView2Loader.dll') {
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $loaderDll, $true)
      }
    }
  } finally {
    $zip.Dispose()
  }
  Remove-Item $nupkgPath -Force -ErrorAction SilentlyContinue
}

# 3. Runtime Paketini Hazirla (node.exe + uygulama dosyalari + WebView2 DLL)
if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force }
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

Copy-Item -Path $nodeExe -Destination (Join-Path $stagingDir 'node.exe') -Force
Copy-Item -Path (Join-Path $root 'server.js') -Destination (Join-Path $stagingDir 'server.js') -Force
Copy-Item -Path (Join-Path $root 'indexer-and-thumbs.js') -Destination (Join-Path $stagingDir 'indexer-and-thumbs.js') -Force
Copy-Item -Path (Join-Path $root 'public') -Destination (Join-Path $stagingDir 'public') -Recurse -Force
Copy-Item -Path $coreDll, $wfDll, $loaderDll -Destination $stagingDir -Force

# 4. Payload ZIP Olustur (Optimal Sikistirma)
$payloadZip = Join-Path $toolsDir 'LightDesktop.Payload.zip'
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingDir, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$payloadHash = (Get-FileHash -Path $payloadZip -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
$buildStamp = "v150-$payloadHash"

# 5. C# Kaynak Koduna Build Stamp Yerlestir ve Tek EXE Olarak Derle
$hostCsSrc = Get-Content -Path (Join-Path $root 'portable\LightDesktopHost.cs') -Raw -Encoding UTF8
$genCsPath = Join-Path $toolsDir 'LightDesktopHost.gen.cs'
$hostCsSrc.Replace('__BUILD_STAMP__', $buildStamp) | Set-Content -Path $genCsPath -Encoding UTF8

$icoPath = Join-Path $root 'public\favicon.ico'
$cscArgs = @(
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  '/utf8output',
  ("/win32icon:" + $icoPath),
  ("/resource:" + $payloadZip + ",LightDesktop.Payload.zip"),
  '/reference:System.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  '/reference:System.Web.Extensions.dll',
  ("/reference:" + $coreDll),
  ("/reference:" + $wfDll),
  ("/out:" + $outExe),
  $genCsPath
)

Write-Host "Tek dosya LightDesktop.exe derleniyor (Stamp: $buildStamp)..."
& $cscPath @cscArgs
if ($LASTEXITCODE -ne 0) {
  throw "csc.exe derleme hatasi verdi (ExitCode=$LASTEXITCODE)"
}

$exeItem = Get-Item $outExe
$zipItem = Get-Item $payloadZip
$rawBytes = (Get-ChildItem $stagingDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host ("BASARILI! Portable EXE hazir: " + $exeItem.FullName)
Write-Host ("Acik toplam boyut : {0:N1} MB" -f ($rawBytes / 1MB))
Write-Host ("Sikistirilmis ZIP : {0:N1} MB" -f ($zipItem.Length / 1MB))
Write-Host ("Nihai EXE boyutu  : {0:N1} MB ({1:N0} bayt)" -f ($exeItem.Length / 1MB), $exeItem.Length)
