import { $, esc } from '../../utils/dom.js';
import { formatBytes } from '../../utils/formatters.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { showPromptModal } from '../shared/promptModal.js';
import { openFolderPickerModal } from '../shared/folderPickerModal.js';
import { getActiveTab, navigateTo } from '../navigation/tabsAndRouter.js';

let currentProtectedPaths = [];

function renderProtectedPathsList(paths, itemCount = 0) {
  currentProtectedPaths = Array.isArray(paths) ? [...paths] : [];
  const listEl = $('vault-protected-list');
  const openBtn = $('btn-open-vault-modal');

  if (openBtn) {
    openBtn.textContent = itemCount > 0 ? `🔐 30 Günlük Kasayı Aç (${itemCount})` : '🔐 30 Günlük Kasayı Aç';
  }
  if (!listEl) return;

  if (currentProtectedPaths.length === 0) {
    listEl.innerHTML = '<div class="muted-text" style="font-size:11px;padding:3px 2px;">Henüz korunan klasör eklenmedi.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const p of currentProtectedPaths) {
    const chip = document.createElement('div');
    chip.className = 'vault-path-chip';
    chip.title = p;
    chip.innerHTML = `
      <span class="vault-path-text">🛡️ ${esc(p)}</span>
      <button type="button" class="vault-path-remove" title="Korumadan kaldır">✕</button>
    `;
    chip.querySelector('.vault-path-remove').onclick = async () => {
      const next = currentProtectedPaths.filter((x) => x.toLowerCase() !== p.toLowerCase());
      try {
        const res = await api('/api/vault/config', {
          method: 'POST',
          body: JSON.stringify({ protectedPaths: next }),
        });
        renderProtectedPathsList(res.protectedPaths, res.itemCount);
        toast('Klasör koruma listesinden çıkarıldı');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    listEl.appendChild(chip);
  }
}

async function refreshVaultSettingsUI() {
  try {
    const data = await api('/api/vault/config', { silentErrors: true });
    renderProtectedPathsList(data.protectedPaths || [], data.itemCount || 0);
  } catch {}
}

function renderVaultModalItems(items = [], totalBytes = 0) {
  const listEl = $('vault-items-list');
  const subEl = $('vault-modal-subtitle');
  const restoreAllBtn = $('btn-vault-restore-all');
  const purgeAllBtn = $('btn-vault-purge-all');

  if (subEl) {
    subEl.textContent = items.length > 0
      ? `${items.length} gizli korunan öğe • Bilinen boyut: ${formatBytes(totalBytes)}`
      : 'Koruma kasası şu an boş.';
  }
  if (restoreAllBtn) restoreAllBtn.disabled = items.length === 0;
  if (purgeAllBtn) purgeAllBtn.disabled = items.length === 0;
  if (!listEl) return;

  if (items.length === 0) {
    listEl.innerHTML = '<div class="vault-empty">🛡️ Korunan klasörlerden kalıcı silinen dosya veya klasörler 30 gün boyunca burada güvenle bekletilir.</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'vault-item-row';
    const delDate = item.deletedAt ? new Date(item.deletedAt).toLocaleString('tr-TR') : '';
    const sizeText = item.isDir ? 'Klasör' : formatBytes(item.size || 0);
    row.innerHTML = `
      <span class="vault-item-icon">${item.isDir ? '📁' : '📄'}</span>
      <div class="vault-item-meta">
        <div class="vault-item-name">${esc(item.name)}</div>
        <div class="vault-item-path" title="${esc(item.origPath)}">${esc(item.origPath)}</div>
        <div class="vault-item-sub">${esc(sizeText)} • Silinme: ${esc(delDate)}</div>
      </div>
      <span class="vault-days-badge" title="Kalan saklama süresi">${item.daysLeft} gün kaldı</span>
      <div class="vault-item-actions">
        <button type="button" class="cmd-btn vault-restore-btn" title="Orijinal konumuna geri yükle">↩️ Geri Yükle</button>
        <button type="button" class="cmd-btn danger-hover vault-purge-btn" title="Kasa içinden tamamen ve kalıcı olarak yok et">🔥</button>
      </div>
    `;

    row.querySelector('.vault-restore-btn').onclick = async () => {
      try {
        const res = await api('/api/vault/restore', {
          method: 'POST',
          body: JSON.stringify({ ids: [item.id] }),
        });
        if (res.restored && res.restored.length > 0) {
          toast(`Geri yüklendi: ${item.name}`, 'success');
          const tab = getActiveTab();
          if (tab && tab.path !== 'PC' && tab.path !== 'TRASH') {
            navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
          }
        }
        await refreshVaultItemsInModal();
        await refreshVaultSettingsUI();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    row.querySelector('.vault-purge-btn').onclick = async () => {
      const ok = await showPromptModal({
        title: 'Kasadan Kalıcı Sil',
        desc: `"${item.name}" öğesi koruma kasasından da KALICI olarak silinecek. Emin misiniz?`,
        okText: 'Evet, Yok Et',
      });
      if (!ok) return;
      try {
        await api('/api/vault/purge', {
          method: 'POST',
          body: JSON.stringify({ ids: [item.id] }),
        });
        toast(`Kasadan kalıcı olarak silindi: ${item.name}`);
        await refreshVaultItemsInModal();
        await refreshVaultSettingsUI();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    listEl.appendChild(row);
  }
}

async function refreshVaultItemsInModal() {
  const data = await api('/api/vault/items');
  renderVaultModalItems(data.items || [], data.totalBytes || 0);
}

async function openVaultModal() {
  const dlg = $('vault-dialog');
  if (!dlg) return;
  if (!dlg.open) dlg.showModal();
  const listEl = $('vault-items-list');
  if (listEl) listEl.innerHTML = '<div class="muted-text" style="padding:14px;">Kasa yükleniyor...</div>';
  try {
    await refreshVaultItemsInModal();
  } catch (err) {
    if (listEl) listEl.innerHTML = `<div class="muted-text" style="padding:14px;">Hata: ${esc(err.message)}</div>`;
  }
}

function bindVaultHandlers() {
  const addBtn = $('btn-vault-add-path');
  if (addBtn) {
    addBtn.onclick = async () => {
      try {
        const pickedPath = await openFolderPickerModal({
          title: 'Korunan Klasör Ekle',
          subtitle: 'Bu klasör (ve alt klasörleri) için kalıcı silme gizlice 30 gün saklanır',
          initialDir: currentProtectedPaths[0] || '',
        });
        if (!pickedPath) return;
        const next = [...currentProtectedPaths, pickedPath];
        const res = await api('/api/vault/config', {
          method: 'POST',
          body: JSON.stringify({ protectedPaths: next }),
        });
        renderProtectedPathsList(res.protectedPaths, res.itemCount);
        toast(`Koruma kasasına eklendi: ${pickedPath}`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  const openBtn = $('btn-open-vault-modal');
  if (openBtn) openBtn.onclick = () => openVaultModal();

  const closeBtn = $('btn-vault-close');
  const doneBtn = $('btn-vault-done');
  const dlg = $('vault-dialog');
  if (closeBtn && dlg) closeBtn.onclick = () => dlg.close();
  if (doneBtn && dlg) doneBtn.onclick = () => dlg.close();

  const restoreAllBtn = $('btn-vault-restore-all');
  if (restoreAllBtn) {
    restoreAllBtn.onclick = async () => {
      try {
        const data = await api('/api/vault/items');
        const allIds = (data.items || []).map((x) => x.id);
        if (allIds.length === 0) return;
        const res = await api('/api/vault/restore', {
          method: 'POST',
          body: JSON.stringify({ ids: allIds }),
        });
        toast(`${(res.restored || []).length} öğe orijinal yerine geri yüklendi`, 'success');
        const tab = getActiveTab();
        if (tab && tab.path !== 'PC' && tab.path !== 'TRASH') {
          navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
        }
        await refreshVaultItemsInModal();
        await refreshVaultSettingsUI();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }

  const purgeAllBtn = $('btn-vault-purge-all');
  if (purgeAllBtn) {
    purgeAllBtn.onclick = async () => {
      const ok = await showPromptModal({
        title: 'Koruma Kasasını Boşalt',
        desc: 'Kasadaki TÜM gizli yedekler kalıcı olarak silinecek ve bir daha kurtarılamayacak. Emin misiniz?',
        okText: 'Tümünü Yok Et',
      });
      if (!ok) return;
      try {
        const res = await api('/api/vault/purge', {
          method: 'POST',
          body: JSON.stringify({ all: true }),
        });
        toast(`Kasa boşaltıldı (${res.deleted || 0} öğe kalıcı silindi)`);
        await refreshVaultItemsInModal();
        await refreshVaultSettingsUI();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
}

export {
  bindVaultHandlers,
  openVaultModal,
  refreshVaultSettingsUI,
};
