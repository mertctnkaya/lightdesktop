'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { SERVER_DIR } = require('../config/constants');
const { runPowerShellEnv } = require('../utils/psRunner');

// ---------- Windows Sistem Entegrasyonu (Varsayılan Gezgin, Kısayollar, Başlangıç) ----------
function getIntegrationTargetInfo() {
  const exePath = process.env.LD_EXE_PATH && fs.existsSync(process.env.LD_EXE_PATH)
    ? path.resolve(process.env.LD_EXE_PATH)
    : '';
  const isPortable = process.env.LD_PORTABLE === '1' && Boolean(exePath);
  const fixedExePath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'LightDesktop', 'LightDesktop.exe')
    : '';
  const hasFixedExe = Boolean(fixedExePath && fs.existsSync(fixedExePath));
  const isRunningFromFixed = Boolean(exePath && fixedExePath && exePath.toLowerCase() === fixedExePath.toLowerCase());
  const devBatPath = path.resolve(SERVER_DIR, '..', 'Baslat-LightDesktop.bat');
  const distExePath = path.resolve(SERVER_DIR, '..', 'dist', 'LightDesktop.exe');
  const hasDistExe = fs.existsSync(distExePath);
  const preferredExe = hasFixedExe ? fixedExePath : (isPortable ? exePath : (hasDistExe ? distExePath : ''));
  const targetPath = preferredExe || (fs.existsSync(devBatPath) ? devBatPath : path.join(SERVER_DIR, 'Baslat-LightDesktop.bat'));
  const usesExe = targetPath.toLowerCase().endsWith('.exe');
  const workDir = usesExe ? path.dirname(targetPath) : path.dirname(targetPath);
  const customIco = path.join(SERVER_DIR, 'public', 'favicon.ico');
  const iconLoc = usesExe
    ? `${targetPath},0`
    : (fs.existsSync(customIco) ? customIco : `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\shell32.dll,4`);
  return {
    isPortable,
    exePath,
    fixedExePath,
    distExePath,
    hasFixedExe,
    isRunningFromFixed,
    targetPath,
    usesExe,
    workDir,
    iconLoc,
  };
}

async function getSystemIntegrationStatus() {
  const info = getIntegrationTargetInfo();
  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    $desktop = [Environment]::GetFolderPath('Desktop')
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'LightDesktop.lnk'
    $hasDesktop = Test-Path -LiteralPath (Join-Path $desktop 'LightDesktop.lnk')
    $hasStartMenu = Test-Path -LiteralPath $startMenu
    $hasCtx = Test-Path -LiteralPath 'HKCU:\\Software\\Classes\\Directory\\shell\\LightDesktop\\command'
    $folderOpenCmd = ''
    try {
      $folderOpenCmd = (Get-ItemProperty -Path 'HKCU:\\Software\\Classes\\Folder\\shell\\open\\command' -Name '(Default)' -ErrorAction SilentlyContinue).'(Default)'
    } catch {}
    $isDef = [bool]($folderOpenCmd -and ($folderOpenCmd -match 'LightDesktop'))
    $runVal = ''
    try {
      $runVal = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'LightDesktop' -ErrorAction SilentlyContinue).'LightDesktop'
    } catch {}
    @{
      hasDesktopShortcut = [bool]$hasDesktop
      hasStartMenuShortcut = [bool]$hasStartMenu
      hasContextMenu = [bool]$hasCtx
      isDefaultExplorer = [bool]$isDef
      autoStartEnabled = [bool]$runVal
    } | ConvertTo-Json -Compress
  `;
  let regState = {
    hasDesktopShortcut: false,
    hasStartMenuShortcut: false,
    hasContextMenu: false,
    isDefaultExplorer: false,
    autoStartEnabled: false,
  };
  try {
    const out = await runPowerShellEnv(psScript, {});
    const parsed = JSON.parse(String(out || '').trim() || '{}');
    regState = { ...regState, ...parsed };
  } catch {}
  return {
    ...info,
    ...regState,
  };
}

async function applySystemIntegration(opts = {}) {
  const action = opts.action || '';
  let info = getIntegrationTargetInfo();

  if (action === 'installFixedApp' || opts.installFixed === true) {
    if (info.isPortable && info.fixedExePath && !info.isRunningFromFixed) {
      await fsp.mkdir(path.dirname(info.fixedExePath), { recursive: true });
      await fsp.copyFile(info.exePath, info.fixedExePath);
      info = getIntegrationTargetInfo();
    }
  }

  const doShortcuts = action === 'installShortcuts' || opts.shortcuts === true;
  const doContextMenu = action === 'installShortcuts' || opts.contextMenu === true;
  const setDef = action === 'setDefaultExplorer'
    ? (opts.enabled ? '1' : '0')
    : (typeof opts.defaultExplorer === 'boolean' ? (opts.defaultExplorer ? '1' : '0') : '');
  const setAuto = action === 'setAutoStart'
    ? (opts.enabled ? '1' : '0')
    : (typeof opts.autoStart === 'boolean' ? (opts.autoStart ? '1' : '0') : '');

  const cmdOpen1 = info.usesExe ? `"${info.targetPath}" "%1"` : `cmd.exe /c ""${info.targetPath}" "%1""`;
  const cmdOpenV = info.usesExe ? `"${info.targetPath}" "%V"` : `cmd.exe /c ""${info.targetPath}" "%V""`;
  const cmdAuto = info.usesExe ? `"${info.targetPath}" --background` : `"${info.targetPath}"`;

  const psScript = `
    $ProgressPreference = 'SilentlyContinue'
    if ($env:LD_DO_SHORTCUTS -eq '1') {
      $ws = New-Object -ComObject WScript.Shell
      $desktop = [Environment]::GetFolderPath('Desktop')
      $programs = [Environment]::GetFolderPath('Programs')
      foreach ($dir in @($desktop, $programs)) {
        if (-not $dir) { continue }
        $lnkPath = Join-Path $dir 'LightDesktop.lnk'
        $lnk = $ws.CreateShortcut($lnkPath)
        $lnk.TargetPath = $env:LD_TARGET
        $lnk.WorkingDirectory = $env:LD_DIR
        $lnk.IconLocation = $env:LD_ICON
        $lnk.Description = 'LightDesktop - HDD Dostu Dosya Gezgini'
        $lnk.Hotkey = 'Ctrl+Alt+E'
        $lnk.Save()
      }
    }
    if ($env:LD_DO_CTX -eq '1') {
      $dirKey = 'HKCU:\\Software\\Classes\\Directory\\shell\\LightDesktop'
      $dirCmd = 'HKCU:\\Software\\Classes\\Directory\\shell\\LightDesktop\\command'
      New-Item -Path $dirCmd -Force | Out-Null
      Set-ItemProperty -Path $dirKey -Name '(Default)' -Value 'LightDesktop ile Ac'
      Set-ItemProperty -Path $dirKey -Name 'Icon' -Value $env:LD_ICON
      Set-ItemProperty -Path $dirCmd -Name '(Default)' -Value $env:LD_CMD_1

      $bgKey = 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\LightDesktop'
      $bgCmd = 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\LightDesktop\\command'
      New-Item -Path $bgCmd -Force | Out-Null
      Set-ItemProperty -Path $bgKey -Name '(Default)' -Value 'LightDesktop ile Ac'
      Set-ItemProperty -Path $bgKey -Name 'Icon' -Value $env:LD_ICON
      Set-ItemProperty -Path $bgCmd -Name '(Default)' -Value $env:LD_CMD_V
    }
    if ($env:LD_SET_DEF -eq '1') {
      $fCmdKey = 'HKCU:\\Software\\Classes\\Folder\\shell\\open\\command'
      New-Item -Path $fCmdKey -Force | Out-Null
      Set-ItemProperty -Path $fCmdKey -Name '(Default)' -Value $env:LD_CMD_1
      Set-ItemProperty -Path $fCmdKey -Name 'DelegateExecute' -Value ''
    } elseif ($env:LD_SET_DEF -eq '0') {
      $fOpenKey = 'HKCU:\\Software\\Classes\\Folder\\shell\\open'
      if (Test-Path -LiteralPath $fOpenKey) {
        Remove-Item -LiteralPath $fOpenKey -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    if ($env:LD_SET_AUTO -eq '1') {
      $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      New-Item -Path $runKey -Force | Out-Null
      Set-ItemProperty -Path $runKey -Name 'LightDesktop' -Value $env:LD_CMD_AUTO
    } elseif ($env:LD_SET_AUTO -eq '0') {
      $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      if (Get-ItemProperty -Path $runKey -Name 'LightDesktop' -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name 'LightDesktop' -ErrorAction SilentlyContinue
      }
    }
    exit 0
  `;

  if (doShortcuts || doContextMenu || setDef !== '' || setAuto !== '') {
    await runPowerShellEnv(psScript, {
      LD_TARGET: info.targetPath,
      LD_DIR: info.workDir,
      LD_ICON: info.iconLoc,
      LD_DO_SHORTCUTS: doShortcuts ? '1' : '0',
      LD_DO_CTX: doContextMenu ? '1' : '0',
      LD_CMD_1: cmdOpen1,
      LD_CMD_V: cmdOpenV,
      LD_SET_DEF: setDef,
      LD_SET_AUTO: setAuto,
      LD_CMD_AUTO: cmdAuto,
    });
  }

  return { ok: true, status: await getSystemIntegrationStatus() };
}


module.exports = {
  getIntegrationTargetInfo,
  getSystemIntegrationStatus,
  applySystemIntegration,
};
