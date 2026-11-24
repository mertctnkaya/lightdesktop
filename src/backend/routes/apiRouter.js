'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFile } = require('node:child_process');
const idx = require('../../indexer-and-thumbs');
const {
  APP_VERSION,
  SERVER_DIR,
  BOUNDS_FILE,
  LOG_FILE,
  START_TIME,
  getActivePort,
} = require('../config/constants');
const { getBackendCodeMtimeMs, START_CODE_MTIME } = require('../utils/codeMtime');
const { sendJson, pipeFileStream, readJsonBody, streamMedia } = require('../utils/httpHelpers');
const {
  errorHistory,
  getUnreadErrors,
  resetUnreadErrors,
  clearErrorHistory,
  recordAppError,
  buildDiagnosticsPayload,
} = require('../services/loggerService');
const { markDirMutated, getLastMutationFor, makeUniquePath } = require('../services/mutationTracker');
const {
  listRecycleBin,
  restoreFromRecycleBin,
  deleteFromRecycleBin,
  emptyRecycleBin,
  getLastKnownTrashCount,
} = require('../services/recycleBinService');
const { getUndoSummary, performUndo } = require('../services/undoService');
const { setOsFileClipboard, getOsFileClipboard } = require('../services/clipboardService');
const {
  getDrives,
  getQuickAccessFolders,
  listDirectory,
  listSubdirs,
  getItemsProperties,
} = require('../services/drivesAndFsService');
const { transferState, createTransferJob, processTransferQueue } = require('../services/transferEngine');
const { handleFsAction } = require('../services/fsActionsService');
const { getSystemIntegrationStatus, applySystemIntegration } = require('../services/windowsIntegrationService');
const {
  getVaultSummary,
  saveVaultConfig,
  listVaultItems,
  restoreVaultEntries,
  purgeVaultEntries,
} = require('../services/protectedVaultService');
const { listZipEntries, extractZipEntries, createZipArchive } = require('../services/zipService');
const {
  addOrToggleWatchPath,
  clearActivityLogs,
  compressActivityLogsNow,
  getActivityConfigAndStats,
  queryActivityLogs,
  saveActivityConfig,
} = require('../services/activityWatcherService');

let activePropsToken = null;

async function handleApiRoute(req, res, url, pathname) {
    if (pathname === '/api/health' && req.method === 'GET') {
      const scanInfo = idx.getScanProgress();
      const indexStats = idx.getIndexStats();
      const hasActiveJob = transferState.jobs.some((j) => j.status === 'running' || j.status === 'queued');
      return sendJson(res, 200, {
        ok: true,
        appVersion: APP_VERSION,
        portable: process.env.LD_PORTABLE === '1',
        pid: process.pid,
        port: getActivePort(),
        serverDir: SERVER_DIR,
        startedAt: START_TIME,
        startCodeMtimeMs: START_CODE_MTIME,
        currentCodeMtimeMs: getBackendCodeMtimeMs(),
        busy: Boolean(hasActiveJob || indexStats.running || (scanInfo.activeCount || 0) > 0),
      });
    }

    if (pathname === '/api/diagnostics' && req.method === 'GET') {
      return sendJson(res, 200, buildDiagnosticsPayload());
    }

    if (pathname === '/api/system/integration' && req.method === 'GET') {
      return sendJson(res, 200, await getSystemIntegrationStatus());
    }

    if (pathname === '/api/system/integration' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await applySystemIntegration(body));
    }

    if (pathname === '/api/init' && req.method === 'GET') {
      const drives = await getDrives(url.searchParams.get('refresh') === '1');
      let trashCount = getLastKnownTrashCount();
      if (trashCount === null) {
        trashCount = 0;
        listRecycleBin().catch(() => {});
      }
      return sendJson(res, 200, {
        drives,
        quickAccess: getQuickAccessFolders(),
        pins: idx.getPins(),
        indexStats: idx.getIndexStats(),
        undoSummary: getUndoSummary(),
        trashCount,
      });
    }

    if (pathname === '/api/window-bounds' && req.method === 'GET') {
      try {
        const raw = await fsp.readFile(BOUNDS_FILE, 'utf8');
        return sendJson(res, 200, JSON.parse(raw));
      } catch {
        return sendJson(res, 200, {});
      }
    }

    if (pathname === '/api/window-bounds' && req.method === 'POST') {
      const b = await readJsonBody(req);
      if (b && Number(b.width) >= 400 && Number(b.height) >= 300) {
        const clean = {
          x: Math.round(Number(b.x) || 0),
          y: Math.round(Number(b.y) || 0),
          width: Math.round(Number(b.width)),
          height: Math.round(Number(b.height)),
        };
        await fsp.writeFile(BOUNDS_FILE, JSON.stringify(clean), 'utf8');
        return sendJson(res, 200, { ok: true, bounds: clean });
      }
      return sendJson(res, 400, { error: 'Geçersiz pencere boyutu' });
    }

    if (pathname === '/api/list' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path');
      if (!dirPath) return sendJson(res, 400, { error: 'path parametresi gerekli' });
      const forceRefresh = url.searchParams.get('refresh') === '1';
      const data = await listDirectory(dirPath, forceRefresh);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/subdirs' && req.method === 'GET') {
      const dirPath = url.searchParams.get('path');
      if (!dirPath) return sendJson(res, 400, { error: 'path parametresi gerekli' });
      const data = await listSubdirs(dirPath);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/thumb' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      const mtime = Number(url.searchParams.get('mtime') || 0);
      const size = Number(url.searchParams.get('size') || 0);
      const session = url.searchParams.get('session') || 'default';
      if (!filePath) return sendJson(res, 400, { error: 'path gerekli' });
      try {
        const thumbPath = await idx.getOrCreateThumbnail(filePath, mtime, size, session);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000' });
        pipeFileStream(req, res, thumbPath);
      } catch (err) {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(err.cancelled ? 499 : 404);
          res.end();
        }
      }
      return;
    }

    if (pathname === '/api/thumb/cancel' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const cancelled = idx.cancelThumbQueue(body.session || null);
      return sendJson(res, 200, { ok: true, cancelled });
    }

    if (pathname === '/api/media' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return sendJson(res, 400, { error: 'path gerekli' });
      return streamMedia(req, res, filePath);
    }

    if (pathname === '/api/search' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await idx.searchFiles(body);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/related' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await idx.findRelatedFiles(body);
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/clipboard/os' && req.method === 'GET') {
      const clipData = await getOsFileClipboard();
      return sendJson(res, 200, clipData);
    }

    if (pathname === '/api/clipboard/os' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const resData = await setOsFileClipboard(body.op, body.paths);
      return sendJson(res, 200, resData);
    }

    if (pathname === '/api/fs/upload-external' && req.method === 'POST') {
      const destDir = url.searchParams.get('destDir');
      const rawName = path.basename(url.searchParams.get('name') || '');
      if (!destDir || !rawName) return sendJson(res, 400, { error: 'destDir ve name gerekli' });
      const resolvedDir = path.resolve(destDir);
      const destPath = makeUniquePath(path.join(resolvedDir, rawName));
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(destPath);
        req.on('error', (err) => { ws.destroy(); reject(err); });
        ws.on('error', reject);
        ws.on('finish', resolve);
        req.pipe(ws);
      });
      markDirMutated(resolvedDir);
      return sendJson(res, 200, { ok: true, path: destPath });
    }

    if (pathname === '/api/storyboard' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return sendJson(res, 400, { error: 'path gerekli' });
      try {
        const sb = await idx.getOrCreateVideoStoryboard(filePath);
        if (!sb || !sb.available || !sb.filePath) {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
        pipeFileStream(req, res, sb.filePath);
      } catch {
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(204);
          res.end();
        }
      }
      return;
    }

    if (pathname === '/api/media/save-frame' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const videoPath = body.videoPath ? path.resolve(String(body.videoPath)) : '';
      const dataUrl = String(body.dataUrl || '');
      const m = /^data:image\/(jpeg|jpg|png);base64,(.+)$/i.exec(dataUrl);
      if (!videoPath || !m) return sendJson(res, 400, { error: 'Geçersiz kare verisi' });
      let destDir = path.dirname(videoPath);
      if (body.saveDir && String(body.saveDir).trim()) {
        const candDir = path.resolve(String(body.saveDir).trim());
        await fsp.mkdir(candDir, { recursive: true });
        destDir = candDir;
      }
      const stem = path.parse(videoPath).name;
      const secs = Math.max(0, Math.floor(Number(body.timeSec) || 0));
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      const ext = m[1].toLowerCase() === 'png' ? '.png' : '.jpg';
      const target = makeUniquePath(path.join(destDir, `${stem}_kare_${mm}m${ss}s${ext}`));
      await fsp.writeFile(target, Buffer.from(m[2], 'base64'));
      markDirMutated(destDir);
      return sendJson(res, 200, { ok: true, savedPath: target });
    }

    if (pathname === '/api/media/trim-video' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const srcPath = body.path ? path.resolve(String(body.path)) : '';
      const startSec = Number(body.startSec);
      const endSec = Number(body.endSec);
      if (!srcPath || !fs.existsSync(srcPath)) return sendJson(res, 404, { error: 'Video dosyası bulunamadı' });
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec + 0.1 || startSec < 0) {
        return sendJson(res, 400, { error: 'Geçersiz kırpma aralığı (Bitiş > Başlangıç olmalı)' });
      }
      const ffmpegBin = idx.getFfmpegBin();
      if (!ffmpegBin) {
        return sendJson(res, 400, { error: 'Kayıpsız video kırpmak için sistemde FFmpeg (C:\\ffmpeg\\bin\\ffmpeg.exe veya PATH) bulunamadı.' });
      }
      const pInfo = path.parse(srcPath);
      let destDir = pInfo.dir;
      if (body.saveDir && String(body.saveDir).trim()) {
        const candDir = path.resolve(String(body.saveDir).trim());
        await fsp.mkdir(candDir, { recursive: true });
        destDir = candDir;
      }
      const outPath = makeUniquePath(path.join(destDir, `${pInfo.name}_kirpildi${pInfo.ext || '.mp4'}`));
      await new Promise((resolve, reject) => {
        execFile(
          ffmpegBin,
          ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', startSec.toFixed(2), '-to', endSec.toFixed(2), '-i', srcPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outPath],
          { timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, _stdout, stderr) => {
            if (err) {
              try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
              return reject(new Error(String(stderr || err.message || 'Video kırpılamadı').trim()));
            }
            resolve();
          }
        );
      });
      markDirMutated(destDir);
      return sendJson(res, 200, { ok: true, savedPath: outPath });
    }

    if (pathname === '/api/smart-view' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = idx.querySmartView(body.criteria || {});
      return sendJson(res, 200, { ok: true, ...data });
    }

    if (pathname === '/api/analyze' && req.method === 'GET') {
      const targetPath = url.searchParams.get('path');
      const mode = url.searchParams.get('mode') || 'auto';
      if (!targetPath) return sendJson(res, 400, { error: 'path gerekli' });
      if (mode !== 'live') {
        const hit = idx.getAnalysisCache('analyze', targetPath, getLastMutationFor(targetPath));
        if (hit && hit.data) {
          return sendJson(res, 200, {
            ...hit.data,
            fromCache: true,
            cachedAt: hit.cachedAt,
            stale: hit.stale,
            staleReason: hit.staleReason,
          });
        }
      }
      let result = null;
      if (mode === 'cached') {
        result = idx.analyzeFromCache(targetPath);
      } else if (mode !== 'live') {
        const sqliteCached = idx.analyzeFromCache(targetPath);
        if (sqliteCached.totalFiles > 0) result = sqliteCached;
      }
      if (!result) {
        result = await idx.analyzeLive(targetPath);
      }
      if (result && !result.cancelled && result.totalFiles > 0) {
        idx.setAnalysisCache('analyze', targetPath, result);
      }
      return sendJson(res, 200, { ...result, fromCache: false, cachedAt: Date.now(), stale: false, staleReason: '' });
    }

    if (pathname === '/api/folder-sizes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      if (!body.force && body.parentDir) {
        const hit = idx.getAnalysisCache('folder_sizes', body.parentDir, getLastMutationFor(body.parentDir));
        if (hit && hit.data && hit.data.sizes) {
          const allMatched = paths.every((p) => Object.prototype.hasOwnProperty.call(hit.data.sizes, p));
          if (allMatched) {
            return sendJson(res, 200, {
              ...hit.data,
              fromCache: true,
              cachedAt: hit.cachedAt,
              stale: hit.stale,
              staleReason: hit.staleReason,
            });
          }
        }
      }
      const data = await idx.calculateFolderSizes(body.parentDir, paths);
      if (res.writableEnded || res.destroyed) return;
      if (data && !data.cancelled && body.parentDir) {
        idx.setAnalysisCache('folder_sizes', body.parentDir, data);
      }
      return sendJson(res, 200, { ...data, fromCache: false, cachedAt: Date.now(), stale: false, staleReason: '' });
    }

    if (pathname === '/api/folder-sizes/cancel' && req.method === 'POST') {
      return sendJson(res, 200, idx.cancelFolderSizes());
    }

    if (pathname === '/api/duplicates' && req.method === 'GET') {
      const targetPath = url.searchParams.get('path');
      const force = url.searchParams.get('force') === '1';
      const protectDev = url.searchParams.get('protectDev') !== '0';
      const cacheKind = protectDev ? 'duplicates_devsafe' : 'duplicates_all';
      if (!targetPath) return sendJson(res, 400, { error: 'path gerekli' });
      if (!force) {
        const hit = idx.getAnalysisCache(cacheKind, targetPath, getLastMutationFor(targetPath));
        if (hit && hit.data) {
          return sendJson(res, 200, {
            ...hit.data,
            fromCache: true,
            cachedAt: hit.cachedAt,
            stale: hit.stale,
            staleReason: hit.staleReason,
          });
        }
      }
      const data = await idx.findDuplicates(targetPath, { protectDevProjects: protectDev });
      if (data && !data.cancelled) {
        idx.setAnalysisCache(cacheKind, targetPath, data);
      }
      return sendJson(res, 200, { ...data, fromCache: false, cachedAt: Date.now(), stale: false, staleReason: '' });
    }

    if (pathname === '/api/index/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.path) return sendJson(res, 400, { error: 'path gerekli' });
      return sendJson(res, 200, await idx.startBackgroundIndex(body.path));
    }

    if (pathname === '/api/index/stop' && req.method === 'POST') {
      return sendJson(res, 200, idx.stopBackgroundIndex());
    }

    if (pathname === '/api/index/status' && req.method === 'GET') {
      return sendJson(res, 200, idx.getIndexStats());
    }

    if (pathname === '/api/pins' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const pins = body.remove ? idx.removePin(body.path) : idx.addPin(body.path, body.name);
      return sendJson(res, 200, { ok: true, pins });
    }

    if (pathname === '/api/fs/action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await handleFsAction(body);
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/transfer/enqueue' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const job = createTransferJob({
        op: body.op === 'move' ? 'move' : 'copy',
        sources: body.sources || [],
        destDir: body.destDir,
        conflict: body.conflict || 'rename',
      });
      processTransferQueue();
      return sendJson(res, 200, { ok: true, job });
    }

    if (pathname === '/api/transfer/status' && req.method === 'GET') {
      const scanInfo = idx.getScanProgress();
      return sendJson(res, 200, {
        paused: transferState.paused,
        jobs: transferState.jobs.slice(-15),
        scan: scanInfo,
        scans: scanInfo.scans || [],
        index: idx.getIndexStats(),
        undoSummary: getUndoSummary(),
        trashCount: getLastKnownTrashCount(),
        errorSummary: {
          total: errorHistory.length,
          unread: getUnreadErrors(),
        },
      });
    }

    if (pathname === '/api/trash/list' && req.method === 'GET') {
      const data = await listRecycleBin();
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/trash/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await restoreFromRecycleBin(Array.isArray(body.paths) ? body.paths : []);
      return sendJson(res, 200, { ...data, undoSummary: getUndoSummary(), trashCount: getLastKnownTrashCount() });
    }

    if (pathname === '/api/trash/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const data = await deleteFromRecycleBin(Array.isArray(body.paths) ? body.paths : []);
      return sendJson(res, 200, { ...data, trashCount: getLastKnownTrashCount() });
    }

    if (pathname === '/api/trash/empty' && req.method === 'POST') {
      const data = await emptyRecycleBin();
      return sendJson(res, 200, { ...data, trashCount: 0 });
    }

    if (pathname === '/api/undo' && req.method === 'POST') {
      const data = await performUndo();
      return sendJson(res, 200, { ...data, trashCount: getLastKnownTrashCount() });
    }

    if (pathname === '/api/fs/properties' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (activePropsToken) activePropsToken.aborted = true;
      const token = { aborted: false };
      activePropsToken = token;
      const data = await getItemsProperties(Array.isArray(body.paths) ? body.paths : [], token);
      if (activePropsToken === token) activePropsToken = null;
      return sendJson(res, 200, data);
    }

    if (pathname === '/api/fs/properties/cancel' && req.method === 'POST') {
      if (activePropsToken) activePropsToken.aborted = true;
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/errors' && req.method === 'GET') {
      if (url.searchParams.get('markRead') === '1') {
        resetUnreadErrors();
      }
      let logsTail = '';
      try {
        if (fs.existsSync(LOG_FILE)) {
          const content = fs.readFileSync(LOG_FILE, 'utf8');
          const lines = content.split(/\r?\n/);
          logsTail = lines.slice(-150).join('\n').trim();
        }
      } catch {}
      return sendJson(res, 200, {
        errors: errorHistory,
        unread: getUnreadErrors(),
        logsTail,
        logFile: LOG_FILE,
      });
    }

    if (pathname === '/api/errors' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'clear') {
        clearErrorHistory();
        return sendJson(res, 200, { ok: true });
      }
      if (body.action === 'openLogFile') {
        if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');
        await handleFsAction({ action: 'open', path: LOG_FILE });
        return sendJson(res, 200, { ok: true });
      }
      if (body.action === 'report') {
        const entry = recordAppError(body.op || 'Arayüz', body.target || '', body.message, {
          stack: body.stack || '',
          meta: body.meta || undefined,
        });
        return sendJson(res, 200, { ok: true, entry, total: errorHistory.length, unread: getUnreadErrors() });
      }
      return sendJson(res, 400, { error: 'Geçersiz hata eylemi' });
    }

    if (pathname === '/api/transfer/control' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const target = body.target || 'job';

      if (target === 'scan') {
        const scan = idx.controlScanProgress(body.action, body.scanId || body.id || null);
        return sendJson(res, 200, { ok: true, scan });
      }
      if (target === 'index') {
        const index = idx.controlBackgroundIndex(body.action);
        return sendJson(res, 200, { ok: true, index });
      }

      if (body.action === 'pause') {
        transferState.paused = true;
        if (transferState.activeJob && transferState.activeJob._pauseFlagFile) {
          await fsp.writeFile(transferState.activeJob._pauseFlagFile, '1', 'utf8').catch(() => {});
        }
      } else if (body.action === 'resume') {
        transferState.paused = false;
        if (transferState.activeJob && transferState.activeJob._pauseFlagFile) {
          await fsp.unlink(transferState.activeJob._pauseFlagFile).catch(() => {});
        }
      } else if (body.action === 'cancel') {
        const j = body.jobId
          ? transferState.jobs.find((x) => x.id === body.jobId)
          : transferState.activeJob;
        if (j) {
          j.cancelled = true;
          if (j.status === 'queued') j.status = 'cancelled';
          if (j === transferState.activeJob) transferState.paused = false;
          if (j._pauseFlagFile) await fsp.unlink(j._pauseFlagFile).catch(() => {});
          if (j._proc) {
            if (j._proc.pid) {
              execFile('taskkill', ['/PID', String(j._proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
            }
            try { j._proc.kill('SIGKILL'); } catch {}
          }
        }
        if (!transferState.jobs.some((x) => x.status === 'running' || x.status === 'queued')) {
          transferState.paused = false;
        }
      } else if (body.action === 'clearFinished') {
        transferState.jobs = transferState.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
      }
      return sendJson(res, 200, { ok: true, paused: transferState.paused });
    }

    if (pathname === '/api/zip/list' && req.method === 'GET') {
      const zipPath = url.searchParams.get('path');
      if (!zipPath) return sendJson(res, 400, { error: 'path gerekli' });
      return sendJson(res, 200, await listZipEntries(zipPath));
    }

    if (pathname === '/api/zip/extract' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.zipPath || !body.destDir) return sendJson(res, 400, { error: 'zipPath ve destDir gerekli' });
      return sendJson(res, 200, await extractZipEntries(body.zipPath, body.destDir, body.entries || null));
    }

    if (pathname === '/api/zip/compress' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.paths) || body.paths.length === 0 || !body.destZipPath) {
        return sendJson(res, 400, { error: 'paths ve destZipPath gerekli' });
      }
      return sendJson(res, 200, await createZipArchive(body.paths, body.destZipPath));
    }

    if (pathname === '/api/file/text' && req.method === 'GET') {
      const target = url.searchParams.get('path');
      if (!target) return sendJson(res, 400, { error: 'path gerekli' });
      const resolved = path.resolve(target);
      const st = await fsp.stat(resolved);
      if (!st.isFile()) return sendJson(res, 400, { error: 'Dosya bulunamadı' });
      const MAX_EDIT_BYTES = 2 * 1024 * 1024;
      const PREVIEW_BYTES = 512 * 1024;
      if (st.size <= MAX_EDIT_BYTES) {
        const content = await fsp.readFile(resolved, 'utf8');
        return sendJson(res, 200, {
          path: resolved,
          size: st.size,
          mtime: Math.floor(st.mtimeMs),
          content,
          truncated: false,
          editable: true,
        });
      }
      const fh = await fsp.open(resolved, 'r');
      let content = '';
      try {
        const buf = Buffer.alloc(PREVIEW_BYTES);
        const { bytesRead } = await fh.read(buf, 0, PREVIEW_BYTES, 0);
        content = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
      return sendJson(res, 200, {
        path: resolved,
        size: st.size,
        mtime: Math.floor(st.mtimeMs),
        content,
        truncated: true,
        editable: false,
      });
    }

    if (pathname === '/api/file/text' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.path || typeof body.content !== 'string') {
        return sendJson(res, 400, { error: 'path ve content gerekli' });
      }
      const resolved = path.resolve(body.path);
      await fsp.writeFile(resolved, body.content, 'utf8');
      markDirMutated(path.dirname(resolved));
      return sendJson(res, 200, { ok: true, path: resolved, size: Buffer.byteLength(body.content, 'utf8') });
    }

    if (pathname === '/api/vault/config' && req.method === 'GET') {
      return sendJson(res, 200, getVaultSummary());
    }

    if (pathname === '/api/vault/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      saveVaultConfig(body.protectedPaths || []);
      return sendJson(res, 200, { ok: true, ...getVaultSummary() });
    }

    if (pathname === '/api/vault/items' && req.method === 'GET') {
      const items = await listVaultItems();
      return sendJson(res, 200, { items, ...getVaultSummary() });
    }

    if (pathname === '/api/vault/restore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await restoreVaultEntries(body.ids || []));
    }

    if (pathname === '/api/vault/purge' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await purgeVaultEntries(body.ids || [], Boolean(body.all)));
    }

    if (pathname === '/api/activity/config' && req.method === 'GET') {
      return sendJson(res, 200, getActivityConfigAndStats());
    }

    if (pathname === '/api/activity/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, saveActivityConfig(body));
    }

    if (pathname === '/api/activity/watch/add' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, addOrToggleWatchPath(body.path, body));
    }

    if (pathname === '/api/activity/logs' && req.method === 'GET') {
      return sendJson(
        res,
        200,
        queryActivityLogs({
          q: url.searchParams.get('q') || '',
          event: url.searchParams.get('event') || 'ALL',
          watchRoot: url.searchParams.get('watchRoot') || '',
          file: url.searchParams.get('file') || '',
          limit: url.searchParams.get('limit') || 400,
        })
      );
    }

    if (pathname === '/api/activity/compress' && req.method === 'POST') {
      return sendJson(res, 200, compressActivityLogsNow());
    }

    if (pathname === '/api/activity/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, clearActivityLogs(body));
    }

    if (pathname === '/api/startup-profile' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const marks = Array.isArray(body.marks) ? body.marks : [];
      if (marks.length > 0) {
        const baseMs = Number(process.env.LD_START_EPOCH_MS) || START_TIME;
        const profFile = path.join(path.dirname(LOG_FILE), 'startup-profile.txt');
        let prev = Number(marks[0].epochMs) || baseMs;
        const lines = marks.map((m, i) => {
          const ep = Number(m.epochMs) || baseMs;
          const total = Math.max(0, ep - baseMs);
          const delta = i === 0 ? 0 : Math.max(0, ep - prev);
          prev = ep;
          const detail = m.detail ? ` (${m.detail})` : '';
          return `  +${String(total).padStart(5)} ms  (d +${String(delta).padStart(4)} ms)  [UI]   ${m.stage || ''}${detail}`;
        });
        lines.push('==============================================================================');
        await fsp.appendFile(profFile, lines.join('\n') + '\n', 'utf8').catch(() => {});
      }
      return sendJson(res, 200, { ok: true });
    }

  return false;
}

module.exports = {
  handleApiRoute,
};
