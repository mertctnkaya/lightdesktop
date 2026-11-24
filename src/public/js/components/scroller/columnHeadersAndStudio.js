import { state } from '../../store/appState.js';
import { $, esc } from '../../utils/dom.js';
import { toast } from '../shared/toast.js';
import { clearColFilters, getDateBucketKey, getFilterCriteria, getNameBucketKey, getSizeBucketKey, getTypeBucketKey, hasActiveColFilters, itemMatchesColFilters, itemMatchesCriteria, sortItemsArray, updateListHeaderIndicators } from '../../core/filterAndSortEngine.js';
import { saveUiPrefs } from '../../services/preferencesService.js';
import { renderVirtualList } from './virtualScroller.js';
import { updateStatusCounts } from './selectionAndMarquee.js';
import { formatBytes } from '../../utils/formatters.js';

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


export {
  applySortAndFilter,
  applyViewModeForFolder,
  closeColFilterPopover,
  getMatchedStudioItems,
  loadColumnWidths,
  loadFolderViews,
  normalizeFolderKey,
  openColFilterPopover,
  resetColumnWidths,
  saveFolderViews,
  setupListColumnResizers,
  updateStudioMatchPreview,
};
