'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { normalizeParentDir } = require('../core/categoryClassifier');

function resolveWritableCacheRoot() {
  const candidates = [
    process.env.LD_CACHE_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'LightDesktopCache') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'LightDesktopCache') : '',
    path.join(os.tmpdir(), 'LightDesktopCache'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  return path.join(os.tmpdir(), 'LightDesktopCache');
}

// Tüm önbellek ve indeks verileri yavaş HDD (D:) yerine hızlı sistem SSD'sinde (C:\AppData\Local) tutulur.
const CACHE_ROOT = resolveWritableCacheRoot();
const THUMBS_DIR = path.join(CACHE_ROOT, 'thumbs');
const STORYBOARDS_DIR = path.join(CACHE_ROOT, 'storyboards');
const DB_PATH = path.join(CACHE_ROOT, 'lightdesktop.db');

fs.mkdirSync(THUMBS_DIR, { recursive: true });
fs.mkdirSync(STORYBOARDS_DIR, { recursive: true });

const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -16000;

  CREATE TABLE IF NOT EXISTS file_index (
    path TEXT PRIMARY KEY,
    parent_dir TEXT NOT NULL,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL,
    ext TEXT NOT NULL,
    category TEXT NOT NULL,
    is_dir INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime INTEGER NOT NULL DEFAULT 0,
    ctime INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_file_parent ON file_index(parent_dir);
  CREATE INDEX IF NOT EXISTS idx_file_name_lower ON file_index(name_lower);
  CREATE INDEX IF NOT EXISTS idx_file_category ON file_index(category);
  CREATE INDEX IF NOT EXISTS idx_file_size ON file_index(size);
  CREATE INDEX IF NOT EXISTS idx_file_mtime ON file_index(mtime);

  CREATE TABLE IF NOT EXISTS thumbs (
    cache_key TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    size INTEGER NOT NULL,
    thumb_file TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pins (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS analysis_cache (
    cache_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_path TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    dir_mtime_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`;

let dbInitWarning = '';
function openResilientDatabase() {
  try {
    const conn = new DatabaseSync(DB_PATH);
    conn.exec(SCHEMA_SQL);
    return conn;
  } catch (err) {
    dbInitWarning = `SQLite veritabanı bozulmuş/kilitli olduğu için sıfırlandı: ${err.message}`;
    const stamp = Date.now();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        const f = DB_PATH + suffix;
        if (fs.existsSync(f)) fs.renameSync(f, `${DB_PATH}.corrupt.${stamp}${suffix}`);
      } catch {
        try { fs.unlinkSync(DB_PATH + suffix); } catch {}
      }
    }
    try {
      const fresh = new DatabaseSync(DB_PATH);
      fresh.exec(SCHEMA_SQL);
      return fresh;
    } catch (err2) {
      dbInitWarning = `Disk SQLite açılamadı (${err2.message}), bellek içi geçici veritabanı kullanılıyor.`;
      const mem = new DatabaseSync(':memory:');
      mem.exec(SCHEMA_SQL);
      return mem;
    }
  }
}

const db = openResilientDatabase();

// SSD üzerindeki mevcut küçük resimleri RAM Set'ine yükle (0 disk okuması ile anında kontrol)
const cachedThumbSet = new Set();
let cachedThumbBytes = 0;
try {
  for (const name of fs.readdirSync(THUMBS_DIR)) {
    if (name.endsWith('.jpg')) cachedThumbSet.add(name);
  }
} catch {}

// Önbellek disk kullanımını başlangıçtan sonra arka planda SSD üzerinden sessizce hesapla
setTimeout(async () => {
  let total = 0;
  const files = Array.from(cachedThumbSet);
  for (let i = 0; i < files.length; i += 64) {
    const chunk = files.slice(i, i + 64);
    await Promise.all(
      chunk.map(async (f) => {
        try {
          const st = await fsp.stat(path.join(THUMBS_DIR, f));
          total += st.size;
        } catch {}
      })
    );
  }
  cachedThumbBytes = total;
}, 400);

// Hazır SQL ifadeleri
const stmtUpsertFile = db.prepare(`
  INSERT INTO file_index (path, parent_dir, name, name_lower, ext, category, is_dir, size, mtime, ctime)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    parent_dir = excluded.parent_dir,
    name = excluded.name,
    name_lower = excluded.name_lower,
    ext = excluded.ext,
    category = excluded.category,
    is_dir = excluded.is_dir,
    size = excluded.size,
    mtime = excluded.mtime,
    ctime = excluded.ctime
`);
const stmtGetDirCached = db.prepare(`
  SELECT path, size, mtime, ctime FROM file_index WHERE parent_dir = ?
`);
const stmtDeleteByPath = db.prepare(`DELETE FROM file_index WHERE path = ? OR path LIKE ?`);
const stmtUpsertThumb = db.prepare(`
  INSERT INTO thumbs (cache_key, file_path, mtime, size, thumb_file, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET created_at = excluded.created_at
`);
const stmtGetPins = db.prepare(`SELECT path, name, sort_order FROM pins ORDER BY sort_order ASC, name ASC`);
const stmtAddPin = db.prepare(`
  INSERT INTO pins (path, name, sort_order) VALUES (?, ?, COALESCE((SELECT MAX(sort_order)+1 FROM pins), 0))
  ON CONFLICT(path) DO UPDATE SET name = excluded.name
`);
const stmtRemovePin = db.prepare(`DELETE FROM pins WHERE path = ?`);


function upsertDirEntries(parentDir, entries) {
  if (!entries || entries.length === 0) return;
  const normParent = normalizeParentDir(parentDir);
  try {
    db.exec('BEGIN');
    for (const item of entries) {
      stmtUpsertFile.run(
        item.path,
        normParent,
        item.name,
        item.name.toLowerCase(),
        item.ext || '',
        item.category || 'other',
        item.isDir ? 1 : 0,
        item.size || 0,
        item.mtime || 0,
        item.ctime || 0
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
  }
}

function getCachedStatsMap(parentDir) {
  const normParent = normalizeParentDir(parentDir);
  const rows = stmtGetDirCached.all(normParent);
  const map = new Map();
  for (const r of rows) {
    map.set(r.path, r);
  }
  return map;
}

function removeIndexedPath(targetPath) {
  try {
    const clean = targetPath.replace(/\\+$/, '');
    stmtDeleteByPath.run(clean, clean + '\\%');
  } catch {}
}


function getPins() {
  return stmtGetPins.all();
}
function addPin(targetPath, name) {
  stmtAddPin.run(targetPath, name || path.basename(targetPath) || targetPath);
  return getPins();
}
function removePin(targetPath) {
  stmtRemovePin.run(targetPath);
  return getPins();
}


function getDbInitWarning() {
  return dbInitWarning;
}

function getCachedThumbBytes() {
  return cachedThumbBytes;
}

function addCachedThumbBytes(delta) {
  cachedThumbBytes += Number(delta) || 0;
}

function resetCachedThumbBytes() {
  cachedThumbBytes = 0;
}

module.exports = {
  CACHE_ROOT,
  THUMBS_DIR,
  STORYBOARDS_DIR,
  DB_PATH,
  db,
  cachedThumbSet,
  getCachedThumbBytes,
  addCachedThumbBytes,
  resetCachedThumbBytes,
  getDbInitWarning,
  stmtUpsertFile,
  stmtGetDirCached,
  stmtDeleteByPath,
  stmtUpsertThumb,
  stmtGetPins,
  stmtAddPin,
  stmtRemovePin,
  upsertDirEntries,
  getCachedStatsMap,
  removeIndexedPath,
  getPins,
  addPin,
  removePin,
};
