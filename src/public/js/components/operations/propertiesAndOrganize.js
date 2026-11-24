import { getActiveTab, getFolderTitle } from '../navigation/tabsAndRouter.js';
import { state } from '../../store/appState.js';
import { $, copyTextSafe, esc } from '../../utils/dom.js';
import { api } from '../../services/apiClient.js';
import { ICONS } from '../../constants/uiConstants.js';
import { formatBytes, formatDate } from '../../utils/formatters.js';
import { toast } from '../shared/toast.js';
import { openProcessModal } from './processAndErrorCenter.js';
import { openFolderPickerModal } from '../shared/folderPickerModal.js';

let propsReqSeq = 0;

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
      const picked = await openFolderPickerModal({
        title: 'Hedef Klasör Seç',
        subtitle: 'Tarihle ayrıştırılan dosyaların kaydedileceği hedef klasörü seçin',
        initialDir: customInp.value.trim() || currentDir,
      });
      if (picked) {
        customInp.value = picked;
        updatePreview();
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


export {
  organizeCurrentFolderByDate,
  propsReqSeq,
  showPropertiesModal,
};
