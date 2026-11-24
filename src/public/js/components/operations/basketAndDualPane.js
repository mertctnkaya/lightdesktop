import { state } from '../../store/appState.js';
import { toast } from '../shared/toast.js';
import { $, esc } from '../../utils/dom.js';
import { getSelectedItems } from '../scroller/selectionAndMarquee.js';
import { enqueueTransfer } from './fileActions.js';
import { getActiveTab, getFolderTitle } from '../navigation/tabsAndRouter.js';
import { ICONS } from '../../constants/uiConstants.js';
import { renderVirtualList } from '../scroller/virtualScroller.js';
import { updateQuickLookBasketBadge } from '../quicklook/quicklookViewer.js';
import { api } from '../../services/apiClient.js';
import { sortItemsArray } from '../../core/filterAndSortEngine.js';
import { formatBytes } from '../../utils/formatters.js';

// ---------- Klasör Sepeti (Drop Basket) ----------
function addItemsToBasket(items) {
  let added = 0;
  for (const it of items) {
    if (!state.basket.has(it.path)) {
      state.basket.set(it.path, it);
      added++;
    }
  }
  renderBasket();
  toast(`${added} öğe sepete eklendi (Toplam: ${state.basket.size})`);
}

function toggleSelectedInBasket(overrideItems = null) {
  const sel = overrideItems || getSelectedItems();
  if (sel.length === 0) return;
  let added = 0;
  let removed = 0;
  for (const it of sel) {
    if (state.basket.has(it.path)) {
      state.basket.delete(it.path);
      removed++;
    } else {
      state.basket.set(it.path, it);
      added++;
    }
  }
  renderBasket();
  toast(`Sepet güncellendi (+${added}, -${removed})`);
}

async function transferBasketTo(destDir, op = 'move') {
  if (!destDir || destDir === 'PC' || destDir === 'TRASH') {
    toast('Geçerli bir hedef klasör açın', 'error');
    return;
  }
  if (state.basket.size === 0) {
    toast('Sepetiniz boş', 'error');
    return;
  }
  const srcs = Array.from(state.basket.keys());
  await enqueueTransfer(op, srcs, destDir);
  if (op === 'move') {
    state.basket.clear();
    renderBasket();
  }
}

function updateBasketActionButtons() {
  const count = state.basket.size;
  const dualCnt = $('dual-basket-count');
  if (dualCnt) dualCnt.textContent = String(count);

  const dualMoveBtn = $('dual-btn-basket-move-here');
  if (dualMoveBtn) {
    dualMoveBtn.disabled = count === 0 || !state.dualPath;
    dualMoveBtn.title = state.dualPath
      ? `Sepetteki ${count} öğeyi "${state.dualPath}" klasörüne taşı`
      : 'Sağ panelde bir hedef klasör açın';
  }

  const tab = getActiveTab();
  const leftReady = Boolean(tab && tab.path !== 'PC' && tab.path !== 'TRASH');
  const mainMove = $('btn-basket-move-here');
  const mainCopy = $('btn-basket-copy-here');
  if (mainMove) {
    mainMove.disabled = count === 0 || !leftReady;
    mainMove.textContent = leftReady ? `📥 Ana Panele Taşı (${getFolderTitle(tab.path)})` : '📥 Ana Panele Taşı';
  }
  if (mainCopy) mainCopy.disabled = count === 0 || !leftReady;

  const dualReady = Boolean(state.dualOpen && state.dualPath);
  const bMoveDual = $('btn-basket-move-dual');
  const bCopyDual = $('btn-basket-copy-dual');
  if (bMoveDual) {
    bMoveDual.classList.toggle('hidden', !dualReady);
    bMoveDual.disabled = count === 0 || !dualReady;
    if (dualReady) bMoveDual.textContent = `➡ Sağ Panele Taşı (${getFolderTitle(state.dualPath)})`;
  }
  if (bCopyDual) {
    bCopyDual.classList.toggle('hidden', !dualReady);
    bCopyDual.disabled = count === 0 || !dualReady;
  }
}

function renderBasket() {
  $('basket-count').textContent = state.basket.size;
  const list = $('basket-list');
  list.innerHTML = '';
  if (state.basket.size === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:24px 8px">Sepetiniz boş.</div>';
    updateBasketActionButtons();
    return;
  }
  for (const [p, it] of state.basket.entries()) {
    const row = document.createElement('div');
    row.className = 'basket-item';
    row.title = p;
    row.innerHTML = `
      <span>${ICONS[it.category] || ICONS.other}</span>
      <span class="basket-item-name">${esc(it.name)}</span>
      <button class="icon-btn small" title="Çıkar">✕</button>
    `;
    row.querySelector('button').onclick = () => {
      state.basket.delete(p);
      renderBasket();
    };
    list.appendChild(row);
  }
  updateBasketActionButtons();
  if ($('explorer-view') && !$('explorer-view').classList.contains('hidden')) {
    renderVirtualList();
  }
  if ($('quicklook-dialog')?.open && state.qlMediaItems[state.qlIndex]) {
    updateQuickLookBasketBadge(state.qlMediaItems[state.qlIndex]);
  }
}


function toggleDualPane() {
  state.dualOpen = !state.dualOpen;
  $('dual-pane').classList.toggle('hidden', !state.dualOpen);
  $('btn-dual-pane').classList.toggle('active', state.dualOpen);
  if (state.dualOpen && !state.dualPath) {
    const tab = getActiveTab();
    const curDrive = tab && tab.path !== 'PC' ? tab.path.slice(0, 3).toUpperCase() : '';
    const altDrive = state.drives.find((d) => d.path.toUpperCase() !== curDrive) || state.drives[0];
    navigateDual(altDrive ? altDrive.path : 'C:\\');
  }
  updateBasketActionButtons();
  if ($('explorer-view') && !$('explorer-view').classList.contains('hidden')) {
    renderVirtualList();
  }
  if ($('quicklook-dialog')?.open && state.qlMediaItems[state.qlIndex]) {
    updateQuickLookBasketBadge(state.qlMediaItems[state.qlIndex]);
  }
}

async function navigateDual(targetPath, pushHistory = true) {
  if (!targetPath || targetPath === 'PC' || targetPath === 'TRASH') return;
  const listEl = $('dual-list');
  const keepDualScroll = !pushHistory && state.dualPath && state.dualPath.toLowerCase() === String(targetPath).toLowerCase();
  const savedDualScroll = keepDualScroll && listEl ? (listEl.scrollTop || 0) : 0;
  try {
    const data = await api(`/api/list?path=${encodeURIComponent(targetPath)}`);
    if (pushHistory && state.dualPath !== data.path) {
      state.dualHistory = state.dualHistory.slice(0, state.dualHistoryIdx + 1);
      state.dualHistory.push(data.path);
      state.dualHistoryIdx = state.dualHistory.length - 1;
    }
    const changedDir = !state.dualPath || state.dualPath.toLowerCase() !== String(data.path).toLowerCase();
    state.dualPath = data.path;
    state.dualItems = sortItemsArray(data.items);
    if (changedDir) {
      state.dualSelectedPaths.clear();
      state.dualLastClickedIdx = -1;
    } else {
      const validPaths = new Set(state.dualItems.map((it) => it.path));
      for (const p of Array.from(state.dualSelectedPaths)) {
        if (!validPaths.has(p)) state.dualSelectedPaths.delete(p);
      }
    }
    $('dual-path-input').value = data.path;
    $('dual-btn-back').disabled = state.dualHistoryIdx <= 0;
    renderDualList();
    updateBasketActionButtons();
    if (listEl) {
      const maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
      listEl.scrollTop = keepDualScroll ? Math.min(savedDualScroll, maxScroll) : 0;
    }
  } catch (err) {
    toast(`Sağ panel açılamadı: ${err.message}`, 'error');
  }
}

function renderDualList() {
  const listEl = $('dual-list');
  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let idx = 0; idx < state.dualItems.length; idx++) {
    const item = state.dualItems[idx];
    const isSel = state.dualSelectedPaths.has(item.path);
    const isCut = state.clipboard.op === 'cut' && state.clipboard.paths.includes(item.path);
    const row = document.createElement('div');
    row.className = `dual-row${isSel ? ' selected' : ''}${isCut ? ' cut-dim' : ''}`;
    row.dataset.index = idx;
    row.dataset.path = item.path;
    row.dataset.isdir = item.isDir ? '1' : '0';
    row.draggable = true;
    row.title = item.path;
    row.innerHTML = `
      <span class="dual-row-icon">${ICONS[item.category] || ICONS.other}</span>
      <span class="dual-row-name">${esc(item.name)}</span>
      <span class="dual-row-spacer"></span>
      <span class="dual-row-size">${item.isDir ? '' : formatBytes(item.size)}</span>
    `;
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}


export {
  addItemsToBasket,
  navigateDual,
  renderBasket,
  toggleDualPane,
  toggleSelectedInBasket,
  transferBasketTo,
  updateBasketActionButtons,
};
