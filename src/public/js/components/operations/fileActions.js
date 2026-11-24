import { state } from '../../store/appState.js';
import { recordRecentFile } from '../../services/preferencesService.js';
import { $ } from '../../utils/dom.js';
import { toast } from '../shared/toast.js';
import { api } from '../../services/apiClient.js';
import { getActiveTab, navigateTo, updateTrashBadge, updateUndoButton } from '../navigation/tabsAndRouter.js';
import { showPromptModal } from '../shared/promptModal.js';
import { getSelectedItems, updateDualSelectionDomInPlace, updateStatusCounts, updateToolbarButtons } from '../scroller/selectionAndMarquee.js';
import { navigateDual, renderBasket } from './basketAndDualPane.js';
import { openProcessModal } from './processAndErrorCenter.js';
import { releaseQuickLookMedia } from '../quicklook/quicklookViewer.js';
import { renderVirtualList } from '../scroller/virtualScroller.js';
import { recordRecentTransferTarget } from '../sidebar/treeAndDashboard.js';

// ---------- Dosya İşlemleri & Sıralı Transfer ----------
async function openExternally(filePath) {
  try {
    const matched = state.viewItems.find((x) => x.path === filePath) || state.dualItems.find((x) => x.path === filePath);
    recordRecentFile(matched || filePath);
    const fileName = String(filePath || '').split(/[/\\]/).pop() || filePath;
    if (/\.(bat|cmd|ps1|exe|msi)$/i.test(fileName)) {
      toast(`🚀 Çalıştırılıyor: ${fileName}`);
    }
    if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
      window.chrome.webview.postMessage({ type: 'openExternal', path: filePath });
      return;
    }
    await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'open', path: filePath }) });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function createNewFolder() {
  const tab = getActiveTab();
  if (!tab || tab.path === 'PC') return;
  const res = await showPromptModal({
    title: 'Yeni Klasör Oluştur',
    fields: [{ name: 'name', label: 'Klasör Adı', value: 'Yeni Klasör' }],
    okText: 'Oluştur',
  });
  if (!res || !res.name.trim()) return;
  try {
    const actRes = await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'mkdir', parentDir: tab.path, name: res.name.trim() }) });
    if (actRes.undoSummary) updateUndoButton(actRes.undoSummary);
    navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameSelected(overrideItems = null) {
  const sel = overrideItems || getSelectedItems();
  if (sel.length === 0) return;
  if (sel.length > 1) return batchRenameSelected(sel);

  const item = sel[0];
  const res = await showPromptModal({
    title: 'Yeniden Adlandır',
    fields: [{ name: 'newName', label: 'Yeni Ad', value: item.name }],
    okText: 'Kaydet',
  });
  if (!res || !res.newName.trim() || res.newName.trim() === item.name) return;
  try {
    const actRes = await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'rename', path: item.path, newName: res.newName.trim() }) });
    if (actRes.undoSummary) updateUndoButton(actRes.undoSummary);
    navigateTo(getActiveTab().path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    if (state.dualOpen && state.dualPath) navigateDual(state.dualPath, false);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function batchRenameSelected(items) {
  const res = await showPromptModal({
    title: `Toplu Yeniden Adlandır (${items.length} öğe)`,
    desc: 'Kullanılabilir yer tutucular: {name} (orijinal ad), {n} (sıra no), {date} (tarih)',
    fields: [
      { name: 'pattern', label: 'İsim Şablonu', value: '{name}_{n}' },
      { name: 'startNum', label: 'Başlangıç Numarası', type: 'number', value: '1' },
    ],
    okText: 'Uygula',
  });
  if (!res || !res.pattern.trim()) return null;
  try {
    const act = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'batchRename',
        paths: items.map((x) => x.path),
        pattern: res.pattern.trim(),
        startNum: Number(res.startNum) || 1,
      }),
    });
    openProcessModal(act.jobId);
    return act;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function deleteSelected(permanent = false, overridePaths = null, extraOpts = {}) {
  const tab = getActiveTab();
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return null;

  if (tab && tab.path === 'TRASH' && !overridePaths) {
    return deleteFromTrash(paths);
  }

  // Normal çöpe atma (1-200 öğe) anında iyimser UI + arka planda sıcak işçiyle yapılır (Ctrl+Z ile geri alınabilir)
  const fastRecycle = !permanent && extraOpts.originTag !== 'dupes' && paths.length <= 200;
  const cmode = state.settings.trashConfirmMode || 'bulk';
  const needsConfirm = permanent || extraOpts.originTag === 'dupes'
    || (cmode === 'always')
    || (cmode === 'bulk' && paths.length > 50);
  if (needsConfirm) {
    const confirmRes = await showPromptModal({
      title: permanent ? 'Kalıcı Olarak Sil' : "Geri Dönüşüm Kutusu'na Taşı",
      desc: `${paths.length} öğe ${permanent ? 'KALICI OLARAK silinecek! Bu işlem geri alınamaz.' : "Çöp Kutusu'na gönderilecek (kalıcı silinmez)."}`,
      okText: permanent ? 'Kalıcı Sil' : 'Çöpe At',
    });
    if (!confirmRes) return null;
  }

  if (fastRecycle) {
    const pathSet = new Set(paths);
    if ($('quicklook-dialog').open) releaseQuickLookMedia();
    state.rawItems = state.rawItems.filter((x) => !pathSet.has(x.path));
    state.viewItems = state.viewItems.filter((x) => !pathSet.has(x.path));
    for (const p of paths) {
      state.selectedPaths.delete(p);
      state.basket.delete(p);
    }
    renderBasket();
    renderVirtualList();
    updateStatusCounts();
    updateToolbarButtons();
    window.dispatchEvent(new CustomEvent('ld:paths-deleted', { detail: { paths } }));

    toast(`${paths.length} öğe çöpe taşınıyor...`, 'success');
    api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        paths,
        permanent: false,
        immediate: true,
      }),
    }).then((res) => {
      if (res.undoSummary) updateUndoButton(res.undoSummary);
      if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    }).catch((err) => {
      toast(`Çöpe taşınamadı: ${err.message}`, 'error');
      const curTab = getActiveTab();
      if (curTab && curTab.path !== 'PC' && curTab.path !== 'TRASH') {
        navigateTo(curTab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
      }
    });
    return { ok: true, optimistic: true };
  }

  try {
    const res = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        paths,
        permanent,
        originTag: extraOpts.originTag || '',
      }),
    });
    openProcessModal(res.jobId);
    return res;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function restoreFromTrash(overridePaths = null) {
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return;
  try {
    const res = await api('/api/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    });
    if (res.undoSummary) updateUndoButton(res.undoSummary);
    if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    const okCount = (res.restored || []).length;
    if (okCount > 0) toast(`${okCount} öğe özgün konumuna geri yüklendi`, 'success');
    if (res.errors && res.errors.length > 0) toast(res.errors[0].message, 'error');
    const tab = getActiveTab();
    if (tab && tab.path === 'TRASH') {
      navigateTo('TRASH', { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteFromTrash(overridePaths = null) {
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return null;
  const confirmRes = await showPromptModal({
    title: 'Çöp Kutusundan Kalıcı Olarak Sil',
    desc: `${paths.length} öğe Çöp Kutusu'ndan KALICI OLARAK silinecek! Bu işlem geri alınamaz.`,
    okText: 'Kalıcı Sil',
  });
  if (!confirmRes) return null;
  try {
    const res = await api('/api/trash/delete', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    });
    if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    toast(`${res.deleted || 0} öğe kalıcı olarak silindi`, 'success');
    const tab = getActiveTab();
    if (tab && tab.path === 'TRASH') {
      navigateTo('TRASH', { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
    return res;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

async function emptyTrash() {
  if (state.rawItems.length === 0) return toast('Çöp kutusu zaten boş');
  const confirmRes = await showPromptModal({
    title: 'Çöp Kutusunu Boşalt',
    desc: `Çöp Kutusu'ndaki tüm (${state.rawItems.length}) öğe KALICI OLARAK silinecek! Bu işlem geri alınamaz.`,
    okText: 'Tümünü Kalıcı Sil',
  });
  if (!confirmRes) return;
  try {
    const res = await api('/api/trash/empty', { method: 'POST', body: '{}' });
    updateTrashBadge(0);
    toast(`${res.deleted || 0} öğe kalıcı silindi, çöp kutusu boşaltıldı`, 'success');
    const tab = getActiveTab();
    if (tab && tab.path === 'TRASH') {
      navigateTo('TRASH', { pushHistory: false, forceRefresh: true });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

let undoInFlight = false;
async function performUndo() {
  if (undoInFlight) return;
  undoInFlight = true;
  try {
    const res = await api('/api/undo', { method: 'POST', body: '{}' });
    if (res.undoSummary) updateUndoButton(res.undoSummary);
    if (typeof res.trashCount === 'number') updateTrashBadge(res.trashCount);
    if (res.empty) {
      toast('Geri alınacak işlem yok');
      return;
    }
    if (res.undoneCount > 0) {
      toast(`Geri alındı: ${res.label}`, 'success');
    } else if (res.errors && res.errors.length > 0) {
      toast(`Geri alınamadı: ${res.errors[0].message}`, 'error');
    }

    const tab = getActiveTab();
    if (tab && tab.path !== 'PC' && $('analyzer-view').classList.contains('hidden')) {
      navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
    if (state.dualOpen && state.dualPath) navigateDual(state.dualPath, false);
  } catch (err) {
    toast(`Geri alma hatası: ${err.message}`, 'error');
  } finally {
    undoInFlight = false;
  }
}


function setClipboard(op, overridePaths = null) {
  const paths = overridePaths || Array.from(state.selectedPaths);
  if (paths.length === 0) return;
  state.clipboard = { op, paths };
  updateToolbarButtons();
  renderVirtualList();
  updateDualSelectionDomInPlace();
  api('/api/clipboard/os', {
    method: 'POST',
    body: JSON.stringify({ op, paths }),
    silentErrors: true,
  }).catch(() => {});
  toast(`${paths.length} öğe ${op === 'cut' ? 'kesildi' : 'kopyalandı'}`);
}

async function pasteToCurrentFolder(overrideDestDir = null) {
  const targetDir = overrideDestDir || getActiveTab()?.path;
  if (!targetDir || targetDir === 'PC' || targetDir === 'TRASH') return;
  if (state.clipboard.paths.length > 0) {
    await enqueueTransfer(state.clipboard.op, state.clipboard.paths, targetDir);
    if (state.clipboard.op === 'cut') {
      state.clipboard = { op: null, paths: [] };
      updateToolbarButtons();
      updateDualSelectionDomInPlace();
    }
    return;
  }
  try {
    const osClip = await api('/api/clipboard/os', { silentErrors: true });
    if (osClip && Array.isArray(osClip.paths) && osClip.paths.length > 0) {
      await enqueueTransfer(osClip.op || 'copy', osClip.paths, targetDir);
      return;
    }
  } catch {}
  toast('Panoda yapıştırılacak dosya yok', 'info');
}

async function enqueueTransfer(op, sources, destDir) {
  try {
    if ((op === 'move' || op === 'copy') && destDir) {
      recordRecentTransferTarget(destDir);
    }
    const res = await api('/api/transfer/enqueue', {
      method: 'POST',
      body: JSON.stringify({ op, sources, destDir, conflict: 'rename' }),
    });
    if (op === 'move' && Array.isArray(sources)) {
      let removedFromBasket = false;
      for (const p of sources) {
        if (state.basket.delete(p)) removedFromBasket = true;
      }
      if (removedFromBasket) renderBasket();
    }
    openProcessModal(res.job?.id || null);
  } catch (err) {
    toast(err.message, 'error');
  }
}


export {
  batchRenameSelected,
  createNewFolder,
  deleteFromTrash,
  deleteSelected,
  emptyTrash,
  enqueueTransfer,
  openExternally,
  pasteToCurrentFolder,
  performUndo,
  renameSelected,
  restoreFromTrash,
  setClipboard,
};
