'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { db, cachedThumbSet } = require('../db/sqliteConnection');
const { makeThumbKey, escapeLikePrefix } = require('../core/categoryClassifier');

// ---------- Analiz / Kopya / Klasör Boyutu Önbelleği & Akıllı Sanal Görünümler ----------
function normalizeCachePath(p) {
  const res = path.resolve(String(p || 'C:\\'));
  return res.replace(/[\\/]+$/, '').toLowerCase() || res.toLowerCase();
}

const stmtGetAnalysisCache = db.prepare(`
  SELECT kind, target_path, payload_json, dir_mtime_ms, created_at
  FROM analysis_cache WHERE cache_key = ?
`);

const stmtSetAnalysisCache = db.prepare(`
  INSERT INTO analysis_cache (cache_key, kind, target_path, payload_json, dir_mtime_ms, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    target_path = excluded.target_path,
    payload_json = excluded.payload_json,
    dir_mtime_ms = excluded.dir_mtime_ms,
    created_at = excluded.created_at
`);

function getAnalysisCache(kind, targetPath, lastMutationAt = 0) {
  try {
    const key = `${kind}|${normalizeCachePath(targetPath)}`;
    const row = stmtGetAnalysisCache.get(key);
    if (!row) return null;
    const payload = JSON.parse(row.payload_json);
    let stale = false;
    let staleReason = '';

    try {
      const st = fs.statSync(path.resolve(targetPath));
      const curMtime = Math.floor(st.mtimeMs || 0);
      if (row.dir_mtime_ms > 0 && curMtime > row.dir_mtime_ms + 1000) {
        stale = true;
        staleReason = 'Klasörde değişiklik algılandı';
      }
    } catch {}

    if (!stale && lastMutationAt > row.created_at) {
      stale = true;
      staleReason = 'Son taramadan sonra dosya işlemi yapıldı';
    }
    if (!stale && Date.now() - row.created_at > 3 * 24 * 60 * 60 * 1000) {
      stale = true;
      staleReason = 'Önbellek 3 günden eski';
    }

    return {
      data: payload,
      cachedAt: row.created_at,
      stale,
      staleReason,
    };
  } catch {
    return null;
  }
}

function setAnalysisCache(kind, targetPath, payload) {
  try {
    const resolved = path.resolve(targetPath);
    const key = `${kind}|${normalizeCachePath(resolved)}`;
    let dirMtimeMs = 0;
    try {
      dirMtimeMs = Math.floor(fs.statSync(resolved).mtimeMs || 0);
    } catch {}
    stmtSetAnalysisCache.run(key, kind, resolved, JSON.stringify(payload), dirMtimeMs, Date.now());
  } catch {}
}

function querySmartView(criteria = {}) {
  const t0 = performance.now();
  const wheres = ['is_dir = 0'];
  const params = [];

  if (criteria.category && criteria.category !== 'all') {
    wheres.push('category = ?');
    params.push(String(criteria.category));
  }
  if (Array.isArray(criteria.extList) && criteria.extList.length > 0) {
    const cleanExts = criteria.extList.map((e) => {
      const s = String(e || '').trim().toLowerCase();
      return s.startsWith('.') ? s : `.${s}`;
    }).filter((s) => s.length > 1);
    if (cleanExts.length > 0) {
      wheres.push(`ext IN (${cleanExts.map(() => '?').join(',')})`);
      params.push(...cleanExts);
    }
  }
  if (Number(criteria.minSize) > 0) {
    wheres.push('size >= ?');
    params.push(Number(criteria.minSize));
  }
  if (Number(criteria.maxSize) > 0) {
    wheres.push('size <= ?');
    params.push(Number(criteria.maxSize));
  }
  if (Number(criteria.withinDays) > 0) {
    wheres.push('mtime >= ?');
    params.push(Date.now() - Number(criteria.withinDays) * 24 * 60 * 60 * 1000);
  }
  if (criteria.nameContains && String(criteria.nameContains).trim()) {
    wheres.push('name_lower LIKE ?');
    params.push(`%${String(criteria.nameContains).trim().toLowerCase()}%`);
  }
  if (criteria.driveRoot && String(criteria.driveRoot).trim()) {
    let prefix = path.resolve(String(criteria.driveRoot));
    if (!prefix.endsWith('\\')) prefix += '\\';
    wheres.push("path LIKE ? ESCAPE '\\'");
    params.push(escapeLikePrefix(prefix));
  }

  const orderCol = criteria.sortBy === 'size' ? 'size DESC, mtime DESC' : 'mtime DESC, size DESC';
  const limit = Math.min(1000, Math.max(50, Number(criteria.limit) || 600));
  const sql = `
    SELECT path, parent_dir, name, ext, category, size, mtime, ctime
    FROM file_index
    WHERE ${wheres.join(' AND ')}
    ORDER BY ${orderCol}
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit);
  const totalIndexed = db.prepare('SELECT COUNT(*) AS cnt FROM file_index WHERE is_dir = 0').get()?.cnt || 0;

  const items = rows.map((r) => {
    const tk = makeThumbKey(r.path, r.mtime, r.size);
    return {
      name: r.name,
      path: r.path,
      parentDir: r.parent_dir,
      ext: r.ext,
      category: r.category,
      isDir: false,
      size: r.size,
      mtime: r.mtime,
      ctime: r.ctime,
      hasCachedThumb: cachedThumbSet.has(`${tk}.jpg`),
    };
  });

  return {
    items,
    totalIndexed,
    durationMs: Number((performance.now() - t0).toFixed(1)),
  };
}


module.exports = {
  normalizeCachePath,
  getAnalysisCache,
  setAnalysisCache,
  querySmartView,
};
