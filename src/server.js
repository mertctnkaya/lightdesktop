'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const readline = require('node:readline');

const APP_VERSION = '1.6.0';
const PORT = Number(process.env.LIGHTDESKTOP_PORT) || 3847;
let activePort = PORT;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const idx = require('./indexer-and-thumbs');
const BOUNDS_FILE = path.join(idx.CACHE_ROOT, 'window-bounds.json');
const CRASH_DUMP_FILE = path.join(idx.CACHE_ROOT, 'crash-last.txt');

function resolveLogFile() {
  if (process.env.LD_LOG_FILE) {
    try {
      fs.mkdirSync(path.dirname(process.env.LD_LOG_FILE), { recursive: true });
      return process.env.LD_LOG_FILE;
    } catch {}
  }
  return path.join(idx.CACHE_ROOT, 'logs.txt');
}

const LOG_FILE = resolveLogFile();

const errorHistory = [];
let unreadErrors = 0;

// ---------- Geri Al (Ctrl+Z) & Çöp Kutusu Durumu ----------
const undoStack = [];
const MAX_UNDO_STACK = 50;
let cachedUserSid = null;
let lastKnownTrashCount = null;

function pushUndoEntry(entry) {
  if (!entry || !entry.type) return null;
  const normalized = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: Date.now(),
    ...entry,
  };
  undoStack.push(normalized);
  if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();
  return normalized;
}

function getUndoSummary() {
  const top = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
  return {
    count: undoStack.length,
    canUndo: undoStack.length > 0,
    topLabel: top ? top.label : '',
    topType: top ? top.type : '',
  };
}

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
    pushUndoEntry({
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
      if (fs.existsSync(rPath)) {
        await fsp.rm(rPath, { recursive: true, force: true });
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

// ---------- Açık Medya Akışlarını Anında Serbest Bırakma & Sıcak Çöp Kutusu İşçisi ----------
const activeOpenStreams = new Map(); // normPath -> Set<{ rs, res }>

function registerOpenStream(filePath, entry) {
  const key = path.resolve(filePath).toLowerCase();
  if (!activeOpenStreams.has(key)) activeOpenStreams.set(key, new Set());
  activeOpenStreams.get(key).add(entry);
  return key;
}

function unregisterOpenStream(key, entry) {
  const set = activeOpenStreams.get(key);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) activeOpenStreams.delete(key);
}

async function releaseOpenStreamsForPaths(paths = []) {
  const targets = (paths || []).filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  if (targets.length === 0 || activeOpenStreams.size === 0) return false;
  let released = false;
  for (const [streamPath, set] of Array.from(activeOpenStreams.entries())) {
    const match = targets.some((t) => streamPath === t || streamPath.startsWith(t.replace(/\\$/, '') + '\\'));
    if (!match) continue;
    for (const entry of Array.from(set)) {
      released = true;
      try { if (entry.rs && !entry.rs.destroyed) entry.rs.destroy(); } catch {}
      try { if (entry.res && !entry.res.writableEnded && !entry.res.destroyed) entry.res.end(); } catch {}
      set.delete(entry);
    }
    if (set.size === 0) activeOpenStreams.delete(streamPath);
  }
  if (released) {
    await new Promise((r) => setTimeout(r, 35));
  }
  return released;
}

let warmRecycleWorker = null;
function getWarmRecycleWorker() {
  if (warmRecycleWorker && !warmRecycleWorker.dead) return warmRecycleWorker;

  const workerScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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

async function movePathSafe(srcPath, destPath) {
  const src = path.resolve(srcPath);
  const destDir = path.dirname(destPath);
  await fsp.mkdir(destDir, { recursive: true });
  const target = fs.existsSync(destPath) ? makeUniquePath(destPath) : destPath;
  const sameRoot = path.parse(src).root.toLowerCase() === path.parse(target).root.toLowerCase();
  if (sameRoot) {
    await fsp.rename(src, target);
    idx.removeIndexedPath(src);
    return target;
  }
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    const plan = await collectFilesRecursive(src);
    for (const relDir of plan.dirs) {
      const relSub = relDir.split(path.sep).slice(1).join(path.sep);
      const subTarget = relSub ? path.join(target, relSub) : target;
      await fsp.mkdir(subTarget, { recursive: true });
    }
    for (const f of plan.files) {
      const relFile = f.rel.split(path.sep).slice(1).join(path.sep);
      const fTarget = path.join(target, relFile);
      await fsp.mkdir(path.dirname(fTarget), { recursive: true });
      await copyFileStreamSafe(f.src, fTarget, { doneBytes: 0, cancelled: false });
      const [h1, h2] = await Promise.all([
        computeQuickFileHash(f.src, f.size),
        computeQuickFileHash(fTarget, f.size),
      ]);
      if (h1 !== h2) {
        await fsp.unlink(fTarget).catch(() => {});
        throw new Error('Geri alma taşıma doğrulama hatası');
      }
      await fsp.unlink(f.src);
      idx.removeIndexedPath(f.src);
    }
    await fsp.rm(src, { recursive: true, force: true });
    return target;
  }
  await copyFileStreamSafe(src, target, { doneBytes: 0, cancelled: false });
  const [h1, h2] = await Promise.all([
    computeQuickFileHash(src, st.size),
    computeQuickFileHash(target, st.size),
  ]);
  if (h1 !== h2) {
    await fsp.unlink(target).catch(() => {});
    throw new Error('Geri alma taşıma doğrulama hatası');
  }
  await fsp.unlink(src);
  idx.removeIndexedPath(src);
  return target;
}

async function performUndo() {
  const entry = undoStack.pop();
  if (!entry) {
    return { ok: false, empty: true, message: 'Geri alınacak işlem yok', undoSummary: getUndoSummary() };
  }

  let undoneCount = 0;
  const errors = [];
  const refreshDirs = new Set(entry.refreshDirs || []);

  try {
    if (entry.type === 'rename' || entry.type === 'move') {
      const pairs = [...(entry.items || [])].reverse();
      for (const pair of pairs) {
        try {
          if (!fs.existsSync(pair.to)) {
            throw new Error(`Öğe bulunamadı: ${pair.to}`);
          }
          const restoredTo = await movePathSafe(pair.to, pair.from);
          refreshDirs.add(path.dirname(restoredTo));
          refreshDirs.add(path.dirname(pair.to));
          undoneCount++;
        } catch (err) {
          errors.push({ path: pair.to, message: err.message });
          recordAppError('Geri Al', pair.to, err.message);
        }
      }
      if (Array.isArray(entry.cleanupEmptyDirs)) {
        const sortedDirs = [...entry.cleanupEmptyDirs].sort((a, b) => b.length - a.length);
        for (const d of sortedDirs) {
          try {
            const left = await fsp.readdir(d);
            if (left.length === 0) await fsp.rmdir(d);
          } catch {}
        }
      }
    } else if (entry.type === 'mkdir') {
      for (const item of entry.items || []) {
        try {
          if (!fs.existsSync(item.path)) continue;
          const children = await fsp.readdir(item.path);
          if (children.length === 0) {
            await fsp.rmdir(item.path);
          } else {
            await sendPathsToRecycleBin([item.path]);
          }
          refreshDirs.add(path.dirname(item.path));
          undoneCount++;
        } catch (err) {
          errors.push({ path: item.path, message: err.message });
          recordAppError('Geri Al (Klasör)', item.path, err.message);
        }
      }
    } else if (entry.type === 'copy') {
      const targets = (entry.items || []).map((x) => x.to).filter((p) => fs.existsSync(p));
      if (targets.length > 0) {
        const res = await sendPathsToRecycleBin(targets);
        undoneCount += res.okList.length;
        for (const e of res.errList) errors.push(e);
      }
      if (Array.isArray(entry.cleanupEmptyDirs)) {
        const sortedDirs = [...entry.cleanupEmptyDirs].sort((a, b) => b.length - a.length);
        for (const d of sortedDirs) {
          try {
            const left = await fsp.readdir(d);
            if (left.length === 0) await fsp.rmdir(d);
          } catch {}
        }
      }
    } else if (entry.type === 'trash') {
      const bin = await listRecycleBin();
      const usedRPaths = new Set();
      const toRestore = [];
      for (const item of entry.items || []) {
        const normOrig = path.resolve(item.origPath).toLowerCase();
        const match = bin.items.find(
          (b) => !usedRPaths.has(b.path) && path.resolve(b.origPath).toLowerCase() === normOrig
        );
        if (match) {
          usedRPaths.add(match.path);
          toRestore.push(match.path);
        } else {
          errors.push({ path: item.origPath, message: 'Çöp kutusunda bulunamadı' });
        }
      }
      if (toRestore.length > 0) {
        const res = await restoreFromRecycleBin(toRestore, { recordUndo: false });
        undoneCount += res.restored.length;
        for (const r of res.restored) refreshDirs.add(path.dirname(r.targetPath));
        for (const e of res.errors) errors.push(e);
      }
    } else if (entry.type === 'restore') {
      const existing = (entry.items || []).map((x) => x.path).filter((p) => fs.existsSync(p));
      if (existing.length > 0) {
        const res = await sendPathsToRecycleBin(existing);
        undoneCount += res.okList.length;
        for (const p of res.okList) refreshDirs.add(path.dirname(p));
        for (const e of res.errList) errors.push(e);
      }
    }
  } catch (err) {
    errors.push({ path: '', message: err.message });
    recordAppError('Geri Al', entry.label || '', err.message);
  }

  return {
    ok: errors.length === 0 || undoneCount > 0,
    label: entry.label,
    type: entry.type,
    undoneCount,
    errors,
    refreshDirs: Array.from(refreshDirs),
    undoSummary: getUndoSummary(),
  };
}

function appendServerLog(msg) {
  try {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
        const prev = `${LOG_FILE}.prev`;
        try { if (fs.existsSync(prev)) fs.unlinkSync(prev); } catch {}
        fs.renameSync(LOG_FILE, prev);
      }
    } catch {}
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] [SERVER] ${msg}\n`, 'utf8');
  } catch {}
}

function recordAppError(op, target, message, extra = {}) {
  const cleanMsg = String(message || 'Bilinmeyen hata').trim();
  const cleanTarget = target ? String(target) : '';
  const cleanStack = extra && extra.stack ? String(extra.stack).trim().slice(0, 4000) : '';
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: new Date().toISOString(),
    op: op || 'Genel',
    target: cleanTarget,
    message: cleanMsg,
    stack: cleanStack || undefined,
    meta: extra && extra.meta ? extra.meta : undefined,
  };
  errorHistory.unshift(entry);
  if (errorHistory.length > 200) errorHistory.length = 200;
  unreadErrors++;
  const firstFrame = cleanStack ? ` | Stack: ${cleanStack.split(/\r?\n/).slice(0, 3).join(' <- ')}` : '';
  appendServerLog(`[${entry.op}] ${cleanTarget ? `${cleanTarget} -> ` : ''}${cleanMsg}${firstFrame}`);
  return entry;
}

if (typeof idx.getDbInitWarning === 'function' && idx.getDbInitWarning()) {
  recordAppError('SQLite Başlatma', idx.CACHE_ROOT, idx.getDbInitWarning());
}

const START_TIME = Date.now();
let serverListening = false;
let fallbackPortTried = false;

function getBackendCodeMtimeMs() {
  let maxMtime = 0;
  for (const f of [__filename, path.join(__dirname, 'indexer-and-thumbs.js')]) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {}
  }
  return Math.floor(maxMtime);
}

const START_CODE_MTIME = getBackendCodeMtimeMs();

function writeFatalCrashDump(kind, err) {
  const stack = err && err.stack ? err.stack : String(err);
  const report = [
    `LightDesktop Crash Report (${new Date().toISOString()})`,
    `Version: ${APP_VERSION} | Portable: ${process.env.LD_PORTABLE === '1' ? 'Yes' : 'No'}`,
    `Node: ${process.version} | Arch: ${process.arch} | OS: ${os.type()} ${os.release()}`,
    `Kind: ${kind}`,
    `CacheRoot: ${idx.CACHE_ROOT}`,
    `LogFile: ${LOG_FILE}`,
    `Error:`,
    stack,
  ].join('\n');
  appendServerLog(`${kind} (FATAL): ${stack}`);
  try { fs.writeFileSync(CRASH_DUMP_FILE, report, 'utf8'); } catch {}
  try { console.error(report); } catch {}
}

process.on('uncaughtException', (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  if (!serverListening || (err && err.code === 'EADDRINUSE')) {
    writeFatalCrashDump('uncaughtException', err);
    process.exit(1);
    return;
  }
  recordAppError('Sunucu (Kurtarıldı)', err && err.code ? err.code : '', err && err.message ? err.message : msg, { stack: msg });
});

process.on('unhandledRejection', (reason) => {
  const stack = reason && reason.stack ? reason.stack : String(reason);
  const msg = reason && reason.message ? reason.message : stack;
  recordAppError('Sunucu (Promise Kurtarıldı)', '', msg, { stack });
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

function sendJson(res, status, data) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function pipeFileStream(req, res, filePath, streamOpts = undefined) {
  const rs = fs.createReadStream(filePath, streamOpts);
  const streamEntry = { rs, res };
  const streamKey = registerOpenStream(filePath, streamEntry);
  const cleanup = () => {
    unregisterOpenStream(streamKey, streamEntry);
    try {
      if (!rs.destroyed) rs.destroy();
    } catch {}
  };
  rs.on('error', (err) => {
    cleanup();
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(404);
      res.end('Dosya okunamadı');
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    if (err && err.code !== 'ENOENT' && err.code !== 'ECONNRESET') {
      recordAppError('Dosya Akışı', filePath, err.message);
    }
  });
  rs.on('close', () => unregisterOpenStream(streamKey, streamEntry));
  res.on('close', cleanup);
  req.on('aborted', cleanup);
  rs.pipe(res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 10 * 1024 * 1024) {
        req.destroy();
        return reject(new Error('İstek boyutu çok büyük'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Geçersiz JSON gövdesi'));
      }
    });
    req.on('error', reject);
  });
}

function runPowerShellEnv(script, envVars = {}, timeoutMs = 30000, useSta = false) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const psArgs = ['-NoProfile', '-NonInteractive'];
    if (useSta) psArgs.push('-STA');
    psArgs.push('-EncodedCommand', encoded);
    execFile(
      'powershell.exe',
      psArgs,
      { env: { ...process.env, ...envVars }, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const cleanErr = String(stderr || '').trim()
            || String(err.message || '').replace(/powershell\.exe[\s\S]*?-EncodedCommand\s+[A-Za-z0-9+/=]+/i, `PowerShell hatası (kod ${err.code || 1})`);
          return reject(new Error(cleanErr || `PowerShell hatası (kod ${err.code || 1})`));
        }
        resolve(stdout);
      }
    );
  });
}

async function setOsFileClipboard(op, paths = []) {
  const valid = (Array.isArray(paths) ? paths : []).map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));
  if (valid.length === 0) return { ok: false, count: 0 };
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $paths = $env:LD_CLIP_PATHS -split [char]10 | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    if ($paths.Count -gt 0) {
      $col = New-Object System.Collections.Specialized.StringCollection
      foreach ($p in $paths) { [void]$col.Add($p) }
      $data = New-Object System.Windows.Forms.DataObject
      $data.SetFileDropList($col)
      $effectVal = if ($env:LD_CLIP_OP -eq 'cut') { [byte[]](2,0,0,0) } else { [byte[]](5,0,0,0) }
      $ms = New-Object System.IO.MemoryStream(, $effectVal)
      $data.SetData('Preferred DropEffect', $ms)
      [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
    }
    exit 0
  `;
  await runPowerShellEnv(psScript, {
    LD_CLIP_OP: op === 'cut' ? 'cut' : 'copy',
    LD_CLIP_PATHS: valid.join('\n'),
  }, 8000, true);
  return { ok: true, count: valid.length };
}

async function getOsFileClipboard() {
  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Windows.Forms
    $paths = @()
    $op = 'copy'
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      $list = [System.Windows.Forms.Clipboard]::GetFileDropList()
      foreach ($p in $list) { if ($p) { $paths += $p } }
      $data = [System.Windows.Forms.Clipboard]::GetDataObject()
      if ($data -and $data.GetDataPresent('Preferred DropEffect')) {
        $eff = $data.GetData('Preferred DropEffect')
        if ($eff -is [System.IO.MemoryStream]) {
          $bytes = $eff.ToArray()
          if ($bytes.Length -ge 1 -and ($bytes[0] -band 2) -eq 2 -and ($bytes[0] -band 1) -eq 0) {
            $op = 'cut'
          }
        }
      }
    }
    @{ op = $op; paths = $paths } | ConvertTo-Json -Compress
    exit 0
  `;
  try {
    const out = await runPowerShellEnv(psScript, {}, 6000, true);
    const parsed = JSON.parse(String(out || '').trim() || '{}');
    const paths = Array.isArray(parsed.paths) ? parsed.paths : (parsed.paths ? [parsed.paths] : []);
    return { ok: true, op: parsed.op === 'cut' ? 'cut' : 'copy', paths: paths.filter((p) => fs.existsSync(p)) };
  } catch {
    return { ok: false, op: 'copy', paths: [] };
  }
}

// ---------- Sürücü Bilgileri (30sn önbellekli) ----------
let drivesCache = { ts: 0, list: [] };

async function getDrives(force = false) {
  if (!force && Date.now() - drivesCache.ts < 30000 && drivesCache.list.length > 0) {
    return drivesCache.list;
  }

  // Hızlı statfs fallback + PowerShell ile gerçek birim adlarını al (en fazla 4 sn bekle)
  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, DriveType, Size, FreeSpace | ConvertTo-Json -Compress
  `;
  let list = [];
  try {
    const out = await runPowerShellEnv(psScript, {}, 4500);
    const parsed = JSON.parse(out || '[]');
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    list = arr
      .filter((d) => d && d.DeviceID)
      .map((d) => {
        const total = Number(d.Size) || 0;
        const free = Number(d.FreeSpace) || 0;
        const used = Math.max(0, total - free);
        const letter = d.DeviceID.replace(':', '');
        return {
          id: d.DeviceID,
          path: `${d.DeviceID}\\`,
          label: d.VolumeName || (letter === 'C' ? 'Yerel Disk' : 'Disk'),
          driveType: Number(d.DriveType) || 3,
          total,
          free,
          used,
          usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        };
      });
  } catch {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      try {
        const st = fs.statfsSync(root);
        const total = st.blocks * st.bsize;
        const free = st.bfree * st.bsize;
        const used = Math.max(0, total - free);
        list.push({
          id: `${letter}:`,
          path: root,
          label: letter === 'C' ? 'Yerel Disk' : 'Disk',
          driveType: 3,
          total,
          free,
          used,
          usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        });
      } catch {}
    }
  }

  drivesCache = { ts: Date.now(), list };
  return list;
}

function getQuickAccessFolders() {
  const home = os.homedir();
  const candidates = [
    { id: 'desktop', name: 'Masaüstü', path: path.join(home, 'Desktop'), icon: 'desktop' },
    { id: 'downloads', name: 'İndirilenler', path: path.join(home, 'Downloads'), icon: 'downloads' },
    { id: 'documents', name: 'Belgeler', path: path.join(home, 'Documents'), icon: 'documents' },
    { id: 'pictures', name: 'Resimler', path: path.join(home, 'Pictures'), icon: 'pictures' },
    { id: 'music', name: 'Müzikler', path: path.join(home, 'Music'), icon: 'music' },
    { id: 'videos', name: 'Videolar', path: path.join(home, 'Videos'), icon: 'videos' },
  ];
  return candidates.filter((c) => fs.existsSync(c.path));
}

// ---------- Sıfır Ön-Okumalı Hızlı Dizin Listeleme ----------
async function listDirectory(dirPath, forceRefresh = false) {
  const t0 = performance.now();
  let resolved = path.resolve(dirPath);
  if (/^[a-zA-Z]:$/.test(resolved)) resolved += '\\';

  const handle = await fsp.opendir(resolved, { bufferSize: 128 });
  const rawEntries = [];
  for await (const dirent of handle) {
    const isDir = dirent.isDirectory();
    const ext = isDir ? '' : path.extname(dirent.name).toLowerCase();
    rawEntries.push({
      name: dirent.name,
      path: path.join(resolved, dirent.name),
      isDir,
      ext,
      category: idx.getCategory(ext, isDir),
    });
  }

  const cachedMap = !forceRefresh ? idx.getCachedStatsMap(resolved) : new Map();
  const useCacheForLarge = !forceRefresh && rawEntries.length > 1500;
  const items = new Array(rawEntries.length);

  // Yalnızca MFT/dizin metadata'sı (stat); dosya içeriği ASLA okunmaz. Küçük gruplarla (12) çalıştırılır.
  const toStat = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    const cached = cachedMap.get(entry.path);
    if (useCacheForLarge && cached) {
      const thumbKey = entry.isDir ? null : idx.makeThumbKey(entry.path, cached.mtime, cached.size);
      items[i] = {
        ...entry,
        size: cached.size,
        mtime: cached.mtime,
        ctime: cached.ctime,
        hasCachedThumb: thumbKey ? idx.getThumbCacheInfo(entry.path, cached.mtime, cached.size).cached : false,
      };
    } else {
      toStat.push({ index: i, entry });
    }
  }

  for (let i = 0; i < toStat.length; i += 12) {
    const batch = toStat.slice(i, i + 12);
    await Promise.all(
      batch.map(async ({ index, entry }) => {
        let size = 0;
        let mtime = 0;
        let ctime = 0;
        try {
          const st = await fsp.stat(entry.path);
          size = entry.isDir ? 0 : st.size;
          mtime = Math.floor(st.mtimeMs);
          ctime = Math.floor(st.birthtimeMs || st.ctimeMs);
        } catch {}
        items[index] = {
          ...entry,
          size,
          mtime,
          ctime,
          hasCachedThumb: entry.isDir ? false : idx.getThumbCacheInfo(entry.path, mtime, size).cached,
        };
      })
    );
  }

  // Arka planda SQLite arama indeksine kaydet (UI yanıtını bekletmez)
  setImmediate(() => {
    try {
      idx.upsertDirEntries(resolved, items);
    } catch {}
  });

  const durationMs = Number((performance.now() - t0).toFixed(2));
  return { path: resolved, count: items.length, durationMs, items };
}

const subdirCollator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
const TREE_SKIP_DIRS = new Set(['$recycle.bin', 'system volume information']);

async function listSubdirs(dirPath) {
  let resolved = path.resolve(dirPath);
  if (/^[a-zA-Z]:$/.test(resolved)) resolved += '\\';

  const handle = await fsp.opendir(resolved, { bufferSize: 128 });
  const dirs = [];
  for await (const dirent of handle) {
    if (!dirent.isDirectory()) continue;
    if (TREE_SKIP_DIRS.has(dirent.name.toLowerCase())) continue;
    dirs.push({
      name: dirent.name,
      path: path.join(resolved, dirent.name),
    });
  }
  dirs.sort((a, b) => subdirCollator.compare(a.name, b.name));
  return { path: resolved, dirs };
}

// ---------- HDD Dostu Sıralı Transfer Kuyruğu (Concurrency = 1) ----------
const transferState = {
  jobs: [],
  activeJob: null,
  paused: false,
  workerRunning: false,
};

function makeUniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let i = 1;
  while (true) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

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
    organizeByDate: 'Tarihe Göre Klasörleniyor',
  };
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    op,
    title: opts.title || titleMap[op] || 'İşlem Yürütülüyor',
    sources: Array.isArray(opts.sources) ? opts.sources.map((s) => path.resolve(s)) : [],
    destDir: opts.destDir ? path.resolve(opts.destDir) : '',
    parentDir: opts.parentDir ? path.resolve(opts.parentDir) : '',
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
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
                await fsp.rm(resolved, { recursive: true, force: true });
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
          const handle = await fsp.opendir(parentDir, { bufferSize: 128 });
          const files = [];
          const folderSet = new Set();
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
              files.push({ src: fullPath, name: dirent.name, relFolder });
            } catch (err) {
              nextJob.errorCount++;
              recordAppError('Tarihle Klasörle', fullPath, err.message);
            }
          }
          nextJob.totalFiles = files.length;
          const createdDirs = [];
          for (const relFolder of folderSet) {
            const absSub = path.join(parentDir, relFolder);
            const absYear = path.dirname(absSub);
            if (!fs.existsSync(absYear)) createdDirs.push(absYear);
            if (!fs.existsSync(absSub)) createdDirs.push(absSub);
            await fsp.mkdir(absSub, { recursive: true });
          }
          const organizedPairs = [];
          for (const f of files) {
            await waitWhilePaused(nextJob);
            const target = makeUniquePath(path.join(parentDir, f.relFolder, f.name));
            nextJob.currentFile = f.name;
            nextJob.currentTarget = path.join(f.relFolder, path.basename(target));
            try {
              await fsp.rename(f.src, target);
              idx.removeIndexedPath(f.src);
              organizedPairs.push({ from: f.src, to: target });
              nextJob.doneFiles++;
              updateJobRate(nextJob);
              pushJobLog(nextJob, f.name, `→ ${nextJob.currentTarget}`, 'ok');
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
              type: 'move',
              label: `Tarihle Klasörle (${organizedPairs.length} öğe)`,
              items: organizedPairs,
              cleanupEmptyDirs: createdDirs,
              refreshDirs: [parentDir],
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
    const newDir = makeUniquePath(path.join(path.resolve(body.parentDir), body.name || 'Yeni Klasör'));
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
            await fsp.rm(resolved, { recursive: true, force: true });
            idx.removeIndexedPath(resolved);
          }
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
        return { ok: true, deleted: resolvedList.length, undoSummary: getUndoSummary(), trashCount: lastKnownTrashCount };
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

  if (action === 'organizeByDate') {
    const parentDir = path.resolve(body.parentDir);
    const dryRun = Boolean(body.dryRun);
    if (dryRun) {
      const handle = await fsp.opendir(parentDir, { bufferSize: 128 });
      const files = [];
      for await (const dirent of handle) {
        if (dirent.isDirectory()) continue;
        const fullPath = path.join(parentDir, dirent.name);
        try {
          const st = await fsp.stat(fullPath);
          const d = new Date(st.mtimeMs);
          const yyyy = String(d.getFullYear());
          const mm = `${yyyy}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          const relFolder = path.join(yyyy, mm);
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
      return { ok: true, totalFiles: files.length, folderCount: folderMap.size, preview };
    }

    const job = createTransferJob({
      op: 'organizeByDate',
      parentDir,
    });
    processTransferQueue();
    return { ok: true, queued: true, jobId: job.id, job };
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
  const devBatPath = path.resolve(__dirname, '..', 'Baslat-LightDesktop.bat');
  const distExePath = path.resolve(__dirname, '..', 'dist', 'LightDesktop.exe');
  const hasDistExe = fs.existsSync(distExePath);
  const preferredExe = hasFixedExe ? fixedExePath : (isPortable ? exePath : (hasDistExe ? distExePath : ''));
  const targetPath = preferredExe || (fs.existsSync(devBatPath) ? devBatPath : path.join(__dirname, 'Baslat-LightDesktop.bat'));
  const usesExe = targetPath.toLowerCase().endsWith('.exe');
  const workDir = usesExe ? path.dirname(targetPath) : path.dirname(targetPath);
  const customIco = path.join(__dirname, 'public', 'favicon.ico');
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

// ---------- Medya Akışı (HTTP Range Destekli QuickLook) ----------
async function streamMedia(req, res, filePath) {
  try {
    const resolved = path.resolve(filePath);
    const st = await fsp.stat(resolved);
    if (!st.isFile()) {
      res.writeHead(404);
      return res.end('Dosya bulunamadı');
    }
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const start = match ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? Math.min(parseInt(match[2], 10), st.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, st.size - 1);
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
      });
      pipeFileStream(req, res, resolved, { start, end });
    } else {
      res.writeHead(200, {
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
      });
      pipeFileStream(req, res, resolved);
    }
  } catch (err) {
    res.writeHead(404);
    res.end(err.message);
  }
}

// ---------- HTTP Sunucu Yönlendiricisi ----------
function buildDiagnosticsPayload() {
  let logsTail = '';
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      logsTail = content.split(/\r?\n/).slice(-150).join('\n').trim();
    }
  } catch {}
  return {
    appVersion: APP_VERSION,
    portable: process.env.LD_PORTABLE === '1',
    exePath: process.env.LD_EXE_PATH || '',
    uiHost: process.env.LD_UI_HOST || '',
    nodeVersion: process.version,
    arch: process.arch,
    osPlatform: `${os.type()} ${os.release()}`,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
    port: activePort,
    cacheRoot: idx.CACHE_ROOT,
    logFile: LOG_FILE,
    crashDumpFile: fs.existsSync(CRASH_DUMP_FILE) ? CRASH_DUMP_FILE : '',
    ffmpegBin: typeof idx.getFfmpegBin === 'function' ? (idx.getFfmpegBin() || 'Windows Shell Fallback (0 MB)') : 'Bilinmiyor',
    dbInitWarning: typeof idx.getDbInitWarning === 'function' ? idx.getDbInitWarning() : '',
    totalErrors: errorHistory.length,
    unreadErrors,
    errors: errorHistory.slice(0, 100),
    logsTail,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${activePort}`);
    const pathname = url.pathname;

    if (pathname === '/api/health' && req.method === 'GET') {
      const scanInfo = idx.getScanProgress();
      const indexStats = idx.getIndexStats();
      const hasActiveJob = transferState.jobs.some((j) => j.status === 'running' || j.status === 'queued');
      return sendJson(res, 200, {
        ok: true,
        appVersion: APP_VERSION,
        portable: process.env.LD_PORTABLE === '1',
        pid: process.pid,
        port: activePort,
        serverDir: __dirname,
        startedAt: START_TIME,
        startCodeMtimeMs: START_CODE_MTIME,
        currentCodeMtimeMs: getBackendCodeMtimeMs(),
        busy: Boolean(hasActiveJob || indexStats.running || (scanInfo.activeCount || 0) > 0),
      });
    }

    if (pathname === '/api/diagnostics' && req.method === 'GET') {
      return sendJson(res, 200, buildDiagnosticsPayload());
    }

    if (pathname === '/api/system/integration' && req.method === 'GET') {
      return sendJson(res, 200, await getSystemIntegrationStatus());
    }

    if (pathname === '/api/system/integration' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await applySystemIntegration(body));
    }

    if (pathname === '/api/init' && req.method === 'GET') {
      const drives = await getDrives(url.searchParams.get('refresh') === '1');
      let trashCount = lastKnownTrashCount;
      if (trashCount === null) {
        try {
          const bin = await listRecycleBin();
          trashCount = bin.count;
        } catch {
          trashCount = 0;
        }
      }
      return sendJson(res, 200, {
        drives,
        quickAccess: getQuickAccessFolders(),
        pins: idx.getPins(),
        indexStats: idx.getIndexStats(),
        undoSummary: getUndoSummary(),
        trashCount,
      });
    }

    if (pathname === '/api/window-bounds' && req.method === 'GET') {
      try {
        const raw = await fsp.readFile(BOUNDS_FILE, 'utf8');
        return sendJson(res, 200, JSON.parse(raw));
      } catch {
        return sendJson(res, 200, {});
      }
    }

    if (pathname === '/api/window-bounds' && req.method === 'POST') {
      const b = await readJsonBody(req);
      if (b && Number(b.width) >= 400 && Number(b.height) >= 300) {
        const clean = {
          x: Math.round(Number(b.x) || 0),
          y: Math.round(Number(b.y) || 0),
          width: Math.round(Number(b.width)),
          height: Math.round(Number(b.height)),
        };
        await fsp.writeFile(BOUNDS_FILE, JSON.stringify(clean), 'utf8');
        return sendJson(res, 200, { ok: true, bounds: clean });
      }
      return sendJson(res, 400, { error: 'Geçersiz pencere boyutu' });
    }

    if (pathname === '/api/list' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path');
      if (!dirPath) return sendJson(res, 400, { error: 'path parametresi gerekli' });
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const data = await listDirectory(dirPath, forceRefresh);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/subdirs' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path');
      if (!dirPath) return sendJson(res, 400, { error: 'path parametresi gerekli' });
      const data = await listSubdirs(dirPath);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/thumb' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      const mtime = Number(url.searchParams.get('mtime') || 0);
      const size = Number(url.searchParams.get('size') || 0);
      const session = url.searchParams.get('session') || 'default';
      if (!filePath) return sendJson(res, 400, { error: 'path gerekli' });
      try {
        const thumbPath = await idx.getOrCreateThumbnail(filePath, mtime, size, session);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' });
        pipeFileStream(req, res, thumbPath);
      } catch (err) {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(err.cancelled ? 499 : 404);
          res.end();
        }
      }
      return;
    }

    if (pathname === '/api/thumb/cancel' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const cancelled = idx.cancelThumbQueue(body.session || null);
      return sendJson(res, 200, { ok: true, cancelled });
    }

    if (pathname === '/api/media' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return sendJson(res, 400, { error: 'path gerekli' });
      return streamMedia(req, res, filePath);
    }

    if (pathname === '/api/search' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await idx.searchFiles(body);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/related' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await idx.findRelatedFiles(body);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/clipboard/os' && req.method === 'GET') {
      const clipData = await getOsFileClipboard();
      return sendJson(res, 200, clipData);
    }

    if (pathname === '/api/clipboard/os' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const resData = await setOsFileClipboard(body.op, body.paths);
      return sendJson(res, 200, resData);
    }

    if (pathname === '/api/fs/upload-external' && req.method === 'POST') {
      const destDir = url.searchParams.get('destDir');
      const rawName = path.basename(url.searchParams.get('name') || '');
      if (!destDir || !rawName) return sendJson(res, 400, { error: 'destDir ve name gerekli' });
      const resolvedDir = path.resolve(destDir);
      const destPath = makeUniquePath(path.join(resolvedDir, rawName));
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(destPath);
        req.on('error', (err) => { ws.destroy(); reject(err); });
        ws.on('error', reject);
        ws.on('finish', resolve);
        req.pipe(ws);
      });
      return sendJson(res, 200, { ok: true, path: destPath });
    }

    if (pathname === '/api/analyze' && req.method === 'GET') {
      const targetPath = url.searchParams.get('path');
      const mode = url.searchParams.get('mode') || 'auto';
      if (!targetPath) return sendJson(res, 400, { error: 'path gerekli' });
      let result = null;
      if (mode !== 'live') {
        const cached = idx.analyzeFromCache(targetPath);
        if (cached.totalFiles > 0 || mode === 'cached') {
          result = cached;
        }
      }
      if (!result) {
        result = await idx.analyzeLive(targetPath);
      }
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/folder-sizes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const data = await idx.calculateFolderSizes(body.parentDir, paths);
      if (res.writableEnded || res.destroyed) return;
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/folder-sizes/cancel' && req.method === 'POST') {
      return sendJson(res, 200, idx.cancelFolderSizes());
    }

    if (pathname === '/api/duplicates' && req.method === 'GET') {
      const targetPath = url.searchParams.get('path');
      if (!targetPath) return sendJson(res, 400, { error: 'path gerekli' });
      const data = await idx.findDuplicates(targetPath);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/index/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.path) return sendJson(res, 400, { error: 'path gerekli' });
      return sendJson(res, 200, await idx.startBackgroundIndex(body.path));
    }

    if (pathname === '/api/index/stop' && req.method === 'POST') {
      return sendJson(res, 200, idx.stopBackgroundIndex());
    }

    if (pathname === '/api/index/status' && req.method === 'GET') {
      return sendJson(res, 200, idx.getIndexStats());
    }

    if (pathname === '/api/pins' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const pins = body.remove ? idx.removePin(body.path) : idx.addPin(body.path, body.name);
      return sendJson(res, 200, { ok: true, pins });
    }

    if (pathname === '/api/fs/action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await handleFsAction(body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/transfer/enqueue' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const job = createTransferJob({
        op: body.op === 'move' ? 'move' : 'copy',
        sources: body.sources || [],
        destDir: body.destDir,
        conflict: body.conflict || 'rename',
      });
      processTransferQueue();
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname === '/api/transfer/status' && req.method === 'GET') {
      const scanInfo = idx.getScanProgress();
      return sendJson(res, 200, {
        paused: transferState.paused,
        jobs: transferState.jobs.slice(-15),
        scan: scanInfo,
        scans: scanInfo.scans || [],
        index: idx.getIndexStats(),
        undoSummary: getUndoSummary(),
        trashCount: lastKnownTrashCount,
        errorSummary: {
          total: errorHistory.length,
          unread: unreadErrors,
        },
      });
    }

    if (pathname === '/api/trash/list' && req.method === 'GET') {
      const data = await listRecycleBin();
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/trash/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await restoreFromRecycleBin(Array.isArray(body.paths) ? body.paths : []);
      return sendJson(res, 200, { ...data, undoSummary: getUndoSummary(), trashCount: lastKnownTrashCount });
    }

    if (pathname === '/api/trash/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await deleteFromRecycleBin(Array.isArray(body.paths) ? body.paths : []);
      return sendJson(res, 200, { ...data, trashCount: lastKnownTrashCount });
    }

    if (pathname === '/api/trash/empty' && req.method === 'POST') {
      const data = await emptyRecycleBin();
      return sendJson(res, 200, { ...data, trashCount: 0 });
    }

let activePropsToken = null;

async function getItemsProperties(rawPaths = [], cancelToken = { aborted: false }) {
  const started = Date.now();
  const uniquePaths = Array.from(new Set((rawPaths || []).filter(Boolean).map((p) => path.resolve(p))));
  let selectedFiles = 0;
  let selectedFolders = 0;
  let totalFiles = 0;
  let totalFolders = 0;
  let totalBytes = 0;
  let minCtime = Infinity;
  let maxMtime = 0;
  let maxAtime = 0;
  let steps = 0;
  const itemSummaries = [];

  for (const p of uniquePaths) {
    if (cancelToken.aborted) break;
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue;
    }

    const ctime = st.birthtimeMs || st.ctimeMs || 0;
    const mtime = st.mtimeMs || 0;
    const atime = st.atimeMs || 0;
    if (ctime > 0 && ctime < minCtime) minCtime = ctime;
    if (mtime > maxMtime) maxMtime = mtime;
    if (atime > maxAtime) maxAtime = atime;

    if (!st.isDirectory()) {
      selectedFiles++;
      totalFiles++;
      totalBytes += st.size || 0;
      const ext = path.extname(p).toLowerCase();
      itemSummaries.push({
        path: p,
        name: path.basename(p) || p,
        dir: path.dirname(p),
        isDir: false,
        ext,
        category: idx.getCategory(ext, false),
        size: st.size || 0,
        fileCount: 1,
        folderCount: 0,
        ctime,
        mtime,
        atime,
      });
      continue;
    }

    selectedFolders++;
    let dirBytes = 0;
    let dirFiles = 0;
    let dirSubFolders = 0;
    const queue = [p];

    while (queue.length > 0) {
      if (cancelToken.aborted) break;
      const curDir = queue.shift();
      let handle;
      try {
        handle = await fsp.opendir(curDir, { bufferSize: 128 });
      } catch {
        continue;
      }
      const cachedMap = idx.getCachedStatsMap(curDir);
      try {
        for await (const dirent of handle) {
          if (cancelToken.aborted) break;
          const full = path.join(curDir, dirent.name);
          if (dirent.isDirectory()) {
            dirSubFolders++;
            totalFolders++;
            if (!dirent.isSymbolicLink()) queue.push(full);
          } else {
            dirFiles++;
            totalFiles++;
            const c = cachedMap.get(full);
            if (c && typeof c.size === 'number') {
              dirBytes += c.size;
              if (c.mtime > maxMtime) maxMtime = c.mtime;
              if (c.ctime > 0 && c.ctime < minCtime) minCtime = c.ctime;
            } else {
              try {
                const fst = await fsp.lstat(full);
                dirBytes += fst.size || 0;
                const fm = fst.mtimeMs || 0;
                const fc = fst.birthtimeMs || fst.ctimeMs || 0;
                if (fm > maxMtime) maxMtime = fm;
                if (fc > 0 && fc < minCtime) minCtime = fc;
              } catch {}
            }
          }
          if (++steps % 200 === 0) await new Promise((r) => setImmediate(r));
        }
      } catch {}
    }

    totalBytes += dirBytes;
    itemSummaries.push({
      path: p,
      name: path.basename(p) || p,
      dir: path.dirname(p),
      isDir: true,
      ext: '',
      category: 'folder',
      size: dirBytes,
      fileCount: dirFiles,
      folderCount: dirSubFolders,
      ctime,
      mtime,
      atime,
    });
  }

  const dirsSet = new Set(itemSummaries.map((x) => x.dir.toLowerCase()));
  const commonDir = dirsSet.size === 1 && itemSummaries[0] ? itemSummaries[0].dir : 'Birden fazla konum';

  return {
    ok: true,
    aborted: Boolean(cancelToken.aborted),
    itemCount: itemSummaries.length,
    selectedFiles,
    selectedFolders,
    totalFiles,
    totalFolders,
    totalBytes,
    minCtime: Number.isFinite(minCtime) ? minCtime : 0,
    maxMtime,
    maxAtime,
    commonDir,
    singleItem: itemSummaries.length === 1 ? itemSummaries[0] : null,
    items: itemSummaries.slice(0, 100),
    durationMs: Date.now() - started,
  };
}

    if (pathname === '/api/undo' && req.method === 'POST') {
      const data = await performUndo();
      return sendJson(res, 200, { ...data, trashCount: lastKnownTrashCount });
    }

    if (pathname === '/api/fs/properties' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (activePropsToken) activePropsToken.aborted = true;
      const token = { aborted: false };
      activePropsToken = token;
      const data = await getItemsProperties(Array.isArray(body.paths) ? body.paths : [], token);
      if (activePropsToken === token) activePropsToken = null;
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/fs/properties/cancel' && req.method === 'POST') {
      if (activePropsToken) activePropsToken.aborted = true;
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/errors' && req.method === 'GET') {
      if (url.searchParams.get('markRead') === '1') {
        unreadErrors = 0;
      }
      let logsTail = '';
      try {
        if (fs.existsSync(LOG_FILE)) {
          const content = fs.readFileSync(LOG_FILE, 'utf8');
          const lines = content.split(/\r?\n/);
          logsTail = lines.slice(-150).join('\n').trim();
        }
      } catch {}
      return sendJson(res, 200, {
        errors: errorHistory,
        unread: unreadErrors,
        logsTail,
        logFile: LOG_FILE,
      });
    }

    if (pathname === '/api/errors' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'clear') {
        errorHistory.length = 0;
        unreadErrors = 0;
        return sendJson(res, 200, { ok: true });
      }
      if (body.action === 'openLogFile') {
        if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');
        await handleFsAction({ action: 'open', path: LOG_FILE });
        return sendJson(res, 200, { ok: true });
      }
      if (body.action === 'report') {
        const entry = recordAppError(body.op || 'Arayüz', body.target || '', body.message, {
          stack: body.stack || '',
          meta: body.meta || undefined,
        });
        return sendJson(res, 200, { ok: true, entry, total: errorHistory.length, unread: unreadErrors });
      }
      return sendJson(res, 400, { error: 'Geçersiz hata eylemi' });
    }

    if (pathname === '/api/transfer/control' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const target = body.target || 'job';

      if (target === 'scan') {
        const scan = idx.controlScanProgress(body.action, body.scanId || body.id || null);
        return sendJson(res, 200, { ok: true, scan });
      }
      if (target === 'index') {
        const index = idx.controlBackgroundIndex(body.action);
        return sendJson(res, 200, { ok: true, index });
      }

      if (body.action === 'pause') {
        transferState.paused = true;
        if (transferState.activeJob && transferState.activeJob._pauseFlagFile) {
          await fsp.writeFile(transferState.activeJob._pauseFlagFile, '1', 'utf8').catch(() => {});
        }
      } else if (body.action === 'resume') {
        transferState.paused = false;
        if (transferState.activeJob && transferState.activeJob._pauseFlagFile) {
          await fsp.unlink(transferState.activeJob._pauseFlagFile).catch(() => {});
        }
      } else if (body.action === 'cancel') {
        const j = body.jobId
          ? transferState.jobs.find((x) => x.id === body.jobId)
          : transferState.activeJob;
        if (j) {
          j.cancelled = true;
          if (j.status === 'queued') j.status = 'cancelled';
          if (j === transferState.activeJob) transferState.paused = false;
          if (j._pauseFlagFile) await fsp.unlink(j._pauseFlagFile).catch(() => {});
          if (j._proc) {
            if (j._proc.pid) {
              execFile('taskkill', ['/PID', String(j._proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
            }
            try { j._proc.kill('SIGKILL'); } catch {}
          }
        }
        if (!transferState.jobs.some((x) => x.status === 'running' || x.status === 'queued')) {
          transferState.paused = false;
        }
      } else if (body.action === 'clearFinished') {
        transferState.jobs = transferState.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
      }
      return sendJson(res, 200, { ok: true, paused: transferState.paused });
    }

    // Statik dosyalar (F5 ile anında güncel kod yüklensin diye önbelleksiz sunulur)
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
    const fullStatic = path.join(PUBLIC_DIR, safePath);
    if (fullStatic.startsWith(PUBLIC_DIR) && fs.existsSync(fullStatic) && fs.statSync(fullStatic).isFile()) {
      const ext = path.extname(fullStatic).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      });
      pipeFileStream(req, res, fullStatic);
      return;
    }

    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bulunamadı');
    }
  } catch (err) {
    const stack = err && err.stack ? err.stack : '';
    recordAppError(req.url || 'Sunucu', req.method || '', err.message || 'Sunucu hatası', { stack });
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { error: err.message || 'Sunucu hatası', stack: process.env.LD_DEBUG === '1' ? stack : undefined });
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
});

server.on('clientError', (err, socket) => {
  if (err && err.code === 'ECONNRESET') return;
  try {
    if (socket && socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  } catch {}
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && process.env.LD_PORT_AUTO === '1' && !fallbackPortTried) {
    fallbackPortTried = true;
    appendServerLog(`Port ${activePort} meşgul, otomatik boş port seçiliyor...`);
    server.listen(0, HOST);
    return;
  }
  writeFatalCrashDump('HTTP server hatası', err);
  if (!serverListening || (err && err.code === 'EADDRINUSE')) {
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  serverListening = true;
  const addr = server.address();
  if (addr && typeof addr === 'object' && addr.port) {
    activePort = addr.port;
  }
  console.log(`LIGHTDESKTOP_READY=http://${HOST}:${activePort}`);
  console.log(`LightDesktop sunucusu hazır: http://${HOST}:${activePort}`);
  console.log(`SSD Önbellek: ${idx.CACHE_ROOT}`);
  setTimeout(() => {
    try { getWarmRecycleWorker(); } catch {}
  }, 1500);
});
