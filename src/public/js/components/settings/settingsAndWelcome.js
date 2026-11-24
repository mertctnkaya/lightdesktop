import { state } from '../../store/appState.js';
import { $, esc } from '../../utils/dom.js';
import { applyAppSettings } from '../../services/preferencesService.js';
import { formatBytes } from '../../utils/formatters.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { refreshVaultSettingsUI } from './protectedVaultModal.js';

function syncSettingsForm() {
  const s = state.settings;
  const setVal = (id, v, isCheck = false) => {
    const el = $(id);
    if (!el) return;
    if (isCheck) el.checked = Boolean(v);
    else el.value = String(v ?? '');
  };
  setVal('set-font-size', s.fontSize || 13);
  setVal('set-default-view', s.defaultViewMode || 'last');
  setVal('set-remember-folder-view', s.rememberFolderView !== false, true);
  setVal('set-folders-first', s.foldersFirst !== false, true);
  setVal('set-show-ext', s.showExtensions !== false, true);
  setVal('set-compact-sidebar', s.compactSidebar, true);
  setVal('set-startup-mode', s.startupMode || 'pc');
  setVal('set-startup-path', s.startupPath || '');
  const customRow = $('set-startup-custom-row');
  if (customRow) customRow.classList.toggle('hidden', (s.startupMode || 'pc') !== 'custom');
  setVal('set-click-mode', s.clickMode || 'double');
  setVal('set-trash-confirm', s.trashConfirmMode || 'bulk');
  setVal('set-auto-close-proc', s.autoCloseProcessModal, true);
  setVal('set-default-thumb', s.defaultThumbMode || 'off');
  setVal('set-dblclick-quicklook', s.dblClickQuickLook !== false, true);
  setVal('set-frame-save-mode', s.frameSaveMode || 'same');
  setVal('set-frame-save-dir', s.frameSaveDir || '');
  const frameRow = $('set-frame-save-custom-row');
  if (frameRow) frameRow.classList.toggle('hidden', (s.frameSaveMode || 'same') !== 'custom');
  setVal('set-trim-save-mode', s.trimSaveMode || 'same');
  setVal('set-trim-save-dir', s.trimSaveDir || '');
  const trimRow = $('set-trim-save-custom-row');
  if (trimRow) trimRow.classList.toggle('hidden', (s.trimSaveMode || 'same') !== 'custom');
  setVal('set-video-autoplay', s.videoAutoplay !== false, true);
  setVal('set-video-loop', s.videoLoop, true);
  applyAppSettings();
}

function refreshSettingsCacheStats(statsObj = null) {
  const box = $('settings-cache-stats');
  if (!box) return;
  const savedViewsCount = Object.keys(state.folderViews || {}).length;
  const renderStats = (st) => {
    if (!st) return;
    box.innerHTML = `
      <div><strong>SSD Önbellek:</strong> ${esc(st.cacheRoot || 'AppData\\Local\\LightDesktopCache')}</div>
      <div><strong>İndeksli Öğe:</strong> ${(st.totalEntries || 0).toLocaleString('tr-TR')} • <strong>Kayıtlı Kapak:</strong> ${(st.cachedThumbCount || 0).toLocaleString('tr-TR')} (${formatBytes(st.cachedThumbBytes || 0)}) • <strong>Klasör Görünümü:</strong> ${savedViewsCount}</div>
    `;
  };
  if (statsObj) {
    renderStats(statsObj);
    return;
  }
  api('/api/index/status', { silentErrors: true }).then(renderStats).catch(() => {});
}

function renderIntegrationStatus(st) {
  if (!st) return;
  const banner = $('int-status-banner');
  const chkDef = $('set-int-default-explorer');
  const chkAuto = $('set-int-autostart');
  const btnRestore = $('btn-int-restore-explorer');
  const btnFixed = $('btn-int-install-fixed');

  if (chkDef) chkDef.checked = Boolean(st.isDefaultExplorer);
  if (btnRestore) btnRestore.classList.toggle('hidden', !st.isDefaultExplorer);
  if (chkAuto) chkAuto.checked = Boolean(st.autoStartEnabled);
  if (btnFixed) {
    btnFixed.classList.toggle('hidden', !st.isPortable || Boolean(st.isRunningFromFixed) || Boolean(st.hasFixedExe));
  }
  if (banner) {
    const modeText = st.isPortable
      ? (st.isRunningFromFixed ? 'Sabit Konumlu Portable EXE' : 'Taşınabilir EXE')
      : 'Geliştirme / Klasör Modu';
    const trayHintHtml = st.isDefaultExplorer
      ? `<div class="muted-text" style="margin-top:4px;">💡 İpucu: Klasörlerin anında açılması için alttaki <strong>"Windows Açılışında Arka Planda Hazır Bekle (tray)"</strong> seçeneğini açmanız önerilir.</div>`
      : '';
    banner.innerHTML = `
      <div><strong>Çalışma Modu:</strong> ${esc(modeText)} • <strong>Hedef:</strong> <code>${esc(st.targetPath || '')}</code></div>
      <div>
        <strong>Kısayollar:</strong> ${st.hasDesktopShortcut ? '✓ Masaüstü' : '— Masaüstü'} / ${st.hasStartMenuShortcut ? '✓ Başlat (Ctrl+Alt+E)' : '— Başlat'} •
        <strong>Sağ Tık:</strong> ${st.hasContextMenu ? '✓ Aktif' : '— Kapalı'} •
        <strong>Varsayılan Gezgin:</strong> ${st.isDefaultExplorer ? '✓ LightDesktop' : 'Windows Gezgini'}
      </div>
      ${trayHintHtml}
    `;
  }
}

async function refreshIntegrationStatus() {
  try {
    const st = await api('/api/system/integration', { silentErrors: true });
    renderIntegrationStatus(st);
    return st;
  } catch {
    return null;
  }
}

function bindIntegrationAndWelcomeHandlers() {
  const chkDef = $('set-int-default-explorer');
  const btnRestore = $('btn-int-restore-explorer');
  const chkAuto = $('set-int-autostart');
  const btnShortcuts = $('btn-int-shortcuts');
  const btnFixed = $('btn-int-install-fixed');
  const btnWelcome = $('btn-int-open-welcome');

  if (chkDef) {
    chkDef.onchange = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'setDefaultExplorer', enabled: chkDef.checked }),
        });
        renderIntegrationStatus(res.status);
        toast(chkDef.checked ? 'LightDesktop varsayılan klasör gezgini yapıldı!' : 'Windows Gezgini varsayılana döndürüldü.', 'success');
      } catch (err) {
        chkDef.checked = !chkDef.checked;
        toast(err.message, 'error');
      }
    };
  }
  if (btnRestore) {
    btnRestore.onclick = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'setDefaultExplorer', enabled: false }),
        });
        renderIntegrationStatus(res.status);
        toast('Windows Gezgini varsayılana geri döndürüldü.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  if (chkAuto) {
    chkAuto.onchange = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'setAutoStart', enabled: chkAuto.checked }),
        });
        renderIntegrationStatus(res.status);
        toast(chkAuto.checked ? 'Windows açılışında arka planda hazır bekleyecek.' : 'Otomatik başlatma kapatıldı.', 'success');
      } catch (err) {
        chkAuto.checked = !chkAuto.checked;
        toast(err.message, 'error');
      }
    };
  }
  if (btnShortcuts) {
    btnShortcuts.onclick = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'installShortcuts' }),
        });
        renderIntegrationStatus(res.status);
        toast('Masaüstü, Başlat Menüsü (Ctrl+Alt+E) ve Sağ Tık menüsü kuruldu!', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  if (btnFixed) {
    btnFixed.onclick = async () => {
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({ action: 'installFixedApp' }),
        });
        renderIntegrationStatus(res.status);
        toast('Uygulama sabit konuma kuruldu (%LOCALAPPDATA%\\LightDesktop)!', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  if (btnWelcome) {
    btnWelcome.onclick = () => {
      const sd = $('settings-dialog');
      if (sd && sd.open) sd.close();
      openWelcomeSetupDialog(true);
    };
  }

  const wDlg = $('welcome-setup-dialog');
  const markDone = () => {
    try { localStorage.setItem('ld_welcome_done', '1'); } catch {}
  };
  if ($('btn-wel-close')) {
    $('btn-wel-close').onclick = () => { markDone(); wDlg.close(); };
  }
  if ($('btn-wel-skip')) {
    $('btn-wel-skip').onclick = () => { markDone(); wDlg.close(); };
  }
  if (wDlg) {
    wDlg.addEventListener('cancel', markDone);
  }
  if ($('btn-wel-apply')) {
    $('btn-wel-apply').onclick = async () => {
      const btn = $('btn-wel-apply');
      btn.disabled = true;
      try {
        const res = await api('/api/system/integration', {
          method: 'POST',
          body: JSON.stringify({
            action: 'applyBundle',
            installFixed: Boolean($('wel-fixed')?.checked && !$('wel-fixed-row')?.classList.contains('hidden')),
            shortcuts: Boolean($('wel-shortcuts')?.checked),
            contextMenu: Boolean($('wel-shortcuts')?.checked),
            defaultExplorer: Boolean($('wel-default-explorer')?.checked),
            autoStart: Boolean($('wel-autostart')?.checked),
          }),
        });
        markDone();
        renderIntegrationStatus(res.status);
        wDlg.close();
        toast('Hızlı kurulum uygulandı! Artık Ctrl+Alt+E veya Başlat Menüsü ile açabilirsiniz.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };
  }
}

async function openWelcomeSetupDialog(forceOpen = false) {
  const dlg = $('welcome-setup-dialog');
  if (!dlg) return;
  try {
    if (!forceOpen && localStorage.getItem('ld_welcome_done') === '1') return;
  } catch {}
  const st = await refreshIntegrationStatus();
  if (st) {
    const fixedRow = $('wel-fixed-row');
    if (fixedRow) {
      fixedRow.classList.toggle('hidden', !st.isPortable || Boolean(st.isRunningFromFixed) || Boolean(st.hasFixedExe));
    }
    if ($('wel-default-explorer')) $('wel-default-explorer').checked = Boolean(st.isDefaultExplorer);
    if ($('wel-autostart')) $('wel-autostart').checked = Boolean(st.autoStartEnabled);
  }
  if (!dlg.open) dlg.showModal();
}

function openSettingsDialog() {
  syncSettingsForm();
  refreshSettingsCacheStats();
  refreshIntegrationStatus();
  refreshVaultSettingsUI();
  const dlg = $('settings-dialog');
  if (dlg && !dlg.open) dlg.showModal();
}


export {
  bindIntegrationAndWelcomeHandlers,
  openSettingsDialog,
  openWelcomeSetupDialog,
  refreshSettingsCacheStats,
  syncSettingsForm,
};
