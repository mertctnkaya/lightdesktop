'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('../db/sqliteConnection');
const { SKIP_DIRS, getCategory, sleep, escapeLikePrefix } = require('../core/categoryClassifier');
const { scanTasks, startScanProgress, waitScanIfPaused, updateScanProgress, finishScanProgress } = require('./scanProgressTracker');
const { analyzeLive } = require('./diskAnalyzer');

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

const DEV_PROJECT_MARKERS = [
  '.git',
  'package.json',
  'capacitor.config.ts',
  'capacitor.config.json',
  'capacitor.config.js',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'pubspec.yaml',
  'composer.json',
  'CMakeLists.txt',
];

const DEV_BUILD_SEGS = [
  '\\dist\\',
  '\\build\\',
  '\\intermediates\\',
  '\\.gradle\\',
  '\\.next\\',
  '\\.nuxt\\',
  '\\.svelte-kit\\',
  '\\.vite\\',
  '\\.build-tools\\',
  '\\.venv\\',
  '\\venv\\',
  '\\__pycache__\\',
  '\\target\\',
  '\\pods\\',
  '\\android\\app\\src\\main\\assets\\',
  '\\ios\\app\\',
];

function hasDevMarker(dirPath, markerCache) {
  const key = dirPath.toLowerCase();
  if (markerCache && markerCache.has(key)) return markerCache.get(key);
  let found = false;
  for (const m of DEV_PROJECT_MARKERS) {
    try {
      if (fs.existsSync(path.join(dirPath, m))) {
        found = true;
        break;
      }
    } catch {}
  }
  if (markerCache) markerCache.set(key, found);
  return found;
}

function isDevProjectFile(filePath, scanRoot, markerCache = null) {
  const norm = String(filePath || '').replace(/\//g, '\\').toLowerCase();
  const rootNorm = String(scanRoot || '').replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase();

  for (const seg of DEV_BUILD_SEGS) {
    if (norm.includes(seg) && !rootNorm.includes(seg.slice(0, -1))) {
      return true;
    }
  }

  let cur = path.dirname(path.resolve(filePath));
  for (let depth = 0; depth < 10; depth++) {
    if (!cur || cur.length <= 3) break;
    if (hasDevMarker(cur, markerCache)) return true;
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
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

async function findDuplicates(targetPath, opts = {}) {
  const cleanRoot = path.resolve(targetPath);
  const protectDevProjects = opts.protectDevProjects !== false;
  const devMarkerCache = new Map();
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
        skippedDevProjectCount: 0,
        protectDevProjects,
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
  let skippedDevProjectCount = 0;
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
        if (protectDevProjects && isDevProjectFile(c.path, cleanRoot, devMarkerCache)) {
          skippedDevProjectCount++;
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
      skippedDevProjectCount,
      protectDevProjects,
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
    skippedDevProjectCount,
    protectDevProjects,
    groups: groups.slice(0, 200),
  };
}

// Sabitlenen Klasörler (Pins) API'si

module.exports = {
  computePartialSignature,
  isDuplicateProtectedPath,
  isDevProjectFile,
  computeFullSha256,
  findDuplicates,
};
