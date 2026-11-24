import { state } from '../../store/appState.js';
import { $, esc } from '../../utils/dom.js';
import { formatBytes } from '../../utils/formatters.js';
import { buildCacheBannerHtml } from '../shared/cacheBanner.js';
import { getActiveTab, renderTabs } from '../navigation/tabsAndRouter.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { openQuickLook } from '../quicklook/quicklookViewer.js';
import { deleteSelected } from '../operations/fileActions.js';
import { pollTransferStatus, procModalState } from '../operations/processAndErrorCenter.js';
import { restoreTabAnalyzerView } from './analyzerAndDuplicates.js';

// ---------- Kopya Dosya Bulucu: Seçim, Satır Aksiyonları & Canlı Ayıklama ----------
const dupSelectedPaths = new Set();
let dupFlatPaths = [];
let dupLastSelectedIdx = -1;

function getProtectDevPref() {
  try {
    return localStorage.getItem('ld_dup_protect_dev') !== '0';
  } catch {
    return true;
  }
}

function setProtectDevPref(val) {
  try {
    localStorage.setItem('ld_dup_protect_dev', val ? '1' : '0');
  } catch {}
}

function syncDupSelectionUI() {
  const count = dupSelectedPaths.size;
  const rows = document.querySelectorAll('#dupe-groups-list .dupe-file-row');
  for (const r of rows) {
    r.classList.toggle('selected', dupSelectedPaths.has(r.dataset.path));
  }
  const delSelBtn = $('btn-delete-selected-dupes');
  const clearSelBtn = $('btn-clear-dup-sel');
  if (delSelBtn) {
    delSelBtn.classList.toggle('hidden', count === 0);
    delSelBtn.textContent = `🗑️ Seçilenleri Çöpe At (${count})`;
  }
  if (clearSelBtn) {
    clearSelBtn.classList.toggle('hidden', count === 0);
  }
}

function getDupSelectedPaths() {
  return Array.from(dupSelectedPaths);
}

function clearDupSelection() {
  dupSelectedPaths.clear();
  dupLastSelectedIdx = -1;
  syncDupSelectionUI();
}

function selectDupPathForContextMenu(filePath) {
  if (!filePath) return [];
  if (!dupSelectedPaths.has(filePath)) {
    dupSelectedPaths.clear();
    dupSelectedPaths.add(filePath);
    const idx = dupFlatPaths.indexOf(filePath);
    if (idx >= 0) dupLastSelectedIdx = idx;
    syncDupSelectionUI();
  }
  return Array.from(dupSelectedPaths);
}

function openQuickLookForSelectedDup() {
  const firstPath = dupSelectedPaths.values().next().value;
  if (!firstPath) return;
  const tab = getActiveTab();
  const groups = tab && tab.dupesData && tab.dupesData.groups;
  if (!Array.isArray(groups)) return;
  for (const g of groups) {
    const found = (g.files || []).find((x) => x.path === firstPath);
    if (found) {
      openQuickLook({ ...found, size: g.size, isDir: false });
      return;
    }
  }
}

function pruneDeletedPathsFromDuplicates(deletedPaths) {
  if (!Array.isArray(deletedPaths) || deletedPaths.length === 0) return;
  const delSet = new Set(deletedPaths.map((p) => String(p).toLowerCase()));

  let selectionChanged = false;
  for (const p of Array.from(dupSelectedPaths)) {
    if (delSet.has(String(p).toLowerCase())) {
      dupSelectedPaths.delete(p);
      selectionChanged = true;
    }
  }
  if (selectionChanged && dupSelectedPaths.size === 0) dupLastSelectedIdx = -1;

  for (const tab of state.tabs) {
    if (tab.dupesData && Array.isArray(tab.dupesData.groups)) {
      const nextGroups = [];
      let totalDuplicateFiles = 0;
      let totalWastedBytes = 0;
      let touched = false;

      for (const g of tab.dupesData.groups) {
        const remaining = (g.files || []).filter((f) => !delSet.has(String(f.path).toLowerCase()));
        if (remaining.length !== (g.files || []).length) touched = true;
        if (remaining.length >= 2) {
          const wasted = (g.size || 0) * (remaining.length - 1);
          nextGroups.push({ ...g, files: remaining, wastedBytes: wasted });
          totalDuplicateFiles += remaining.length - 1;
          totalWastedBytes += wasted;
        }
      }

      if (touched) {
        tab.dupesData.groups = nextGroups;
        tab.dupesData.totalGroups = nextGroups.length;
        tab.dupesData.totalDuplicateFiles = totalDuplicateFiles;
        tab.dupesData.totalWastedBytes = totalWastedBytes;
        if (tab.id === state.activeTabId && tab.viewType === 'analyzer') {
          renderDuplicatesResult(tab.dupesData);
        }
      }
    }

    if (tab.analyzerData && Array.isArray(tab.analyzerData.topFiles)) {
      const prevLen = tab.analyzerData.topFiles.length;
      tab.analyzerData.topFiles = tab.analyzerData.topFiles.filter(
        (f) => !delSet.has(String(f.path).toLowerCase())
      );
      if (tab.analyzerData.topFiles.length !== prevLen && tab.id === state.activeTabId && tab.viewType === 'analyzer') {
        const rows = document.querySelectorAll('#top-files-list .analyzer-row');
        for (const r of rows) {
          if (r.title && delSet.has(r.title.toLowerCase())) r.remove();
        }
      }
    }
  }
}

window.addEventListener('ld:paths-deleted', (ev) => {
  const paths = ev && ev.detail && ev.detail.paths;
  if (Array.isArray(paths) && paths.length > 0) {
    pruneDeletedPathsFromDuplicates(paths);
  }
});

function renderDuplicatesResult(data) {
  const panel = $('dupes-panel');
  const prevListEl = $('dupe-groups-list');
  const prevScrollTop = prevListEl ? prevListEl.scrollTop : 0;

  panel.classList.remove('hidden');
  const protectedNote = data.skippedProtectedCount > 0
    ? `<div class="muted-text" style="font-size:11.5px;margin-bottom:6px;">🛡️ Güvenlik koruması: Sistem, program ve uygulama klasörlerinden (Windows, Program Files, AppData, ProgramData, .dll/.exe/.dat) ${data.skippedProtectedCount.toLocaleString('tr-TR')} dosya hariç tutuldu.</div>`
    : '';
  const devNote = data.skippedDevProjectCount > 0
    ? `<div class="muted-text dup-dev-note">💻 Yazılım projesi koruması: <code>.git</code>, <code>package.json</code>, Capacitor/Android ve <code>dist/build</code> klasörlerindeki <strong>${data.skippedDevProjectCount.toLocaleString('tr-TR')}</strong> proje dosyası (logo, asset, çıktı vb.) bozulmaması için hariç tutuldu.</div>`
    : '';
  const devChecked = (typeof data.protectDevProjects === 'boolean' ? data.protectDevProjects : getProtectDevPref()) ? 'checked' : '';
  const devToggleHtml = `<label class="dup-dev-toggle" title="package.json, .git, Capacitor/Android ve dist/build klasörlerindeki proje kopyalarını korur"><input type="checkbox" id="chk-dup-protect-dev" ${devChecked} /> 💻 Yazılım projelerini koru</label>`;
  const dupesBannerHtml = buildCacheBannerHtml(data, 'btn-cache-rescan-dupes', '🔄 Kopyaları Yeniden Tara');
  const dupesBannerWrap = dupesBannerHtml
    ? `<div class="cache-status-banner${data.stale ? ' stale' : ''}">${dupesBannerHtml}</div>`
    : '';

  const bindCommonControls = () => {
    const rBtn = $('btn-cache-rescan-dupes');
    if (rBtn) rBtn.onclick = () => findAndRenderDuplicates(true);
    const devChk = $('chk-dup-protect-dev');
    if (devChk) {
      devChk.onchange = () => {
        setProtectDevPref(devChk.checked);
        findAndRenderDuplicates(false);
      };
    }
  };

  if (!data.groups || data.groups.length === 0) {
    dupFlatPaths = [];
    clearDupSelection();
    panel.innerHTML = `${dupesBannerWrap}<div class="dupes-summary"><h3>🧬 Kopya Dosya Bulucu</h3>${devToggleHtml}</div>${protectedNote}${devNote}<div class="muted-text">Bu konumda birebir kopya dosya bulunamadı.</div>`;
    bindCommonControls();
    return;
  }

  const redundantPaths = [];
  const validPathSet = new Set();
  for (const g of data.groups) {
    g.files.forEach((f, idx) => {
      validPathSet.add(f.path);
      if (idx > 0) redundantPaths.push(f.path);
    });
  }
  for (const p of Array.from(dupSelectedPaths)) {
    if (!validPathSet.has(p)) dupSelectedPaths.delete(p);
  }

  panel.innerHTML = `
    ${dupesBannerWrap}
    ${protectedNote}
    ${devNote}
    <div class="dupes-summary">
      <div>
        <strong>🧬 ${data.totalGroups} kopya grubu</strong> •
        ${data.totalDuplicateFiles} gereksiz kopya •
        <span style="color:#ff9c94;font-weight:700;">${formatBytes(data.totalWastedBytes)} kazanılabilir alan</span>
        <span class="muted-text" style="margin-left:6px;">(Ctrl / Shift ile çoklu seç)</span>
      </div>
      <div class="dupes-actions">
        ${devToggleHtml}
        <button id="btn-delete-selected-dupes" class="cmd-btn danger-hover hidden">🗑️ Seçilenleri Çöpe At (0)</button>
        <button id="btn-clear-dup-sel" class="cmd-btn hidden" title="Seçimi temizle (Esc)">✕</button>
        <button id="btn-delete-all-dupes" class="cmd-btn danger-hover">🗑️ Fazla Kopyaları Çöpe At (${redundantPaths.length})</button>
      </div>
    </div>
    <div id="dupe-groups-list" class="dupe-groups-list"></div>
  `;

  bindCommonControls();

  const listEl = $('dupe-groups-list');
  dupFlatPaths = [];

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
      const flatIdx = dupFlatPaths.length;
      dupFlatPaths.push(f.path);

      const row = document.createElement('div');
      row.className = 'dupe-file-row' + (dupSelectedPaths.has(f.path) ? ' selected' : '');
      row.dataset.path = f.path;
      row.dataset.flatIdx = String(flatIdx);
      row.title = f.path;
      row.innerHTML = `
        <span class="${idx === 0 ? 'dupe-badge-orig' : 'dupe-badge-copy'}">${idx === 0 ? 'Orijinal' : 'Kopya'}</span>
        <span class="analyzer-row-name">${esc(f.path)}</span>
        <span class="dupe-row-actions">
          <button type="button" class="dupe-mini-btn dupe-preview-btn" title="Hızlı Önizle (Çift Tık / Space)">👁️</button>
          <button type="button" class="dupe-mini-btn dupe-trash-btn" title="Bu dosyayı Çöp Kutusu'na at">🗑️</button>
        </span>
      `;

      row.onclick = (e) => {
        if (e.target.closest('.dupe-row-actions')) return;
        if (e.shiftKey && dupLastSelectedIdx >= 0) {
          const start = Math.min(dupLastSelectedIdx, flatIdx);
          const end = Math.max(dupLastSelectedIdx, flatIdx);
          if (!e.ctrlKey) dupSelectedPaths.clear();
          for (let i = start; i <= end; i++) {
            if (dupFlatPaths[i]) dupSelectedPaths.add(dupFlatPaths[i]);
          }
        } else if (e.ctrlKey) {
          if (dupSelectedPaths.has(f.path)) dupSelectedPaths.delete(f.path);
          else dupSelectedPaths.add(f.path);
          dupLastSelectedIdx = flatIdx;
        } else {
          dupSelectedPaths.clear();
          dupSelectedPaths.add(f.path);
          dupLastSelectedIdx = flatIdx;
        }
        syncDupSelectionUI();
      };

      row.ondblclick = (e) => {
        if (e.target.closest('.dupe-row-actions')) return;
        openQuickLook({ ...f, size: g.size, isDir: false });
      };

      const previewBtn = row.querySelector('.dupe-preview-btn');
      if (previewBtn) {
        previewBtn.onclick = (e) => {
          e.stopPropagation();
          openQuickLook({ ...f, size: g.size, isDir: false });
        };
      }

      const trashBtn = row.querySelector('.dupe-trash-btn');
      if (trashBtn) {
        trashBtn.onclick = async (e) => {
          e.stopPropagation();
          const res = await deleteSelected(false, [f.path]);
          if (res && res.jobId) procModalState.refreshDupesOnJobId = res.jobId;
        };
      }

      box.appendChild(row);
    });
    listEl.appendChild(box);
  }

  if (prevScrollTop > 0) listEl.scrollTop = prevScrollTop;
  syncDupSelectionUI();

  const delSelBtn = $('btn-delete-selected-dupes');
  if (delSelBtn) {
    delSelBtn.onclick = async () => {
      const targets = Array.from(dupSelectedPaths);
      if (targets.length === 0) return;
      const res = await deleteSelected(false, targets);
      if (res && res.jobId) procModalState.refreshDupesOnJobId = res.jobId;
    };
  }

  const clearSelBtn = $('btn-clear-dup-sel');
  if (clearSelBtn) clearSelBtn.onclick = () => clearDupSelection();

  $('btn-delete-all-dupes').onclick = async () => {
    const res = await deleteSelected(false, redundantPaths, { originTag: 'dupes' });
    if (res && res.jobId) procModalState.refreshDupesOnJobId = res.jobId;
  };
}

async function findAndRenderDuplicates(force = false) {
  clearDupSelection();
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
    const protectDev = getProtectDevPref() ? '1' : '0';
    const data = await api(`/api/duplicates?path=${encodeURIComponent(targetPath)}&force=${force === true ? '1' : '0'}&protectDev=${protectDev}`);
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

export {
  clearDupSelection,
  findAndRenderDuplicates,
  getDupSelectedPaths,
  openQuickLookForSelectedDup,
  pruneDeletedPathsFromDuplicates,
  renderDuplicatesResult,
  selectDupPathForContextMenu,
};
