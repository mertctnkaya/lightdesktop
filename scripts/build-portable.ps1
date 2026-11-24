$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $root 'src'
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
Copy-Item -Path (Join-Path $srcDir 'server.js') -Destination (Join-Path $stagingDir 'server.js') -Force
Copy-Item -Path (Join-Path $srcDir 'indexer-and-thumbs.js') -Destination (Join-Path $stagingDir 'indexer-and-thumbs.js') -Force
Copy-Item -Path (Join-Path $srcDir 'public') -Destination (Join-Path $stagingDir 'public') -Recurse -Force
Copy-Item -Path $coreDll, $wfDll, $loaderDll -Destination $stagingDir -Force

# 4. Payload ZIP Olustur (Optimal Sikistirma)
$payloadZip = Join-Path $toolsDir 'LightDesktop.Payload.zip'
if (Test-Path $payloadZip) { Remove-Item $payloadZip -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stagingDir, $payloadZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$payloadHash = (Get-FileHash -Path $payloadZip -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
$buildStamp = "v151-$payloadHash"

# 5. C# Kaynak Koduna Build Stamp Yerlestir ve Tek EXE Olarak Derle
$hostCsSrc = Get-Content -Path (Join-Path $PSScriptRoot 'LightDesktopHost.cs') -Raw -Encoding UTF8
$genCsPath = Join-Path $toolsDir 'LightDesktopHost.gen.cs'
$hostCsSrc.Replace('__BUILD_STAMP__', $buildStamp) | Set-Content -Path $genCsPath -Encoding UTF8

$icoPath = Join-Path $srcDir 'public\favicon.ico'
$tempOutExe = Join-Path $toolsDir 'LightDesktop.build.exe'
if (Test-Path $tempOutExe) { Remove-Item $tempOutExe -Force -ErrorAction SilentlyContinue }
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
  ("/out:" + $tempOutExe),
  $genCsPath
)

Write-Host "Tek dosya LightDesktop.exe derleniyor (Stamp: $buildStamp)..."
& $cscPath @cscArgs
if ($LASTEXITCODE -ne 0) {
  throw "csc.exe derleme hatasi verdi (ExitCode=$LASTEXITCODE)"
}

# Derleme tamamlandiktan sonra acik LightDesktop varsa temizce kapatip guncel EXE ile yeniden baslat
$fullOutExe = [System.IO.Path]::GetFullPath($outExe)
$fixedExe = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'LightDesktop\LightDesktop.exe' } else { '' }
$fullFixedExe = if ($fixedExe) { [System.IO.Path]::GetFullPath($fixedExe) } else { '' }

$runningHosts = @()
try {
  $runningHosts = @(Get-CimInstance Win32_Process -Filter "Name = 'LightDesktop.exe'" -ErrorAction SilentlyContinue)
} catch {}

$relaunchExe = ''
$relaunchArgs = ''
if ($runningHosts.Count -gt 0) {
  foreach ($procInfo in $runningHosts) {
    $ep = if ($procInfo.ExecutablePath) { [System.IO.Path]::GetFullPath($procInfo.ExecutablePath) } else { '' }
    if ($fullFixedExe -and $ep -ieq $fullFixedExe) {
      $relaunchExe = $fullFixedExe
    } elseif (-not $relaunchExe) {
      $relaunchExe = $fullOutExe
    }
    if (-not $relaunchArgs -and $procInfo.CommandLine) {
      if ($procInfo.CommandLine -match '--background') {
        $relaunchArgs = '--background'
      } elseif ($procInfo.CommandLine -match '^\s*"[^"]+"\s+(.+)$') {
        $relaunchArgs = $matches[1].Trim()
      }
    }
  }

  Write-Host ("Acik LightDesktop surecleri guncelleme icin kapatiliyor (" + $runningHosts.Count + " surec)...")
  foreach ($procInfo in $runningHosts) {
    try {
      $p = Get-Process -Id ([int]$procInfo.ProcessId) -ErrorAction SilentlyContinue
      if ($p) {
        $null = $p.CloseMainWindow()
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 650

  foreach ($procInfo in $runningHosts) {
    try {
      $p = Get-Process -Id ([int]$procInfo.ProcessId) -ErrorAction SilentlyContinue
      if ($p -and -not $p.HasExited) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 350

  # Portable runtime icinden calisan eski arka plan node.exe varsa temizle (yeni surum temiz port alsin)
  if ($env:LOCALAPPDATA) {
    $rtPrefix = Join-Path $env:LOCALAPPDATA 'LightDesktopRuntime'
    try {
      $rtNodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($rtPrefix, [System.StringComparison]::OrdinalIgnoreCase)
      })
      foreach ($rn in $rtNodes) {
        Stop-Process -Id ([int]$rn.ProcessId) -Force -ErrorAction SilentlyContinue
      }
    } catch {}
  }
}

Copy-Item -LiteralPath $tempOutExe -Destination $fullOutExe -Force
Remove-Item -LiteralPath $tempOutExe -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath ($fullOutExe + '.old') -Force -ErrorAction SilentlyContinue

if ($fullFixedExe -and (Test-Path -LiteralPath $fullFixedExe)) {
  Copy-Item -LiteralPath $fullOutExe -Destination $fullFixedExe -Force
  Remove-Item -LiteralPath ($fullFixedExe + '.old') -Force -ErrorAction SilentlyContinue
  Write-Host ("Sabit konum EXE guncellendi: " + $fullFixedExe)
}

$exeItem = Get-Item $fullOutExe
$zipItem = Get-Item $payloadZip
$rawBytes = (Get-ChildItem $stagingDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ""
Write-Host ("BASARILI! Portable EXE hazir: " + $exeItem.FullName)
Write-Host ("Acik toplam boyut : {0:N1} MB" -f ($rawBytes / 1MB))
Write-Host ("Sikistirilmis ZIP : {0:N1} MB" -f ($zipItem.Length / 1MB))
Write-Host ("Nihai EXE boyutu  : {0:N1} MB ({1:N0} bayt)" -f ($exeItem.Length / 1MB), $exeItem.Length)

if ($relaunchExe -and (Test-Path -LiteralPath $relaunchExe)) {
  Write-Host ("Guncel LightDesktop yeniden baslatiliyor: " + $relaunchExe)
  if ($relaunchArgs) {
    Start-Process -FilePath $relaunchExe -ArgumentList $relaunchArgs | Out-Null
  } else {
    Start-Process -FilePath $relaunchExe | Out-Null
  }
}
exit 0
