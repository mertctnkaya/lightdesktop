'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const idx = require('../../indexer-and-thumbs');
const { runPowerShellEnv } = require('../utils/psRunner');

// ---------- Sürücü Bilgileri (Anında statfsSync + SSD Etiket Önbelleği + Arka Plan PS Tazeleme) ----------
const DRIVE_LABELS_FILE = path.join(idx.CACHE_ROOT, 'drive-labels.json');
let drivesCache = { ts: 0, hasLabels: false, list: [] };
let drivesRefreshPromise = null;

function loadSavedDriveLabels() {
  try {
    if (fs.existsSync(DRIVE_LABELS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DRIVE_LABELS_FILE, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch {}
  return {};
}

function saveDriveLabels(list) {
  try {
    const map = {};
    for (const d of list || []) {
      if (d && d.id && d.label) map[d.id] = d.label;
    }
    fs.mkdirSync(path.dirname(DRIVE_LABELS_FILE), { recursive: true });
    fs.writeFileSync(DRIVE_LABELS_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch {}
}

function getFastStatfsDrives() {
  const savedLabels = loadSavedDriveLabels();
  const list = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      const st = fs.statfsSync(root);
      const total = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      const used = Math.max(0, total - free);
      const id = `${letter}:`;
      list.push({
        id,
        path: root,
        label: savedLabels[id] || (letter === 'C' ? 'Yerel Disk' : 'Disk'),
        driveType: 3,
        total,
        free,
        used,
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
      });
    } catch {}
  }
  return list;
}

function refreshDrivesFromPowerShell() {
  if (drivesRefreshPromise) return drivesRefreshPromise;
  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, DriveType, Size, FreeSpace | ConvertTo-Json -Compress
  `;
  drivesRefreshPromise = runPowerShellEnv(psScript, {}, 4500)
    .then((out) => {
      const parsed = JSON.parse(out || '[]');
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const list = arr
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
      if (list.length > 0) {
        drivesCache = { ts: Date.now(), hasLabels: true, list };
        saveDriveLabels(list);
      }
      return drivesCache.list;
    })
    .catch(() => drivesCache.list)
    .finally(() => {
      drivesRefreshPromise = null;
    });
  return drivesRefreshPromise;
}

function prewarmDrives() {
  if (drivesCache.list.length === 0) {
    drivesCache = { ts: Date.now(), hasLabels: false, list: getFastStatfsDrives() };
  }
  refreshDrivesFromPowerShell();
}

async function getDrives(force = false) {
  if (force) {
    const res = await refreshDrivesFromPowerShell();
    if (res && res.length > 0) return res;
    const fast = getFastStatfsDrives();
    drivesCache = { ts: Date.now(), hasLabels: false, list: fast };
    return fast;
  }
  if (drivesCache.list.length > 0 && Date.now() - drivesCache.ts < 60000) {
    if (!drivesCache.hasLabels) refreshDrivesFromPowerShell();
    return drivesCache.list;
  }
  const fast = getFastStatfsDrives();
  drivesCache = { ts: Date.now(), hasLabels: false, list: fast };
  refreshDrivesFromPowerShell();
  return fast;
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
    if (dirent.name.toLowerCase() === '.lightdesktopvault') continue;
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
const TREE_SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', '.lightdesktopvault']);

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

module.exports = {
  getDrives,
  prewarmDrives,
  getQuickAccessFolders,
  listDirectory,
  listSubdirs,
  getItemsProperties,
};
