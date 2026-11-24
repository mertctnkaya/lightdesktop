import { api } from '../../services/apiClient.js';
import { state } from '../../store/appState.js';
import { toast } from '../shared/toast.js';
import { showPromptModal } from '../shared/promptModal.js';
import { openFolderPickerModal } from '../shared/folderPickerModal.js';
import { getActiveTab, navigateTo } from '../navigation/tabsAndRouter.js';
import { navigateDual } from './basketAndDualPane.js';

function defaultShortcutName(item) {
  const raw = String(item?.name || '').trim();
  if (!raw) return 'Kısayol';
  if (item.isDir) return `${raw} - Kısayol`;
  const dot = raw.lastIndexOf('.');
  const base = dot > 0 ? raw.slice(0, dot) : raw;
  return `${base} - Kısayol`;
}

function refreshViewsIfMatching(destDir) {
  const normDest = String(destDir || '').replace(/[\\/]+$/, '').toLowerCase();
  if (!normDest) return;
  const tab = getActiveTab();
  if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
    if (tab.path.replace(/[\\/]+$/, '').toLowerCase() === normDest) {
      navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
    }
  }
  if (state.dualPane && state.dualPath && state.dualPath.replace(/[\\/]+$/, '').toLowerCase() === normDest) {
    navigateDual(state.dualPath, false);
  }
}

async function createShortcutsInDir(items, destDir) {
  const list = Array.isArray(items) ? items.filter((it) => it && it.path) : [];
  if (list.length === 0) return;
  const targetDir = String(destDir || '').trim();
  if (!targetDir || targetDir === 'PC' || targetDir === 'TRASH') {
    toast('Kısayol oluşturulacak geçerli bir klasör seçin', 'error');
    return;
  }

  let shortcutNameOverride = '';
  if (list.length === 1 && targetDir.toUpperCase() !== 'DESKTOP') {
    const defName = defaultShortcutName(list[0]);
    const res = await showPromptModal({
      title: '🔗 Kısayol Oluştur (.lnk)',
      desc: `Hedef: ${list[0].path}`,
      okText: '🔗 Oluştur',
      fields: [
        { name: 'name', label: 'Kısayol Adı (.lnk)', value: defName },
      ],
    });
    if (!res) return;
    shortcutNameOverride = (res.name || '').trim();
  }

  try {
    const res = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'createShortcut',
        destDir: targetDir,
        items: list.map((it, idx) => ({
          targetPath: it.path,
          name: idx === 0 && shortcutNameOverride ? shortcutNameOverride : defaultShortcutName(it),
        })),
      }),
    });
    const created = res.created || [];
    if (targetDir.toUpperCase() === 'DESKTOP') {
      toast(`🖥️ Masaüstüne ${created.length || list.length} kısayol oluşturuldu`, 'success');
    } else {
      toast(`🔗 ${created.length || list.length} kısayol oluşturuldu`, 'success');
    }
    refreshViewsIfMatching(res.destDir || targetDir);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function createShortcutsToPicker(items) {
  const list = Array.isArray(items) ? items.filter((it) => it && it.path) : [];
  if (list.length === 0) return;
  const picked = await openFolderPickerModal({
    title: 'Kısayolun Oluşturulacağı Klasörü Seç',
    initialPath: getActiveTab()?.path || 'PC',
  });
  if (!picked) return;
  await createShortcutsInDir(list, picked);
}

async function createCustomShortcutInDir(destDir) {
  const targetDir = String(destDir || '').trim();
  if (!targetDir || targetDir === 'PC' || targetDir === 'TRASH') return;

  const res = await showPromptModal({
    title: '🔗 Yeni Windows Kısayolu (.lnk)',
    desc: `Kısayol "${targetDir}" klasörüne kaydedilecek.`,
    okText: '🔗 Kısayolu Oluştur',
    fields: [
      { name: 'targetPath', label: 'Hedef Dosya, Klasör veya Program Yolu', placeholder: 'Örn. C:\\Windows\\notepad.exe veya D:\\Projeler' },
      { name: 'name', label: 'Kısayol Adı (boş bırakılırsa hedeften türetilir)', placeholder: 'Örn. Not Defteri' },
      { name: 'args', label: 'Başlatma Parametreleri (isteğe bağlı)', placeholder: 'Örn. --minimized' },
    ],
  });
  if (!res || !res.targetPath) return;

  try {
    const apiRes = await api('/api/fs/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'createShortcut',
        destDir: targetDir,
        items: [{
          targetPath: res.targetPath.trim(),
          name: (res.name || '').trim(),
          args: (res.args || '').trim(),
        }],
      }),
    });
    const first = apiRes.created?.[0];
    toast(`🔗 Kısayol oluşturuldu: ${first?.name || 'Kısayol.lnk'}`, 'success');
    refreshViewsIfMatching(apiRes.destDir || targetDir);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export {
  createCustomShortcutInDir,
  createShortcutsInDir,
  createShortcutsToPicker,
};
