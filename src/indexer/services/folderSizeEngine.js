'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { upsertDirEntries, getCachedStatsMap } = require('../db/sqliteConnection');
const { SKIP_DIRS, getCategory, sleep } = require('../core/categoryClassifier');
const { scanTasks, startScanProgress, waitScanIfPaused, updateScanProgress, finishScanProgress, controlScanProgress } = require('./scanProgressTracker');

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


module.exports = {
  cancelFolderSizes,
  calculateFolderSizes,
};
