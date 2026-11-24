'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR, MIME_TYPES } = require('../config/constants');
const { pipeFileStream } = require('../utils/httpHelpers');

const IS_PORTABLE = process.env.LD_PORTABLE === '1';

let htmlCache = { sig: '', content: '' };
let cssCache = { sig: '', content: '' };
const ramFileCache = new Map(); // fullPath -> { mtimeMs, buf, contentType }

function computeDirSig(dir, ext) {
  if (!fs.existsSync(dir)) return '';
  let sig = '';
  for (const name of fs.readdirSync(dir).sort()) {
    if (ext && !name.endsWith(ext)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) sig += `${name}:${Math.floor(st.mtimeMs)};`;
    } catch {}
  }
  return sig;
}

function collectJsPreloadPaths(dir, prefix = '/js') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      out.push(...collectJsPreloadPaths(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name.endsWith('.js')) {
      out.push(`${prefix}/${entry.name}`);
    }
  }
  return out;
}

function getAssembledHtml(force = false) {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  const modalsDir = path.join(PUBLIC_DIR, 'modals');
  if (!force && IS_PORTABLE && htmlCache.content) return htmlCache.content;

  let sig = '';
  try {
    sig = `i:${Math.floor(fs.statSync(indexPath).mtimeMs)}|${computeDirSig(modalsDir, '.html')}`;
  } catch {}
  if (!force && htmlCache.content && htmlCache.sig === sig) return htmlCache.content;

  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/<!--\s*@include\s+([^\s]+)\s*-->/g, (_m, rel) => {
    const target = path.resolve(PUBLIC_DIR, rel);
    if (!target.startsWith(PUBLIC_DIR) || !fs.existsSync(target)) return '';
    return fs.readFileSync(target, 'utf8');
  });

  htmlCache = { sig, content: html };
  return html;
}

function getAssembledCss(force = false) {
  const cssDir = path.join(PUBLIC_DIR, 'css');
  const legacyCss = path.join(PUBLIC_DIR, 'styles.css');
  if (!force && IS_PORTABLE && cssCache.content) return cssCache.content;

  if (fs.existsSync(cssDir)) {
    const sig = computeDirSig(cssDir, '.css');
    if (!force && cssCache.content && cssCache.sig === sig) return cssCache.content;
    const files = fs.readdirSync(cssDir).filter((n) => n.endsWith('.css')).sort();
    const combined = files
      .map((name) => `/* === ${name} === */\n${fs.readFileSync(path.join(cssDir, name), 'utf8')}`)
      .join('\n');
    cssCache = { sig, content: combined };
    return combined;
  }

  if (fs.existsSync(legacyCss)) {
    const sig = String(Math.floor(fs.statSync(legacyCss).mtimeMs));
    if (!force && cssCache.content && cssCache.sig === sig) return cssCache.content;
    const content = fs.readFileSync(legacyCss, 'utf8');
    cssCache = { sig, content };
    return content;
  }

  return '';
}

function serveStaticAsset(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    const html = getAssembledHtml(false);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES['.html'],
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(html);
    return true;
  }

  const staticCacheCtrl = 'no-store, no-cache, must-revalidate';

  if (pathname === '/styles.css') {
    const css = getAssembledCss(false);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES['.css'],
      'Cache-Control': staticCacheCtrl,
    });
    res.end(css);
    return true;
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const fullStatic = path.join(PUBLIC_DIR, safePath);
  if (!fullStatic.startsWith(PUBLIC_DIR)) return false;

  const cached = ramFileCache.get(fullStatic);
  if (IS_PORTABLE && cached) {
    res.writeHead(200, {
      'Content-Type': cached.contentType,
      'Cache-Control': staticCacheCtrl,
    });
    res.end(cached.buf);
    return true;
  }

  if (!fs.existsSync(fullStatic)) return false;
  const st = fs.statSync(fullStatic);
  if (!st.isFile()) return false;

  const ext = path.extname(fullStatic).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // Küçük metin/ikon varlıklarını (< 512 KB) RAM'de önbellekle
  if (st.size <= 512 * 1024) {
    if (!cached || cached.mtimeMs !== st.mtimeMs) {
      const buf = fs.readFileSync(fullStatic);
      ramFileCache.set(fullStatic, { mtimeMs: st.mtimeMs, buf, contentType });
    }
    const entry = ramFileCache.get(fullStatic);
    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Cache-Control': staticCacheCtrl,
    });
    res.end(entry.buf);
    return true;
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
  });
  pipeFileStream(req, res, fullStatic);
  return true;
}

function prewarmStaticAssets() {
  try { getAssembledHtml(true); } catch {}
  try { getAssembledCss(true); } catch {}
  try {
    const jsDir = path.join(PUBLIC_DIR, 'js');
    for (const rel of collectJsPreloadPaths(jsDir)) {
      const full = path.join(PUBLIC_DIR, rel);
      if (fs.existsSync(full)) {
        const st = fs.statSync(full);
        ramFileCache.set(full, {
          mtimeMs: st.mtimeMs,
          buf: fs.readFileSync(full),
          contentType: MIME_TYPES['.js'],
        });
      }
    }
  } catch {}
}

module.exports = {
  getAssembledHtml,
  getAssembledCss,
  serveStaticAsset,
  prewarmStaticAssets,
};
