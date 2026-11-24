import { $, esc } from '../../utils/dom.js';
import { state } from '../../store/appState.js';
import { recordRecentFile } from '../../services/preferencesService.js';
import { formatBytes, formatDate } from '../../utils/formatters.js';
import { api } from '../../services/apiClient.js';
import { updateTrimDurationUi, updateTrimPlayheadUi, updateTrimPreviewBtnUi } from './quicklookVideoTools.js';
import { isPdfPreviewable, isTextPreviewable, renderQuickLookTextEditor } from './quicklookTextTools.js';
import { openExternally } from '../operations/fileActions.js';
import { openRelatedDialog } from './relatedFinderModal.js';
import { renderBasket } from '../operations/basketAndDualPane.js';
import { toast } from '../shared/toast.js';
import { showPromptModal } from '../shared/promptModal.js';
import { renderVirtualList } from '../scroller/virtualScroller.js';
import { updateStatusCounts, updateToolbarButtons } from '../scroller/selectionAndMarquee.js';
import { getActiveTab, navigateTo, updateTrashBadge, updateUndoButton } from '../navigation/tabsAndRouter.js';

// ---------- Space QuickLook Medya Önizleyici (Fotoğraf & Video Yakınlaştırma) ----------
function applyQuickLookTransform() {
  const media = $('ql-stage').querySelector('img, video');
  const stage = $('ql-stage');
  $('btn-ql-zoom-reset').textContent = `${Math.round(state.qlZoom * 100)}%`;
  const brRange = $('ql-brightness-range');
  const brReset = $('btn-ql-bright-reset');
  if (brRange && Number(brRange.value) !== state.qlBrightness) brRange.value = String(state.qlBrightness);
  if (brReset) brReset.textContent = `${state.qlBrightness}%`;
  stage.classList.toggle('zoomed', state.qlZoom > 1.01);
  if (!media) return;
  media.style.transform = `translate3d(${state.qlPanX}px, ${state.qlPanY}px, 0) scale(${state.qlZoom})`;
  media.style.filter = state.qlBrightness === 100 ? '' : `brightness(${state.qlBrightness / 100})`;
}

function setQuickLookBrightness(nextVal) {
  const clamped = Math.max(30, Math.min(200, Math.round(Number(nextVal) || 100)));
  state.qlBrightness = clamped;
  try { localStorage.setItem('ld_media_brightness', String(clamped)); } catch {}
  applyQuickLookTransform();
}

function setQuickLookZoom(nextZoom) {
  const clamped = Math.max(1, Math.min(8, Number(nextZoom.toFixed(2))));
  state.qlZoom = clamped;
  if (clamped <= 1.01) {
    state.qlZoom = 1;
    state.qlPanX = 0;
    state.qlPanY = 0;
  }
  applyQuickLookTransform();
}

function openQuickLook(item, customList = null) {
  if (!item || item.isDir) return;
  if (!item.inTrash) recordRecentFile(item);
  const source = customList || state.viewItems;
  const mediaList = customList
    ? source.filter((it) => !it.isDir)
    : source.filter((it) => !it.isDir && (it.category === 'image' || it.category === 'video' || it.category === 'audio' || isPdfPreviewable(it) || isTextPreviewable(it)));
  state.qlMediaItems = mediaList;
  state.qlIndex = mediaList.findIndex((m) => m.path === item.path);
  renderQuickLookStage(item);
  $('quicklook-dialog').showModal();
}

function updateQuickLookBasketBadge(item) {
  const inBasket = Boolean(item && state.basket.has(item.path));
  const btn = $('btn-ql-basket');
  if (btn) {
    btn.classList.toggle('in-basket', inBasket);
    btn.innerHTML = inBasket ? '🧺 Sepette ✓' : '🧺 Sepete (B)';
  }
  const badge = $('ql-basket-badge');
  if (badge) badge.classList.toggle('hidden', !inBasket);
}

function renderQuickLookStage(item) {
  state.qlZoom = 1;
  state.qlPanX = 0;
  state.qlPanY = 0;
  updateQuickLookBasketBadge(item);
  $('ql-filename').textContent = item.name;
  const posText = state.qlIndex >= 0 ? `  •  [${state.qlIndex + 1} / ${state.qlMediaItems.length}]` : '';
  $('ql-meta').textContent = `${formatBytes(item.size)}  •  ${formatDate(item.mtime)}  •  ${item.path}${posText}`;
  const atStart = state.qlIndex <= 0;
  const atEnd = state.qlIndex < 0 || state.qlIndex >= state.qlMediaItems.length - 1;
  $('btn-ql-prev').disabled = atStart;
  $('btn-ql-next').disabled = atEnd;
  const stPrev = $('btn-ql-stage-prev');
  const stNext = $('btn-ql-stage-next');
  if (stPrev) stPrev.disabled = atStart;
  if (stNext) stNext.disabled = atEnd;
  const stage = $('ql-stage');
  const url = `/api/media?path=${encodeURIComponent(item.path)}`;
  const framePrevBtn = $('btn-ql-frame-prev');
  const frameNextBtn = $('btn-ql-frame-next');
  const capBtn = $('btn-ql-capture');
  const trimToggleBtn = $('btn-ql-trim-toggle');
  const trimBar = $('ql-trim-bar');
  if (framePrevBtn) framePrevBtn.classList.toggle('hidden', item.category !== 'video');
  if (frameNextBtn) frameNextBtn.classList.toggle('hidden', item.category !== 'video');
  if (capBtn) capBtn.classList.toggle('hidden', item.category !== 'video');
  if (trimToggleBtn) trimToggleBtn.classList.toggle('hidden', item.category !== 'video');
  if (trimBar) trimBar.classList.add('hidden');

  const isPdf = isPdfPreviewable(item);
  const isText = isTextPreviewable(item);
  stage.classList.toggle('ql-stage-doc', isPdf || isText);

  if (item.category === 'image') {
    stage.innerHTML = `<img src="${url}" alt="${esc(item.name)}" draggable="false" />`;
  } else if (item.category === 'video' || item.category === 'audio') {
    let savedAudio = { muted: false, volume: 1 };
    try {
      const raw = JSON.parse(localStorage.getItem('ld_media_audio') || 'null');
      if (raw && typeof raw === 'object') {
        savedAudio.muted = Boolean(raw.muted);
        if (typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1) savedAudio.volume = raw.volume;
      }
    } catch {}
    const tag = item.category === 'video' ? 'video' : 'audio';
    const extraAttr = item.category === 'audio' ? ' style="width:80%"' : '';
    const autoAttr = state.settings.videoAutoplay !== false ? ' autoplay' : '';
    const loopAttr = state.settings.videoLoop ? ' loop' : '';
    stage.innerHTML = `<${tag} src="${url}" controls${autoAttr}${loopAttr} preload="metadata"${savedAudio.muted ? ' muted' : ''}${extraAttr}></${tag}>`;
    const mediaEl = stage.querySelector(tag);
    if (mediaEl) {
      mediaEl.muted = savedAudio.muted;
      mediaEl.volume = savedAudio.volume;
      mediaEl.addEventListener('volumechange', () => {
        if (!mediaEl.getAttribute('src')) return;
        try {
          localStorage.setItem('ld_media_audio', JSON.stringify({
            muted: Boolean(mediaEl.muted),
            volume: Number.isFinite(mediaEl.volume) ? mediaEl.volume : 1,
          }));
        } catch {}
      });
      if (item.category === 'video') {
        state.qlTrimPreviewLoop = false;
        updateTrimPreviewBtnUi();
        mediaEl.addEventListener('loadedmetadata', () => {
          if (!$('ql-trim-bar')?.classList.contains('hidden')) updateTrimDurationUi();
        });
        mediaEl.addEventListener('timeupdate', () => {
          if (state.qlTrimPreviewLoop) {
            const endSec = Number($('ql-trim-end')?.value || 0);
            if (endSec > 0 && mediaEl.currentTime >= endSec) {
              mediaEl.pause();
              mediaEl.currentTime = endSec;
              state.qlTrimPreviewLoop = false;
              updateTrimPreviewBtnUi();
            }
          }
          if (!$('ql-trim-bar')?.classList.contains('hidden')) updateTrimPlayheadUi();
        });
        mediaEl.addEventListener('pause', () => {
          if (state.qlTrimPreviewLoop) {
            state.qlTrimPreviewLoop = false;
            updateTrimPreviewBtnUi();
          }
        });
      }
    }
  } else if (isPdf) {
    stage.innerHTML = `<iframe class="ql-pdf-frame" src="${url}#view=FitH" title="${esc(item.name)}"></iframe>`;
  } else if (isText) {
    renderQuickLookTextEditor(stage, item);
  } else {
    stage.innerHTML = `<div class="empty-state">Bu dosya türü için hızlı önizleme yok.<br><br>Varsayılan uygulamada açmak için sağ üstteki butonu kullanabilirsiniz.</div>`;
  }
  applyQuickLookTransform();
  $('btn-ql-open-ext').onclick = () => openExternally(item.path);
  const revBtn = $('btn-ql-reveal');
  if (revBtn) revBtn.onclick = () => revealInExplorer(item.path);
  const relQlBtn = $('btn-ql-related');
  if (relQlBtn) relQlBtn.onclick = () => openRelatedDialog(item);
}


function releaseQuickLookMedia() {
  const stage = $('ql-stage');
  if (!stage) return;
  for (const m of stage.querySelectorAll('video, audio')) {
    try {
      m.pause();
      m.removeAttribute('src');
      m.load();
    } catch {}
  }
  stage.innerHTML = '';
}

function closeQuickLook() {
  releaseQuickLookMedia();
  $('quicklook-dialog').close();
}

function triageQuickLookBasket() {
  const item = state.qlMediaItems[state.qlIndex];
  if (!item) return;
  if (state.basket.has(item.path)) {
    state.basket.delete(item.path);
    renderBasket();
    updateQuickLookBasketBadge(item);
    toast(`${item.name} sepetten çıkarıldı`);
    return;
  }
  state.basket.set(item.path, item);
  renderBasket();
  toast(`${item.name} sepete eklendi`);
  if (state.qlIndex < state.qlMediaItems.length - 1) {
    state.qlIndex++;
    renderQuickLookStage(state.qlMediaItems[state.qlIndex]);
  } else {
    updateQuickLookBasketBadge(item);
  }
}

async function triageQuickLookDelete(permanent = false) {
  const item = state.qlMediaItems[state.qlIndex];
  if (!item) return;
  if (permanent) {
    const ok = await showPromptModal({
      title: 'Kalıcı Olarak Sil',
      desc: `${item.name} KALICI OLARAK silinecek!`,
      okText: 'Kalıcı Sil',
    });
    if (!ok) return;
  }

  // Açık video/ses akışını anında serbest bırak ki dosya kilidi bekletmesin
  releaseQuickLookMedia();

  // İyimser (optimistic) arayüz güncellemesi: Kullanıcıyı bekletmeden hemen sonraki medyaya geç
  state.rawItems = state.rawItems.filter((x) => x.path !== item.path);
  state.viewItems = state.viewItems.filter((x) => x.path !== item.path);
  state.selectedPaths.delete(item.path);
  state.basket.delete(item.path);
  state.qlMediaItems.splice(state.qlIndex, 1);

  renderBasket();
  renderVirtualList();
  updateStatusCounts();
  updateToolbarButtons();

  if (state.qlMediaItems.length === 0) {
    $('quicklook-dialog').close();
  } else {
    state.qlIndex = Math.min(state.qlIndex, state.qlMediaItems.length - 1);
    renderQuickLookStage(state.qlMediaItems[state.qlIndex]);
  }

  toast(`${item.name} ${permanent ? 'kalıcı siliniyor...' : 'çöpe atıldı (Ctrl+Z)'}`, 'success');

  api('/api/fs/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'delete', paths: [item.path], permanent, immediate: true }),
  }).then((res) => {
    if (res.undoSummary) updateUndoButton(res.undoSummary);
    if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
  }).catch((err) => {
    toast(`Silinemedi (${item.name}): ${err.message}`, 'error');
    const tab = getActiveTab();
    if (tab && tab.path !== 'PC' && tab.path !== 'TRASH') {
      navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
  });
}


export {
  applyQuickLookTransform,
  closeQuickLook,
  openQuickLook,
  releaseQuickLookMedia,
  renderQuickLookStage,
  setQuickLookBrightness,
  setQuickLookZoom,
  triageQuickLookBasket,
  triageQuickLookDelete,
  updateQuickLookBasketBadge,
};
