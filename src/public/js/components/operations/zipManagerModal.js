import { $, esc } from '../../utils/dom.js';
import { formatBytes, formatDate } from '../../utils/formatters.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { showPromptModal } from '../shared/promptModal.js';
import { openFolderPickerModal } from '../shared/folderPickerModal.js';
import { getActiveTab, navigateTo } from '../navigation/tabsAndRouter.js';

let currentZipPath = '';
let currentZipEntries = [];
let filteredZipEntries = [];
const selectedZipEntries = new Set();
let lastZipCheckedIdx = -1;
let zipHandlersBound = false;

function getParentDirStr(filePath) {
  const clean = String(filePath || '').trim().replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  if (idx <= 0) return clean;
  const parent = clean.slice(0, idx);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

function getDefaultExtractSubdir(zipPath) {
  const parent = getParentDirStr(zipPath);
  const base = String(zipPath || '').split(/[\\/]/).pop().replace(/\.zip$/i, '') || 'Ayiklanan';
  return parent.endsWith('\\') ? `${parent}${base}` : `${parent}\\${base}`;
}

function refreshActiveExplorerIfMatches(dirPath) {
  const tab = getActiveTab();
  if (!tab || !tab.path || tab.path === 'PC' || tab.path === 'TRASH') return;
  const normTab = tab.path.replace(/[\\/]+$/, '').toLowerCase();
  const normTarget = String(dirPath || '').replace(/[\\/]+$/, '').toLowerCase();
  if (normTab === normTarget || normTarget.startsWith(normTab + '\\')) {
    navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
  }
}

function syncZipSelectionUI() {
  const count = selectedZipEntries.size;
  const btnSel = $('btn-zip-extract-selected');
  if (btnSel) {
    btnSel.disabled = count === 0;
    btnSel.textContent = `📤 Seçilenleri Ayıkla (${count})`;
  }
  const chkAll = $('chk-zip-select-all');
  if (chkAll) {
    chkAll.checked = filteredZipEntries.length > 0 && filteredZipEntries.every((e) => selectedZipEntries.has(e.fullName));
  }
  const rows = document.querySelectorAll('#zip-entries-list .zip-entry-row');
  for (const r of rows) {
    const fn = r.dataset.fullName;
    const isSel = selectedZipEntries.has(fn);
    r.classList.toggle('selected', isSel);
    const cb = r.querySelector('.zip-entry-chk');
    if (cb) cb.checked = isSel;
  }
}

function renderZipEntries() {
  const listEl = $('zip-entries-list');
  if (!listEl) return;
  const q = ($('zip-search-input')?.value || '').trim().toLowerCase();
  filteredZipEntries = q
    ? currentZipEntries.filter((e) => e.fullName.toLowerCase().includes(q))
    : currentZipEntries;

  if (filteredZipEntries.length === 0) {
    listEl.innerHTML = '<div class="muted-text" style="padding:18px;text-align:center;">Eşleşen öğe yok.</div>';
    syncZipSelectionUI();
    return;
  }

  const limit = 1500;
  const shown = filteredZipEntries.slice(0, limit);
  listEl.innerHTML = '';

  shown.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'zip-entry-row' + (selectedZipEntries.has(entry.fullName) ? ' selected' : '');
    row.dataset.fullName = entry.fullName;
    row.title = entry.fullName;

    const ratio = !entry.isDir && entry.size > 0
      ? `-%${Math.max(0, Math.round((1 - (entry.compressedSize / entry.size)) * 100))}`
      : '';
    const sizeText = entry.isDir ? 'Klasör' : formatBytes(entry.size);
    const dateText = entry.mtimeMs ? formatDate(entry.mtimeMs) : '';

    row.innerHTML = `
      <input type="checkbox" class="zip-entry-chk" ${selectedZipEntries.has(entry.fullName) ? 'checked' : ''} />
      <span class="zip-entry-icon">${entry.isDir ? '📁' : '📄'}</span>
      <span class="zip-entry-name">${esc(entry.fullName)}</span>
      <span class="zip-entry-ratio muted-text">${esc(ratio)}</span>
      <span class="zip-entry-size">${esc(sizeText)}</span>
      <span class="zip-entry-date muted-text">${esc(dateText)}</span>
    `;

    row.onclick = (e) => {
      if (e.shiftKey && lastZipCheckedIdx >= 0) {
        const start = Math.min(lastZipCheckedIdx, idx);
        const end = Math.max(lastZipCheckedIdx, idx);
        if (!e.ctrlKey && e.target.type !== 'checkbox') selectedZipEntries.clear();
        for (let i = start; i <= end; i++) {
          if (shown[i]) selectedZipEntries.add(shown[i].fullName);
        }
      } else {
        if (selectedZipEntries.has(entry.fullName)) selectedZipEntries.delete(entry.fullName);
        else selectedZipEntries.add(entry.fullName);
        lastZipCheckedIdx = idx;
      }
      syncZipSelectionUI();
    };
    listEl.appendChild(row);
  });

  if (filteredZipEntries.length > limit) {
    const more = document.createElement('div');
    more.className = 'muted-text';
    more.style.padding = '8px 12px';
    more.textContent = `İlk ${limit} öğe gösteriliyor (toplam ${filteredZipEntries.length}). Arama kutusuyla daraltabilirsiniz.`;
    listEl.appendChild(more);
  }
  syncZipSelectionUI();
}

async function runZipExtract(zipPath, destDir, entries = null) {
  toast('ZIP ayıklanıyor...');
  try {
    const res = await api('/api/zip/extract', {
      method: 'POST',
      body: JSON.stringify({ zipPath, destDir, entries }),
    });
    toast(`✅ ${res.extractedFiles} dosya ayıklandı → ${res.destDir}`, 'success');
    refreshActiveExplorerIfMatches(res.destDir);
    return res;
  } catch (err) {
    toast(`ZIP ayıklama hatası: ${err.message}`, 'error');
    return null;
  }
}

function bindZipDialogHandlers() {
  if (zipHandlersBound) return;
  zipHandlersBound = true;
  const dlg = $('zip-dialog');
  if (!dlg) return;

  if ($('btn-zip-close')) $('btn-zip-close').onclick = () => dlg.close();
  if ($('btn-zip-done')) $('btn-zip-done').onclick = () => dlg.close();
  if ($('zip-search-input')) $('zip-search-input').oninput = () => renderZipEntries();

  if ($('chk-zip-select-all')) {
    $('chk-zip-select-all').onchange = (e) => {
      const checked = Boolean(e.target.checked);
      for (const item of filteredZipEntries) {
        if (checked) selectedZipEntries.add(item.fullName);
        else selectedZipEntries.delete(item.fullName);
      }
      syncZipSelectionUI();
    };
  }

  if ($('btn-zip-extract-here')) {
    $('btn-zip-extract-here').onclick = async () => {
      if (!currentZipPath) return;
      await runZipExtract(currentZipPath, getDefaultExtractSubdir(currentZipPath), null);
    };
  }

  if ($('btn-zip-extract-to')) {
    $('btn-zip-extract-to').onclick = async () => {
      if (!currentZipPath) return;
      const dest = await openFolderPickerModal({
        title: 'Ayıklanacak Hedef Klasör',
        subtitle: 'ZIP içeriğinin çıkarılacağı klasörü seçin',
        initialDir: getParentDirStr(currentZipPath),
      });
      if (dest) await runZipExtract(currentZipPath, dest, null);
    };
  }

  if ($('btn-zip-extract-selected')) {
    $('btn-zip-extract-selected').onclick = async () => {
      if (!currentZipPath || selectedZipEntries.size === 0) return;
      const dest = await openFolderPickerModal({
        title: `Seçilen ${selectedZipEntries.size} Öğeyi Ayıkla`,
        subtitle: 'Seçili öğelerin çıkarılacağı hedef klasörü seçin',
        initialDir: getParentDirStr(currentZipPath),
      });
      if (dest) await runZipExtract(currentZipPath, dest, Array.from(selectedZipEntries));
    };
  }
}

async function openZipManagerModal(zipPath) {
  bindZipDialogHandlers();
  const dlg = $('zip-dialog');
  if (!dlg) return;

  currentZipPath = zipPath;
  currentZipEntries = [];
  filteredZipEntries = [];
  selectedZipEntries.clear();
  lastZipCheckedIdx = -1;
  if ($('zip-search-input')) $('zip-search-input').value = '';
  if ($('zip-title')) $('zip-title').textContent = String(zipPath || '').split(/[\\/]/).pop() || 'ZIP Arşivi';
  if ($('zip-subtitle')) $('zip-subtitle').textContent = `${zipPath} • Yükleniyor...`;
  if ($('zip-footer-info')) $('zip-footer-info').textContent = '';
  if ($('zip-entries-list')) $('zip-entries-list').innerHTML = '<div class="muted-text" style="padding:18px;">Arşiv okunuyor...</div>';
  syncZipSelectionUI();
  if (!dlg.open) dlg.showModal();

  try {
    const data = await api(`/api/zip/list?path=${encodeURIComponent(zipPath)}`);
    currentZipEntries = data.entries || [];
    if ($('zip-subtitle')) {
      $('zip-subtitle').textContent = `${data.zipPath} • ${data.fileCount} dosya, ${data.dirCount} klasör`;
    }
    if ($('zip-footer-info')) {
      $('zip-footer-info').textContent = `Açık Boyut: ${formatBytes(data.totalSize)} • Sıkıştırılmış: ${formatBytes(data.archiveSize)}`;
    }
    renderZipEntries();
  } catch (err) {
    if ($('zip-entries-list')) {
      $('zip-entries-list').innerHTML = `<div class="muted-text" style="padding:18px;color:#ff9c94;">Arşiv okunamadı: ${esc(err.message)}</div>`;
    }
  }
}

async function extractZipQuickHere(zipPath) {
  await runZipExtract(zipPath, getDefaultExtractSubdir(zipPath), null);
}

async function extractZipToPicker(zipPath) {
  const dest = await openFolderPickerModal({
    title: 'Ayıklanacak Hedef Klasör',
    subtitle: 'ZIP içeriğinin çıkarılacağı klasörü seçin',
    initialDir: getParentDirStr(zipPath),
  });
  if (dest) await runZipExtract(zipPath, dest, null);
}

async function compressPathsToZip(paths = [], parentDir = '') {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const baseDir = parentDir && parentDir !== 'PC' && parentDir !== 'TRASH'
    ? parentDir
    : getParentDirStr(paths[0]);
  const defaultBase = paths.length === 1
    ? (String(paths[0]).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'Arsiv')
    : `${String(baseDir).split(/[\\/]/).pop() || 'Arsiv'}_Arsiv`;

  const promptRes = await showPromptModal({
    title: 'ZIP Arşivi Oluştur',
    desc: `${paths.length} öğe sıkıştırılacak. Hedef klasör: ${baseDir}`,
    fields: [{ name: 'name', label: 'ZIP dosya adı', value: `${defaultBase}.zip`, placeholder: 'Arsiv.zip' }],
    okText: '🗜️ Sıkıştır',
  });
  let name = promptRes && promptRes.name ? promptRes.name.trim() : '';
  if (!name) return;
  if (!name.toLowerCase().endsWith('.zip')) name += '.zip';

  const destZipPath = baseDir.endsWith('\\') ? `${baseDir}${name}` : `${baseDir}\\${name}`;
  toast('ZIP arşivi oluşturuluyor...');
  try {
    const res = await api('/api/zip/compress', {
      method: 'POST',
      body: JSON.stringify({ paths, destZipPath }),
    });
    toast(`✅ Arşiv oluşturuldu: ${res.name} (${formatBytes(res.size)})`, 'success');
    refreshActiveExplorerIfMatches(baseDir);
  } catch (err) {
    toast(`Sıkıştırma hatası: ${err.message}`, 'error');
  }
}

export {
  compressPathsToZip,
  extractZipQuickHere,
  extractZipToPicker,
  openZipManagerModal,
};
