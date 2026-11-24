import { $, esc } from '../../utils/dom.js';
import { formatBytes, formatDurationShort, opIconForType } from '../../utils/formatters.js';
import { api, localClientErrors } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { getActiveTab, getFolderTitle, navigateTo, updateTrashBadge, updateUndoButton } from '../navigation/tabsAndRouter.js';
import { state } from '../../store/appState.js';
import { findAndRenderDuplicates, pollIndexStatus } from '../analyzer/analyzerAndDuplicates.js';
import { navigateDual, renderBasket } from './basketAndDualPane.js';

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


export {
  closeProcessModal,
  controlTask,
  copyFullDiagnosticsReport,
  minimizeProcessModal,
  openErrorsDialog,
  openProcessModal,
  pollTransferStatus,
  procModalState,
  refreshErrorsDialog,
  updateErrorBadge,
};
