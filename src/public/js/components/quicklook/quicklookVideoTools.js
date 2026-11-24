import { state } from '../../store/appState.js';
import { $ } from '../../utils/dom.js';
import { toast } from '../shared/toast.js';
import { api } from '../../services/apiClient.js';
import { getActiveTab, navigateTo } from '../navigation/tabsAndRouter.js';
import { formatTrimTime } from '../../utils/formatters.js';

function stepQuickLookVideoFrame(deltaFrames = 1) {
  const item = state.qlMediaItems[state.qlIndex];
  const vid = $('ql-stage')?.querySelector('video');
  if (!item || item.category !== 'video' || !vid) return;
  if (!vid.paused) vid.pause();
  const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 1e9;
  const frameSec = 1 / 30;
  vid.currentTime = Math.max(0, Math.min(dur, (vid.currentTime || 0) + deltaFrames * frameSec));
  if (!$('ql-trim-bar')?.classList.contains('hidden')) updateTrimPlayheadUi();
}

async function captureQuickLookFrame() {
  const item = state.qlMediaItems[state.qlIndex];
  const vid = $('ql-stage')?.querySelector('video');
  if (!item || !vid || vid.videoWidth <= 0 || vid.videoHeight <= 0) {
    return toast('Kare yakalamak için videonun yüklenmiş olması gerekir', 'error');
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = vid.videoWidth;
    canvas.height = vid.videoHeight;
    canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.94);
    const saveDir = state.settings.frameSaveMode === 'custom' ? (state.settings.frameSaveDir || '').trim() : '';
    const res = await api('/api/media/save-frame', {
      method: 'POST',
      body: JSON.stringify({ videoPath: item.path, dataUrl, saveDir, timeSec: vid.currentTime || 0 }),
    });
    toast(`📸 Kare kaydedildi: ${res.savedPath}`, 'success');
    const tab = getActiveTab();
    const savedParent = String(res.savedPath || '').replace(/\\[^\\]+$/, '').toLowerCase();
    if (tab && tab.path && tab.path.toLowerCase() === savedParent) {
      navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
  } catch (err) {
    toast(`Kare kaydedilemedi: ${err.message}`, 'error');
  }
}


function getTrimVideoDuration(vid) {
  if (vid && Number.isFinite(vid.duration) && vid.duration > 0) return vid.duration;
  return Math.max(10, Number($('ql-trim-end')?.value || 10));
}

function updateTrimPreviewBtnUi() {
  const btn = $('btn-ql-trim-preview');
  if (btn) btn.textContent = state.qlTrimPreviewLoop ? '⏸ Önizlemeyi Durdur' : '▶ Seçimi Oynat';
}

function updateTrimPlayheadUi() {
  const vid = $('ql-stage')?.querySelector('video');
  const head = $('ql-trim-playhead');
  if (!vid || !head) return;
  const dur = getTrimVideoDuration(vid);
  const pct = Math.max(0, Math.min(100, ((vid.currentTime || 0) / dur) * 100));
  head.style.left = `${pct}%`;
}

function updateTrimDurationUi() {
  const vid = $('ql-stage')?.querySelector('video');
  const dur = getTrimVideoDuration(vid);
  const s = Math.max(0, Math.min(dur, Number($('ql-trim-start')?.value || 0)));
  const e = Math.max(0, Math.min(dur, Number($('ql-trim-end')?.value || 0)));
  if ($('ql-trim-start-fmt')) $('ql-trim-start-fmt').textContent = formatTrimTime(s);
  if ($('ql-trim-end-fmt')) $('ql-trim-end-fmt').textContent = formatTrimTime(e);
  if ($('ql-trim-time-max')) $('ql-trim-time-max').textContent = formatTrimTime(dur);

  const pctA = Math.max(0, Math.min(100, (s / dur) * 100));
  const pctB = Math.max(0, Math.min(100, (e / dur) * 100));
  if ($('ql-trim-handle-a')) $('ql-trim-handle-a').style.left = `${pctA}%`;
  if ($('ql-trim-handle-b')) $('ql-trim-handle-b').style.left = `${pctB}%`;
  if ($('ql-trim-selection')) {
    $('ql-trim-selection').style.left = `${Math.min(pctA, pctB)}%`;
    $('ql-trim-selection').style.width = `${Math.max(0, pctB - pctA)}%`;
  }
  updateTrimPlayheadUi();

  const lbl = $('ql-trim-duration');
  if (!lbl) return;
  const diff = e - s;
  if (diff > 0.05) {
    lbl.classList.remove('invalid');
    lbl.textContent = `Seçili: ${formatTrimTime(diff)} (${diff.toFixed(1)} sn)`;
  } else {
    lbl.classList.add('invalid');
    lbl.textContent = 'Geçersiz aralık (B > A olmalı)';
  }
}

function toggleQuickLookTrimBar() {
  const bar = $('ql-trim-bar');
  const vid = $('ql-stage')?.querySelector('video');
  if (!bar || !vid) return;
  state.qlTrimPreviewLoop = false;
  updateTrimPreviewBtnUi();
  const willShow = bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !willShow);
  if (willShow) {
    const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : 10;
    const cur = Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
    const startVal = cur >= dur - 0.5 ? 0 : cur;
    $('ql-trim-start').value = startVal.toFixed(1);
    $('ql-trim-end').value = dur.toFixed(1);
    updateTrimDurationUi();
  }
}

async function runQuickLookTrim() {
  const item = state.qlMediaItems[state.qlIndex];
  const btn = $('btn-ql-trim-run');
  if (!item) return;
  const startSec = Number($('ql-trim-start')?.value || 0);
  const endSec = Number($('ql-trim-end')?.value || 0);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec + 0.1) {
    return toast('Geçerli bir kırpma aralığı seçin (Bitiş > Başlangıç)', 'error');
  }
  if (btn) btn.disabled = true;
  try {
    const saveDir = state.settings.trimSaveMode === 'custom' ? (state.settings.trimSaveDir || '').trim() : '';
    const res = await api('/api/media/trim-video', {
      method: 'POST',
      body: JSON.stringify({ path: item.path, startSec, endSec, saveDir }),
    });
    toast(`✂️ Kayıpsız kırpıldı: ${res.savedPath}`, 'success');
    const tab = getActiveTab();
    const outParent = String(res.savedPath || '').replace(/\\[^\\]+$/, '').toLowerCase();
    if (tab && tab.path && tab.path.toLowerCase() === outParent) {
      navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}


export {
  captureQuickLookFrame,
  getTrimVideoDuration,
  runQuickLookTrim,
  stepQuickLookVideoFrame,
  toggleQuickLookTrimBar,
  updateTrimDurationUi,
  updateTrimPlayheadUi,
  updateTrimPreviewBtnUi,
};
