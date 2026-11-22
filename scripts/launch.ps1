param(
  [string]$OpenPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $root 'src'
$cacheDir = Join-Path $env:LOCALAPPDATA 'LightDesktopCache'
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$logFile = Join-Path $cacheDir 'logs.txt'
$baseUrl = 'http://127.0.0.1:3847'
$port = 3847

function Write-Log([string]$msg) {
  try {
    Add-Content -Path $logFile -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $msg) -Encoding UTF8
  } catch {}
}

function Show-LaunchError([string]$title, [string]$msg) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($msg, $title, 'OK', 'Error') | Out-Null
  } catch {}
}

function Stop-PortOccupier([int]$targetPort) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
      $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($p in $pids) {
        if ($p -and $p -gt 0) {
          Write-Log ("Port $targetPort uzerindeki eski/takili surec kapatiliyor (PID=" + $p + ")")
          Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
      }
      Start-Sleep -Milliseconds 350
    }
  } catch {}
}

function Test-ServerHealth {
  try {
    $resp = Invoke-WebRequest -Uri ($baseUrl + '/api/health') -TimeoutSec 2 -UseBasicParsing
    return ($resp.Content | ConvertFrom-Json)
  } catch {
    try {
      Invoke-WebRequest -Uri ($baseUrl + '/api/index/status') -TimeoutSec 2 -UseBasicParsing | Out-Null
      return [PSCustomObject]@{ ok = $true; legacy = $true; busy = $false }
    } catch {
      return $null
    }
  }
}

try {
  Write-Log ("Baslatildi. OPEN_PATH=" + $OpenPath)

  $health = Test-ServerHealth
  if ($health) {
    $needsRestart = $false
    if ($health.legacy) {
      $needsRestart = $true
    } elseif (-not $health.busy) {
      if (-not $health.currentCodeMtimeMs -or ([double]$health.currentCodeMtimeMs -le 0)) {
        $needsRestart = $true
      } elseif (-not $health.serverDir -or ($health.serverDir.ToString().TrimEnd('\') -ine $srcDir.TrimEnd('\'))) {
        $needsRestart = $true
      } elseif ($health.startCodeMtimeMs -and ([double]$health.currentCodeMtimeMs -gt [double]$health.startCodeMtimeMs)) {
        $needsRestart = $true
      }
    }
    if ($needsRestart) {
      Write-Log 'Sunucu kodu guncellenmis, sunucu yenileniyor...'
      if ($health.pid) {
        Stop-Process -Id ([int]$health.pid) -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
      } else {
        Stop-PortOccupier -targetPort $port
      }
      $health = $null
    }
  } else {
    # Portta yanit vermeyen/takili bir surec varsa temizle
    Stop-PortOccupier -targetPort $port
  }

  if (-not $health) {
    Write-Log 'Sunucu acik degil, node baslatiliyor...'
    $nodeCmd = Get-Command 'node' -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
      $errMsg = 'Node.js bulunamadi! Lutfen Node.js kurulu oldugundan emin olun.'
      Write-Log ('HATA: ' + $errMsg)
      Show-LaunchError 'LightDesktop Baslatilamadi' $errMsg
      exit 1
    }

    $proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList '--no-warnings','server.js' -WorkingDirectory $srcDir -WindowStyle Hidden -PassThru
    $ready = $false
    for ($i = 0; $i -lt 35; $i++) {
      Start-Sleep -Milliseconds 180
      $h = Test-ServerHealth
      if ($h -and $h.ok) {
        $ready = $true
        break
      }
      if ($proc.HasExited) { break }
    }

    if (-not $ready) {
      $exitInfo = if ($proc.HasExited) { "Cikis kodu: $($proc.ExitCode)" } else { "Zaman asimi" }
      Write-Log ("UYARI: Node sunucusu hazir yaniti vermedi (PID=$($proc.Id), $exitInfo). Pencere yine de aciliyor.")
    } else {
      Write-Log ("Node sunucusu hazir (PID=$($proc.Id)).")
    }
  }

  $targetUrl = $baseUrl
  $cleanPath = ($OpenPath -replace '^"+|"+$', '').Trim()
  if ($cleanPath) {
    $targetUrl = $baseUrl + '/?openPath=' + [uri]::EscapeDataString($cleanPath)
  }

  $boundsFile = Join-Path $env:LOCALAPPDATA 'LightDesktopCache\window-bounds.json'
  $sizeArg = '--window-size=1360,820'
  $posArg = ''
  if (Test-Path $boundsFile) {
    try {
      $b = Get-Content $boundsFile -Raw | ConvertFrom-Json
      if ($b.width -ge 400 -and $b.height -ge 300) {
        $sizeArg = ('--window-size=' + [int]$b.width + ',' + [int]$b.height)
        $bx = [int]$b.x
        $by = [int]$b.y
        if ($bx -gt -4000 -and $by -gt -4000) {
          $onScreen = $false
          try {
            Add-Type -AssemblyName System.Windows.Forms
            foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
              $wa = $scr.WorkingArea
              if ($bx -ge ($wa.Left - 80) -and $bx -lt ($wa.Right - 80) -and $by -ge ($wa.Top - 40) -and $by -lt ($wa.Bottom - 80)) {
                $onScreen = $true
                break
              }
            }
          } catch { $onScreen = $true }
          if ($onScreen) {
            $posArg = ('--window-position=' + $bx + ',' + $by)
          } else {
            Write-Log ("Kayitli pencere konumu ($bx,$by) ekran disinda kaldigi icin sifirlandi.")
          }
        }
      }
    } catch {
      Write-Log ('Bounds uyarisi: ' + $_.Exception.Message)
    }
  }

  $edgeArgs = @('--app=' + $targetUrl, '--new-window', $sizeArg)
  if ($posArg) { $edgeArgs += $posArg }

  $browserCandidates = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe',
    'C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe'
  )
  $appExe = $browserCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

  if ($appExe) {
    try {
      Start-Process -FilePath $appExe -ArgumentList $edgeArgs | Out-Null
      Write-Log ('App penceresi acildi (' + [System.IO.Path]::GetFileName($appExe) + '): ' + $targetUrl)
    } catch {
      Write-Log ('Tarayici app baslatma uyarisi, varsayilan tarayici deneniyor: ' + $_.Exception.Message)
      Start-Process $targetUrl | Out-Null
      Write-Log ('Tarayici acildi: ' + $targetUrl)
    }
  } else {
    Start-Process $targetUrl | Out-Null
    Write-Log ('Tarayici acildi: ' + $targetUrl)
  }
} catch {
  $errText = $_.Exception.ToString()
  Write-Log ('KRITIK HATA: ' + $errText)
  Show-LaunchError 'LightDesktop Hatasi' $errText
  exit 1
}
