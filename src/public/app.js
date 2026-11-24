'use strict';

// LightDesktop İstemci Motoru — 60 FPS Virtual Scroller, Aralık/RegExp Seçici & Sıralı Kapak Yükleyici

const $ = (id) => document.getElementById(id);

const ICONS = {
  folder: '📁',
  video: '🎬',
  image: '🖼️',
  audio: '🎵',
  archive: '📦',
  document: '📄',
  app: '⚙️',
  code: '💻',
  other: '📃',
};

const CAT_META = {
  video: { label: 'Videolar', color: '#0078d4', icon: '🎬' },
  image: { label: 'Fotoğraflar', color: '#00b7c3', icon: '🖼️' },
  archive: { label: 'Arşivler & ISO', color: '#ca5010', icon: '📦' },
  document: { label: 'Belgeler', color: '#10893e', icon: '📄' },
  audio: { label: 'Ses', color: '#8764b8', icon: '🎵' },
  app: { label: 'Uygulamalar', color: '#e3008c', icon: '⚙️' },
  code: { label: 'Kod & Metin', color: '#498205', icon: '💻' },
  other: { label: 'Diğer', color: '#69797e', icon: '📃' },
};

const QUICK_ICONS = {
  desktop: '🖥️',
  downloads: '⬇️',
  documents: '📄',
  pictures: '🖼️',
  music: '🎵',
  videos: '🎬',
};

const state = {
  drives: [],
  quickAccess: [],
  pins: [],
  tabs: [],
  activeTabId: null,

  // Aktif klasör verileri
  rawItems: [],
  viewItems: [],
  selectedPaths: new Set(),
  lastClickedIndex: -1,

  // Görünüm & Sıralama
  sortBy: 'name',
  sortDir: 'asc',
  viewMode: 'list', // list | compact | grid
  globalViewMode: 'list',
  folderViews: {}, // normalizedPath -> viewMode
  colWidths: { name: null, mtime: null, ext: null, size: null },
  colFilters: { name: new Set(), mtime: new Set(), ext: new Set(), size: new Set() },
  suppressHeaderSortUntil: 0,
  activeFilterCol: null,
  thumbMode: 'off', // off | selected | viewport | all
  filterOnlyMatched: false,
  relatedCtx: null,

  // Pano & Sepet
  clipboard: { op: null, paths: [] },
  basket: new Map(), // path -> item

  // Arama
  searchTimer: null,
  searchQuery: '',

  // Kapak Resmi Sıralı İstemci Önbelleği (Concurrency = 1)
  thumbBlobCache: new Map(), // key -> objectURL
  thumbAbortCtrl: null,
  thumbQueueRunning: false,
  thumbSessionId: 1,
  viewportScrollTimer: null,
  folderSizeRunning: false,
  folderSizePath: '',
  folderSizesCache: new Map(), // folderPath -> bytes

  // QuickLook & Seçim zamanlayıcı
  qlIndex: -1,
  qlMediaItems: [],
  qlZoom: 1,
  qlPanX: 0,
  qlPanY: 0,
  qlBrightness: 100,
  lastClickPath: '',
  lastClickTime: 0,
  lastActivatedPath: '',
  lastActivatedTime: 0,
  suppressNextClick: false,
  expandedTreePaths: new Set(),
  draggedPaths: [],

  // Çift Panel (Dual Pane)
  dualOpen: false,
  dualPath: '',
  dualItems: [],
  dualSelectedPaths: new Set(),
  dualLastClickedIdx: -1,
  dualHistory: [],
  dualHistoryIdx: -1,
  activePane: 'left',

  // Çöp Kutusu & Geri Al (Ctrl+Z)
  trashCount: 0,
  undoSummary: { count: 0, canUndo: false, topLabel: '', topType: '' },

  // Hızlı Erişim: Son Açılan Klasörler & Son Erişilen Dosyalar
  recentFolders: [],
  recentFiles: [],
  recentTransferTargets: [], // En son dosya taşınan/kopyalanan max 15 hedef klasör (LRU)
  recentTargetsOpen: true,
  dashSections: { quick: true, folders: true, files: true },

  // Akıllı Klasörler (Sanal Görünüm) & Geçici Yüzen Raf
  smartViews: [],
  smartViewsOpen: true,
  smartViewCtx: null,
  shelfItems: new Map(),
  shelfPinned: false,

  // Uygulama Ayarları
  settings: {
    accentColor: '#0078d4',
    fontSize: 13,
    foldersFirst: true,
    showExtensions: true,
    compactSidebar: false,
    defaultViewMode: 'last', // last | list | dense | compact | tiles | grid-sm | grid | grid-lg | grid-xl
    rememberFolderView: true,
    startupMode: 'pc', // pc | last | custom
    startupPath: '',
    clickMode: 'double', // double | single
    trashConfirmMode: 'bulk', // bulk | always | never
    autoCloseProcessModal: false,
    defaultThumbMode: 'off',
    dblClickQuickLook: true,
    frameSaveMode: 'same', // same | custom
    frameSaveDir: '',
    trimSaveMode: 'same', // same | custom
    trimSaveDir: '',
    videoAutoplay: true,
    videoLoop: false,
  },
};

const DEFAULT_APP_SETTINGS = { ...state.settings };

const naturalCollator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });

// ---------- Yardımcılar ----------
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

const localClientErrors = [];

function reportClientError(op, message, target = '', stack = '') {
  if (!message) return;
  const activeTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const meta = {
    tabPath: activeTab ? activeTab.path : '',
    viewType: activeTab ? activeTab.viewType : '',
    ua: navigator.userAgent,
  };
  const localItem = {
    id: `local-${Date.now().toString(36)}`,
    time: new Date().toISOString(),
    op: op || 'Arayüz',
    target: target || meta.tabPath || '',
    message: String(message),
    stack: stack ? String(stack).slice(0, 4000) : '',
    meta,
  };
  localClientErrors.unshift(localItem);
  if (localClientErrors.length > 50) localClientErrors.length = 50;

  fetch('/api/errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'report',
      op: localItem.op,
      target: localItem.target,
      message: localItem.message,
      stack: localItem.stack,
      meta,
    }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (d && d.total !== undefined) updateErrorBadge({ total: d.total, unread: d.unread });
    })
    .catch(() => {
      updateErrorBadge({ total: localClientErrors.length, unread: localClientErrors.length });
    });
}

async function api(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' && !opts.noRetry ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const fetchOpts = {
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        ...opts,
      };
      if (!fetchOpts.signal && opts.timeoutMs > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        fetchOpts.signal = AbortSignal.timeout(opts.timeoutMs);
      }
      const res = await fetch(url, fetchOpts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || `HTTP ${res.status}`;
        if (res.status !== 500 && !opts.silentErrors && !String(url).startsWith('/api/errors')) {
          reportClientError(url, msg);
        }
        throw new Error(msg);
      }
      return data;
    } catch (err) {
      const isNetworkErr = err && (String(err.message || '').includes('Failed to fetch') || err.name === 'TimeoutError');
      if (isNetworkErr && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (err && err.name !== 'AbortError' && !opts.silentErrors && !String(url).startsWith('/api/errors') && !err.loggedClient) {
        if (isNetworkErr) {
          reportClientError(url, err.message);
        }
      }
      throw err;
    }
  }
}

// ---------- Özel Modal Prompt (native prompt() yok) ----------
function showPromptModal({ title, desc = '', fields = [], okText = 'Onayla' }) {
  return new Promise((resolve) => {
    const dlg = $('prompt-dialog');
    $('prompt-title').textContent = title;
    $('prompt-desc').textContent = desc;
    $('btn-prompt-ok').textContent = okText;

    const container = $('prompt-fields');
    container.innerHTML = '';
    for (const f of fields) {
      const lbl = document.createElement('label');
      lbl.textContent = f.label;
      const inp = document.createElement('input');
      inp.type = f.type || 'text';
      inp.name = f.name;
      inp.value = f.value ?? '';
      inp.placeholder = f.placeholder || '';
      container.appendChild(lbl);
      container.appendChild(inp);
    }

    let settled = false;
    const cleanup = (val) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(val);
    };

    $('btn-prompt-cancel').onclick = () => cleanup(null);
    $('prompt-form').onsubmit = (e) => {
      e.preventDefault();
      const result = {};
      for (const f of fields) {
        result[f.name] = container.querySelector(`[name="${f.name}"]`).value;
      }
      cleanup(result);
    };
    dlg.oncancel = () => cleanup(null);
    dlg.onclose = () => cleanup(null);
    dlg.showModal();
    const firstInp = container.querySelector('input');
    if (firstInp) {
      firstInp.focus();
      firstInp.select();
    }
  });
}

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

// ---------- Sol Menü Ağacı & Bu Bilgisayar Dashboard ----------
async function setTreeNodeExpanded(nodeEl, targetPath, depth, expand) {
  const twisty = nodeEl.querySelector(':scope > .tree-row .tree-twisty');
  const childrenEl = nodeEl.querySelector(':scope > .tree-children');
  if (!twisty || !childrenEl) return;

  if (!expand) {
    twisty.classList.remove('expanded');
    childrenEl.classList.add('hidden');
    state.expandedTreePaths.delete(targetPath);
    return;
  }

  twisty.classList.add('expanded');
  childrenEl.classList.remove('hidden');
  state.expandedTreePaths.add(targetPath);

  if (nodeEl.dataset.loaded !== '1') {
    childrenEl.innerHTML = `<div class="muted-text" style="padding:3px 0 3px ${26 + depth * 14}px;font-size:11px;">Yükleniyor...</div>`;
    try {
      const data = await api(`/api/subdirs?path=${encodeURIComponent(targetPath)}`);
      nodeEl.dataset.loaded = '1';
      childrenEl.innerHTML = '';
      if (!data.dirs || data.dirs.length === 0) {
        twisty.classList.remove('expanded');
        twisty.classList.add('empty');
        childrenEl.classList.add('hidden');
        state.expandedTreePaths.delete(targetPath);
        return;
      }
      for (const sub of data.dirs) {
        const childNode = createTreeNodeElement({
          name: sub.name,
          path: sub.path,
          iconHtml: '<span class="sb-icon">📁</span>',
          depth: depth + 1,
        });
        childrenEl.appendChild(childNode);
        if (state.expandedTreePaths.has(sub.path)) {
          setTreeNodeExpanded(childNode, sub.path, depth + 1, true);
        }
      }
      const tab = getActiveTab();
      if (tab) updateSidebarActive(tab.path);
    } catch {
      childrenEl.innerHTML = '';
      twisty.classList.remove('expanded');
    }
  }
}

function createTreeNodeElement({ name, path, iconHtml, extraHtml = '', unpinHandler = null, depth = 0 }) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.dataset.depth = String(depth);

  const row = document.createElement('div');
  row.className = 'sidebar-item tree-row';
  row.dataset.path = path;
  row.style.paddingLeft = `${6 + depth * 14}px`;
  row.title = path;
  row.innerHTML = `
    <button type="button" class="tree-twisty" title="Alt klasörleri aç/kapat">›</button>
    ${iconHtml}
    ${extraHtml || `<span class="sb-label">${esc(name)}</span>`}
    ${unpinHandler ? '<button type="button" class="sb-unpin" title="Sabitlemeyi Kaldır">✕</button>' : ''}
  `;

  const twisty = row.querySelector('.tree-twisty');
  twisty.onclick = (e) => {
    e.stopPropagation();
    const isExpanded = twisty.classList.contains('expanded');
    setTreeNodeExpanded(node, path, depth, !isExpanded);
  };

  row.onclick = (e) => {
    if (unpinHandler && e.target.classList.contains('sb-unpin')) {
      e.stopPropagation();
      unpinHandler();
      return;
    }
    navigateTo(path);
  };

  const children = document.createElement('div');
  children.className = 'tree-children hidden';

  node.appendChild(row);
  node.appendChild(children);
  return node;
}

function getDriveRoot(p) {
  const m = /^([a-zA-Z]:)/.exec(String(p || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function isCrossDriveTransfer(paths, targetDir) {
  const dstDrive = getDriveRoot(targetDir);
  if (!dstDrive || !Array.isArray(paths) || paths.length === 0) return false;
  return paths.some((p) => {
    const srcDrive = getDriveRoot(p);
    return srcDrive && srcDrive !== dstDrive;
  });
}

// Windows Dosya Gezgini kuralı: aynı diskte varsayılan Taşı, farklı diske varsayılan Kopyala
function resolveDragOp(paths, targetDir, ctrlKey = false, shiftKey = false) {
  if (isCrossDriveTransfer(paths, targetDir)) {
    return (shiftKey && !ctrlKey) ? 'move' : 'copy';
  }
  return ctrlKey ? 'copy' : 'move';
}

function loadRecentTransferTargets() {
  try {
    const raw = JSON.parse(localStorage.getItem('ld_recent_transfer_targets') || '[]');
    if (Array.isArray(raw)) {
      state.recentTransferTargets = raw.filter((x) => x && x.path).slice(0, 15);
    }
  } catch {
    state.recentTransferTargets = [];
  }
}

function saveRecentTransferTargets() {
  try {
    localStorage.setItem('ld_recent_transfer_targets', JSON.stringify((state.recentTransferTargets || []).slice(0, 15)));
  } catch {}
}

function recordRecentTransferTarget(destDir) {
  if (!destDir || destDir === 'PC' || destDir === 'TRASH') return;
  let clean = String(destDir).trim().replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(clean)) clean += '\\';
  const low = clean.toLowerCase();
  const list = (state.recentTransferTargets || []).filter((x) => String(x.path || '').toLowerCase() !== low);
  list.unshift({
    path: clean,
    name: getFolderTitle(clean) || clean,
    usedAt: Date.now(),
  });
  if (list.length > 15) list.length = 15;
  state.recentTransferTargets = list;
  saveRecentTransferTargets();
  renderRecentTransferTargets();
}

function renderRecentTransferTargets() {
  const listEl = $('sb-recent-targets-list');
  const cntEl = $('sb-recent-targets-count');
  const chevEl = $('sb-recent-targets-chevron');
  if (!listEl) return;

  const items = state.recentTransferTargets || [];
  if (cntEl) cntEl.textContent = String(items.length);
  if (chevEl) chevEl.textContent = state.recentTargetsOpen ? '▾' : '▸';
  listEl.classList.toggle('hidden', !state.recentTargetsOpen);

  listEl.innerHTML = '';
  if (items.length === 0) {
    listEl.innerHTML = '<div class="muted-text" style="padding:4px 10px;font-size:11.5px;">Henüz hedef klasör yok (dosya taşıdıkça/kopyaladıkça dolacak)</div>';
    return;
  }

  for (const entry of items) {
    const row = document.createElement('div');
    row.className = 'sidebar-item tree-row sb-recent-target-row';
    row.dataset.path = entry.path;
    row.title = `${entry.path}\n• Dosya bırak: Taşı / Farklı diske Kopyala\n• Tıkla: Klasörü aç`;
    row.innerHTML = `
      <span class="sb-icon">📁</span>
      <div class="sb-recent-target-meta">
        <span class="sb-label">${esc(entry.name || getFolderTitle(entry.path))}</span>
        <span class="sb-recent-target-sub">${esc(entry.path)}</span>
      </div>
      <button type="button" class="sb-unpin sb-recent-del-btn" title="Listeden çıkar">✕</button>
    `;
    row.onclick = (e) => {
      if (e.target.closest('.sb-recent-del-btn')) {
        e.stopPropagation();
        const low = String(entry.path).toLowerCase();
        state.recentTransferTargets = state.recentTransferTargets.filter((x) => String(x.path || '').toLowerCase() !== low);
        saveRecentTransferTargets();
        renderRecentTransferTargets();
        return;
      }
      navigateTo(entry.path);
    };
    listEl.appendChild(row);
  }
}

const DEFAULT_SMART_VIEWS = [
  { id: 'sv_vid_7d', icon: '🎬', name: 'Son 7 Gün Videoları', builtin: true, criteria: { category: 'video', withinDays: 7, sortBy: 'mtime' } },
  { id: 'sv_big_500mb', icon: '🐘', name: '500 MB+ Büyük Dosyalar', builtin: true, criteria: { minSize: 500 * 1024 * 1024, sortBy: 'size' } },
  { id: 'sv_img_30d', icon: '🖼️', name: 'Bu Ay Fotoğrafları', builtin: true, criteria: { category: 'image', withinDays: 30, sortBy: 'mtime' } },
];

function loadSmartViews() {
  let saved = null;
  try {
    const raw = JSON.parse(localStorage.getItem('ld_smart_views') || 'null');
    if (Array.isArray(raw) && raw.length > 0) saved = raw;
  } catch {}
  state.smartViews = saved || DEFAULT_SMART_VIEWS.map((x) => ({ ...x, criteria: { ...x.criteria } }));
  try {
    const openFlag = localStorage.getItem('ld_smart_views_open');
    if (openFlag === '0') state.smartViewsOpen = false;
  } catch {}
}

function saveSmartViews() {
  try {
    localStorage.setItem('ld_smart_views', JSON.stringify(state.smartViews || []));
  } catch {}
}

function renderSmartViewsSidebar() {
  const listEl = $('sb-smart-views-list');
  const cntEl = $('sb-smart-views-count');
  const chevEl = $('sb-smart-views-chevron');
  if (!listEl) return;
  const views = state.smartViews || [];
  if (cntEl) cntEl.textContent = String(views.length);
  if (chevEl) chevEl.textContent = state.smartViewsOpen ? '▾' : '▸';
  listEl.classList.toggle('hidden', !state.smartViewsOpen);
  listEl.innerHTML = '';

  for (const sv of views) {
    const row = document.createElement('div');
    row.className = `sb-smart-view-item${state.smartViewCtx && state.smartViewCtx.id === sv.id ? ' active' : ''}`;
    row.title = sv.name;
    row.innerHTML = `
      <span>${esc(sv.icon || '✨')}</span>
      <span class="sb-smart-view-name">${esc(sv.name)}</span>
    `;
    row.onclick = () => openSmartView(sv);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCustomContextMenu(e, [
        { label: '✨ Akıllı Klasörü Aç', bold: true, onClick: () => openSmartView(sv) },
        !sv.builtin ? { label: '🗑️ Akıllı Klasörden Kaldır', danger: true, onClick: () => {
          state.smartViews = state.smartViews.filter((x) => x.id !== sv.id);
          saveSmartViews();
          renderSmartViewsSidebar();
          if (state.smartViewCtx && state.smartViewCtx.id === sv.id) closeSmartView();
        } } : null,
      ]);
    };
    listEl.appendChild(row);
  }
}

async function openSmartView(sv) {
  if (!sv) return;
  const tab = getActiveTab();
  if (!tab) return;
  try {
    cancelPendingThumbs();
    state.thumbSessionId++;
    state.selectedPaths.clear();
    state.lastClickedIndex = -1;
    state.filterOnlyMatched = false;
    state.relatedCtx = null;
    state.smartViewCtx = sv;
    $('related-bar')?.classList.add('hidden');

    tab.viewType = 'explorer';
    $('analyzer-view').classList.add('hidden');
    $('pc-dashboard').classList.add('hidden');
    $('trash-bar').classList.add('hidden');
    $('explorer-view').classList.remove('hidden');

    const res = await api('/api/smart-view', {
      method: 'POST',
      body: JSON.stringify({ criteria: sv.criteria || {} }),
    });
    const bar = $('smart-view-bar');
    if (bar) bar.classList.remove('hidden');
    if ($('smart-view-title')) $('smart-view-title').textContent = `${sv.icon || '✨'} ${sv.name}`;
    const idxNote = (res.totalIndexed || 0) === 0
      ? ' • ⚠️ İndeks boş: üstteki ⚡ İndeksle butonuyla diski tarayın'
      : ` • ${res.items.length} öğe (${res.durationMs} ms)`;
    if ($('smart-view-summary')) $('smart-view-summary').textContent = `İndeksten Sanal Görünüm${idxNote}`;

    state.rawItems = res.items || [];
    renderSmartViewsSidebar();
    applySortAndFilter();
    updateStatusCounts();
    updateToolbarButtons();
    $('status-timing').textContent = `${res.durationMs} ms (sanal)`;
    if (state.thumbMode === 'viewport' || state.thumbMode === 'all') scheduleThumbBatch();
  } catch (err) {
    toast(`Akıllı klasör açılamadı: ${err.message}`, 'error');
  }
}

function closeSmartView() {
  state.smartViewCtx = null;
  $('smart-view-bar')?.classList.add('hidden');
  renderSmartViewsSidebar();
  const tab = getActiveTab();
  navigateTo(tab && tab.path ? tab.path : 'PC', { pushHistory: false, forceRefresh: false });
}

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

function renderSidebarAndDashboard() {
  renderSmartViewsSidebar();
  // Hızlı Erişim
  const qaList = $('quick-access-list');
  const qaGrid = $('quick-cards-grid');
  qaList.innerHTML = '';
  qaGrid.innerHTML = '';
  for (const q of state.quickAccess) {
    const icon = QUICK_ICONS[q.icon] || '📁';
    const node = createTreeNodeElement({
      name: q.name,
      path: q.path,
      iconHtml: `<span class="sb-icon">${icon}</span>`,
    });
    qaList.appendChild(node);
    if (state.expandedTreePaths.has(q.path)) setTreeNodeExpanded(node, q.path, 0, true);

    const card = document.createElement('div');
    card.className = 'quick-card';
    card.dataset.path = q.path;
    card.innerHTML = `<span style="font-size:20px">${icon}</span><span>${esc(q.name)}</span>`;
    card.onclick = () => navigateTo(q.path);
    qaGrid.appendChild(card);
  }
  const trashCard = document.createElement('div');
  trashCard.className = 'quick-card';
  trashCard.dataset.path = 'TRASH';
  trashCard.innerHTML = `<span style="font-size:20px">🗑️</span><span>Çöp Kutusu</span>`;
  trashCard.onclick = () => navigateTo('TRASH');
  qaGrid.appendChild(trashCard);
  const qCnt = $('cnt-sec-quick');
  if (qCnt) qCnt.textContent = String(state.quickAccess.length + 1);
  renderRecentDashboardSections();
  applyDashSectionVisibility();

  // Sabitlenenler
  const pinsList = $('pins-list');
  pinsList.innerHTML = '';
  if (state.pins.length === 0) {
    pinsList.innerHTML = '<div class="muted-text" style="padding:4px 10px;font-size:11.5px;">Henüz sabitlenen yok</div>';
  } else {
    for (const pin of state.pins) {
      const node = createTreeNodeElement({
        name: pin.name,
        path: pin.path,
        iconHtml: '<span class="sb-icon">📌</span>',
        unpinHandler: () => togglePin(pin.path, pin.name, true),
      });
      pinsList.appendChild(node);
      if (state.expandedTreePaths.has(pin.path)) setTreeNodeExpanded(node, pin.path, 0, true);
    }
  }

  // Sürücüler (Sidebar Ağaç + Bu Bilgisayar)
  const sbDrives = $('sidebar-drives-list');
  const dGrid = $('drives-grid');
  sbDrives.innerHTML = '';
  dGrid.innerHTML = '';

  for (const d of state.drives) {
    const isHigh = d.usedPercent >= 85;
    const node = createTreeNodeElement({
      name: `${d.label} (${d.id})`,
      path: d.path,
      iconHtml: '<span class="sb-icon">💽</span>',
      extraHtml: `
        <div class="sb-drive-meta">
          <span class="sb-label">${esc(d.label)} (${esc(d.id)})</span>
          <div class="sb-mini-bar"><div class="sb-mini-fill ${isHigh ? 'high' : ''}" style="width:${d.usedPercent}%"></div></div>
        </div>`,
    });
    sbDrives.appendChild(node);
    if (state.expandedTreePaths.has(d.path)) setTreeNodeExpanded(node, d.path, 0, true);

    const card = document.createElement('div');
    card.className = 'drive-card';
    card.innerHTML = `
      <div class="drive-top">
        <span class="drive-icon">💽</span>
        <div class="drive-info">
          <div class="drive-name">${esc(d.label)} (${esc(d.id)})</div>
          <div class="drive-bar"><div class="drive-bar-fill ${isHigh ? 'high' : ''}" style="width:${d.usedPercent}%"></div></div>
          <div class="drive-sub">${formatBytes(d.free)} boş, ${formatBytes(d.total)} toplam (%${d.usedPercent} dolu)</div>
        </div>
      </div>
      <div class="drive-actions">
        <button class="mini-pill-btn btn-card-analyze">📊 Neler Dolduruyor?</button>
        <button class="mini-pill-btn btn-card-index">⚡ İndeksle</button>
      </div>`;
    card.onclick = (e) => {
      if (e.target.classList.contains('btn-card-analyze')) {
        e.stopPropagation();
        openAnalyzer(d.path);
        return;
      }
      if (e.target.classList.contains('btn-card-index')) {
        e.stopPropagation();
        startBackgroundIndex(d.path);
        return;
      }
      navigateTo(d.path);
    };
    dGrid.appendChild(card);
  }

  renderRecentTransferTargets();

  // Çift Panel hızlı hedef seçici
  const dualSel = $('dual-quick-select');
  if (dualSel) {
    dualSel.innerHTML = '<option value="">Hızlı Git...</option>';
    for (const d of state.drives) {
      const opt = document.createElement('option');
      opt.value = d.path;
      opt.textContent = `${d.label} (${d.id})`;
      dualSel.appendChild(opt);
    }
    for (const q of state.quickAccess) {
      const opt = document.createElement('option');
      opt.value = q.path;
      opt.textContent = q.name;
      dualSel.appendChild(opt);
    }
  }
}

function updateSidebarActive(currentPath) {
  const norm = (currentPath || '').toLowerCase();
  document.querySelectorAll('.sidebar-item').forEach((el) => {
    const p = (el.dataset.path || '').toLowerCase();
    el.classList.toggle('active', p === norm);
  });
}

// ---------- Sıralama & Filtreleme Motoru ----------
function getFilterCriteria() {
  const pattern = $('flt-pattern').value.trim();
  const isRegex = $('flt-regex').checked;
  const numMinRaw = $('flt-num-min').value;
  const numMaxRaw = $('flt-num-max').value;
  const dateMinRaw = $('flt-date-min').value;
  const dateMaxRaw = $('flt-date-max').value;
  const sizeMinRaw = $('flt-size-min').value;
  const sizeMaxRaw = $('flt-size-max').value;
  const category = $('flt-category').value;
  const extRaw = $('flt-ext').value.trim();
  const rowMinRaw = $('flt-row-min').value;
  const rowMaxRaw = $('flt-row-max').value;

  let regexObj = null;
  if (pattern) {
    if (isRegex) {
      regexObj = new RegExp(pattern, 'i');
    } else if (/[*?]/.test(pattern)) {
      const escPat = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      regexObj = new RegExp(`^${escPat}$`, 'i');
    }
  }

  const extSet = extRaw
    ? new Set(
        extRaw
          .split(',')
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
          .map((x) => (x.startsWith('.') ? x : `.${x}`))
      )
    : null;

  return {
    pattern,
    isRegex,
    regexObj,
    numMin: numMinRaw !== '' ? Number(numMinRaw) : null,
    numMax: numMaxRaw !== '' ? Number(numMaxRaw) : null,
    dateMin: dateMinRaw ? new Date(dateMinRaw + 'T00:00:00').getTime() : null,
    dateMax: dateMaxRaw ? new Date(dateMaxRaw + 'T23:59:59.999').getTime() : null,
    sizeMin: sizeMinRaw !== '' ? Number(sizeMinRaw) * Number($('flt-size-min-unit').value) : null,
    sizeMax: sizeMaxRaw !== '' ? Number(sizeMaxRaw) * Number($('flt-size-max-unit').value) : null,
    category,
    extSet,
    rowMin: rowMinRaw !== '' ? Number(rowMinRaw) : null,
    rowMax: rowMaxRaw !== '' ? Number(rowMaxRaw) : null,
  };
}

function itemMatchesCriteria(item, rowIndex1Based, c) {
  if (c.pattern) {
    if (c.regexObj) {
      if (!c.regexObj.test(item.name)) return false;
    } else if (!item.name.toLowerCase().includes(c.pattern.toLowerCase())) {
      return false;
    }
  }
  if (c.numMin !== null || c.numMax !== null) {
    const nums = item.name.match(/\d+/g);
    if (!nums) return false;
    // Dosya adındaki son veya herhangi bir sayı aralığa giriyor mu kontrol et
    const ok = nums.some((nStr) => {
      const n = Number(nStr);
      if (c.numMin !== null && n < c.numMin) return false;
      if (c.numMax !== null && n > c.numMax) return false;
      return true;
    });
    if (!ok) return false;
  }
  if (c.dateMin !== null && item.mtime < c.dateMin) return false;
  if (c.dateMax !== null && item.mtime > c.dateMax) return false;
  if (c.sizeMin !== null && (item.isDir || item.size < c.sizeMin)) return false;
  if (c.sizeMax !== null && (item.isDir || item.size > c.sizeMax)) return false;
  if (c.category !== 'all' && item.category !== c.category) return false;
  if (c.extSet && !c.extSet.has((item.ext || '').toLowerCase())) return false;
  if (c.rowMin !== null && rowIndex1Based < c.rowMin) return false;
  if (c.rowMax !== null && rowIndex1Based > c.rowMax) return false;
  return true;
}

// ---------- Sütun Genişlikleri, Klasöre Özel Görünüm & Başlık Filtreleri ----------
const COL_LIMITS = {
  name: { cssVar: '--col-name', def: 'minmax(220px, 1fr)', min: 120, max: 1400 },
  mtime: { cssVar: '--col-date', def: '150px', min: 100, max: 420 },
  ext: { cssVar: '--col-type', def: '110px', min: 70, max: 360 },
  size: { cssVar: '--col-size', def: '95px', min: 65, max: 280 },
};

function applyColumnWidths() {
  const rootStyle = document.documentElement.style;
  for (const [col, meta] of Object.entries(COL_LIMITS)) {
    const val = state.colWidths[col];
    if (Number.isFinite(val) && val >= meta.min && val <= meta.max) {
      rootStyle.setProperty(meta.cssVar, `${Math.round(val)}px`);
    } else {
      rootStyle.setProperty(meta.cssVar, meta.def);
    }
  }
  const hasExplicitName = Number.isFinite(state.colWidths.name)
    && state.colWidths.name >= COL_LIMITS.name.min
    && state.colWidths.name <= COL_LIMITS.name.max;
  if (hasExplicitName) {
    const datePx = (Number.isFinite(state.colWidths.mtime) && state.colWidths.mtime >= COL_LIMITS.mtime.min)
      ? state.colWidths.mtime : 150;
    const typePx = (Number.isFinite(state.colWidths.ext) && state.colWidths.ext >= COL_LIMITS.ext.min)
      ? state.colWidths.ext : 110;
    const sizePx = (Number.isFinite(state.colWidths.size) && state.colWidths.size >= COL_LIMITS.size.min)
      ? state.colWidths.size : 95;
    // padding (10+10) + chk (32) + eye (40) = 92 px
    const totalRowWidth = Math.round(92 + state.colWidths.name + datePx + typePx + sizePx);
    rootStyle.setProperty('--list-row-width', `${totalRowWidth}px`);
  } else {
    rootStyle.setProperty('--list-row-width', '100%');
  }
}

function saveColumnWidths() {
  try {
    localStorage.setItem('ld_col_widths', JSON.stringify(state.colWidths));
  } catch {}
}

function loadColumnWidths() {
  try {
    const raw = JSON.parse(localStorage.getItem('ld_col_widths') || 'null');
    if (raw && typeof raw === 'object') {
      for (const col of Object.keys(COL_LIMITS)) {
        const n = Number(raw[col]);
        state.colWidths[col] = (raw[col] !== null && Number.isFinite(n)) ? n : null;
      }
    }
  } catch {}
  applyColumnWidths();
}

function resetColumnWidths() {
  state.colWidths = { name: null, mtime: null, ext: null, size: null };
  saveColumnWidths();
  applyColumnWidths();
  toast('Liste sütun genişlikleri varsayılana sıfırlandı', 'success');
}

function setupListColumnResizers() {
  document.querySelectorAll('#list-header .lh-resizer[data-col]').forEach((handle) => {
    const col = handle.dataset.col;
    const meta = COL_LIMITS[col];
    if (!meta) return;

    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.colWidths[col] = null;
      saveColumnWidths();
      applyColumnWidths();
      state.suppressHeaderSortUntil = Date.now() + 250;
    });

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const cell = handle.closest('.lh-cell');
      if (!cell) return;
      const startX = e.clientX;
      const startWidth = cell.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('col-resizing');

      const onMove = (mv) => {
        const nextW = Math.max(meta.min, Math.min(meta.max, Math.round(startWidth + (mv.clientX - startX))));
        state.colWidths[col] = nextW;
        applyColumnWidths();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        handle.classList.remove('dragging');
        document.body.classList.remove('col-resizing');
        state.suppressHeaderSortUntil = Date.now() + 250;
        saveColumnWidths();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  });
}

function normalizeFolderKey(p) {
  if (!p) return '';
  let clean = String(p).trim().replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(clean)) clean += '\\';
  return clean.toLowerCase();
}

function loadFolderViews() {
  try {
    const raw = JSON.parse(localStorage.getItem('ld_folder_views') || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      state.folderViews = raw;
    }
  } catch {
    state.folderViews = {};
  }
}

function saveFolderViews() {
  try {
    const keys = Object.keys(state.folderViews);
    if (keys.length > 500) {
      const trimmed = {};
      for (const k of keys.slice(-500)) trimmed[k] = state.folderViews[k];
      state.folderViews = trimmed;
    }
    localStorage.setItem('ld_folder_views', JSON.stringify(state.folderViews));
  } catch {}
}

function applyViewModeForFolder(folderPath) {
  const sel = $('view-mode');
  const isValidMode = (vm) => Boolean(vm && sel && sel.querySelector(`option[value="${vm}"]`));
  let nextMode = null;

  if (state.settings.rememberFolderView !== false && folderPath && folderPath !== 'PC' && folderPath !== 'TRASH') {
    const remembered = state.folderViews[normalizeFolderKey(folderPath)];
    if (isValidMode(remembered)) nextMode = remembered;
  }
  if (!nextMode) {
    const def = state.settings.defaultViewMode;
    if (def && def !== 'last' && isValidMode(def)) {
      nextMode = def;
    } else if (isValidMode(state.globalViewMode)) {
      nextMode = state.globalViewMode;
    } else {
      nextMode = 'list';
    }
  }
  state.viewMode = nextMode;
  if (sel) sel.value = nextMode;
}

function hasActiveColFilters() {
  return Object.values(state.colFilters).some((s) => s && s.size > 0);
}

function clearColFilters(col = null) {
  if (col && state.colFilters[col]) {
    state.colFilters[col].clear();
  } else {
    for (const set of Object.values(state.colFilters)) set.clear();
  }
  updateListHeaderIndicators();
  applySortAndFilter();
}

function updateListHeaderIndicators() {
  document.querySelectorAll('#list-header .lh-cell[data-sort]').forEach((cell) => {
    const col = cell.dataset.col || cell.dataset.sort;
    const arrow = cell.querySelector('.lh-sort-arrow');
    if (arrow) {
      arrow.textContent = state.sortBy === cell.dataset.sort ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
    }
    const btn = cell.querySelector('.lh-filter-btn');
    if (btn && state.colFilters[col]) {
      btn.classList.toggle('active', state.colFilters[col].size > 0);
    }
  });
}

function getNameBucketKey(name) {
  const ch = String(name || '').trim().charAt(0).toLocaleLowerCase('tr-TR');
  if (!ch || !/[a-zçğıİöşü]/i.test(ch)) return '0-9';
  if ('abcdefç'.includes(ch)) return 'A-F';
  if ('gğhıijk'.includes(ch)) return 'G-K';
  if ('lmnoöprs'.includes(ch)) return 'L-R';
  return 'S-Z';
}

function getDateBucketKey(ts) {
  if (!ts || ts <= 0) return 'older';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startToday) return 'today';
  if (ts >= startToday - 7 * 86400000) return 'week';
  if (ts >= startToday - 30 * 86400000) return 'month';
  if (ts >= new Date(now.getFullYear(), 0, 1).getTime()) return 'year';
  return 'older';
}

function getTypeBucketKey(item) {
  if (item.isDir) return 'FOLDER';
  return (item.ext || '').toLowerCase() || 'NONE';
}

function getSizeBucketKey(item) {
  const s = item.size || 0;
  if (s === 0) return 'empty';
  if (s < 100 * 1024) return 'tiny';
  if (s < 1024 * 1024) return 'small';
  if (s < 100 * 1024 * 1024) return 'medium';
  if (s < 1024 * 1024 * 1024) return 'large';
  return 'huge';
}

function itemMatchesColFilters(item) {
  if (state.colFilters.name.size > 0 && !state.colFilters.name.has(getNameBucketKey(item.name))) return false;
  if (state.colFilters.mtime.size > 0 && !state.colFilters.mtime.has(getDateBucketKey(item.mtime))) return false;
  if (state.colFilters.ext.size > 0 && !state.colFilters.ext.has(getTypeBucketKey(item))) return false;
  if (state.colFilters.size.size > 0 && !state.colFilters.size.has(getSizeBucketKey(item))) return false;
  return true;
}

function closeColFilterPopover() {
  const pop = $('col-filter-popover');
  state.activeFilterCol = null;
  if (pop && typeof pop.hidePopover === 'function') {
    try {
      if (pop.matches(':popover-open')) pop.hidePopover();
    } catch {}
  }
}

function buildColumnFilterOptions(col) {
  const items = state.rawItems || [];
  const counts = new Map();
  if (col === 'name') {
    for (const it of items) {
      const k = getNameBucketKey(it.name);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [
      { key: '0-9', label: '0 – 9 / Semboller' },
      { key: 'A-F', label: 'A – F' },
      { key: 'G-K', label: 'G – K' },
      { key: 'L-R', label: 'L – R' },
      { key: 'S-Z', label: 'S – Z' },
    ].map((o) => ({ ...o, count: counts.get(o.key) || 0 })).filter((o) => o.count > 0 || state.colFilters.name.has(o.key));
  }
  if (col === 'mtime') {
    for (const it of items) {
      const k = getDateBucketKey(it.mtime);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return [
      { key: 'today', label: 'Bugün' },
      { key: 'week', label: 'Son 7 gün' },
      { key: 'month', label: 'Son 30 gün' },
      { key: 'year', label: 'Bu yıl' },
      { key: 'older', label: 'Daha eski' },
    ].map((o) => ({ ...o, count: counts.get(o.key) || 0 })).filter((o) => o.count > 0 || state.colFilters.mtime.has(o.key));
  }
  if (col === 'ext') {
    for (const it of items) {
      const k = getTypeBucketKey(it);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => {
        if (a[0] === 'FOLDER') return -1;
        if (b[0] === 'FOLDER') return 1;
        return b[1] - a[1] || a[0].localeCompare(b[0]);
      })
      .map(([key, count]) => ({
        key,
        label: key === 'FOLDER' ? '📁 Dosya klasörü' : (key === 'NONE' ? 'Uzantısız Dosya' : key.toUpperCase().replace('.', '')),
        count,
      }));
  }
  for (const it of items) {
    const k = getSizeBucketKey(it);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [
    { key: 'empty', label: 'Boş / Hesaplanmamış (0 B)' },
    { key: 'tiny', label: 'Çok küçük (< 100 KB)' },
    { key: 'small', label: 'Küçük (100 KB – 1 MB)' },
    { key: 'medium', label: 'Orta (1 MB – 100 MB)' },
    { key: 'large', label: 'Büyük (100 MB – 1 GB)' },
    { key: 'huge', label: 'Çok büyük (> 1 GB)' },
  ].map((o) => ({ ...o, count: counts.get(o.key) || 0 })).filter((o) => o.count > 0 || state.colFilters.size.has(o.key));
}

function openColFilterPopover(col, anchorBtn) {
  const pop = $('col-filter-popover');
  if (!pop || !anchorBtn) return;

  if (state.activeFilterCol === col && pop.matches(':popover-open')) {
    closeColFilterPopover();
    return;
  }

  state.activeFilterCol = col;
  const sortLabels = {
    name: ['A → Z (Artan)', 'Z → A (Azalan)'],
    mtime: ['Eskiden Yeniye', 'Yeniden Eskiye'],
    ext: ['Türe Göre (A → Z)', 'Türe Göre (Z → A)'],
    size: ['Küçükten Büyüğe', 'Büyükten Küçüğe'],
  };
  const labels = sortLabels[col] || ['Artan', 'Azalan'];
  const opts = buildColumnFilterOptions(col);
  const selectedSet = state.colFilters[col];

  pop.innerHTML = `
    <div class="cfp-sort-group">
      <button type="button" class="cfp-sort-btn ${state.sortBy === col && state.sortDir === 'asc' ? 'active' : ''}" data-sort-dir="asc">
        <span>${esc(labels[0])}</span><span>▲</span>
      </button>
      <button type="button" class="cfp-sort-btn ${state.sortBy === col && state.sortDir === 'desc' ? 'active' : ''}" data-sort-dir="desc">
        <span>${esc(labels[1])}</span><span>▼</span>
      </button>
    </div>
    <div class="cfp-sep"></div>
    <div class="cfp-list">
      ${opts.length === 0 ? '<div class="muted-text" style="padding:6px 8px;">Filtrelenecek öğe yok.</div>' : opts.map((o) => `
        <label class="cfp-opt">
          <input type="checkbox" value="${esc(o.key)}" ${selectedSet.has(o.key) ? 'checked' : ''} />
          <span class="cfp-opt-label">${esc(o.label)}</span>
          <span class="cfp-count">${o.count}</span>
        </label>
      `).join('')}
    </div>
    <div class="cfp-sep"></div>
    <div class="cfp-footer">
      <button type="button" class="cmd-btn" data-act="clear-col" ${selectedSet.size === 0 ? 'disabled' : ''}>Bu Sütunu Temizle</button>
      ${hasActiveColFilters() ? '<button type="button" class="cmd-btn danger-hover" data-act="clear-all">Tümünü Sıfırla</button>' : ''}
    </div>
  `;

  pop.querySelectorAll('.cfp-sort-btn').forEach((btn) => {
    btn.onclick = () => {
      state.sortBy = col;
      state.sortDir = btn.dataset.sortDir;
      $('sort-by').value = col;
      $('btn-sort-dir').textContent = state.sortDir === 'asc' ? '▲' : '▼';
      saveUiPrefs();
      applySortAndFilter();
      closeColFilterPopover();
    };
  });

  pop.querySelectorAll('.cfp-opt input[type="checkbox"]').forEach((chk) => {
    chk.onchange = () => {
      if (chk.checked) selectedSet.add(chk.value);
      else selectedSet.delete(chk.value);
      const clrCol = pop.querySelector('[data-act="clear-col"]');
      if (clrCol) clrCol.disabled = selectedSet.size === 0;
      applySortAndFilter();
    };
  });

  const btnClrCol = pop.querySelector('[data-act="clear-col"]');
  if (btnClrCol) {
    btnClrCol.onclick = () => {
      clearColFilters(col);
      closeColFilterPopover();
    };
  }
  const btnClrAll = pop.querySelector('[data-act="clear-all"]');
  if (btnClrAll) {
    btnClrAll.onclick = () => {
      clearColFilters(null);
      closeColFilterPopover();
    };
  }

  pop.style.left = '-9999px';
  pop.style.top = '-9999px';
  pop.showPopover();

  const rect = anchorBtn.getBoundingClientRect();
  const pw = pop.offsetWidth || 230;
  const ph = pop.offsetHeight || 240;
  const left = Math.max(8, Math.min(window.innerWidth - pw - 8, rect.right - pw));
  const top = Math.max(8, Math.min(window.innerHeight - ph - 8, rect.bottom + 4));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function sortItemsArray(arr) {
  const by = state.sortBy;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const foldersFirst = state.settings.foldersFirst !== false;
  return arr.slice().sort((a, b) => {
    if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (by === 'name') cmp = naturalCollator.compare(a.name, b.name);
    else if (by === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (by === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0);
    else if (by === 'ctime') cmp = (a.ctime || 0) - (b.ctime || 0);
    else if (by === 'ext') cmp = naturalCollator.compare(a.ext || '', b.ext || '');
    if (cmp === 0) cmp = naturalCollator.compare(a.name, b.name);
    return cmp * dir;
  });
}

function applySortAndFilter() {
  let list = sortItemsArray(state.rawItems);

  // Hızlı arama kutusu (Bu Klasör modu)
  const q = state.searchQuery.trim().toLowerCase();
  if (q && $('search-scope').value === 'folder') {
    list = list.filter((it) => it.name.toLowerCase().includes(q));
  }

  // Başlık çentik sütun filtreleri
  if (hasActiveColFilters()) {
    list = list.filter(itemMatchesColFilters);
  }

  // Gelişmiş Aralık Stüdyosu filtresi
  if (state.filterOnlyMatched) {
    try {
      const crit = getFilterCriteria();
      list = list.filter((it, idx) => itemMatchesCriteria(it, idx + 1, crit));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('btn-flt-clear-view').classList.toggle('hidden', !state.filterOnlyMatched && !hasActiveColFilters());
  updateListHeaderIndicators();

  state.viewItems = list;
  updateStudioMatchPreview();
  renderVirtualList();
  updateStatusCounts();
}

function getMatchedStudioItems() {
  try {
    const crit = getFilterCriteria();
    return state.viewItems.filter((it, idx) => itemMatchesCriteria(it, idx + 1, crit));
  } catch (err) {
    return [];
  }
}

function updateStudioMatchPreview() {
  if ($('range-studio').classList.contains('hidden')) return;
  try {
    const crit = getFilterCriteria();
    const matched = state.viewItems.filter((it, idx) => itemMatchesCriteria(it, idx + 1, crit));
    let totalBytes = 0;
    for (const m of matched) totalBytes += m.size || 0;
    $('studio-match-summary').textContent = `${matched.length} öğe eşleşti (${formatBytes(totalBytes)})`;
  } catch (err) {
    $('studio-match-summary').textContent = `Hata: ${err.message}`;
  }
}

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

function formatDisplayName(item) {
  if (!item || state.settings.showExtensions !== false || item.isDir || !item.ext) return item?.name || '';
  const name = String(item.name || '');
  const ext = String(item.ext || '');
  if (ext && name.toLowerCase().endsWith(ext.toLowerCase()) && name.length > ext.length) {
    return name.slice(0, name.length - ext.length);
  }
  return name;
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
    : source.filter((it) => !it.isDir && (it.category === 'image' || it.category === 'video' || it.category === 'audio'));
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

function formatTrimTime(sec) {
  const clean = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(clean / 60);
  const rem = clean - mins * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${String(mins).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenths}`;
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

const MONTH_NAMES_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const GENERIC_REL_WORDS = new Set(['vid', 'img', 'dsc', 'dcim', 'pxl', 'mvimg', 'wa', 'snap', 'screenshot', 'screen', 'recording', 'rec', 'video', 'photo', 'foto', 'resim', 'image', 'copy', 'kopya', 'mp4', 'jpg', 'jpeg', 'png', 'mov', 'mkv', 'webm']);

function parseClientRefTime(item) {
  const name = String(item?.name || '');
  let m = /(?:^|[^\d])((?:199\d|20\d\d))(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_\-\s]?([01]\d|2[0-3])([0-5]\d)([0-5]\d)(?:[^\d]|$)/.exec(name);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  m = /(?:^|[^\d])((?:199\d|20\d\d))[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/.exec(name);
  if (m && !(item?.mtime > 0)) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0).getTime();
  return item?.mtime || Date.now();
}

function getClientNameTokensPreview(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const spaced = stem.replace(/([a-zçğıöşü])([A-ZÇĞİÖŞÜ])/g, '$1 $2');
  const words = spaced.toLocaleLowerCase('tr-TR').split(/[^a-zçğıöşü0-9]+/i).filter((w) => {
    if (w.length < 3) return false;
    if (GENERIC_REL_WORDS.has(w) || GENERIC_REL_WORDS.has(w.replace(/ı/g, 'i'))) return false;
    if (/^\d+$/.test(w) && (w.length < 8 || w.length === 6)) return false;
    return true;
  });
  return Array.from(new Set(words)).slice(0, 5);
}

function openRelatedDialog(item) {
  if (!item || item.isDir) return;
  const dlg = $('related-dialog');
  if (!dlg) return;
  dlg._targetItem = item;
  const refMs = parseClientRefTime(item);
  const dt = new Date(refMs);
  const dateStr = dt.toLocaleDateString('tr-TR');
  const timeStr = dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const tokens = getClientNameTokensPreview(item.name);

  $('related-dlg-sub').textContent = `${item.name} • Tarih: ${dateStr} ${timeStr}`;
  $('rel-desc-nearTime').textContent = `${dateStr} • ${timeStr} civarı (±1 saat)`;
  $('rel-desc-sameDay').textContent = `${dateStr} günündeki tüm kayıtlar`;
  $('rel-desc-sameWeek').textContent = `${dateStr} merkezli ±3 gün aralığı`;
  $('rel-desc-sameMonth').textContent = `${MONTH_NAMES_TR[dt.getMonth()]} ${dt.getFullYear()} ayındaki dosyalar`;
  $('rel-desc-similarName').textContent = tokens.length > 0
    ? `Anahtar kelimeler: ${tokens.join(', ')}`
    : `Dosya adı başlangıcıyla eşleşen seri dosyalar`;

  if (state.relatedCtx) {
    if ($('rel-dlg-scope')) $('rel-dlg-scope').value = state.relatedCtx.scope || 'folder';
    if ($('rel-dlg-cat')) $('rel-dlg-cat').value = state.relatedCtx.sameCategoryOnly || 'media';
  }
  if (!dlg.open) dlg.showModal();
}

function updateRelatedBarUi() {
  const bar = $('related-bar');
  const ctx = state.relatedCtx;
  if (!bar) return;
  if (!ctx) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const modeNames = {
    nearTime: '±1 Saat',
    sameDay: 'Aynı Gün',
    sameWeek: '±3 Gün',
    sameMonth: 'Aynı Ay',
    similarName: 'Benzer İsim',
  };
  $('related-bar-title').textContent = `✨ ${ctx.item.name}`;
  $('related-bar-summary').textContent = `${modeNames[ctx.mode] || ctx.mode} • ${state.rawItems.length} eşleşme (${ctx.durationMs || 0} ms)`;
  bar.querySelectorAll('.rel-mode-btn[data-rel-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.relMode === ctx.mode);
  });
  if ($('related-bar-scope')) $('related-bar-scope').value = ctx.scope;
  if ($('related-bar-cat')) $('related-bar-cat').value = ctx.sameCategoryOnly;
}

async function runRelatedSearch({ item, mode = 'sameDay', scope = 'folder', sameCategoryOnly = 'media' }) {
  if (!item || item.isDir) return;
  const relDlg = $('related-dialog');
  if (relDlg && relDlg.open) relDlg.close();
  if ($('quicklook-dialog')?.open) closeQuickLook();

  const tab = getActiveTab();
  const returnPath = (state.relatedCtx && state.relatedCtx.returnPath) || (tab && tab.path) || 'PC';

  $('pc-dashboard').classList.add('hidden');
  $('analyzer-view').classList.add('hidden');
  $('trash-bar').classList.add('hidden');
  $('explorer-view').classList.remove('hidden');

  try {
    const data = await api('/api/related', {
      method: 'POST',
      body: JSON.stringify({
        filePath: item.path,
        fileName: item.name,
        mtime: item.mtime,
        category: item.category,
        mode,
        scope,
        sameCategoryOnly,
      }),
    });
    state.relatedCtx = {
      item,
      mode,
      scope: data.scopeUsed || scope,
      sameCategoryOnly,
      returnPath,
      durationMs: data.durationMs || 0,
    };
    state.rawItems = data.items || [];
    state.selectedPaths.clear();
    state.selectedPaths.add(item.path);
    updateRelatedBarUi();
    applySortAndFilter();
    updateToolbarButtons();
    const vp = $('virtual-viewport');
    if (vp) vp.scrollTop = 0;
    if (state.thumbMode === 'viewport' || state.thumbMode === 'all') scheduleThumbBatch();
    $('status-timing').textContent = `${data.durationMs} ms (${data.source === 'sqlite' ? 'SQLite İndeks' : 'Canlı Klasör'})`;
    if (data.fallbackNotice) toast(data.fallbackNotice, 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function exitRelatedMode() {
  const ctx = state.relatedCtx;
  state.relatedCtx = null;
  $('related-bar')?.classList.add('hidden');
  if (ctx && ctx.returnPath && ctx.returnPath !== 'PC' && ctx.returnPath !== 'TRASH') {
    navigateTo(ctx.returnPath, { pushHistory: false, forceRefresh: false });
  } else {
    const tab = getActiveTab();
    navigateTo(tab ? tab.path : 'PC', { pushHistory: false });
  }
}

function bindRelatedHandlers() {
  const btnToolbarRel = $('btn-find-related');
  if (btnToolbarRel) {
    btnToolbarRel.onclick = () => {
      const sel = getSelectedItems();
      if (sel.length === 1 && !sel[0].isDir) openRelatedDialog(sel[0]);
    };
  }
  const btnDlgClose = $('btn-rel-dlg-close');
  if (btnDlgClose) btnDlgClose.onclick = () => $('related-dialog').close();

  document.querySelectorAll('#related-dialog .rel-card[data-rel-pick]').forEach((card) => {
    card.onclick = () => {
      const dlg = $('related-dialog');
      const item = dlg && dlg._targetItem;
      if (!item) return;
      runRelatedSearch({
        item,
        mode: card.dataset.relPick,
        scope: $('rel-dlg-scope')?.value || 'folder',
        sameCategoryOnly: $('rel-dlg-cat')?.value || 'media',
      });
    };
  });

  document.querySelectorAll('#related-bar .rel-mode-btn[data-rel-mode]').forEach((btn) => {
    btn.onclick = () => {
      if (!state.relatedCtx) return;
      runRelatedSearch({
        item: state.relatedCtx.item,
        mode: btn.dataset.relMode,
        scope: $('related-bar-scope')?.value || state.relatedCtx.scope,
        sameCategoryOnly: $('related-bar-cat')?.value || state.relatedCtx.sameCategoryOnly,
      });
    };
  });
  const barScope = $('related-bar-scope');
  if (barScope) {
    barScope.onchange = () => {
      if (!state.relatedCtx) return;
      runRelatedSearch({
        item: state.relatedCtx.item,
        mode: state.relatedCtx.mode,
        scope: barScope.value,
        sameCategoryOnly: $('related-bar-cat')?.value || state.relatedCtx.sameCategoryOnly,
      });
    };
  }
  const barCat = $('related-bar-cat');
  if (barCat) {
    barCat.onchange = () => {
      if (!state.relatedCtx) return;
      runRelatedSearch({
        item: state.relatedCtx.item,
        mode: state.relatedCtx.mode,
        scope: $('related-bar-scope')?.value || state.relatedCtx.scope,
        sameCategoryOnly: barCat.value,
      });
    };
  }
  const btnBarClose = $('btn-related-close');
  if (btnBarClose) btnBarClose.onclick = exitRelatedMode;
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

// ---------- Dosya İşlemleri & Sıralı Transfer ----------
async function openExternally(filePath) {
  try {
    const matched = state.viewItems.find((x) => x.path === filePath) || state.dualItems.find((x) => x.path === filePath);
    recordRecentFile(matched || filePath);
    const fileName = String(filePath || '').split(/[/\\]/).pop() || filePath;
    if (/\.(bat|cmd|ps1|exe|msi)$/i.test(fileName)) {
      toast(`🚀 Çalıştırılıyor: ${fileName}`);
    }
    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
      window.chrome.webview.postMessage({ type: 'openExternal', path: filePath });
      return;
    }
    await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'open', path: filePath }) });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function createNewFolder() {
  const tab = getActiveTab();
  if (!tab || tab.path === 'PC') return;
  const res = await showPromptModal({
    title: 'Yeni Klasör Oluştur',
    fields: [{ name: 'name', label: 'Klasör Adı', value: 'Yeni Klasör' }],
    okText: 'Oluştur',
  });
  if (!res || !res.name.trim()) return;
  try {
    const actRes = await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'mkdir', parentDir: tab.path, name: res.name.trim() }) });
    if (actRes.undoSummary) updateUndoButton(actRes.undoSummary);
    navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameSelected(overrideItems = null) {
  const sel = overrideItems || getSelectedItems();
  if (sel.length === 0) return;
  if (sel.length > 1) return batchRenameSelected(sel);

  const item = sel[0];
  const res = await showPromptModal({
    title: 'Yeniden Adlandır',
    fields: [{ name: 'newName', label: 'Yeni Ad', value: item.name }],
    okText: 'Kaydet',
  });
  if (!res || !res.newName.trim() || res.newName.trim() === item.name) return;
  try {
    const actRes = await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'rename', path: item.path, newName: res.newName.trim() }) });
    if (actRes.undoSummary) updateUndoButton(actRes.undoSummary);
    navigateTo(getActiveTab().path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    if (state.dualOpen && state.dualPath) navigateDual(state.dualPath, false);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function batchRenameSelected(items) {
  const res = await showPromptModal({
    title: `Toplu Yeniden Adlandır (${items.length} öğe)`,
    desc: 'Kullanılabilir yer tutucular: {name} (orijinal ad), {n} (sıra no), {date} (tarih)',
    fields: [
      { name: 'pattern', label: 'İsim Şablonu', value: '{name}_{n}' },
      { name: 'startNum', label: 'Başlangıç Numarası', type: 'number', value: '1' },
    ],
    okText: 'Uygula',
  });
  if (!res || !res.pattern.trim()) return null;
  try {
    const act = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'batchRename',
        paths: items.map((x) => x.path),
        pattern: res.pattern.trim(),
        startNum: Number(res.startNum) || 1,
      }),
    });
    openProcessModal(act.jobId);
    return act;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function deleteSelected(permanent = false, overridePaths = null, extraOpts = {}) {
  const tab = getActiveTab();
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return null;

  if (tab && tab.path === 'TRASH' && !overridePaths) {
    return deleteFromTrash(paths);
  }

  // Normal çöpe atma (1-200 öğe) anında iyimser UI + arka planda sıcak işçiyle yapılır (Ctrl+Z ile geri alınabilir)
  const fastRecycle = !permanent && extraOpts.originTag !== 'dupes' && paths.length <= 200;
  const cmode = state.settings.trashConfirmMode || 'bulk';
  const needsConfirm = permanent || extraOpts.originTag === 'dupes'
    || (cmode === 'always')
    || (cmode === 'bulk' && paths.length > 50);
  if (needsConfirm) {
    const confirmRes = await showPromptModal({
      title: permanent ? 'Kalıcı Olarak Sil' : "Geri Dönüşüm Kutusu'na Taşı",
      desc: `${paths.length} öğe ${permanent ? 'KALICI OLARAK silinecek! Bu işlem geri alınamaz.' : "Çöp Kutusu'na gönderilecek (kalıcı silinmez)."}`,
      okText: permanent ? 'Kalıcı Sil' : 'Çöpe At',
    });
    if (!confirmRes) return null;
  }

  if (fastRecycle) {
    const pathSet = new Set(paths);
    if ($('quicklook-dialog').open) releaseQuickLookMedia();
    state.rawItems = state.rawItems.filter((x) => !pathSet.has(x.path));
    state.viewItems = state.viewItems.filter((x) => !pathSet.has(x.path));
    for (const p of paths) {
      state.selectedPaths.delete(p);
      state.basket.delete(p);
    }
    renderBasket();
    renderVirtualList();
    updateStatusCounts();
    updateToolbarButtons();

    toast(`${paths.length} öğe çöpe taşınıyor...`, 'success');
    api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        paths,
        permanent: false,
        immediate: true,
      }),
    }).then((res) => {
      if (res.undoSummary) updateUndoButton(res.undoSummary);
      if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    }).catch((err) => {
      toast(`Çöpe taşınamadı: ${err.message}`, 'error');
      const curTab = getActiveTab();
      if (curTab && curTab.path !== 'PC' && curTab.path !== 'TRASH') {
        navigateTo(curTab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
      }
    });
    return { ok: true, optimistic: true };
  }

  try {
    const res = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        paths,
        permanent,
        originTag: extraOpts.originTag || '',
      }),
    });
    openProcessModal(res.jobId);
    return res;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function restoreFromTrash(overridePaths = null) {
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return;
  try {
    const res = await api('/api/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    });
    if (res.undoSummary) updateUndoButton(res.undoSummary);
    if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    const okCount = (res.restored || []).length;
    if (okCount > 0) toast(`${okCount} öğe özgün konumuna geri yüklendi`, 'success');
    if (res.errors && res.errors.length > 0) toast(res.errors[0].message, 'error');
    const tab = getActiveTab();
    if (tab && tab.path === 'TRASH') {
      navigateTo('TRASH', { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteFromTrash(overridePaths = null) {
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return null;
  const confirmRes = await showPromptModal({
    title: 'Çöp Kutusundan Kalıcı Olarak Sil',
    desc: `${paths.length} öğe Çöp Kutusu'ndan KALICI OLARAK silinecek! Bu işlem geri alınamaz.`,
    okText: 'Kalıcı Sil',
  });
  if (!confirmRes) return null;
  try {
    const res = await api('/api/trash/delete', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    });
    if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    toast(`${res.deleted || 0} öğe kalıcı olarak silindi`, 'success');
    const tab = getActiveTab();
    if (tab && tab.path === 'TRASH') {
      navigateTo('TRASH', { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
    return res;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function emptyTrash() {
  if (state.rawItems.length === 0) return toast('Çöp kutusu zaten boş');
  const confirmRes = await showPromptModal({
    title: 'Çöp Kutusunu Boşalt',
    desc: `Çöp Kutusu'ndaki tüm (${state.rawItems.length}) öğe KALICI OLARAK silinecek! Bu işlem geri alınamaz.`,
    okText: 'Tümünü Kalıcı Sil',
  });
  if (!confirmRes) return;
  try {
    const res = await api('/api/trash/empty', { method: 'POST', body: '{}' });
    updateTrashBadge(0);
    toast(`${res.deleted || 0} öğe kalıcı silindi, çöp kutusu boşaltıldı`, 'success');
    const tab = getActiveTab();
    if (tab && tab.path === 'TRASH') {
      navigateTo('TRASH', { pushHistory: false, forceRefresh: true });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

let undoInFlight = false;
async function performUndo() {
  if (undoInFlight) return;
  undoInFlight = true;
  try {
    const res = await api('/api/undo', { method: 'POST', body: '{}' });
    if (res.undoSummary) updateUndoButton(res.undoSummary);
    if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    if (res.empty) {
      toast('Geri alınacak işlem yok');
      return;
    }
    if (res.undoneCount > 0) {
      toast(`Geri alındı: ${res.label}`, 'success');
    } else if (res.errors && res.errors.length > 0) {
      toast(`Geri alınamadı: ${res.errors[0].message}`, 'error');
    }

    const tab = getActiveTab();
    if (tab && tab.path !== 'PC' && $('analyzer-view').classList.contains('hidden')) {
      navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
    if (state.dualOpen && state.dualPath) navigateDual(state.dualPath, false);
  } catch (err) {
    toast(`Geri alma hatası: ${err.message}`, 'error');
  } finally {
    undoInFlight = false;
  }
}

let propsReqSeq = 0;
async function copyTextSafe(text, toastMsg = 'Panoya kopyalandı') {
  const val = String(text ?? '');
  if (!val) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(val);
      if (toastMsg) toast(toastMsg, 'success');
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok && toastMsg) toast(toastMsg, 'success');
    return ok;
  } catch {
    toast('Panoya kopyalanamadı', 'error');
    return false;
  }
}

async function showPropertiesModal(overridePaths = null) {
  const tab = getActiveTab();
  const targetPaths = (overridePaths && overridePaths.length > 0)
    ? overridePaths
    : (state.selectedPaths.size > 0
      ? Array.from(state.selectedPaths)
      : (tab && tab.path !== 'PC' && tab.path !== 'TRASH' ? [tab.path] : []));
  if (targetPaths.length === 0) return;

  const dlg = $('properties-dialog');
  const body = $('props-body');
  const seq = ++propsReqSeq;

  $('props-icon').textContent = targetPaths.length === 1 ? 'ℹ️' : '📦';
  $('props-title').textContent = targetPaths.length === 1 ? getFolderTitle(targetPaths[0]) : `${targetPaths.length} Öğe Özellikleri`;
  $('props-subtitle').textContent = 'Bilgiler ve toplam boyut hesaplanıyor...';
  body.innerHTML = '<div class="analyzer-loading"><div class="spinner"></div><span>Klasör içerikleri ve toplam boyut hesaplanıyor...</span></div>';

  const copyBtn = $('btn-props-copy-path');
  const revBtn = $('btn-props-reveal');
  if (copyBtn) {
    copyBtn.textContent = targetPaths.length === 1
      ? '🔗 Tam Yolu Kopyala'
      : `🔗 Tüm Yolları Kopyala (${targetPaths.length})`;
    copyBtn.onclick = () => copyTextSafe(
      targetPaths.join('\n'),
      targetPaths.length === 1 ? 'Tam yol kopyalandı' : `${targetPaths.length} dosya yolu kopyalandı`
    );
  }
  if (revBtn) {
    revBtn.disabled = targetPaths.length !== 1;
    revBtn.onclick = () => revealInExplorer(targetPaths[0]);
  }

  if (!dlg.open) dlg.showModal();

  try {
    const data = await api('/api/fs/properties', {
      method: 'POST',
      body: JSON.stringify({ paths: targetPaths }),
    });
    if (seq !== propsReqSeq || !dlg.open) return;

    const single = data.singleItem;
    $('props-icon').textContent = single ? (ICONS[single.category] || ICONS.other) : '📦';
    $('props-title').textContent = single ? single.name : `${data.itemCount} Öğe Seçili`;
    $('props-subtitle').textContent = `${data.durationMs} ms içinde hesaplandı`;

    const exactBytes = Number(data.totalBytes || 0).toLocaleString('tr-TR');
    const typeText = single
      ? (single.isDir ? 'Dosya klasörü' : `${(single.ext || '').toUpperCase().replace('.', '') || 'Dosya'} Dosyası`)
      : `${data.selectedFolders} klasör, ${data.selectedFiles} dosya`;

    const rows = [
      { lbl: 'Tür', val: typeText },
      { lbl: 'Konum', val: single ? single.dir : data.commonDir, copyLabel: 'Konum kopyalandı' },
      ...(single ? [{ lbl: 'Tam Yol', val: single.path, copyLabel: 'Tam yol kopyalandı' }] : []),
      { lbl: 'Toplam Boyut', html: `<span class="props-size-strong">${formatBytes(data.totalBytes)}</span> (${exactBytes} bayt)` },
    ];
    if (!single || single.isDir) {
      rows.push({ lbl: 'İçerik', val: `${(data.totalFiles || 0).toLocaleString('tr-TR')} Dosya, ${(data.totalFolders || 0).toLocaleString('tr-TR')} Klasör` });
    }
    if (data.minCtime > 0) rows.push({ lbl: 'Oluşturma', val: formatDate(data.minCtime) });
    if (data.maxMtime > 0) rows.push({ lbl: 'Değiştirme', val: formatDate(data.maxMtime) });
    if (data.maxAtime > 0) rows.push({ lbl: 'Son Erişim', val: formatDate(data.maxAtime) });

    const gridHtml = `<div class="props-grid">${rows.map((r) => {
      let valHtml;
      if (r.html) {
        valHtml = r.html;
      } else if (r.copyLabel && r.val) {
        valHtml = `<div class="props-val-copy"><span class="props-val-text">${esc(r.val)}</span><button type="button" class="props-copy-btn" data-copy-val="${esc(r.val)}" data-copy-msg="${esc(r.copyLabel)}" title="Kopyala">📋 Kopyala</button></div>`;
      } else {
        valHtml = esc(r.val);
      }
      return `<div class="props-lbl">${esc(r.lbl)}:</div><div class="props-val">${valHtml}</div>`;
    }).join('')}</div>`;

    let listHtml = '';
    if (data.items && data.items.length > 1) {
      listHtml = `
        <div style="font-size:12px;font-weight:600;color:#ccc;">Seçili Öğeler (${data.items.length}${data.itemCount > data.items.length ? ' / ' + data.itemCount : ''})</div>
        <div class="props-items-list">
          ${data.items.map((it) => `
            <div class="props-item-row" title="${esc(it.path)}">
              <span class="props-item-name">${ICONS[it.category] || ICONS.other} ${esc(it.name)}</span>
              <span class="props-item-meta">${it.isDir ? `${it.fileCount} dosya • ` : ''}${formatBytes(it.size)}</span>
              <button type="button" class="props-copy-btn" data-copy-val="${esc(it.path)}" data-copy-msg="Dosya yolu kopyalandı" title="${esc(it.path)}">📋</button>
            </div>
          `).join('')}
        </div>
      `;
    }
    body.innerHTML = gridHtml + listHtml;
    body.onclick = (e) => {
      const btn = e.target.closest('.props-copy-btn[data-copy-val]');
      if (!btn) return;
      e.stopPropagation();
      copyTextSafe(btn.dataset.copyVal, btn.dataset.copyMsg || 'Yol kopyalandı');
    };
  } catch (err) {
    if (seq !== propsReqSeq || !dlg.open) return;
    $('props-subtitle').textContent = 'Hata';
    body.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function setClipboard(op, overridePaths = null) {
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return;
  state.clipboard = { op, paths };
  updateToolbarButtons();
  renderVirtualList();
  updateDualSelectionDomInPlace();
  api('/api/clipboard/os', {
    method: 'POST',
    body: JSON.stringify({ op, paths }),
    silentErrors: true,
  }).catch(() => {});
  toast(`${paths.length} öğe ${op === 'cut' ? 'kesildi' : 'kopyalandı'}`);
}

async function pasteToCurrentFolder(overrideDestDir = null) {
  const targetDir = overrideDestDir || getActiveTab()?.path;
  if (!targetDir || targetDir === 'PC' || targetDir === 'TRASH') return;
  if (state.clipboard.paths.length > 0) {
    await enqueueTransfer(state.clipboard.op, state.clipboard.paths, targetDir);
    if (state.clipboard.op === 'cut') {
      state.clipboard = { op: null, paths: [] };
      updateToolbarButtons();
      updateDualSelectionDomInPlace();
    }
    return;
  }
  try {
    const osClip = await api('/api/clipboard/os', { silentErrors: true });
    if (osClip && Array.isArray(osClip.paths) && osClip.paths.length > 0) {
      await enqueueTransfer(osClip.op || 'copy', osClip.paths, targetDir);
      return;
    }
  } catch {}
  toast('Panoda yapıştırılacak dosya yok', 'info');
}

async function enqueueTransfer(op, sources, destDir) {
  try {
    if ((op === 'move' || op === 'copy') && destDir) {
      recordRecentTransferTarget(destDir);
    }
    const res = await api('/api/transfer/enqueue', {
      method: 'POST',
      body: JSON.stringify({ op, sources, destDir, conflict: 'rename' }),
    });
    if (op === 'move' && Array.isArray(sources)) {
      let removedFromBasket = false;
      for (const p of sources) {
        if (state.basket.delete(p)) removedFromBasket = true;
      }
      if (removedFromBasket) renderBasket();
    }
    openProcessModal(res.job?.id || null);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Windows Tarzı İşlem Merkezi, Arka Plan Dock & Hata Merkezi ----------
const procModalState = {
  mode: 'closed', // closed | expanded | minimized
  detailsOpen: false,
  trackedJobId: null,
  trackedScanId: null,
  refreshDupesOnJobId: null,
  lastHandledFinishedId: null,
  trackIndex: false,
  activeControlType: null, // job | scan | index
  activeControlId: null,
  activePaused: false,
  scanType: '',
  lastScanActive: false,
};

function updateErrorBadge(summary) {
  if (!summary) return;
  const total = Number(summary.total) || 0;
  const unread = Number(summary.unread) || 0;
  const btn = $('btn-errors-center');
  const cntEl = $('error-badge-count');
  if (!btn || !cntEl) return;
  cntEl.textContent = String(total);
  btn.classList.toggle('has-errors', total > 0);
  btn.classList.toggle('has-unread', unread > 0);
  btn.title = unread > 0
    ? `${unread} okunmamış, toplam ${total} hata (logs.txt)`
    : `Toplam ${total} kayıtlı hata (logs.txt)`;
}

function openProcessModal(jobId = null, scanId = null) {
  if (jobId) {
    procModalState.trackedJobId = jobId;
    procModalState.trackedScanId = null;
    procModalState.trackIndex = false;
  } else if (scanId) {
    procModalState.trackedScanId = scanId;
    procModalState.trackedJobId = null;
    procModalState.trackIndex = false;
  }
  procModalState.mode = 'expanded';
  $('process-modal').classList.remove('hidden');
  $('process-dock').classList.add('hidden');
  pollTransferStatus();
}

function minimizeProcessModal() {
  procModalState.mode = 'closed';
  $('process-modal').classList.add('hidden');
  $('process-dock').classList.add('hidden');
  pollTransferStatus();
}

function closeProcessModal() {
  const isRunning = Boolean(procModalState.activeControlType);
  if (isRunning) {
    minimizeProcessModal();
  } else {
    procModalState.mode = 'closed';
    procModalState.trackedJobId = null;
    procModalState.trackedScanId = null;
    $('process-modal').classList.add('hidden');
    $('process-dock').classList.add('hidden');
  }
}

function ensureScanDockVisible(scanType = '') {
  if (scanType) procModalState.scanType = scanType;
  if (procModalState.mode === 'closed') {
    procModalState.mode = 'minimized';
  }
  pollTransferStatus();
}

function formatDurationShort(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `~${Math.ceil(sec)} sn`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec % 60);
  return `~${m} dk ${s} sn`;
}

function opIconForType(op) {
  if (op === 'delete') return '🗑️';
  if (op === 'move') return '📦';
  if (op === 'copy') return '📋';
  if (op === 'batchRename') return '✏️';
  if (op === 'organizeByDate') return '📅';
  if (op === 'duplicates') return '🧬';
  if (op === 'folderSizes') return '📏';
  if (op === 'analyze') return '📊';
  if (op === 'index') return '⚡';
  return '⚙️';
}

function renderProcessDetailsLog(logs = [], queuedJobs = []) {
  const qEl = $('proc-queue-summary');
  if (queuedJobs.length > 0) {
    qEl.classList.remove('hidden');
    qEl.textContent = `Sırada bekleyen ${queuedJobs.length} işlem: ` + queuedJobs.map((j) => `${j.title} (${j.sources?.length || j.totalFiles || '?'})`).join(', ');
  } else {
    qEl.classList.add('hidden');
  }

  const logEl = $('proc-log-list');
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 28;
  logEl.innerHTML = '';
  if (!logs || logs.length === 0) {
    logEl.innerHTML = '<div class="muted-text" style="padding:8px;">Henüz dosya kaydı yok...</div>';
    return;
  }
  for (const entry of logs) {
    const row = document.createElement('div');
    const stClass = entry.status === 'error' ? 'error' : entry.status === 'skip' ? 'skip' : 'ok';
    const badge = entry.status === 'error' ? '✕' : entry.status === 'skip' ? '⏭' : entry.status === 'info' ? '•' : '✓';
    row.className = `proc-log-row ${stClass}`;
    row.innerHTML = `
      <span class="proc-log-badge">${badge}</span>
      <span class="proc-log-file" title="${esc(entry.file)}">${esc(entry.file)}</span>
      <span class="proc-log-detail" title="${esc(entry.detail)}">${esc(entry.detail || '')}</span>
    `;
    logEl.appendChild(row);
  }
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function renderProcessViews(view, allJobs = [], scan = null) {
  const modal = $('process-modal');
  const dock = $('process-dock');

  if (!view) {
    modal.classList.add('hidden');
    dock.classList.add('hidden');
    procModalState.mode = 'closed';
    return;
  }

  const icon = opIconForType(view.op);
  const barFill = $('proc-bar-fill');
  barFill.className = 'proc-bar-fill';
  if (view.indeterminate) {
    barFill.classList.add('indeterminate');
  } else {
    barFill.style.width = `${Math.min(100, Math.max(0, view.pct))}%`;
    if (view.state === 'completed') barFill.classList.add(view.errorCount > 0 ? 'warn' : 'done');
    else if (view.state === 'error' || view.state === 'cancelled') barFill.classList.add('err');
  }

  $('proc-op-icon').textContent = icon;
  $('proc-title').textContent = view.title;
  $('proc-pct').textContent = view.indeterminate ? 'İşleniyor...' : `%${view.pct}`;
  $('proc-rate-eta').textContent = view.rateEtaText;
  $('proc-count').textContent = view.countText;
  $('proc-current').textContent = view.currentFile || '—';
  $('proc-target').textContent = view.currentTarget || '—';

  const errInline = $('proc-err-inline');
  const errOpenBtn = $('btn-proc-open-errors');
  if (view.errorCount > 0) {
    errInline.textContent = `${view.errorCount} hata`;
    errInline.classList.remove('hidden');
    errOpenBtn.classList.remove('hidden');
  } else {
    errInline.classList.add('hidden');
    errOpenBtn.classList.add('hidden');
  }

  const pauseBtn = $('btn-proc-pause');
  const cancelBtn = $('btn-proc-cancel');
  const doneBtn = $('btn-proc-done');
  const minBtn = $('btn-proc-minimize');

  if (view.isActive) {
    doneBtn.classList.add('hidden');
    minBtn.classList.remove('hidden');
    cancelBtn.classList.toggle('hidden', !view.canCancel);
    pauseBtn.classList.toggle('hidden', !view.canPause);
    if (view.canPause) pauseBtn.textContent = view.paused ? '▶ Devam Et' : '⏸ Duraklat';
  } else {
    pauseBtn.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    minBtn.classList.add('hidden');
    doneBtn.classList.remove('hidden');
  }

  const queuedJobs = allJobs.filter((j) => j.status === 'queued');
  $('proc-details-box').classList.toggle('hidden', !procModalState.detailsOpen);
  $('btn-proc-details').textContent = procModalState.detailsOpen ? '⌃ Az Detay' : '⌄ Ayrıntılı Liste';
  if (procModalState.detailsOpen && procModalState.mode === 'expanded') {
    renderProcessDetailsLog(view.recentLog || [], queuedJobs);
  }

  if (procModalState.mode === 'expanded') {
    modal.classList.remove('hidden');
    dock.classList.add('hidden');
  } else {
    modal.classList.add('hidden');
    dock.classList.add('hidden');
  }
}

async function openErrorsDialog() {
  const dlg = $('errors-dialog');
  if (!dlg.open) dlg.showModal();
  await refreshErrorsDialog(true);
}

async function refreshErrorsDialog(markRead = true) {
  try {
    const [data, diag] = await Promise.all([
      api(`/api/errors?markRead=${markRead ? '1' : '0'}`, { silentErrors: true }),
      api('/api/diagnostics', { silentErrors: true }).catch(() => null),
    ]);
    updateErrorBadge({ total: data.errors.length, unread: data.unread });
    $('errors-dialog-sub').textContent = `${data.errors.length} oturum hatası • Log dosyası: ${data.logFile || 'logs.txt'}`;

    const envEl = $('diag-env-line');
    if (envEl) {
      if (diag) {
        envEl.textContent = `Sürüm: v${diag.appVersion} (${diag.portable ? 'Portable EXE' : 'Klasör Modu'}) | Node: ${diag.nodeVersion} (${diag.arch}) | OS: ${diag.osPlatform} | Port: ${diag.port} | FFmpeg: ${diag.ffmpegBin} | Önbellek: ${diag.cacheRoot}`;
      } else {
        envEl.textContent = `Tarayıcı/Arayüz Modu • Önbellek/Sunucu bilgisi alınamadı`;
      }
    }

    const combinedErrors = (data.errors && data.errors.length > 0) ? data.errors : localClientErrors;
    const listEl = $('errors-list');
    listEl.innerHTML = '';
    if (!combinedErrors || combinedErrors.length === 0) {
      listEl.innerHTML = '<div class="muted-text" style="padding:10px;">Henüz yakalanmış bir hata yok.</div>';
    } else {
      for (const e of combinedErrors) {
        const div = document.createElement('div');
        div.className = 'error-entry';
        const timeStr = e.time ? new Date(e.time).toLocaleTimeString('tr-TR') : '';
        div.innerHTML = `
          <div class="error-entry-top">
            <span class="error-entry-op">${esc(e.op)}</span>
            <span class="muted-text" style="font-size:11px;">${esc(timeStr)}</span>
          </div>
          ${e.target ? `<div class="error-entry-target">${esc(e.target)}</div>` : ''}
          <div class="error-entry-msg">${esc(e.message)}</div>
          ${e.stack ? `<details class="error-entry-stack"><summary>Hata İzi (Stack Trace)</summary><pre>${esc(e.stack)}</pre></details>` : ''}
        `;
        listEl.appendChild(div);
      }
    }

    $('errors-logs-tail').textContent = data.logsTail || '(logs.txt henüz boş)';
  } catch (err) {
    const envEl = $('diag-env-line');
    if (envEl) envEl.textContent = `Sunucu erişilemiyor (${err.message}). Yerel arayüz hataları gösteriliyor.`;
    const listEl = $('errors-list');
    if (listEl) {
      listEl.innerHTML = '';
      if (localClientErrors.length === 0) {
        listEl.innerHTML = `<div class="muted-text" style="padding:10px;">Sunucu hatası: ${esc(err.message)}</div>`;
      } else {
        for (const e of localClientErrors) {
          const div = document.createElement('div');
          div.className = 'error-entry';
          div.innerHTML = `
            <div class="error-entry-top"><span class="error-entry-op">${esc(e.op)}</span><span class="muted-text" style="font-size:11px;">${esc(new Date(e.time).toLocaleTimeString('tr-TR'))}</span></div>
            <div class="error-entry-msg">${esc(e.message)}</div>
            ${e.stack ? `<details class="error-entry-stack" open><summary>Hata İzi (Stack Trace)</summary><pre>${esc(e.stack)}</pre></details>` : ''}
          `;
          listEl.appendChild(div);
        }
      }
    }
    toast(err.message, 'error');
  }
}

async function copyFullDiagnosticsReport() {
  let diag = null;
  try {
    diag = await api('/api/diagnostics', { silentErrors: true });
  } catch {}
  const activeTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const lines = [
    '=== LIGHTDESKTOP GELISTIRICI TESHIS RAPORU ===',
    `Tarih: ${new Date().toISOString()}`,
    `Aktif Sekme: ${activeTab ? `${activeTab.path} (${activeTab.viewType})` : '-'}`,
    `Ekran: ${window.innerWidth}x${window.innerHeight} | DPR: ${window.devicePixelRatio}`,
    `UserAgent: ${navigator.userAgent}`,
  ];
  if (diag) {
    lines.push(
      `Surum: v${diag.appVersion} | Portable: ${diag.portable} | UI Host: ${diag.uiHost || 'Tarayici'}`,
      `Node: ${diag.nodeVersion} (${diag.arch}) | OS: ${diag.osPlatform}`,
      `PID: ${diag.pid} | Port: ${diag.port} | Calisma Suresi: ${diag.uptimeSec}sn`,
      `Exe: ${diag.exePath || '-'}`,
      `Onbellek: ${diag.cacheRoot}`,
      `Log: ${diag.logFile}`,
      `FFmpeg: ${diag.ffmpegBin}`,
      diag.dbInitWarning ? `DB Uyarisi: ${diag.dbInitWarning}` : '',
      '',
      `--- OTURUM HATALARI (${(diag.errors || []).length}) ---`,
      ...(diag.errors || []).slice(0, 30).map((e) => `[${e.time}] [${e.op}] ${e.target ? e.target + ' -> ' : ''}${e.message}${e.stack ? '\n' + e.stack : ''}`),
      '',
      '--- LOGS.TXT SON KAYITLAR ---',
      diag.logsTail || '(bos)'
    );
  } else {
    lines.push(
      'Sunucu /api/diagnostics yanit vermedi!',
      `--- YEREL ARAYUZ HATALARI (${localClientErrors.length}) ---`,
      ...localClientErrors.map((e) => `[${e.time}] [${e.op}] ${e.message}${e.stack ? '\n' + e.stack : ''}`)
    );
  }
  const reportText = lines.filter((x) => x !== undefined).join('\n');
  try {
    await navigator.clipboard.writeText(reportText);
    toast('Geliştirici için tam teşhis raporu panoya kopyalandı', 'success');
  } catch {
    toast('Panoya kopyalanamadı', 'error');
  }
}

async function controlTask(target, action, id = null) {
  const payload = { target, action };
  if (target === 'job' && id) payload.jobId = id;
  if (target === 'scan' && id) payload.scanId = id;
  await api('/api/transfer/control', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (target === 'scan' && action === 'cancel') {
    state.folderSizeRunning = false;
    const btn = $('btn-folder-sizes');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📏 Boyutlar';
    }
  }
  if (target === 'index' && (action === 'cancel' || action === 'stop')) {
    procModalState.trackIndex = false;
    pollIndexStatus();
  }
  pollTransferStatus();
}

function buildSidebarTaskList(data) {
  const list = [];
  const jobs = (data && data.jobs) || [];
  const shortJobLabel = {
    copy: '📋 Kopyalama',
    move: '📦 Taşıma',
    delete: '🗑️ Silme',
    batchRename: '✏️ Adlandırma',
    organizeByDate: '📅 Klasörleme',
  };

  for (const j of jobs) {
    if (j.status !== 'running' && j.status !== 'queued') continue;
    const hasBytes = j.totalBytes > 0;
    const pct = hasBytes
      ? Math.round((j.doneBytes / j.totalBytes) * 100)
      : j.totalFiles > 0
        ? Math.round((j.doneFiles / j.totalFiles) * 100)
        : 0;
    const indet = j.totalFiles === 0 && j.totalBytes === 0;
    const isPaused = Boolean(data.paused) && j.status === 'running';
    list.push({
      target: 'job',
      id: j.id,
      title: shortJobLabel[j.op] || j.title || 'İşlem',
      pctText: isPaused ? `⏸ %${pct}` : indet ? '…' : `%${pct}`,
      pct,
      indeterminate: indet,
      paused: isPaused,
      sub: j.status === 'queued'
        ? `Sırada (${j.totalFiles || j.sources?.length || '?'} öğe)`
        : `${j.doneFiles}/${j.totalFiles || '?'} • ${j.currentFile || 'Hazırlanıyor'}`,
    });
  }

  const scans = (data && Array.isArray(data.scans))
    ? data.scans.filter((s) => s.active)
    : (data && data.scan && data.scan.active ? [data.scan] : []);

  for (const scan of scans) {
    const baseLabel = scan.type === 'duplicates'
      ? '🧬 Kopya Arama'
      : scan.type === 'folderSizes'
        ? '📏 Boyut Tarama'
        : '📊 Disk Analizi';
    const pathTag = scan.targetPath ? ` (${getFolderTitle(scan.targetPath)})` : '';
    const pct = scan.total > 0 ? Math.min(99, Math.round((scan.done / scan.total) * 100)) : 0;
    const indet = scan.total <= 0;
    list.push({
      target: 'scan',
      id: scan.id || scan.type,
      title: baseLabel + pathTag,
      pctText: scan.paused ? (indet ? '⏸' : `⏸ %${pct}`) : (indet ? `${scan.done}` : `%${pct}`),
      pct,
      indeterminate: indet,
      paused: Boolean(scan.paused),
      sub: `${scan.done}${scan.total > 0 ? '/' + scan.total : ' tarandı'} • ${scan.currentItem || scan.targetPath || ''}`,
    });
  }

  const idx = data && data.index && data.index.running ? data.index : null;
  if (idx) {
    list.push({
      target: 'index',
      id: 'index',
      title: `⚡ İndeksleme (${idx.rootPath || ''})`,
      pctText: idx.paused ? '⏸' : `${(idx.indexedFiles || 0).toLocaleString('tr-TR')}`,
      pct: 0,
      indeterminate: true,
      paused: Boolean(idx.paused),
      sub: idx.currentDir || 'Taranıyor...',
    });
  }
  return list;
}

function renderSidebarTasks(data) {
  const listEl = $('sidebar-tasks-list');
  const countEl = $('sidebar-tasks-count');
  if (!listEl || !countEl) return;

  const tasks = buildSidebarTaskList(data);
  countEl.textContent = String(tasks.length);
  countEl.classList.toggle('active', tasks.length > 0);

  listEl.innerHTML = '';
  if (tasks.length === 0) {
    listEl.innerHTML = '<div class="sidebar-tasks-empty">Aktif işlem yok</div>';
    return;
  }

  for (const t of tasks) {
    const card = document.createElement('div');
    card.className = `sb-task-card${t.paused ? ' paused' : ''}`;
    card.innerHTML = `
      <div class="sb-task-top">
        <span class="sb-task-title" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="sb-task-pct">${esc(t.pctText)}</span>
      </div>
      <div class="sb-task-bar">
        <div class="sb-task-fill${t.indeterminate ? ' indeterminate' : ''}" style="${t.indeterminate ? '' : `width:${Math.min(100, Math.max(0, t.pct))}%`}"></div>
      </div>
      <div class="sb-task-bottom">
        <span class="sb-task-sub" title="${esc(t.sub)}">${esc(t.sub)}</span>
        <div class="sb-task-actions">
          <button class="sb-task-btn" data-act="pause" title="${t.paused ? 'Devam Et' : 'Duraklat'}">${t.paused ? '▶' : '⏸'}</button>
          <button class="sb-task-btn danger" data-act="cancel" title="İptal Et">✕</button>
          <button class="sb-task-btn" data-act="detail" title="Ayrıntılı Pencereyi Aç">🗖</button>
        </div>
      </div>
    `;
    card.querySelector('[data-act="pause"]').onclick = () => controlTask(t.target, t.paused ? 'resume' : 'pause', t.id);
    card.querySelector('[data-act="cancel"]').onclick = () => controlTask(t.target, 'cancel', t.id);
    card.querySelector('[data-act="detail"]').onclick = () => {
      if (t.target === 'job') openProcessModal(t.id, null);
      else if (t.target === 'scan') openProcessModal(null, t.id);
      else if (t.target === 'index') {
        procModalState.trackIndex = true;
        procModalState.trackedJobId = null;
        procModalState.trackedScanId = null;
        openProcessModal();
      } else {
        openProcessModal();
      }
    };
    listEl.appendChild(card);
  }
}

let transferPollTimer = null;
async function pollTransferStatus() {
  clearTimeout(transferPollTimer);
  try {
    const data = await api('/api/transfer/status', { silentErrors: true });
    updateErrorBadge(data.errorSummary);
    renderSidebarTasks(data);

    const jobs = data.jobs || [];
    const activeJob = jobs.find((j) => j.status === 'running' || j.status === 'queued');
    const trackedJob = procModalState.trackedJobId
      ? jobs.find((j) => j.id === procModalState.trackedJobId)
      : null;
    const latestJob = jobs[jobs.length - 1] || null;
    const scans = Array.isArray(data.scans)
      ? data.scans
      : (data.scan && data.scan.id ? [data.scan] : []);
    const activeScans = scans.filter((s) => s.active);
    const trackedScan = procModalState.trackedScanId
      ? scans.find((s) => s.id === procModalState.trackedScanId)
      : null;
    const activeScan = (trackedScan && trackedScan.active ? trackedScan : null)
      || activeScans[activeScans.length - 1]
      || null;
    const activeIndex = data.index && data.index.running ? data.index : null;

    // Biten son transfer / silme / düzenleme job'unu yakala ve listeyi yenile
    const finishedCandidate = activeJob
      ? null
      : (trackedJob && trackedJob.status !== 'running' && trackedJob.status !== 'queued' ? trackedJob : latestJob);

    if (finishedCandidate && finishedCandidate.finishedAt && finishedCandidate.id !== procModalState.lastHandledFinishedId) {
      procModalState.lastHandledFinishedId = finishedCandidate.id;
      if (finishedCandidate.op === 'delete' || (finishedCandidate.op === 'move' && finishedCandidate.status !== 'cancelled')) {
        for (const p of finishedCandidate.sources || []) {
          state.basket.delete(p);
          state.selectedPaths.delete(p);
        }
        renderBasket();
      }
      if (finishedCandidate.status === 'completed') {
        if (finishedCandidate.errorCount > 0) {
          toast(`${finishedCandidate.title} tamamlandı (${finishedCandidate.errorCount} hata oluştu)`, 'error');
        } else {
          toast(`${finishedCandidate.title} tamamlandı!`, 'success');
          if (state.settings.autoCloseProcessModal && procModalState.trackedJobId === finishedCandidate.id) {
            procModalState.mode = 'closed';
            procModalState.trackedJobId = null;
            $('process-modal').classList.add('hidden');
          }
        }
      } else if (finishedCandidate.status === 'cancelled') {
        toast(`${finishedCandidate.title} iptal edildi`);
      } else if (finishedCandidate.status === 'error') {
        toast(`${finishedCandidate.title} başarısız: ${finishedCandidate.error || ''}`, 'error');
      }

      const tab = getActiveTab();
      if (tab && tab.path !== 'PC' && $('analyzer-view').classList.contains('hidden')) {
        navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
      }
      if (state.dualOpen && state.dualPath) navigateDual(state.dualPath, false);

      if (
        procModalState.refreshDupesOnJobId === finishedCandidate.id &&
        !$('analyzer-view').classList.contains('hidden')
      ) {
        procModalState.refreshDupesOnJobId = null;
        findAndRenderDuplicates();
      }
    }

    if (data.undoSummary) updateUndoButton(data.undoSummary);
    if (typeof data.trashCount === 'number') updateTrashBadge(data.trashCount);

    // Alt durum çubuğundaki küçük pill + Modal + Dock görünümü seçimi
    const pill = $('transfer-pill');
    let view = null;

    if (activeIndex && procModalState.trackIndex && procModalState.mode !== 'closed') {
      pill.classList.add('hidden');
      procModalState.activeControlType = 'index';
      procModalState.activeControlId = 'index';
      const idxPaused = Boolean(activeIndex.paused);
      procModalState.activePaused = idxPaused;
      view = {
        op: 'index',
        title: `Disk İndeksleniyor: ${activeIndex.rootPath || ''}`,
        isActive: true,
        state: 'running',
        pct: 0,
        indeterminate: true,
        rateEtaText: idxPaused ? 'Duraklatıldı' : `${(activeIndex.indexedDirs || 0).toLocaleString('tr-TR')} klasör tarandı`,
        countText: `${(activeIndex.indexedFiles || 0).toLocaleString('tr-TR')} dosya indekslendi`,
        currentFile: activeIndex.currentDir || 'Başlıyor...',
        currentTarget: 'Yalnızca ad/boyut/tarih okunur (0 dosya içeriği)',
        errorCount: 0,
        canPause: true,
        paused: idxPaused,
        canCancel: true,
        recentLog: activeIndex.recentLog || [],
        dockStatsText: (idxPaused ? '⏸ ' : '') + `${(activeIndex.indexedFiles || 0).toLocaleString('tr-TR')} öğe`,
      };
    } else if (activeJob) {
      procModalState.activeControlType = 'job';
      procModalState.activeControlId = activeJob.id;
      procModalState.trackedJobId = activeJob.id;
      procModalState.activePaused = Boolean(data.paused);

      const hasBytes = activeJob.totalBytes > 0;
      const pct = hasBytes
        ? Math.round((activeJob.doneBytes / activeJob.totalBytes) * 100)
        : activeJob.totalFiles > 0
          ? Math.round((activeJob.doneFiles / activeJob.totalFiles) * 100)
          : 0;
      let rateTxt = data.paused
        ? 'Duraklatıldı'
        : hasBytes
          ? `Hız: ${formatBytes(activeJob.speedBps)}/s`
          : `Hız: ${activeJob.itemsPerSec || 0} öğe/sn`;

      if (!data.paused) {
        if (hasBytes && activeJob.speedBps > 0) {
          const eta = (activeJob.totalBytes - activeJob.doneBytes) / activeJob.speedBps;
          const etaStr = formatDurationShort(eta);
          if (etaStr) rateTxt += ` • Kalan: ${etaStr}`;
        } else if (!hasBytes && activeJob.itemsPerSec > 0 && activeJob.totalFiles > activeJob.doneFiles) {
          const eta = (activeJob.totalFiles - activeJob.doneFiles) / activeJob.itemsPerSec;
          const etaStr = formatDurationShort(eta);
          if (etaStr) rateTxt += ` • Kalan: ${etaStr}`;
        }
      }

      const countText = hasBytes
        ? `${activeJob.doneFiles} / ${activeJob.totalFiles || '?'} dosya (${formatBytes(activeJob.doneBytes)} / ${formatBytes(activeJob.totalBytes)})`
        : `${activeJob.doneFiles} / ${activeJob.totalFiles || '?'} öğe`;

      view = {
        op: activeJob.op,
        title: activeJob.title || 'İşlem Yürütülüyor',
        isActive: true,
        state: 'running',
        pct,
        indeterminate: activeJob.totalFiles === 0 && activeJob.totalBytes === 0,
        rateEtaText: rateTxt,
        countText,
        currentFile: activeJob.currentFile || 'Hazırlanıyor...',
        currentTarget: activeJob.currentTarget || activeJob.destDir || activeJob.parentDir || '',
        errorCount: activeJob.errorCount || 0,
        canPause: true,
        paused: Boolean(data.paused),
        canCancel: true,
        recentLog: activeJob.recentLog || [],
        dockStatsText: `%${pct} (${activeJob.doneFiles}/${activeJob.totalFiles || '?'})`,
      };

      pill.classList.add('hidden');
    } else if (activeScan) {
      pill.classList.add('hidden');
      procModalState.activeControlType = 'scan';
      procModalState.activeControlId = activeScan.id || activeScan.type;
      if (!procModalState.trackedJobId && activeScan.id) procModalState.trackedScanId = activeScan.id;
      const pct = activeScan.total > 0 ? Math.min(99, Math.round((activeScan.done / activeScan.total) * 100)) : 0;
      const indet = activeScan.total <= 0;
      const scanPaused = Boolean(activeScan.paused);
      procModalState.activePaused = scanPaused;
      view = {
        op: activeScan.type,
        title: activeScan.title || 'Disk Taranıyor',
        isActive: true,
        state: 'running',
        pct,
        indeterminate: indet,
        rateEtaText: scanPaused ? 'Duraklatıldı' : `Hız: ${activeScan.itemsPerSec || 0} öğe/sn`,
        countText: activeScan.total > 0 ? `${activeScan.done} / ${activeScan.total}` : `${activeScan.done} öğe tarandı`,
        currentFile: activeScan.currentItem || 'Taranıyor...',
        currentTarget: activeScan.currentDetail || '',
        errorCount: 0,
        canPause: true,
        paused: scanPaused,
        canCancel: true,
        recentLog: activeScan.recentLog || [],
        dockStatsText: (scanPaused ? '⏸ ' : '') + (indet ? `${activeScan.done} tarandı` : `%${pct} (${activeScan.done}/${activeScan.total})`),
      };
    } else {
      pill.classList.add('hidden');
      procModalState.activeControlType = null;
      procModalState.activeControlId = null;
      procModalState.activePaused = false;
      if (procModalState.trackIndex && !activeIndex) procModalState.trackIndex = false;

      if (procModalState.mode === 'minimized') {
        procModalState.mode = 'closed';
      } else if (procModalState.mode === 'expanded' && trackedJob && trackedJob.status !== 'running' && trackedJob.status !== 'queued') {
        const doneStatus = trackedJob.status;
        view = {
          op: trackedJob.op,
          title: doneStatus === 'cancelled'
            ? `${trackedJob.title} (İptal Edildi)`
            : doneStatus === 'error'
              ? `${trackedJob.title} (Hata)`
              : `${trackedJob.title} — Tamamlandı`,
          isActive: false,
          state: doneStatus,
          pct: doneStatus === 'completed' ? 100 : 0,
          indeterminate: false,
          rateEtaText: doneStatus === 'completed'
            ? `Süre: ${Math.max(1, Math.round(((trackedJob.finishedAt || Date.now()) - (trackedJob.startedAt || Date.now())) / 1000))} sn`
            : (trackedJob.error || ''),
          countText: `${trackedJob.doneFiles} / ${trackedJob.totalFiles || trackedJob.doneFiles} öğe`,
          currentFile: doneStatus === 'completed' ? 'İşlem tamamlandı' : (trackedJob.error || 'Durduruldu'),
          currentTarget: trackedJob.destDir || trackedJob.parentDir || '',
          errorCount: trackedJob.errorCount || 0,
          canPause: false,
          paused: false,
          canCancel: false,
          recentLog: trackedJob.recentLog || [],
          dockStatsText: 'Tamamlandı',
        };
      } else if (procModalState.mode === 'expanded' && trackedScan && !trackedScan.active) {
        const doneStatus = trackedScan.status || (trackedScan.cancelled ? 'cancelled' : 'completed');
        const totalCnt = trackedScan.total > 0 ? trackedScan.total : trackedScan.done;
        const doneCnt = doneStatus === 'completed' ? totalCnt : trackedScan.done;
        view = {
          op: trackedScan.type,
          title: doneStatus === 'cancelled'
            ? `${trackedScan.title} (İptal Edildi)`
            : `${trackedScan.title} — Tamamlandı`,
          isActive: false,
          state: doneStatus,
          pct: doneStatus === 'completed' ? 100 : (totalCnt > 0 ? Math.round((doneCnt / totalCnt) * 100) : 0),
          indeterminate: false,
          rateEtaText: `Süre: ${Math.max(1, Math.round(((trackedScan.finishedAt || Date.now()) - (trackedScan.startedAt || Date.now())) / 1000))} sn`,
          countText: `${doneCnt} / ${totalCnt} öğe`,
          currentFile: doneStatus === 'completed' ? 'İşlem tamamlandı' : 'İptal edildi',
          currentTarget: trackedScan.targetPath || '',
          errorCount: 0,
          canPause: false,
          paused: false,
          canCancel: false,
          recentLog: trackedScan.recentLog || [],
          dockStatsText: doneStatus === 'completed' ? 'Tamamlandı' : 'İptal edildi',
        };
      } else if (procModalState.mode === 'expanded' && procModalState.lastScanActive && !activeScan) {
        procModalState.mode = 'closed';
      }
    }

    procModalState.lastScanActive = Boolean(activeScans.length > 0);
    renderProcessViews(view, jobs, activeScan);

    if (activeJob || activeScans.length > 0 || activeIndex) {
      transferPollTimer = setTimeout(pollTransferStatus, 400);
    }
  } catch {}
}

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

function formatCacheAge(ts) {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'az önce';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} dk önce`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} sa önce`;
  return `${Math.floor(diffHr / 24)} gün önce`;
}

function buildCacheBannerHtml(data, btnId, freshLabel = '🔄 Canlı Yenile') {
  if (!data || !data.fromCache) return '';
  const age = formatCacheAge(data.cachedAt);
  if (data.stale) {
    return `
      <span>💡 <strong>${esc(data.staleReason || 'Değişiklik algılandı')}</strong> — önbellekten (${esc(age)}) gösteriliyor; tekrar taramanız önerilir.</span>
      <button type="button" id="${btnId}" class="cmd-btn small primary">🔄 Şimdi Yeniden Tara</button>
    `;
  }
  return `
    <span>⚡ <strong>Önbellekten anında yüklendi</strong> (${esc(age)})</span>
    <button type="button" id="${btnId}" class="cmd-btn small">${esc(freshLabel)}</button>
  `;
}

// ---------- Disk & Klasör Analizörü ----------
function restoreTabAnalyzerView(tab) {
  if (!tab) return;
  const targetPath = tab.analyzerPath || (tab.path !== 'PC' ? tab.path : state.drives[0]?.path || 'C:\\');
  $('pc-dashboard').classList.add('hidden');
  $('explorer-view').classList.add('hidden');
  $('analyzer-view').classList.remove('hidden');

  renderBreadcrumbs(targetPath);
  updateNavButtons();
  updateSidebarActive(targetPath);

  $('analyzer-title').textContent = `📊 Doluluk Analizi: ${targetPath}`;
  $('btn-analyzer-live').dataset.path = targetPath;
  $('btn-analyzer-dupes').dataset.path = targetPath;

  const cacheBanner = $('analyzer-cache-banner');
  if (tab.analyzerLoading) {
    if (cacheBanner) cacheBanner.classList.add('hidden');
    $('analyzer-loading').classList.remove('hidden');
    $('analyzer-subtitle').textContent = 'Tarama / analiz devam ediyor...';
    $('stacked-bar').innerHTML = '';
    $('category-cards').innerHTML = '';
    $('top-files-list').innerHTML = '';
    $('top-folders-list').innerHTML = '';
  } else {
    $('analyzer-loading').classList.add('hidden');
    if (tab.analyzerData) {
      const d = tab.analyzerData;
      $('analyzer-subtitle').textContent = `${d.totalFiles.toLocaleString('tr-TR')} dosya • ${formatBytes(d.totalBytes)} (${d.fromCache ? 'Önbellekten' : (d.source === 'sqlite-cache' ? 'SSD İndeksinden Anında' : 'Canlı Tarama')}${d.cancelled ? ' • Kısmi' : ''})`;
      if (cacheBanner) {
        const html = buildCacheBannerHtml(d, 'btn-cache-rescan-analyzer');
        cacheBanner.classList.toggle('hidden', !html);
        cacheBanner.classList.toggle('stale', Boolean(d.stale));
        cacheBanner.innerHTML = html;
        const rBtn = $('btn-cache-rescan-analyzer');
        if (rBtn) rBtn.onclick = () => openAnalyzer(targetPath, 'live');
      }
      renderAnalyzerResult(d);
    } else if (cacheBanner) {
      cacheBanner.classList.add('hidden');
    }
  }

  const panel = $('dupes-panel');
  if (tab.dupesLoading) {
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="analyzer-loading"><div class="spinner"></div><span>Kopya dosyalar arka planda taranıyor (sol alt panelden durdurup devam ettirebilirsiniz)...</span></div>';
  } else if (tab.dupesData) {
    panel.classList.remove('hidden');
    renderDuplicatesResult(tab.dupesData);
  } else if (tab.dupesError) {
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="muted-text">${esc(tab.dupesError)}</div>`;
  } else {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
}

async function openAnalyzer(targetPath, mode = 'auto') {
  const originTab = getActiveTab();
  const pathToAnalyze = targetPath || (originTab && originTab.path !== 'PC' ? originTab.path : state.drives[0]?.path || 'C:\\');

  if (originTab) {
    const pathChanged = originTab.analyzerPath && originTab.analyzerPath !== pathToAnalyze;
    originTab.viewType = 'analyzer';
    originTab.analyzerPath = pathToAnalyze;
    originTab.analyzerLoading = true;
    if (pathChanged) {
      originTab.dupesData = null;
      originTab.dupesLoading = false;
      originTab.dupesError = '';
    }
    renderTabs();
    restoreTabAnalyzerView(originTab);
  }

  try {
    if (mode === 'live') setTimeout(pollTransferStatus, 80);
    const data = await api(`/api/analyze?path=${encodeURIComponent(pathToAnalyze)}&mode=${mode}`);
    if (originTab) {
      originTab.analyzerLoading = false;
      originTab.analyzerData = data;
      renderTabs();
      if (state.activeTabId === originTab.id && originTab.viewType === 'analyzer') {
        restoreTabAnalyzerView(originTab);
      } else if (!data.cancelled) {
        toast(`📊 ${pathToAnalyze} disk analizi tamamlandı`, 'success');
      }
    }
  } catch (err) {
    if (originTab) originTab.analyzerLoading = false;
    $('analyzer-loading').classList.add('hidden');
    toast(`Analiz hatası: ${err.message}`, 'error');
  } finally {
    pollTransferStatus();
  }
}

function renderAnalyzerResult(data) {
  const bar = $('stacked-bar');
  const cards = $('category-cards');
  bar.innerHTML = '';
  cards.innerHTML = '';

  for (const c of data.categories) {
    const meta = CAT_META[c.category] || CAT_META.other;
    if (c.percent > 0) {
      const seg = document.createElement('div');
      seg.className = 'stacked-seg';
      seg.style.width = `${Math.max(1, c.percent)}%`;
      seg.style.background = meta.color;
      seg.title = `${meta.label}: ${formatBytes(c.bytes)} (%${c.percent})`;
      bar.appendChild(seg);
    }

    const card = document.createElement('div');
    card.className = 'cat-card';
    card.style.borderLeftColor = meta.color;
    card.innerHTML = `
      <div class="cat-card-title">${meta.icon} ${meta.label}</div>
      <div class="cat-card-size">${formatBytes(c.bytes)}</div>
      <div class="cat-card-meta">${c.count.toLocaleString('tr-TR')} dosya • %${c.percent}</div>
    `;
    cards.appendChild(card);
  }

  const tf = $('top-files-list');
  tf.innerHTML = '';
  const topFilesNorm = (data.topFiles || []).map((x) => ({ ...x, isDir: false }));
  for (const f of topFilesNorm) {
    const row = document.createElement('div');
    row.className = 'analyzer-row';
    row.title = f.path;
    row.innerHTML = `
      <span>${ICONS[f.category] || '📃'}</span>
      <span class="analyzer-row-name">${esc(f.name)}</span>
      <span class="analyzer-row-size">${formatBytes(f.size)}</span>
    `;
    row.onclick = () => openQuickLook(f, topFilesNorm);
    row.ondblclick = () => openExternally(f.path);
    tf.appendChild(row);
  }

  const tdir = $('top-folders-list');
  tdir.innerHTML = '';
  if (!data.topFolders || data.topFolders.length === 0) {
    tdir.innerHTML = '<div class="muted-text" style="padding:10px">Alt klasör dökümü için "Canlı Tara & Güncelle" butonunu kullanın.</div>';
  } else {
    for (const d of data.topFolders) {
      const row = document.createElement('div');
      row.className = 'analyzer-row';
      row.innerHTML = `
        <span>📁</span>
        <span class="analyzer-row-name">${esc(d.name)}</span>
        <span class="analyzer-row-size">${formatBytes(d.bytes)}</span>
      `;
      row.onclick = () => navigateTo(d.path);
      tdir.appendChild(row);
    }
  }
}

// ---------- Klasör Boyutu, Tarihle Klasörle, Kopya Bulucu & Çift Panel ----------
async function cancelPendingFolderSizes(showToast = false) {
  if (!state.folderSizeRunning) return;
  state.folderSizeRunning = false;
  await fetch('/api/transfer/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'scan', action: 'cancel' }),
  }).catch(() => {});
  const btn = $('btn-folder-sizes');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '📏 Boyutlar';
  }
  if (showToast) toast('Klasör boyutu hesaplama iptal edildi');
  pollTransferStatus();
}

async function calculateCurrentFolderSizes(force = false) {
  if (state.folderSizeRunning) {
    await cancelPendingFolderSizes(true);
    return;
  }
  const tab = getActiveTab();
  if (!tab || tab.path === 'PC') return;
  const dirs = state.rawItems.filter((it) => it.isDir);
  if (dirs.length === 0) return toast('Bu klasörde alt klasör yok');

  const btn = $('btn-folder-sizes');
  const startPath = tab.path;
  state.folderSizeRunning = true;
  state.folderSizePath = startPath;
  btn.disabled = false;
  btn.textContent = '⏹️ Boyut İptal';
  setTimeout(pollTransferStatus, 80);

  try {
    const res = await api('/api/folder-sizes', {
      method: 'POST',
      body: JSON.stringify({ parentDir: startPath, paths: dirs.map((d) => d.path), force: Boolean(force) }),
    });
    if (res.sizes) {
      for (const [fp, bytes] of Object.entries(res.sizes)) {
        state.folderSizesCache.set(fp, bytes);
      }
    }
    if (res.cancelled) return;

    let totalFolderBytes = 0;
    for (const val of Object.values(res.sizes || {})) totalFolderBytes += val || 0;

    const curTab = getActiveTab();
    if (curTab && curTab.path === startPath && curTab.viewType === 'explorer') {
      for (const item of state.rawItems) {
        if (item.isDir && res.sizes && res.sizes[item.path] !== undefined) {
          item.size = res.sizes[item.path];
          item.sizeCalculated = true;
        }
      }
      state.sortBy = 'size';
      state.sortDir = 'desc';
      $('sort-by').value = 'size';
      $('btn-sort-dir').textContent = '▼';
      applySortAndFilter();
    }
    if (res.fromCache) {
      toast(
        res.stale
          ? `💡 Boyutlar önbellekten yüklendi (${formatCacheAge(res.cachedAt)}) — değişiklik algılandı! Yenilemek için Shift + 📏 Boyutlar tıklayın`
          : `⚡ ${dirs.length} klasör boyutu önbellekten yüklendi (Canlı tarama için Shift+Tık)`,
        res.stale ? 'info' : 'success'
      );
    } else {
      toast(`${dirs.length} klasör boyutu hesaplandı (${startPath} • Toplam: ${formatBytes(totalFolderBytes)})`, 'success');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(err.message, 'error');
  } finally {
    state.folderSizeRunning = false;
    state.folderSizePath = '';
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📏 Boyutlar';
    }
    pollTransferStatus();
  }
}

function showOrganizeDateModal(currentDir, prev) {
  return new Promise((resolve) => {
    const dlg = $('organize-date-dialog');
    const form = $('org-date-form');
    const customRow = $('org-custom-dest-row');
    const customInp = $('org-custom-dest-input');
    const btnBrowse = $('btn-org-browse');
    const btnUseDual = $('btn-org-use-dual');
    const previewBox = $('org-output-preview');

    const topLines = prev.preview.slice(0, 6).map((p) => `${p.folder} (${p.count})`).join(', ');
    const more = prev.preview.length > 6 ? ` +${prev.preview.length - 6} klasör daha` : '';
    const sizeInfo = prev.totalBytes ? ` (${formatBytes(prev.totalBytes)})` : '';
    $('org-date-summary').textContent = `${prev.totalFiles} dosya${sizeInfo}, değiştirme tarihine göre ${prev.folderCount} alt klasöre ayrılacak.`;
    $('org-current-path-label').textContent = currentDir;

    const rCopy = form.querySelector('input[name="org-mode"][value="copy"]');
    const rCur = form.querySelector('input[name="org-dest-mode"][value="current"]');
    if (rCopy) rCopy.checked = true;
    if (rCur) rCur.checked = true;
    customInp.value = '';
    customRow.classList.add('hidden');
    btnUseDual.classList.toggle('hidden', !(state.dualOpen && state.dualPath));

    const getMode = () => form.querySelector('input[name="org-mode"]:checked')?.value || 'copy';
    const getDestMode = () => form.querySelector('input[name="org-dest-mode"]:checked')?.value || 'current';
    const updatePreview = () => {
      const destMode = getDestMode();
      customRow.classList.toggle('hidden', destMode !== 'custom');
      const rawBase = destMode === 'custom' ? (customInp.value.trim() || '<Seçilen Konum>') : currentDir;
      const baseClean = rawBase.replace(/[\\/]+$/, '');
      const fullOut = `${baseClean}\\${prev.outputFolderName}`;
      const modeLabel = getMode() === 'copy' ? 'Kopyalayarak (orijinaller kalır)' : 'Taşıyarak (orijinaller taşınır)';
      previewBox.innerHTML = `
        <div><strong>İşlem:</strong> ${esc(modeLabel)}</div>
        <div><strong>Oluşacak Ana Klasör:</strong><code>${esc(fullOut)}</code></div>
        <div class="muted-text" style="margin-top:4px;">Alt klasörler: ${esc(topLines + more)}</div>
      `;
    };

    form.querySelectorAll('input[name="org-mode"], input[name="org-dest-mode"]').forEach((r) => {
      r.onchange = updatePreview;
    });
    customInp.oninput = updatePreview;

    btnUseDual.onclick = () => {
      if (state.dualPath) {
        customInp.value = state.dualPath;
        updatePreview();
      }
    };

    btnBrowse.onclick = async () => {
      btnBrowse.disabled = true;
      try {
        const res = await api('/api/fs/action', {
          method: 'POST',
          body: JSON.stringify({ action: 'pickFolder', initialDir: customInp.value.trim() || currentDir }),
        });
        if (res && res.path) {
          customInp.value = res.path;
          updatePreview();
        }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btnBrowse.disabled = false;
      }
    };

    let settled = false;
    const cleanup = (val) => {
      if (settled) return;
      settled = true;
      if (dlg.open) dlg.close();
      resolve(val);
    };

    $('btn-org-cancel').onclick = () => cleanup(null);
    form.onsubmit = (e) => {
      e.preventDefault();
      const mode = getMode();
      const destMode = getDestMode();
      const destDir = destMode === 'custom' ? customInp.value.trim() : currentDir;
      if (destMode === 'custom' && !destDir) {
        toast('Lütfen hedef klasör seçin veya yolunu yazın', 'error');
        customInp.focus();
        return;
      }
      cleanup({ mode, destDir });
    };
    dlg.oncancel = () => cleanup(null);
    dlg.onclose = () => cleanup(null);
    updatePreview();
    dlg.showModal();
  });
}

async function organizeCurrentFolderByDate() {
  const tab = getActiveTab();
  if (!tab || tab.path === 'PC' || tab.path === 'TRASH') return toast('Önce bir klasör açın', 'error');
  try {
    const prev = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({ action: 'organizeByDate', parentDir: tab.path, dryRun: true }),
    });
    if (!prev.totalFiles) return toast('Bu klasörde düzenlenecek dosya yok');

    const opts = await showOrganizeDateModal(tab.path, prev);
    if (!opts) return;

    const done = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'organizeByDate',
        parentDir: tab.path,
        destDir: opts.destDir,
        mode: opts.mode,
        dryRun: false,
      }),
    });
    openProcessModal(done.jobId);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderDuplicatesResult(data) {
  const panel = $('dupes-panel');
  panel.classList.remove('hidden');
  const protectedNote = data.skippedProtectedCount > 0
    ? `<div class="muted-text" style="font-size:11.5px;margin-bottom:8px;">🛡️ Güvenlik koruması: Sistem, program ve uygulama klasörlerinden (Windows, Program Files, AppData, ProgramData, .dll/.exe/.dat) ${data.skippedProtectedCount.toLocaleString('tr-TR')} dosya hariç tutuldu.</div>`
    : '';
  const dupesBannerHtml = buildCacheBannerHtml(data, 'btn-cache-rescan-dupes', '🔄 Kopyaları Yeniden Tara');
  const dupesBannerWrap = dupesBannerHtml
    ? `<div class="cache-status-banner${data.stale ? ' stale' : ''}">${dupesBannerHtml}</div>`
    : '';

  if (!data.groups || data.groups.length === 0) {
    panel.innerHTML = `${dupesBannerWrap}<h3>🧬 Kopya Dosya Bulucu</h3>${protectedNote}<div class="muted-text">Bu konumda birebir kopya dosya bulunamadı.</div>`;
    const rBtn = $('btn-cache-rescan-dupes');
    if (rBtn) rBtn.onclick = () => findAndRenderDuplicates(true);
    return;
  }

  const redundantPaths = [];
  for (const g of data.groups) {
    for (let i = 1; i < g.files.length; i++) redundantPaths.push(g.files[i].path);
  }

  panel.innerHTML = `
    ${dupesBannerWrap}
    ${protectedNote}
    <div class="dupes-summary">
      <div>
        <strong>🧬 ${data.totalGroups} kopya grubu</strong> •
        ${data.totalDuplicateFiles} gereksiz kopya •
        <span style="color:#ff9c94;font-weight:700;">${formatBytes(data.totalWastedBytes)} kazanılabilir alan</span>
      </div>
      <button id="btn-delete-all-dupes" class="cmd-btn danger-hover">🗑️ Fazla Kopyaları Çöpe At (${redundantPaths.length})</button>
    </div>
    <div id="dupe-groups-list" class="dupe-groups-list"></div>
  `;

  const rBtn = $('btn-cache-rescan-dupes');
  if (rBtn) rBtn.onclick = () => findAndRenderDuplicates(true);

  const listEl = $('dupe-groups-list');
  for (const g of data.groups) {
    const box = document.createElement('div');
    box.className = 'dupe-group';
    box.innerHTML = `
      <div class="dupe-group-head">
        <span>${esc(g.files[0].name)} (${g.files.length} kopya)</span>
        <span>Tekil: ${formatBytes(g.size)} • Boşa: ${formatBytes(g.wastedBytes)}</span>
      </div>
    `;
    g.files.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'dupe-file-row';
      row.title = f.path;
      row.innerHTML = `
        <span class="${idx === 0 ? 'dupe-badge-orig' : 'dupe-badge-copy'}">${idx === 0 ? 'Orijinal' : 'Kopya'}</span>
        <span class="analyzer-row-name">${esc(f.path)}</span>
      `;
      row.onclick = () => openQuickLook({ ...f, size: g.size, isDir: false });
      box.appendChild(row);
    });
    listEl.appendChild(box);
  }

  $('btn-delete-all-dupes').onclick = async () => {
    const res = await deleteSelected(false, redundantPaths, { originTag: 'dupes' });
    if (res && res.jobId) procModalState.refreshDupesOnJobId = res.jobId;
  };
}

async function findAndRenderDuplicates(force = false) {
  const originTab = getActiveTab();
  const targetPath = (originTab && originTab.analyzerPath) || $('btn-analyzer-dupes').dataset.path || state.drives[0]?.path || 'C:\\';
  if (originTab) {
    originTab.viewType = 'analyzer';
    originTab.analyzerPath = targetPath;
    originTab.dupesLoading = true;
    originTab.dupesData = null;
    originTab.dupesError = '';
    renderTabs();
    restoreTabAnalyzerView(originTab);
  }

  setTimeout(pollTransferStatus, 80);
  try {
    const data = await api(`/api/duplicates?path=${encodeURIComponent(targetPath)}&force=${force === true ? '1' : '0'}`);
    if (originTab) {
      originTab.dupesLoading = false;
      if (data.cancelled) {
        originTab.dupesError = 'Kopya dosya taraması kullanıcı tarafından durduruldu / iptal edildi.';
      } else {
        originTab.dupesData = data;
      }
      renderTabs();
      if (state.activeTabId === originTab.id && originTab.viewType === 'analyzer') {
        restoreTabAnalyzerView(originTab);
      } else if (!data.cancelled) {
        toast(`🧬 ${targetPath} kopya taraması tamamlandı (${data.totalGroups} grup bulundu)`, 'success');
      }
    }
  } catch (err) {
    if (originTab) {
      originTab.dupesLoading = false;
      originTab.dupesError = `Kopya tarama hatası: ${err.message}`;
      renderTabs();
      if (state.activeTabId === originTab.id && originTab.viewType === 'analyzer') {
        restoreTabAnalyzerView(originTab);
      }
    } else {
      $('dupes-panel').innerHTML = `<div class="muted-text">Kopya tarama hatası: ${esc(err.message)}</div>`;
    }
  } finally {
    pollTransferStatus();
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

// ---------- Arka Plan İndeksleyici & Arama ----------
let indexPollTimer = null;
async function startBackgroundIndex(targetPath) {
  try {
    await api('/api/index/start', { method: 'POST', body: JSON.stringify({ path: targetPath }) });
    toast(`${targetPath} arka planda HDD dostu şekilde indeksleniyor...`);
    pollIndexStatus();
    pollTransferStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pollIndexStatus() {
  clearTimeout(indexPollTimer);
  try {
    const st = await api('/api/index/status');
    const pill = $('index-pill');
    const btn = $('btn-toggle-index');
    if (st.running) {
      pill.classList.add('indexing');
      $('index-pill-text').textContent = `İndeksleniyor: ${st.indexedFiles.toLocaleString('tr-TR')}`;
      btn.textContent = '⏹ Durdur';
      indexPollTimer = setTimeout(pollIndexStatus, 900);
    } else {
      pill.classList.remove('indexing');
      $('index-pill-text').textContent = `İndeks: ${(st.totalEntries || 0).toLocaleString('tr-TR')} öğe`;
      btn.textContent = '⚡ İndeksle';
    }
    const cnt = (st.cachedThumbCount || 0).toLocaleString('tr-TR');
    const mb = formatBytes(st.cachedThumbBytes || 0);
    $('cache-badge').textContent = `🛡️ SSD Önbellek: ${cnt} kapak (${mb})`;
  } catch {}
}

async function togglePin(targetPath, name, remove = false) {
  try {
    const res = await api('/api/pins', { method: 'POST', body: JSON.stringify({ path: targetPath, name, remove }) });
    state.pins = res.pins;
    renderSidebarAndDashboard();
    toast(remove ? 'Sabitleme kaldırıldı' : 'Sol menüye sabitlendi', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function executeGlobalSearch() {
  const q = $('search-input').value.trim();
  const scope = $('search-scope').value;
  if (scope === 'folder') {
    applySortAndFilter();
    return;
  }
  if (!q) {
    const tab = getActiveTab();
    if (tab) navigateTo(tab.path, { pushHistory: false });
    return;
  }

  const tab = getActiveTab();
  let scopePath = '';
  if (scope === 'drive' && tab && tab.path !== 'PC') {
    scopePath = tab.path.slice(0, 3);
  }

  $('pc-dashboard').classList.add('hidden');
  $('analyzer-view').classList.add('hidden');
  $('explorer-view').classList.remove('hidden');

  const t0 = performance.now();
  try {
    const data = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: q, scopePath, limit: 1000 }),
    });
    const ms = (performance.now() - t0).toFixed(1);
    state.rawItems = data.items;
    state.selectedPaths.clear();
    $('status-timing').textContent = `Arama: ${ms} ms (${data.source})`;
    applySortAndFilter();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Olay Dinleyicileri & Kısayollar ----------
function bindEvents() {
  // Sekme ve Gezinti
  const sbPc = document.querySelector('.sidebar-item[data-path="PC"]');
  if (sbPc) sbPc.onclick = () => navigateTo('PC');
  const sbTrash = $('sb-trash-btn');
  if (sbTrash) sbTrash.onclick = () => navigateTo('TRASH');
  const toggleSec = (key) => {
    state.dashSections[key] = !state.dashSections[key];
    saveUiPrefs();
    applyDashSectionVisibility();
  };
  const bq = $('btn-toggle-sec-quick');
  if (bq) bq.onclick = () => toggleSec('quick');
  const bf = $('btn-toggle-sec-folders');
  if (bf) bf.onclick = () => toggleSec('folders');
  const bfi = $('btn-toggle-sec-files');
  if (bfi) bfi.onclick = () => toggleSec('files');
  const bcf = $('btn-clear-recent-folders');
  if (bcf) bcf.onclick = () => { state.recentFolders = []; saveDashHistory(); renderRecentDashboardSections(); toast('Son açılan klasörler temizlendi'); };
  const bcfi = $('btn-clear-recent-files');
  if (bcfi) bcfi.onclick = () => { state.recentFiles = []; saveDashHistory(); renderRecentDashboardSections(); toast('Son erişilen dosyalar temizlendi'); };
  const btnRecTargets = $('btn-toggle-recent-targets');
  if (btnRecTargets) {
    btnRecTargets.onclick = () => {
      state.recentTargetsOpen = !state.recentTargetsOpen;
      saveUiPrefs();
      renderRecentTransferTargets();
    };
  }
  const cmdTrash = $('btn-open-trash');
  if (cmdTrash) cmdTrash.onclick = () => navigateTo('TRASH');
  const undoBtn = $('btn-undo');
  if (undoBtn) undoBtn.onclick = () => performUndo();
  const trashRestoreBtn = $('btn-trash-restore');
  if (trashRestoreBtn) trashRestoreBtn.onclick = () => restoreFromTrash();
  const trashPermBtn = $('btn-trash-perm-delete');
  if (trashPermBtn) trashPermBtn.onclick = () => deleteFromTrash();
  const trashEmptyBtn = $('btn-trash-empty');
  if (trashEmptyBtn) trashEmptyBtn.onclick = () => emptyTrash();

  $('btn-new-tab').onclick = () => createTab('PC', true);
  $('btn-back').onclick = () => {
    const tab = getActiveTab();
    if (tab && tab.historyIndex > 0) {
      tab.historyIndex--;
      navigateTo(tab.history[tab.historyIndex], { pushHistory: false, restoreScroll: true });
    }
  };
  $('btn-forward').onclick = () => {
    const tab = getActiveTab();
    if (tab && tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      navigateTo(tab.history[tab.historyIndex], { pushHistory: false, restoreScroll: true });
    }
  };
  $('btn-up').onclick = () => {
    const tab = getActiveTab();
    if (!tab || tab.path === 'PC') return;
    if (tab.path === 'TRASH') return navigateTo('PC');
    const clean = tab.path.replace(/\\+$/, '');
    if (/^[a-zA-Z]:$/.test(clean)) return navigateTo('PC');
    const parent = clean.substring(0, clean.lastIndexOf('\\'));
    navigateTo(/^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent);
  };
  $('btn-refresh').onclick = () => {
    const tab = getActiveTab();
    if (tab) navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
  };

  // Adres Çubuğu Düzenleme
  $('address-wrapper').onclick = () => {
    const tab = getActiveTab();
    $('breadcrumbs').classList.add('hidden');
    const inp = $('address-input');
    inp.classList.remove('hidden');
    inp.value = tab && tab.path !== 'PC' ? tab.path : '';
    inp.focus();
    inp.select();
  };
  const closeAddressEdit = () => {
    $('address-input').classList.add('hidden');
    $('breadcrumbs').classList.remove('hidden');
  };
  $('address-input').onblur = closeAddressEdit;
  $('address-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const val = $('address-input').value.trim();
      closeAddressEdit();
      navigateTo(val || 'PC');
    } else if (e.key === 'Escape') {
      closeAddressEdit();
    }
  };

  // Arama
  $('search-input').oninput = () => {
    state.searchQuery = $('search-input').value;
    $('btn-clear-search').classList.toggle('hidden', !state.searchQuery);
    clearTimeout(state.searchTimer);
    if ($('search-scope').value === 'folder') {
      applySortAndFilter();
    } else {
      state.searchTimer = setTimeout(executeGlobalSearch, 180);
    }
  };
  $('search-scope').onchange = () => {
    if ($('search-input').value.trim()) executeGlobalSearch();
  };
  $('btn-clear-search').onclick = () => {
    $('search-input').value = '';
    state.searchQuery = '';
    $('btn-clear-search').classList.add('hidden');
    if ($('search-scope').value === 'folder') applySortAndFilter();
    else {
      const tab = getActiveTab();
      if (tab) navigateTo(tab.path, { pushHistory: false });
    }
  };

  // Komut Çubuğu
  $('btn-mkdir').onclick = createNewFolder;
  $('btn-pin').onclick = () => {
    const tab = getActiveTab();
    if (tab && tab.path !== 'PC') togglePin(tab.path, getFolderTitle(tab.path), false);
  };
  $('btn-cut').onclick = () => setClipboard('cut');
  $('btn-copy').onclick = () => setClipboard('copy');
  $('btn-paste').onclick = pasteToCurrentFolder;
  $('btn-rename').onclick = renameSelected;
  $('btn-delete').onclick = () => deleteSelected(false);
  const propsBtn = $('btn-properties');
  if (propsBtn) propsBtn.onclick = () => showPropertiesModal();
  const propsClose = $('btn-props-close');
  if (propsClose) propsClose.onclick = () => $('properties-dialog').close();
  const propsOk = $('btn-props-ok');
  if (propsOk) propsOk.onclick = () => $('properties-dialog').close();
  const propsDlg = $('properties-dialog');
  if (propsDlg) {
    propsDlg.addEventListener('close', () => {
      propsReqSeq++;
      api('/api/fs/properties/cancel', { method: 'POST', body: '{}', silentErrors: true }).catch(() => {});
    });
  }

  $('sort-by').onchange = (e) => {
    state.sortBy = e.target.value;
    saveUiPrefs();
    applySortAndFilter();
  };
  $('btn-sort-dir').onclick = () => {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    $('btn-sort-dir').textContent = state.sortDir === 'asc' ? '▲' : '▼';
    saveUiPrefs();
    applySortAndFilter();
  };
  document.querySelectorAll('#list-header .lh-cell[data-sort]').forEach((el) => {
    el.onclick = (e) => {
      if (Date.now() < state.suppressHeaderSortUntil) return;
      if (e.target.closest('.lh-filter-btn') || e.target.closest('.lh-resizer')) return;
      const col = el.dataset.sort;
      if (state.sortBy === col) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortBy = col; state.sortDir = 'asc'; }
      $('sort-by').value = state.sortBy;
      $('btn-sort-dir').textContent = state.sortDir === 'asc' ? '▲' : '▼';
      saveUiPrefs();
      applySortAndFilter();
    };
  });
  document.querySelectorAll('#list-header .lh-filter-btn[data-col]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openColFilterPopover(btn.dataset.col, btn);
    };
  });
  setupListColumnResizers();
  document.addEventListener('pointerdown', (e) => {
    const pop = $('col-filter-popover');
    if (pop && pop.matches(':popover-open')) {
      if (!e.target.closest('#col-filter-popover') && !e.target.closest('#list-header .lh-filter-btn')) {
        closeColFilterPopover();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeColFilterPopover();
  });

  $('view-mode').onchange = (e) => {
    state.viewMode = e.target.value;
    state.globalViewMode = state.viewMode;
    const tab = getActiveTab();
    if (state.settings.rememberFolderView !== false && tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
      state.folderViews[normalizeFolderKey(tab.path)] = state.viewMode;
      saveFolderViews();
    }
    saveUiPrefs();
    renderVirtualList();
    if (state.thumbMode === 'viewport' || state.thumbMode === 'all') scheduleThumbBatch();
  };

  $('thumb-mode').onchange = (e) => {
    state.thumbMode = e.target.value;
    cancelPendingThumbs();
    if (state.thumbMode !== 'off') scheduleThumbBatch();
  };
  $('btn-stop-thumbs').onclick = cancelPendingThumbs;

  // İndeksleyici Butonu & Durum Hapı
  $('index-pill').onclick = async () => {
    try {
      const st = await api('/api/index/status', { silentErrors: true });
      if (st.running) {
        procModalState.trackIndex = true;
        openProcessModal();
      }
    } catch {}
  };
  $('btn-toggle-index').onclick = async () => {
    const st = await api('/api/index/status');
    if (st.running) {
      await controlTask('index', 'cancel', 'index');
      pollIndexStatus();
    } else {
      const tab = getActiveTab();
      const target = tab && tab.path !== 'PC' ? tab.path.slice(0, 3) : (state.drives.find((d) => d.id === 'D:')?.path || state.drives[0]?.path || 'C:\\');
      await startBackgroundIndex(target);
      procModalState.trackIndex = true;
    }
  };

  // Aralık Seçici Stüdyosu
  $('btn-range-studio').onclick = () => {
    $('range-studio').classList.toggle('hidden');
    $('btn-range-studio').classList.toggle('active', !$('range-studio').classList.contains('hidden'));
    updateStudioMatchPreview();
  };
  $('btn-close-studio').onclick = () => {
    $('range-studio').classList.add('hidden');
    $('btn-range-studio').classList.remove('active');
  };
  ['flt-pattern', 'flt-regex', 'flt-num-min', 'flt-num-max', 'flt-date-min', 'flt-date-max', 'flt-size-min', 'flt-size-min-unit', 'flt-size-max', 'flt-size-max-unit', 'flt-category', 'flt-ext', 'flt-row-min', 'flt-row-max'].forEach((id) => {
    $(id).addEventListener('input', updateStudioMatchPreview);
    $(id).addEventListener('change', updateStudioMatchPreview);
  });

  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.onclick = () => {
      const p = btn.dataset.preset;
      if (p === 'reset') {
        ['flt-pattern', 'flt-num-min', 'flt-num-max', 'flt-date-min', 'flt-date-max', 'flt-size-min', 'flt-size-max', 'flt-ext', 'flt-row-min', 'flt-row-max'].forEach((id) => $(id).value = '');
        $('flt-regex').checked = false;
        $('flt-category').value = 'all';
        state.filterOnlyMatched = false;
        $('btn-flt-clear-view').classList.add('hidden');
        applySortAndFilter();
      } else if (p === 'img') {
        $('flt-pattern').value = 'IMG_*';
        $('flt-regex').checked = false;
      } else if (p === 'vid') {
        $('flt-pattern').value = 'VID_*';
        $('flt-regex').checked = false;
      } else if (p === 'bigvid') {
        $('flt-category').value = 'video';
        $('flt-size-min').value = '100';
        $('flt-size-min-unit').value = '1048576';
      } else if (p === 'dupes') {
        $('flt-pattern').value = '\\(\\d+\\)\\.[^.]+$';
        $('flt-regex').checked = true;
      } else if (p === 'today') {
        const today = new Date().toISOString().slice(0, 10);
        $('flt-date-min').value = today;
        $('flt-date-max').value = today;
      }
      updateStudioMatchPreview();
    };
  });

  $('btn-flt-select').onclick = () => {
    const matched = getMatchedStudioItems();
    state.selectedPaths.clear();
    for (const m of matched) state.selectedPaths.add(m.path);
    renderVirtualList();
    updateStatusCounts();
    updateToolbarButtons();
    toast(`${matched.length} öğe seçildi`);
  };
  $('btn-flt-filter-view').onclick = () => {
    state.filterOnlyMatched = true;
    $('btn-flt-clear-view').classList.remove('hidden');
    applySortAndFilter();
  };
  $('btn-flt-clear-view').onclick = () => {
    state.filterOnlyMatched = false;
    for (const set of Object.values(state.colFilters)) set.clear();
    $('btn-flt-clear-view').classList.add('hidden');
    applySortAndFilter();
  };
  $('btn-flt-basket').onclick = () => addItemsToBasket(getMatchedStudioItems());
  $('btn-flt-copy').onclick = () => setClipboard('copy', getMatchedStudioItems().map((x) => x.path));
  $('btn-flt-delete').onclick = () => deleteSelected(false, getMatchedStudioItems().map((x) => x.path));
  $('btn-flt-move-folder').onclick = async () => {
    const matched = getMatchedStudioItems();
    if (matched.length === 0) return toast('Eşleşen öğe yok', 'error');
    const tab = getActiveTab();
    if (!tab || tab.path === 'PC') return;
    const res = await showPromptModal({
      title: `Seçilen ${matched.length} Öğeyi Yeni Klasöre Taşı`,
      fields: [{ name: 'folderName', label: 'Yeni Klasör Adı', value: 'Filtrelenenler' }],
      okText: 'Klasör Aç ve Taşı',
    });
    if (!res || !res.folderName.trim()) return;
    try {
      const actRes = await api('/api/fs/action', {
        method: 'POST',
        body: JSON.stringify({
          action: 'createFolderWithSelection',
          parentDir: tab.path,
          folderName: res.folderName.trim(),
          paths: matched.map((x) => x.path),
          op: 'move',
        }),
      });
      openProcessModal(actRes.jobId);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // Analizör, Kopya Bulucu, Klasör Boyutları, Tarih Düzenleyici, Çift Panel & Sepet
  const btnSaveSmart = $('btn-studio-save-smart');
  if (btnSaveSmart) {
    btnSaveSmart.onclick = async () => {
      const criteria = {};
      const pat = $('flt-pattern')?.value.trim();
      if (pat) criteria.nameContains = pat.replace(/\*/g, '').replace(/\.\*/g, '').trim();
      const cat = $('flt-category')?.value;
      if (cat && cat !== 'all') criteria.category = cat;
      const extVal = $('flt-ext')?.value.trim();
      if (extVal) criteria.extList = extVal.split(',').map((s) => s.trim()).filter(Boolean);
      const minSz = Number($('flt-size-min')?.value || 0);
      if (minSz > 0) criteria.minSize = minSz * Number($('flt-size-min-unit')?.value || 1048576);
      const maxSz = Number($('flt-size-max')?.value || 0);
      if (maxSz > 0) criteria.maxSize = maxSz * Number($('flt-size-max-unit')?.value || 1048576);
      const tab = getActiveTab();
      if (tab && tab.path && /^[a-zA-Z]:/.test(tab.path)) {
        criteria.driveRoot = tab.path.slice(0, 3);
      }
      const res = await showPromptModal({
        title: '✨ Akıllı Klasör Olarak Kaydet',
        desc: 'Geçerli filtre kriterleri sol menüdeki Akıllı Klasörler altına sanal klasör olarak eklenecek:',
        fields: [{ name: 'name', label: 'Klasör Adı', value: pat || (cat && cat !== 'all' ? `${cat} Görünümü` : 'Özel Akıllı Görünüm') }],
        okText: 'Kaydet',
      });
      if (!res || !res.name.trim()) return;
      state.smartViews.push({
        id: 'sv_' + Date.now().toString(36),
        icon: '✨',
        name: res.name.trim(),
        builtin: false,
        criteria,
      });
      state.smartViewsOpen = true;
      saveSmartViews();
      renderSmartViewsSidebar();
      toast(`✨ "${res.name.trim()}" Akıllı Klasörlere eklendi`, 'success');
    };
  }
  const btnToggleSmart = $('btn-toggle-smart-views');
  if (btnToggleSmart) {
    btnToggleSmart.onclick = () => {
      state.smartViewsOpen = !state.smartViewsOpen;
      try { localStorage.setItem('ld_smart_views_open', state.smartViewsOpen ? '1' : '0'); } catch {}
      renderSmartViewsSidebar();
    };
  }
  if ($('btn-smart-view-refresh')) $('btn-smart-view-refresh').onclick = () => { if (state.smartViewCtx) openSmartView(state.smartViewCtx); };
  if ($('btn-smart-view-close')) $('btn-smart-view-close').onclick = closeSmartView;

  $('btn-analyze').onclick = () => openAnalyzer();
  $('btn-analyzer-live').onclick = () => openAnalyzer($('btn-analyzer-live').dataset.path, 'live');
  $('btn-analyzer-dupes').onclick = () => findAndRenderDuplicates(false);
  $('btn-analyzer-close').onclick = () => {
    const tab = getActiveTab();
    navigateTo(tab ? tab.path : 'PC', { pushHistory: false });
  };

  $('btn-folder-sizes').onclick = (e) => calculateCurrentFolderSizes(Boolean(e?.shiftKey));
  $('btn-organize-date').onclick = organizeCurrentFolderByDate;
  $('btn-install-shortcut').onclick = async () => {
    try {
      await api('/api/system/integration', { method: 'POST', body: JSON.stringify({ action: 'installShortcuts' }) });
      toast('Masaüstü, Başlat Menüsü (Ctrl+Alt+E) ve Sağ Tık menüsü kuruldu!', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  bindIntegrationAndWelcomeHandlers();
  bindRelatedHandlers();
  const btnSettings = $('btn-settings');
  if (btnSettings) btnSettings.onclick = openSettingsDialog;
  const btnSetClose = $('btn-settings-close');
  if (btnSetClose) btnSetClose.onclick = () => $('settings-dialog').close();
  const btnSetDone = $('btn-settings-done');
  if (btnSetDone) btnSetDone.onclick = () => $('settings-dialog').close();

  const swatchesEl = $('set-accent-swatches');
  if (swatchesEl) {
    swatchesEl.onclick = (e) => {
      const btn = e.target.closest('.color-swatch[data-color]');
      if (!btn) return;
      state.settings.accentColor = btn.dataset.color;
      saveAppSettings();
      applyAppSettings();
    };
  }
  const setBind = (id, prop, isCheck = false, extra = null) => {
    const el = $(id);
    if (!el) return;
    el.onchange = () => {
      state.settings[prop] = isCheck ? Boolean(el.checked) : (id === 'set-font-size' ? Number(el.value) : el.value);
      saveAppSettings();
      applyAppSettings();
      if (extra) extra();
    };
  };
  setBind('set-font-size', 'fontSize');
  setBind('set-default-view', 'defaultViewMode', false, () => {
    const tab = getActiveTab();
    if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
      applyViewModeForFolder(tab.path);
      renderVirtualList();
    }
  });
  setBind('set-remember-folder-view', 'rememberFolderView', true, () => {
    const tab = getActiveTab();
    if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
      applyViewModeForFolder(tab.path);
      renderVirtualList();
    }
  });
  setBind('set-folders-first', 'foldersFirst', true, () => applySortAndFilter());
  setBind('set-show-ext', 'showExtensions', true, () => renderVirtualList());
  setBind('set-compact-sidebar', 'compactSidebar', true);
  const bindCustomPathSetting = (modeSelectId, customRowId, inputId, browseBtnId, modeProp, dirProp) => {
    setBind(modeSelectId, modeProp, false, () => {
      const row = $(customRowId);
      if (row) row.classList.toggle('hidden', state.settings[modeProp] !== 'custom');
    });
    const inputEl = $(inputId);
    if (inputEl) {
      inputEl.onchange = () => {
        state.settings[dirProp] = inputEl.value.trim();
        saveAppSettings();
      };
    }
    const browseBtn = $(browseBtnId);
    if (browseBtn) {
      browseBtn.onclick = async () => {
        browseBtn.disabled = true;
        try {
          const res = await api('/api/fs/action', {
            method: 'POST',
            body: JSON.stringify({ action: 'pickFolder', initialDir: state.settings[dirProp] || '' }),
          });
          if (res && res.path) {
            state.settings[dirProp] = res.path;
            if ($(inputId)) $(inputId).value = res.path;
            saveAppSettings();
          }
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          browseBtn.disabled = false;
        }
      };
    }
  };
  bindCustomPathSetting('set-startup-mode', 'set-startup-custom-row', 'set-startup-path', 'btn-set-startup-browse', 'startupMode', 'startupPath');
  setBind('set-click-mode', 'clickMode');
  setBind('set-trash-confirm', 'trashConfirmMode');
  setBind('set-auto-close-proc', 'autoCloseProcessModal', true);
  setBind('set-default-thumb', 'defaultThumbMode', false, () => {
    state.thumbMode = state.settings.defaultThumbMode;
    $('thumb-mode').value = state.thumbMode;
    cancelPendingThumbs();
    if (state.thumbMode !== 'off') scheduleThumbBatch();
  });
  setBind('set-dblclick-quicklook', 'dblClickQuickLook', true);
  bindCustomPathSetting('set-frame-save-mode', 'set-frame-save-custom-row', 'set-frame-save-dir', 'btn-set-frame-save-browse', 'frameSaveMode', 'frameSaveDir');
  bindCustomPathSetting('set-trim-save-mode', 'set-trim-save-custom-row', 'set-trim-save-dir', 'btn-set-trim-save-browse', 'trimSaveMode', 'trimSaveDir');
  setBind('set-video-autoplay', 'videoAutoplay', true);
  setBind('set-video-loop', 'videoLoop', true);

  const btnClearThumbs = $('btn-set-clear-thumbs');
  if (btnClearThumbs) {
    btnClearThumbs.onclick = async () => {
      try {
        const res = await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'clearThumbCache' }) });
        toast('Kapak resmi önbelleği temizlendi', 'success');
        refreshSettingsCacheStats(res.stats);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  const btnClearRecents = $('btn-set-clear-recents');
  if (btnClearRecents) {
    btnClearRecents.onclick = () => {
      state.recentFolders = [];
      state.recentFiles = [];
      saveDashHistory();
      renderRecentDashboardSections();
      toast('Son açılan klasör ve dosya geçmişi temizlendi', 'success');
    };
  }
  const btnClearFolderViews = $('btn-set-clear-folder-views');
  if (btnClearFolderViews) {
    btnClearFolderViews.onclick = () => {
      state.folderViews = {};
      saveFolderViews();
      const tab = getActiveTab();
      if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
        applyViewModeForFolder(tab.path);
        renderVirtualList();
      }
      refreshSettingsCacheStats();
      toast('Kayıtlı klasör görünümleri temizlendi', 'success');
    };
  }
  const btnResetColWidths = $('btn-set-reset-col-widths');
  if (btnResetColWidths) {
    btnResetColWidths.onclick = resetColumnWidths;
  }
  const btnSetShortcut = $('btn-set-update-shortcut');
  if (btnSetShortcut) btnSetShortcut.onclick = () => $('btn-install-shortcut').click();
  const btnSetReset = $('btn-set-reset-defaults');
  if (btnSetReset) {
    btnSetReset.onclick = () => {
      state.settings = { ...DEFAULT_APP_SETTINGS };
      saveAppSettings();
      applyAppSettings();
      syncSettingsForm();
      applySortAndFilter();
      toast('Ayarlar varsayılana sıfırlandı', 'success');
    };
  }

  $('btn-dual-pane').onclick = toggleDualPane;
  $('btn-close-dual').onclick = toggleDualPane;
  $('dual-btn-back').onclick = () => {
    if (state.dualHistoryIdx > 0) {
      state.dualHistoryIdx--;
      navigateDual(state.dualHistory[state.dualHistoryIdx], false);
    }
  };
  $('dual-btn-up').onclick = () => {
    if (!state.dualPath) return;
    const clean = state.dualPath.replace(/\\+$/, '');
    if (/^[a-zA-Z]:$/.test(clean)) return;
    const parent = clean.substring(0, clean.lastIndexOf('\\'));
    navigateDual(/^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent);
  };
  $('dual-btn-refresh').onclick = () => { if (state.dualPath) navigateDual(state.dualPath, false); };
  $('dual-path-input').onkeydown = (e) => {
    if (e.key === 'Enter') navigateDual($('dual-path-input').value.trim());
  };
  $('dual-quick-select').onchange = (e) => {
    if (e.target.value) {
      navigateDual(e.target.value);
      e.target.value = '';
    }
  };
  $('dual-btn-move-here').onclick = async () => {
    const srcs = Array.from(state.selectedPaths);
    if (!state.dualPath || srcs.length === 0) return toast('Soldan öğe seçin ve sağda hedef açın', 'error');
    await enqueueTransfer('move', srcs, state.dualPath);
  };
  $('dual-btn-copy-here').onclick = async () => {
    const srcs = Array.from(state.selectedPaths);
    if (!state.dualPath || srcs.length === 0) return toast('Soldan öğe seçin ve sağda hedef açın', 'error');
    await enqueueTransfer('copy', srcs, state.dualPath);
  };
  const dualBasketMove = $('dual-btn-basket-move-here');
  if (dualBasketMove) dualBasketMove.onclick = () => transferBasketTo(state.dualPath, 'move');
  $('dual-btn-mkdir').onclick = async () => {
    if (!state.dualPath) return;
    const res = await showPromptModal({ title: 'Sağ Panelde Yeni Klasör', fields: [{ name: 'name', label: 'Klasör Adı', value: 'Yeni Klasör' }], okText: 'Oluştur' });
    if (!res || !res.name.trim()) return;
    await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'mkdir', parentDir: state.dualPath, name: res.name.trim() }) });
    navigateDual(state.dualPath, false);
  };

  $('btn-basket').onclick = () => $('basket-drawer').classList.toggle('hidden');
  $('btn-close-basket').onclick = () => $('basket-drawer').classList.add('hidden');
  $('btn-basket-clear').onclick = () => { state.basket.clear(); renderBasket(); };
  $('btn-basket-move-here').onclick = () => transferBasketTo(getActiveTab()?.path, 'move');
  $('btn-basket-copy-here').onclick = () => transferBasketTo(getActiveTab()?.path, 'copy');
  const bMoveDual = $('btn-basket-move-dual');
  if (bMoveDual) bMoveDual.onclick = () => transferBasketTo(state.dualPath, 'move');
  const bCopyDual = $('btn-basket-copy-dual');
  if (bCopyDual) bCopyDual.onclick = () => transferBasketTo(state.dualPath, 'copy');

  // Transfer Kontrolleri, İşlem Modalı & Hata Merkezi
  const toggleJobPause = async () => {
    const t = procModalState.activeControlType;
    if (!t) return;
    const nextPause = !procModalState.activePaused;
    procModalState.activePaused = nextPause;
    const pauseBtn = $('btn-proc-pause');
    if (pauseBtn) pauseBtn.textContent = nextPause ? '▶ Devam Et' : '⏸ Duraklat';
    await controlTask(t, nextPause ? 'pause' : 'resume', procModalState.activeControlId);
  };
  const cancelActiveProcess = async () => {
    const t = procModalState.activeControlType;
    if (!t) return;
    await controlTask(t, 'cancel', procModalState.activeControlId);
  };

  $('btn-transfer-pause').onclick = toggleJobPause;
  $('btn-transfer-cancel').onclick = async () => {
    const jobId = $('btn-transfer-cancel').dataset.jobId;
    await api('/api/transfer/control', { method: 'POST', body: JSON.stringify({ action: 'cancel', jobId }) });
    pollTransferStatus();
  };
  $('transfer-pill').onclick = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    openProcessModal();
  };

  $('btn-proc-minimize').onclick = minimizeProcessModal;
  $('btn-proc-close').onclick = closeProcessModal;
  $('btn-proc-done').onclick = () => {
    procModalState.mode = 'closed';
    procModalState.trackedJobId = null;
    procModalState.trackedScanId = null;
    $('process-modal').classList.add('hidden');
  };
  {
    const procOverlay = $('process-modal');
    let procPressedOverlay = false;
    procOverlay.addEventListener('pointerdown', (e) => {
      procPressedOverlay = e.target === procOverlay;
    });
    procOverlay.addEventListener('pointerup', (e) => {
      if (procPressedOverlay && e.target === procOverlay) closeProcessModal();
      procPressedOverlay = false;
    });
  }
  $('btn-proc-details').onclick = () => {
    procModalState.detailsOpen = !procModalState.detailsOpen;
    pollTransferStatus();
  };
  $('btn-proc-pause').onclick = toggleJobPause;
  $('btn-proc-cancel').onclick = cancelActiveProcess;
  $('btn-proc-open-errors').onclick = () => {
    minimizeProcessModal();
    openErrorsDialog();
  };

  $('btn-dock-expand').onclick = () => openProcessModal();
  $('btn-dock-pause').onclick = toggleJobPause;
  $('btn-dock-cancel').onclick = cancelActiveProcess;

  $('btn-errors-center').onclick = openErrorsDialog;
  $('btn-err-close').onclick = () => $('errors-dialog').close();
  $('btn-err-refresh').onclick = () => refreshErrorsDialog(true);
  $('btn-err-open-file').onclick = async () => {
    await api('/api/errors', { method: 'POST', body: JSON.stringify({ action: 'openLogFile' }), silentErrors: true });
  };
  const btnDiagCopy = $('btn-err-diag-copy');
  if (btnDiagCopy) btnDiagCopy.onclick = copyFullDiagnosticsReport;
  $('btn-err-copy').onclick = async () => {
    const text = $('errors-logs-tail').textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('Hata günlüğü panoya kopyalandı', 'success');
    } catch {
      toast('Panoya kopyalanamadı', 'error');
    }
  };
  $('btn-err-clear').onclick = async () => {
    localClientErrors.length = 0;
    await api('/api/errors', { method: 'POST', body: JSON.stringify({ action: 'clear' }), silentErrors: true });
    refreshErrorsDialog(true);
    toast('Oturum hata listesi temizlendi');
  };

  window.addEventListener('error', (ev) => {
    const loc = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno || 0}` : '';
    const stack = ev.error && ev.error.stack ? ev.error.stack : '';
    reportClientError('Arayüz Hatası', ev.message || 'Bilinmeyen JS hatası', loc, stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const msg = ev.reason?.message || String(ev.reason || 'Promise hatası');
    const stack = ev.reason && ev.reason.stack ? ev.reason.stack : '';
    if (msg !== 'İptal edildi') reportClientError('Arayüz Promise', msg, '', stack);
  });

  // Sanal Liste Etkileşimi & Scroll
  const vp = $('virtual-viewport');
  vp.onscroll = () => {
    closeColFilterPopover();
    const cur = getActiveTab();
    if (cur && cur.viewType === 'explorer') cur.scrollTop = vp.scrollTop || 0;
    renderVirtualList();
    if (state.thumbMode === 'viewport') scheduleThumbBatch();
  };

  vp.onclick = (e) => {
    state.activePane = 'left';
    if (state.suppressNextClick) {
      state.suppressNextClick = false;
      return;
    }
    const rowEl = e.target.closest('[data-index]');
    if (!rowEl) {
      if (!e.ctrlKey && !e.shiftKey) {
        state.selectedPaths.clear();
        updateSelectionDomInPlace();
        updateStatusCounts();
        updateToolbarButtons();
      }
      return;
    }
    const idx = Number(rowEl.dataset.index);
    const item = state.viewItems[idx];
    if (!item) return;

    if (e.target.closest('.eye-btn')) {
      e.stopPropagation();
      loadSingleThumb(item);
      return;
    }

    const now = Date.now();
    const isCheckbox = e.target.type === 'checkbox';
    if (!isCheckbox && !e.ctrlKey && !e.shiftKey && state.settings.clickMode === 'single') {
      handleItemSelect(idx, e);
      activateItem(item);
      return;
    }
    if (!isCheckbox && !e.ctrlKey && !e.shiftKey && state.lastClickPath === item.path && now - state.lastClickTime < 400) {
      state.lastClickPath = '';
      state.lastClickTime = 0;
      activateItem(item);
      return;
    }

    if (!isCheckbox) {
      state.lastClickPath = item.path;
      state.lastClickTime = now;
    }
    handleItemSelect(idx, e);
  };

  vp.ondblclick = (e) => {
    if (e.target.type === 'checkbox' || e.target.classList.contains('eye-btn')) return;
    const rowEl = e.target.closest('[data-index]');
    if (!rowEl) return;
    const item = state.viewItems[Number(rowEl.dataset.index)];
    if (!item) return;
    state.lastClickPath = '';
    state.lastClickTime = 0;
    activateItem(item);
  };

  vp.onauxclick = (e) => {
    if (e.button === 1) {
      const rowEl = e.target.closest('[data-index]');
      if (!rowEl) return;
      const item = state.viewItems[Number(rowEl.dataset.index)];
      if (item && item.isDir) createTab(item.path, true);
    }
  };

  const dualListEl = $('dual-list');
  if (dualListEl) {
    dualListEl.onclick = (e) => {
      state.activePane = 'dual';
      if (state.suppressNextClick) {
        state.suppressNextClick = false;
        return;
      }
      const rowEl = e.target.closest('.dual-row[data-index]');
      if (!rowEl) {
        if (!e.ctrlKey && !e.shiftKey) {
          state.dualSelectedPaths.clear();
          updateDualSelectionDomInPlace();
        }
        return;
      }
      const idx = Number(rowEl.dataset.index);
      const item = state.dualItems[idx];
      if (!item) return;
      handleDualItemSelect(idx, e);
      if (!e.ctrlKey && !e.shiftKey && state.settings.clickMode === 'single') {
        if (item.isDir) navigateDual(item.path);
        else openExternally(item.path);
      }
    };

    dualListEl.ondblclick = (e) => {
      const rowEl = e.target.closest('.dual-row[data-index]');
      if (!rowEl) return;
      const item = state.dualItems[Number(rowEl.dataset.index)];
      if (!item) return;
      if (item.isDir) navigateDual(item.path);
      else if (shouldOpenInQuickLook(item)) openQuickLook(item, state.dualItems);
      else openExternally(item.path);
    };

    dualListEl.onauxclick = (e) => {
      if (e.button === 1) {
        const rowEl = e.target.closest('.dual-row[data-index]');
        if (!rowEl) return;
        const item = state.dualItems[Number(rowEl.dataset.index)];
        if (item && item.isDir) createTab(item.path, true);
      }
    };
  }

  $('chk-select-all').onchange = (e) => {
    state.selectedPaths.clear();
    if (e.target.checked) {
      for (const it of state.viewItems) state.selectedPaths.add(it.path);
    }
    renderVirtualList();
    updateStatusCounts();
    updateToolbarButtons();
  };

  // Sağ Tık Menüsü (Uygulama Geneli Dinamik Bağlam Menüsü — Edge Menüsü Engelli)
  const ctxMenu = $('context-menu');
  const supportsPopover = 'showPopover' in HTMLElement.prototype;

  window.revealInExplorer = (targetPath) => {
    if (!targetPath || targetPath === 'PC' || targetPath === 'TRASH') return;
    api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'reveal', path: targetPath }) });
  };

  function hideCustomContextMenu() {
    if (supportsPopover) {
      try {
        if (ctxMenu.matches(':popover-open')) ctxMenu.hidePopover();
      } catch {}
    }
    ctxMenu.classList.add('hidden');
  }

  function showCustomContextMenu(e, entries) {
    const clean = (entries || []).filter(Boolean);
    if (clean.length === 0) return;

    ctxMenu.innerHTML = '';
    for (const entry of clean) {
      if (entry.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = `ctx-item${entry.danger ? ' danger' : ''}${entry.disabled ? ' disabled' : ''}`;
      el.innerHTML = `<span>${entry.bold ? `<strong>${esc(entry.label)}</strong>` : esc(entry.label)}</span>${entry.shortcut ? `<span class="ctx-shortcut">${esc(entry.shortcut)}</span>` : ''}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        if (entry.disabled) return;
        if (!entry.keepOpen) hideCustomContextMenu();
        if (entry.onClick) entry.onClick(ev);
      };
      ctxMenu.appendChild(el);
    }

    ctxMenu.classList.remove('hidden');
    if (supportsPopover) {
      try {
        if (!ctxMenu.matches(':popover-open')) ctxMenu.showPopover();
      } catch {}
    }
    const menuW = ctxMenu.offsetWidth || 240;
    const menuH = ctxMenu.offsetHeight || 260;
    ctxMenu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - menuW - 6))}px`;
    ctxMenu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - menuH - 6))}px`;
  }

  document.addEventListener('click', (e) => {
    if (!ctxMenu.contains(e.target)) hideCustomContextMenu();
  });
  window.addEventListener('blur', hideCustomContextMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCustomContextMenu();
  }, true);

  function buildExplorerItemMenu(sel) {
    const first = sel[0];
    const multi = sel.length > 1;
    const tab = getActiveTab();
    const isTrash = tab && tab.path === 'TRASH';

    if (isTrash) {
      return [
        { label: `♻️ Geri Yükle (${sel.length} öğe)`, bold: true, onClick: () => restoreFromTrash(sel.map((s) => s.path)) },
        { label: '🔗 Özgün Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(sel.map((s) => s.origPath || s.path).join('\n')); toast('Özgün yol kopyalandı'); } },
        { sep: true },
        { label: '🔥 Kalıcı Sil', shortcut: 'Del', danger: true, onClick: () => deleteFromTrash(sel.map((s) => s.path)) },
      ];
    }

    const inBasket = sel.every((s) => state.basket.has(s.path));
    return [
      { label: first.isDir ? '📂 Aç' : '🚀 Varsayılan Uygulamada Aç', bold: true, shortcut: 'Enter', onClick: () => (first.isDir ? navigateTo(first.path) : openExternally(first.path)) },
      !first.isDir ? { label: '👁️ Hızlı Önizle', shortcut: 'Space', onClick: () => openQuickLook(first) } : null,
      !multi && !first.isDir ? { label: '✨ Benzer / Yakın Zamanlı Dosyaları Bul...', onClick: () => openRelatedDialog(first) } : null,
      !multi && !first.isDir ? { label: '📅 Aynı Gündeki Dosyaları Göster', onClick: () => runRelatedSearch({ item: first, mode: 'sameDay', scope: 'folder', sameCategoryOnly: 'media' }) } : null,
      first.isDir ? { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(first.path, true) } : null,
      first.isDir ? { label: '📊 Bu Klasörü Analiz Et', onClick: () => openAnalyzer(first.path) } : null,
      { sep: true },
      { label: inBasket ? '🧺 Sepetten Çıkar' : '🧺 Sepete Ekle', shortcut: 'B', onClick: () => toggleSelectedInBasket() },
      first.isDir ? { label: '📌 Sol Menüye Sabitle', onClick: () => togglePin(first.path, first.name, false) } : null,
      { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(first.path) },
      { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(sel.map((s) => s.path).join('\n')); toast('Yol kopyalandı'); } },
      { sep: true },
      { label: '✂️ Kes', shortcut: 'Ctrl+X', onClick: () => setClipboard('cut') },
      { label: '📋 Kopyala', shortcut: 'Ctrl+C', onClick: () => setClipboard('copy') },
      (state.recentTransferTargets && state.recentTransferTargets.length > 0)
        ? {
            label: `⚡ Son Erişilen Yollara Gönder (${state.recentTransferTargets.length})`,
            shortcut: '▸',
            keepOpen: true,
            onClick: (ev) => {
              const selPaths = sel.map((s) => s.path);
              const subEntries = [
                {
                  label: '← Ana Menüye Dön',
                  keepOpen: true,
                  onClick: (ev2) => showCustomContextMenu(ev2, buildExplorerItemMenu(sel)),
                },
                { sep: true },
                ...state.recentTransferTargets.map((rt) => {
                  const autoOp = resolveDragOp(selPaths, rt.path, false, false);
                  return {
                    label: `${autoOp === 'copy' ? '📋 Kopyala' : '📦 Taşı'} → ${rt.name}`,
                    shortcut: rt.path.length > 26 ? '…' + rt.path.slice(-24) : rt.path,
                    onClick: () => enqueueTransfer(autoOp, selPaths, rt.path),
                  };
                }),
              ];
              showCustomContextMenu(ev, subEntries);
            },
          }
        : null,
      state.clipboard.paths.length > 0 && first.isDir && !multi
        ? { label: '📥 Bu Klasöre Yapıştır', onClick: () => enqueueTransfer(state.clipboard.op, state.clipboard.paths, first.path) }
        : null,
      state.basket.size > 0 && first.isDir && !multi
        ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, onClick: () => transferBasketTo(first.path, 'move') }
        : null,
      state.basket.size > 0 && first.isDir && !multi
        ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(first.path, 'copy') }
        : null,
      { label: multi ? '🔢 Toplu Adlandır' : '✏️ Yeniden Adlandır', shortcut: multi ? '' : 'F2', onClick: () => (multi ? batchRenameSelected(sel) : renameSelected()) },
      { sep: true },
      { label: '🗑️ Çöpe At', shortcut: 'Del', danger: true, onClick: () => deleteSelected(false) },
      { label: '🔥 Kalıcı Sil', shortcut: 'Shift+Del', danger: true, onClick: () => deleteSelected(true) },
      { sep: true },
      { label: 'ℹ️ Dosya Bilgisi / Özellikler', shortcut: 'Alt+Enter', onClick: () => showPropertiesModal(sel.map((s) => s.path)) },
    ];
  }

  function buildFolderBgMenu(tab) {
    if (!tab || tab.path === 'PC') {
      return [
        { label: '🔄 Sürücüleri Yenile', shortcut: 'F5', onClick: () => hydrateInitData(false) },
        { label: '🗑️ Çöp Kutusunu Aç', onClick: () => navigateTo('TRASH') },
        state.undoSummary?.canUndo ? { label: `↩️ Geri Al (${state.undoSummary.topLabel})`, shortcut: 'Ctrl+Z', onClick: () => performUndo() } : null,
      ];
    }
    if (tab.path === 'TRASH') {
      return [
        { label: '🔄 Yenile', shortcut: 'F5', onClick: () => navigateTo('TRASH', { pushHistory: false, forceRefresh: true, preserveScroll: true }) },
        { label: '✅ Tümünü Seç', shortcut: 'Ctrl+A', disabled: state.viewItems.length === 0, onClick: () => $('chk-select-all').click() },
        { sep: true },
        { label: '🧹 Çöp Kutusunu Boşalt', danger: true, disabled: state.rawItems.length === 0, onClick: () => emptyTrash() },
      ];
    }
    return [
      { label: '📥 Yapıştır', shortcut: 'Ctrl+V', onClick: () => pasteToCurrentFolder() },
      state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, bold: true, onClick: () => transferBasketTo(tab.path, 'move') } : null,
      state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(tab.path, 'copy') } : null,
      { label: '📁 Yeni Klasör', shortcut: 'Ctrl+Shift+N', onClick: () => createNewFolder() },
      { sep: true },
      { label: '✅ Tümünü Seç', shortcut: 'Ctrl+A', disabled: state.viewItems.length === 0, onClick: () => { for (const it of state.viewItems) state.selectedPaths.add(it.path); renderVirtualList(); updateStatusCounts(); updateToolbarButtons(); } },
      { label: '↩️ Geri Al', shortcut: 'Ctrl+Z', disabled: !state.undoSummary?.canUndo, onClick: () => performUndo() },
      { label: '🔄 Yenile', shortcut: 'F5', onClick: () => navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true }) },
      { sep: true },
      { label: '📂 Bulunduğu Yeri Aç (Gezgin)', onClick: () => revealInExplorer(tab.path) },
      { label: '🔗 Klasör Yolunu Kopyala', onClick: () => { navigator.clipboard.writeText(tab.path); toast('Klasör yolu kopyalandı'); } },
      { label: '📌 Sol Menüye Sabitle', onClick: () => togglePin(tab.path, getFolderTitle(tab.path), false) },
      { label: '📊 Bu Klasörü Analiz Et', onClick: () => openAnalyzer(tab.path) },
      { label: 'ℹ️ Klasör Bilgisi / Özellikler', shortcut: 'Alt+Enter', onClick: () => showPropertiesModal([tab.path]) },
    ];
  }

  document.addEventListener('contextmenu', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();

    // 1) QuickLook Önizleme Penceresi
    if ($('quicklook-dialog').open && $('quicklook-dialog').contains(e.target)) {
      const item = state.qlMediaItems[state.qlIndex];
      if (!item) return;
      const inBasket = state.basket.has(item.path);
      showCustomContextMenu(e, [
        { label: '🚀 Varsayılan Uygulamada Aç', bold: true, onClick: () => openExternally(item.path) },
        { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(item.path) },
        { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(item.path); toast('Yol kopyalandı'); } },
        { sep: true },
        { label: inBasket ? '🧺 Sepetten Çıkar' : '🧺 Sepete Ekle ve Sonrakine Geç', shortcut: 'B', onClick: () => triageQuickLookBasket() },
        { label: '◀ Önceki', shortcut: '←', disabled: state.qlIndex <= 0, onClick: () => $('btn-ql-prev').click() },
        { label: 'Sonraki ▶', shortcut: '→', disabled: state.qlIndex >= state.qlMediaItems.length - 1, onClick: () => $('btn-ql-next').click() },
        { label: '🔍 Yakınlaştırmayı Sıfırla (%100)', shortcut: '0', disabled: state.qlZoom <= 1.01, onClick: () => setQuickLookZoom(1) },
        { sep: true },
        { label: '🗑️ Çöpe At', shortcut: 'Del', danger: true, onClick: () => triageQuickLookDelete(false) },
        { label: '🔥 Kalıcı Sil', shortcut: 'Shift+Del', danger: true, onClick: () => triageQuickLookDelete(true) },
        { sep: true },
        { label: 'ℹ️ Dosya Bilgisi / Özellikler', onClick: () => showPropertiesModal([item.path]) },
      ]);
      return;
    }

    // 2) Orta Dosya Listesi (#virtual-viewport)
    if (vp.contains(e.target)) {
      const rowEl = e.target.closest('[data-index]');
      if (rowEl) {
        const idx = Number(rowEl.dataset.index);
        const item = state.viewItems[idx];
        if (item && !state.selectedPaths.has(item.path)) {
          state.selectedPaths.clear();
          state.selectedPaths.add(item.path);
          renderVirtualList();
          updateStatusCounts();
          updateToolbarButtons();
        }
        const sel = getSelectedItems();
        if (sel.length > 0) showCustomContextMenu(e, buildExplorerItemMenu(sel));
      } else {
        showCustomContextMenu(e, buildFolderBgMenu(getActiveTab()));
      }
      return;
    }

    // 3) Sağ Çift Panel (#dual-list)
    const dualListEl = $('dual-list');
    if (dualListEl && dualListEl.contains(e.target)) {
      state.activePane = 'dual';
      const row = e.target.closest('.dual-row');
      const tab = getActiveTab();
      const leftCanReceive = tab && tab.path !== 'PC' && tab.path !== 'TRASH';
      if (row) {
        const p = row.dataset.path;
        const idx = Number(row.dataset.index);
        if (!state.dualSelectedPaths.has(p)) {
          state.dualSelectedPaths.clear();
          state.dualSelectedPaths.add(p);
          if (!Number.isNaN(idx)) state.dualLastClickedIdx = idx;
          updateDualSelectionDomInPlace();
        }
        const dualSelPaths = state.dualSelectedPaths.size > 0 ? Array.from(state.dualSelectedPaths) : [p];
        const dualSelItems = getDualSelectedItems();
        const isDir = row.dataset.isdir === '1';
        const multiCount = dualSelPaths.length;
        const countTag = multiCount > 1 ? ` (${multiCount})` : '';
        const dualItem = state.dualItems.find((x) => x.path === p) || { path: p, isDir, name: getFolderTitle(p), size: 0, mtime: Date.now(), category: 'other' };
        showCustomContextMenu(e, [
          multiCount === 1 ? { label: isDir ? '📂 Sağ Panelde Aç' : '🚀 Varsayılan Uygulamada Aç', bold: true, onClick: () => (isDir ? navigateDual(p) : openExternally(p)) } : null,
          multiCount === 1 && isDir ? { label: '📑 Sol Sekmede Aç', onClick: () => navigateTo(p) } : null,
          multiCount === 1 && !isDir ? { label: '👁️ Hızlı Önizle', onClick: () => openQuickLook(dualItem, state.dualItems) } : null,
          multiCount === 1 ? { sep: true } : null,
          leftCanReceive ? { label: `⬅ Sol Panele Taşı${countTag}`, onClick: () => enqueueTransfer('move', dualSelPaths, tab.path) } : null,
          leftCanReceive ? { label: `📋 Sol Panele Kopyala${countTag}`, onClick: () => enqueueTransfer('copy', dualSelPaths, tab.path) } : null,
          multiCount === 1 && state.basket.size > 0 && isDir ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, bold: true, onClick: () => transferBasketTo(p, 'move') } : null,
          multiCount === 1 && state.basket.size > 0 && isDir ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(p, 'copy') } : null,
          { label: `🧺 Sepete Ekle / Çıkar${countTag}`, onClick: () => toggleSelectedInBasket(dualSelItems.length ? dualSelItems : [dualItem]) },
          { sep: true },
          { label: `✂️ Kes${countTag}`, shortcut: 'Ctrl+X', onClick: () => setClipboard('cut', dualSelPaths) },
          { label: `📋 Kopyala${countTag}`, shortcut: 'Ctrl+C', onClick: () => setClipboard('copy', dualSelPaths) },
          { label: multiCount > 1 ? `✏️ Toplu Yeniden Adlandır (${multiCount})` : '✏️ Yeniden Adlandır', shortcut: 'F2', onClick: () => renameSelected(dualSelItems.length ? dualSelItems : [dualItem]) },
          { sep: true },
          multiCount === 1 ? { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(p) } : null,
          { label: multiCount > 1 ? `🔗 Yolları Kopyala (${multiCount})` : '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(dualSelPaths.join('\n')); toast('Yol kopyalandı'); } },
          { sep: true },
          { label: `🗑️ Çöpe At${countTag}`, shortcut: 'Del', danger: true, onClick: () => deleteSelected(false, dualSelPaths) },
          { label: `🔥 Kalıcı Sil${countTag}`, shortcut: 'Shift+Del', danger: true, onClick: () => deleteSelected(true, dualSelPaths) },
          { sep: true },
          { label: `ℹ️ Özellikler${countTag}`, shortcut: 'Alt+Enter', onClick: () => showPropertiesModal(dualSelPaths) },
        ]);
      } else if (state.dualPath) {
        showCustomContextMenu(e, [
          state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, bold: true, onClick: () => transferBasketTo(state.dualPath, 'move') } : null,
          state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(state.dualPath, 'copy') } : null,
          state.basket.size > 0 ? { sep: true } : null,
          { label: '📥 Buraya Yapıştır', shortcut: 'Ctrl+V', onClick: () => pasteToCurrentFolder(state.dualPath) },
          { label: '📁 Yeni Klasör', onClick: () => $('dual-btn-mkdir').click() },
          { label: '🔄 Yenile', onClick: () => navigateDual(state.dualPath, false) },
          { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(state.dualPath) },
          { label: 'ℹ️ Klasör Bilgisi / Özellikler', onClick: () => showPropertiesModal([state.dualPath]) },
        ]);
      }
      return;
    }

    // 4) Sol Gezinti Menüsü (.sidebar)
    const sidebarEl = document.querySelector('.sidebar');
    if (sidebarEl && sidebarEl.contains(e.target)) {
      const sbItem = e.target.closest('.sidebar-item[data-path]');
      if (sbItem) {
        const p = sbItem.dataset.path;
        if (p === 'PC') {
          showCustomContextMenu(e, [
            { label: '🖥️ Bu Bilgisayar\'ı Aç', bold: true, onClick: () => navigateTo('PC') },
            { label: '🔄 Sürücüleri Yenile', onClick: () => hydrateInitData(false) },
          ]);
        } else if (p === 'TRASH') {
          showCustomContextMenu(e, [
            { label: '🗑️ Çöp Kutusunu Aç', bold: true, onClick: () => navigateTo('TRASH') },
            { label: '📑 Yeni Sekmede Aç', onClick: () => createTab('TRASH', true) },
            { sep: true },
            { label: '🧹 Çöp Kutusunu Boşalt', danger: true, onClick: () => navigateTo('TRASH').then(() => emptyTrash()) },
          ]);
        } else {
          const isPinned = state.pins.some((x) => x.path.toLowerCase() === p.toLowerCase());
          showCustomContextMenu(e, [
            { label: '📂 Aç', bold: true, onClick: () => navigateTo(p) },
            { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(p, true) },
            state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, onClick: () => transferBasketTo(p, 'move') } : null,
            state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(p, 'copy') } : null,
            { sep: true },
            { label: isPinned ? '📌 Sabitlemeyi Kaldır' : '📌 Sabitle', onClick: () => togglePin(p, getFolderTitle(p), isPinned) },
            { label: '📊 Disk / Klasör Analizi', onClick: () => openAnalyzer(p) },
            { label: '📂 Bulunduğu Yeri Aç (Gezgin)', onClick: () => revealInExplorer(p) },
            { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
            { label: 'ℹ️ Özellikler / Toplam Boyut', onClick: () => showPropertiesModal([p]) },
          ]);
        }
        return;
      }
    }

    // 5) Analiz / Kopya Listesi Satırları
    const analyzerRow = e.target.closest('.analyzer-row, .dupe-file-row');
    if (analyzerRow && analyzerRow.title) {
      const p = analyzerRow.title;
      showCustomContextMenu(e, [
        { label: '📂 Bulunduğu Yeri Aç', bold: true, onClick: () => revealInExplorer(p) },
        { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
        { label: 'ℹ️ Dosya Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) },
        { sep: true },
        { label: '🗑️ Çöpe At', danger: true, onClick: () => deleteSelected(false, [p]) },
      ]);
      return;
    }

    // 5.5) Bu Bilgisayar Dashboard Kartları (Hızlı Erişim / Son Klasörler / Son Dosyalar)
    const recentCard = e.target.closest('.recent-card[data-path]');
    if (recentCard) {
      const p = recentCard.dataset.path;
      const rType = recentCard.dataset.rtype;
      if (rType === 'folder') {
        showCustomContextMenu(e, [
          { label: '📂 Klasörü Aç', bold: true, onClick: () => navigateTo(p) },
          { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(p, true) },
          { label: '📂 Bulunduğu Yeri Aç (Gezgin)', onClick: () => revealInExplorer(p) },
          { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
          { label: 'ℹ️ Klasör Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) },
          { sep: true },
          { label: '✕ Son Klasörlerden Kaldır', onClick: () => removeRecentEntry('folder', p) },
        ]);
      } else {
        const rf = state.recentFiles.find((x) => x.path === p) || { path: p, name: getFolderTitle(p), category: 'other', isDir: false, size: 0, mtime: Date.now() };
        showCustomContextMenu(e, [
          { label: '🚀 Varsayılan Uygulamada Aç', bold: true, onClick: () => openExternally(p) },
          { label: '👁️ Hızlı Önizle', onClick: () => openQuickLook(rf, state.recentFiles) },
          { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(p) },
          { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
          { label: 'ℹ️ Dosya Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) },
          { sep: true },
          { label: '✕ Son Dosyalardan Kaldır', onClick: () => removeRecentEntry('file', p) },
        ]);
      }
      return;
    }

    const quickCard = e.target.closest('.quick-card[data-path]');
    if (quickCard) {
      const p = quickCard.dataset.path;
      showCustomContextMenu(e, [
        { label: '📂 Aç', bold: true, onClick: () => navigateTo(p) },
        { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(p, true) },
        p !== 'TRASH' ? { label: '📂 Windows Gezgini\'nde Aç', onClick: () => revealInExplorer(p) } : null,
        p !== 'TRASH' ? { label: 'ℹ️ Klasör Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) } : null,
      ]);
      return;
    }

    // 6) Diğer Alanlar (Toolbar, Dashboard vb.) — Edge menüsü yerine program menüsü
    const tab = getActiveTab();
    showCustomContextMenu(e, [
      { label: '🔄 Yenile', shortcut: 'F5', onClick: () => $('btn-refresh').click() },
      { label: '↩️ Geri Al', shortcut: 'Ctrl+Z', disabled: !state.undoSummary?.canUndo, onClick: () => performUndo() },
      { sep: true },
      { label: '🖥️ Bu Bilgisayar', onClick: () => navigateTo('PC') },
      { label: '🗑️ Çöp Kutusu', onClick: () => navigateTo('TRASH') },
      tab && tab.path !== 'PC' && tab.path !== 'TRASH'
        ? { label: '📂 Mevcut Konumu Gezgin\'de Aç', onClick: () => revealInExplorer(tab.path) }
        : null,
      { sep: true },
      { label: '⚙️ Ayarlar', shortcut: 'Ctrl+,', onClick: () => openSettingsDialog() },
    ]);
  });

  // QuickLook Kontrolleri & Yakınlaştırma + Hızlı Ayıklama (Triage)
  $('btn-ql-close').onclick = closeQuickLook;
  $('btn-ql-basket').onclick = triageQuickLookBasket;
  $('btn-ql-delete').onclick = () => triageQuickLookDelete(false);
  if ($('btn-ql-frame-prev')) $('btn-ql-frame-prev').onclick = (e) => stepQuickLookVideoFrame(e?.shiftKey ? -5 : -1);
  if ($('btn-ql-frame-next')) $('btn-ql-frame-next').onclick = (e) => stepQuickLookVideoFrame(e?.shiftKey ? 5 : 1);
  if ($('btn-ql-capture')) $('btn-ql-capture').onclick = captureQuickLookFrame;
  if ($('btn-ql-trim-toggle')) $('btn-ql-trim-toggle').onclick = toggleQuickLookTrimBar;
  if ($('btn-ql-trim-close')) $('btn-ql-trim-close').onclick = () => $('ql-trim-bar')?.classList.add('hidden');
  if ($('btn-ql-set-start')) {
    $('btn-ql-set-start').onclick = () => {
      const vid = $('ql-stage')?.querySelector('video');
      if (vid && $('ql-trim-start')) {
        $('ql-trim-start').value = Number(vid.currentTime || 0).toFixed(1);
        updateTrimDurationUi();
      }
    };
  }
  if ($('btn-ql-set-end')) {
    $('btn-ql-set-end').onclick = () => {
      const vid = $('ql-stage')?.querySelector('video');
      if (vid && $('ql-trim-end')) {
        $('ql-trim-end').value = Number(vid.currentTime || 0).toFixed(1);
        updateTrimDurationUi();
      }
    };
  }
  if ($('ql-trim-start')) $('ql-trim-start').oninput = updateTrimDurationUi;
  if ($('ql-trim-end')) $('ql-trim-end').oninput = updateTrimDurationUi;
  if ($('btn-ql-trim-preview')) {
    $('btn-ql-trim-preview').onclick = () => {
      const vid = $('ql-stage')?.querySelector('video');
      if (!vid) return;
      if (state.qlTrimPreviewLoop) {
        vid.pause();
        state.qlTrimPreviewLoop = false;
        updateTrimPreviewBtnUi();
        return;
      }
      const startSec = Number($('ql-trim-start')?.value || 0);
      const endSec = Number($('ql-trim-end')?.value || 0);
      if (endSec <= startSec + 0.1) return toast('Önizleme için Bitiş > Başlangıç olmalı', 'error');
      vid.currentTime = startSec;
      state.qlTrimPreviewLoop = true;
      updateTrimPreviewBtnUi();
      vid.play().catch(() => {});
    };
  }
  const trimTrack = $('ql-trim-track');
  if (trimTrack) {
    let dragMode = null; // 'a' | 'b' | 'seek'
    const applyTrackPointer = (clientX, mode) => {
      const vid = $('ql-stage')?.querySelector('video');
      const rect = trimTrack.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const dur = getTrimVideoDuration(vid);
      const t = ratio * dur;
      if (mode === 'a') {
        const endSec = Number($('ql-trim-end')?.value || dur);
        const clamped = Math.max(0, Math.min(Math.max(0, endSec - 0.1), t));
        $('ql-trim-start').value = clamped.toFixed(1);
        if (vid) vid.currentTime = clamped;
        updateTrimDurationUi();
      } else if (mode === 'b') {
        const startSec = Number($('ql-trim-start')?.value || 0);
        const clamped = Math.min(dur, Math.max(Math.min(dur, startSec + 0.1), t));
        $('ql-trim-end').value = clamped.toFixed(1);
        if (vid) vid.currentTime = clamped;
        updateTrimDurationUi();
      } else if (vid) {
        vid.currentTime = t;
        updateTrimPlayheadUi();
      }
    };
    trimTrack.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('#ql-trim-handle-a')) dragMode = 'a';
      else if (e.target.closest('#ql-trim-handle-b')) dragMode = 'b';
      else dragMode = 'seek';
      try { trimTrack.setPointerCapture(e.pointerId); } catch {}
      applyTrackPointer(e.clientX, dragMode);
    });
    trimTrack.addEventListener('pointermove', (e) => {
      if (!dragMode) return;
      applyTrackPointer(e.clientX, dragMode);
    });
    const endTrackDrag = (e) => {
      if (!dragMode) return;
      dragMode = null;
      try { trimTrack.releasePointerCapture(e.pointerId); } catch {}
    };
    trimTrack.addEventListener('pointerup', endTrackDrag);
    trimTrack.addEventListener('pointercancel', endTrackDrag);
  }
  if ($('btn-ql-trim-run')) $('btn-ql-trim-run').onclick = runQuickLookTrim;
  $('btn-ql-zoom-in').onclick = () => setQuickLookZoom(state.qlZoom * 1.25);
  $('btn-ql-zoom-out').onclick = () => setQuickLookZoom(state.qlZoom / 1.25);
  $('btn-ql-zoom-reset').onclick = () => setQuickLookZoom(1);
  const brRange = $('ql-brightness-range');
  const brReset = $('btn-ql-bright-reset');
  if (brRange) brRange.oninput = (e) => setQuickLookBrightness(e.target.value);
  if (brReset) brReset.onclick = () => setQuickLookBrightness(100);
  $('btn-ql-prev').onclick = () => {
    if (state.qlIndex > 0) {
      state.qlIndex--;
      renderQuickLookStage(state.qlMediaItems[state.qlIndex]);
    }
  };
  $('btn-ql-next').onclick = () => {
    if (state.qlIndex < state.qlMediaItems.length - 1) {
      state.qlIndex++;
      renderQuickLookStage(state.qlMediaItems[state.qlIndex]);
    }
  };
  const stPrevBtn = $('btn-ql-stage-prev');
  const stNextBtn = $('btn-ql-stage-next');
  if (stPrevBtn) stPrevBtn.onclick = (e) => { e.stopPropagation(); $('btn-ql-prev').click(); };
  if (stNextBtn) stNextBtn.onclick = (e) => { e.stopPropagation(); $('btn-ql-next').click(); };
  $('quicklook-dialog').addEventListener('close', () => {
    $('ql-stage').innerHTML = '';
  });

  const qlStage = $('ql-stage');
  qlStage.addEventListener('wheel', (e) => {
    if (!$('quicklook-dialog').open) return;
    if (!qlStage.querySelector('img, video')) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    setQuickLookZoom(state.qlZoom * factor);
  }, { passive: false });

  let qlPanning = false;
  let qlPanStartX = 0;
  let qlPanStartY = 0;
  let qlOrigX = 0;
  let qlOrigY = 0;
  let qlPanMoved = false;

  qlStage.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || state.qlZoom <= 1.01) return;
    if (e.target.tagName === 'VIDEO' && e.offsetY > e.target.clientHeight - 44) return;
    e.preventDefault();
    qlPanning = true;
    qlPanMoved = false;
    qlPanStartX = e.clientX;
    qlPanStartY = e.clientY;
    qlOrigX = state.qlPanX;
    qlOrigY = state.qlPanY;
    qlStage.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!qlPanning) return;
    const dx = e.clientX - qlPanStartX;
    const dy = e.clientY - qlPanStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) qlPanMoved = true;
    state.qlPanX = qlOrigX + dx;
    state.qlPanY = qlOrigY + dy;
    applyQuickLookTransform();
  });
  window.addEventListener('mouseup', () => {
    if (!qlPanning) return;
    qlPanning = false;
    qlStage.classList.remove('dragging');
  });
  qlStage.addEventListener('click', (e) => {
    if (qlPanMoved) {
      e.preventDefault();
      e.stopPropagation();
      qlPanMoved = false;
    }
  }, true);
  {
    const outsideDialog = (e, dlg) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dlg of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dlg.addEventListener('pointerdown', (e) => {
        pressedOutside = dlg.open && outsideDialog(e, dlg);
      });
      dlg.addEventListener('pointerup', (e) => {
        if (pressedOutside && dlg.open && outsideDialog(e, dlg)) {
          if (dlg.id === 'quicklook-dialog') closeQuickLook();
          else dlg.close();
        }
        pressedOutside = false;
      });
    }
  }

  // Fare yan tuşları (Mouse 4 Geri / Mouse 5 İleri)
  window.addEventListener('mousedown', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      if ($('quicklook-dialog').open) $('btn-ql-prev').click();
      else $('btn-back').click();
    } else if (e.button === 4) {
      e.preventDefault();
      if ($('quicklook-dialog').open) $('btn-ql-next').click();
      else $('btn-forward').click();
    }
  });

  // Global Klavye Kısayolları
  document.addEventListener('keydown', (e) => {
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

    if ($('quicklook-dialog').open) {
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        closeQuickLook();
      } else if (e.key === 'ArrowLeft') $('btn-ql-prev').click();
      else if (e.key === 'ArrowRight') $('btn-ql-next').click();
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setQuickLookZoom(state.qlZoom * 1.25); }
      else if (e.key === '-') { e.preventDefault(); setQuickLookZoom(state.qlZoom / 1.25); }
      else if (e.key === '0') { e.preventDefault(); setQuickLookZoom(1); }
      else if (e.key.toLowerCase() === 'b') { e.preventDefault(); triageQuickLookBasket(); }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); captureQuickLookFrame(); }
      else if (!isInput && (e.key === ',' || e.key === '<')) { e.preventDefault(); stepQuickLookVideoFrame(e.shiftKey ? -5 : -1); }
      else if (!isInput && (e.key === '.' || e.key === '>')) { e.preventDefault(); stepQuickLookVideoFrame(e.shiftKey ? 5 : 1); }
      else if (e.key === 'Delete') { e.preventDefault(); triageQuickLookDelete(e.shiftKey); }
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleDragShelfVisible();
      return;
    }

    if (e.key === 'Escape' && !$('process-modal').classList.contains('hidden')) {
      e.preventDefault();
      closeProcessModal();
      return;
    }

    if (e.key === 'F3') {
      e.preventDefault();
      toggleDualPane();
      return;
    }

    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      openSettingsDialog();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-input').focus();
      $('search-input').select();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      $('address-wrapper').click();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      createTab('PC', true);
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeTab(state.activeTabId);
      return;
    }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); $('btn-back').click(); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); $('btn-forward').click(); return; }
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); $('btn-up').click(); return; }
    if (e.key === 'F5') { e.preventDefault(); $('btn-refresh').click(); return; }

    if (isInput) return;

    const activeTab = getActiveTab();
    const inTrash = activeTab && activeTab.path === 'TRASH';
    const inDual = Boolean(state.dualOpen && state.activePane === 'dual');

    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      performUndo();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (inDual) $('dual-btn-mkdir').click();
      else if (!inTrash) createNewFolder();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (inDual) {
        for (const it of state.dualItems) state.dualSelectedPaths.add(it.path);
        updateDualSelectionDomInPlace();
      } else {
        for (const it of state.viewItems) state.selectedPaths.add(it.path);
        renderVirtualList();
        updateStatusCounts();
        updateToolbarButtons();
      }
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      if (inDual) setClipboard('copy', Array.from(state.dualSelectedPaths));
      else if (!inTrash) setClipboard('copy');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      if (inDual) setClipboard('cut', Array.from(state.dualSelectedPaths));
      else if (!inTrash) setClipboard('cut');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      if (inDual) pasteToCurrentFolder(state.dualPath);
      else if (!inTrash) pasteToCurrentFolder();
    } else if (e.key === 'F2') {
      e.preventDefault();
      if (inDual) renameSelected(getDualSelectedItems());
      else if (!inTrash) renameSelected();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (inDual) deleteSelected(e.shiftKey, Array.from(state.dualSelectedPaths));
      else if (inTrash) deleteFromTrash();
      else deleteSelected(e.shiftKey);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      if (inDual) $('dual-btn-up').click();
      else $('btn-up').click();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (inDual) {
        const sel = getDualSelectedItems();
        if (sel.length > 0 && !sel[0].isDir) openQuickLook(sel[0], state.dualItems);
      } else if (!inTrash) {
        const sel = getSelectedItems();
        if (sel.length > 0 && !sel[0].isDir) openQuickLook(sel[0]);
      }
    } else if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      if (inDual) showPropertiesModal(Array.from(state.dualSelectedPaths));
      else if (!inTrash) showPropertiesModal();
    } else if (e.key === 'Enter') {
      if (inDual) {
        const sel = getDualSelectedItems();
        if (sel.length === 1) {
          if (sel[0].isDir) navigateDual(sel[0].path);
          else openExternally(sel[0].path);
        }
      } else {
        const sel = getSelectedItems();
        if (sel.length === 1) {
          activateItem(sel[0]);
        }
      }
    } else if (e.key.toLowerCase() === 'b' && !e.ctrlKey) {
      e.preventDefault();
      if (inDual) toggleSelectedInBasket(getDualSelectedItems());
      else if (!inTrash) toggleSelectedInBasket();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (inDual) {
        if (state.dualItems.length === 0) return;
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = Math.max(0, Math.min(state.dualItems.length - 1, state.dualLastClickedIdx + step));
        handleDualItemSelect(next, e);
        const listEl = $('dual-list');
        const rowEl = listEl?.querySelector(`.dual-row[data-index="${next}"]`);
        if (rowEl) rowEl.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (state.viewItems.length === 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(state.viewItems.length - 1, state.lastClickedIndex + step));
      handleItemSelect(next, e);
      const vp = $('virtual-viewport');
      const { rowHeight, cols } = getLayoutMetrics();
      const rowTop = Math.floor(next / cols) * rowHeight;
      if (rowTop < vp.scrollTop) vp.scrollTop = rowTop;
      else if (rowTop + rowHeight > vp.scrollTop + vp.clientHeight) vp.scrollTop = rowTop + rowHeight - vp.clientHeight;
    }
  });
}

// ---------- Pencere Boyutu & Konum Hafızası ----------
function setupWindowBoundsPersistence() {
  let lastSaved = '';
  let timer = null;

  const persistNow = (syncBeacon = false) => {
    const x = Math.round(window.screenX);
    const y = Math.round(window.screenY);
    const width = Math.round(window.outerWidth);
    const height = Math.round(window.outerHeight);
    if (width < 400 || height < 300 || x < -4000 || y < -4000) return;
    const b = { x, y, width, height };
    const key = `${b.x},${b.y},${b.width},${b.height}`;
    if (key === lastSaved) return;
    lastSaved = key;
    try { localStorage.setItem('ld_window_bounds', key); } catch {}
    if (syncBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/window-bounds', new Blob([JSON.stringify(b)], { type: 'application/json' }));
    } else {
      api('/api/window-bounds', { method: 'POST', body: JSON.stringify(b), silentErrors: true, timeoutMs: 2500 }).catch(() => {});
    }
  };

  const schedulePersist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => persistNow(false), 450);
  };

  window.addEventListener('resize', schedulePersist);
  setInterval(() => persistNow(false), 1500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow(true);
  });
  window.addEventListener('beforeunload', () => persistNow(true));
}

async function restoreWindowBounds() {
  try {
    const b = await api('/api/window-bounds', { silentErrors: true, timeoutMs: 1500 });
    if (b && b.width >= 400 && b.height >= 300) {
      window.resizeTo(b.width, b.height);
      if (Number(b.x) > -4000 && Number(b.y) > -4000) {
        window.moveTo(b.x, b.y);
      }
    }
  } catch {}
}

// ---------- Görünüm, Sıralama & Hızlı Erişim Geçmişi Tercihleri ----------
function saveDashHistory() {
  try {
    localStorage.setItem('ld_recent_folders', JSON.stringify(state.recentFolders.slice(0, 24)));
    localStorage.setItem('ld_recent_files', JSON.stringify(state.recentFiles.slice(0, 30)));
  } catch {}
}

function loadDashHistory() {
  try {
    const rf = JSON.parse(localStorage.getItem('ld_recent_folders') || '[]');
    if (Array.isArray(rf)) state.recentFolders = rf.slice(0, 24);
  } catch {}
  try {
    const rfi = JSON.parse(localStorage.getItem('ld_recent_files') || '[]');
    if (Array.isArray(rfi)) state.recentFiles = rfi.slice(0, 30);
  } catch {}
}

function recordRecentFolder(dirPath) {
  if (!dirPath || dirPath === 'PC' || dirPath === 'TRASH') return;
  try { localStorage.setItem('ld_last_folder', String(dirPath)); } catch {}
  const clean = String(dirPath).replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(clean)) return; // Sürücü kökleri zaten üstte
  const norm = clean.toLowerCase();
  state.recentFolders = [
    { path: clean, name: getFolderTitle(clean), parent: clean.substring(0, clean.lastIndexOf('\\')) || clean, time: Date.now() },
    ...state.recentFolders.filter((x) => (x.path || '').toLowerCase() !== norm),
  ].slice(0, 24);
  saveDashHistory();
}

function recordRecentFile(itemOrPath) {
  const isObj = itemOrPath && typeof itemOrPath === 'object';
  const p = isObj ? itemOrPath.path : String(itemOrPath || '');
  if (!p || p === 'PC' || p === 'TRASH') return;
  const norm = p.toLowerCase();
  const idxSlash = p.lastIndexOf('\\');
  const name = (isObj && itemOrPath.name) ? itemOrPath.name : (idxSlash >= 0 ? p.slice(idxSlash + 1) : p);
  const dir = idxSlash > 0 ? p.slice(0, idxSlash) : '';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  const guessCat = (isObj && itemOrPath.category)
    ? itemOrPath.category
    : /\.(jpg|jpeg|png|webp|gif|bmp|heic|avif|svg)$/i.test(ext) ? 'image'
      : /\.(mp4|mkv|avi|mov|wmv|webm|m4v)$/i.test(ext) ? 'video'
        : /\.(mp3|flac|wav|aac|ogg|m4a)$/i.test(ext) ? 'audio'
          : /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|md|csv)$/i.test(ext) ? 'document'
            : /\.(zip|rar|7z|tar|gz|iso)$/i.test(ext) ? 'archive'
              : /\.(js|ts|py|html|css|json|sql|cpp|c|h|cs)$/i.test(ext) ? 'code'
                : 'other';
  state.recentFiles = [
    {
      path: p,
      name,
      dir,
      category: guessCat,
      isDir: false,
      size: isObj ? (Number(itemOrPath.size) || 0) : 0,
      mtime: isObj ? (Number(itemOrPath.mtime) || Date.now()) : Date.now(),
      time: Date.now(),
    },
    ...state.recentFiles.filter((x) => (x.path || '').toLowerCase() !== norm),
  ].slice(0, 30);
  saveDashHistory();
}

function removeRecentEntry(type, targetPath) {
  const norm = (targetPath || '').toLowerCase();
  if (type === 'folder') {
    state.recentFolders = state.recentFolders.filter((x) => (x.path || '').toLowerCase() !== norm);
  } else {
    state.recentFiles = state.recentFiles.filter((x) => (x.path || '').toLowerCase() !== norm);
  }
  saveDashHistory();
  renderRecentDashboardSections();
}

function applyDashSectionVisibility() {
  const map = [
    { key: 'quick', btn: $('btn-toggle-sec-quick'), grid: $('quick-cards-grid') },
    { key: 'folders', btn: $('btn-toggle-sec-folders'), grid: $('recent-folders-grid') },
    { key: 'files', btn: $('btn-toggle-sec-files'), grid: $('recent-files-grid') },
  ];
  for (const m of map) {
    const open = state.dashSections[m.key] !== false;
    if (m.grid) m.grid.classList.toggle('hidden', !open);
    if (m.btn) {
      m.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const chev = m.btn.querySelector('.dash-chevron');
      if (chev) chev.textContent = open ? '▾' : '▸';
    }
  }
}

function renderRecentDashboardSections() {
  const fGrid = $('recent-folders-grid');
  const fiGrid = $('recent-files-grid');
  const fCnt = $('cnt-sec-folders');
  const fiCnt = $('cnt-sec-files');
  if (fCnt) fCnt.textContent = String(state.recentFolders.length);
  if (fiCnt) fiCnt.textContent = String(state.recentFiles.length);

  if (fGrid) {
    fGrid.innerHTML = '';
    if (state.recentFolders.length === 0) {
      fGrid.innerHTML = '<div class="recent-empty">Henüz açılan klasör yok. Bir klasör açtığınızda burada listelenir.</div>';
    } else {
      for (const f of state.recentFolders) {
        const card = document.createElement('div');
        card.className = 'recent-card';
        card.dataset.path = f.path;
        card.dataset.rtype = 'folder';
        card.title = f.path;
        card.innerHTML = `
          <span class="recent-card-icon">📁</span>
          <div class="recent-card-body">
            <div class="recent-card-name">${esc(f.name)}</div>
            <div class="recent-card-sub">${esc(f.parent || f.path)}</div>
          </div>
          <div class="recent-card-actions">
            <button type="button" class="recent-mini-btn" data-act="tab" title="Yeni Sekmede Aç">📑</button>
            <button type="button" class="recent-mini-btn" data-act="remove" title="Listeden Kaldır">✕</button>
          </div>
        `;
        card.onclick = (e) => {
          const btn = e.target.closest('.recent-mini-btn');
          if (btn) {
            e.stopPropagation();
            if (btn.dataset.act === 'tab') createTab(f.path, true);
            else if (btn.dataset.act === 'remove') removeRecentEntry('folder', f.path);
            return;
          }
          navigateTo(f.path);
        };
        fGrid.appendChild(card);
      }
    }
  }

  if (fiGrid) {
    fiGrid.innerHTML = '';
    if (state.recentFiles.length === 0) {
      fiGrid.innerHTML = '<div class="recent-empty">Henüz erişilen dosya yok. Bir dosya açtığınızda veya önizlediğinizde burada listelenir.</div>';
    } else {
      for (const f of state.recentFiles) {
        const card = document.createElement('div');
        card.className = 'recent-card';
        card.dataset.path = f.path;
        card.dataset.rtype = 'file';
        card.title = f.path;
        const icon = ICONS[f.category] || ICONS.other;
        const isMedia = f.category === 'image' || f.category === 'video' || f.category === 'audio';
        card.innerHTML = `
          <span class="recent-card-icon">${icon}</span>
          <div class="recent-card-body">
            <div class="recent-card-name">${esc(f.name)}</div>
            <div class="recent-card-sub">${esc(f.dir || f.path)}</div>
          </div>
          <div class="recent-card-actions">
            ${isMedia ? '<button type="button" class="recent-mini-btn" data-act="preview" title="Hızlı Önizle">👁️</button>' : ''}
            <button type="button" class="recent-mini-btn" data-act="reveal" title="Bulunduğu Yeri Aç">📂</button>
            <button type="button" class="recent-mini-btn" data-act="remove" title="Listeden Kaldır">✕</button>
          </div>
        `;
        card.onclick = (e) => {
          const btn = e.target.closest('.recent-mini-btn');
          if (btn) {
            e.stopPropagation();
            if (btn.dataset.act === 'preview') openQuickLook(f, state.recentFiles);
            else if (btn.dataset.act === 'reveal') revealInExplorer(f.path);
            else if (btn.dataset.act === 'remove') removeRecentEntry('file', f.path);
            return;
          }
          if (isMedia) openQuickLook(f, state.recentFiles);
          else openExternally(f.path);
        };
        fiGrid.appendChild(card);
      }
    }
  }
  applyDashSectionVisibility();
}

function saveUiPrefs() {
  try {
    localStorage.setItem('ld_ui_prefs', JSON.stringify({
      viewMode: state.globalViewMode || state.viewMode,
      sortBy: state.sortBy,
      sortDir: state.sortDir,
      recentTargetsOpen: state.recentTargetsOpen !== false,
      dashSections: state.dashSections,
    }));
  } catch {}
}

function saveAppSettings() {
  try {
    localStorage.setItem('ld_app_settings', JSON.stringify(state.settings));
  } catch {}
}

function applyAppSettings() {
  const s = state.settings;
  const root = document.documentElement;
  if (s.accentColor) {
    root.style.setProperty('--accent', s.accentColor);
    root.style.setProperty('--accent-hover', s.accentColor);
    root.style.setProperty('--bg-selected-border', s.accentColor);
    root.style.setProperty('--bg-selected', `${s.accentColor}38`);
  }
  const fsPx = Math.max(12, Math.min(15, Number(s.fontSize) || 13));
  document.body.style.fontSize = `${fsPx}px`;
  const sb = document.querySelector('.sidebar');
  if (sb) sb.classList.toggle('compact-sidebar', Boolean(s.compactSidebar));
  document.querySelectorAll('#set-accent-swatches .color-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.color === s.accentColor);
  });
}

function syncSettingsForm() {
  const s = state.settings;
  const setVal = (id, v, isCheck = false) => {
    const el = $(id);
    if (!el) return;
    if (isCheck) el.checked = Boolean(v);
    else el.value = String(v ?? '');
  };
  setVal('set-font-size', s.fontSize || 13);
  setVal('set-default-view', s.defaultViewMode || 'last');
  setVal('set-remember-folder-view', s.rememberFolderView !== false, true);
  setVal('set-folders-first', s.foldersFirst !== false, true);
  setVal('set-show-ext', s.showExtensions !== false, true);
  setVal('set-compact-sidebar', s.compactSidebar, true);
  setVal('set-startup-mode', s.startupMode || 'pc');
  setVal('set-startup-path', s.startupPath || '');
  const customRow = $('set-startup-custom-row');
  if (customRow) customRow.classList.toggle('hidden', (s.startupMode || 'pc') !== 'custom');
  setVal('set-click-mode', s.clickMode || 'double');
  setVal('set-trash-confirm', s.trashConfirmMode || 'bulk');
  setVal('set-auto-close-proc', s.autoCloseProcessModal, true);
  setVal('set-default-thumb', s.defaultThumbMode || 'off');
  setVal('set-dblclick-quicklook', s.dblClickQuickLook !== false, true);
  setVal('set-frame-save-mode', s.frameSaveMode || 'same');
  setVal('set-frame-save-dir', s.frameSaveDir || '');
  const frameRow = $('set-frame-save-custom-row');
  if (frameRow) frameRow.classList.toggle('hidden', (s.frameSaveMode || 'same') !== 'custom');
  setVal('set-trim-save-mode', s.trimSaveMode || 'same');
  setVal('set-trim-save-dir', s.trimSaveDir || '');
  const trimRow = $('set-trim-save-custom-row');
  if (trimRow) trimRow.classList.toggle('hidden', (s.trimSaveMode || 'same') !== 'custom');
  setVal('set-video-autoplay', s.videoAutoplay !== false, true);
  setVal('set-video-loop', s.videoLoop, true);
  applyAppSettings();
}

function refreshSettingsCacheStats(statsObj = null) {
  const box = $('settings-cache-stats');
  if (!box) return;
  const savedViewsCount = Object.keys(state.folderViews || {}).length;
  const renderStats = (st) => {
    if (!st) return;
    box.innerHTML = `
      <div><strong>SSD Önbellek:</strong> ${esc(st.cacheRoot || 'AppData\\Local\\LightDesktopCache')}</div>
      <div><strong>İndeksli Öğe:</strong> ${(st.totalEntries || 0).toLocaleString('tr-TR')} • <strong>Kayıtlı Kapak:</strong> ${(st.cachedThumbCount || 0).toLocaleString('tr-TR')} (${formatBytes(st.cachedThumbBytes || 0)}) • <strong>Klasör Görünümü:</strong> ${savedViewsCount}</div>
    `;
  };
  if (statsObj) {
    renderStats(statsObj);
    return;
  }
  api('/api/index/status', { silentErrors: true }).then(renderStats).catch(() => {});
}

function renderIntegrationStatus(st) {
  if (!st) return;
  const banner = $('int-status-banner');
  const chkDef = $('set-int-default-explorer');
  const chkAuto = $('set-int-autostart');
  const btnRestore = $('btn-int-restore-explorer');
  const btnFixed = $('btn-int-install-fixed');

  if (chkDef) chkDef.checked = Boolean(st.isDefaultExplorer);
  if (btnRestore) btnRestore.classList.toggle('hidden', !st.isDefaultExplorer);
  if (chkAuto) chkAuto.checked = Boolean(st.autoStartEnabled);
  if (btnFixed) {
    btnFixed.classList.toggle('hidden', !st.isPortable || Boolean(st.isRunningFromFixed) || Boolean(st.hasFixedExe));
  }
  if (banner) {
    const modeText = st.isPortable
      ? (st.isRunningFromFixed ? 'Sabit Konumlu Portable EXE' : 'Taşınabilir EXE')
      : 'Geliştirme / Klasör Modu';
    const trayHintHtml = st.isDefaultExplorer
      ? `<div class="muted-text" style="margin-top:4px;">💡 İpucu: Klasörlerin anında açılması için alttaki <strong>"Windows Açılışında Arka Planda Hazır Bekle (tray)"</strong> seçeneğini açmanız önerilir.</div>`
      : '';
    banner.innerHTML = `
      <div><strong>Çalışma Modu:</strong> ${esc(modeText)} • <strong>Hedef:</strong> <code>${esc(st.targetPath || '')}</code></div>
      <div>
        <strong>Kısayollar:</strong> ${st.hasDesktopShortcut ? '✓ Masaüstü' : '— Masaüstü'} / ${st.hasStartMenuShortcut ? '✓ Başlat (Ctrl+Alt+E)' : '— Başlat'} •
        <strong>Sağ Tık:</strong> ${st.hasContextMenu ? '✓ Aktif' : '— Kapalı'} •
        <strong>Varsayılan Gezgin:</strong> ${st.isDefaultExplorer ? '✓ LightDesktop' : 'Windows Gezgini'}
      </div>
      ${trayHintHtml}
    `;
  }
}

async function refreshIntegrationStatus() {
  try {
    const st = await api('/api/system/integration', { silentErrors: true });
    renderIntegrationStatus(st);
    return st;
  } catch {
    return null;
  }
}

function bindIntegrationAndWelcomeHandlers() {
  const chkDef = $('set-int-default-explorer');
  const btnRestore = $('btn-int-restore-explorer');
  const chkAuto = $('set-int-autostart');
  const btnShortcuts = $('btn-int-shortcuts');
  const btnFixed = $('btn-int-install-fixed');
  const btnWelcome = $('btn-int-open-welcome');

  if (chkDef) {
    chkDef.onchange = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'setDefaultExplorer', enabled: chkDef.checked }),
        });
        renderIntegrationStatus(res.status);
        toast(chkDef.checked ? 'LightDesktop varsayılan klasör gezgini yapıldı!' : 'Windows Gezgini varsayılana döndürüldü.', 'success');
      } catch (err) {
        chkDef.checked = !chkDef.checked;
        toast(err.message, 'error');
      }
    };
  }
  if (btnRestore) {
    btnRestore.onclick = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'setDefaultExplorer', enabled: false }),
        });
        renderIntegrationStatus(res.status);
        toast('Windows Gezgini varsayılana geri döndürüldü.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  if (chkAuto) {
    chkAuto.onchange = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'setAutoStart', enabled: chkAuto.checked }),
        });
        renderIntegrationStatus(res.status);
        toast(chkAuto.checked ? 'Windows açılışında arka planda hazır bekleyecek.' : 'Otomatik başlatma kapatıldı.', 'success');
      } catch (err) {
        chkAuto.checked = !chkAuto.checked;
        toast(err.message, 'error');
      }
    };
  }
  if (btnShortcuts) {
    btnShortcuts.onclick = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'installShortcuts' }),
        });
        renderIntegrationStatus(res.status);
        toast('Masaüstü, Başlat Menüsü (Ctrl+Alt+E) ve Sağ Tık menüsü kuruldu!', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  if (btnFixed) {
    btnFixed.onclick = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'installFixedApp' }),
        });
        renderIntegrationStatus(res.status);
        toast('Uygulama sabit konuma kuruldu (%LOCALAPPDATA%\\LightDesktop)!', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  if (btnWelcome) {
    btnWelcome.onclick = () => {
      const sd = $('settings-dialog');
      if (sd && sd.open) sd.close();
      openWelcomeSetupDialog(true);
    };
  }

  const wDlg = $('welcome-setup-dialog');
  const markDone = () => {
    try { localStorage.setItem('ld_welcome_done', '1'); } catch {}
  };
  if ($('btn-wel-close')) {
    $('btn-wel-close').onclick = () => { markDone(); wDlg.close(); };
  }
  if ($('btn-wel-skip')) {
    $('btn-wel-skip').onclick = () => { markDone(); wDlg.close(); };
  }
  if (wDlg) {
    wDlg.addEventListener('cancel', markDone);
  }
  if ($('btn-wel-apply')) {
    $('btn-wel-apply').onclick = async () => {
      const btn = $('btn-wel-apply');
      btn.disabled = true;
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({
            action: 'applyBundle',
            installFixed: Boolean($('wel-fixed')?.checked && !$('wel-fixed-row')?.classList.contains('hidden')),
            shortcuts: Boolean($('wel-shortcuts')?.checked),
            contextMenu: Boolean($('wel-shortcuts')?.checked),
            defaultExplorer: Boolean($('wel-default-explorer')?.checked),
            autoStart: Boolean($('wel-autostart')?.checked),
          }),
        });
        markDone();
        renderIntegrationStatus(res.status);
        wDlg.close();
        toast('Hızlı kurulum uygulandı! Artık Ctrl+Alt+E veya Başlat Menüsü ile açabilirsiniz.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };
  }
}

async function openWelcomeSetupDialog(forceOpen = false) {
  const dlg = $('welcome-setup-dialog');
  if (!dlg) return;
  try {
    if (!forceOpen && localStorage.getItem('ld_welcome_done') === '1') return;
  } catch {}
  const st = await refreshIntegrationStatus();
  if (st) {
    const fixedRow = $('wel-fixed-row');
    if (fixedRow) {
      fixedRow.classList.toggle('hidden', !st.isPortable || Boolean(st.isRunningFromFixed) || Boolean(st.hasFixedExe));
    }
    if ($('wel-default-explorer')) $('wel-default-explorer').checked = Boolean(st.isDefaultExplorer);
    if ($('wel-autostart')) $('wel-autostart').checked = Boolean(st.autoStartEnabled);
  }
  if (!dlg.open) dlg.showModal();
}

function openSettingsDialog() {
  syncSettingsForm();
  refreshSettingsCacheStats();
  refreshIntegrationStatus();
  const dlg = $('settings-dialog');
  if (dlg && !dlg.open) dlg.showModal();
}

function loadUiPrefs() {
  loadDashHistory();
  loadRecentTransferTargets();
  loadSmartViews();
  loadFolderViews();
  loadColumnWidths();
  try {
    const rawSet = JSON.parse(localStorage.getItem('ld_app_settings') || 'null');
    if (rawSet && typeof rawSet === 'object') {
      state.settings = { ...DEFAULT_APP_SETTINGS, ...rawSet };
    }
  } catch {}
  if (state.settings.defaultThumbMode && $('thumb-mode')?.querySelector(`option[value="${state.settings.defaultThumbMode}"]`)) {
    state.thumbMode = state.settings.defaultThumbMode;
    $('thumb-mode').value = state.thumbMode;
  }
  applyAppSettings();
  try {
    const br = Number(localStorage.getItem('ld_media_brightness'));
    if (Number.isFinite(br) && br >= 30 && br <= 200) state.qlBrightness = Math.round(br);
  } catch {}
  try {
    const raw = localStorage.getItem('ld_ui_prefs');
    if (!raw) {
      applyDashSectionVisibility();
      updateListHeaderIndicators();
      return;
    }
    const p = JSON.parse(raw);
    if (p.viewMode && $('view-mode').querySelector(`option[value="${p.viewMode}"]`)) {
      state.globalViewMode = p.viewMode;
      state.viewMode = p.viewMode;
      $('view-mode').value = p.viewMode;
    }
    if (p.sortBy && $('sort-by').querySelector(`option[value="${p.sortBy}"]`)) {
      state.sortBy = p.sortBy;
      $('sort-by').value = p.sortBy;
    }
    if (p.sortDir === 'asc' || p.sortDir === 'desc') {
      state.sortDir = p.sortDir;
      $('btn-sort-dir').textContent = p.sortDir === 'asc' ? '▲' : '▼';
    }
    if (typeof p.recentTargetsOpen === 'boolean') {
      state.recentTargetsOpen = p.recentTargetsOpen;
    }
    if (p.dashSections && typeof p.dashSections === 'object') {
      state.dashSections = {
        quick: p.dashSections.quick !== false,
        folders: p.dashSections.folders !== false,
        files: p.dashSections.files !== false,
      };
    }
  } catch {}
  applyDashSectionVisibility();
  updateListHeaderIndicators();
}

function shouldOpenInQuickLook(item) {
  if (!item || item.isDir) return false;
  if (state.settings.dblClickQuickLook === false) return false;
  return item.category === 'image' || item.category === 'video';
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
  else if (shouldOpenInQuickLook(item)) openQuickLook(item);
  else openExternally(item.path);
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

// ---------- Sürükle-Bırak (Drag & Drop) Motoru ----------
function setupDragAndDrop() {
  let hoverExpandTimer = null;
  let hoverExpandPath = '';
  let currentDropEl = null;

  const setDropHighlight = (el) => {
    if (currentDropEl && currentDropEl !== el) {
      currentDropEl.classList.remove('drop-target-hover');
    }
    currentDropEl = el;
    if (el) el.classList.add('drop-target-hover');
  };

  const clearHoverExpand = () => {
    clearTimeout(hoverExpandTimer);
    hoverExpandTimer = null;
    hoverExpandPath = '';
  };

  const normDir = (p) => {
    const clean = String(p || '').replace(/\\+$/, '');
    return (/^[a-zA-Z]:$/.test(clean) ? clean + '\\' : clean).toLowerCase();
  };

  const getParentDir = (p) => {
    const clean = String(p || '').replace(/\\+$/, '');
    const idx = clean.lastIndexOf('\\');
    if (idx < 0) return '';
    const parent = clean.slice(0, idx);
    return /^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent;
  };

  const canDropInto = (targetDir, isCopy) => {
    if (!state.draggedPaths.length || !targetDir || targetDir === 'PC' || targetDir === 'TRASH') return false;
    const nt = normDir(targetDir);
    for (const src of state.draggedPaths) {
      const ns = normDir(src);
      if (ns === nt || nt.startsWith(ns.replace(/\\$/, '') + '\\')) return false;
    }
    if (!isCopy) {
      const hasMovable = state.draggedPaths.some((src) => normDir(getParentDir(src)) !== nt);
      if (!hasMovable) return false;
    }
    return true;
  };

  const executeDropPaths = async (paths, targetDir, isCopy) => {
    setDropHighlight(null);
    clearHoverExpand();
    if (!paths || paths.length === 0 || !targetDir) return;
    const nt = normDir(targetDir);
    const filtered = isCopy ? paths.slice() : paths.filter((src) => normDir(getParentDir(src)) !== nt);
    if (filtered.length === 0) return;

    document.querySelectorAll('.sidebar .tree-node[data-loaded="1"]').forEach((node) => {
      const rowPath = node.querySelector(':scope > .tree-row')?.dataset.path;
      if (rowPath && normDir(rowPath) === nt) {
        node.dataset.loaded = '0';
      }
    });
    await enqueueTransfer(isCopy ? 'copy' : 'move', filtered, targetDir);
  };

  const isExternalFilesDrag = (e) => {
    if (state.draggedPaths.length > 0 || !e || !e.dataTransfer) return false;
    const types = e.dataTransfer.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  };

  const canDropExternalInto = (targetDir) => Boolean(targetDir && targetDir !== 'PC' && targetDir !== 'TRASH');

  const handleExternalDrop = async (e, targetDir, targetKind = 'dir') => {
    e.preventDefault();
    setDropHighlight(null);
    clearHoverExpand();
    if (targetKind === 'dir' && !canDropExternalInto(targetDir)) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length === 0) return;

    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessageWithAdditionalObjects === 'function') {
      window.chrome.webview.postMessageWithAdditionalObjects(
        {
          type: 'resolveExternalDrop',
          targetDir: targetDir || '',
          targetKind,
          ctrlKey: Boolean(e.ctrlKey),
          shiftKey: Boolean(e.shiftKey),
        },
        files
      );
      return;
    }

    if (targetKind !== 'dir') {
      toast('Tarayıcı modunda dışarıdan doğrudan sepete bırakma desteklenmiyor.', 'info');
      return;
    }
    toast(`Dışarıdan ${files.length} dosya aktarılıyor...`, 'info');
    let okCount = 0;
    for (const f of files) {
      if (!f || f.size === 0 && !f.type) {
        // Tarayıcı modunda boş klasör yüklemesi kısıtlıdır; normal dosyaları aktar
      }
      try {
        const upRes = await fetch(`/api/fs/upload-external?destDir=${encodeURIComponent(targetDir)}&name=${encodeURIComponent(f.name)}`, {
          method: 'POST',
          body: f,
        });
        if (upRes.ok) okCount++;
      } catch {}
    }
    if (okCount > 0) {
      recordRecentTransferTarget(targetDir);
      toast(`${okCount} dosya hedef klasöre kopyalandı`, 'success');
      const tab = getActiveTab();
      if (tab && tab.path && normDir(tab.path) === normDir(targetDir)) {
        navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
      }
      if (state.dualOpen && state.dualPath && normDir(state.dualPath) === normDir(targetDir)) {
        navigateDual(state.dualPath, false);
      }
    } else {
      toast('Dışarıdan klasör aktarımı için LightDesktop.exe kullanın veya Ctrl+V ile yapıştırın.', 'info');
    }
  };

  const handleDropToDir = async (e, targetDir) => {
    if (isExternalFilesDrag(e)) {
      await handleExternalDrop(e, targetDir, 'dir');
      return;
    }
    e.preventDefault();
    setDropHighlight(null);
    clearHoverExpand();
    const op = resolveDragOp(state.draggedPaths, targetDir, e.ctrlKey, e.shiftKey);
    const isCopy = op === 'copy';
    if (!canDropInto(targetDir, isCopy)) return;
    await executeDropPaths(state.draggedPaths, targetDir, isCopy);
  };

  const isNativeWebView = Boolean(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
  const vp = $('virtual-viewport');
  const dualList = $('dual-list');

  if (isNativeWebView) {
    // WebView2 yerel modunda sürüklemeyi kesintisiz kontrol edip pencere dışına çıkınca gerçek Windows CF_HDROP sürüklemesi başlat
    const suppressNativeDrag = (e) => e.preventDefault();
    vp.addEventListener('dragstart', suppressNativeDrag);
    if (dualList) dualList.addEventListener('dragstart', suppressNativeDrag);

    let ghostEl = null;
    let pState = null;

    const removeGhost = () => {
      if (ghostEl) {
        ghostEl.remove();
        ghostEl = null;
      }
    };

    const cleanupPointerDrag = () => {
      if (pState && pState.captureEl && pState.pointerId !== null) {
        try { pState.captureEl.releasePointerCapture(pState.pointerId); } catch {}
      }
      pState = null;
      removeGhost();
      setDropHighlight(null);
      clearHoverExpand();
    };

    const findInAppDropTarget = (clientX, clientY, ctrlKey, shiftKey) => {
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return null;
      const treeRow = el.closest('.sidebar .tree-row[data-path]');
      if (treeRow) {
        const op = resolveDragOp(state.draggedPaths, treeRow.dataset.path, ctrlKey, shiftKey);
        if (canDropInto(treeRow.dataset.path, op === 'copy')) {
          return { kind: 'dir', dir: treeRow.dataset.path, op, highlightEl: treeRow, treeNode: treeRow.closest('.tree-node') };
        }
      }
      const listRow = el.closest('#virtual-viewport [data-index]');
      if (listRow) {
        const it = state.viewItems[Number(listRow.dataset.index)];
        if (it && it.isDir) {
          const op = resolveDragOp(state.draggedPaths, it.path, ctrlKey, shiftKey);
          if (canDropInto(it.path, op === 'copy')) {
            return { kind: 'dir', dir: it.path, op, highlightEl: listRow };
          }
        }
      }
      const crumb = el.closest('#breadcrumbs .crumb-btn[data-path]');
      if (crumb) {
        const op = resolveDragOp(state.draggedPaths, crumb.dataset.path, ctrlKey, shiftKey);
        if (canDropInto(crumb.dataset.path, op === 'copy')) {
          return { kind: 'dir', dir: crumb.dataset.path, op, highlightEl: crumb };
        }
      }
      const shelfEl = el.closest('#drag-shelf');
      if (shelfEl) {
        return { kind: 'shelf', op: 'copy', highlightEl: shelfEl };
      }
      const basketEl = el.closest('#btn-basket, #basket-drawer');
      if (basketEl) {
        return { kind: 'basket', op: 'copy', highlightEl: basketEl };
      }
      const dList = el.closest('#dual-list');
      if (dList && state.dualPath) {
        const dRow = el.closest('.dual-row[data-isdir="1"]');
        const tDir = dRow ? dRow.dataset.path : state.dualPath;
        const op = resolveDragOp(state.draggedPaths, tDir, ctrlKey, shiftKey);
        if (canDropInto(tDir, op === 'copy')) {
          return { kind: 'dir', dir: tDir, op, highlightEl: dRow || dList };
        }
      }
      if (vp.contains(el) && (state.dragSource === 'dual' || state.dragSource === 'shelf')) {
        const tab = getActiveTab();
        if (tab && tab.path !== 'PC' && tab.path !== 'TRASH') {
          const op = resolveDragOp(state.draggedPaths, tab.path, ctrlKey, shiftKey);
          if (canDropInto(tab.path, op === 'copy')) {
            return { kind: 'dir', dir: tab.path, op, highlightEl: null };
          }
        }
      }
      return null;
    };

    const beginPointerDrag = (e, itemPaths, sourceKind) => {
      if (e.button !== 0 || e.altKey) return;
      pState = {
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        captureEl: e.currentTarget,
        paths: itemPaths,
        sourceKind,
        active: false,
        handedOff: false,
      };
    };

    vp.addEventListener('pointerdown', (e) => {
      state.activePane = 'left';
      if (e.button !== 0 || e.altKey) return;
      if (e.target.closest('button, input, a, .eye-btn, .lh-resizer')) return;
      const rowEl = e.target.closest('[data-index]');
      if (!rowEl || !isDragFileHandle(e.target, rowEl)) return;
      const item = state.viewItems[Number(rowEl.dataset.index)];
      if (!item || item.inTrash) return;
      const paths = state.selectedPaths.has(item.path) ? Array.from(state.selectedPaths) : [item.path];
      beginPointerDrag(e, paths, 'vp');
    });

    if (dualList) {
      dualList.addEventListener('pointerdown', (e) => {
        state.activePane = 'dual';
        if (e.button !== 0 || e.altKey) return;
        const row = e.target.closest('.dual-row[data-path]');
        if (!row || !isDragFileHandle(e.target, row)) return;
        const p = row.dataset.path;
        const paths = state.dualSelectedPaths.has(p) ? Array.from(state.dualSelectedPaths) : [p];
        beginPointerDrag(e, paths, 'dual');
      });
    }

    window.addEventListener('pointermove', (e) => {
      if (!pState || pState.handedOff) return;
      if ((e.buttons & 1) !== 1) {
        if (pState.active) {
          state.draggedPaths = [];
          cleanupPointerDrag();
        } else {
          pState = null;
        }
        return;
      }

      if (!pState.active) {
        if (Math.hypot(e.clientX - pState.startX, e.clientY - pState.startY) < 6) return;
        pState.active = true;
        state.dragSource = pState.sourceKind;
        state.draggedPaths = pState.paths.slice();
        if (pState.sourceKind === 'vp' && state.draggedPaths.length === 1 && !state.selectedPaths.has(state.draggedPaths[0])) {
          state.selectedPaths.clear();
          state.selectedPaths.add(state.draggedPaths[0]);
          updateSelectionDomInPlace();
          updateStatusCounts();
          updateToolbarButtons();
        }
        try { pState.captureEl.setPointerCapture(pState.pointerId); } catch {}
        setShelfAutoReveal(true);
        ghostEl = document.createElement('div');
        ghostEl.className = 'drag-ghost-pill';
        document.body.appendChild(ghostEl);
      }

      const outsideWindow = e.clientX <= 1 || e.clientY <= 1 || e.clientX >= window.innerWidth - 1 || e.clientY >= window.innerHeight - 1;
      if (outsideWindow) {
        pState.handedOff = true;
        const dragPaths = state.draggedPaths.slice();
        cleanupPointerDrag();
        setShelfAutoReveal(false);
        state.suppressNextClick = true;
        setTimeout(() => { state.suppressNextClick = false; }, 120);
        window.chrome.webview.postMessage({ type: 'startNativeFileDrag', paths: dragPaths });
        return;
      }

      const hit = findInAppDropTarget(e.clientX, e.clientY, e.ctrlKey, e.shiftKey);
      if (ghostEl) {
        const isCopyOp = hit ? (hit.op === 'copy') : e.ctrlKey;
        const prefix = hit && hit.kind === 'shelf' ? '🧲 Rafa Park Et: ' : (isCopyOp ? '📋 Kopyala: ' : '📦 Taşı: ');
        const label = state.draggedPaths.length === 1
          ? getFolderTitle(state.draggedPaths[0])
          : `${state.draggedPaths.length} öğe`;
        ghostEl.textContent = prefix + label;
        ghostEl.style.left = `${e.clientX + 14}px`;
        ghostEl.style.top = `${e.clientY + 14}px`;
      }

      setDropHighlight(hit ? hit.highlightEl : null);
      if (hit && hit.treeNode) {
        const twisty = hit.treeNode.querySelector('.tree-twisty');
        const tPath = hit.dir;
        if (twisty && !twisty.classList.contains('expanded') && !twisty.classList.contains('empty')) {
          if (hoverExpandPath !== tPath) {
            clearHoverExpand();
            hoverExpandPath = tPath;
            hoverExpandTimer = setTimeout(() => {
              setTreeNodeExpanded(hit.treeNode, tPath, Number(hit.treeNode.dataset.depth || 0), true);
            }, 550);
          }
        } else if (hoverExpandPath !== tPath) {
          clearHoverExpand();
        }
      } else {
        clearHoverExpand();
      }
    });

    const shelfHandle = $('drag-shelf-drag-handle');
    if (shelfHandle) {
      shelfHandle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || state.shelfItems.size === 0) return;
        beginPointerDrag(e, Array.from(state.shelfItems.keys()), 'shelf');
      });
    }

    window.addEventListener('pointerup', (e) => {
      if (!pState) return;
      if (!pState.active) {
        pState = null;
        return;
      }
      if (pState.handedOff) {
        pState = null;
        return;
      }
      const dragPaths = state.draggedPaths.slice();
      const dragSource = state.dragSource;
      const dragPool = dragSource === 'dual'
        ? state.dualItems
        : (dragSource === 'shelf' ? Array.from(state.shelfItems.values()) : state.viewItems);
      const hit = findInAppDropTarget(e.clientX, e.clientY, e.ctrlKey, e.shiftKey);
      cleanupPointerDrag();
      state.draggedPaths = [];
      state.dragSource = null;
      state.suppressNextClick = true;
      setTimeout(() => { state.suppressNextClick = false; }, 120);

      if (hit && hit.kind === 'shelf') {
        const draggedSet = new Set(dragPaths);
        const matched = dragPool.filter((it) => draggedSet.has(it.path));
        addItemsToShelf(matched.length > 0 ? matched : dragPaths);
      } else if (hit && hit.kind === 'basket') {
        const draggedSet = new Set(dragPaths);
        const matched = dragPool.filter((it) => draggedSet.has(it.path));
        if (matched.length > 0) addItemsToBasket(matched);
      } else if (hit && hit.kind === 'dir') {
        executeDropPaths(dragPaths, hit.dir, hit.op === 'copy');
        if (dragSource === 'shelf' && hit.op !== 'copy') {
          for (const dp of dragPaths) state.shelfItems.delete(dp);
          renderDragShelf();
        }
      }
      setShelfAutoReveal(false);
    });

    window.chrome.webview.addEventListener('message', (ev) => {
      const msg = ev && ev.data;
      if (!msg) return;
      if (msg.type === 'externalDropResolved') {
        const paths = Array.isArray(msg.paths) ? msg.paths.filter(Boolean) : [];
        if (paths.length === 0) return;
        if (msg.targetKind === 'basket') {
          let added = 0;
          for (const p of paths) {
            if (!state.basket.has(p)) {
              state.basket.set(p, { path: p, name: getFolderTitle(p), isDir: false });
              added++;
            }
          }
          renderBasket();
          toast(added > 0 ? `${added} öğe sepete eklendi` : 'Öğeler zaten sepette');
        } else if (canDropExternalInto(msg.targetDir)) {
          const op = resolveDragOp(paths, msg.targetDir, Boolean(msg.ctrlKey), Boolean(msg.shiftKey));
          executeDropPaths(paths, msg.targetDir, op === 'copy');
        }
        return;
      }
      if (msg.type !== 'nativeDragDone') return;
      state.draggedPaths = [];
      state.dragSource = null;
      if (msg.effect === 'Move' && Array.isArray(msg.paths)) {
        let dirtyBasket = false;
        for (const p of msg.paths) {
          if (state.basket.delete(p)) dirtyBasket = true;
        }
        if (dirtyBasket) renderBasket();
        const tab = getActiveTab();
        if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
          navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
        }
      }
    });
  } else {
    vp.addEventListener('dragstart', (e) => {
      const rowEl = e.target.closest('[data-index]');
      if (!rowEl) return;
      const item = state.viewItems[Number(rowEl.dataset.index)];
      if (!item) return;

      if (!state.selectedPaths.has(item.path)) {
        state.selectedPaths.clear();
        state.selectedPaths.add(item.path);
        state.lastClickedIndex = Number(rowEl.dataset.index);
        updateSelectionDomInPlace();
        updateStatusCounts();
        updateToolbarButtons();
      }

      state.draggedPaths = Array.from(state.selectedPaths);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', state.draggedPaths.join('\n'));
        if (state.draggedPaths.length === 1 && !item.isDir) {
          const dlUrl = `${window.location.origin}/api/media?path=${encodeURIComponent(item.path)}`;
          try { e.dataTransfer.setData('DownloadURL', `application/octet-stream:${item.name}:${dlUrl}`); } catch {}
        }
      }
    });
  }

  document.addEventListener('dragover', (e) => {
    if (isExternalFilesDrag(e)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (isExternalFilesDrag(e) && !e.defaultPrevented) e.preventDefault();
  });

  document.addEventListener('dragend', () => {
    state.draggedPaths = [];
    setDropHighlight(null);
    clearHoverExpand();
  });

  // 1) Sol Menü Ağacı (Diskler, Hızlı Erişim, Sabitlenenler ve tüm alt klasörler)
  const sidebar = document.querySelector('.sidebar');
  sidebar.addEventListener('dragover', (e) => {
    const row = e.target.closest('.tree-row[data-path]');
    const extDrag = isExternalFilesDrag(e);
    const op = row ? (extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, row.dataset.path, e.ctrlKey, e.shiftKey)) : 'move';
    const valid = row && (extDrag ? canDropExternalInto(row.dataset.path) : canDropInto(row.dataset.path, op === 'copy'));
    if (!valid) {
      if (currentDropEl && sidebar.contains(currentDropEl)) setDropHighlight(null);
      clearHoverExpand();
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(row);

    const node = row.closest('.tree-node');
    const twisty = row.querySelector('.tree-twisty');
    const path = row.dataset.path;
    if (node && twisty && !twisty.classList.contains('expanded') && !twisty.classList.contains('empty')) {
      if (hoverExpandPath !== path) {
        clearHoverExpand();
        hoverExpandPath = path;
        hoverExpandTimer = setTimeout(() => {
          setTreeNodeExpanded(node, path, Number(node.dataset.depth || 0), true);
        }, 550);
      }
    } else if (hoverExpandPath !== path) {
      clearHoverExpand();
    }
  });
  sidebar.addEventListener('dragleave', (e) => {
    if (!sidebar.contains(e.relatedTarget)) {
      setDropHighlight(null);
      clearHoverExpand();
    }
  });
  sidebar.addEventListener('drop', (e) => {
    const row = e.target.closest('.tree-row[data-path]');
    if (row) handleDropToDir(e, row.dataset.path);
  });

  // 2) Orta Listedeki Klasörler
  vp.addEventListener('dragover', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    const extDrag = isExternalFilesDrag(e);
    const op = item && item.isDir ? (extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, item.path, e.ctrlKey, e.shiftKey)) : 'move';
    const valid = item && item.isDir && (extDrag ? canDropExternalInto(item.path) : canDropInto(item.path, op === 'copy'));
    if (!valid) {
      if (currentDropEl && vp.contains(currentDropEl)) setDropHighlight(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(rowEl);
  });
  vp.addEventListener('dragleave', (e) => {
    if (!vp.contains(e.relatedTarget)) setDropHighlight(null);
  });
  vp.addEventListener('drop', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    if (item && item.isDir) handleDropToDir(e, item.path);
  });

  // 3) Üst Yol Çubuğu (Breadcrumbs)
  const bc = $('breadcrumbs');
  bc.addEventListener('dragover', (e) => {
    const btn = e.target.closest('.crumb-btn[data-path]');
    const extDrag = isExternalFilesDrag(e);
    const op = btn ? (extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, btn.dataset.path, e.ctrlKey, e.shiftKey)) : 'move';
    const valid = btn && (extDrag ? canDropExternalInto(btn.dataset.path) : canDropInto(btn.dataset.path, op === 'copy'));
    if (!valid) {
      if (currentDropEl && bc.contains(currentDropEl)) setDropHighlight(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(btn);
  });
  bc.addEventListener('dragleave', (e) => {
    if (!bc.contains(e.relatedTarget)) setDropHighlight(null);
  });
  bc.addEventListener('drop', (e) => {
    const btn = e.target.closest('.crumb-btn[data-path]');
    if (btn) handleDropToDir(e, btn.dataset.path);
  });

  // 4) Sepet Butonu & Sepet Çekmecesi
  for (const targetEl of [$('btn-basket'), $('basket-drawer')]) {
    targetEl.addEventListener('dragover', (e) => {
      if (!state.draggedPaths.length && !isExternalFilesDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDropHighlight(targetEl);
    });
    targetEl.addEventListener('dragleave', (e) => {
      if (!targetEl.contains(e.relatedTarget)) setDropHighlight(null);
    });
    targetEl.addEventListener('drop', (e) => {
      if (isExternalFilesDrag(e)) {
        handleExternalDrop(e, '', 'basket');
        return;
      }
      e.preventDefault();
      setDropHighlight(null);
      if (!state.draggedPaths.length) return;
      const draggedSet = new Set(state.draggedPaths);
      const matched = state.viewItems.filter((it) => draggedSet.has(it.path));
      if (matched.length > 0) addItemsToBasket(matched);
    });
  }

  // 5) Çift Panel (Dual Pane) Sürükle-Bırak
  if (dualList && !isNativeWebView) {
    dualList.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.dual-row');
      if (!row) return;
      const p = row.dataset.path;
      state.draggedPaths = state.dualSelectedPaths.has(p) ? Array.from(state.dualSelectedPaths) : [p];
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', state.draggedPaths[0] || p);
      }
    });
  }
  dualList.addEventListener('dragover', (e) => {
    const extDrag = isExternalFilesDrag(e);
    if ((!state.draggedPaths.length && !extDrag) || !state.dualPath) return;
    const row = e.target.closest('.dual-row[data-isdir="1"]');
    const targetDir = row ? row.dataset.path : state.dualPath;
    const op = extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, targetDir, e.ctrlKey, e.shiftKey);
    const valid = extDrag ? canDropExternalInto(targetDir) : canDropInto(targetDir, op === 'copy');
    if (!valid) {
      if (currentDropEl && dualList.contains(currentDropEl)) setDropHighlight(null);
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
    setDropHighlight(row || dualList);
  });
  dualList.addEventListener('dragleave', (e) => {
    if (!dualList.contains(e.relatedTarget)) setDropHighlight(null);
  });
  dualList.addEventListener('drop', (e) => {
    const row = e.target.closest('.dual-row[data-isdir="1"]');
    const targetDir = row ? row.dataset.path : state.dualPath;
    if (targetDir) handleDropToDir(e, targetDir);
  });

  // Soldaki boş alana (sağ panelden veya dış uygulamadan / masaüstünden) sürükleyip bırakma
  vp.addEventListener('dragover', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    if (item && item.isDir) return;
    const tab = getActiveTab();
    if (!tab || tab.path === 'PC' || tab.path === 'TRASH') return;
    const extDrag = isExternalFilesDrag(e);
    const op = extDrag ? (e.shiftKey ? 'move' : 'copy') : resolveDragOp(state.draggedPaths, tab.path, e.ctrlKey, e.shiftKey);
    const valid = extDrag ? canDropExternalInto(tab.path) : canDropInto(tab.path, op === 'copy');
    if (!valid) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = op;
  });
  vp.addEventListener('drop', (e) => {
    const rowEl = e.target.closest('[data-index]');
    const item = rowEl ? state.viewItems[Number(rowEl.dataset.index)] : null;
    if (item && item.isDir) return;
    const tab = getActiveTab();
    if (tab && tab.path !== 'PC' && tab.path !== 'TRASH') handleDropToDir(e, tab.path);
  });
}

// ---------- Başlangıç ----------
async function hydrateInitData(openInitialTab = false) {
  const urlOpenPath = new URLSearchParams(window.location.search).get('openPath');
  try {
    const data = await api('/api/init', { timeoutMs: 8000, silentErrors: openInitialTab });
    state.drives = data.drives || [];
    state.quickAccess = data.quickAccess || [];
    state.pins = data.pins || [];
    if (data.undoSummary) updateUndoButton(data.undoSummary);
    if (typeof data.trashCount === 'number') updateTrashBadge(data.trashCount);
    $('cache-badge').title = `SSD Önbellek: ${data.indexStats?.cacheRoot || ''}`;
    renderSidebarAndDashboard();
    renderBasket();
    if (openInitialTab) {
      let startTarget = urlOpenPath || '';
      if (!startTarget) {
        if (state.settings.startupMode === 'last') {
          try { startTarget = localStorage.getItem('ld_last_folder') || 'PC'; } catch { startTarget = 'PC'; }
        } else if (state.settings.startupMode === 'custom' && state.settings.startupPath) {
          startTarget = state.settings.startupPath;
        } else {
          startTarget = 'PC';
        }
      }
      createTab(startTarget || 'PC', true);
    }
    return true;
  } catch (err) {
    if (openInitialTab) {
      renderSidebarAndDashboard();
      renderBasket();
      createTab(urlOpenPath || 'PC', true);
      toast(`Başlatma uyarısı: ${err.message} (yeniden bağlanılıyor)`, 'error');
    }
    return false;
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

let cmdPaletteActiveIdx = 0;
let cmdPaletteEntries = [];

function buildCommandPaletteEntries(rawQuery) {
  const q = String(rawQuery || '').trim();
  const qLow = q.toLocaleLowerCase('tr-TR');
  const results = [];

  // 1) Hızlı Tek-Satır Akıllı Filtre Yorumlayıcı
  if (q && (q.includes('>') || q.includes('<') || q.startsWith('.') || /\b(mb|gb|video|foto|görsel|bugün|kopya)\b/i.test(q))) {
    results.push({
      icon: '🎯',
      title: `Klasörde Hızlı Filtre Uygula: "${q}"`,
      sub: 'Gelişmiş Filtre Stüdyosu kriterlerini doldur ve uygula',
      badge: 'Hızlı Filtre',
      run: () => applyQuickStudioQuery(q),
    });
  }

  const actions = [
    { icon: '📅', title: 'Tarihe Göre Klasörle', sub: 'Dosyaları Yıl/Ay alt klasörlerine kopyala veya taşı', badge: 'Eylem', run: organizeCurrentFolderByDate },
    { icon: '📊', title: 'Disk ve Klasör Analizi Aç', sub: 'Kategori dökümü ve en büyük dosyalar', badge: 'Eylem', run: () => openAnalyzer() },
    { icon: '🧬', title: 'Kopya Dosyaları Bul', sub: 'Birebir aynı dosyaları bul ve temizle', badge: 'Eylem', run: () => findAndRenderDuplicates(false) },
    { icon: '📏', title: 'Klasör Boyutlarını Hesapla', sub: 'Açık klasördeki alt klasör boyutlarını sırala', badge: 'Eylem', run: () => calculateCurrentFolderSizes(false) },
    { icon: '◫', title: 'Çift Panel Aç / Kapat (F3)', sub: 'Yan yana dosya yönetimi', badge: 'Eylem', run: toggleDualPane },
    { icon: '🧲', title: 'Geçici Yüzen Rafı Aç / Kapat (Ctrl+Shift+S)', sub: 'Dosyaları park edip başka klasöre taşı', badge: 'Eylem', run: () => toggleDragShelfVisible() },
    { icon: '🎯', title: 'Gelişmiş Filtre & Aralık Stüdyosu', sub: 'Numara, tarih, boyut ve RegExp filtresi', badge: 'Eylem', run: () => $('btn-range-studio')?.click() },
    { icon: '⚙️', title: 'Ayarlar Merkezi (Ctrl+,)', sub: 'Görünüm, medya ve Windows entegrasyonu', badge: 'Eylem', run: openSettingsDialog },
    { icon: '🧹', title: 'Sepeti Temizle', sub: 'Toplama sepetindeki tüm öğeleri çıkar', badge: 'Eylem', run: () => { state.basket.clear(); renderBasket(); toast('Sepet temizlendi'); } },
  ];

  for (const act of actions) {
    if (!qLow || act.title.toLocaleLowerCase('tr-TR').includes(qLow) || act.sub.toLocaleLowerCase('tr-TR').includes(qLow)) {
      results.push(act);
    }
  }

  for (const sv of state.smartViews || []) {
    if (!qLow || sv.name.toLocaleLowerCase('tr-TR').includes(qLow)) {
      results.push({
        icon: sv.icon || '✨',
        title: `Akıllı Klasör: ${sv.name}`,
        sub: 'İndeksten anlık sanal görünüm',
        badge: 'Sanal',
        run: () => openSmartView(sv),
      });
    }
  }

  const seenPaths = new Set();
  const addNav = (icon, name, p, badge) => {
    if (!p || seenPaths.has(p.toLowerCase())) return;
    seenPaths.add(p.toLowerCase());
    if (!qLow || name.toLocaleLowerCase('tr-TR').includes(qLow) || p.toLocaleLowerCase('tr-TR').includes(qLow)) {
      results.push({ icon, title: name, sub: p, badge, run: () => navigateTo(p) });
    }
  };
  for (const d of state.drives || []) addNav('💽', d.label || d.path, d.path, 'Disk');
  for (const qItem of state.quickAccess || []) addNav(QUICK_ICONS[qItem.icon] || '📁', qItem.name, qItem.path, 'Hızlı');
  for (const pItem of state.pins || []) addNav('📌', pItem.name || getFolderTitle(pItem.path), pItem.path, 'Sabit');
  for (const rt of state.recentTransferTargets || []) addNav('🕒', rt.name || getFolderTitle(rt.path), rt.path, 'Son Yol');

  return results.slice(0, 24);
}

function applyQuickStudioQuery(q) {
  const studio = $('range-studio');
  if (studio && studio.classList.contains('hidden')) {
    studio.classList.remove('hidden');
    $('btn-range-studio')?.classList.add('active');
  }
  ['flt-pattern', 'flt-num-min', 'flt-num-max', 'flt-date-min', 'flt-date-max', 'flt-size-min', 'flt-size-max', 'flt-ext'].forEach((id) => {
    if ($(id)) $(id).value = '';
  });
  $('flt-regex').checked = false;
  $('flt-category').value = 'all';

  let rest = String(q || '');
  const szMatch = /([<>])\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb)?/i.exec(rest);
  if (szMatch) {
    const mult = szMatch[3]?.toLowerCase() === 'gb' ? 1073741824 : (szMatch[3]?.toLowerCase() === 'kb' ? 1024 : 1048576);
    if (szMatch[1] === '>') {
      $('flt-size-min').value = szMatch[2];
      $('flt-size-min-unit').value = String(mult);
    } else {
      $('flt-size-max').value = szMatch[2];
      $('flt-size-max-unit').value = String(mult);
    }
    rest = rest.replace(szMatch[0], '');
  }
  if (/\bvideo\w*\b/i.test(rest)) { $('flt-category').value = 'video'; rest = rest.replace(/\bvideo\w*\b/gi, ''); }
  else if (/\b(foto\w*|resim\w*|görsel\w*|img)\b/i.test(rest)) { $('flt-category').value = 'image'; rest = rest.replace(/\b(foto\w*|resim\w*|görsel\w*|img)\b/gi, ''); }
  else if (/\bbugün\b/i.test(rest)) {
    const today = new Date().toISOString().slice(0, 10);
    $('flt-date-min').value = today;
    $('flt-date-max').value = today;
    rest = rest.replace(/\bbugün\b/gi, '');
  }
  else if (/\bkopya\b/i.test(rest)) {
    $('flt-pattern').value = '\\(\\d+\\)\\.[^.]+$';
    $('flt-regex').checked = true;
    rest = rest.replace(/\bkopya\b/gi, '');
  }
  const extMatch = /(^|\s)(\.[a-z0-9]{2,6})\b/i.exec(rest);
  if (extMatch) {
    $('flt-ext').value = extMatch[2];
    rest = rest.replace(extMatch[0], '');
  }
  const leftover = rest.trim();
  if (leftover && !$('flt-pattern').value) $('flt-pattern').value = `*${leftover}*`;

  state.filterOnlyMatched = true;
  $('btn-flt-clear-view')?.classList.remove('hidden');
  updateStudioMatchPreview();
  applySortAndFilter();
}

function renderCommandPaletteList(query) {
  const listEl = $('cmd-palette-list');
  if (!listEl) return;
  cmdPaletteEntries = buildCommandPaletteEntries(query);
  if (cmdPaletteActiveIdx >= cmdPaletteEntries.length) cmdPaletteActiveIdx = 0;
  listEl.innerHTML = '';
  if (cmdPaletteEntries.length === 0) {
    listEl.innerHTML = '<div class="muted-text" style="padding:14px;text-align:center;">Eşleşen komut veya yol bulunamadı</div>';
    return;
  }
  cmdPaletteEntries.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `cmd-palette-item${idx === cmdPaletteActiveIdx ? ' active' : ''}`;
    row.innerHTML = `
      <div class="cmd-palette-item-left">
        <span>${esc(item.icon)}</span>
        <span class="cmd-palette-item-title">${esc(item.title)}</span>
        <span class="cmd-palette-item-sub">${esc(item.sub)}</span>
      </div>
      <span class="cmd-palette-badge">${esc(item.badge)}</span>
    `;
    row.onclick = () => {
      $('command-palette-dialog')?.close();
      item.run();
    };
    listEl.appendChild(row);
  });
}

function openCommandPalette() {
  const dlg = $('command-palette-dialog');
  const inp = $('cmd-palette-input');
  if (!dlg || !inp) return;
  cmdPaletteActiveIdx = 0;
  inp.value = '';
  renderCommandPaletteList('');
  if (!dlg.open) dlg.showModal();
  inp.focus();
}

function bindCommandPaletteHandlers() {
  const btn = $('btn-cmd-palette');
  const inp = $('cmd-palette-input');
  const dlg = $('command-palette-dialog');
  if (btn) btn.onclick = openCommandPalette;
  if (inp) {
    inp.oninput = () => {
      cmdPaletteActiveIdx = 0;
      renderCommandPaletteList(inp.value);
    };
    inp.onkeydown = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (cmdPaletteEntries.length > 0) {
          cmdPaletteActiveIdx = (cmdPaletteActiveIdx + 1) % cmdPaletteEntries.length;
          renderCommandPaletteList(inp.value);
          $('cmd-palette-list')?.children[cmdPaletteActiveIdx]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (cmdPaletteEntries.length > 0) {
          cmdPaletteActiveIdx = (cmdPaletteActiveIdx - 1 + cmdPaletteEntries.length) % cmdPaletteEntries.length;
          renderCommandPaletteList(inp.value);
          $('cmd-palette-list')?.children[cmdPaletteActiveIdx]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const picked = cmdPaletteEntries[cmdPaletteActiveIdx];
        if (picked) {
          dlg?.close();
          picked.run();
        }
      }
    };
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

async function init() {
  try { loadUiPrefs(); } catch {}
  try { bindEvents(); } catch {}
  try { bindCommandPaletteHandlers(); } catch {}
  try { bindDragShelfHandlers(); } catch {}
  try { setupMarqueeSelection(); } catch {}
  try { setupDragAndDrop(); } catch {}
  try { setupHoverVideoStoryboard(); } catch {}
  try { setupViewportResizeObserver(); } catch {}
  await restoreWindowBounds();
  try { setupWindowBoundsPersistence(); } catch {}

  const ok = await hydrateInitData(true);
  pollIndexStatus();
  pollTransferStatus();

  if (ok) {
    setTimeout(() => { openWelcomeSetupDialog(false); }, 450);
  }

  if (!ok) {
    const retryTimer = setInterval(async () => {
      const recovered = await hydrateInitData(false);
      if (recovered) {
        clearInterval(retryTimer);
        const tab = getActiveTab();
        if (tab && tab.path !== 'PC') navigateTo(tab.path, { pushHistory: false });
      }
    }, 2000);
  }
}

init();
