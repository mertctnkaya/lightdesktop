'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const PUBLIC_DIR = path.join(SRC_DIR, 'public');

const EXPECTED_INDEXER_EXPORTS = [
  'CACHE_ROOT', 'THUMBS_DIR', 'STORYBOARDS_DIR', 'getCategory',
  'upsertDirEntries', 'getCachedStatsMap', 'removeIndexedPath',
  'searchFiles', 'findRelatedFiles', 'startBackgroundIndex',
  'stopBackgroundIndex', 'controlBackgroundIndex', 'getIndexStats',
  'analyzeFromCache', 'analyzeLive', 'getScanProgress',
  'controlScanProgress', 'calculateFolderSizes', 'cancelFolderSizes',
  'findDuplicates', 'makeThumbKey', 'getThumbCacheInfo',
  'getOrCreateThumbnail', 'cancelThumbQueue', 'clearThumbCache',
  'getPins', 'addPin', 'removePin', 'getFfmpegBin',
  'runWindowsShellThumb', 'getAnalysisCache', 'setAnalysisCache',
  'querySmartView', 'getOrCreateVideoStoryboard', 'getDbInitWarning',
];

function walkFiles(dir, extFilter = null) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full, extFilter));
    else if (!extFilter || full.endsWith(extFilter)) out.push(full);
  }
  return out;
}

function fail(msg) {
  console.error('VERIFY_5S_FAIL:', msg);
  process.exit(1);
}

// 1. Sözdizimi Kontrolü (Tüm .js dosyaları)
const jsFiles = walkFiles(SRC_DIR, '.js');
let checkedJs = 0;
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`Syntax error in ${path.relative(ROOT, file)}:\n${r.stderr || r.stdout}`);
  }
  checkedJs++;
}

// 1b. Backend & Indexer CommonJS Builtin Import Denetimi
const cjsBuiltins = ['fs', 'fsp', 'path', 'os', 'crypto', 'execFile', 'execFileSync', 'spawn', 'readline', 'http', 'idx'];
for (const file of [...walkFiles(path.join(SRC_DIR, 'backend'), '.js'), ...walkFiles(path.join(SRC_DIR, 'indexer'), '.js')]) {
  const src = fs.readFileSync(file, 'utf8');
  const cleaned = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
  for (const b of cjsBuiltins) {
    if (new RegExp(`(?<![.\\w$'"])${b}\\s*[.(]`, 'g').test(cleaned)) {
      if (!new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\b${b}\\b[^}]*\\}|${b}\\b)`).test(cleaned)) {
        fail(`Missing require('${b}') in ${path.relative(ROOT, file)}`);
      }
    }
  }
}

// 2. Indexer Export Kontrolü
const idx = require(path.join(SRC_DIR, 'indexer-and-thumbs.js'));
const idxKeys = new Set(Object.keys(idx));
const missingExports = EXPECTED_INDEXER_EXPORTS.filter((k) => !idxKeys.has(k));
if (missingExports.length > 0) {
  fail(`Missing indexer exports: ${missingExports.join(', ')}`);
}

// 3. HTML & CSS Bütünlük Kontrolü (RAM Assembler veya Doğrudan Dosya)
const staticSvcPath = path.join(SRC_DIR, 'backend', 'services', 'staticAssetServer.js');
let htmlContent = '';
let cssSize = 0;
if (fs.existsSync(staticSvcPath)) {
  const staticSvc = require(staticSvcPath);
  htmlContent = staticSvc.getAssembledHtml(true);
  cssSize = Buffer.byteLength(staticSvc.getAssembledCss(true), 'utf8');
} else {
  htmlContent = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const cssPath = path.join(PUBLIC_DIR, 'styles.css');
  if (fs.existsSync(cssPath)) cssSize = fs.statSync(cssPath).size;
}

if (htmlContent.includes('<!-- @include ')) {
  fail('Unresolved <!-- @include ... --> directive found in assembled HTML');
}
const htmlIds = [...htmlContent.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const idCounts = new Map();
for (const id of htmlIds) idCounts.set(id, (idCounts.get(id) || 0) + 1);
const dupIds = [...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
if (dupIds.length > 0) fail(`Duplicate HTML IDs: ${dupIds.join(', ')}`);
if (htmlIds.length < 355) fail(`Unexpectedly low HTML ID count: ${htmlIds.length} (expected >= 355)`);
if (cssSize < 40000) fail(`Assembled CSS unexpectedly small: ${cssSize} bytes`);

// 4. Frontend ES Module Import / Export Doğrulaması
const esDir = path.join(PUBLIC_DIR, 'js');
let esModuleCount = 0;
if (fs.existsSync(esDir)) {
  const esFiles = walkFiles(esDir, '.js');
  esModuleCount = esFiles.length;
  const exportMap = new Map();

  for (const file of esFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const exportsSet = new Set();
    for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      exportsSet.add(m[1]);
    }
    for (const m of src.matchAll(/^\s*export\s*\{([^}]+)\}/gm)) {
      for (const part of m[1].split(',')) {
        const clean = part.trim();
        if (!clean) continue;
        const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(clean);
        exportsSet.add(asMatch ? asMatch[1] : clean.split(/\s+/)[0]);
      }
    }
    exportMap.set(path.resolve(file), exportsSet);
  }

  for (const file of esFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    for (const m of src.matchAll(/^\s*import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/gm)) {
      const specifiers = m[1];
      const rel = m[2];
      const target = path.resolve(dir, rel);
      if (!exportMap.has(target)) {
        fail(`Broken ES import in ${path.relative(ROOT, file)}: '${rel}' not found`);
      }
      const targetExports = exportMap.get(target);
      for (const part of specifiers.split(',')) {
        const clean = part.trim();
        if (!clean) continue;
        const origName = clean.split(/\s+as\s+/)[0].trim();
        if (!targetExports.has(origName)) {
          fail(`Missing export '${origName}' in ${path.relative(ROOT, target)} (imported by ${path.relative(ROOT, file)})`);
        }
      }
    }
  }
}

// 5. CommonJS Modüller Arası Eksik Sembol (Cross-Module Require) Kontrolü
function auditCrossModuleSymbols(groupName, groupFiles) {
  const strip = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const defMap = new Map();
  const IGNORE_SHORT_EXPORTS = new Set(['path', 'name', 'type', 'size', 'list', 'ok', 'get', 'set', 'run']);
  for (const f of groupFiles) {
    const clean = strip(fs.readFileSync(f, 'utf8'));
    for (const m of clean.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      if (!defMap.has(m[1])) defMap.set(m[1], f);
    }
    for (const m of clean.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
      if (!defMap.has(m[1])) defMap.set(m[1], f);
    }
    if (path.basename(f) !== 'server.js') {
      try {
        const mod = require(f);
        if (mod && typeof mod === 'object') {
          for (const k of Object.keys(mod)) {
            if (!IGNORE_SHORT_EXPORTS.has(k) && !defMap.has(k)) defMap.set(k, f);
          }
        }
      } catch {}
    }
  }
  for (const f of groupFiles) {
    const clean = strip(fs.readFileSync(f, 'utf8'));
    const declared = new Set();
    for (const m of clean.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/\b(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
    for (const m of clean.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const alias = part.split(':').pop().trim().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(alias)) declared.add(alias);
      }
    }
    for (const m of clean.matchAll(/\b(?:const|let|var)\s*\[([^\]]+)\]\s*=/g)) {
      for (const part of m[1].split(',')) {
        const alias = part.replace(/^\.\.\./, '').trim().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(alias)) declared.add(alias);
      }
    }
    for (const [sym, defFile] of defMap.entries()) {
      if (f === defFile || declared.has(sym) || (sym.length <= 2 && sym !== 'db')) continue;
      const re = new RegExp(`(?<![.\\w$])${sym}\\b(?!\\s*:)`, 'g');
      if (re.test(clean)) {
        fail(`[${groupName}] Missing require/import for '${sym}' in ${path.relative(ROOT, f)} (defined in ${path.relative(ROOT, defFile)})`);
      }
    }
  }
}

auditCrossModuleSymbols('indexer', [
  ...walkFiles(path.join(SRC_DIR, 'indexer'), '.js'),
  path.join(SRC_DIR, 'indexer-and-thumbs.js'),
]);
auditCrossModuleSymbols('backend', [
  ...walkFiles(path.join(SRC_DIR, 'backend'), '.js'),
  path.join(SRC_DIR, 'server.js'),
]);

console.log(
  `VERIFY_5S_OK | JS=${checkedJs} | ES_MODS=${esModuleCount} | INDEXER_EXPORTS=${EXPECTED_INDEXER_EXPORTS.length} | HTML_IDS=${htmlIds.length} | CSS_BYTES=${cssSize}`
);
process.exit(0);
