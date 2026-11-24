import { state } from '../../store/appState.js';
import { QUICK_ICONS } from '../../constants/uiConstants.js';
import { $, esc } from '../../utils/dom.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { showPromptModal } from './promptModal.js';

function getParentDirPath(dirPath) {
  const clean = String(dirPath || '').trim().replace(/[\\/]+$/, '');
  if (!clean) return '';
  if (/^[a-zA-Z]:$/.test(clean)) return `${clean}\\`;
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  if (idx <= 0) return clean;
  const parent = clean.slice(0, idx);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

function openFolderPickerModal({ title = 'Klasör Seç', subtitle = 'Bir klasör seçin veya yolu yapıştırın', initialDir = '' } = {}) {
  const dlg = $('folder-picker-dialog');
  if (!dlg) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('close', onClose);
      if (dlg.open) dlg.close();
      resolve(val || null);
    };
    const onClose = () => finish(null);
    dlg.addEventListener('close', onClose);

    $('fp-title').textContent = title || 'Klasör Seç';
    $('fp-subtitle').textContent = subtitle || 'Bir klasör seçin veya yolu yapıştırın';

    const pathInput = $('fp-path-input');
    const sidebarEl = $('fp-sidebar');
    const listEl = $('fp-list');
    const previewEl = $('fp-selected-preview');
    const backBtn = $('btn-fp-back');
    const fwdBtn = $('btn-fp-forward');

    let currentDir = '';
    const history = [];
    let histIdx = -1;

    const updateNavBtns = () => {
      if (backBtn) backBtn.disabled = histIdx <= 0;
      if (fwdBtn) fwdBtn.disabled = histIdx >= history.length - 1;
    };

    const updateSelectionPreview = () => {
      previewEl.textContent = currentDir ? `Seçili: ${currentDir}` : '';
      previewEl.title = currentDir || '';
    };

    const renderSidebar = () => {
      sidebarEl.innerHTML = '';

      const addSection = (secTitle, entries, iconDefault) => {
        if (!entries || entries.length === 0) return;
        const h = document.createElement('div');
        h.className = 'fp-sb-title';
        h.textContent = secTitle;
        sidebarEl.appendChild(h);

        for (const item of entries) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'fp-sb-item';
          btn.title = item.path;
          btn.innerHTML = `<span>${esc(item.icon || iconDefault)}</span><span class="fp-sb-label">${esc(item.label || item.name)}</span>`;
          btn.onclick = () => loadDir(item.path, false, true);
          sidebarEl.appendChild(btn);
        }
      };

      const qa = (state.quickAccess || []).map((x) => ({
        path: x.path,
        label: x.name,
        icon: QUICK_ICONS[x.icon] || '📁',
      }));
      const drives = (state.drives || []).map((d) => {
        const driveCode = d.letter || (d.path ? d.path.replace(/[\\/]+$/, '') : '');
        const labelText = d.label || 'Yerel Disk';
        return {
          path: d.path,
          label: driveCode ? `${labelText} (${driveCode})` : labelText,
          icon: '💽',
        };
      });
      addSection('Hızlı Erişim', qa, '📁');
      addSection('Sürücüler', drives, '💽');
    };

    const loadDir = async (rawTarget, allowFallback = true, pushHistory = true) => {
      const fallbackDir = (state.drives[0] && state.drives[0].path) || 'C:\\';
      const target = (rawTarget || '').trim() || fallbackDir;
      listEl.innerHTML = '<div class="muted-text" style="padding:12px;">Klasörler yükleniyor...</div>';
      try {
        const data = await api(`/api/subdirs?path=${encodeURIComponent(target)}`, { silentErrors: true });
        currentDir = data.path || target;
        pathInput.value = currentDir;
        updateSelectionPreview();

        if (pushHistory && history[histIdx] !== currentDir) {
          history.splice(histIdx + 1);
          history.push(currentDir);
          histIdx = history.length - 1;
        }
        updateNavBtns();

        const dirs = (data.dirs || []).filter((sub) => sub.name.toLowerCase() !== '.lightdesktopvault');
        listEl.innerHTML = '';
        if (dirs.length === 0) {
          listEl.innerHTML = '<div class="muted-text" style="padding:12px;">Alt klasör yok — "✓ Bu Klasörü Seç" ile mevcut konumu seçebilirsiniz.</div>';
          return;
        }
        for (const sub of dirs) {
          const row = document.createElement('div');
          row.className = 'fp-dir-row';
          row.title = `${sub.path} (Açmak için tıklayın)`;
          row.innerHTML = `<span>📁</span><span class="fp-dir-name">${esc(sub.name)}</span>`;
          row.onclick = () => loadDir(sub.path, false, true);
          listEl.appendChild(row);
        }
      } catch (err) {
        if (allowFallback && target.toLowerCase() !== fallbackDir.toLowerCase()) {
          await loadDir(fallbackDir, false, pushHistory);
        } else {
          listEl.innerHTML = `<div class="muted-text" style="padding:12px;">Açılamadı: ${esc(err.message)}</div>`;
        }
      }
    };

    $('btn-fp-close').onclick = () => finish(null);
    $('btn-fp-cancel').onclick = () => finish(null);
    $('btn-fp-select').onclick = () => finish(currentDir);
    if (backBtn) {
      backBtn.onclick = () => {
        if (histIdx > 0) {
          histIdx--;
          loadDir(history[histIdx], false, false);
        }
      };
    }
    if (fwdBtn) {
      fwdBtn.onclick = () => {
        if (histIdx < history.length - 1) {
          histIdx++;
          loadDir(history[histIdx], false, false);
        }
      };
    }
    $('btn-fp-up').onclick = () => {
      const parent = getParentDirPath(currentDir);
      if (parent && parent !== currentDir) loadDir(parent, false, true);
    };
    $('btn-fp-go').onclick = () => loadDir(pathInput.value, false, true);
    pathInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadDir(pathInput.value, false, true);
      }
    };
    $('btn-fp-mkdir').onclick = async () => {
      if (!currentDir) return;
      const promptRes = await showPromptModal({
        title: 'Yeni Klasör Oluştur',
        desc: `${currentDir} içine oluşturulacak klasör adı:`,
        fields: [{ name: 'name', label: 'Klasör adı', value: 'Yeni Klasör', placeholder: 'Klasör adı...' }],
        okText: 'Oluştur',
      });
      const name = promptRes && promptRes.name ? promptRes.name.trim() : '';
      if (!name) return;
      try {
        const res = await api('/api/fs/action', {
          method: 'POST',
          body: JSON.stringify({ action: 'mkdir', parentDir: currentDir, name }),
        });
        toast(`Klasör oluşturuldu: ${name}`, 'success');
        await loadDir((res && res.path) || currentDir, false, true);
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    updateNavBtns();
    renderSidebar();
    if (!dlg.open) dlg.showModal();
    loadDir(initialDir, true, true);
  });
}

export { openFolderPickerModal };
