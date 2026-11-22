'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, execFileSync, spawn } = require('node:child_process');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

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
const DB_PATH = path.join(CACHE_ROOT, 'lightdesktop.db');

fs.mkdirSync(THUMBS_DIR, { recursive: true });

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

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.3gp', '.vob', '.mts']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tiff', '.tif', '.raw', '.cr2', '.nef', '.arw', '.dng', '.svg', '.ico']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.opus', '.mid']);
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.img', '.cab', '.zst']);
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt', '.ods', '.epub', '.log']);
const APP_EXTS = new Set(['.exe', '.msi', '.apk', '.dll', '.sys', '.bat', '.cmd', '.lnk']);
const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sql', '.c', '.cpp', '.h', '.cs', '.java', '.go', '.rs', '.php', '.sh', '.ps1']);

function getCategory(ext, isDir) {
  if (isDir) return 'folder';
  const e = (ext || '').toLowerCase();
  if (VIDEO_EXTS.has(e)) return 'video';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (ARCHIVE_EXTS.has(e)) return 'archive';
  if (DOC_EXTS.has(e)) return 'document';
  if (APP_EXTS.has(e)) return 'app';
  if (CODE_EXTS.has(e)) return 'code';
  return 'other';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeParentDir(p) {
  if (!p) return '';
  let resolved = path.resolve(p);
  if (/^[a-zA-Z]:$/.test(resolved)) resolved += '\\';
  return resolved.toLowerCase();
}

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

// ---------- Everything CLI (es.exe) veya Dahili SQLite Hibrit Arama ----------
let esExePath = null;
for (const candidate of [
  'C:\\Program Files\\Everything\\es.exe',
  'C:\\Program Files (x86)\\Everything\\es.exe',
]) {
  if (fs.existsSync(candidate)) {
    esExePath = candidate;
    break;
  }
}

function queryEverythingCli(query, scopePath, limit = 500) {
  return new Promise((resolve) => {
    if (!esExePath) return resolve(null);
    const args = ['-n', String(limit), '-size', '-dm', '-s'];
    const fullQuery = scopePath ? `"${scopePath}" ${query}` : query;
    args.push(fullQuery);
    execFile(esExePath, args, { timeout: 3500, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const results = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s{2,}/);
        const fullPath = parts[parts.length - 1];
        if (!fullPath || fullPath.length < 3) continue;
        const name = path.basename(fullPath);
        const ext = path.extname(name).toLowerCase();
        results.push({
          name,
          path: fullPath,
          parentDir: path.dirname(fullPath),
          ext,
          category: getCategory(ext, !ext),
          isDir: !ext,
          size: 0,
          mtime: 0,
          ctime: 0,
        });
      }
      resolve(results);
    });
  });
}

async function searchFiles(opts) {
  const {
    query = '',
    regex = '',
    scopePath = '',
    category = '',
    minSize = null,
    maxSize = null,
    minDate = null,
    maxDate = null,
    includeDirs = true,
    limit = 1000,
  } = opts || {};

  let re = null;
  if (regex) {
    try {
      re = new RegExp(regex, 'i');
    } catch (e) {
      throw new Error(`Geçersiz RegExp: ${e.message}`);
    }
  }

  // Basit metin sorgusu ve Everything CLI mevcutsa öncelikle dene
  if (esExePath && query && !regex && !category && minSize == null && maxSize == null && minDate == null && maxDate == null) {
    const esRes = await queryEverythingCli(query, scopePath, limit);
    if (esRes && esRes.length > 0) {
      return { source: 'everything', items: esRes };
    }
  }

  const conditions = [];
  const params = [];

  if (scopePath) {
    let prefix = path.resolve(scopePath);
    if (!prefix.endsWith('\\')) prefix += '\\';
    conditions.push('(parent_dir = ? OR path LIKE ?)');
    params.push(normalizeParentDir(scopePath), prefix + '%');
  }

  if (query && !regex) {
    // Joker karakter (*, ?) destekli LIKE dönüşümü
    const hasWildcard = /[*?]/.test(query);
    if (hasWildcard) {
      const likePat = query.toLowerCase().replace(/[%_]/g, '\\$&').replace(/\*/g, '%').replace(/\?/g, '_');
      conditions.push("name_lower LIKE ? ESCAPE '\\'");
      params.push(likePat);
    } else {
      conditions.push("name_lower LIKE ? ESCAPE '\\'");
      const escaped = query.toLowerCase().replace(/[%_\\]/g, '\\$&');
      params.push(`%${escaped}%`);
    }
  }

  if (category && category !== 'all') {
    conditions.push('category = ?');
    params.push(category);
  }
  if (!includeDirs) {
    conditions.push('is_dir = 0');
  }
  if (minSize !== null && minSize !== '' && !Number.isNaN(Number(minSize))) {
    conditions.push('size >= ?');
    params.push(Number(minSize));
  }
  if (maxSize !== null && maxSize !== '' && !Number.isNaN(Number(maxSize))) {
    conditions.push('size <= ?');
    params.push(Number(maxSize));
  }
  if (minDate !== null && minDate !== '' && !Number.isNaN(Number(minDate))) {
    conditions.push('mtime >= ?');
    params.push(Number(minDate));
  }
  if (maxDate !== null && maxDate !== '' && !Number.isNaN(Number(maxDate))) {
    conditions.push('mtime <= ?');
    params.push(Number(maxDate));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // RegExp varsa SQLite'tan daha geniş çekip JS'te filtrele
  const sqlLimit = re ? Math.max(limit * 10, 25000) : limit;
  const sql = `
    SELECT path, parent_dir, name, ext, category, is_dir, size, mtime, ctime
    FROM file_index
    ${whereClause}
    ORDER BY is_dir DESC, mtime DESC
    LIMIT ?
  `;
  params.push(sqlLimit);

  const rows = db.prepare(sql).all(...params);
  const out = [];
  for (const r of rows) {
    if (re && !re.test(r.name)) continue;
    const isDir = r.is_dir === 1;
    const thumbKey = isDir ? null : makeThumbKey(r.path, r.mtime, r.size);
    out.push({
      name: r.name,
      path: r.path,
      parentDir: r.parent_dir,
      ext: r.ext,
      category: r.category,
      isDir,
      size: r.size,
      mtime: r.mtime,
      ctime: r.ctime,
      hasCachedThumb: thumbKey ? cachedThumbSet.has(`${thumbKey}.jpg`) : false,
    });
    if (out.length >= limit) break;
  }

  return { source: 'sqlite', items: out, totalIndexed: getIndexStats().totalEntries };
}

const GENERIC_MEDIA_TOKENS = new Set([
  'vid', 'img', 'dsc', 'dcim', 'pxl', 'mvimg', 'wa', 'snap', 'screenshot',
  'screen', 'recording', 'rec', 'video', 'photo', 'foto', 'resim', 'image',
  'copy', 'kopya', 'new', 'yeni', 'edited', 'trim', 'mp4', 'jpg', 'jpeg',
  'png', 'mov', 'mkv', 'webm', 'avi', 'heic',
]);

function extractTimestampFromName(name) {
  const base = String(name || '');
  // 1) YYYYMMDD[_- ]?HHMMSS
  let m = /(?:^|[^\d])((?:199\d|20\d\d))(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_\-\s]?([01]\d|2[0-3])([0-5]\d)([0-5]\d)(?:[^\d]|$)/.exec(base);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (!Number.isNaN(dt.getTime())) return { ms: dt.getTime(), hasTime: true, dateTag: `${m[1]}${m[2]}${m[3]}` };
  }
  // 2) YYYY-MM-DD[_- T]HH[-.:]MM[-.:]SS
  m = /(?:^|[^\d])((?:199\d|20\d\d))[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])[_\-\sT]([01]\d|2[0-3])[-.:]([0-5]\d)[-.:]([0-5]\d)(?:[^\d]|$)/.exec(base);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (!Number.isNaN(dt.getTime())) return { ms: dt.getTime(), hasTime: true, dateTag: `${m[1]}${m[2]}${m[3]}` };
  }
  // 3) Tarih yalnizca YYYYMMDD veya YYYY-MM-DD
  m = /(?:^|[^\d])((?:199\d|20\d\d))[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/.exec(base);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
    if (!Number.isNaN(dt.getTime())) return { ms: dt.getTime(), hasTime: false, dateTag: `${m[1]}${m[2]}${m[3]}` };
  }
  return null;
}

function isGenericMediaWord(w) {
  if (!w) return true;
  if (GENERIC_MEDIA_TOKENS.has(w)) return true;
  const asciiI = w.replace(/ı/g, 'i');
  return GENERIC_MEDIA_TOKENS.has(asciiI);
}

function extractNameTokens(fileName) {
  const stem = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  // CamelCase sınırlarını ayır (örn. cokiyiVID -> cokiyi VID)
  const spaced = stem.replace(/([a-zçğıöşü])([A-ZÇĞİÖŞÜ])/g, '$1 $2');
  const rawParts = spaced.toLocaleLowerCase('tr-TR').split(/[^a-zçğıöşü0-9]+/i).filter(Boolean);
  const tokens = [];
  const seen = new Set();

  for (const part of rawParts) {
    if (part.length < 3) continue;
    if (isGenericMediaWord(part)) continue;
    // Kısa sayıları (ve 6 haneli saat damgasını) isim tokenı yapma; 8 haneli tarihi (YYYYMMDD) tut
    if (/^\d+$/.test(part) && (part.length < 8 || part.length === 6)) continue;
    // Sonuna eklenmis generic prefix/suffix temizle (örn. cokiyiVID -> cokiyi)
    const stripped = part.replace(/(?:v[iı]d|[iı]mg|dsc|pxl)$/i, '');
    if (stripped.length >= 3 && stripped !== part && !isGenericMediaWord(stripped) && !seen.has(stripped)) {
      seen.add(stripped);
      tokens.push(stripped);
      continue;
    }
    if (!seen.has(part)) {
      seen.add(part);
      tokens.push(part);
    }
  }

  const cleanAlpha = stem.toLocaleLowerCase('tr-TR').replace(/[^a-zçğıöşü]/g, '');
  const prefix = cleanAlpha.length >= 4 ? cleanAlpha.slice(0, Math.min(8, cleanAlpha.length)) : '';
  return { tokens, prefix };
}

async function listFolderFilesLive(dirPath) {
  const out = [];
  let handle;
  try {
    handle = await fsp.opendir(dirPath, { bufferSize: 128 });
  } catch {
    return out;
  }
  const names = [];
  for await (const d of handle) {
    if (!d.isDirectory()) names.push(d.name);
  }
  const BATCH = 16;
  for (let i = 0; i < names.length; i += BATCH) {
    const slice = names.slice(i, i + BATCH);
    const stats = await Promise.all(
      slice.map(async (name) => {
        const full = path.join(dirPath, name);
        try {
          const st = await fsp.lstat(full);
          if (st.isDirectory()) return null;
          const ext = path.extname(name).toLowerCase();
          const mtime = Math.floor(st.mtimeMs || 0);
          const ctime = Math.floor(st.birthtimeMs || st.ctimeMs || 0);
          const size = st.size || 0;
          const tk = makeThumbKey(full, mtime, size);
          return {
            name,
            path: full,
            parentDir: normalizeParentDir(dirPath),
            ext,
            category: getCategory(ext, false),
            isDir: false,
            size,
            mtime,
            ctime,
            hasCachedThumb: cachedThumbSet.has(`${tk}.jpg`),
          };
        } catch {
          return null;
        }
      })
    );
    for (const s of stats) {
      if (s) out.push(s);
    }
  }
  return out;
}

async function findRelatedFiles(opts = {}) {
  const t0 = performance.now();
  const {
    filePath = '',
    fileName = '',
    mtime = 0,
    category = '',
    mode = 'sameDay', // nearTime | sameDay | sameWeek | sameMonth | similarName
    scope = 'folder', // folder | drive | all
    sameCategoryOnly = 'media', // media | exact | all
    limit = 1500,
  } = opts;

  if (!filePath) throw new Error('filePath gerekli');
  const resolvedSrc = path.resolve(filePath);
  const srcName = fileName || path.basename(resolvedSrc);
  const srcDir = path.dirname(resolvedSrc);
  const srcExt = path.extname(srcName).toLowerCase();
  const srcCat = category || getCategory(srcExt, false);

  const embRef = extractTimestampFromName(srcName);
  let refMs = Number(mtime) || 0;
  if (!refMs && fs.existsSync(resolvedSrc)) {
    try { refMs = Math.floor(fs.statSync(resolvedSrc).mtimeMs || 0); } catch {}
  }
  if (!refMs && embRef) refMs = embRef.ms;
  // Gömülü dosya adı zamanı + mtime arasından zaman penceresi hesabı (dosya adı tarihini de referans al)
  const effectiveRefMs = (embRef && embRef.hasTime) ? embRef.ms : (refMs || (embRef ? embRef.ms : Date.now()));
  const refDate = new Date(effectiveRefMs);
  const refY = refDate.getFullYear();
  const refM = refDate.getMonth();
  const refD = refDate.getDate();

  let minMs = 0;
  let maxMs = Number.MAX_SAFE_INTEGER;
  if (mode === 'nearTime') {
    minMs = effectiveRefMs - 3600000;
    maxMs = effectiveRefMs + 3600000;
  } else if (mode === 'sameDay') {
    minMs = new Date(refY, refM, refD, 0, 0, 0, 0).getTime();
    maxMs = new Date(refY, refM, refD, 23, 59, 59, 999).getTime();
  } else if (mode === 'sameWeek') {
    minMs = new Date(refY, refM, refD - 3, 0, 0, 0, 0).getTime();
    maxMs = new Date(refY, refM, refD + 3, 23, 59, 59, 999).getTime();
  } else if (mode === 'sameMonth') {
    minMs = new Date(refY, refM, 1, 0, 0, 0, 0).getTime();
    maxMs = new Date(refY, refM + 1, 0, 23, 59, 59, 999).getTime();
  }

  const { tokens, prefix } = extractNameTokens(srcName);
  const categoryAllowed = (candCat) => {
    if (sameCategoryOnly === 'all') return true;
    if (sameCategoryOnly === 'exact') return candCat === srcCat;
    if (srcCat === 'video' || srcCat === 'image') {
      return candCat === 'video' || candCat === 'image';
    }
    return candCat === srcCat;
  };

  let candidates = [];
  let source = 'live-folder';
  let scopeUsed = scope;
  let fallbackNotice = '';

  if (scope === 'drive' || scope === 'all') {
    const scopeRoot = scope === 'drive' ? resolvedSrc.slice(0, 3) : '';
    const where = ['is_dir = 0'];
    const params = [];
    if (scopeRoot) {
      let pfx = path.resolve(scopeRoot);
      if (!pfx.endsWith('\\')) pfx += '\\';
      where.push('(parent_dir = ? OR path LIKE ?)');
      params.push(normalizeParentDir(scopeRoot), pfx + '%');
    }
    // Önce bu kapsamda indeksli dosya var mı hızlıca bak
    const checkCntRow = db.prepare(`SELECT COUNT(*) AS c FROM file_index WHERE ${where.join(' AND ')}`).get(...params);
    if (!checkCntRow || (checkCntRow.c || 0) === 0) {
      scopeUsed = 'folder';
      fallbackNotice = scope === 'drive'
        ? `${scopeRoot} henüz indekslenmemiş; yalnızca mevcut klasörde arandı.`
        : 'İndeks henüz boş; yalnızca mevcut klasörde arandı.';
    } else {
      source = 'sqlite';
      if (mode !== 'similarName') {
        const yStr = String(refY);
        const ymCompact = `${yStr}${String(refM + 1).padStart(2, '0')}`;
        const ymDash = `${yStr}-${String(refM + 1).padStart(2, '0')}`;
        const ymdCompact = `${ymCompact}${String(refD).padStart(2, '0')}`;
        const ymdDash = `${ymDash}-${String(refD).padStart(2, '0')}`;
        if (mode === 'sameMonth') {
          where.push('((mtime BETWEEN ? AND ?) OR name_lower LIKE ? OR name_lower LIKE ?)');
          params.push(minMs, maxMs, `%${ymCompact}%`, `%${ymDash}%`);
        } else {
          where.push('((mtime BETWEEN ? AND ?) OR name_lower LIKE ? OR name_lower LIKE ?)');
          params.push(minMs, maxMs, `%${ymdCompact}%`, `%${ymdDash}%`);
        }
      } else {
        const nameConds = [];
        for (const tk of tokens.slice(0, 6)) {
          const escTk = tk.replace(/[%_\\]/g, '\\$&');
          nameConds.push("name_lower LIKE ? ESCAPE '\\'");
          params.push(`%${escTk}%`);
        }
        if (prefix.length >= 4) {
          const escPfx = prefix.slice(0, 5).replace(/[%_\\]/g, '\\$&');
          nameConds.push("name_lower LIKE ? ESCAPE '\\'");
          params.push(`${escPfx}%`);
        }
        if (nameConds.length > 0) {
          where.push(`(${nameConds.join(' OR ')})`);
        }
      }
      const rows = db.prepare(`
        SELECT path, parent_dir, name, ext, category, is_dir, size, mtime, ctime
        FROM file_index
        WHERE ${where.join(' AND ')}
        LIMIT 6000
      `).all(...params);
      for (const r of rows) {
        const thumbKey = makeThumbKey(r.path, r.mtime, r.size);
        candidates.push({
          name: r.name,
          path: r.path,
          parentDir: r.parent_dir,
          ext: r.ext,
          category: r.category,
          isDir: false,
          size: r.size,
          mtime: r.mtime,
          ctime: r.ctime,
          hasCachedThumb: thumbKey ? cachedThumbSet.has(`${thumbKey}.jpg`) : false,
        });
      }
    }
  }

  if (scopeUsed === 'folder') {
    candidates = await listFolderFilesLive(srcDir);
    source = 'live-folder';
  }

  const matched = [];
  const candPathSeen = new Set();

  for (const cand of candidates) {
    if (!cand || cand.isDir) continue;
    const isSelf = cand.path.toLowerCase() === resolvedSrc.toLowerCase();
    if (!isSelf && !categoryAllowed(cand.category)) continue;

    const candEmb = extractTimestampFromName(cand.name);
    let score = 0;

    if (mode === 'similarName') {
      if (isSelf) {
        score = 10000;
      } else {
        const lowerStem = path.basename(cand.name, cand.ext).toLocaleLowerCase('tr-TR');
        const candTok = extractNameTokens(cand.name);
        const candSet = new Set(candTok.tokens);
        for (const tk of tokens) {
          if (candSet.has(tk)) score += tk.length >= 6 ? 12 : 8;
          else if (lowerStem.includes(tk)) score += 6;
        }
        if (prefix.length >= 4 && lowerStem.replace(/[^a-zçğıöşü]/g, '').startsWith(prefix.slice(0, 4))) {
          score += 5;
        }
        if (score === 0) continue;
      }
    } else {
      const mtimeHit = cand.mtime >= minMs && cand.mtime <= maxMs;
      const embHit = candEmb
        ? (mode === 'nearTime' ? (candEmb.hasTime && candEmb.ms >= minMs && candEmb.ms <= maxMs) : (candEmb.ms >= minMs && candEmb.ms <= maxMs))
        : false;
      if (!isSelf && !mtimeHit && !embHit) continue;
      const candRef = (candEmb && (candEmb.hasTime || mode !== 'nearTime')) ? candEmb.ms : cand.mtime;
      score = isSelf ? 1000000000 : -Math.abs((candRef || 0) - effectiveRefMs);
    }

    candPathSeen.add(cand.path.toLowerCase());
    matched.push({ item: cand, score, isSelf });
  }

  if (!candPathSeen.has(resolvedSrc.toLowerCase()) && fs.existsSync(resolvedSrc)) {
    try {
      const st = await fsp.lstat(resolvedSrc);
      const tk = makeThumbKey(resolvedSrc, Math.floor(st.mtimeMs || 0), st.size || 0);
      matched.unshift({
        item: {
          name: srcName,
          path: resolvedSrc,
          parentDir: normalizeParentDir(srcDir),
          ext: srcExt,
          category: srcCat,
          isDir: false,
          size: st.size || 0,
          mtime: Math.floor(st.mtimeMs || 0),
          ctime: Math.floor(st.birthtimeMs || st.ctimeMs || 0),
          hasCachedThumb: cachedThumbSet.has(`${tk}.jpg`),
        },
        score: 1000000000,
        isSelf: true,
      });
    } catch {}
  }

  matched.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (mode === 'similarName') {
      if (b.score !== a.score) return b.score - a.score;
      return Math.abs((a.item.mtime || 0) - effectiveRefMs) - Math.abs((b.item.mtime || 0) - effectiveRefMs);
    }
    return b.score - a.score;
  });

  const items = matched.slice(0, limit).map((x) => x.item);
  return {
    ok: true,
    items,
    source,
    scopeUsed,
    mode,
    refDateMs: effectiveRefMs,
    tokens,
    prefix,
    fallbackNotice,
    durationMs: Number((performance.now() - t0).toFixed(1)),
  };
}

// ---------- Düşük Yük Arka Plan İndeksleyici (HDD Dostu Tek Fiber) ----------
const SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'winsxs',
  'installer',
  '$windows.~bt',
  'recovery',
  'node_modules',
  '.git',
]);

const indexState = {
  running: false,
  paused: false,
  cancelRequested: false,
  rootPath: '',
  indexedFiles: 0,
  indexedDirs: 0,
  currentDir: '',
  startedAt: 0,
  finishedAt: 0,
  error: null,
  recentLog: [],
};

function pushIndexLog(file, detail = '', status = 'ok') {
  indexState.recentLog.push({
    file: file || '',
    detail: detail || '',
    status,
    time: Date.now(),
  });
  if (indexState.recentLog.length > 60) indexState.recentLog.shift();
}

async function startBackgroundIndex(rootPath) {
  if (indexState.running) {
    return { started: false, message: 'İndeksleme zaten çalışıyor', status: getIndexStats() };
  }
  const cleanRoot = path.resolve(rootPath);
  indexState.running = true;
  indexState.paused = false;
  indexState.cancelRequested = false;
  indexState.rootPath = cleanRoot;
  indexState.indexedFiles = 0;
  indexState.indexedDirs = 0;
  indexState.currentDir = cleanRoot;
  indexState.startedAt = Date.now();
  indexState.finishedAt = 0;
  indexState.error = null;
  indexState.recentLog = [];

  (async () => {
    const queue = [cleanRoot];
    let dirStep = 0;
    try {
      while (queue.length > 0 && !indexState.cancelRequested) {
        while (indexState.paused && !indexState.cancelRequested) {
          await sleep(120);
        }
        if (indexState.cancelRequested) break;
        const dir = queue.shift();
        indexState.currentDir = dir;
        indexState.indexedDirs++;
        dirStep++;
        pushIndexLog(path.basename(dir) || dir, dir, 'info');

        let handle;
        try {
          handle = await fsp.opendir(dir, { bufferSize: 128 });
        } catch {
          continue;
        }

        const pendingFiles = [];
        let batchEntries = [];
        let direntCount = 0;
        try {
          for await (const dirent of handle) {
            if (++direntCount % 32 === 0) {
              while (indexState.paused && !indexState.cancelRequested) {
                await sleep(120);
              }
            }
            if (indexState.cancelRequested) break;
            const fullPath = path.join(dir, dirent.name);
            const isDir = dirent.isDirectory();
            const lower = dirent.name.toLowerCase();

            if (isDir) {
              if (!SKIP_DIRS.has(lower) && !dirent.isSymbolicLink()) {
                queue.push(fullPath);
              }
              batchEntries.push({
                name: dirent.name,
                path: fullPath,
                ext: '',
                category: 'folder',
                isDir: true,
                size: 0,
                mtime: 0,
                ctime: 0,
              });
            } else {
              pendingFiles.push({ name: dirent.name, path: fullPath });
            }
          }
        } catch {}

        // HDD'yi boğmamak için 8'li küçük gruplarla yalnızca dosya tablosu (stat) okunur; içerik okunmaz
        for (let i = 0; i < pendingFiles.length && !indexState.cancelRequested; i += 8) {
          while (indexState.paused && !indexState.cancelRequested) {
            await sleep(120);
          }
          if (indexState.cancelRequested) break;
          const chunk = pendingFiles.slice(i, i + 8);
          await Promise.all(
            chunk.map(async (f) => {
              if (indexState.cancelRequested) return;
              const ext = path.extname(f.name).toLowerCase();
              let size = 0;
              let mtime = 0;
              let ctime = 0;
              try {
                const st = await fsp.stat(f.path);
                size = st.size;
                mtime = Math.floor(st.mtimeMs);
                ctime = Math.floor(st.birthtimeMs || st.ctimeMs);
              } catch {}
              batchEntries.push({
                name: f.name,
                path: f.path,
                ext,
                category: getCategory(ext, false),
                isDir: false,
                size,
                mtime,
                ctime,
              });
              indexState.indexedFiles++;
            })
          );
          if (chunk.length > 0 && !indexState.cancelRequested) {
            const lastF = chunk[chunk.length - 1];
            pushIndexLog(lastF.name, lastF.path, 'ok');
          }
          // Büyük klasörlerde SQLite & event loop bloklanmasın, Duraklat/Durdur anında çalışsın
          if (batchEntries.length >= 160) {
            upsertDirEntries(dir, batchEntries);
            batchEntries = [];
            await sleep(2);
          }
        }

        if (!indexState.cancelRequested && batchEntries.length > 0) {
          upsertDirEntries(dir, batchEntries);
        }

        // Her 20 klasörde 15ms HDD nefes molası
        if (dirStep % 20 === 0) {
          await sleep(15);
        }
      }
    } catch (err) {
      indexState.error = err.message;
    } finally {
      indexState.running = false;
      indexState.paused = false;
      indexState.finishedAt = Date.now();
      indexState.currentDir = '';
    }
  })();

  return { started: true, status: getIndexStats() };
}

function stopBackgroundIndex() {
  if (indexState.running) {
    indexState.cancelRequested = true;
    indexState.paused = false;
  }
  return getIndexStats();
}

function controlBackgroundIndex(action) {
  if (!indexState.running) return getIndexStats();
  if (action === 'pause') indexState.paused = true;
  else if (action === 'resume') indexState.paused = false;
  else if (action === 'cancel' || action === 'stop') {
    indexState.cancelRequested = true;
    indexState.paused = false;
  }
  return getIndexStats();
}

function getIndexStats() {
  let totalEntries = 0;
  try {
    totalEntries = db.prepare('SELECT COUNT(*) as cnt FROM file_index').get().cnt;
  } catch {}
  return {
    ...indexState,
    recentLog: indexState.recentLog.slice(),
    totalEntries,
    cacheRoot: CACHE_ROOT,
    cachedThumbCount: cachedThumbSet.size,
    cachedThumbBytes,
  };
}

// ---------- Canlı Tarama İlerleme Takibi (Çoklu Eşzamanlı: Analiz, Boyut, Kopya Bulucu) ----------
let scanSeq = 0;
const scanTasks = new Map();

function startScanProgress(type, title, total = 0, targetPath = '') {
  const id = 'scan_' + (++scanSeq);
  const task = {
    id,
    active: true,
    status: 'running',
    paused: false,
    cancelled: false,
    type,
    targetPath: targetPath || '',
    title,
    currentItem: '',
    currentDetail: '',
    done: 0,
    total,
    startedAt: Date.now(),
    finishedAt: 0,
    itemsPerSec: 0,
    recentLog: [],
  };
  scanTasks.set(id, task);
  if (scanTasks.size > 20) {
    for (const [k, v] of scanTasks.entries()) {
      if (!v.active) {
        scanTasks.delete(k);
        break;
      }
    }
  }
  return id;
}

async function waitScanIfPaused(scanId) {
  const t = scanTasks.get(scanId);
  if (!t) return true;
  while (t.active && t.paused && !t.cancelled) {
    await sleep(150);
  }
  return !t.active || t.cancelled;
}

function controlScanProgress(action, scanId = null) {
  const all = Array.from(scanTasks.values());
  let targets = [];
  if (scanId) {
    const byId = scanTasks.get(scanId);
    if (byId) targets = [byId];
    else targets = all.filter((x) => x.active && x.type === scanId);
  } else {
    const activeList = all.filter((x) => x.active);
    if (activeList.length > 0) targets = [activeList[activeList.length - 1]];
  }

  for (const t of targets) {
    if (!t.active) continue;
    if (action === 'pause') t.paused = true;
    else if (action === 'resume') t.paused = false;
    else if (action === 'cancel') {
      t.cancelled = true;
      t.paused = false;
      t.active = false;
      t.status = 'cancelled';
      t.finishedAt = Date.now();
      t.currentItem = 'İptal edildi';
    }
  }
  return getScanProgress();
}

function updateScanProgress(scanId, item, detail = '', done = null, total = null) {
  const t = scanTasks.get(scanId);
  if (!t || !t.active) return;
  if (done !== null) t.done = done;
  if (total !== null) t.total = total;
  t.currentItem = item || '';
  t.currentDetail = detail || '';
  const elapsedSec = Math.max(0.15, (Date.now() - t.startedAt) / 1000);
  t.itemsPerSec = Number((t.done / elapsedSec).toFixed(1));
  if (item) {
    t.recentLog.push({ file: item, detail, status: 'info', time: Date.now() });
    if (t.recentLog.length > 50) t.recentLog.shift();
  }
}

function finishScanProgress(scanId, cancelled = false) {
  const t = scanTasks.get(scanId);
  if (!t) return;
  const isCancelled = Boolean(cancelled || t.cancelled);
  t.active = false;
  t.paused = false;
  t.cancelled = isCancelled;
  t.status = isCancelled ? 'cancelled' : 'completed';
  if (!isCancelled && t.total > 0) t.done = t.total;
  t.finishedAt = Date.now();
  t.currentItem = isCancelled ? 'İptal edildi' : 'İşlem tamamlandı';
}

function getScanProgress() {
  const scans = Array.from(scanTasks.values()).map((t) => ({
    ...t,
    recentLog: t.recentLog.slice(),
  }));
  const activeScans = scans.filter((t) => t.active);
  const primary = activeScans[activeScans.length - 1] || scans[scans.length - 1] || {
    active: false,
    paused: false,
    cancelled: false,
    id: null,
    type: '',
    targetPath: '',
    title: '',
    currentItem: '',
    currentDetail: '',
    done: 0,
    total: 0,
    startedAt: 0,
    finishedAt: 0,
    itemsPerSec: 0,
    recentLog: [],
  };
  return {
    ...primary,
    scans,
    activeScans,
  };
}

// ---------- Disk / Klasör Doluluk ve Kategori Analizörü ----------
function analyzeFromCache(targetPath) {
  let prefix = path.resolve(targetPath);
  if (!prefix.endsWith('\\')) prefix += '\\';
  const normParent = normalizeParentDir(targetPath);

  const catRows = db.prepare(`
    SELECT category, COUNT(*) as count, COALESCE(SUM(size), 0) as bytes
    FROM file_index
    WHERE is_dir = 0 AND (parent_dir = ? OR path LIKE ?)
    GROUP BY category
  `).all(normParent, prefix + '%');

  const topFiles = db.prepare(`
    SELECT path, name, ext, category, size, mtime
    FROM file_index
    WHERE is_dir = 0 AND (parent_dir = ? OR path LIKE ?)
    ORDER BY size DESC
    LIMIT 100
  `).all(normParent, prefix + '%');

  const dirCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_index
    WHERE is_dir = 1 AND (parent_dir = ? OR path LIKE ?)
  `).get(normParent, prefix + '%').cnt;

  return formatAnalysisResult(targetPath, catRows, topFiles, dirCount, 'sqlite-cache');
}

async function analyzeLive(targetPath) {
  const cleanRoot = path.resolve(targetPath);
  const categories = new Map();
  const topFiles = [];
  const immediateSubfolders = new Map();
  let dirCount = 0;

  const rootNorm = cleanRoot.endsWith('\\') ? cleanRoot : cleanRoot + '\\';
  const rootDepthLen = rootNorm.length;

  const queue = [cleanRoot];
  let steps = 0;
  let cancelled = false;
  const scanId = startScanProgress('analyze', `Canlı Disk Analizi: ${cleanRoot}`, 0, cleanRoot);

  try {
    while (queue.length > 0) {
      if (await waitScanIfPaused(scanId)) {
        cancelled = true;
        break;
      }
      const dir = queue.shift();
      dirCount++;
      steps++;
      if (steps % 4 === 1) {
        updateScanProgress(scanId, path.basename(dir) || dir, dir, dirCount, dirCount + queue.length);
      }

    let handle;
    try {
      handle = await fsp.opendir(dir, { bufferSize: 128 });
    } catch {
      continue;
    }

    const pendingFiles = [];
    const batchEntries = [];
    try {
      for await (const dirent of handle) {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (!SKIP_DIRS.has(dirent.name.toLowerCase()) && !dirent.isSymbolicLink()) {
            queue.push(fullPath);
          }
          batchEntries.push({
            name: dirent.name,
            path: fullPath,
            ext: '',
            category: 'folder',
            isDir: true,
            size: 0,
            mtime: 0,
            ctime: 0,
          });
        } else {
          pendingFiles.push({ name: dirent.name, path: fullPath });
        }
      }
    } catch {}

    for (let i = 0; i < pendingFiles.length; i += 10) {
      if (await waitScanIfPaused(scanId)) {
        cancelled = true;
        break;
      }
      const chunk = pendingFiles.slice(i, i + 10);
      await Promise.all(
        chunk.map(async (f) => {
          const ext = path.extname(f.name).toLowerCase();
          const cat = getCategory(ext, false);
          let size = 0;
          let mtime = 0;
          let ctime = 0;
          try {
            const st = await fsp.stat(f.path);
            size = st.size;
            mtime = Math.floor(st.mtimeMs);
            ctime = Math.floor(st.birthtimeMs || st.ctimeMs);
          } catch {}

          const cur = categories.get(cat) || { category: cat, count: 0, bytes: 0 };
          cur.count++;
          cur.bytes += size;
          categories.set(cat, cur);

          // Doğrudan alt klasör boyutunu topla
          if (f.path.length > rootDepthLen) {
            const rel = f.path.slice(rootDepthLen);
            const slashIdx = rel.indexOf('\\');
            if (slashIdx > 0) {
              const subName = rel.slice(0, slashIdx);
              const subPath = rootNorm + subName;
              const prev = immediateSubfolders.get(subPath) || { name: subName, path: subPath, bytes: 0, count: 0 };
              prev.bytes += size;
              prev.count++;
              immediateSubfolders.set(subPath, prev);
            }
          }

          // Top 100 en büyük dosya listesini bellekte tut
          if (topFiles.length < 100 || size > topFiles[topFiles.length - 1].size) {
            topFiles.push({ path: f.path, name: f.name, ext, category: cat, size, mtime });
            topFiles.sort((a, b) => b.size - a.size);
            if (topFiles.length > 100) topFiles.pop();
          }

          batchEntries.push({
            name: f.name,
            path: f.path,
            ext,
            category: cat,
            isDir: false,
            size,
            mtime,
            ctime,
          });
        })
      );
    }

      if (cancelled) break;
      if (batchEntries.length > 0) upsertDirEntries(dir, batchEntries);
      if (steps % 25 === 0) await sleep(12);
    }
  } finally {
    finishScanProgress(scanId, cancelled);
  }

  const catRows = Array.from(categories.values());
  const res = formatAnalysisResult(cleanRoot, catRows, topFiles, dirCount, 'live-scan');
  res.topFolders = Array.from(immediateSubfolders.values())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 25);
  if (cancelled) res.cancelled = true;
  return res;
}

function formatAnalysisResult(targetPath, catRows, topFiles, dirCount, source) {
  let totalBytes = 0;
  let totalFiles = 0;
  for (const r of catRows) {
    totalBytes += r.bytes || 0;
    totalFiles += r.count || 0;
  }
  const categories = catRows
    .map((r) => ({
      category: r.category,
      count: r.count,
      bytes: r.bytes,
      percent: totalBytes > 0 ? Number(((r.bytes / totalBytes) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    targetPath,
    source,
    totalBytes,
    totalFiles,
    dirCount,
    categories,
    topFiles,
    topFolders: [],
  };
}

// ---------- HDD Korumalı Sıralı Thumbnail Motoru (Concurrency = 1) ----------
function makeThumbKey(filePath, mtime, size) {
  return crypto.createHash('sha1').update(`${filePath.toLowerCase()}|${mtime}|${size}`).digest('hex');
}

function getThumbCacheInfo(filePath, mtime, size) {
  const key = makeThumbKey(filePath, mtime, size);
  const thumbFile = `${key}.jpg`;
  return {
    key,
    thumbFile,
    fullPath: path.join(THUMBS_DIR, thumbFile),
    cached: cachedThumbSet.has(thumbFile),
  };
}

// JPEG dosyalarının yalnızca ilk 64 KB başlığını okuyup gömülü EXIF kapak resmini çıkarır
async function tryExtractExifThumb(filePath, outPath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, 65536, 0);
    if (bytesRead < 200 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;

    const slice = buf.subarray(0, bytesRead);
    // İkinci SOI işaretini (0xFF 0xD8 0xFF) ara — gömülü EXIF thumbnail
    let start = -1;
    for (let i = 4; i < slice.length - 4; i++) {
      if (slice[i] === 0xff && slice[i + 1] === 0xd8 && slice[i + 2] === 0xff) {
        start = i;
        break;
      }
    }
    if (start === -1) return false;

    let end = -1;
    for (let j = start + 100; j < slice.length - 1; j++) {
      if (slice[j] === 0xff && slice[j + 1] === 0xd9) {
        end = j + 2;
        break;
      }
    }
    if (end === -1 || end - start < 1024) return false;

    await fsp.writeFile(outPath, slice.subarray(start, end));
    return true;
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

let resolvedFfmpegBin; // undefined = henüz kontrol edilmedi, null = yok, string = tam yol
function getFfmpegBin() {
  if (resolvedFfmpegBin !== undefined) return resolvedFfmpegBin;
  const localCandidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(path.dirname(process.execPath || __dirname), 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const c of localCandidates) {
    try {
      if (fs.existsSync(c)) {
        resolvedFfmpegBin = c;
        return resolvedFfmpegBin;
      }
    } catch {}
  }
  try {
    execFileSync('ffmpeg', ['-version'], { timeout: 2000, windowsHide: true, stdio: 'ignore' });
    resolvedFfmpegBin = 'ffmpeg';
    return resolvedFfmpegBin;
  } catch {
    resolvedFfmpegBin = null;
    return null;
  }
}

function runFfmpegThumb(filePath, outPath, seekSec) {
  const ffmpegBin = getFfmpegBin();
  if (!ffmpegBin) return Promise.resolve(false);
  return new Promise((resolve) => {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
    if (seekSec) {
      args.push('-ss', seekSec);
    }
    args.push('-i', filePath, '-frames:v', '1', '-vf', 'scale=240:240:force_original_aspect_ratio=decrease', '-q:v', '5', outPath);
    execFile(ffmpegBin, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err) => {
      if (err) {
        if (err.code === 'ENOENT') resolvedFfmpegBin = null;
        return resolve(false);
      }
      try {
        resolve(fs.existsSync(outPath) && fs.statSync(outPath).size > 100);
      } catch {
        resolve(false);
      }
    });
  });
}

// FFmpeg kurulu olmayan sistemlerde 0 MB ek boyutla Windows yerleşik Shell Thumbnail (IShellItemImageFactory) işçisi
let warmShellThumbWorker = null;
let shellThumbSeq = 0;

function getWarmShellThumbWorker() {
  if (warmShellThumbWorker && !warmShellThumbWorker.dead) return warmShellThumbWorker;

  const psScript = `
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Drawing
    $cs = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class LdShellThumb {
  [StructLayout(LayoutKind.Sequential)]
  public struct SIZE { public int cx; public int cy; }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
  interface IShellItemImageFactory {
    [PreserveSig]
    int GetImage([In, MarshalAs(UnmanagedType.Struct)] SIZE size, [In] int flags, out IntPtr phbm);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr hObject);

  public static bool SaveThumb(string srcPath, string outPath, int maxSize) {
    Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory factory = null;
    IntPtr hbm = IntPtr.Zero;
    try {
      int hr = SHCreateItemFromParsingName(srcPath, IntPtr.Zero, ref iid, out factory);
      if (hr != 0 || factory == null) return false;
      SIZE sz = new SIZE { cx = maxSize, cy = maxSize };
      // 0x04 = SIIGBF_THUMBNAILONLY, 0x00 = SIIGBF_RESIZETOFIT fallback
      hr = factory.GetImage(sz, 0x04, out hbm);
      if (hr != 0 || hbm == IntPtr.Zero) {
        hr = factory.GetImage(sz, 0x00, out hbm);
      }
      if (hr != 0 || hbm == IntPtr.Zero) return false;
      using (Bitmap bmp = Image.FromHbitmap(hbm)) {
        ImageCodecInfo jpgEnc = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) {
          if (c.FormatID == ImageFormat.Jpeg.Guid) { jpgEnc = c; break; }
        }
        if (jpgEnc != null) {
          using (EncoderParameters ep = new EncoderParameters(1)) {
            ep.Param[0] = new EncoderParameter(Encoder.Quality, 82L);
            bmp.Save(outPath, jpgEnc, ep);
          }
        } else {
          bmp.Save(outPath, ImageFormat.Jpeg);
        }
      }
      return true;
    } finally {
      if (hbm != IntPtr.Zero) DeleteObject(hbm);
      if (factory != null) Marshal.FinalReleaseComObject(factory);
    }
  }
}
'@
    Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try {
        $req = $line | ConvertFrom-Json
        $reqId = if ($req -and $req.id) { $req.id } else { 0 }
        $ok = [LdShellThumb]::SaveThumb($req.src, $req.out, 240)
        $res = @{ id = $reqId; ok = [bool]$ok } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine('RES|' + $res)
      } catch {
        $reqId = if ($req -and $req.id) { $req.id } else { 0 }
        $errRes = @{ id = $reqId; ok = $false; err = $_.Exception.Message } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine('RES|' + $errRes)
      }
      [Console]::Out.Flush()
    }
  `;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
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
          cb.resolve(Boolean(res.ok));
        }
      } catch {}
    }
  });

  const failAll = () => {
    worker.dead = true;
    if (warmShellThumbWorker === worker) warmShellThumbWorker = null;
    readyResolve(false);
    for (const cb of pending.values()) cb.resolve(false);
    pending.clear();
  };
  proc.on('error', failAll);
  proc.on('close', failAll);

  warmShellThumbWorker = worker;
  return worker;
}

function runWindowsShellThumb(filePath, outPath) {
  const worker = getWarmShellThumbWorker();
  const job = async () => {
    const ready = await Promise.race([
      worker.readyPromise,
      new Promise((r) => setTimeout(() => r(false), 10000)),
    ]);
    if (!ready || worker.dead) return false;
    return await new Promise((resolve) => {
      const id = ++shellThumbSeq;
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        try {
          if (worker.proc && worker.proc.pid) {
            execFile('taskkill', ['/PID', String(worker.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
          }
        } catch {}
        resolve(false);
      }, 6000);
      worker.pending.set(id, {
        resolve: (ok) => {
          clearTimeout(timer);
          try {
            resolve(Boolean(ok) && fs.existsSync(outPath) && fs.statSync(outPath).size > 100);
          } catch {
            resolve(false);
          }
        },
      });
      try {
        worker.proc.stdin.write(`${JSON.stringify({ id, src: filePath, out: outPath })}\n`, 'utf8');
      } catch {
        clearTimeout(timer);
        worker.pending.delete(id);
        resolve(false);
      }
    });
  };

  const p = worker.queueTail.then(job, job);
  worker.queueTail = p.catch(() => false);
  return p;
}

const thumbQueue = [];
const inFlightThumbs = new Map();
let thumbWorkerActive = false;

async function processThumbQueue() {
  if (thumbWorkerActive) return;
  thumbWorkerActive = true;

  try {
    while (thumbQueue.length > 0) {
      const job = thumbQueue.shift();
      if (job.cancelled) continue;

      try {
        if (fs.existsSync(job.outPath)) {
          cachedThumbSet.add(job.thumbFile);
          job.resolve(job.outPath);
        } else {
          const ext = path.extname(job.filePath).toLowerCase();
          let ok = false;

          if (ext === '.jpg' || ext === '.jpeg') {
            ok = await tryExtractExifThumb(job.filePath, job.outPath);
          }
          if (!ok && VIDEO_EXTS.has(ext)) {
            if (getFfmpegBin()) {
              ok = await runFfmpegThumb(job.filePath, job.outPath, '00:00:02');
              if (!ok) ok = await runFfmpegThumb(job.filePath, job.outPath, '00:00:00');
            }
            if (!ok) ok = await runWindowsShellThumb(job.filePath, job.outPath);
          } else if (!ok) {
            if (getFfmpegBin()) {
              ok = await runFfmpegThumb(job.filePath, job.outPath, null);
            }
            if (!ok) ok = await runWindowsShellThumb(job.filePath, job.outPath);
          }

          if (ok) {
            if (!cachedThumbSet.has(job.thumbFile)) {
              try { cachedThumbBytes += fs.statSync(job.outPath).size; } catch {}
            }
            cachedThumbSet.add(job.thumbFile);
            try {
              stmtUpsertThumb.run(job.key, job.filePath, job.mtime, job.size, job.thumbFile, Date.now());
            } catch {}
            job.resolve(job.outPath);
          } else {
            job.reject(new Error('Kapak oluşturulamadı'));
          }
        }
      } catch (err) {
        job.reject(err);
      } finally {
        inFlightThumbs.delete(job.key);
      }

      // HDD okuma kafası dinlendirme aralığı (Concurrency=1 garantisi)
      await sleep(40);
    }
  } finally {
    thumbWorkerActive = false;
  }
}

function getOrCreateThumbnail(filePath, mtime, size, sessionId = 'default') {
  const info = getThumbCacheInfo(filePath, mtime, size);
  if (info.cached && fs.existsSync(info.fullPath)) {
    return Promise.resolve(info.fullPath);
  }
  if (inFlightThumbs.has(info.key)) {
    return inFlightThumbs.get(info.key);
  }

  const p = new Promise((resolve, reject) => {
    thumbQueue.push({
      key: info.key,
      filePath,
      mtime: Number(mtime) || 0,
      size: Number(size) || 0,
      thumbFile: info.thumbFile,
      outPath: info.fullPath,
      sessionId,
      cancelled: false,
      resolve,
      reject,
    });
    processThumbQueue();
  });

  inFlightThumbs.set(info.key, p);
  return p;
}

function cancelThumbQueue(sessionId = null) {
  let cancelledCount = 0;
  for (let i = thumbQueue.length - 1; i >= 0; i--) {
    const job = thumbQueue[i];
    if (!sessionId || job.sessionId === sessionId) {
      job.cancelled = true;
      thumbQueue.splice(i, 1);
      inFlightThumbs.delete(job.key);
      job.reject(Object.assign(new Error('İptal edildi'), { cancelled: true }));
      cancelledCount++;
    }
  }
  return cancelledCount;
}

function escapeLikePrefix(prefix) {
  return prefix.replace(/[\\%_]/g, '\\$&') + '%';
}

// ---------- İsteğe Bağlı Klasör Boyutu Hesaplama (Concurrency = 1, Çoklu Sekme Uyumlu) ----------
function cancelFolderSizes() {
  controlScanProgress('cancel', 'folderSizes');
  return { ok: true, cancelled: true };
}

async function calculateFolderSizes(parentDir, folderPaths = []) {
  const sizes = {};
  const scanId = startScanProgress('folderSizes', `Boyut Tarama: ${parentDir || ''}`, folderPaths.length, parentDir || '');
  let completedFolders = 0;
  let cancelled = false;

  try {
    for (const fp of folderPaths) {
      if (await waitScanIfPaused(scanId)) {
        cancelled = true;
        return { sizes, cancelled: true };
      }
      const cleanRoot = path.resolve(fp);
      const folderName = path.basename(cleanRoot) || cleanRoot;
      let totalBytes = 0;
      const queue = [cleanRoot];
      let dirStep = 0;

      while (queue.length > 0) {
        if (await waitScanIfPaused(scanId)) {
          cancelled = true;
          return { sizes, cancelled: true };
        }
        const dir = queue.shift();
        dirStep++;
        if (dirStep % 5 === 1) {
          updateScanProgress(scanId, folderName, dir, completedFolders, folderPaths.length);
        }
        let handle;
      try {
        handle = await fsp.opendir(dir, { bufferSize: 128 });
      } catch {
        continue;
      }

      const dirCached = getCachedStatsMap(dir);
      const pendingFiles = [];
      const batchEntries = [];
      try {
        for await (const dirent of handle) {
          const t = scanTasks.get(scanId);
          if (!t || !t.active || t.cancelled) break;
          const full = path.join(dir, dirent.name);
          if (dirent.isDirectory()) {
            if (!SKIP_DIRS.has(dirent.name.toLowerCase()) && !dirent.isSymbolicLink()) {
              queue.push(full);
            }
            batchEntries.push({ name: dirent.name, path: full, ext: '', category: 'folder', isDir: true, size: 0, mtime: 0, ctime: 0 });
          } else {
            const c = dirCached.get(full);
            if (c && c.mtime > 0) {
              const sz = c.size || 0;
              totalBytes += sz;
              const ext = path.extname(dirent.name).toLowerCase();
              batchEntries.push({
                name: dirent.name,
                path: full,
                ext,
                category: getCategory(ext, false),
                isDir: false,
                size: sz,
                mtime: c.mtime,
                ctime: c.ctime || 0,
              });
            } else {
              pendingFiles.push({ name: dirent.name, path: full });
            }
          }
        }
      } catch {}

      if (await waitScanIfPaused(scanId)) {
        cancelled = true;
        return { sizes, cancelled: true };
      }

      for (let i = 0; i < pendingFiles.length; i += 10) {
        if (await waitScanIfPaused(scanId)) {
          cancelled = true;
          return { sizes, cancelled: true };
        }
        const chunk = pendingFiles.slice(i, i + 10);
        await Promise.all(
          chunk.map(async (f) => {
            const ext = path.extname(f.name).toLowerCase();
            let size = 0;
            let mtime = 0;
            let ctime = 0;
            try {
              const st = await fsp.stat(f.path);
              size = st.size;
              mtime = Math.floor(st.mtimeMs);
              ctime = Math.floor(st.birthtimeMs || st.ctimeMs);
            } catch {}
            totalBytes += size;
            batchEntries.push({
              name: f.name,
              path: f.path,
              ext,
              category: getCategory(ext, false),
              isDir: false,
              size,
              mtime,
              ctime,
            });
          })
        );
      }

      if (await waitScanIfPaused(scanId)) {
        cancelled = true;
        return { sizes, cancelled: true };
      }
      if (pendingFiles.length > 0 && batchEntries.length > 0) upsertDirEntries(dir, batchEntries);
      if (dirStep % 3 === 0) await sleep(2);
    }

      sizes[fp] = totalBytes;
      completedFolders++;
      updateScanProgress(scanId, folderName, `${cleanRoot} (${totalBytes} bayt)`, completedFolders, folderPaths.length);
    }

    return { sizes, cancelled };
  } finally {
    finishScanProgress(scanId, cancelled);
  }
}

// ---------- Birebir Kopya (Duplicate) Dosya Bulucu (HDD Dostu 2 Aşamalı) ----------
async function computePartialSignature(filePath, size) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const hash = crypto.createHash('sha1');
    hash.update(String(size) + '|');
    const headLen = Math.min(16384, size);
    const headBuf = Buffer.allocUnsafe(headLen);
    const r1 = await fh.read(headBuf, 0, headLen, 0);
    hash.update(headBuf.subarray(0, r1.bytesRead));

    if (size > 16384) {
      const tailLen = Math.min(16384, size - 16384);
      const tailBuf = Buffer.allocUnsafe(tailLen);
      const r2 = await fh.read(tailBuf, 0, tailLen, size - tailLen);
      hash.update(tailBuf.subarray(0, r2.bytesRead));
    }
    return hash.digest('hex');
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

const DUPE_PROTECTED_EXTS = new Set([
  '.dll', '.exe', '.sys', '.dat', '.pak', '.bin', '.asar', '.node',
  '.so', '.ocx', '.cpl', '.drv', '.mui', '.winmd', '.tlb', '.cat',
  '.lnk', '.msi', '.cab', '.inf', '.reg', '.regtrans-ms', '.blf',
  '.log1', '.log2', '.evtx', '.etl', '.ini',
]);

function isDuplicateProtectedPath(filePath, scanRoot) {
  const norm = String(filePath || '').replace(/\//g, '\\').toLowerCase();
  const rootNorm = String(scanRoot || '').replace(/\//g, '\\').toLowerCase();
  const base = path.basename(norm);

  // Windows kayıt defteri hive ve sistem profil dosyaları (örn. NTUSER.DAT{...}.regtrans-ms)
  if (
    base.startsWith('ntuser.') ||
    base.startsWith('usrclass.') ||
    base === 'desktop.ini' ||
    base === 'thumbs.db' ||
    base === 'pagefile.sys' ||
    base === 'hiberfil.sys' ||
    base === 'swapfile.sys'
  ) {
    return true;
  }

  // Sistem, program ve uygulama klasörlerini kopya silme adaylarından koru
  const protectedSegs = [
    '\\windows\\',
    '\\program files\\',
    '\\program files (x86)\\',
    '\\programdata\\',
    '\\$recycle.bin\\',
    '\\system volume information\\',
    '\\recovery\\',
    '\\users\\default\\',
    '\\users\\public\\',
    '\\users\\all users\\',
    '\\appdata\\',
    '\\node_modules\\',
    '\\.git\\',
    '\\.vscode\\',
    '\\.gemini\\',
    '\\.antigravity\\',
    '\\riot games\\',
    '\\steamapps\\',
  ];

  for (const seg of protectedSegs) {
    // Kullanıcı doğrudan bu alt klasörlerden birinin içini taramıyorsa hariç tut
    if (norm.includes(seg) && !rootNorm.includes(seg.slice(0, -1))) {
      return true;
    }
  }

  const ext = path.extname(norm);
  if (DUPE_PROTECTED_EXTS.has(ext)) {
    return true;
  }
  return false;
}

async function computeFullSha256(filePath, scanId) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 262144 });
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      resolve(val);
    };
    stream.on('data', (chunk) => {
      const t = scanTasks.get(scanId);
      if (!t || !t.active || t.cancelled) {
        stream.destroy();
        finish(null);
        return;
      }
      hash.update(chunk);
    });
    stream.on('end', () => finish(hash.digest('hex')));
    stream.on('error', () => finish(null));
  });
}

async function findDuplicates(targetPath) {
  const cleanRoot = path.resolve(targetPath);
  const prefix = cleanRoot.endsWith('\\') ? cleanRoot : cleanRoot + '\\';
  const likeArg = escapeLikePrefix(prefix);

  const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM file_index WHERE is_dir = 0 AND path LIKE ? ESCAPE '\\'`).get(likeArg);
  if (!countRow || countRow.cnt < 5) {
    const liveRes = await analyzeLive(cleanRoot);
    if (liveRes && liveRes.cancelled) {
      return {
        targetPath: cleanRoot,
        cancelled: true,
        totalGroups: 0,
        totalDuplicateFiles: 0,
        totalWastedBytes: 0,
        skippedProtectedCount: 0,
        groups: [],
      };
    }
  }

  const sizeGroups = db.prepare(`
    SELECT size, COUNT(*) AS cnt
    FROM file_index
    WHERE is_dir = 0 AND size > 1024 AND path LIKE ? ESCAPE '\\'
    GROUP BY size
    HAVING cnt > 1
    ORDER BY (size * (cnt - 1)) DESC
    LIMIT 300
  `).all(likeArg);

  const stmtBySize = db.prepare(`
    SELECT path, name, mtime, category
    FROM file_index
    WHERE is_dir = 0 AND size = ? AND path LIKE ? ESCAPE '\\'
    ORDER BY mtime ASC, path ASC
  `);

  const groups = [];
  let totalDuplicateFiles = 0;
  let totalWastedBytes = 0;
  let skippedProtectedCount = 0;
  let readSteps = 0;
  let groupIdx = 0;
  let cancelled = false;
  const scanId = startScanProgress('duplicates', `Kopya Arama: ${cleanRoot}`, sizeGroups.length, cleanRoot);

  try {
    for (const sg of sizeGroups) {
      if (await waitScanIfPaused(scanId)) {
        cancelled = true;
        break;
      }
      groupIdx++;
      const rawCandidates = stmtBySize.all(sg.size, likeArg);
      const candidates = [];
      const seenInodes = new Set();

      for (const c of rawCandidates) {
        if (isDuplicateProtectedPath(c.path, cleanRoot)) {
          skippedProtectedCount++;
          continue;
        }
        try {
          const st = await fsp.stat(c.path);
          if (st.size !== sg.size) continue;
          // NTFS hardlink'leri aynı fiziksel dosyadır, ekstra yer kaplamaz
          if (st.ino && st.ino > 0) {
            const inodeKey = `${st.dev}:${st.ino}`;
            if (seenInodes.has(inodeKey)) continue;
            seenInodes.add(inodeKey);
          }
          candidates.push(c);
        } catch {}
      }
      if (candidates.length < 2) continue;

      // Aşama 2: İlk 16KB + Son 16KB hızlı ön eleme
      const byPartial = new Map();
      for (const c of candidates) {
        if (await waitScanIfPaused(scanId)) {
          cancelled = true;
          break;
        }
        const sig = await computePartialSignature(c.path, sg.size);
        if (!sig) continue;
        if (++readSteps % 3 === 1) {
          updateScanProgress(scanId, c.name, c.path, groupIdx, sizeGroups.length);
        }
        if (readSteps % 15 === 0) await sleep(8);
        if (!byPartial.has(sig)) byPartial.set(sig, []);
        byPartial.get(sig).push(c);
      }
      if (cancelled) break;

      // Aşama 3: Tam dosya SHA-256 doğrulaması (%100 bayt-bayt kesinlik)
      for (const partialFiles of byPartial.values()) {
        if (partialFiles.length < 2) continue;
        const byFullHash = new Map();
        for (const c of partialFiles) {
          if (await waitScanIfPaused(scanId)) {
            cancelled = true;
            break;
          }
          updateScanProgress(scanId, `SHA-256: ${c.name}`, c.path, groupIdx, sizeGroups.length);
          const fullHash = await computeFullSha256(c.path, scanId);
          if (!fullHash) continue;
          if (!byFullHash.has(fullHash)) byFullHash.set(fullHash, []);
          byFullHash.get(fullHash).push(c);
          await sleep(4);
        }
        if (cancelled) break;

        for (const [fullHash, files] of byFullHash.entries()) {
          if (files.length < 2) continue;
          const wastedBytes = sg.size * (files.length - 1);
          totalDuplicateFiles += files.length - 1;
          totalWastedBytes += wastedBytes;
          groups.push({
            hash: fullHash,
            size: sg.size,
            wastedBytes,
            files,
          });
        }
      }
      if (cancelled) break;
    }
  } finally {
    finishScanProgress(scanId, cancelled);
  }

  if (cancelled) {
    return {
      targetPath: cleanRoot,
      cancelled: true,
      totalGroups: 0,
      totalDuplicateFiles: 0,
      totalWastedBytes: 0,
      skippedProtectedCount,
      groups: [],
    };
  }

  groups.sort((a, b) => b.wastedBytes - a.wastedBytes);
  return {
    targetPath: cleanRoot,
    totalGroups: groups.length,
    totalDuplicateFiles,
    totalWastedBytes,
    skippedProtectedCount,
    groups: groups.slice(0, 200),
  };
}

// Sabitlenen Klasörler (Pins) API'si
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

async function clearThumbCache() {
  cancelThumbQueue();
  try {
    const files = await fsp.readdir(THUMBS_DIR);
    for (const f of files) {
      if (f.endsWith('.jpg')) {
        await fsp.unlink(path.join(THUMBS_DIR, f)).catch(() => {});
      }
    }
  } catch {}
  try {
    db.exec('DELETE FROM thumbs;');
  } catch {}
  cachedThumbSet.clear();
  cachedThumbBytes = 0;
  return getIndexStats();
}

module.exports = {
  CACHE_ROOT,
  THUMBS_DIR,
  getCategory,
  upsertDirEntries,
  getCachedStatsMap,
  removeIndexedPath,
  searchFiles,
  findRelatedFiles,
  startBackgroundIndex,
  stopBackgroundIndex,
  controlBackgroundIndex,
  getIndexStats,
  analyzeFromCache,
  analyzeLive,
  getScanProgress,
  controlScanProgress,
  calculateFolderSizes,
  cancelFolderSizes,
  findDuplicates,
  makeThumbKey,
  getThumbCacheInfo,
  getOrCreateThumbnail,
  cancelThumbQueue,
  clearThumbCache,
  getPins,
  addPin,
  removePin,
  getFfmpegBin,
  runWindowsShellThumb,
  getDbInitWarning: () => dbInitWarning,
};
