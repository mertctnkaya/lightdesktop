'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');
const idx = require('../../indexer-and-thumbs');
const { runPowerShellEnv } = require('../utils/psRunner');
const { markDirsMutated, makeUniquePath } = require('./mutationTracker');
const { releaseOpenStreamsForPaths } = require('./streamRegistry');
const { getDrives } = require('./drivesAndFsService');
const { recordAppError } = require('./loggerService');
const { isPathProtected, moveToProtectedVault } = require('./protectedVaultService');

let cachedUserSid = null;
let lastKnownTrashCount = null;

async function getCurrentUserSid() {
  if (cachedUserSid) return cachedUserSid;
  const out = await new Promise((resolve, reject) => {
    execFile('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout || '');
    });
  });
  const matches = String(out).match(/S-1-[0-9-]+/);
  if (!matches) throw new Error('Kullanıcı SID bilgisi alınamadı');
  cachedUserSid = matches[0];
  return cachedUserSid;
}

function parseRecycleMetadata(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) return null;
  const version = buf.readBigInt64LE(0);
  const size = Number(buf.readBigInt64LE(8));
  const fileTime = buf.readBigInt64LE(16);
  const EPOCH_DIFF = 116444736000000000n;
  const deletedAt = fileTime > EPOCH_DIFF ? Number((fileTime - EPOCH_DIFF) / 10000n) : Date.now();

  let origPath = '';
  if (version === 1n && buf.length >= 26) {
    origPath = buf.subarray(24, Math.min(buf.length, 544)).toString('utf16le').replace(/\0.*$/, '');
  } else if (version === 2n && buf.length >= 28) {
    const charCount = buf.readUInt32LE(24);
    const byteEnd = Math.min(buf.length, 28 + charCount * 2);
    origPath = buf.subarray(28, byteEnd).toString('utf16le').replace(/\0+$/, '');
  } else {
    return null;
  }
  if (!origPath) return null;
  return { size: Math.max(0, size), deletedAt, origPath };
}

function getTrashMetaPath(rPath) {
  const dir = path.dirname(rPath);
  const base = path.basename(rPath);
  if (!base.startsWith('$R')) return '';
  return path.join(dir, '$I' + base.slice(2));
}

async function listRecycleBin() {
  const started = Date.now();
  const sid = await getCurrentUserSid();
  const drives = await getDrives(false);
  const items = [];
  let totalSize = 0;

  for (const d of drives) {
    if (!d.path || d.total <= 0) continue;
    const binDir = path.join(d.path, '$Recycle.Bin', sid);
    let handle;
    try {
      handle = await fsp.opendir(binDir, { bufferSize: 64 });
    } catch {
      continue;
    }
    try {
      for await (const dirent of handle) {
        if (!dirent.name.startsWith('$I')) continue;
        const iPath = path.join(binDir, dirent.name);
        const rName = '$R' + dirent.name.slice(2);
        const rPath = path.join(binDir, rName);
        try {
          const [buf, rStat] = await Promise.all([
            fsp.readFile(iPath),
            fsp.lstat(rPath).catch(() => null),
          ]);
          if (!rStat) continue;
          const meta = parseRecycleMetadata(buf);
          if (!meta) continue;
          const isDir = rStat.isDirectory();
          const ext = isDir ? '' : path.extname(meta.origPath).toLowerCase();
          const size = meta.size || (isDir ? 0 : rStat.size);
          totalSize += size;
          items.push({
            path: rPath,
            metaPath: iPath,
            name: path.basename(meta.origPath) || rName,
            origPath: meta.origPath,
            origDir: path.dirname(meta.origPath),
            ext,
            category: idx.getCategory(ext, isDir),
            isDir,
            size,
            mtime: meta.deletedAt,
            deletedAt: meta.deletedAt,
            ctime: meta.deletedAt,
            inTrash: true,
          });
        } catch {}
      }
    } catch {}
  }

  items.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  lastKnownTrashCount = items.length;
  return {
    path: 'TRASH',
    items,
    count: items.length,
    totalSize,
    durationMs: Date.now() - started,
  };
}

async function restoreFromRecycleBin(rPaths = [], { recordUndo = true } = {}) {
  const restored = [];
  const errors = [];

  for (const rawPath of rPaths) {
    const rPath = path.resolve(rawPath);
    const iPath = getTrashMetaPath(rPath);
    try {
      if (!iPath || !fs.existsSync(rPath)) {
        throw new Error('Öğe çöp kutusunda bulunamadı');
      }
      const buf = await fsp.readFile(iPath);
      const meta = parseRecycleMetadata(buf);
      if (!meta || !meta.origPath) {
        throw new Error('Özgün konum bilgisi okunamadı');
      }
      const origDir = path.dirname(meta.origPath);
      await fsp.mkdir(origDir, { recursive: true });
      const targetPath = fs.existsSync(meta.origPath) ? makeUniquePath(meta.origPath) : meta.origPath;
      await fsp.rename(rPath, targetPath);
      await fsp.unlink(iPath).catch(() => {});
      idx.removeIndexedPath(targetPath);
      restored.push({ rPath, targetPath, origPath: meta.origPath });
    } catch (err) {
      errors.push({ path: rPath, message: err.message });
      recordAppError('Çöpten Geri Yükleme', rPath, err.message);
    }
  }

  if (recordUndo && restored.length > 0) {
    const refreshDirs = Array.from(new Set(restored.map((x) => path.dirname(x.targetPath))));
    require('./undoService').pushUndoEntry({
      type: 'restore',
      label: `Geri Yükleme (${restored.length} öğe)`,
      items: restored.map((x) => ({ path: x.targetPath })),
      refreshDirs,
    });
  }
  if (lastKnownTrashCount !== null) {
    lastKnownTrashCount = Math.max(0, lastKnownTrashCount - restored.length);
  }
  return { ok: errors.length === 0 || restored.length > 0, restored, errors };
}

async function deleteFromRecycleBin(rPaths = []) {
  let deleted = 0;
  const errors = [];
  for (const rawPath of rPaths) {
    const rPath = path.resolve(rawPath);
    const iPath = getTrashMetaPath(rPath);
    try {
      let protectedOrig = '';
      if (iPath && fs.existsSync(iPath)) {
        try {
          const meta = parseRecycleMetadata(await fsp.readFile(iPath));
          if (meta && meta.origPath) protectedOrig = meta.origPath;
        } catch {}
      }
      if (fs.existsSync(rPath)) {
        if (protectedOrig && isPathProtected(protectedOrig)) {
          await moveToProtectedVault(rPath, 'trash-delete', protectedOrig);
        } else {
          await fsp.rm(rPath, { recursive: true, force: true });
        }
      }
      if (iPath && fs.existsSync(iPath)) {
        await fsp.rm(iPath, { force: true });
      }
      deleted++;
    } catch (err) {
      errors.push({ path: rPath, message: err.message });
      recordAppError('Çöpten Kalıcı Silme', rPath, err.message);
    }
  }
  if (lastKnownTrashCount !== null) {
    lastKnownTrashCount = Math.max(0, lastKnownTrashCount - deleted);
  }
  return { ok: true, deleted, errors };
}

async function emptyRecycleBin() {
  const list = await listRecycleBin();
  const res = await deleteFromRecycleBin(list.items.map((x) => x.path));
  lastKnownTrashCount = 0;
  return res;
}


let warmRecycleWorker = null;
function getWarmRecycleWorker() {
  if (warmRecycleWorker && !warmRecycleWorker.dead) return warmRecycleWorker;

  const workerScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try {
        $req = $line | ConvertFrom-Json
        $ok = New-Object System.Collections.Generic.List[string]
        $err = New-Object System.Collections.Generic.List[object]
        foreach ($p in $req.paths) {
          try {
            if (Test-Path -LiteralPath $p -PathType Container) {
              [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
              $ok.Add($p)
            } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
              [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
              $ok.Add($p)
            } else {
              $err.Add(@{ path = $p; message = 'Dosya veya klasör bulunamadı' })
            }
          } catch {
            $msg = $_.Exception.Message -replace "[\\r\\n]+", " "
            $err.Add(@{ path = $p; message = $msg })
          }
        }
        $out = @{ id = $req.id; ok = $ok; err = $err } | ConvertTo-Json -Compress -Depth 4
        [Console]::Out.WriteLine('RES|' + $out)
      } catch {
        $em = $_.Exception.Message -replace "[\\r\\n]+", " "
        [Console]::Out.WriteLine('FATAL|' + $em)
      }
      [Console]::Out.Flush()
    }
  `;

  const encoded = Buffer.from(workerScript, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });

  const worker = {
    proc,
    pending,
    dead: false,
    readyPromise,
    queueTail: Promise.resolve(),
  };

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line === 'READY') {
      readyResolve(true);
      return;
    }
    if (line.startsWith('RES|')) {
      try {
        const res = JSON.parse(line.slice(4));
        const cb = pending.get(res.id);
        if (cb) {
          pending.delete(res.id);
          cb.resolve(res);
        }
      } catch {}
    }
  });

  const failAll = (msg) => {
    worker.dead = true;
    if (warmRecycleWorker === worker) warmRecycleWorker = null;
    readyResolve(false);
    for (const cb of pending.values()) cb.reject(new Error(msg || 'Çöp kutusu işçisi kapandı'));
    pending.clear();
  };
  proc.on('error', (e) => failAll(e.message));
  proc.on('close', () => failAll('Çöp kutusu işçisi sonlandı'));

  warmRecycleWorker = worker;
  return worker;
}

async function sendPathsToRecycleBin(paths = []) {
  const resolvedList = paths.map((p) => path.resolve(p)).filter(Boolean);
  if (resolvedList.length === 0) return { okList: [], errList: [] };

  await releaseOpenStreamsForPaths(resolvedList);

  const worker = getWarmRecycleWorker();
  const runOnWorker = async () => {
    const isReady = await Promise.race([
      worker.readyPromise,
      new Promise((r) => setTimeout(() => r(false), 12000)),
    ]);
    if (!isReady || worker.dead) throw new Error('Çöp kutusu işçisi başlatılamadı');

    const reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(reqId);
        reject(new Error('Çöp kutusu işlemi zaman aşımına uğradı'));
      }, 120000);
      worker.pending.set(reqId, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      worker.proc.stdin.write(JSON.stringify({ id: reqId, paths: resolvedList }) + '\n', 'utf8');
    });

    const okList = Array.isArray(res.ok) ? res.ok : (res.ok ? [res.ok] : []);
    const errList = Array.isArray(res.err) ? res.err : (res.err ? [res.err] : []);
    for (const fp of okList) idx.removeIndexedPath(fp);
    if (lastKnownTrashCount !== null && okList.length > 0) {
      lastKnownTrashCount += okList.length;
    }
    return { okList, errList };
  };

  const p = worker.queueTail.then(runOnWorker, runOnWorker);
  worker.queueTail = p.catch(() => {});
  return p;
}


function getLastKnownTrashCount() {
  return lastKnownTrashCount;
}

function setLastKnownTrashCount(val) {
  lastKnownTrashCount = val;
}

module.exports = {
  getCurrentUserSid,
  parseRecycleMetadata,
  getTrashMetaPath,
  listRecycleBin,
  restoreFromRecycleBin,
  deleteFromRecycleBin,
  emptyRecycleBin,
  getWarmRecycleWorker,
  sendPathsToRecycleBin,
  getLastKnownTrashCount,
  setLastKnownTrashCount,
};
