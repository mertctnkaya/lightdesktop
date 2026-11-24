import { state } from '../../store/appState.js';
import { $, esc } from '../../utils/dom.js';
import { api } from '../../services/apiClient.js';
import { createTab, getActiveTab, getFolderTitle, navigateTo } from '../navigation/tabsAndRouter.js';
import { renderSmartViewsSidebar } from './smartViews.js';
import { ICONS, QUICK_ICONS } from '../../constants/uiConstants.js';
import { openAnalyzer, startBackgroundIndex, togglePin } from '../analyzer/analyzerAndDuplicates.js';
import { formatBytes } from '../../utils/formatters.js';
import { removeRecentEntry } from '../../services/preferencesService.js';
import { openQuickLook } from '../quicklook/quicklookViewer.js';
import { openExternally } from '../operations/fileActions.js';

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


export {
  applyDashSectionVisibility,
  loadRecentTransferTargets,
  recordRecentTransferTarget,
  renderRecentDashboardSections,
  renderRecentTransferTargets,
  renderSidebarAndDashboard,
  setTreeNodeExpanded,
  updateSidebarActive,
};
