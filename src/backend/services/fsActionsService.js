'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const idx = require('../../indexer-and-thumbs');
const { runPowerShellEnv } = require('../utils/psRunner');
const { markDirMutated, markDirsMutated, makeUniquePath } = require('./mutationTracker');
const { releaseOpenStreamsForPaths } = require('./streamRegistry');
const { pushUndoEntry, getUndoSummary } = require('./undoService');
const { createTransferJob, processTransferQueue } = require('./transferEngine');
const { sendPathsToRecycleBin, getLastKnownTrashCount } = require('./recycleBinService');
const { applySystemIntegration } = require('./windowsIntegrationService');
const { recordAppError } = require('./loggerService');
const { isPathProtected, moveToProtectedVault } = require('./protectedVaultService');

function getOrganizeOutputFolderName(parentDir) {
  const trimmed = String(parentDir || '').replace(/[\\/]+$/, '');
  let base = path.basename(trimmed);
  if (!base || /^[a-zA-Z]:$/.test(base)) {
    base = trimmed.replace(/[^a-zA-Z0-9]/g, '') || 'Klasör';
  }
  base = base.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Klasör';
  return `${base} Tarihle Ayrıştırıldı`;
}

// ---------- Dosya Sistemi Eylemleri ----------
async function handleFsAction(body) {
  const { action } = body;

  if (action === 'open') {
    const resolved = path.resolve(body.path);
    const workDir = path.dirname(resolved);
    if (/\.(bat|cmd)$/i.test(resolved)) {
      await runPowerShellEnv(
        `
          $ProgressPreference = 'SilentlyContinue'
          Add-Type -Namespace LDWin -Name ConsoleDetach -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole();'
          [LDWin.ConsoleDetach]::FreeConsole() | Out-Null
          Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c ""' + $env:LD_TARGET + '""') -WorkingDirectory $env:LD_WORKDIR -WindowStyle Normal
          exit 0
        `,
        { LD_TARGET: resolved, LD_WORKDIR: workDir }
      );
      return { ok: true };
    }
    await new Promise((resolve, reject) => {
      let settled = false;
      const child = execFile(
        'rundll32.exe',
        ['url.dll,FileProtocolHandler', resolved],
        { cwd: workDir, windowsHide: false },
        (err) => {
          if (settled) return;
          settled = true;
          if (err) {
            runPowerShellEnv(
              "$ProgressPreference='SilentlyContinue'; Start-Process -FilePath $env:LD_TARGET -WorkingDirectory $env:LD_WORKDIR -WindowStyle Normal",
              { LD_TARGET: resolved, LD_WORKDIR: workDir }
            )
              .then(() => resolve())
              .catch(reject);
          } else {
            resolve();
          }
        }
      );
      if (child && child.pid) {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 80);
      }
    });
    return { ok: true };
  }

  if (action === 'reveal') {
    const resolved = path.resolve(body.path);
    const cleanTarget = resolved.replace(/"/g, '');
    const isDriveRoot = /^[a-zA-Z]:\\?$/.test(cleanTarget);
    const arg = isDriveRoot ? `"${cleanTarget.replace(/\\?$/, '\\')}"` : `/select,"${cleanTarget}"`;
    execFile('explorer.exe', [arg], { windowsVerbatimArguments: true, windowsHide: false }, () => {});
    return { ok: true };
  }

  if (action === 'mkdir') {
    const folderName = (typeof body.name === 'string' ? body.name.trim() : '') || 'Yeni Klasör';
    const newDir = makeUniquePath(path.join(path.resolve(body.parentDir), folderName));
    await fsp.mkdir(newDir, { recursive: false });
    pushUndoEntry({
      type: 'mkdir',
      label: `Yeni Klasör: ${path.basename(newDir)}`,
      items: [{ path: newDir }],
      refreshDirs: [path.dirname(newDir)],
    });
    return { ok: true, path: newDir, undoSummary: getUndoSummary() };
  }

  if (action === 'rename') {
    const oldPath = path.resolve(body.path);
    await releaseOpenStreamsForPaths([oldPath]);
    const newPath = path.join(path.dirname(oldPath), body.newName);
    await fsp.rename(oldPath, newPath);
    idx.removeIndexedPath(oldPath);
    pushUndoEntry({
      type: 'rename',
      label: `Ad Değiştirme: ${path.basename(oldPath)} → ${path.basename(newPath)}`,
      items: [{ from: oldPath, to: newPath }],
      refreshDirs: [path.dirname(oldPath)],
    });
    return { ok: true, path: newPath, undoSummary: getUndoSummary() };
  }

  if (action === 'batchRename') {
    const { paths = [], pattern = '{name}_{n}', startNum = 1 } = body;
    const job = createTransferJob({
      op: 'batchRename',
      sources: paths,
      pattern,
      startNum,
    });
    processTransferQueue();
    return { ok: true, queued: true, jobId: job.id, job };
  }

  if (action === 'createFolderWithSelection') {
    const { parentDir, folderName, paths = [], op = 'move' } = body;
    const targetDir = makeUniquePath(path.join(path.resolve(parentDir), folderName || 'Seçilenler'));
    await fsp.mkdir(targetDir, { recursive: true });
    const job = createTransferJob({
      op: op === 'copy' ? 'copy' : 'move',
      sources: paths,
      destDir: targetDir,
      conflict: 'rename',
      createdDir: targetDir,
    });
    processTransferQueue();
    return { ok: true, queued: true, folderPath: targetDir, jobId: job.id, job };
  }

  if (action === 'delete') {
    const { paths = [], permanent = false, immediate = false } = body;
    if (immediate) {
      const resolvedList = paths.map((p) => path.resolve(p));
      try {
        if (permanent) {
          await releaseOpenStreamsForPaths(resolvedList);
          for (const resolved of resolvedList) {
            if (isPathProtected(resolved)) {
              await moveToProtectedVault(resolved, 'permanent-delete');
            } else {
              await fsp.rm(resolved, { recursive: true, force: true });
            }
            idx.removeIndexedPath(resolved);
          }
          markDirsMutated(resolvedList.map((p) => path.dirname(p)));
        } else {
          const { okList, errList } = await sendPathsToRecycleBin(resolvedList);
          if (okList.length > 0) {
            pushUndoEntry({
              type: 'trash',
              label: `Çöpe Taşıma (${okList.length} öğe)`,
              items: okList.map((p) => ({ origPath: p })),
              refreshDirs: Array.from(new Set(okList.map((p) => path.dirname(p)))),
            });
          }
          if (errList.length > 0 && okList.length === 0) {
            throw new Error(errList[0].message);
          }
        }
        return { ok: true, deleted: resolvedList.length, undoSummary: getUndoSummary(), trashCount: getLastKnownTrashCount() };
      } catch (err) {
        recordAppError('Hızlı Silme', resolvedList[0] || '', err.message);
        throw err;
      }
    }

    const job = createTransferJob({
      op: 'delete',
      sources: paths,
      permanent: Boolean(permanent),
      originTag: body.originTag || '',
    });
    processTransferQueue();
    return { ok: true, queued: true, jobId: job.id, job };
  }

  if (action === 'pickFolder') {
    const initialDir = body.initialDir ? path.resolve(String(body.initialDir)) : '';
    const out = await runPowerShellEnv(
      `
        $ProgressPreference = 'SilentlyContinue'
        $OutputEncoding = [System.Text.Encoding]::UTF8
        try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
        Add-Type -AssemblyName System.Windows.Forms
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        $owner.ShowInTaskbar = $false
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Tarihle ayristirilan dosyalarin kaydedilecegi hedef klasoru secin'
        $dlg.ShowNewFolderButton = $true
        if ($env:LD_INIT_DIR -and (Test-Path -LiteralPath $env:LD_INIT_DIR -PathType Container)) {
          $dlg.SelectedPath = $env:LD_INIT_DIR
        }
        if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Output $dlg.SelectedPath
        }
        $owner.Dispose()
        exit 0
      `,
      { LD_INIT_DIR: initialDir },
      120000,
      true
    );
    return { ok: true, path: String(out || '').trim() };
  }

  if (action === 'organizeByDate') {
    const parentDir = path.resolve(body.parentDir);
    const dryRun = Boolean(body.dryRun);
    const outputFolderName = getOrganizeOutputFolderName(parentDir);
    if (dryRun) {
      const handle = await fsp.opendir(parentDir, { bufferSize: 128 });
      const files = [];
      let totalBytes = 0;
      for await (const dirent of handle) {
        if (dirent.isDirectory()) continue;
        const fullPath = path.join(parentDir, dirent.name);
        try {
          const st = await fsp.stat(fullPath);
          const d = new Date(st.mtimeMs);
          const yyyy = String(d.getFullYear());
          const mm = `${yyyy}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          const relFolder = path.join(yyyy, mm);
          totalBytes += st.size || 0;
          files.push({ src: fullPath, name: dirent.name, relFolder });
        } catch {}
      }

      const folderMap = new Map();
      for (const f of files) {
        folderMap.set(f.relFolder, (folderMap.get(f.relFolder) || 0) + 1);
      }

      const preview = Array.from(folderMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([folder, count]) => ({ folder, count }));
      return { ok: true, totalFiles: files.length, totalBytes, folderCount: folderMap.size, preview, outputFolderName };
    }

    const mode = body.mode === 'copy' ? 'copy' : 'move';
    const destBaseDir = body.destDir ? path.resolve(String(body.destDir)) : parentDir;
    if (!fs.existsSync(destBaseDir) || !fs.statSync(destBaseDir).isDirectory()) {
      throw new Error('Hedef klasör bulunamadı');
    }

    const job = createTransferJob({
      op: 'organizeByDate',
      parentDir,
      destDir: destBaseDir,
      organizeMode: mode,
      outputFolderName,
    });
    processTransferQueue();
    return { ok: true, queued: true, jobId: job.id, job };
  }

  if (action === 'createShortcut') {
    const rawItems = Array.isArray(body.items) && body.items.length > 0
      ? body.items
      : (body.targetPath ? [{ targetPath: body.targetPath, name: body.name || '', args: body.args || '', description: body.description || '' }] : []);
    if (rawItems.length === 0) throw new Error('Kısayol hedefi belirtilmedi');
    const rawDest = String(body.destDir || '').trim();
    if (!rawDest) throw new Error('Kısayol hedef klasörü belirtilmedi');
    const destDir = rawDest.toUpperCase() === 'DESKTOP' ? 'DESKTOP' : path.resolve(rawDest);

    const payloadB64 = Buffer.from(
      JSON.stringify({
        destDir,
        items: rawItems.map((it) => ({
          targetPath: path.resolve(String(it.targetPath || '')),
          name: String(it.name || '').trim(),
          args: String(it.args || '').trim(),
          description: String(it.description || '').trim(),
        })),
      }),
      'utf8'
    ).toString('base64');

    const psOut = await runPowerShellEnv(
      `
        $ProgressPreference = 'SilentlyContinue'
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:LD_SC_B64))
        $payload = $json | ConvertFrom-Json
        $destDir = [string]$payload.destDir
        if ($destDir -eq 'DESKTOP') { $destDir = [Environment]::GetFolderPath('Desktop') }
        if (-not (Test-Path -LiteralPath $destDir)) { throw 'Hedef klasor bulunamadi.' }
        $ws = New-Object -ComObject WScript.Shell
        $created = @()
        foreach ($it in $payload.items) {
          $target = [string]$it.targetPath
          $base = ([string]$it.name).Trim()
          if (-not $base) {
            $bName = [System.IO.Path]::GetFileNameWithoutExtension($target)
            if (-not $bName) { $bName = [System.IO.Path]::GetFileName($target) }
            if (-not $bName) { $bName = 'Kisayol' }
            $base = $bName + ' - Kisayol'
          }
          $base = $base -replace '[<>:"/\\\\|?*]', '_'
          if ($base.ToLower().EndsWith('.lnk')) { $base = $base.Substring(0, $base.Length - 4) }
          $lnk = Join-Path $destDir ($base + '.lnk')
          $idx = 2
          while (Test-Path -LiteralPath $lnk) {
            $lnk = Join-Path $destDir ($base + ' (' + $idx + ').lnk')
            $idx++
          }
          $sc = $ws.CreateShortcut($lnk)
          $sc.TargetPath = $target
          if (Test-Path -LiteralPath $target -PathType Container) { $sc.WorkingDirectory = $target }
          else {
            $parentDir = Split-Path -Parent $target
            if ($parentDir) { $sc.WorkingDirectory = $parentDir }
          }
          if ($it.args) { $sc.Arguments = [string]$it.args }
          if ($it.description) { $sc.Description = [string]$it.description }
          $sc.Save()
          $created += [PSCustomObject]@{ path = $lnk; name = [System.IO.Path]::GetFileName($lnk); target = $target }
        }
        @{ ok = $true; destDir = $destDir; created = @($created) } | ConvertTo-Json -Depth 4 -Compress
        exit 0
      `,
      { LD_SC_B64: payloadB64 }
    );

    const parsed = JSON.parse(String(psOut || '{}').trim() || '{}');
    const created = Array.isArray(parsed.created) ? parsed.created : (parsed.created ? [parsed.created] : []);
    if (parsed.destDir) markDirMutated(parsed.destDir);
    return { ok: true, destDir: parsed.destDir || destDir, created };
  }

  if (action === 'installShortcut') {
    const res = await applySystemIntegration({ action: 'installShortcuts' });
    return { ok: true, status: res.status };
  }

  if (action === 'clearThumbCache') {
    const stats = await idx.clearThumbCache();
    return { ok: true, stats };
  }

  throw new Error(`Bilinmeyen işlem: ${action}`);
}


module.exports = {
  getOrganizeOutputFolderName,
  handleFsAction,
};
