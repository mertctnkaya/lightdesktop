import { $ } from '../utils/dom.js';
import { naturalCollator, state } from '../store/appState.js';
import { applySortAndFilter } from '../components/scroller/columnHeadersAndStudio.js';

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


export {
  clearColFilters,
  getDateBucketKey,
  getFilterCriteria,
  getNameBucketKey,
  getSizeBucketKey,
  getTypeBucketKey,
  hasActiveColFilters,
  itemMatchesColFilters,
  itemMatchesCriteria,
  sortItemsArray,
  updateListHeaderIndicators,
};
