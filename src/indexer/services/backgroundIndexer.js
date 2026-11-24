'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { CACHE_ROOT, db, cachedThumbSet, getCachedThumbBytes, upsertDirEntries } = require('../db/sqliteConnection');
const { SKIP_DIRS, getCategory, sleep, normalizeParentDir } = require('../core/categoryClassifier');

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
    cachedThumbBytes: getCachedThumbBytes(),
  };
}


module.exports = {
  indexState,
  pushIndexLog,
  startBackgroundIndex,
  stopBackgroundIndex,
  controlBackgroundIndex,
  getIndexStats,
};
