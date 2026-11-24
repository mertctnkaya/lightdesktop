import { $, esc } from '../../utils/dom.js';
import { state } from '../../store/appState.js';
import { getActiveTab, getFolderTitle } from '../navigation/tabsAndRouter.js';
import { ICONS } from '../../constants/uiConstants.js';
import { toast } from '../shared/toast.js';
import { enqueueTransfer } from '../operations/fileActions.js';

function renderDragShelf() {
  const shelf = $('drag-shelf');
  const listEl = $('drag-shelf-list');
  const cntEl = $('drag-shelf-count');
  const handleEl = $('drag-shelf-drag-handle');
  const btnMove = $('btn-shelf-move-here');
  const btnCopy = $('btn-shelf-copy-here');
  if (!shelf || !listEl) return;

  const items = Array.from(state.shelfItems.values());
  if (cntEl) cntEl.textContent = String(items.length);
  if (handleEl) {
    handleEl.classList.toggle('hidden', items.length === 0);
    handleEl.textContent = `🧲 Tümünü Sürükle (${items.length})`;
  }
  const tab = getActiveTab();
  const canDropToCur = Boolean(tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH');
  if (btnMove) btnMove.disabled = items.length === 0 || !canDropToCur;
  if (btnCopy) btnCopy.disabled = items.length === 0 || !canDropToCur;

  listEl.innerHTML = '';
  if (items.length === 0) {
    listEl.innerHTML = '<div class="drag-shelf-empty muted-text">Dosyaları buraya sürükleyip başka klasörde tek hamlede bırakabilirsiniz.</div>';
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'drag-shelf-row';
    row.title = it.path;
    row.innerHTML = `
      <span>${ICONS[it.category] || ICONS.other}</span>
      <span class="drag-shelf-row-name">${esc(it.name || getFolderTitle(it.path))}</span>
      <button type="button" class="mini-pill-btn" title="Raftan Çıkar">✕</button>
    `;
    row.querySelector('button').onclick = () => {
      state.shelfItems.delete(it.path);
      renderDragShelf();
    };
    listEl.appendChild(row);
  }
}

function addItemsToShelf(itemsOrPaths) {
  let added = 0;
  for (const entry of itemsOrPaths || []) {
    const p = typeof entry === 'string' ? entry : entry?.path;
    if (!p || state.shelfItems.has(p)) continue;
    const itemObj = typeof entry === 'object' && entry
      ? entry
      : (state.viewItems.find((x) => x.path === p) || state.dualItems.find((x) => x.path === p) || { path: p, name: getFolderTitle(p), category: 'other' });
    state.shelfItems.set(p, itemObj);
    added++;
  }
  state.shelfPinned = true;
  $('drag-shelf')?.classList.remove('hidden');
  renderDragShelf();
  if (added > 0) toast(`🧲 ${added} öğe Geçici Rafa park edildi`);
}

function clearDragShelf() {
  state.shelfItems.clear();
  renderDragShelf();
}

function setShelfAutoReveal(isDragging) {
  const shelf = $('drag-shelf');
  if (!shelf) return;
  if (isDragging) {
    shelf.classList.remove('hidden');
  } else if (state.shelfItems.size === 0 && !state.shelfPinned) {
    shelf.classList.add('hidden');
  }
}


function toggleDragShelfVisible(forceShow = null) {
  const shelf = $('drag-shelf');
  if (!shelf) return;
  const shouldShow = forceShow !== null ? forceShow : shelf.classList.contains('hidden');
  state.shelfPinned = shouldShow;
  shelf.classList.toggle('hidden', !shouldShow);
  if (shouldShow) renderDragShelf();
}

function bindDragShelfHandlers() {
  const shelf = $('drag-shelf');
  const btnToggle = $('btn-toggle-shelf');
  const btnClose = $('btn-shelf-close');
  const btnClear = $('btn-shelf-clear');
  const btnMoveHere = $('btn-shelf-move-here');
  const btnCopyHere = $('btn-shelf-copy-here');
  const handleEl = $('drag-shelf-drag-handle');

  if (btnToggle) btnToggle.onclick = () => toggleDragShelfVisible();
  if (btnClose) {
    btnClose.onclick = () => {
      state.shelfPinned = false;
      shelf?.classList.add('hidden');
    };
  }
  if (btnClear) btnClear.onclick = clearDragShelf;

  const transferShelfToCur = async (op) => {
    const tab = getActiveTab();
    if (!tab || !tab.path || tab.path === 'PC' || tab.path === 'TRASH') {
      return toast('Geçerli bir hedef klasör açın', 'error');
    }
    const paths = Array.from(state.shelfItems.keys());
    if (paths.length === 0) return;
    await enqueueTransfer(op, paths, tab.path);
    if (op === 'move') clearDragShelf();
  };
  if (btnMoveHere) btnMoveHere.onclick = () => transferShelfToCur('move');
  if (btnCopyHere) btnCopyHere.onclick = () => transferShelfToCur('copy');

  if (shelf) {
    shelf.addEventListener('dragover', (e) => {
      if (!state.draggedPaths.length) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      shelf.classList.add('drop-active');
    });
    shelf.addEventListener('dragleave', (e) => {
      if (!shelf.contains(e.relatedTarget)) shelf.classList.remove('drop-active');
    });
    shelf.addEventListener('drop', (e) => {
      shelf.classList.remove('drop-active');
      if (!state.draggedPaths.length) return;
      e.preventDefault();
      const draggedSet = new Set(state.draggedPaths);
      const matched = state.viewItems.filter((it) => draggedSet.has(it.path));
      addItemsToShelf(matched.length > 0 ? matched : state.draggedPaths);
    });
  }
  if (handleEl) {
    handleEl.addEventListener('dragstart', (e) => {
      if (state.shelfItems.size === 0) { e.preventDefault(); return; }
      state.draggedPaths = Array.from(state.shelfItems.keys());
      state.dragSource = 'shelf';
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', state.draggedPaths.join('\n'));
      }
    });
  }
}


export {
  addItemsToShelf,
  bindDragShelfHandlers,
  renderDragShelf,
  setShelfAutoReveal,
  toggleDragShelfVisible,
};
