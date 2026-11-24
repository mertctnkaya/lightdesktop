import { api } from './services/apiClient.js';
import { state } from './store/appState.js';
import { createTab, getActiveTab, navigateTo, updateTrashBadge, updateUndoButton } from './components/navigation/tabsAndRouter.js';
import { $ } from './utils/dom.js';
import { renderSidebarAndDashboard } from './components/sidebar/treeAndDashboard.js';
import { renderBasket } from './components/operations/basketAndDualPane.js';
import { toast } from './components/shared/toast.js';
import { loadUiPrefs, restoreWindowBounds, setupWindowBoundsPersistence } from './services/preferencesService.js';
import { bindEvents } from './events/bindEvents.js';
import { bindCommandPaletteHandlers } from './components/palette/commandPalette.js';
import { bindDragShelfHandlers } from './components/sidebar/dragShelf.js';
import { setupMarqueeSelection } from './components/scroller/selectionAndMarquee.js';
import { setupDragAndDrop } from './components/operations/dragAndDropEngine.js';
import { setupHoverVideoStoryboard } from './components/scroller/thumbLoaderAndStoryboard.js';
import { setupViewportResizeObserver } from './components/scroller/virtualScroller.js';
import { pollIndexStatus } from './components/analyzer/analyzerAndDuplicates.js';
import { pollTransferStatus } from './components/operations/processAndErrorCenter.js';
import { openWelcomeSetupDialog } from './components/settings/settingsAndWelcome.js';
import { bindActivityLogHandlers, refreshActivitySettingsUI } from './components/settings/activityLogModal.js';

const UI_BOOT_MARKS = [{ stage: 'main.js modul yuklendi', epochMs: Date.now() }];
let uiProfileFlushed = false;

window.__ldMarkStartup = (stage, detail = '') => {
  if (uiProfileFlushed) return;
  UI_BOOT_MARKS.push({ stage, detail, epochMs: Date.now() });
};

window.__ldFlushStartupProfile = () => {
  if (uiProfileFlushed) return;
  uiProfileFlushed = true;
  fetch('/api/startup-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks: UI_BOOT_MARKS }),
  }).catch(() => {});
};

// ---------- Başlangıç ----------
async function hydrateInitData(openInitialTab = false) {
  const urlOpenPath = new URLSearchParams(window.location.search).get('openPath');
  try {
    const data = await api('/api/init', { timeoutMs: 8000, silentErrors: openInitialTab });
    if (openInitialTab && window.__ldMarkStartup) {
      window.__ldMarkStartup('/api/init cevabi geldi');
    }
    state.drives = data.drives || [];
    state.quickAccess = data.quickAccess || [];
    state.pins = data.pins || [];
    if (data.undoSummary) updateUndoButton(data.undoSummary);
    if (typeof data.trashCount === 'number') updateTrashBadge(data.trashCount);
    $('cache-badge').title = `SSD Önbellek: ${data.indexStats?.cacheRoot || ''}`;
    renderSidebarAndDashboard();
    renderBasket();
    if (openInitialTab) {
      let startTarget = urlOpenPath || '';
      if (!startTarget) {
        if (state.settings.startupMode === 'last') {
          try { startTarget = localStorage.getItem('ld_last_folder') || 'PC'; } catch { startTarget = 'PC'; }
        } else if (state.settings.startupMode === 'custom' && state.settings.startupPath) {
          startTarget = state.settings.startupPath;
        } else {
          startTarget = 'PC';
        }
      }
      createTab(startTarget || 'PC', true);
      api('/api/init?refresh=1', { timeoutMs: 6000, silentErrors: true }).then((fresh) => {
        if (!fresh || !Array.isArray(fresh.drives) || fresh.drives.length === 0) return;
        const oldSig = state.drives.map((d) => `${d.id}:${d.label}`).join('|');
        const newSig = fresh.drives.map((d) => `${d.id}:${d.label}`).join('|');
        if (oldSig !== newSig) {
          state.drives = fresh.drives;
          renderSidebarAndDashboard();
        }
      }).catch(() => {});
    }
    return true;
  } catch (err) {
    if (openInitialTab) {
      renderSidebarAndDashboard();
      renderBasket();
      createTab(urlOpenPath || 'PC', true);
      toast(`Başlatma uyarısı: ${err.message} (yeniden bağlanılıyor)`, 'error');
    }
    return false;
  }
}


async function init() {
  if (window.__ldMarkStartup) window.__ldMarkStartup('init() basladi');
  try { loadUiPrefs(); } catch {}
  try { bindEvents(); } catch {}
  try { bindCommandPaletteHandlers(); } catch {}
  try { bindDragShelfHandlers(); } catch {}
  try { setupMarqueeSelection(); } catch {}
  try { setupDragAndDrop(); } catch {}
  try { setupHoverVideoStoryboard(); } catch {}
  try { setupViewportResizeObserver(); } catch {}
  try { bindActivityLogHandlers(); } catch {}
  if (!(window.chrome && window.chrome.webview)) {
    await restoreWindowBounds();
    if (window.__ldMarkStartup) window.__ldMarkStartup('restoreWindowBounds() bitti');
  }
  try { setupWindowBoundsPersistence(); } catch {}

  const ok = await hydrateInitData(true);
  pollIndexStatus();
  pollTransferStatus();

  if (ok) {
    setTimeout(() => { openWelcomeSetupDialog(false); }, 450);
    setTimeout(() => { refreshActivitySettingsUI(); }, 950);
  }

  if (!ok) {
    const retryTimer = setInterval(async () => {
      const recovered = await hydrateInitData(false);
      if (recovered) {
        clearInterval(retryTimer);
        const tab = getActiveTab();
        if (tab && tab.path !== 'PC') navigateTo(tab.path, { pushHistory: false });
      }
    }, 2000);
  }
}

init();


export {
  hydrateInitData,
};
