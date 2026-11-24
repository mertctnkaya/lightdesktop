'use strict';

const fs = require('node:fs');
const os = require('node:os');
const idx = require('../../indexer-and-thumbs');
const {
  APP_VERSION,
  LOG_FILE,
  CRASH_DUMP_FILE,
  START_TIME,
  getActivePort,
} = require('../config/constants');

const errorHistory = [];
let unreadErrors = 0;

function appendServerLog(msg) {
  try {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
        const prev = `${LOG_FILE}.prev`;
        try { if (fs.existsSync(prev)) fs.unlinkSync(prev); } catch {}
        fs.renameSync(LOG_FILE, prev);
      }
    } catch {}
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${ts}] [SERVER] ${msg}\n`, 'utf8');
  } catch {}
}

function recordAppError(op, target, message, extra = {}) {
  const cleanMsg = String(message || 'Bilinmeyen hata').trim();
  const cleanTarget = target ? String(target) : '';
  const cleanStack = extra && extra.stack ? String(extra.stack).trim().slice(0, 4000) : '';
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: new Date().toISOString(),
    op: op || 'Genel',
    target: cleanTarget,
    message: cleanMsg,
    stack: cleanStack || undefined,
    meta: extra && extra.meta ? extra.meta : undefined,
  };
  errorHistory.unshift(entry);
  if (errorHistory.length > 200) errorHistory.length = 200;
  unreadErrors++;
  const firstFrame = cleanStack ? ` | Stack: ${cleanStack.split(/\r?\n/).slice(0, 3).join(' <- ')}` : '';
  appendServerLog(`[${entry.op}] ${cleanTarget ? `${cleanTarget} -> ` : ''}${cleanMsg}${firstFrame}`);
  return entry;
}

if (typeof idx.getDbInitWarning === 'function' && idx.getDbInitWarning()) {
  recordAppError('SQLite Başlatma', idx.CACHE_ROOT, idx.getDbInitWarning());
}


function writeFatalCrashDump(kind, err) {
  const stack = err && err.stack ? err.stack : String(err);
  const report = [
    `LightDesktop Crash Report (${new Date().toISOString()})`,
    `Version: ${APP_VERSION} | Portable: ${process.env.LD_PORTABLE === '1' ? 'Yes' : 'No'}`,
    `Node: ${process.version} | Arch: ${process.arch} | OS: ${os.type()} ${os.release()}`,
    `Kind: ${kind}`,
    `CacheRoot: ${idx.CACHE_ROOT}`,
    `LogFile: ${LOG_FILE}`,
    `Error:`,
    stack,
  ].join('\n');
  appendServerLog(`${kind} (FATAL): ${stack}`);
  try { fs.writeFileSync(CRASH_DUMP_FILE, report, 'utf8'); } catch {}
  try { console.error(report); } catch {}
}


function buildDiagnosticsPayload() {
  let logsTail = '';
  try {
    if (fs.existsSync(LOG_FILE)) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      logsTail = content.split(/\r?\n/).slice(-150).join('\n').trim();
    }
  } catch {}
  return {
    appVersion: APP_VERSION,
    portable: process.env.LD_PORTABLE === '1',
    exePath: process.env.LD_EXE_PATH || '',
    uiHost: process.env.LD_UI_HOST || '',
    nodeVersion: process.version,
    arch: process.arch,
    osPlatform: `${os.type()} ${os.release()}`,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
    port: getActivePort(),
    cacheRoot: idx.CACHE_ROOT,
    logFile: LOG_FILE,
    crashDumpFile: fs.existsSync(CRASH_DUMP_FILE) ? CRASH_DUMP_FILE : '',
    ffmpegBin: typeof idx.getFfmpegBin === 'function' ? (idx.getFfmpegBin() || 'Windows Shell Fallback (0 MB)') : 'Bilinmiyor',
    dbInitWarning: typeof idx.getDbInitWarning === 'function' ? idx.getDbInitWarning() : '',
    totalErrors: errorHistory.length,
    unreadErrors,
    errors: errorHistory.slice(0, 100),
    logsTail,
  };
}

function getUnreadErrors() {
  return unreadErrors;
}

function resetUnreadErrors() {
  unreadErrors = 0;
}

function clearErrorHistory() {
  errorHistory.length = 0;
  unreadErrors = 0;
}

module.exports = {
  errorHistory,
  getUnreadErrors,
  resetUnreadErrors,
  clearErrorHistory,
  appendServerLog,
  recordAppError,
  writeFatalCrashDump,
  buildDiagnosticsPayload,
};
