import { state } from '../../store/appState.js';
import { $, esc } from '../../utils/dom.js';
import { restoreTabAnalyzerView } from '../analyzer/analyzerAndDuplicates.js';
import { cancelPendingThumbs, scheduleThumbBatch } from '../scroller/thumbLoaderAndStoryboard.js';
import { renderSmartViewsSidebar } from '../sidebar/smartViews.js';
import { applySortAndFilter, applyViewModeForFolder, closeColFilterPopover } from '../scroller/columnHeadersAndStudio.js';
import { updateListHeaderIndicators } from '../../core/filterAndSortEngine.js';
import { renderRecentDashboardSections, updateSidebarActive } from '../sidebar/treeAndDashboard.js';
import { updateStatusCounts, updateToolbarButtons } from '../scroller/selectionAndMarquee.js';
import { api } from '../../services/apiClient.js';
import { formatBytes } from '../../utils/formatters.js';
import { recordRecentFolder } from '../../services/preferencesService.js';
import { renderVirtualList } from '../scroller/virtualScroller.js';
import { toast } from '../shared/toast.js';
import { showPromptModal } from '../shared/promptModal.js';
import { openExternally, restoreFromTrash } from '../operations/fileActions.js';
import { openQuickLook } from '../quicklook/quicklookViewer.js';
import { isPdfPreviewable, isTextPreviewable } from '../quicklook/quicklookTextTools.js';
import { openZipManagerModal } from '../operations/zipManagerModal.js';

// ---------- Sekmeler & Gezinti ----------
function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

function saveCurrentTabScroll() {
  const cur = getActiveTab();
  const vp = $('virtual-viewport');
  if (cur && cur.viewType === 'explorer' && vp) {
    cur.scrollTop = vp.scrollTop || 0;
  }
}

function createTab(targetPath = 'PC', activate = true) {
  if (activate) saveCurrentTabScroll();
  const id = 'tab_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const tab = {
    id,
    path: targetPath,
    title: targetPath === 'PC' ? 'Bu bilgisayar' : getFolderTitle(targetPath),
    history: [targetPath],
    historyIndex: 0,
    viewType: 'explorer', // 'explorer' | 'analyzer'
    analyzerPath: '',
    analyzerData: null,
    analyzerLoading: false,
    dupesData: null,
    dupesLoading: false,
    dupesError: '',
    scrollTop: 0,
  };
  state.tabs.push(tab);
  if (activate) {
    state.activeTabId = id;
    navigateTo(targetPath, { pushHistory: false });
  }
  renderTabs();
  return tab;
}

function getFolderTitle(p) {
  if (!p || p === 'PC') return 'Bu bilgisayar';
  if (p === 'TRASH') return '🗑️ Çöp Kutusu';
  const clean = p.replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(clean)) return clean + '\\';
  const parts = clean.split('\\');
  return parts[parts.length - 1] || clean;
}

function updateTrashBadge(count) {
  if (typeof count !== 'number' || Number.isNaN(count)) return;
  state.trashCount = Math.max(0, count);
  const cmdCount = $('cmd-trash-count');
  if (cmdCount) cmdCount.textContent = String(state.trashCount);
  const sbBadge = $('sb-trash-badge');
  if (sbBadge) {
    sbBadge.textContent = String(state.trashCount);
    sbBadge.classList.toggle('hidden', state.trashCount === 0);
  }
}

function updateUndoButton(summary) {
  if (!summary) return;
  state.undoSummary = summary;
  const btn = $('btn-undo');
  if (!btn) return;
  btn.disabled = !summary.canUndo;
  btn.title = summary.canUndo
    ? `Geri Al: ${summary.topLabel} (Ctrl+Z)`
    : 'Geri alınacak işlem yok (Ctrl+Z)';
}

function switchToTab(t) {
  if (!t || t.id === state.activeTabId) return;
  saveCurrentTabScroll();
  state.activeTabId = t.id;
  renderTabs();
  if (t.viewType === 'analyzer') {
    restoreTabAnalyzerView(t);
  } else {
    navigateTo(t.path, { pushHistory: false, restoreScroll: true });
  }
}

function renderTabs() {
  const cont = $('tabs-container');
  cont.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = `tab-item ${t.id === state.activeTabId ? 'active' : ''}`;
    const displayTitle = t.viewType === 'analyzer'
      ? `📊 ${getFolderTitle(t.analyzerPath || t.path)}${t.dupesLoading ? ' ⏳' : ''}`
      : t.title;
    el.innerHTML = `<span class="tab-title">${esc(displayTitle)}</span>${
      state.tabs.length > 1 ? '<button class="tab-close" title="Sekmeyi Kapat">✕</button>' : ''
    }`;
    el.onclick = (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeTab(t.id);
        return;
      }
      switchToTab(t);
    };
    cont.appendChild(el);
  }
}

function closeTab(id) {
  if (state.tabs.length <= 1) return;
  const idx = state.tabs.findIndex((t) => t.id === id);
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    state.activeTabId = next.id;
    if (next.viewType === 'analyzer') {
      restoreTabAnalyzerView(next);
    } else {
      navigateTo(next.path, { pushHistory: false, restoreScroll: true });
    }
  }
  renderTabs();
}

async function navigateTo(targetPath, { pushHistory = true, forceRefresh = false, restoreScroll = false, preserveScroll = false } = {}) {
  const tab = getActiveTab();
  if (!tab) return;

  const vp = $('virtual-viewport');
  const prevPath = tab.path;
  const isSameTarget = Boolean(prevPath && targetPath && prevPath.toLowerCase() === String(targetPath).toLowerCase());
  const shouldKeepScroll = Boolean(restoreScroll || preserveScroll || (!pushHistory && isSameTarget));
  const savedScrollTop = restoreScroll
    ? (tab.scrollTop || 0)
    : (shouldKeepScroll && vp ? (vp.scrollTop || 0) : 0);

  cancelPendingThumbs();
  state.thumbSessionId++;
  state.selectedPaths.clear();
  state.lastClickedIndex = -1;
  if (!isSameTarget || pushHistory) {
    state.filterOnlyMatched = false;
    state.relatedCtx = null;
    state.smartViewCtx = null;
    $('related-bar')?.classList.add('hidden');
    $('smart-view-bar')?.classList.add('hidden');
    renderSmartViewsSidebar();
    for (const set of Object.values(state.colFilters)) set.clear();
    closeColFilterPopover();
    updateListHeaderIndicators();
    $('btn-flt-clear-view').classList.add('hidden');
    $('search-input').value = '';
    state.searchQuery = '';
    $('btn-clear-search').classList.add('hidden');
  }

  tab.viewType = 'explorer';
  $('analyzer-view').classList.add('hidden');

  if (pushHistory && tab.path !== targetPath) {
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(targetPath);
    tab.historyIndex = tab.history.length - 1;
  }
  tab.path = targetPath;
  tab.title = getFolderTitle(targetPath);

  renderTabs();
  renderBreadcrumbs(targetPath);
  updateNavButtons();
  updateSidebarActive(targetPath);

  if (targetPath === 'PC') {
    $('trash-bar').classList.add('hidden');
    $('explorer-view').classList.add('hidden');
    $('pc-dashboard').classList.remove('hidden');
    renderRecentDashboardSections();
    $('status-count').textContent = `${state.drives.length} sürücü`;
    $('status-selected').textContent = '0 seçili';
    $('status-timing').textContent = 'Hazır';
    updateToolbarButtons();
    if (window.__ldMarkStartup) {
      window.__ldMarkStartup('Ilk ekran (PC) cizildi (TAM HAZIR)');
      window.__ldFlushStartupProfile();
    }
    return;
  }

  $('pc-dashboard').classList.add('hidden');
  $('explorer-view').classList.remove('hidden');
  const isTrash = targetPath === 'TRASH';
  $('trash-bar').classList.toggle('hidden', !isTrash);
  const dateHeaderLabel = document.querySelector('#list-header .lh-date .lh-label');
  if (dateHeaderLabel) dateHeaderLabel.textContent = isTrash ? 'Silinme tarihi' : 'Değiştirme tarihi';

  const reqTabId = tab.id;
  try {
    const data = isTrash
      ? await api('/api/trash/list')
      : await api(`/api/list?path=${encodeURIComponent(targetPath)}&refresh=${forceRefresh ? '1' : '0'}`);
    tab.path = data.path;
    tab.title = getFolderTitle(data.path);
    renderTabs();

    // Kullanıcı yanıt beklerken başka sekmeye geçtiyse aktif ekranı bozma
    if (state.activeTabId !== reqTabId || tab.viewType !== 'explorer') return;

    renderBreadcrumbs(data.path);
    updateSidebarActive(data.path);

    if (isTrash) {
      updateTrashBadge(data.count || data.items.length);
      const sumEl = $('trash-bar-summary');
      if (sumEl) {
        sumEl.textContent = data.items.length > 0
          ? `${data.items.length} öğe • Toplam ${formatBytes(data.totalSize || 0)} (Kalıcı sil yapılmadıkça geri yüklenebilir)`
          : 'Çöp kutusu boş.';
      }
    } else {
      recordRecentFolder(data.path);
      for (const item of data.items) {
        if (item.isDir && state.folderSizesCache.has(item.path)) {
          item.size = state.folderSizesCache.get(item.path);
          item.sizeCalculated = true;
        }
      }
    }

    state.rawItems = data.items;
    if (!isTrash) {
      applyViewModeForFolder(data.path);
    } else {
      const vmSel = $('view-mode');
      state.viewMode = 'list';
      if (vmSel) vmSel.value = 'list';
    }
    $('status-timing').textContent = isTrash
      ? `${data.durationMs} ms (Çöp Kutusu)`
      : `${data.durationMs} ms (0 ön-okuma)`;
    applySortAndFilter();
    updateToolbarButtons();
    if (window.__ldMarkStartup) {
      window.__ldMarkStartup('Ilk klasor listesi cizildi (TAM HAZIR)', `${data.items.length} oge, list=${data.durationMs}ms`);
      window.__ldFlushStartupProfile();
    }
    if (vp) {
      const maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
      const nextScroll = shouldKeepScroll ? Math.min(savedScrollTop, maxScroll) : 0;
      vp.scrollTop = nextScroll;
      tab.scrollTop = vp.scrollTop;
      if (nextScroll > 0) renderVirtualList();
    }

    if (!isTrash && (state.thumbMode === 'viewport' || state.thumbMode === 'all')) {
      scheduleThumbBatch();
    }
  } catch (err) {
    toast(`Klasör açılamadı: ${err.message}`, 'error');
    if (state.activeTabId === reqTabId && tab.viewType === 'explorer') {
      state.rawItems = [];
      state.viewItems = [];
      updateStatusCounts();
      updateToolbarButtons();
      $('status-timing').textContent = 'Hata';
      const content = $('virtual-content');
      content.style.height = 'auto';
      content.innerHTML = `
        <div class="empty-state" style="padding:36px 20px;">
          <div style="font-size:15px;font-weight:600;color:#fca5a5;margin-bottom:8px;">⚠️ Klasör Açılamadı</div>
          <div class="muted-text" style="margin-bottom:14px;">${esc(targetPath)}<br>${esc(err.message)}</div>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
            <button type="button" class="cmd-btn primary" id="btn-err-go-pc">🖥️ Bu Bilgisayara Dön</button>
            ${prevPath && prevPath !== targetPath ? `<button type="button" class="cmd-btn" id="btn-err-go-prev">↩️ Önceki Klasöre Dön</button>` : ''}
          </div>
        </div>
      `;
      const pcBtn = $('btn-err-go-pc');
      if (pcBtn) pcBtn.onclick = () => navigateTo('PC');
      const backBtn = $('btn-err-go-prev');
      if (backBtn) backBtn.onclick = () => navigateTo(prevPath, { pushHistory: false });
    }
  }
}

function updateNavButtons() {
  const tab = getActiveTab();
  if (!tab) return;
  $('btn-back').disabled = tab.historyIndex <= 0;
  $('btn-forward').disabled = tab.historyIndex >= tab.history.length - 1;
  $('btn-up').disabled = tab.path === 'PC';
}

function renderBreadcrumbs(p) {
  const bc = $('breadcrumbs');
  bc.innerHTML = '';

  const pcBtn = document.createElement('button');
  pcBtn.className = 'crumb-btn';
  pcBtn.textContent = '🖥️ Bu bilgisayar';
  pcBtn.onclick = (e) => { e.stopPropagation(); navigateTo('PC'); };
  bc.appendChild(pcBtn);

  if (!p || p === 'PC') return;

  if (p === 'TRASH') {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    bc.appendChild(sep);
    const tBtn = document.createElement('button');
    tBtn.className = 'crumb-btn';
    tBtn.textContent = '🗑️ Çöp Kutusu';
    tBtn.onclick = (e) => { e.stopPropagation(); navigateTo('TRASH', { pushHistory: false, preserveScroll: true }); };
    bc.appendChild(tBtn);
    return;
  }

  const clean = p.replace(/\\+$/, '');
  const parts = clean.split('\\');
  let accum = '';
  parts.forEach((part, i) => {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    bc.appendChild(sep);

    accum = i === 0 ? `${part}\\` : `${accum.replace(/\\$/, '')}\\${part}`;
    const target = accum;
    const btn = document.createElement('button');
    btn.className = 'crumb-btn';
    btn.dataset.path = target;
    btn.textContent = i === 0 ? part : part;
    btn.onclick = (e) => { e.stopPropagation(); navigateTo(target); };
    bc.appendChild(btn);
  });
}


const NO_DBLCLICK_QUICKLOOK_EXTS = new Set([
  '.bat', '.cmd', '.exe', '.msi', '.com', '.lnk', '.url',
  '.vbs', '.vbe', '.wsf', '.wsh', '.hta', '.reg', '.scr', '.pif', '.msc', '.cpl',
]);

function shouldOpenInQuickLook(item) {
  if (!item || item.isDir) return false;
  if (state.settings.dblClickQuickLook === false) return false;
  const ext = (item.ext || '').toLowerCase();
  if (item.category === 'app' || NO_DBLCLICK_QUICKLOOK_EXTS.has(ext)) return false;
  return item.category === 'image' || item.category === 'video' || isPdfPreviewable(item) || isTextPreviewable(item);
}

async function activateItem(item) {
  if (!item) return;
  const now = Date.now();
  if (state.lastActivatedPath === item.path && now - state.lastActivatedTime < 600) return;
  state.lastActivatedPath = item.path;
  state.lastActivatedTime = now;
  if (item.inTrash) {
    const ok = await showPromptModal({
      title: 'Çöp Kutusundan Geri Yükle',
      desc: `"${item.name}" özgün konumuna (${item.origDir}) geri yüklensin mi?`,
      okText: '♻️ Geri Yükle',
    });
    if (ok) restoreFromTrash([item.path]);
    return;
  }
  if (item.isDir) navigateTo(item.path);
  else if ((item.ext || '').toLowerCase() === '.zip') openZipManagerModal(item.path);
  else if (shouldOpenInQuickLook(item)) openQuickLook(item);
  else openExternally(item.path);
}


export {
  activateItem,
  closeTab,
  createTab,
  getActiveTab,
  getFolderTitle,
  navigateTo,
  renderBreadcrumbs,
  renderTabs,
  shouldOpenInQuickLook,
  updateNavButtons,
  updateTrashBadge,
  updateUndoButton,
};
