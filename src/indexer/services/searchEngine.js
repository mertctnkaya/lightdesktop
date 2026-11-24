'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { db, cachedThumbSet } = require('../db/sqliteConnection');
const { getCategory, makeThumbKey, escapeLikePrefix, normalizeParentDir } = require('../core/categoryClassifier');
const { getIndexStats } = require('./backgroundIndexer');

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


module.exports = {
  queryEverythingCli,
  searchFiles,
};
