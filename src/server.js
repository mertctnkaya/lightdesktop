'use strict';

const NODE_BOOT_EPOCH_MS = Date.now();

// LightDesktop HTTP & İşletim Sistemi Sunucusu — 5S Modüler Giriş Noktası

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const idx = require('./indexer-and-thumbs');
const { PORT, HOST, LOG_FILE, START_TIME, getActivePort, setActivePort } = require('./backend/config/constants');
const { sendJson } = require('./backend/utils/httpHelpers');
const { appendServerLog, recordAppError, writeFatalCrashDump } = require('./backend/services/loggerService');
const { getWarmRecycleWorker, listRecycleBin } = require('./backend/services/recycleBinService');
const { prewarmDrives } = require('./backend/services/drivesAndFsService');
const { serveStaticAsset, prewarmStaticAssets } = require('./backend/services/staticAssetServer');
const { handleApiRoute } = require('./backend/routes/apiRouter');
const { purgeExpiredVaultEntries } = require('./backend/services/protectedVaultService');
const { startActivityWatchers } = require('./backend/services/activityWatcherService');

process.on('uncaughtException', (err) => {
  writeFatalCrashDump('uncaughtException', err);
  recordAppError('Sunucu', 'uncaughtException', err && err.message ? err.message : String(err), {
    stack: err && err.stack ? err.stack : '',
  });
  if (err && err.code === 'EADDRINUSE') {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  writeFatalCrashDump('unhandledRejection', err);
  recordAppError('Sunucu', 'unhandledRejection', err.message, { stack: err.stack || '' });
});

let serverListening = false;
let fallbackPortTried = false;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${getActivePort()}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const handled = await handleApiRoute(req, res, url, pathname);
      if (handled !== false || res.headersSent || res.writableEnded) return;
    }

    if (serveStaticAsset(req, res, pathname)) {
      return;
    }

    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bulunamadı');
    }
  } catch (err) {
    const stack = err && err.stack ? err.stack : '';
    recordAppError(req.url || 'Sunucu', req.method || '', err.message || 'Sunucu hatası', { stack });
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, 500, { error: err.message || 'Sunucu hatası', stack: process.env.LD_DEBUG === '1' ? stack : undefined });
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
});

server.on('clientError', (err, socket) => {
  if (err && err.code === 'ECONNRESET') return;
  try {
    if (socket && socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  } catch {}
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && process.env.LD_PORT_AUTO === '1' && !fallbackPortTried) {
    fallbackPortTried = true;
    appendServerLog(`Port ${getActivePort()} meşgul, otomatik boş port seçiliyor...`);
    server.listen(0, HOST);
    return;
  }
  writeFatalCrashDump('HTTP server hatası', err);
  if (!serverListening || (err && err.code === 'EADDRINUSE')) {
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  serverListening = true;
  const addr = server.address();
  if (addr && typeof addr === 'object' && addr.port) {
    setActivePort(addr.port);
  }
  console.log(`LIGHTDESKTOP_READY=http://${HOST}:${getActivePort()}`);
  console.log(`LightDesktop sunucusu hazır: http://${HOST}:${getActivePort()}`);
  console.log(`SSD Önbellek: ${idx.CACHE_ROOT}`);

  try {
    const baseMs = Number(process.env.LD_START_EPOCH_MS) || START_TIME;
    const profFile = path.join(path.dirname(LOG_FILE), 'startup-profile.txt');
    const tRequire = Math.max(0, NODE_BOOT_EPOCH_MS - baseMs);
    const tReady = Math.max(0, Date.now() - baseMs);
    const lines = [
      `  +${String(tRequire).padStart(5)} ms  (node)  [NODE] server.js basladi (require oncesi)`,
      `  +${String(tReady).padStart(5)} ms  (d +${String(Math.max(0, tReady - tRequire)).padStart(4)} ms)  [NODE] server.listen hazir (require+init)`,
    ];
    fs.appendFileSync(profFile, lines.join('\n') + '\n', 'utf8');
  } catch {}

  // Açılışı sıfır gecikmeye çekmek için arka plan ön-ısıtmaları (non-blocking)
  prewarmStaticAssets();
  prewarmDrives();
  setTimeout(() => {
    try { listRecycleBin().catch(() => {}); } catch {}
    try { getWarmRecycleWorker(); } catch {}
    try { purgeExpiredVaultEntries().catch(() => {}); } catch {}
    try { startActivityWatchers(); } catch {}
  }, 400);
});
