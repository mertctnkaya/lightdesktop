import { $, esc } from '../../utils/dom.js';
import { state } from '../../store/appState.js';
import { api } from '../../services/apiClient.js';
import { ICONS } from '../../constants/uiConstants.js';
import { formatBytes, formatDate, formatDisplayName } from '../../utils/formatters.js';

// ---------- 60 FPS Virtual Scroller ----------
function getLayoutMetrics() {
  const vp = $('virtual-viewport');
  const width = Math.max(300, vp.clientWidth - 18);
  const vm = state.viewMode;
  if (vm === 'dense') {
    return { mode: 'list', dense: true, cols: 1, rowHeight: 25 };
  }
  if (vm === 'compact') {
    return { mode: 'compact', cols: 3, rowHeight: 32 };
  }
  if (vm === 'tiles') {
    const cols = Math.max(1, Math.floor(width / 270));
    return { mode: 'tiles', cols, rowHeight: 64 };
  }
  if (vm === 'grid-sm') {
    return { mode: 'grid', sizeClass: 'grid-sm', cols: Math.max(2, Math.floor(width / 128)), rowHeight: 136 };
  }
  if (vm === 'grid') {
    return { mode: 'grid', sizeClass: 'grid-md', cols: Math.max(2, Math.floor(width / 172)), rowHeight: 186 };
  }
  if (vm === 'grid-lg') {
    return { mode: 'grid', sizeClass: 'grid-lg', cols: Math.max(2, Math.floor(width / 235)), rowHeight: 238 };
  }
  if (vm === 'grid-xl') {
    return { mode: 'grid', sizeClass: 'grid-xl', cols: Math.max(1, Math.floor(width / 305)), rowHeight: 288 };
  }
  return { mode: 'list', dense: false, cols: 1, rowHeight: 34 };
}

function thumbUrlFor(item) {
  return `/api/thumb?path=${encodeURIComponent(item.path)}&mtime=${item.mtime}&size=${item.size}&session=${state.thumbSessionId}`;
}

function isMediaItem(item) {
  return !item.isDir && (item.category === 'image' || item.category === 'video');
}

function getThumbImgSrc(item) {
  const key = `${item.path}|${item.mtime}|${item.size}`;
  if (state.thumbBlobCache.has(key)) {
    return state.thumbBlobCache.get(key);
  }
  if (item.hasCachedThumb) {
    return thumbUrlFor(item);
  }
  return null;
}


function renderVirtualList() {
  const items = state.viewItems;
  const vp = $('virtual-viewport');
  const spacer = $('virtual-spacer');
  const content = $('virtual-content');

  const metrics = getLayoutMetrics();
  $('list-header').classList.toggle('hidden', metrics.mode !== 'list');
  $('empty-state').classList.toggle('hidden', items.length > 0);

  const totalRows = Math.ceil(items.length / metrics.cols);
  spacer.style.height = `${totalRows * metrics.rowHeight}px`;

  if (items.length === 0) {
    content.innerHTML = '';
    return;
  }

  const scrollTop = vp.scrollTop;
  const viewHeight = vp.clientHeight || 600;
  const overscan = 4;
  const startRow = Math.max(0, Math.floor(scrollTop / metrics.rowHeight) - overscan);
  const endRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewHeight) / metrics.rowHeight) + overscan);

  content.style.transform = `translate3d(0, ${startRow * metrics.rowHeight}px, 0)`;

  const frag = document.createDocumentFragment();

  for (let r = startRow; r <= endRow; r++) {
    if (metrics.mode === 'list') {
      const idx = r;
      const item = items[idx];
      const row = document.createElement('div');
      const isSel = state.selectedPaths.has(item.path);
      const isCut = state.clipboard.op === 'cut' && state.clipboard.paths.includes(item.path);
      row.className = `file-row ${metrics.dense ? 'dense' : ''} ${isSel ? 'selected' : ''} ${isCut ? 'cut-dim' : ''}`;
      row.dataset.index = idx;
      row.draggable = !item.inTrash;

      const media = !item.inTrash && isMediaItem(item);
      const thumbSrc = media ? getThumbImgSrc(item) : null;
      const iconHtml = thumbSrc
        ? `<img class="fr-thumb" src="${thumbSrc}" loading="lazy" alt="" />`
        : `<span class="fr-icon">${ICONS[item.category] || ICONS.other}</span>`;
      const origDirHtml = (item.inTrash && item.origDir)
        ? `<span class="fr-orig-dir muted-text" title="Özgün Konum: ${esc(item.origPath || item.origDir)}">${esc(item.origDir)}</span>`
        : ((state.relatedCtx && state.relatedCtx.scope !== 'folder' && item.parentDir)
          ? `<span class="fr-orig-dir muted-text" title="${esc(item.parentDir)}">${esc(item.parentDir)}</span>`
          : '');

      const isBasket = state.basket.has(item.path);
      const basketInline = isBasket ? '<span class="basket-inline-badge" title="Sepette">🧺<span class="basket-check">✓</span></span>' : '';
      const dispName = formatDisplayName(item);

      row.innerHTML = `
        <div class="fr-chk"><input type="checkbox" ${isSel ? 'checked' : ''} /></div>
        <div class="fr-name" title="${esc(item.origPath || item.path)}">${iconHtml}<span class="fr-text">${esc(dispName)}</span>${basketInline}${origDirHtml}</div>
        <div class="fr-date">${formatDate(item.mtime)}</div>
        <div class="fr-type">${item.isDir ? 'Dosya klasörü' : esc((item.ext || '').toUpperCase().replace('.', '') || 'Dosya')}</div>
        <div class="fr-size">${item.isDir ? ((item.sizeCalculated || item.size > 0) ? formatBytes(item.size) : '') : formatBytes(item.size)}</div>
        <div class="fr-eye">${media ? `<button class="eye-btn ${thumbSrc ? 'loaded' : ''}" title="Bu dosyanın kapağını yükle / önizle">👁️</button>` : ''}</div>
      `;
      frag.appendChild(row);
    } else if (metrics.mode === 'compact') {
      const wrap = document.createElement('div');
      wrap.className = 'compact-row-wrap';
      for (let c = 0; c < metrics.cols; c++) {
        const idx = r * metrics.cols + c;
        if (idx >= items.length) break;
        const item = items[idx];
        const isSel = state.selectedPaths.has(item.path);
        const isBasket = state.basket.has(item.path);
        const showDirSize = item.isDir && (item.sizeCalculated || item.size > 0);
        const cell = document.createElement('div');
        cell.className = `compact-cell ${isSel ? 'selected' : ''}`;
        cell.dataset.index = idx;
        cell.draggable = true;
        cell.title = showDirSize ? `${item.name} (${formatBytes(item.size)})` : item.name;
        cell.innerHTML = `<span>${ICONS[item.category] || ICONS.other}</span><span class="fr-text">${esc(formatDisplayName(item))}</span>${isBasket ? '<span class="basket-inline-badge" title="Sepette">🧺<span class="basket-check">✓</span></span>' : ''}${showDirSize ? `<span class="compact-size">${formatBytes(item.size)}</span>` : ''}`;
        wrap.appendChild(cell);
      }
      frag.appendChild(wrap);
    } else if (metrics.mode === 'tiles') {
      const wrap = document.createElement('div');
      wrap.className = 'tiles-row-wrap';
      wrap.style.gridTemplateColumns = `repeat(${metrics.cols}, minmax(0, 1fr))`;
      for (let c = 0; c < metrics.cols; c++) {
        const idx = r * metrics.cols + c;
        if (idx >= items.length) break;
        const item = items[idx];
        const isSel = state.selectedPaths.has(item.path);
        const isBasket = state.basket.has(item.path);
        const media = isMediaItem(item);
        const thumbSrc = media ? getThumbImgSrc(item) : null;
        const typeText = item.isDir
          ? ((item.sizeCalculated || item.size > 0) ? `Klasör • ${formatBytes(item.size)}` : 'Klasör')
          : `${(item.ext || '').toUpperCase().replace('.', '') || 'Dosya'} • ${formatBytes(item.size)}`;
        const tile = document.createElement('div');
        tile.className = `tile-card ${isSel ? 'selected' : ''}`;
        tile.dataset.index = idx;
        tile.draggable = true;
        tile.title = item.path;
        tile.innerHTML = `
          <div class="tile-thumb-box">${thumbSrc ? `<img src="${thumbSrc}" alt="" />` : `<span>${ICONS[item.category] || ICONS.other}</span>`}${isBasket ? '<span class="basket-thumb-badge small" title="Sepette">🧺<span class="basket-check">✓</span></span>' : ''}</div>
          <div class="tile-info">
            <div class="tile-name">${esc(formatDisplayName(item))}</div>
            <div class="tile-meta">${esc(typeText)}</div>
          </div>
          ${media ? `<button class="eye-btn tile-eye ${thumbSrc ? 'loaded' : ''}" title="Kapak Yükle">👁️</button>` : ''}
        `;
        wrap.appendChild(tile);
      }
      frag.appendChild(wrap);
    } else {
      const wrap = document.createElement('div');
      wrap.className = `grid-row-wrap ${metrics.sizeClass || 'grid-md'}`;
      wrap.style.gridTemplateColumns = `repeat(${metrics.cols}, minmax(0, 1fr))`;
      for (let c = 0; c < metrics.cols; c++) {
        const idx = r * metrics.cols + c;
        if (idx >= items.length) break;
        const item = items[idx];
        const isSel = state.selectedPaths.has(item.path);
        const isBasket = state.basket.has(item.path);
        const media = isMediaItem(item);
        const thumbSrc = media ? getThumbImgSrc(item) : null;
        const showDirSize = item.isDir && (item.sizeCalculated || item.size > 0);
        const dirSizeText = showDirSize ? formatBytes(item.size) : 'Klasör';
        const card = document.createElement('div');
        card.className = `grid-card ${isSel ? 'selected' : ''}`;
        card.dataset.index = idx;
        card.draggable = true;
        card.title = `${item.name}\n${item.isDir ? dirSizeText : formatBytes(item.size)}`;
        const extraMeta = metrics.sizeClass === 'grid-xl'
          ? `<div class="grid-meta">${item.isDir ? dirSizeText : formatBytes(item.size)} • ${formatDate(item.mtime)}</div>`
          : '';
        card.innerHTML = `
          <input type="checkbox" class="grid-card-chk" ${isSel ? 'checked' : ''} />
          ${media ? `<button class="eye-btn grid-card-eye ${thumbSrc ? 'loaded' : ''}" title="Kapak Yükle">👁️</button>` : ''}
          <div class="grid-preview">${thumbSrc ? `<img src="${thumbSrc}" alt="" />` : `<span>${ICONS[item.category] || ICONS.other}</span>`}${isBasket ? '<span class="basket-thumb-badge" title="Sepette">🧺<span class="basket-check">✓</span></span>' : ''}${showDirSize ? `<span class="grid-size-badge">${formatBytes(item.size)}</span>` : ''}</div>
          <div class="grid-name">${esc(formatDisplayName(item))}</div>
          ${extraMeta}
        `;
        wrap.appendChild(card);
      }
      frag.appendChild(wrap);
    }
  }

  content.innerHTML = '';
  content.appendChild(frag);
}

function updateSelectionDomInPlace() {
  const nodes = $('virtual-content').querySelectorAll('[data-index]');
  for (const el of nodes) {
    const idx = Number(el.dataset.index);
    const item = state.viewItems[idx];
    if (!item) continue;
    const isSel = state.selectedPaths.has(item.path);
    const isCut = state.clipboard.op === 'cut' && state.clipboard.paths.includes(item.path);
    el.classList.toggle('selected', isSel);
    el.classList.toggle('cut-dim', isCut);
    const chk = el.querySelector('input[type="checkbox"]');
    if (chk) chk.checked = isSel;
  }
}

function updateItemThumbInPlace(item, thumbUrl) {
  const nodes = $('virtual-content').querySelectorAll('[data-index]');
  for (const el of nodes) {
    const idx = Number(el.dataset.index);
    const rowItem = state.viewItems[idx];
    if (!rowItem || rowItem.path !== item.path) continue;
    const eye = el.querySelector('.eye-btn');
    if (eye) eye.classList.add('loaded');
    if (state.viewMode === 'list' || state.viewMode === 'dense') {
      const nameWrap = el.querySelector('.fr-name');
      if (nameWrap) {
        const iconEl = nameWrap.querySelector('.fr-icon, .fr-thumb');
        if (iconEl) {
          const img = document.createElement('img');
          img.className = 'fr-thumb';
          img.src = thumbUrl;
          img.alt = '';
          iconEl.replaceWith(img);
        }
      }
    } else if (state.viewMode === 'tiles') {
      const box = el.querySelector('.tile-thumb-box');
      if (box) box.innerHTML = `<img src="${thumbUrl}" alt="" />`;
    } else if (state.viewMode.startsWith('grid')) {
      const preview = el.querySelector('.grid-preview');
      if (preview) {
        preview.innerHTML = `<img src="${thumbUrl}" alt="" />`;
      }
    }
  }
}


function setupViewportResizeObserver() {
  const vp = $('virtual-viewport');
  if (!vp) return;
  let lastW = vp.clientWidth;
  let raf = 0;
  const onChange = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ev = $('explorer-view');
      if (!ev || ev.classList.contains('hidden')) return;
      const w = vp.clientWidth;
      if (w <= 0 || Math.abs(w - lastW) < 2) return;
      lastW = w;
      try { renderVirtualList(); } catch (e) { console.warn(e); }
    });
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onChange).observe(vp);
  window.addEventListener('resize', onChange);
}


export {
  getLayoutMetrics,
  getThumbImgSrc,
  isMediaItem,
  renderVirtualList,
  setupViewportResizeObserver,
  thumbUrlFor,
  updateItemThumbInPlace,
  updateSelectionDomInPlace,
};
