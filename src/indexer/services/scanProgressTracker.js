'use strict';

const { sleep } = require('../core/categoryClassifier');

// ---------- Canlı Tarama İlerleme Takibi (Çoklu Eşzamanlı: Analiz, Boyut, Kopya Bulucu) ----------
let scanSeq = 0;
const scanTasks = new Map();

function startScanProgress(type, title, total = 0, targetPath = '') {
  const id = 'scan_' + (++scanSeq);
  const task = {
    id,
    active: true,
    status: 'running',
    paused: false,
    cancelled: false,
    type,
    targetPath: targetPath || '',
    title,
    currentItem: '',
    currentDetail: '',
    done: 0,
    total,
    startedAt: Date.now(),
    finishedAt: 0,
    itemsPerSec: 0,
    recentLog: [],
  };
  scanTasks.set(id, task);
  if (scanTasks.size > 20) {
    for (const [k, v] of scanTasks.entries()) {
      if (!v.active) {
        scanTasks.delete(k);
        break;
      }
    }
  }
  return id;
}

async function waitScanIfPaused(scanId) {
  const t = scanTasks.get(scanId);
  if (!t) return true;
  while (t.active && t.paused && !t.cancelled) {
    await sleep(150);
  }
  return !t.active || t.cancelled;
}

function controlScanProgress(action, scanId = null) {
  const all = Array.from(scanTasks.values());
  let targets = [];
  if (scanId) {
    const byId = scanTasks.get(scanId);
    if (byId) targets = [byId];
    else targets = all.filter((x) => x.active && x.type === scanId);
  } else {
    const activeList = all.filter((x) => x.active);
    if (activeList.length > 0) targets = [activeList[activeList.length - 1]];
  }

  for (const t of targets) {
    if (!t.active) continue;
    if (action === 'pause') t.paused = true;
    else if (action === 'resume') t.paused = false;
    else if (action === 'cancel') {
      t.cancelled = true;
      t.paused = false;
      t.active = false;
      t.status = 'cancelled';
      t.finishedAt = Date.now();
      t.currentItem = 'İptal edildi';
    }
  }
  return getScanProgress();
}

function updateScanProgress(scanId, item, detail = '', done = null, total = null) {
  const t = scanTasks.get(scanId);
  if (!t || !t.active) return;
  if (done !== null) t.done = done;
  if (total !== null) t.total = total;
  t.currentItem = item || '';
  t.currentDetail = detail || '';
  const elapsedSec = Math.max(0.15, (Date.now() - t.startedAt) / 1000);
  t.itemsPerSec = Number((t.done / elapsedSec).toFixed(1));
  if (item) {
    t.recentLog.push({ file: item, detail, status: 'info', time: Date.now() });
    if (t.recentLog.length > 50) t.recentLog.shift();
  }
}

function finishScanProgress(scanId, cancelled = false) {
  const t = scanTasks.get(scanId);
  if (!t) return;
  const isCancelled = Boolean(cancelled || t.cancelled);
  t.active = false;
  t.paused = false;
  t.cancelled = isCancelled;
  t.status = isCancelled ? 'cancelled' : 'completed';
  if (!isCancelled && t.total > 0) t.done = t.total;
  t.finishedAt = Date.now();
  t.currentItem = isCancelled ? 'İptal edildi' : 'İşlem tamamlandı';
}

function getScanProgress() {
  const scans = Array.from(scanTasks.values()).map((t) => ({
    ...t,
    recentLog: t.recentLog.slice(),
  }));
  const activeScans = scans.filter((t) => t.active);
  const primary = activeScans[activeScans.length - 1] || scans[scans.length - 1] || {
    active: false,
    paused: false,
    cancelled: false,
    id: null,
    type: '',
    targetPath: '',
    title: '',
    currentItem: '',
    currentDetail: '',
    done: 0,
    total: 0,
    startedAt: 0,
    finishedAt: 0,
    itemsPerSec: 0,
    recentLog: [],
  };
  return {
    ...primary,
    scans,
    activeScans,
  };
}


module.exports = {
  scanTasks,
  startScanProgress,
  waitScanIfPaused,
  controlScanProgress,
  updateScanProgress,
  finishScanProgress,
  getScanProgress,
};
