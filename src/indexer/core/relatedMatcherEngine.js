'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { db, cachedThumbSet } = require('../db/sqliteConnection');
const { getCategory, makeThumbKey, escapeLikePrefix, normalizeParentDir } = require('./categoryClassifier');

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


module.exports = {
  GENERIC_MEDIA_TOKENS,
  extractTimestampFromName,
  isGenericMediaWord,
  extractNameTokens,
  listFolderFilesLive,
  findRelatedFiles,
};
