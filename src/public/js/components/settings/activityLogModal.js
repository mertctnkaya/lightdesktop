import { $, esc } from '../../utils/dom.js';
import { formatBytes } from '../../utils/formatters.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { showPromptModal } from '../shared/promptModal.js';
import { openFolderPickerModal } from '../shared/folderPickerModal.js';
import { getActiveTab, navigateTo } from '../navigation/tabsAndRouter.js';

const FIELD_DEFS = [
  { key: 'time', label: 'Tarih/Saat' },
  { key: 'event', label: 'Olay' },
  { key: 'kind', label: 'Tür' },
  { key: 'path', label: 'Tam Yol' },
  { key: 'size', label: 'Boyut' },
  { key: 'delta', label: 'Değişim' },
  { key: 'meta', label: 'Detay / Meta' },
  { key: 'watchRoot', label: 'İzlenen Kök' },
];

const EVENT_LABELS = {
  CREATED: { text: 'Oluştu', cls: 'created' },
  MODIFIED: { text: 'Düzenlendi', cls: 'modified' },
  DELETED: { text: 'Silindi', cls: 'deleted' },
  RENAMED: { text: 'Ad Değişti', cls: 'renamed' },
  BATCH: { text: 'Toplu', cls: 'batch' },
};

let actState = {
  config: null,
  logsDir: '',
  files: [],
  totalBytes: 0,
  txtCount: 0,
  gzCount: 0,
  activeCount: 0,
  activeTab: 'logs',
  eventFilter: 'ALL',
  lastEntries: [],
  totalMatched: 0,
};

let searchDebounce = null;
let handlersBound = false;

function formatShortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDelta(delta) {
  if (delta === null || delta === undefined || Number.isNaN(delta) || delta === 0) return '';
  const sign = delta > 0 ? '+' : '-';
  return `${sign}${formatBytes(Math.abs(delta))}`;
}

function updateTopButtonAndHeader() {
  const cfg = actState.config;
  const enabledCount = (cfg?.watches || []).filter((w) => w.enabled).length;
  const isRunning = Boolean(cfg?.enabled && actState.activeCount > 0);

  const topBtn = $('btn-activity-log');
  if (topBtn) {
    topBtn.textContent = enabledCount > 0 ? `📝 Loglar (${enabledCount})` : '📝 Loglar';
    topBtn.classList.toggle('active-watch', isRunning);
  }

  const statusEl = $('act-live-status');
  if (statusEl) {
    if (!cfg?.enabled) statusEl.textContent = 'İzleme genel olarak duraklatıldı';
    else if (actState.activeCount > 0) statusEl.textContent = `${actState.activeCount} yol canlı izleniyor • Sıfır tarama yükü`;
    else statusEl.textContent = 'Henüz aktif izlenen klasör yok';
  }

  const toggleBtn = $('btn-act-toggle-global');
  if (toggleBtn && cfg) {
    toggleBtn.textContent = cfg.enabled ? '⏸️ Duraklat' : '▶️ Başlat';
  }

  const diskBadge = $('act-disk-badge');
  if (diskBadge) {
    diskBadge.textContent = `${formatBytes(actState.totalBytes)} (${actState.txtCount} txt, ${actState.gzCount} gz)`;
  }
}

function renderSettingsActivityList() {
  const listEl = $('act-settings-watch-list');
  if (!listEl) return;
  const watches = actState.config?.watches || [];
  if (watches.length === 0) {
    listEl.innerHTML = '<div class="muted-text" style="font-size:11px;padding:3px 2px;">Henüz izlenen klasör eklenmedi.</div>';
    return;
  }
  listEl.innerHTML = '';
  for (const w of watches) {
    const chip = document.createElement('div');
    chip.className = 'vault-path-chip';
    chip.title = w.path;
    const subTag = w.recursive ? 'Alt klasörler dahil' : 'Sadece üst klasör';
    const statusDot = w.enabled && actState.config?.enabled ? '🟢' : '⏸️';
    chip.innerHTML = `
      <span class="vault-path-text">${statusDot} ${esc(w.path)} <span class="muted-text">(${subTag})</span></span>
      <button type="button" class="vault-path-remove" title="İzlemeden kaldır">✕</button>
    `;
    chip.querySelector('.vault-path-remove').onclick = () => removeWatchPath(w.path);
    listEl.appendChild(chip);
  }
}

async function saveConfigPatch(patch, toastMsg = '') {
  const res = await api('/api/activity/config', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
  applyConfigPayload(res);
  if (toastMsg) toast(toastMsg, 'success');
  return res;
}

function applyConfigPayload(res) {
  if (!res) return;
  actState.config = res.config || actState.config;
  actState.logsDir = res.logsDir || actState.logsDir;
  actState.files = res.files || actState.files;
  actState.totalBytes = Number(res.totalBytes) || 0;
  actState.txtCount = Number(res.txtCount) || 0;
  actState.gzCount = Number(res.gzCount) || 0;
  actState.activeCount = Number(res.activeCount) || 0;
  updateTopButtonAndHeader();
  renderSettingsActivityList();
}

async function refreshActivitySettingsUI() {
  try {
    const res = await api('/api/activity/config', { silentErrors: true });
    applyConfigPayload(res);
  } catch {}
}

async function removeWatchPath(targetPath) {
  const watches = (actState.config?.watches || []).filter(
    (w) => w.path.toLowerCase() !== String(targetPath || '').toLowerCase()
  );
  try {
    await saveConfigPatch({ watches }, 'Yol izleme listesinden kaldırıldı');
    renderWatchesPanel();
    syncLogFilterSelects();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderColumnToggles() {
  const wrap = $('act-col-toggles');
  if (!wrap || !actState.config) return;
  const vis = actState.config.visibleFields || {};
  wrap.innerHTML = '<span class="muted-text" style="font-size:11px;margin-right:4px;">Görünür Alanlar:</span>';
  for (const f of FIELD_DEFS) {
    const lbl = document.createElement('label');
    lbl.className = 'act-col-chip';
    lbl.innerHTML = `<input type="checkbox" ${vis[f.key] ? 'checked' : ''} /> <span>${esc(f.label)}</span>`;
    lbl.querySelector('input').onchange = async (e) => {
      const nextVis = { ...(actState.config.visibleFields || {}), [f.key]: e.target.checked };
      actState.config.visibleFields = nextVis;
      renderLogEntries();
      try {
        await saveConfigPatch({ visibleFields: nextVis });
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    wrap.appendChild(lbl);
  }
}

function syncLogFilterSelects() {
  const rootSel = $('act-filter-root');
  if (rootSel && actState.config) {
    const prev = rootSel.value;
    rootSel.innerHTML = '<option value="">Tüm İzlenen Yollar</option>';
    for (const w of actState.config.watches || []) {
      const opt = document.createElement('option');
      opt.value = w.path;
      opt.textContent = w.path;
      rootSel.appendChild(opt);
    }
    rootSel.value = prev;
  }

  const fileSel = $('act-filter-file');
  if (fileSel) {
    const prev = fileSel.value;
    fileSel.innerHTML = '<option value="">Tüm Log Dosyaları</option>';
    for (const f of actState.files || []) {
      const opt = document.createElement('option');
      opt.value = f.name;
      opt.textContent = `${f.name} (${formatBytes(f.size)})`;
      fileSel.appendChild(opt);
    }
    fileSel.value = prev;
  }
}

function renderLogEntries() {
  const listEl = $('act-logs-list');
  const countEl = $('act-logs-count');
  if (!listEl) return;

  const vis = actState.config?.visibleFields || {};
  const entries = actState.lastEntries || [];
  if (countEl) {
    countEl.textContent = actState.totalMatched > entries.length
      ? `${entries.length} / ${actState.totalMatched} kayıt gösteriliyor`
      : `${entries.length} kayıt`;
  }

  if (entries.length === 0) {
    const hasWatches = (actState.config?.watches || []).length > 0;
    listEl.innerHTML = `<div class="muted-text" style="padding:28px 16px;text-align:center;">${
      hasWatches
        ? 'Eşleşen log kaydı bulunamadı. İzlenen klasörlerde işlem yapıldığında buraya anında düşer.'
        : 'Henüz izlenen klasör yok. "👁️ İzlenen Yollar & Ayarlar" sekmesinden klasör ekleyin.'
    }</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of entries) {
    const row = document.createElement('div');
    row.className = 'act-log-row';

    const evInfo = EVENT_LABELS[item.event] || { text: item.event, cls: 'batch' };
    const kindIcon = item.kind === 'dir' ? '📁' : '📄';
    const kindText = item.kind === 'dir' ? 'Klasör' : (item.ext ? item.ext.toUpperCase() : item.cat || 'Dosya');
    const sizeText = item.kind !== 'dir' && item.size !== null ? formatBytes(item.size) : '';
    const deltaText = formatDelta(item.delta);

    const pieces = [];
    if (vis.time) pieces.push(`<span class="act-cell-time">${esc(formatShortTime(item.time))}</span>`);
    if (vis.event) pieces.push(`<span class="act-badge act-badge-${evInfo.cls}">${esc(evInfo.text)}</span>`);
    if (vis.kind) pieces.push(`<span class="act-cell-kind">${kindIcon} ${esc(kindText)}</span>`);
    pieces.push(`<span class="act-cell-name" title="${esc(item.fullPath)}">${esc(item.name)}</span>`);
    if (vis.size && sizeText) pieces.push(`<span class="act-cell-size">${esc(sizeText)}</span>`);
    if (vis.delta && deltaText) {
      const deltaCls = item.delta > 0 ? 'pos' : 'neg';
      pieces.push(`<span class="act-cell-delta ${deltaCls}">${esc(deltaText)}</span>`);
    }
    if (vis.meta && item.meta) pieces.push(`<span class="act-cell-meta">${esc(item.meta)}</span>`);

    const subLines = [];
    if (vis.path && item.fullPath) subLines.push(`<div class="act-sub-path">${esc(item.fullPath)}</div>`);
    if (vis.watchRoot && item.watchRoot) subLines.push(`<div class="act-sub-root">Kök: ${esc(item.watchRoot)} (${esc(item.file || '')})</div>`);

    row.innerHTML = `
      <div class="act-row-main">${pieces.join('')}</div>
      ${subLines.length > 0 ? `<div class="act-row-sub">${subLines.join('')}</div>` : ''}
      <button type="button" class="act-jump-btn" title="Klasöre Git">📂</button>
    `;
    row.querySelector('.act-jump-btn').onclick = () => {
      const idx = Math.max(item.fullPath.lastIndexOf('\\'), item.fullPath.lastIndexOf('/'));
      const parentDir = item.kind === 'dir' && item.event !== 'DELETED'
        ? item.fullPath
        : (idx > 0 ? item.fullPath.slice(0, idx) : item.watchRoot);
      const target = /^[a-zA-Z]:$/.test(parentDir) ? `${parentDir}\\` : parentDir;
      if (target) {
        $('activity-log-dialog')?.close();
        navigateTo(target);
      }
    };
    frag.appendChild(row);
  }
  listEl.innerHTML = '';
  listEl.appendChild(frag);
}

async function fetchAndRenderLogs() {
  const q = $('act-search')?.value || '';
  const watchRoot = $('act-filter-root')?.value || '';
  const file = $('act-filter-file')?.value || '';
  const qs = new URLSearchParams({
    q,
    event: actState.eventFilter,
    watchRoot,
    file,
    limit: '400',
  });
  try {
    const res = await api(`/api/activity/logs?${qs.toString()}`);
    actState.lastEntries = res.entries || [];
    actState.totalMatched = Number(res.totalMatched) || 0;
    actState.files = res.files || actState.files;
    actState.totalBytes = Number(res.totalBytes) || 0;
    actState.txtCount = Number(res.txtCount) || 0;
    actState.gzCount = Number(res.gzCount) || 0;
    updateTopButtonAndHeader();
    syncLogFilterSelects();
    renderLogEntries();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderWatchesPanel() {
  const listEl = $('act-watches-list');
  const cfg = actState.config;
  if (!listEl || !cfg) return;

  if ($('act-opt-noise')) $('act-opt-noise').checked = Boolean(cfg.ignoreNoise);
  if ($('act-opt-maxkb')) $('act-opt-maxkb').value = String(cfg.maxActiveKb || 512);
  if ($('act-opt-retention')) $('act-opt-retention').value = String(cfg.retentionDays || 30);

  if (!cfg.watches || cfg.watches.length === 0) {
    listEl.innerHTML = '<div class="muted-text" style="padding:20px;text-align:center;">Henüz izlenen klasör eklenmedi. Yukarıdan klasör ekleyerek değişimleri anında takip edebilirsiniz.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const w of cfg.watches) {
    const card = document.createElement('div');
    card.className = `act-watch-card${w.enabled ? '' : ' paused'}`;
    card.innerHTML = `
      <div class="act-watch-top">
        <div class="act-watch-path" title="${esc(w.path)}">📁 ${esc(w.path)}</div>
        <div class="act-watch-top-btns">
          <label class="act-mini-toggle"><input type="checkbox" class="w-enabled" ${w.enabled ? 'checked' : ''} /> İzle</label>
          <button type="button" class="cmd-btn danger-hover w-remove" title="Kaldır">✕</button>
        </div>
      </div>
      <div class="act-watch-opts">
        <label class="act-mini-toggle"><input type="checkbox" class="w-recursive" ${w.recursive ? 'checked' : ''} /> Alt klasörler dahil</label>
        <span class="act-opt-sep">|</span>
        <label class="act-mini-toggle"><input type="checkbox" class="w-ev-create" ${w.events?.create !== false ? 'checked' : ''} /> Oluşan</label>
        <label class="act-mini-toggle"><input type="checkbox" class="w-ev-modify" ${w.events?.modify !== false ? 'checked' : ''} /> Düzenlenen</label>
        <label class="act-mini-toggle"><input type="checkbox" class="w-ev-delete" ${w.events?.delete !== false ? 'checked' : ''} /> Silinen</label>
        <label class="act-mini-toggle"><input type="checkbox" class="w-ev-rename" ${w.events?.rename !== false ? 'checked' : ''} /> Ad Değişen</label>
      </div>
    `;

    const patchWatch = async (patch) => {
      const nextWatches = (actState.config?.watches || []).map((item) =>
        item.id === w.id ? { ...item, ...patch } : item
      );
      try {
        await saveConfigPatch({ watches: nextWatches });
        renderWatchesPanel();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    card.querySelector('.w-enabled').onchange = (e) => patchWatch({ enabled: e.target.checked });
    card.querySelector('.w-recursive').onchange = (e) => patchWatch({ recursive: e.target.checked });
    const evHandler = () => {
      patchWatch({
        events: {
          create: card.querySelector('.w-ev-create').checked,
          modify: card.querySelector('.w-ev-modify').checked,
          delete: card.querySelector('.w-ev-delete').checked,
          rename: card.querySelector('.w-ev-rename').checked,
        },
      });
    };
    card.querySelector('.w-ev-create').onchange = evHandler;
    card.querySelector('.w-ev-modify').onchange = evHandler;
    card.querySelector('.w-ev-delete').onchange = evHandler;
    card.querySelector('.w-ev-rename').onchange = evHandler;
    card.querySelector('.w-remove').onclick = () => removeWatchPath(w.path);
    listEl.appendChild(card);
  }
}

function switchActivityTab(tab) {
  actState.activeTab = tab;
  $('btn-act-tab-logs')?.classList.toggle('active', tab === 'logs');
  $('btn-act-tab-watches')?.classList.toggle('active', tab === 'watches');
  $('act-panel-logs')?.classList.toggle('hidden', tab !== 'logs');
  $('act-panel-watches')?.classList.toggle('hidden', tab !== 'watches');
  if (tab === 'logs') fetchAndRenderLogs();
  else renderWatchesPanel();
}

async function addWatchViaPicker(initialPath = '') {
  const picked = await openFolderPickerModal({
    title: 'İzlenecek Klasörü Seç',
    initialPath: initialPath || getActiveTab()?.path || 'PC',
  });
  if (!picked || picked === 'PC' || picked === 'TRASH') return;
  await quickWatchFolder(picked);
  if ($('activity-log-dialog')?.open) {
    renderWatchesPanel();
    syncLogFilterSelects();
  }
}

async function quickWatchFolder(dirPath, recursive = true) {
  const clean = String(dirPath || '').trim();
  if (!clean || clean === 'PC' || clean === 'TRASH') {
    toast('Lütfen izlenecek gerçek bir klasör seçin', 'error');
    return;
  }
  try {
    const res = await api('/api/activity/watch/add', {
      method: 'POST',
      body: JSON.stringify({ path: clean, recursive, enabled: true }),
    });
    applyConfigPayload(res);
    toast(`👁️ Klasör izlemeye alındı: ${clean}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openActivityLogModal(defaultTab = 'logs') {
  await refreshActivitySettingsUI();
  renderColumnToggles();
  syncLogFilterSelects();
  const dlg = $('activity-log-dialog');
  if (dlg && !dlg.open) dlg.showModal();
  switchActivityTab(defaultTab);
}

function bindActivityLogHandlers() {
  if (handlersBound) return;
  handlersBound = true;

  $('btn-activity-log')?.addEventListener('click', () => openActivityLogModal('logs'));
  $('btn-open-activity-modal')?.addEventListener('click', () => openActivityLogModal('watches'));
  $('btn-set-act-add')?.addEventListener('click', () => addWatchViaPicker());
  $('btn-close-activity-modal')?.addEventListener('click', () => $('activity-log-dialog')?.close());
  $('btn-act-done')?.addEventListener('click', () => $('activity-log-dialog')?.close());

  $('btn-act-tab-logs')?.addEventListener('click', () => switchActivityTab('logs'));
  $('btn-act-tab-watches')?.addEventListener('click', () => switchActivityTab('watches'));

  $('btn-act-toggle-global')?.addEventListener('click', async () => {
    if (!actState.config) return;
    try {
      const next = !actState.config.enabled;
      await saveConfigPatch({ enabled: next }, next ? 'İzleme başlatıldı' : 'İzleme duraklatıldı');
      renderWatchesPanel();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('act-search')?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => fetchAndRenderLogs(), 180);
  });

  document.querySelectorAll('[data-act-event]').forEach((btn) => {
    btn.addEventListener('click', () => {
      actState.eventFilter = btn.dataset.actEvent || 'ALL';
      document.querySelectorAll('[data-act-event]').forEach((b) => b.classList.toggle('active', b === btn));
      fetchAndRenderLogs();
    });
  });

  $('act-filter-root')?.addEventListener('change', () => fetchAndRenderLogs());
  $('act-filter-file')?.addEventListener('change', () => fetchAndRenderLogs());
  $('btn-act-refresh')?.addEventListener('click', () => fetchAndRenderLogs());

  $('btn-act-compress')?.addEventListener('click', async () => {
    try {
      const res = await api('/api/activity/compress', { method: 'POST', body: '{}' });
      applyConfigPayload(res);
      syncLogFilterSelects();
      fetchAndRenderLogs();
      toast(
        res.compressedCount > 0
          ? `🗜️ ${res.compressedCount} log sıkıştırıldı (${formatBytes(res.savedBytes || 0)} tasarruf)`
          : 'Sıkıştırılacak açık .txt log yok',
        'success'
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('btn-act-open-dir')?.addEventListener('click', () => {
    if (!actState.logsDir) return;
    $('activity-log-dialog')?.close();
    navigateTo(actState.logsDir);
  });

  $('btn-act-clear')?.addEventListener('click', async () => {
    const selectedFile = $('act-filter-file')?.value || '';
    const ok = await showPromptModal({
      title: 'Aktivite Loglarını Temizle',
      desc: selectedFile
        ? `"${selectedFile}" log dosyası kalıcı olarak silinsin mi?`
        : 'TÜM aktivite log dosyaları (.txt ve .txt.gz) kalıcı olarak silinsin mi?',
      okText: '🗑️ Sil',
    });
    if (!ok) return;
    try {
      const res = await api('/api/activity/clear', {
        method: 'POST',
        body: JSON.stringify(selectedFile ? { file: selectedFile } : { all: true }),
      });
      applyConfigPayload(res);
      if (selectedFile && $('act-filter-file')) $('act-filter-file').value = '';
      syncLogFilterSelects();
      fetchAndRenderLogs();
      toast(`${res.deleted || 0} log dosyası silindi`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('btn-act-add-watch')?.addEventListener('click', () => addWatchViaPicker());
  $('btn-act-add-current')?.addEventListener('click', async () => {
    const tab = getActiveTab();
    await quickWatchFolder(tab?.path || '');
    renderWatchesPanel();
    syncLogFilterSelects();
  });

  $('btn-act-save-opts')?.addEventListener('click', async () => {
    const ignoreNoise = Boolean($('act-opt-noise')?.checked);
    const maxActiveKb = Number($('act-opt-maxkb')?.value) || 512;
    const retentionDays = Number($('act-opt-retention')?.value) || 30;
    try {
      await saveConfigPatch({ ignoreNoise, maxActiveKb, retentionDays }, 'İzleme ayarları kaydedildi');
      renderWatchesPanel();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

export {
  bindActivityLogHandlers,
  openActivityLogModal,
  quickWatchFolder,
  refreshActivitySettingsUI,
};
