'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');
const idx = require('../../indexer-and-thumbs');
const { markDirMutated, markDirsMutated, makeUniquePath } = require('./mutationTracker');
const { releaseOpenStreamsForPaths } = require('./streamRegistry');
const { pushUndoEntry, movePathSafe } = require('./undoService');
const { sendPathsToRecycleBin, setLastKnownTrashCount } = require('./recycleBinService');
const { recordAppError } = require('./loggerService');
const { isPathProtected, moveToProtectedVault } = require('./protectedVaultService');

// ---------- HDD Dostu Sıralı Transfer Kuyruğu (Concurrency = 1) ----------
const transferState = {
  jobs: [],
  activeJob: null,
  paused: false,
  workerRunning: false,
};


async function computeQuickFileHash(filePath, fileSize) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const hash = crypto.createHash('sha1');
    const headLen = Math.min(65536, fileSize);
    if (headLen > 0) {
      const headBuf = Buffer.allocUnsafe(headLen);
      const r1 = await fh.read(headBuf, 0, headLen, 0);
      hash.update(headBuf.subarray(0, r1.bytesRead));
    }
    if (fileSize > 65536) {
      const tailLen = Math.min(65536, fileSize - 65536);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      const r2 = await fh.read(tailBuf, 0, tailLen, fileSize - tailLen);
      hash.update(tailBuf.subarray(0, r2.bytesRead));
    }
    return hash.digest('hex');
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function copyFileStreamSafe(src, dest, job) {
  const st = await fsp.stat(src);
  let copied = 0;
  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 });
    const ws = fs.createWriteStream(dest, { highWaterMark: 4 * 1024 * 1024 });
    let aborted = false;

    const checkPauseAndCancel = setInterval(() => {
      if (job.cancelled && !aborted) {
        aborted = true;
        clearInterval(checkPauseAndCancel);
        rs.destroy(new Error('İptal edildi'));
        ws.destroy();
      } else if (transferState.paused && !rs.isPaused()) {
        rs.pause();
      } else if (!transferState.paused && rs.isPaused()) {
        rs.resume();
      }
    }, 100);

    rs.on('data', (chunk) => {
      copied += chunk.length;
      job.doneBytes += chunk.length;
      const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
      job.speedBps = Math.round(copied / elapsedSec);
    });
    rs.on('error', (err) => {
      clearInterval(checkPauseAndCancel);
      ws.destroy();
      reject(err);
    });
    ws.on('error', (err) => {
      clearInterval(checkPauseAndCancel);
      rs.destroy();
      reject(err);
    });
    ws.on('finish', () => {
      clearInterval(checkPauseAndCancel);
      resolve();
    });
    rs.pipe(ws);
  });

  // Boyut bütünlüğü doğrulaması (6 yıllık HDD bozuk sektör koruması)
  const destSt = await fsp.stat(dest);
  if (destSt.size !== st.size) {
    await fsp.unlink(dest).catch(() => {});
    throw new Error('Doğrulama hatası: hedef dosya boyutu uyuşmuyor');
  }

  // Tarih bilgisini koru
  await fsp.utimes(dest, st.atime, st.mtime).catch(() => {});
}

async function collectFilesRecursive(srcPath) {
  const st = await fsp.stat(srcPath);
  if (!st.isDirectory()) {
    return { totalBytes: st.size, dirs: [], files: [{ src: srcPath, rel: path.basename(srcPath), size: st.size }] };
  }
  const baseName = path.basename(srcPath);
  const dirs = [baseName];
  const files = [];
  let totalBytes = 0;

  async function walk(cur, relBase) {
    const handle = await fsp.opendir(cur);
    for await (const dirent of handle) {
      const full = path.join(cur, dirent.name);
      const rel = path.join(relBase, dirent.name);
      if (dirent.isDirectory()) {
        dirs.push(rel);
        await walk(full, rel);
      } else {
        const fst = await fsp.stat(full);
        totalBytes += fst.size;
        files.push({ src: full, rel, size: fst.size });
      }
    }
  }
  await walk(srcPath, baseName);
  return { totalBytes, dirs, files };
}

function pushJobLog(job, file, detail = '', status = 'ok') {
  if (!Array.isArray(job.recentLog)) job.recentLog = [];
  job.recentLog.push({
    file: file || '',
    detail: detail || '',
    status,
    time: Date.now(),
  });
  if (job.recentLog.length > 50) job.recentLog.shift();
}

function updateJobRate(job) {
  const elapsedSec = Math.max(0.2, (Date.now() - (job.startedAt || Date.now())) / 1000);
  job.itemsPerSec = Number((job.doneFiles / elapsedSec).toFixed(1));
}

function createTransferJob(opts = {}) {
  const op = opts.op || 'copy';
  const titleMap = {
    copy: 'Dosyalar Kopyalanıyor',
    move: 'Dosyalar Taşınıyor',
    delete: opts.permanent ? 'Kalıcı Olarak Siliniyor' : "Geri Dönüşüm Kutusu'na Taşınıyor",
    batchRename: 'Toplu Yeniden Adlandırma',
    organizeByDate: opts.organizeMode === 'copy'
      ? 'Tarihe Göre Kopyalanarak Klasörleniyor'
      : 'Tarihe Göre Taşınarak Klasörleniyor',
  };
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    op,
    title: opts.title || titleMap[op] || 'İşlem Yürütülüyor',
    sources: Array.isArray(opts.sources) ? opts.sources.map((s) => path.resolve(s)) : [],
    destDir: opts.destDir ? path.resolve(opts.destDir) : '',
    parentDir: opts.parentDir ? path.resolve(opts.parentDir) : '',
    organizeMode: opts.organizeMode === 'copy' ? 'copy' : 'move',
    outputFolderName: opts.outputFolderName || '',
    conflict: opts.conflict || 'rename',
    permanent: Boolean(opts.permanent),
    pattern: opts.pattern || '{name}_{n}',
    startNum: Number(opts.startNum) || 1,
    originTag: opts.originTag || '',
    createdDir: opts.createdDir ? path.resolve(opts.createdDir) : '',
    status: 'queued',
    totalFiles: Number(opts.totalFiles) || 0,
    doneFiles: 0,
    errorCount: 0,
    totalBytes: 0,
    doneBytes: 0,
    speedBps: 0,
    itemsPerSec: 0,
    currentFile: '',
    currentTarget: '',
    cancelled: false,
    startedAt: 0,
    finishedAt: 0,
    recentLog: [],
    error: null,
  };
  transferState.jobs.push(job);
  if (transferState.jobs.length > 25) {
    const finishedIdx = transferState.jobs.findIndex(
      (j) => j.status === 'completed' || j.status === 'cancelled' || j.status === 'error'
    );
    if (finishedIdx !== -1) transferState.jobs.splice(finishedIdx, 1);
  }
  return job;
}

async function waitWhilePaused(job) {
  while (transferState.paused && !job.cancelled) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (job.cancelled) throw new Error('İptal edildi');
}

async function runRecycleBinJob(job) {
  await releaseOpenStreamsForPaths(job.sources);
  const listFile = path.join(idx.CACHE_ROOT, `del-${job.id}.txt`);
  const pauseFlagFile = path.join(idx.CACHE_ROOT, `pause-${job.id}.flag`);
  await fsp.writeFile(listFile, job.sources.join('\n'), 'utf8');

  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    Add-Type -AssemblyName Microsoft.VisualBasic
    $lines = [System.IO.File]::ReadAllLines($env:LD_DEL_FILE, [System.Text.Encoding]::UTF8)
    foreach ($p in $lines) {
      while ($env:LD_PAUSE_FILE -and (Test-Path -LiteralPath $env:LD_PAUSE_FILE)) { Start-Sleep -Milliseconds 200 }
      if ([string]::IsNullOrWhiteSpace($p)) { continue }
      try {
        if (Test-Path -LiteralPath $p -PathType Container) {
          [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          [Console]::Out.WriteLine('OK|' + $p)
        } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
          [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          [Console]::Out.WriteLine('OK|' + $p)
        } else {
          [Console]::Out.WriteLine('ERR|' + $p + '|Dosya veya klasör bulunamadı')
        }
      } catch {
        $msg = $_.Exception.Message -replace "[\\r\\n]+", " "
        [Console]::Out.WriteLine('ERR|' + $p + '|' + $msg)
      }
      [Console]::Out.Flush()
    }
  `;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  let stderrBuf = '';

  try {
    if (transferState.paused) {
      await fsp.writeFile(pauseFlagFile, '1', 'utf8').catch(() => {});
    }

    await new Promise((resolve, reject) => {
      const proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        {
          env: { ...process.env, LD_DEL_FILE: listFile, LD_PAUSE_FILE: pauseFlagFile },
          windowsHide: true,
        }
      );
      job._proc = proc;
      job._pauseFlagFile = pauseFlagFile;

      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      const trashedPaths = [];
      rl.on('line', (line) => {
        if (line.startsWith('OK|')) {
          const fp = line.slice(3);
          idx.removeIndexedPath(fp);
          trashedPaths.push(fp);
          job.doneFiles++;
          job.currentFile = path.basename(fp) || fp;
          job.currentTarget = fp;
          updateJobRate(job);
          pushJobLog(job, job.currentFile, `${fp} → Çöp Kutusu`, 'ok');
        } else if (line.startsWith('ERR|')) {
          const rest = line.slice(4);
          const sep = rest.indexOf('|');
          const fp = sep === -1 ? rest : rest.slice(0, sep);
          const errMsg = sep === -1 ? 'Silme hatası' : rest.slice(sep + 1);
          job.doneFiles++;
          job.errorCount++;
          job.currentFile = path.basename(fp) || fp;
          job.currentTarget = fp;
          updateJobRate(job);
          recordAppError('Çöpe Taşıma', fp, errMsg);
          pushJobLog(job, job.currentFile, errMsg, 'error');
        }
      });

      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
      });

      let settled = false;
      const finishResolve = () => { if (!settled) { settled = true; resolve(); } };
      const finishReject = (err) => { if (!settled) { settled = true; reject(err); } };

      const ctlTimer = setInterval(() => {
        if (job.cancelled) {
          clearInterval(ctlTimer);
          try { fs.unlinkSync(pauseFlagFile); } catch {}
          if (proc.pid) {
            execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
          }
          try { proc.kill('SIGKILL'); } catch {}
          setTimeout(() => {
            rl.close();
            finishReject(new Error('İptal edildi'));
          }, 400);
          return;
        }
        if (transferState.paused) {
          if (!fs.existsSync(pauseFlagFile)) {
            try { fs.writeFileSync(pauseFlagFile, '1'); } catch {}
          }
        } else if (fs.existsSync(pauseFlagFile)) {
          try { fs.unlinkSync(pauseFlagFile); } catch {}
        }
      }, 150);

      proc.on('error', (err) => {
        clearInterval(ctlTimer);
        rl.close();
        finishReject(err);
      });

      proc.on('close', (code) => {
        clearInterval(ctlTimer);
        rl.close();
        if (trashedPaths.length > 0) {
          if (lastKnownTrashCount !== null) lastKnownTrashCount += trashedPaths.length;
          const refreshDirs = Array.from(new Set(trashedPaths.map((p) => path.dirname(p))));
          pushUndoEntry({
            type: 'trash',
            label: `Çöpe Taşıma (${trashedPaths.length} öğe)`,
            items: trashedPaths.map((p) => ({ origPath: p })),
            refreshDirs,
          });
        }
        if (job.cancelled) return finishReject(new Error('İptal edildi'));
        if (code !== 0 && stderrBuf.trim()) {
          return finishReject(new Error(stderrBuf.trim()));
        }
        finishResolve();
      });
    });
  } finally {
    delete job._proc;
    delete job._pauseFlagFile;
    await fsp.unlink(listFile).catch(() => {});
    await fsp.unlink(pauseFlagFile).catch(() => {});
  }
}

async function processTransferQueue() {
  if (transferState.workerRunning) return;
  transferState.workerRunning = true;
  try {
    while (true) {
      const nextJob = transferState.jobs.find((j) => j.status === 'queued');
      if (!nextJob) break;

      transferState.activeJob = nextJob;
      nextJob.status = 'running';
      nextJob.startedAt = Date.now();

      try {
        if (nextJob.op === 'delete') {
          nextJob.totalFiles = nextJob.sources.length;
          if (nextJob.permanent) {
            await releaseOpenStreamsForPaths(nextJob.sources);
            for (const resolved of nextJob.sources) {
              await waitWhilePaused(nextJob);
              nextJob.currentFile = path.basename(resolved) || resolved;
              nextJob.currentTarget = resolved;
              try {
                if (isPathProtected(resolved)) {
                  await moveToProtectedVault(resolved, 'permanent-delete');
                } else {
                  await fsp.rm(resolved, { recursive: true, force: true });
                }
                idx.removeIndexedPath(resolved);
                nextJob.doneFiles++;
                updateJobRate(nextJob);
                pushJobLog(nextJob, nextJob.currentFile, `${resolved} (Kalıcı silindi)`, 'ok');
              } catch (err) {
                nextJob.doneFiles++;
                nextJob.errorCount++;
                updateJobRate(nextJob);
                recordAppError('Kalıcı Silme', resolved, err.message);
                pushJobLog(nextJob, nextJob.currentFile, err.message, 'error');
              }
              if (nextJob.doneFiles % 10 === 0) await new Promise((r) => setImmediate(r));
            }
          } else if (nextJob.sources.length > 0) {
            await runRecycleBinJob(nextJob);
          }
        } else if (nextJob.op === 'batchRename') {
          nextJob.totalFiles = nextJob.sources.length;
          let num = Number(nextJob.startNum) || 1;
          const renamedPairs = [];
          for (const oldPath of nextJob.sources) {
            await waitWhilePaused(nextJob);
            nextJob.currentFile = path.basename(oldPath);
            try {
              const dir = path.dirname(oldPath);
              const ext = path.extname(oldPath);
              const base = path.basename(oldPath, ext);
              const st = await fsp.stat(oldPath);
              const d = new Date(st.mtimeMs);
              const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              const newBase = nextJob.pattern
                .replace(/\{name\}/g, base)
                .replace(/\{n\}/g, String(num).padStart(3, '0'))
                .replace(/\{date\}/g, dateStr);
              const target = makeUniquePath(path.join(dir, newBase + ext));
              nextJob.currentTarget = target;
              await fsp.rename(oldPath, target);
              idx.removeIndexedPath(oldPath);
              renamedPairs.push({ from: oldPath, to: target });
              nextJob.doneFiles++;
              updateJobRate(nextJob);
              pushJobLog(nextJob, path.basename(oldPath), `→ ${path.basename(target)}`, 'ok');
            } catch (err) {
              nextJob.doneFiles++;
              nextJob.errorCount++;
              updateJobRate(nextJob);
              recordAppError('Toplu Adlandırma', oldPath, err.message);
              pushJobLog(nextJob, path.basename(oldPath), err.message, 'error');
            }
            num++;
            if (nextJob.doneFiles % 15 === 0) await new Promise((r) => setImmediate(r));
          }
          if (renamedPairs.length > 0) {
            pushUndoEntry({
              type: 'rename',
              label: `Toplu Adlandırma (${renamedPairs.length} öğe)`,
              items: renamedPairs,
              refreshDirs: Array.from(new Set(renamedPairs.map((p) => path.dirname(p.to)))),
            });
          }
        } else if (nextJob.op === 'organizeByDate') {
          const parentDir = nextJob.parentDir;
          const destBaseDir = nextJob.destDir || parentDir;
          const outputFolderName = nextJob.outputFolderName || getOrganizeOutputFolderName(parentDir);
          const outputRootDir = path.join(destBaseDir, outputFolderName);
          const isCopy = nextJob.organizeMode === 'copy';
          const handle = await fsp.opendir(parentDir, { bufferSize: 128 });
          const files = [];
          const folderSet = new Set();
          let totalBytes = 0;
          for await (const dirent of handle) {
            if (nextJob.cancelled) throw new Error('İptal edildi');
            if (dirent.isDirectory()) continue;
            const fullPath = path.join(parentDir, dirent.name);
            try {
              const st = await fsp.stat(fullPath);
              const d = new Date(st.mtimeMs);
              const yyyy = String(d.getFullYear());
              const mm = `${yyyy}-${String(d.getMonth() + 1).padStart(2, '0')}`;
              const relFolder = path.join(yyyy, mm);
              folderSet.add(relFolder);
              totalBytes += st.size || 0;
              files.push({
                src: fullPath,
                name: dirent.name,
                relFolder,
                size: st.size || 0,
                atime: st.atime,
                mtime: st.mtime,
              });
            } catch (err) {
              nextJob.errorCount++;
              recordAppError('Tarihle Klasörle', fullPath, err.message);
            }
          }
          nextJob.totalFiles = files.length;
          nextJob.totalBytes = totalBytes;
          const createdDirs = [];
          if (!fs.existsSync(outputRootDir)) createdDirs.push(outputRootDir);
          for (const relFolder of folderSet) {
            const absSub = path.join(outputRootDir, relFolder);
            const absYear = path.dirname(absSub);
            if (!fs.existsSync(absYear)) createdDirs.push(absYear);
            if (!fs.existsSync(absSub)) createdDirs.push(absSub);
            await fsp.mkdir(absSub, { recursive: true });
          }
          const organizedPairs = [];
          for (const f of files) {
            await waitWhilePaused(nextJob);
            const target = makeUniquePath(path.join(outputRootDir, f.relFolder, f.name));
            nextJob.currentFile = f.name;
            nextJob.currentTarget = path.join(outputFolderName, f.relFolder, path.basename(target));
            try {
              if (isCopy) {
                await copyFileStreamSafe(f.src, target, nextJob);
                await fsp.utimes(target, f.atime, f.mtime).catch(() => {});
              } else {
                const sameRoot = path.parse(f.src).root.toLowerCase() === path.parse(target).root.toLowerCase();
                if (sameRoot) {
                  await fsp.rename(f.src, target);
                  idx.removeIndexedPath(f.src);
                  nextJob.doneBytes += f.size || 0;
                } else {
                  await copyFileStreamSafe(f.src, target, nextJob);
                  const [srcHash, destHash] = await Promise.all([
                    computeQuickFileHash(f.src, f.size),
                    computeQuickFileHash(target, f.size),
                  ]);
                  if (srcHash !== destHash) {
                    await fsp.unlink(target).catch(() => {});
                    throw new Error('Kopya bütünlük doğrulaması başarısız');
                  }
                  await fsp.utimes(target, f.atime, f.mtime).catch(() => {});
                  await fsp.unlink(f.src);
                  idx.removeIndexedPath(f.src);
                }
              }
              organizedPairs.push({ from: f.src, to: target });
              nextJob.doneFiles++;
              updateJobRate(nextJob);
              pushJobLog(nextJob, f.name, `${isCopy ? '📋' : '→'} ${nextJob.currentTarget}`, 'ok');
            } catch (err) {
              nextJob.doneFiles++;
              nextJob.errorCount++;
              updateJobRate(nextJob);
              recordAppError('Tarihle Klasörle', f.src, err.message);
              pushJobLog(nextJob, f.name, err.message, 'error');
            }
            if (nextJob.doneFiles % 15 === 0) await new Promise((r) => setImmediate(r));
          }
          if (organizedPairs.length > 0) {
            pushUndoEntry({
              type: isCopy ? 'copy' : 'move',
              label: `${isCopy ? 'Tarihle Kopyalayarak Klasörle' : 'Tarihle Taşıyarak Klasörle'} (${organizedPairs.length} öğe)`,
              items: organizedPairs,
              cleanupEmptyDirs: createdDirs,
              refreshDirs: Array.from(new Set([parentDir, destBaseDir])),
            });
          }
        } else {
          const sameDrive =
            nextJob.op === 'move' &&
            nextJob.sources.length > 0 &&
            nextJob.sources.every((s) => path.parse(s).root.toLowerCase() === path.parse(nextJob.destDir).root.toLowerCase());

          if (sameDrive) {
            nextJob.totalFiles = nextJob.sources.length;
            const movedPairs = [];
            for (const src of nextJob.sources) {
              await waitWhilePaused(nextJob);
              let target = path.join(nextJob.destDir, path.basename(src));
              if (target.toLowerCase() === path.resolve(src).toLowerCase()) {
                nextJob.doneFiles++;
                continue;
              }
              nextJob.currentFile = path.basename(src);
              nextJob.currentTarget = target;
              try {
                if (fs.existsSync(target)) {
                  if (nextJob.conflict === 'skip') {
                    nextJob.doneFiles++;
                    pushJobLog(nextJob, nextJob.currentFile, 'Atlandı (mevcut)', 'skip');
                    continue;
                  }
                  if (nextJob.conflict === 'rename') target = makeUniquePath(target);
                  else if (nextJob.conflict === 'overwrite') await fsp.rm(target, { recursive: true, force: true });
                }
                nextJob.currentTarget = target;
                await fsp.rename(src, target);
                idx.removeIndexedPath(src);
                movedPairs.push({ from: src, to: target });
                nextJob.doneFiles++;
                updateJobRate(nextJob);
                pushJobLog(nextJob, nextJob.currentFile, `→ ${target}`, 'ok');
              } catch (err) {
                nextJob.doneFiles++;
                nextJob.errorCount++;
                updateJobRate(nextJob);
                recordAppError('Taşıma', src, err.message);
                pushJobLog(nextJob, nextJob.currentFile, err.message, 'error');
              }
            }
            if (movedPairs.length > 0) {
              pushUndoEntry({
                type: 'move',
                label: `Taşıma (${movedPairs.length} öğe)`,
                items: movedPairs,
                cleanupEmptyDirs: nextJob.createdDir ? [nextJob.createdDir] : [],
                refreshDirs: Array.from(new Set([nextJob.destDir, ...movedPairs.map((p) => path.dirname(p.from))])),
              });
            }
          } else {
            const plan = { totalBytes: 0, dirs: [], files: [] };
            for (const src of nextJob.sources) {
              const sub = await collectFilesRecursive(src);
              plan.totalBytes += sub.totalBytes;
              plan.dirs.push(...sub.dirs);
              plan.files.push(...sub.files);
            }
            nextJob.totalBytes = plan.totalBytes;
            nextJob.totalFiles = plan.files.length;

            const createdDirs = [];
            if (nextJob.createdDir) createdDirs.push(nextJob.createdDir);
            for (const relDir of plan.dirs) {
              const targetSub = path.join(nextJob.destDir, relDir);
              if (!fs.existsSync(targetSub)) createdDirs.push(targetSub);
              await fsp.mkdir(targetSub, { recursive: true });
            }

            const movedOrCopied = [];
            for (const f of plan.files) {
              await waitWhilePaused(nextJob);

              let target = path.join(nextJob.destDir, f.rel);
              if (target.toLowerCase() === path.resolve(f.src).toLowerCase()) {
                target = makeUniquePath(target);
              } else if (fs.existsSync(target)) {
                if (nextJob.conflict === 'skip') {
                  nextJob.doneBytes += f.size;
                  nextJob.doneFiles++;
                  updateJobRate(nextJob);
                  pushJobLog(nextJob, path.basename(f.src), 'Atlandı (mevcut)', 'skip');
                  continue;
                }
                if (nextJob.conflict === 'rename') target = makeUniquePath(target);
              }

              nextJob.currentFile = path.basename(f.src);
              nextJob.currentTarget = target;
              try {
                await copyFileStreamSafe(f.src, target, nextJob);
                if (nextJob.op === 'move') {
                  const [srcHash, destHash] = await Promise.all([
                    computeQuickFileHash(f.src, f.size),
                    computeQuickFileHash(target, f.size),
                  ]);
                  if (srcHash !== destHash) {
                    await fsp.unlink(target).catch(() => {});
                    throw new Error('Doğrulama hatası: hedef dosya özeti uyuşmadı, kaynak korundu');
                  }
                  await fsp.unlink(f.src);
                  idx.removeIndexedPath(f.src);
                }
                movedOrCopied.push({ from: f.src, to: target });
                nextJob.doneFiles++;
                updateJobRate(nextJob);
                pushJobLog(nextJob, nextJob.currentFile, `→ ${target}`, 'ok');
              } catch (err) {
                if (nextJob.cancelled) throw err;
                nextJob.doneFiles++;
                nextJob.errorCount++;
                updateJobRate(nextJob);
                recordAppError(nextJob.op === 'move' ? 'Taşıma' : 'Kopyalama', f.src, err.message);
                pushJobLog(nextJob, nextJob.currentFile, err.message, 'error');
              }
            }

            if (nextJob.op === 'move' && nextJob.errorCount === 0) {
              for (const src of nextJob.sources) {
                try {
                  const st = await fsp.stat(src);
                  if (st.isDirectory()) await fsp.rm(src, { recursive: true, force: true });
                } catch {}
              }
            }

            if (movedOrCopied.length > 0) {
              pushUndoEntry({
                type: nextJob.op === 'move' ? 'move' : 'copy',
                label: `${nextJob.op === 'move' ? 'Taşıma' : 'Kopyalama'} (${movedOrCopied.length} dosya)`,
                items: movedOrCopied,
                cleanupEmptyDirs: createdDirs,
                refreshDirs: Array.from(new Set([nextJob.destDir, ...movedOrCopied.map((p) => path.dirname(p.from))])),
              });
            }
          }
        }

        nextJob.status = 'completed';
        nextJob.finishedAt = Date.now();
      } catch (err) {
        nextJob.status = nextJob.cancelled ? 'cancelled' : 'error';
        nextJob.error = err.message;
        nextJob.finishedAt = Date.now();
        if (!nextJob.cancelled) {
          recordAppError(nextJob.title, nextJob.destDir || nextJob.parentDir || '', err.message);
        }
      } finally {
        transferState.activeJob = null;
      }
    }
  } finally {
    transferState.workerRunning = false;
    transferState.paused = false;
  }
}


module.exports = {
  transferState,
  computeQuickFileHash,
  copyFileStreamSafe,
  collectFilesRecursive,
  pushJobLog,
  updateJobRate,
  createTransferJob,
  waitWhilePaused,
  runRecycleBinJob,
  processTransferQueue,
};
