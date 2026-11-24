'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { LOG_FILE } = require('../config/constants');
const { getCategory } = require('../../indexer/core/categoryClassifier');

const CACHE_DIR = path.dirname(LOG_FILE);
const CONFIG_FILE = path.join(CACHE_DIR, 'activity-watch-config.json');
const LOGS_DIR = path.join(CACHE_DIR, 'activity-logs');

const LOG_HEADER = '# LightDesktop Klasör Aktivite Logu (TSV UTF-8: time\\tevent\\tkind\\tname\\tfullPath\\text\\tcat\\tsize\\tdelta\\tmeta\\twatchRoot)\n';
const IMAGE_DIM_EXTS = new Set(['.png', '.gif', '.bmp', '.jpg', '.jpeg', '.webp']);
const TEXT_META_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.log', '.csv', '.tsv', '.xml', '.yaml', '.yml',
  '.ini', '.cfg', '.conf', '.env', '.toml', '.bat', '.cmd', '.ps1', '.sh',
]);
const ARCHIVE_META_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz']);

const DEFAULT_VISIBLE_FIELDS = {
  time: true,
  event: true,
  kind: true,
  path: true,
  size: true,
  delta: true,
  meta: true,
  watchRoot: false,
};

const DEFAULT_CONFIG = {
  enabled: true,
  ignoreNoise: true,
  maxActiveKb: 512,
  retentionDays: 30,
  visibleFields: { ...DEFAULT_VISIBLE_FIELDS },
  watches: [],
};

// Aktif fs.watch oturumları: id -> { watch, watcher, snapshot, debounceTimers, pendingDeletes, pendingCreates, burst }
const activeWatchers = new Map();
let lastMaintenanceMs = 0;

function ensureDirs() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch {}
}

function normPathKey(p) {
  const clean = path.resolve(String(p || '').trim());
  if (/^[a-zA-Z]:\\$/.test(clean)) return clean.toLowerCase();
  return clean.replace(/[\\/]+$/, '').toLowerCase();
}

function sanitizeField(val) {
  return String(val ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function sanitizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const vis = { ...DEFAULT_VISIBLE_FIELDS, ...(src.visibleFields && typeof src.visibleFields === 'object' ? src.visibleFields : {}) };
  const maxActiveKb = Math.max(64, Math.min(10240, Number(src.maxActiveKb) || 512));
  const retentionDays = Math.max(1, Math.min(365, Number(src.retentionDays) || 30));
  const watches = [];
  const seen = new Set();

  for (const w of Array.isArray(src.watches) ? src.watches : []) {
    if (!w || !w.path) continue;
    let resolved;
    try { resolved = path.resolve(String(w.path).trim()); } catch { continue; }
    const key = normPathKey(resolved);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ev = w.events && typeof w.events === 'object' ? w.events : {};
    watches.push({
      id: String(w.id || `w_${Buffer.from(key).toString('hex').slice(0, 12)}`),
      path: resolved,
      recursive: w.recursive !== false,
      enabled: w.enabled !== false,
      events: {
        create: ev.create !== false,
        modify: ev.modify !== false,
        delete: ev.delete !== false,
        rename: ev.rename !== false,
      },
      addedAt: Number(w.addedAt) || Date.now(),
    });
  }

  return {
    enabled: src.enabled !== false,
    ignoreNoise: src.ignoreNoise !== false,
    maxActiveKb,
    retentionDays,
    visibleFields: vis,
    watches,
  };
}

function loadConfig() {
  ensureDirs();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return sanitizeConfig(parsed);
    }
  } catch {}
  return sanitizeConfig(DEFAULT_CONFIG);
}

function writeConfig(cfg) {
  ensureDirs();
  const clean = sanitizeConfig(cfg);
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2), 'utf8');
  } catch {}
  return clean;
}

function getLocalDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTimeStampTag(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}${mm}${ss}`;
}

function isNoisyPath(fullPath, cfg) {
  if (!cfg.ignoreNoise) return false;
  const low = String(fullPath || '').toLowerCase();
  if (low.includes('\\.lightdesktopvault\\') || low.includes('\\lightdesktopcache\\')) return true;
  if (low.includes('\\node_modules\\') || low.includes('\\.git\\objects\\')) return true;
  const base = path.basename(low);
  if (!base) return false;
  if (base.startsWith('~$') || base === 'thumbs.db' || base === 'desktop.ini') return true;
  if (base.endsWith('.tmp') || base.endsWith('.crdownload') || base.endsWith('.part')) return true;
  return false;
}

function readImageDimsQuick(filePath, ext) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(32768);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead < 16) return '';

    if (ext === '.png' && bytesRead >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    }
    if (ext === '.gif' && bytesRead >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return `${buf.readUInt16LE(6)}x${buf.readUInt16LE(8)}`;
    }
    if (ext === '.bmp' && bytesRead >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return `${buf.readInt32LE(18)}x${Math.abs(buf.readInt32LE(22))}`;
    }
    if (ext === '.webp' && bytesRead >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X' && bytesRead >= 30) {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return `${w}x${h}`;
      }
      if (chunk === 'VP8 ' && bytesRead >= 30) {
        return `${buf.readUInt16LE(26) & 0x3FFF}x${buf.readUInt16LE(28) & 0x3FFF}`;
      }
      if (chunk === 'VP8L' && bytesRead >= 25) {
        const bits = buf.readUInt32LE(21);
        return `${(bits & 0x3FFF) + 1}x${((bits >> 14) & 0x3FFF) + 1}`;
      }
    }
    if ((ext === '.jpg' || ext === '.jpeg') && buf[0] === 0xFF && buf[1] === 0xD8) {
      let off = 2;
      while (off + 9 < bytesRead) {
        if (buf[off] !== 0xFF) { off++; continue; }
        const marker = buf[off + 1];
        if (marker === 0xFF) { off++; continue; }
        if (marker === 0xD9 || marker === 0xDA) break;
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const h = buf.readUInt16BE(off + 5);
          const w = buf.readUInt16BE(off + 7);
          if (w > 0 && h > 0) return `${w}x${h}`;
          break;
        }
        const segLen = buf.readUInt16BE(off + 2);
        if (segLen < 2) break;
        off += 2 + segLen;
      }
    }
  } catch {} finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return '';
}

function countLinesQuick(filePath, sizeBytes) {
  if (sizeBytes <= 0 || sizeBytes > 256 * 1024) return '';
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(sizeBytes);
    const n = fs.readSync(fd, buf, 0, sizeBytes, 0);
    let lines = 1;
    for (let i = 0; i < n; i++) {
      if (buf[i] === 0x0A) lines++;
    }
    return `${lines} satır`;
  } catch {} finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return '';
}

function extractQuickMeta(fullPath, isDir, ext, cat, sizeBytes) {
  if (isDir) return 'Klasör';
  if (IMAGE_DIM_EXTS.has(ext)) {
    const dims = readImageDimsQuick(fullPath, ext);
    if (dims) return dims;
  }
  if (cat === 'code' || TEXT_META_EXTS.has(ext)) {
    const lineMeta = countLinesQuick(fullPath, sizeBytes);
    if (lineMeta) return lineMeta;
  }
  if (ARCHIVE_META_EXTS.has(ext)) return 'Arşiv';
  return '';
}

function appendLogEntry(entry, cfg) {
  ensureDirs();
  const dateKey = getLocalDateKey();
  const activeFile = path.join(LOGS_DIR, `activity-${dateKey}.txt`);
  const line = [
    sanitizeField(entry.time || new Date().toISOString()),
    sanitizeField(entry.event),
    sanitizeField(entry.kind),
    sanitizeField(entry.name),
    sanitizeField(entry.fullPath),
    sanitizeField(entry.ext),
    sanitizeField(entry.cat),
    Number.isFinite(entry.size) ? String(entry.size) : '',
    Number.isFinite(entry.delta) ? String(entry.delta) : '',
    sanitizeField(entry.meta),
    sanitizeField(entry.watchRoot),
  ].join('\t') + '\n';

  try {
    if (!fs.existsSync(activeFile)) {
      fs.writeFileSync(activeFile, LOG_HEADER + line, 'utf8');
    } else {
      fs.appendFileSync(activeFile, line, 'utf8');
    }
    const maxBytes = (cfg.maxActiveKb || 512) * 1024;
    const st = fs.statSync(activeFile);
    if (st.size >= maxBytes) {
      rotateAndCompressFile(activeFile);
    }
    if (Date.now() - lastMaintenanceMs > 6 * 60 * 60 * 1000) {
      runLogMaintenance(cfg);
    }
  } catch {}
}

function rotateAndCompressFile(txtPath) {
  try {
    if (!fs.existsSync(txtPath)) return null;
    const raw = fs.readFileSync(txtPath);
    if (raw.length === 0) return null;
    const dir = path.dirname(txtPath);
    const base = path.basename(txtPath, '.txt');
    let gzPath = path.join(dir, `${base}-${getTimeStampTag()}.txt.gz`);
    let idx = 2;
    while (fs.existsSync(gzPath)) {
      gzPath = path.join(dir, `${base}-${getTimeStampTag()}-${idx}.txt.gz`);
      idx++;
    }
    fs.writeFileSync(gzPath, zlib.gzipSync(raw, { level: 9 }));
    fs.unlinkSync(txtPath);
    return gzPath;
  } catch {
    return null;
  }
}

function runLogMaintenance(cfg) {
  lastMaintenanceMs = Date.now();
  ensureDirs();
  const todayFile = `activity-${getLocalDateKey()}.txt`;
  const cutoffMs = Date.now() - (cfg.retentionDays || 30) * 86400 * 1000;

  try {
    for (const name of fs.readdirSync(LOGS_DIR)) {
      if (!name.startsWith('activity-')) continue;
      const full = path.join(LOGS_DIR, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (st.mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
          continue;
        }
        if (name.endsWith('.txt') && name !== todayFile) {
          rotateAndCompressFile(full);
        }
      } catch {}
    }
  } catch {}
}

function seedShallowSnapshot(watchRoot) {
  const snap = new Map();
  try {
    const entries = fs.readdirSync(watchRoot, { withFileTypes: true });
    const limit = Math.min(entries.length, 1500);
    for (let i = 0; i < limit; i++) {
      const d = entries[i];
      const full = path.join(watchRoot, d.name);
      try {
        const st = fs.lstatSync(full);
        snap.set(normPathKey(full), {
          isDir: st.isDirectory(),
          size: st.isDirectory() ? 0 : st.size,
          mtimeMs: st.mtimeMs,
          name: d.name,
        });
      } catch {}
    }
  } catch {}
  return snap;
}

function createWatchSession(w, cfg) {
  if (!fs.existsSync(w.path)) return null;
  const session = {
    watch: w,
    watcher: null,
    snapshot: seedShallowSnapshot(w.path),
    debounceTimers: new Map(),
    pendingDeletes: new Map(),
    pendingCreates: new Map(),
    burstWindowStart: 0,
    burstCount: 0,
    burstTimer: null,
  };

  function recordBurstOrWrite(entry) {
    const now = Date.now();
    if (now - session.burstWindowStart > 1000) {
      session.burstWindowStart = now;
      session.burstCount = 0;
    }
    session.burstCount++;
    if (session.burstCount <= 60) {
      appendLogEntry(entry, loadConfig());
      return;
    }
    if (!session.burstTimer) {
      session.burstTimer = setTimeout(() => {
        const extra = Math.max(0, session.burstCount - 60);
        session.burstTimer = null;
        session.burstCount = 0;
        if (extra > 0) {
          appendLogEntry({
            time: new Date().toISOString(),
            event: 'BATCH',
            kind: 'dir',
            name: `${path.basename(w.path) || w.path} (+${extra} değişim)`,
            fullPath: w.path,
            ext: '',
            cat: 'folder',
            size: 0,
            delta: 0,
            meta: `Yoğun akış özetlendi (+${extra} olay)`,
            watchRoot: w.path,
          }, loadConfig());
        }
      }, 950);
    }
  }

  function flushPendingCreate(key) {
    const pending = session.pendingCreates.get(key);
    if (!pending) return;
    session.pendingCreates.delete(key);
    if (!w.events.create) return;
    recordBurstOrWrite(pending.entry);
  }

  function flushPendingDelete(key) {
    const pending = session.pendingDeletes.get(key);
    if (!pending) return;
    session.pendingDeletes.delete(key);
    if (!w.events.delete) return;
    recordBurstOrWrite(pending.entry);
  }

  function tryMatchRename(parentDir, kindFlag, size, isCreate, newKey, entry) {
    const mapToSearch = isCreate ? session.pendingDeletes : session.pendingCreates;
    for (const [otherKey, other] of mapToSearch.entries()) {
      if (other.parentDir !== parentDir || other.isDir !== kindFlag) continue;
      if (!kindFlag && other.size > 0 && size > 0 && other.size !== size) continue;
      clearTimeout(other.timer);
      mapToSearch.delete(otherKey);
      if (!w.events.rename) return true;
      const oldEntry = isCreate ? other.entry : entry;
      const newEntry = isCreate ? entry : other.entry;
      recordBurstOrWrite({
        time: new Date().toISOString(),
        event: 'RENAMED',
        kind: kindFlag ? 'dir' : 'file',
        name: `${oldEntry.name} → ${newEntry.name}`,
        fullPath: newEntry.fullPath,
        ext: newEntry.ext,
        cat: newEntry.cat,
        size: newEntry.size,
        delta: 0,
        meta: `Eski ad: ${oldEntry.name}${newEntry.meta ? ' | ' + newEntry.meta : ''}`,
        watchRoot: w.path,
      });
      return true;
    }
    return false;
  }

  function processDebouncedPath(fullPath) {
    const liveCfg = loadConfig();
    if (!liveCfg.enabled) return;
    if (isNoisyPath(fullPath, liveCfg)) return;

    const key = normPathKey(fullPath);
    const prev = session.snapshot.get(key);
    const parentDir = path.dirname(fullPath).toLowerCase();
    const baseName = path.basename(fullPath);

    let st = null;
    try { st = fs.lstatSync(fullPath); } catch {}

    if (!st) {
      session.snapshot.delete(key);
      const isDir = prev ? prev.isDir : !path.extname(baseName);
      const ext = isDir ? '' : path.extname(baseName).toLowerCase();
      const cat = isDir ? 'folder' : getCategory(ext, false);
      const prevSize = prev ? prev.size : 0;
      const delEntry = {
        time: new Date().toISOString(),
        event: 'DELETED',
        kind: isDir ? 'dir' : 'file',
        name: baseName,
        fullPath,
        ext,
        cat,
        size: prevSize,
        delta: prevSize > 0 ? -prevSize : 0,
        meta: prev ? (isDir ? 'Klasör silindi' : 'Dosya silindi') : 'Silindi',
        watchRoot: w.path,
      };
      if (tryMatchRename(parentDir, isDir, prevSize, false, key, delEntry)) return;
      const timer = setTimeout(() => flushPendingDelete(key), 340);
      session.pendingDeletes.set(key, { parentDir, isDir, size: prevSize, entry: delEntry, timer });
      return;
    }

    const isDir = st.isDirectory();
    const size = isDir ? 0 : st.size;
    const ext = isDir ? '' : path.extname(baseName).toLowerCase();
    const cat = isDir ? 'folder' : getCategory(ext, false);

    if (!prev) {
      session.snapshot.set(key, { isDir, size, mtimeMs: st.mtimeMs, name: baseName });
      const meta = extractQuickMeta(fullPath, isDir, ext, cat, size);
      const createEntry = {
        time: new Date().toISOString(),
        event: 'CREATED',
        kind: isDir ? 'dir' : 'file',
        name: baseName,
        fullPath,
        ext,
        cat,
        size,
        delta: size,
        meta,
        watchRoot: w.path,
      };
      if (tryMatchRename(parentDir, isDir, size, true, key, createEntry)) return;
      const timer = setTimeout(() => flushPendingCreate(key), 340);
      session.pendingCreates.set(key, { parentDir, isDir, size, entry: createEntry, timer });
      return;
    }

    // Var olan öğede değişiklik (no-op eventleri atla)
    if (prev.size === size && Math.abs(st.mtimeMs - prev.mtimeMs) < 50) return;
    const delta = size - prev.size;
    session.snapshot.set(key, { isDir, size, mtimeMs: st.mtimeMs, name: baseName });
    if (!w.events.modify || isDir) return;
    const meta = extractQuickMeta(fullPath, false, ext, cat, size);
    recordBurstOrWrite({
      time: new Date().toISOString(),
      event: 'MODIFIED',
      kind: 'file',
      name: baseName,
      fullPath,
      ext,
      cat,
      size,
      delta,
      meta,
      watchRoot: w.path,
    });
  }

  try {
    session.watcher = fs.watch(
      w.path,
      { recursive: Boolean(w.recursive), persistent: false },
      (_eventType, filename) => {
        if (!filename) return;
        const fullPath = path.join(w.path, String(filename));
        const key = normPathKey(fullPath);
        if (session.debounceTimers.has(key)) clearTimeout(session.debounceTimers.get(key));
        session.debounceTimers.set(key, setTimeout(() => {
          session.debounceTimers.delete(key);
          processDebouncedPath(fullPath);
        }, 250));
      }
    );
    session.watcher.on('error', () => {});
  } catch {
    return null;
  }

  return session;
}

function stopSession(session) {
  if (!session) return;
  try { session.watcher?.close(); } catch {}
  for (const t of session.debounceTimers.values()) clearTimeout(t);
  for (const p of session.pendingDeletes.values()) clearTimeout(p.timer);
  for (const p of session.pendingCreates.values()) clearTimeout(p.timer);
  if (session.burstTimer) clearTimeout(session.burstTimer);
}

function stopAllActivityWatchers() {
  for (const sess of activeWatchers.values()) stopSession(sess);
  activeWatchers.clear();
}

function syncWatchersWithConfig(cfg) {
  stopAllActivityWatchers();
  if (!cfg.enabled) return;
  for (const w of cfg.watches) {
    if (!w.enabled) continue;
    const sess = createWatchSession(w, cfg);
    if (sess) activeWatchers.set(w.id, sess);
  }
}

function startActivityWatchers() {
  const cfg = loadConfig();
  runLogMaintenance(cfg);
  syncWatchersWithConfig(cfg);
  return getActivityConfigAndStats();
}

function getLogFilesStats() {
  ensureDirs();
  const files = [];
  let totalBytes = 0;
  let txtCount = 0;
  let gzCount = 0;
  try {
    for (const name of fs.readdirSync(LOGS_DIR).sort().reverse()) {
      if (!name.startsWith('activity-') || (!name.endsWith('.txt') && !name.endsWith('.txt.gz'))) continue;
      const full = path.join(LOGS_DIR, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        const isGz = name.endsWith('.gz');
        if (isGz) gzCount++;
        else txtCount++;
        totalBytes += st.size;
        files.push({
          name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          compressed: isGz,
        });
      } catch {}
    }
  } catch {}
  return { logsDir: LOGS_DIR, files, totalBytes, txtCount, gzCount };
}

function getActivityConfigAndStats() {
  const cfg = loadConfig();
  const diskStats = getLogFilesStats();
  return {
    config: cfg,
    activeCount: activeWatchers.size,
    ...diskStats,
  };
}

function saveActivityConfig(patch) {
  const cur = loadConfig();
  const next = sanitizeConfig({ ...cur, ...(patch && typeof patch === 'object' ? patch : {}) });
  writeConfig(next);
  syncWatchersWithConfig(next);
  return getActivityConfigAndStats();
}

function addOrToggleWatchPath(dirPath, opts = {}) {
  const resolved = path.resolve(String(dirPath || '').trim());
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('İzlenecek geçerli bir klasör bulunamadı');
  }
  const cur = loadConfig();
  const key = normPathKey(resolved);
  const existing = cur.watches.find((w) => normPathKey(w.path) === key);
  if (existing) {
    if (typeof opts.recursive === 'boolean') existing.recursive = opts.recursive;
    existing.enabled = typeof opts.enabled === 'boolean' ? opts.enabled : true;
    if (opts.events && typeof opts.events === 'object') {
      existing.events = { ...existing.events, ...opts.events };
    }
  } else {
    cur.watches.push({
      id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      path: resolved,
      recursive: opts.recursive !== false,
      enabled: true,
      events: {
        create: true,
        modify: true,
        delete: true,
        rename: true,
        ...(opts.events && typeof opts.events === 'object' ? opts.events : {}),
      },
      addedAt: Date.now(),
    });
  }
  writeConfig(cur);
  syncWatchersWithConfig(cur);
  return getActivityConfigAndStats();
}

function readLogFileLines(fullPath) {
  try {
    const raw = fs.readFileSync(fullPath);
    const text = fullPath.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return text.split(/\r?\n/);
  } catch {
    return [];
  }
}

function parseLogLine(line) {
  if (!line || line[0] === '#') return null;
  const cols = line.split('\t');
  if (cols.length < 5) return null;
  return {
    time: cols[0] || '',
    event: cols[1] || '',
    kind: cols[2] || 'file',
    name: cols[3] || '',
    fullPath: cols[4] || '',
    ext: cols[5] || '',
    cat: cols[6] || '',
    size: cols[7] !== '' ? Number(cols[7]) : null,
    delta: cols[8] !== '' ? Number(cols[8]) : null,
    meta: cols[9] || '',
    watchRoot: cols[10] || '',
  };
}

function queryActivityLogs({ q = '', event = '', watchRoot = '', file = '', limit = 400 } = {}) {
  const stats = getLogFilesStats();
  const targetFiles = file
    ? stats.files.filter((f) => f.name === path.basename(String(file)))
    : stats.files;
  const maxEntries = Math.max(50, Math.min(2000, Number(limit) || 400));
  const qLow = String(q || '').trim().toLocaleLowerCase('tr-TR');
  const evFilter = String(event || '').trim().toUpperCase();
  const rootKey = watchRoot ? normPathKey(watchRoot) : '';

  const matched = [];
  let totalMatched = 0;

  for (const f of targetFiles) {
    const lines = readLogFileLines(path.join(LOGS_DIR, f.name));
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLogLine(lines[i]);
      if (!entry) continue;
      if (evFilter && evFilter !== 'ALL' && entry.event !== evFilter) continue;
      if (rootKey && normPathKey(entry.watchRoot) !== rootKey) continue;
      if (qLow) {
        const hay = `${entry.name}\n${entry.fullPath}\n${entry.meta}\n${entry.ext}\n${entry.event}`.toLocaleLowerCase('tr-TR');
        if (!hay.includes(qLow)) continue;
      }
      totalMatched++;
      if (matched.length < maxEntries) {
        matched.push({ ...entry, file: f.name });
      }
    }
  }

  return {
    entries: matched,
    totalMatched,
    ...stats,
  };
}

function compressActivityLogsNow() {
  const stats = getLogFilesStats();
  let compressedCount = 0;
  let savedBytes = 0;
  for (const f of stats.files) {
    if (f.compressed || !f.name.endsWith('.txt')) continue;
    const full = path.join(LOGS_DIR, f.name);
    const gz = rotateAndCompressFile(full);
    if (gz) {
      compressedCount++;
      try { savedBytes += Math.max(0, f.size - fs.statSync(gz).size); } catch {}
    }
  }
  return { ok: true, compressedCount, savedBytes, ...getActivityConfigAndStats() };
}

function clearActivityLogs({ file = '', all = false } = {}) {
  ensureDirs();
  let deleted = 0;
  if (all) {
    for (const f of getLogFilesStats().files) {
      try { fs.unlinkSync(path.join(LOGS_DIR, f.name)); deleted++; } catch {}
    }
  } else if (file) {
    const safeName = path.basename(String(file));
    if (safeName.startsWith('activity-') && (safeName.endsWith('.txt') || safeName.endsWith('.txt.gz'))) {
      try { fs.unlinkSync(path.join(LOGS_DIR, safeName)); deleted++; } catch {}
    }
  }
  return { ok: true, deleted, ...getActivityConfigAndStats() };
}

module.exports = {
  addOrToggleWatchPath,
  clearActivityLogs,
  compressActivityLogsNow,
  getActivityConfigAndStats,
  queryActivityLogs,
  saveActivityConfig,
  startActivityWatchers,
  stopAllActivityWatchers,
};
