'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { db, upsertDirEntries } = require('../db/sqliteConnection');
const { SKIP_DIRS, getCategory, sleep, escapeLikePrefix, normalizeParentDir } = require('../core/categoryClassifier');
const { startScanProgress, waitScanIfPaused, updateScanProgress, finishScanProgress } = require('./scanProgressTracker');

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


module.exports = {
  analyzeFromCache,
  analyzeLive,
  formatAnalysisResult,
};
