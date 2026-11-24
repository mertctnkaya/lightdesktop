'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const idx = require('../../indexer-and-thumbs');
const { markDirMutated, markDirsMutated, makeUniquePath } = require('./mutationTracker');
const { releaseOpenStreamsForPaths } = require('./streamRegistry');
const { restoreFromRecycleBin, sendPathsToRecycleBin, listRecycleBin } = require('./recycleBinService');
const { recordAppError } = require('./loggerService');

const undoStack = [];
const MAX_UNDO_STACK = 50;

function pushUndoEntry(entry) {
  if (!entry || !entry.type) return null;
  if (Array.isArray(entry.refreshDirs)) markDirsMutated(entry.refreshDirs);
  const normalized = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    time: Date.now(),
    ...entry,
  };
  undoStack.push(normalized);
  if (undoStack.length > MAX_UNDO_STACK) undoStack.shift();
  return normalized;
}

function getUndoSummary() {
  const top = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
  return {
    count: undoStack.length,
    canUndo: undoStack.length > 0,
    topLabel: top ? top.label : '',
    topType: top ? top.type : '',
  };
}


async function movePathSafe(srcPath, destPath) {
  const src = path.resolve(srcPath);
  const destDir = path.dirname(destPath);
  await fsp.mkdir(destDir, { recursive: true });
  const target = fs.existsSync(destPath) ? makeUniquePath(destPath) : destPath;
  const sameRoot = path.parse(src).root.toLowerCase() === path.parse(target).root.toLowerCase();
  if (sameRoot) {
    await fsp.rename(src, target);
    idx.removeIndexedPath(src);
    return target;
  }
  const st = await fsp.stat(src);
  const { collectFilesRecursive, copyFileStreamSafe, computeQuickFileHash } = require('./transferEngine');
  if (st.isDirectory()) {
    const plan = await collectFilesRecursive(src);
    for (const relDir of plan.dirs) {
      const relSub = relDir.split(path.sep).slice(1).join(path.sep);
      const subTarget = relSub ? path.join(target, relSub) : target;
      await fsp.mkdir(subTarget, { recursive: true });
    }
    for (const f of plan.files) {
      const relFile = f.rel.split(path.sep).slice(1).join(path.sep);
      const fTarget = path.join(target, relFile);
      await fsp.mkdir(path.dirname(fTarget), { recursive: true });
      await copyFileStreamSafe(f.src, fTarget, { doneBytes: 0, cancelled: false });
      const [h1, h2] = await Promise.all([
        computeQuickFileHash(f.src, f.size),
        computeQuickFileHash(fTarget, f.size),
      ]);
      if (h1 !== h2) {
        await fsp.unlink(fTarget).catch(() => {});
        throw new Error('Geri alma taşıma doğrulama hatası');
      }
      await fsp.unlink(f.src);
      idx.removeIndexedPath(f.src);
    }
    await fsp.rm(src, { recursive: true, force: true });
    return target;
  }
  await copyFileStreamSafe(src, target, { doneBytes: 0, cancelled: false });
  const [h1, h2] = await Promise.all([
    computeQuickFileHash(src, st.size),
    computeQuickFileHash(target, st.size),
  ]);
  if (h1 !== h2) {
    await fsp.unlink(target).catch(() => {});
    throw new Error('Geri alma taşıma doğrulama hatası');
  }
  await fsp.unlink(src);
  idx.removeIndexedPath(src);
  return target;
}

async function performUndo() {
  const entry = undoStack.pop();
  if (!entry) {
    return { ok: false, empty: true, message: 'Geri alınacak işlem yok', undoSummary: getUndoSummary() };
  }

  let undoneCount = 0;
  const errors = [];
  const refreshDirs = new Set(entry.refreshDirs || []);

  try {
    if (entry.type === 'rename' || entry.type === 'move') {
      const pairs = [...(entry.items || [])].reverse();
      for (const pair of pairs) {
        try {
          if (!fs.existsSync(pair.to)) {
            throw new Error(`Öğe bulunamadı: ${pair.to}`);
          }
          const restoredTo = await movePathSafe(pair.to, pair.from);
          refreshDirs.add(path.dirname(restoredTo));
          refreshDirs.add(path.dirname(pair.to));
          undoneCount++;
        } catch (err) {
          errors.push({ path: pair.to, message: err.message });
          recordAppError('Geri Al', pair.to, err.message);
        }
      }
      if (Array.isArray(entry.cleanupEmptyDirs)) {
        const sortedDirs = [...entry.cleanupEmptyDirs].sort((a, b) => b.length - a.length);
        for (const d of sortedDirs) {
          try {
            const left = await fsp.readdir(d);
            if (left.length === 0) await fsp.rmdir(d);
          } catch {}
        }
      }
    } else if (entry.type === 'mkdir') {
      for (const item of entry.items || []) {
        try {
          if (!fs.existsSync(item.path)) continue;
          const children = await fsp.readdir(item.path);
          if (children.length === 0) {
            await fsp.rmdir(item.path);
          } else {
            await sendPathsToRecycleBin([item.path]);
          }
          refreshDirs.add(path.dirname(item.path));
          undoneCount++;
        } catch (err) {
          errors.push({ path: item.path, message: err.message });
          recordAppError('Geri Al (Klasör)', item.path, err.message);
        }
      }
    } else if (entry.type === 'copy') {
      const targets = (entry.items || []).map((x) => x.to).filter((p) => fs.existsSync(p));
      if (targets.length > 0) {
        const res = await sendPathsToRecycleBin(targets);
        undoneCount += res.okList.length;
        for (const e of res.errList) errors.push(e);
      }
      if (Array.isArray(entry.cleanupEmptyDirs)) {
        const sortedDirs = [...entry.cleanupEmptyDirs].sort((a, b) => b.length - a.length);
        for (const d of sortedDirs) {
          try {
            const left = await fsp.readdir(d);
            if (left.length === 0) await fsp.rmdir(d);
          } catch {}
        }
      }
    } else if (entry.type === 'trash') {
      const bin = await listRecycleBin();
      const usedRPaths = new Set();
      const toRestore = [];
      for (const item of entry.items || []) {
        const normOrig = path.resolve(item.origPath).toLowerCase();
        const match = bin.items.find(
          (b) => !usedRPaths.has(b.path) && path.resolve(b.origPath).toLowerCase() === normOrig
        );
        if (match) {
          usedRPaths.add(match.path);
          toRestore.push(match.path);
        } else {
          errors.push({ path: item.origPath, message: 'Çöp kutusunda bulunamadı' });
        }
      }
      if (toRestore.length > 0) {
        const res = await restoreFromRecycleBin(toRestore, { recordUndo: false });
        undoneCount += res.restored.length;
        for (const r of res.restored) refreshDirs.add(path.dirname(r.targetPath));
        for (const e of res.errors) errors.push(e);
      }
    } else if (entry.type === 'restore') {
      const existing = (entry.items || []).map((x) => x.path).filter((p) => fs.existsSync(p));
      if (existing.length > 0) {
        const res = await sendPathsToRecycleBin(existing);
        undoneCount += res.okList.length;
        for (const p of res.okList) refreshDirs.add(path.dirname(p));
        for (const e of res.errList) errors.push(e);
      }
    }
  } catch (err) {
    errors.push({ path: '', message: err.message });
    recordAppError('Geri Al', entry.label || '', err.message);
  }

  return {
    ok: errors.length === 0 || undoneCount > 0,
    label: entry.label,
    type: entry.type,
    undoneCount,
    errors,
    refreshDirs: Array.from(refreshDirs),
    undoSummary: getUndoSummary(),
  };
}


module.exports = {
  undoStack,
  pushUndoEntry,
  getUndoSummary,
  movePathSafe,
  performUndo,
};
