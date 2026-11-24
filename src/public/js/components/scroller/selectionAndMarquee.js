import { state } from '../../store/appState.js';
import { getLayoutMetrics, renderVirtualList, updateSelectionDomInPlace } from './virtualScroller.js';
import { scheduleThumbBatch } from './thumbLoaderAndStoryboard.js';
import { $ } from '../../utils/dom.js';
import { formatBytes } from '../../utils/formatters.js';
import { getActiveTab } from '../navigation/tabsAndRouter.js';
import { updateBasketActionButtons } from '../operations/basketAndDualPane.js';
import { updateQuickLookBasketBadge } from '../quicklook/quicklookViewer.js';

// ---------- Seçim & Etkileşim ----------
function applyListSelection(items, selectedSet, lastIdx, index, e) {
  const item = items[index];
  if (!item) return lastIdx;
  if (e.shiftKey && lastIdx >= 0) {
    const start = Math.min(lastIdx, index);
    const end = Math.max(lastIdx, index);
    if (!e.ctrlKey) selectedSet.clear();
    for (let i = start; i <= end; i++) {
      selectedSet.add(items[i].path);
    }
    return lastIdx;
  }
  if (e.ctrlKey || (e.target && e.target.type === 'checkbox')) {
    if (selectedSet.has(item.path)) selectedSet.delete(item.path);
    else selectedSet.add(item.path);
    return index;
  }
  selectedSet.clear();
  selectedSet.add(item.path);
  return index;
}

function handleItemSelect(index, e) {
  state.lastClickedIndex = applyListSelection(state.viewItems, state.selectedPaths, state.lastClickedIndex, index, e);

  updateSelectionDomInPlace();
  updateStatusCounts();
  updateToolbarButtons();

  if (state.thumbMode === 'selected') {
    scheduleThumbBatch();
  }
}

function updateDualSelectionDomInPlace() {
  const listEl = $('dual-list');
  if (!listEl) return;
  const rows = listEl.querySelectorAll('.dual-row[data-index]');
  for (const el of rows) {
    const item = state.dualItems[Number(el.dataset.index)];
    if (!item) continue;
    const isSel = state.dualSelectedPaths.has(item.path);
    const isCut = state.clipboard.op === 'cut' && state.clipboard.paths.includes(item.path);
    el.classList.toggle('selected', isSel);
    el.classList.toggle('cut-dim', isCut);
  }
}

function handleDualItemSelect(index, e) {
  state.dualLastClickedIdx = applyListSelection(state.dualItems, state.dualSelectedPaths, state.dualLastClickedIdx, index, e);
  updateDualSelectionDomInPlace();
}

function getDualSelectedItems() {
  return state.dualItems.filter((it) => state.dualSelectedPaths.has(it.path));
}

function getSelectedItems() {
  return state.viewItems.filter((it) => state.selectedPaths.has(it.path));
}

function updateStatusCounts() {
  $('status-count').textContent = `${state.viewItems.length} öğe`;
  const sel = getSelectedItems();
  let selBytes = 0;
  for (const s of sel) selBytes += s.size || 0;
  $('status-selected').textContent = sel.length > 0 ? `${sel.length} seçili (${formatBytes(selBytes)})` : '0 seçili';
  $('chk-select-all').checked = state.viewItems.length > 0 && sel.length === state.viewItems.length;
}

function updateToolbarButtons() {
  const tab = getActiveTab();
  const isTrash = tab && tab.path === 'TRASH';
  const inFolder = tab && tab.path !== 'PC' && !isTrash;
  const hasSel = state.selectedPaths.size > 0;
  const hasClip = state.clipboard.paths.length > 0;

  $('btn-mkdir').disabled = !inFolder;
  $('btn-pin').disabled = !inFolder;
  $('btn-cut').disabled = !inFolder || !hasSel;
  $('btn-copy').disabled = !inFolder || !hasSel;
  $('btn-paste').disabled = !inFolder;
  $('btn-rename').disabled = !inFolder || !hasSel;
  $('btn-delete').disabled = !(tab && tab.path !== 'PC' && hasSel);
  const propsBtn = $('btn-properties');
  if (propsBtn) propsBtn.disabled = !inFolder;
  const relBtn = $('btn-find-related');
  if (relBtn) {
    const selList = inFolder && state.selectedPaths.size === 1 ? getSelectedItems() : [];
    relBtn.disabled = !(selList.length === 1 && !selList[0].isDir);
  }

  const restoreBtn = $('btn-trash-restore');
  const permBtn = $('btn-trash-perm-delete');
  const emptyBtn = $('btn-trash-empty');
  if (restoreBtn) restoreBtn.disabled = !isTrash || !hasSel;
  if (permBtn) permBtn.disabled = !isTrash || !hasSel;
  if (emptyBtn) emptyBtn.disabled = !isTrash || state.rawItems.length === 0;
  updateBasketActionButtons();
  if ($('explorer-view') && !$('explorer-view').classList.contains('hidden')) {
    renderVirtualList();
  }
  if ($('quicklook-dialog')?.open && state.qlMediaItems[state.qlIndex]) {
    updateQuickLookBasketBadge(state.qlMediaItems[state.qlIndex]);
  }
}


// ---------- Windows 11 Mavi Seçim Kutusu (Marquee Selection) ----------
function isDragFileHandle(target, rowEl) {
  if (!rowEl) return false;
  if (rowEl.classList.contains('selected')) return true;
  return Boolean(target.closest('.fr-icon, .fr-thumb, .fr-text, .tile-thumb-box, .tile-name, .grid-preview img, .grid-preview span, .grid-name, .compact-cell span, .dual-row-icon, .dual-row-name'));
}

function attachRubberBandController(cfg) {
  const { container, rowSelector, getBox, canStart, isDragHandle, getBaseSelection, onBeforeStart, onSelectionBox } = cfg;
  if (!container) return;
  let active = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let lastClientX = 0;
  let lastClientY = 0;
  let baseSelection = new Set();
  let autoScrollTimer = null;

  const updateBoxAndSelection = () => {
    const box = getBox();
    const rect = container.getBoundingClientRect();
    const curX = Math.max(0, Math.min(container.clientWidth, lastClientX - rect.left));
    const curY = Math.max(0, Math.min(container.scrollHeight, lastClientY - rect.top + container.scrollTop));

    const bounds = {
      left: Math.min(startX, curX),
      right: Math.max(startX, curX),
      top: Math.min(startY, curY),
      bottom: Math.max(startY, curY),
    };

    box.style.left = `${bounds.left}px`;
    box.style.top = `${bounds.top}px`;
    box.style.width = `${bounds.right - bounds.left}px`;
    box.style.height = `${bounds.bottom - bounds.top}px`;

    onSelectionBox(bounds, baseSelection);
  };

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (canStart && !canStart(e)) return;
    if (e.clientX > container.getBoundingClientRect().left + container.clientWidth) return;

    const rowEl = e.target.closest(rowSelector);
    if (!e.altKey && isDragHandle(e.target, rowEl)) {
      if (rowEl) rowEl.draggable = true;
      return;
    }

    if (rowEl) rowEl.draggable = false;
    if (onBeforeStart) onBeforeStart(e);
    const rect = container.getBoundingClientRect();
    active = true;
    dragging = false;
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top + container.scrollTop;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    baseSelection = getBaseSelection(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (!active) return;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    const rect = container.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top + container.scrollTop;

    if (!dragging) {
      if (Math.hypot(curX - startX, curY - startY) < 5) return;
      dragging = true;
      getBox().classList.remove('hidden');
      autoScrollTimer = setInterval(() => {
        if (!dragging) return;
        const r = container.getBoundingClientRect();
        let scrolled = false;
        if (lastClientY < r.top + 32) {
          container.scrollTop -= 18;
          scrolled = true;
        } else if (lastClientY > r.bottom - 32) {
          container.scrollTop += 18;
          scrolled = true;
        }
        if (scrolled) updateBoxAndSelection();
      }, 30);
    }

    e.preventDefault();
    updateBoxAndSelection();
  });

  window.addEventListener('mouseup', () => {
    if (!active) return;
    active = false;
    clearInterval(autoScrollTimer);
    autoScrollTimer = null;
    if (dragging) {
      dragging = false;
      getBox().classList.add('hidden');
      state.suppressNextClick = true;
      setTimeout(() => { state.suppressNextClick = false; }, 100);
    }
    container.querySelectorAll(rowSelector).forEach((el) => { el.draggable = true; });
  });
}

function setupMarqueeSelection() {
  const vp = $('virtual-viewport');
  attachRubberBandController({
    container: vp,
    rowSelector: '[data-index]',
    getBox: () => $('marquee-box'),
    canStart: (e) => e.target.type !== 'checkbox' && !e.target.classList.contains('eye-btn'),
    isDragHandle: isDragFileHandle,
    getBaseSelection: (e) => (e.ctrlKey || e.shiftKey ? new Set(state.selectedPaths) : new Set()),
    onBeforeStart: () => { state.activePane = 'left'; },
    onSelectionBox: ({ left, right, top, bottom }, baseSelection) => {
      const metrics = getLayoutMetrics();
      const total = state.viewItems.length;
      const nextSel = new Set(baseSelection);
      if (total > 0) {
        const startRow = Math.max(0, Math.floor(top / metrics.rowHeight));
        const endRow = Math.min(Math.ceil(total / metrics.cols) - 1, Math.floor(bottom / metrics.rowHeight));
        const colWidth = vp.clientWidth / metrics.cols;
        for (let r = startRow; r <= endRow; r++) {
          for (let c = 0; c < metrics.cols; c++) {
            const idx = r * metrics.cols + c;
            if (idx >= total) break;
            const itemLeft = c * colWidth + 6;
            const itemRight = (c + 1) * colWidth - 6;
            if (metrics.cols === 1 || (right >= itemLeft && left <= itemRight)) {
              nextSel.add(state.viewItems[idx].path);
            }
          }
        }
      }
      state.selectedPaths = nextSel;
      updateSelectionDomInPlace();
      updateStatusCounts();
      updateToolbarButtons();
    },
  });

  const dualList = $('dual-list');
  attachRubberBandController({
    container: dualList,
    rowSelector: '.dual-row[data-index]',
    getBox: () => {
      let b = $('dual-marquee-box');
      if (!b) {
        b = document.createElement('div');
        b.id = 'dual-marquee-box';
        b.className = 'marquee-box hidden';
      }
      if (b.parentElement !== dualList) dualList.appendChild(b);
      return b;
    },
    isDragHandle: isDragFileHandle,
    getBaseSelection: (e) => (e.ctrlKey || e.shiftKey ? new Set(state.dualSelectedPaths) : new Set()),
    onBeforeStart: () => { state.activePane = 'dual'; },
    onSelectionBox: ({ top, bottom }, baseSelection) => {
      const nextSel = new Set(baseSelection);
      const rows = dualList.querySelectorAll('.dual-row[data-index]');
      for (const row of rows) {
        const rowTop = row.offsetTop;
        const rowBottom = rowTop + row.offsetHeight;
        if (rowTop <= bottom && rowBottom >= top) {
          const item = state.dualItems[Number(row.dataset.index)];
          if (item) nextSel.add(item.path);
        }
      }
      state.dualSelectedPaths = nextSel;
      updateDualSelectionDomInPlace();
    },
  });
}


export {
  getDualSelectedItems,
  getSelectedItems,
  handleDualItemSelect,
  handleItemSelect,
  isDragFileHandle,
  setupMarqueeSelection,
  updateDualSelectionDomInPlace,
  updateStatusCounts,
  updateToolbarButtons,
};
