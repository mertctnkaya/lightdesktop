import { state } from '../../store/appState.js';
import { $ } from '../../utils/dom.js';
import { api } from '../../services/apiClient.js';
import { getSelectedItems } from './selectionAndMarquee.js';
import { getLayoutMetrics, getThumbImgSrc, isMediaItem, thumbUrlFor, updateItemThumbInPlace } from './virtualScroller.js';
import { openQuickLook } from '../quicklook/quicklookViewer.js';

// ---------- HDD Korumalı Sıralı Kapak Resmi Yükleyicisi (Concurrency = 1) ----------
function cancelPendingThumbs() {
  if (state.thumbAbortCtrl) {
    state.thumbAbortCtrl.abort();
    state.thumbAbortCtrl = null;
  }
  state.thumbQueueRunning = false;
  $('btn-stop-thumbs').classList.add('hidden');
  api('/api/thumb/cancel', { method: 'POST', body: JSON.stringify({ session: String(state.thumbSessionId) }) }).catch(() => {});
}

function scheduleThumbBatch() {
  clearTimeout(state.viewportScrollTimer);
  state.viewportScrollTimer = setTimeout(() => {
    const mode = state.thumbMode;
    if (mode === 'off') return;

    let candidates = [];
    if (mode === 'selected') {
      candidates = getSelectedItems().filter(isMediaItem);
    } else if (mode === 'viewport') {
      const vp = $('virtual-viewport');
      const metrics = getLayoutMetrics();
      const startRow = Math.max(0, Math.floor(vp.scrollTop / metrics.rowHeight));
      const endRow = Math.ceil((vp.scrollTop + (vp.clientHeight || 600)) / metrics.rowHeight);
      const startIdx = startRow * metrics.cols;
      const endIdx = Math.min(state.viewItems.length - 1, (endRow + 1) * metrics.cols - 1);
      for (let i = startIdx; i <= endIdx; i++) {
        if (isMediaItem(state.viewItems[i])) candidates.push(state.viewItems[i]);
      }
    } else if (mode === 'all') {
      candidates = state.viewItems.filter(isMediaItem);
    }

    const toFetch = candidates.filter((it) => !getThumbImgSrc(it));
    if (toFetch.length > 0) runSequentialThumbFetch(toFetch);
  }, 180);
}

async function runSequentialThumbFetch(itemsList) {
  cancelPendingThumbs();
  const ctrl = new AbortController();
  state.thumbAbortCtrl = ctrl;
  state.thumbQueueRunning = true;
  const sessionAtStart = state.thumbSessionId;

  const stopBtn = $('btn-stop-thumbs');
  stopBtn.classList.remove('hidden');

  for (let i = 0; i < itemsList.length; i++) {
    if (ctrl.signal.aborted || state.thumbSessionId !== sessionAtStart) break;
    $('thumb-queue-count').textContent = `${i + 1}/${itemsList.length}`;
    const item = itemsList[i];
    const key = `${item.path}|${item.mtime}|${item.size}`;
    if (state.thumbBlobCache.has(key)) continue;

    try {
      const res = await fetch(thumbUrlFor(item), { signal: ctrl.signal });
      if (!res.ok) continue;
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      if (state.thumbBlobCache.size > 600) {
        const oldestKey = state.thumbBlobCache.keys().next().value;
        URL.revokeObjectURL(state.thumbBlobCache.get(oldestKey));
        state.thumbBlobCache.delete(oldestKey);
      }
      state.thumbBlobCache.set(key, objUrl);
      item.hasCachedThumb = true;
      updateItemThumbInPlace(item, objUrl);
    } catch (err) {
      if (err.name === 'AbortError') break;
    }
  }

  if (state.thumbAbortCtrl === ctrl) {
    state.thumbQueueRunning = false;
    stopBtn.classList.add('hidden');
  }
}

async function loadSingleThumb(item) {
  if (!isMediaItem(item)) return;
  openQuickLook(item);
  if (!getThumbImgSrc(item)) {
    runSequentialThumbFetch([item]);
  }
}


const storyboardUrlCache = new Map();
function setupHoverVideoStoryboard() {
  const content = $('virtual-content');
  if (!content) return;
  let activeCard = null;
  let hoverTimer = null;
  let autoPlayTimer = null;
  let scrubResumeTimer = null;
  let abortCtrl = null;
  let currentFrame = 0;

  const setStripFrame = (card, frameIdx) => {
    if (!card || !card.isConnected) return;
    const idx = Math.max(0, Math.min(4, frameIdx | 0));
    currentFrame = idx;
    const overlay = card.querySelector('.sb-scrub-overlay');
    const fill = card.querySelector('.sb-scrub-fill');
    if (overlay) overlay.style.backgroundPosition = `${idx * 25}% 0%`;
    if (fill) fill.style.width = `${((idx + 1) / 5) * 100}%`;
  };

  const startAutoPlay = (card) => {
    clearInterval(autoPlayTimer);
    autoPlayTimer = setInterval(() => {
      if (activeCard !== card || !card.isConnected) {
        clearInterval(autoPlayTimer);
        autoPlayTimer = null;
        return;
      }
      setStripFrame(card, (currentFrame + 1) % 5);
    }, 650);
  };

  const clearCardOverlay = (card) => {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    clearInterval(autoPlayTimer);
    autoPlayTimer = null;
    clearTimeout(scrubResumeTimer);
    scrubResumeTimer = null;
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    if (card) {
      card.querySelectorAll('.sb-scrub-overlay, .sb-scrub-bar').forEach((el) => el.remove());
    }
    activeCard = null;
  };

  const showLoadingBar = (previewEl) => {
    let bar = previewEl.querySelector('.sb-scrub-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'sb-scrub-bar loading';
      bar.innerHTML = '<div class="sb-scrub-fill"></div>';
      previewEl.appendChild(bar);
    } else {
      bar.classList.add('loading');
    }
    return bar;
  };

  const showStrip = (card, previewEl, url) => {
    if (!card || !card.isConnected || activeCard !== card) return;
    let overlay = previewEl.querySelector('.sb-scrub-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'sb-scrub-overlay';
      previewEl.appendChild(overlay);
    }
    overlay.style.backgroundImage = `url("${url}")`;
    let bar = previewEl.querySelector('.sb-scrub-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'sb-scrub-bar';
      bar.innerHTML = '<div class="sb-scrub-fill"></div>';
      previewEl.appendChild(bar);
    } else {
      bar.classList.remove('loading');
    }
    setStripFrame(card, 0);
    startAutoPlay(card);
  };

  content.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.grid-card[data-index]');
    if (!card || card === activeCard) return;
    const item = state.viewItems[Number(card.dataset.index)];
    if (!item || item.category !== 'video') {
      if (activeCard) clearCardOverlay(activeCard);
      return;
    }
    if (activeCard) clearCardOverlay(activeCard);
    activeCard = card;
    const previewEl = card.querySelector('.grid-preview');
    if (!previewEl) return;

    if (storyboardUrlCache.has(item.path)) {
      const cached = storyboardUrlCache.get(item.path);
      if (cached) {
        showStrip(card, previewEl, cached);
        return;
      }
      storyboardUrlCache.delete(item.path);
    }

    hoverTimer = setTimeout(async () => {
      if (activeCard !== card || !card.isConnected) return;
      const loadBar = showLoadingBar(previewEl);
      abortCtrl = new AbortController();
      try {
        const res = await fetch(`/api/storyboard?path=${encodeURIComponent(item.path)}`, { signal: abortCtrl.signal });
        if (res.status === 204 || !res.ok) {
          if (loadBar.isConnected) loadBar.remove();
          return;
        }
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        if (storyboardUrlCache.size > 120) {
          const oldestKey = storyboardUrlCache.keys().next().value;
          const oldUrl = storyboardUrlCache.get(oldestKey);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          storyboardUrlCache.delete(oldestKey);
        }
        storyboardUrlCache.set(item.path, objUrl);
        showStrip(card, previewEl, objUrl);
      } catch {
        if (loadBar.isConnected) loadBar.remove();
      }
    }, 350);
  });

  content.addEventListener('mousemove', (e) => {
    if (!activeCard) return;
    const overlay = activeCard.querySelector('.sb-scrub-overlay');
    const previewEl = activeCard.querySelector('.grid-preview');
    if (!overlay || !previewEl) return;
    clearInterval(autoPlayTimer);
    autoPlayTimer = null;
    clearTimeout(scrubResumeTimer);
    const rect = previewEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.999, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const frameIdx = Math.min(4, Math.floor(ratio * 5));
    setStripFrame(activeCard, frameIdx);
    const cardRef = activeCard;
    scrubResumeTimer = setTimeout(() => {
      if (activeCard === cardRef && cardRef.isConnected) startAutoPlay(cardRef);
    }, 1100);
  });

  content.addEventListener('mouseout', (e) => {
    if (!activeCard) return;
    if (e.relatedTarget && activeCard.contains(e.relatedTarget)) return;
    clearCardOverlay(activeCard);
  });
}


export {
  cancelPendingThumbs,
  loadSingleThumb,
  scheduleThumbBatch,
  setupHoverVideoStoryboard,
};
