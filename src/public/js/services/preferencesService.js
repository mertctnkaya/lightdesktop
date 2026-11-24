import { $ } from '../utils/dom.js';
import { api } from './apiClient.js';
import { DEFAULT_APP_SETTINGS, state } from '../store/appState.js';
import { getFolderTitle } from '../components/navigation/tabsAndRouter.js';
import { applyDashSectionVisibility, loadRecentTransferTargets, renderRecentDashboardSections } from '../components/sidebar/treeAndDashboard.js';
import { loadSmartViews } from '../components/sidebar/smartViews.js';
import { loadColumnWidths, loadFolderViews } from '../components/scroller/columnHeadersAndStudio.js';
import { updateListHeaderIndicators } from '../core/filterAndSortEngine.js';

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


export {
  applyAppSettings,
  loadUiPrefs,
  recordRecentFile,
  recordRecentFolder,
  removeRecentEntry,
  restoreWindowBounds,
  saveAppSettings,
  saveDashHistory,
  saveUiPrefs,
  setupWindowBoundsPersistence,
};
