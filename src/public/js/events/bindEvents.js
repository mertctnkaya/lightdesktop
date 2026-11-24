import { activateItem, closeTab, createTab, getActiveTab, getFolderTitle, navigateTo, shouldOpenInQuickLook } from '../components/navigation/tabsAndRouter.js';
import { $, esc } from '../utils/dom.js';
import { DEFAULT_APP_SETTINGS, state } from '../store/appState.js';
import { applyAppSettings, removeRecentEntry, saveAppSettings, saveDashHistory, saveUiPrefs } from '../services/preferencesService.js';
import { applyDashSectionVisibility, renderRecentDashboardSections, renderRecentTransferTargets } from '../components/sidebar/treeAndDashboard.js';
import { toast } from '../components/shared/toast.js';
import { batchRenameSelected, createNewFolder, deleteFromTrash, deleteSelected, emptyTrash, enqueueTransfer, openExternally, pasteToCurrentFolder, performUndo, renameSelected, restoreFromTrash, setClipboard } from '../components/operations/fileActions.js';
import { applySortAndFilter, applyViewModeForFolder, closeColFilterPopover, getMatchedStudioItems, normalizeFolderKey, openColFilterPopover, resetColumnWidths, saveFolderViews, setupListColumnResizers, updateStudioMatchPreview } from '../components/scroller/columnHeadersAndStudio.js';
import { calculateCurrentFolderSizes, executeGlobalSearch, findAndRenderDuplicates, openAnalyzer, pollIndexStatus, startBackgroundIndex, togglePin } from '../components/analyzer/analyzerAndDuplicates.js';
import { clearDupSelection, getDupSelectedPaths, openQuickLookForSelectedDup, selectDupPathForContextMenu } from '../components/analyzer/duplicatesPanel.js';
import { organizeCurrentFolderByDate, propsReqSeq, showPropertiesModal } from '../components/operations/propertiesAndOrganize.js';
import { api, localClientErrors, reportClientError } from '../services/apiClient.js';
import { getLayoutMetrics, renderVirtualList, updateSelectionDomInPlace } from '../components/scroller/virtualScroller.js';
import { cancelPendingThumbs, loadSingleThumb, scheduleThumbBatch } from '../components/scroller/thumbLoaderAndStoryboard.js';
import { closeProcessModal, controlTask, copyFullDiagnosticsReport, minimizeProcessModal, openErrorsDialog, openProcessModal, pollTransferStatus, procModalState, refreshErrorsDialog } from '../components/operations/processAndErrorCenter.js';
import { getDualSelectedItems, getSelectedItems, handleDualItemSelect, handleItemSelect, updateDualSelectionDomInPlace, updateStatusCounts, updateToolbarButtons } from '../components/scroller/selectionAndMarquee.js';
import { addItemsToBasket, navigateDual, renderBasket, toggleDualPane, toggleSelectedInBasket, transferBasketTo } from '../components/operations/basketAndDualPane.js';
import { showPromptModal } from '../components/shared/promptModal.js';
import { openFolderPickerModal } from '../components/shared/folderPickerModal.js';
import { closeSmartView, openSmartView, renderSmartViewsSidebar, saveSmartViews } from '../components/sidebar/smartViews.js';
import { bindIntegrationAndWelcomeHandlers, openSettingsDialog, refreshSettingsCacheStats, syncSettingsForm } from '../components/settings/settingsAndWelcome.js';
import { bindVaultHandlers } from '../components/settings/protectedVaultModal.js';
import { bindRelatedHandlers, openRelatedDialog, runRelatedSearch } from '../components/quicklook/relatedFinderModal.js';
import { applyQuickLookTransform, closeQuickLook, openQuickLook, renderQuickLookStage, setQuickLookBrightness, setQuickLookZoom, triageQuickLookBasket, triageQuickLookDelete } from '../components/quicklook/quicklookViewer.js';
import { resolveDragOp } from '../core/transferRulesEngine.js';
import { hydrateInitData } from '../main.js';
import { captureQuickLookFrame, getTrimVideoDuration, runQuickLookTrim, stepQuickLookVideoFrame, toggleQuickLookTrimBar, updateTrimDurationUi, updateTrimPlayheadUi, updateTrimPreviewBtnUi } from '../components/quicklook/quicklookVideoTools.js';
import { saveActiveQuickLookText } from '../components/quicklook/quicklookTextTools.js';
import { compressPathsToZip, extractZipQuickHere, extractZipToPicker, openZipManagerModal } from '../components/operations/zipManagerModal.js';
import { openCommandPalette } from '../components/palette/commandPalette.js';
import { toggleDragShelfVisible } from '../components/sidebar/dragShelf.js';

// ---------- Olay Dinleyicileri & Kısayollar ----------
function bindEvents() {
  // Sekme ve Gezinti
  const sbPc = document.querySelector('.sidebar-item[data-path="PC"]');
  if (sbPc) sbPc.onclick = () => navigateTo('PC');
  const sbTrash = $('sb-trash-btn');
  if (sbTrash) sbTrash.onclick = () => navigateTo('TRASH');
  const toggleSec = (key) => {
    state.dashSections[key] = !state.dashSections[key];
    saveUiPrefs();
    applyDashSectionVisibility();
  };
  const bq = $('btn-toggle-sec-quick');
  if (bq) bq.onclick = () => toggleSec('quick');
  const bf = $('btn-toggle-sec-folders');
  if (bf) bf.onclick = () => toggleSec('folders');
  const bfi = $('btn-toggle-sec-files');
  if (bfi) bfi.onclick = () => toggleSec('files');
  const bcf = $('btn-clear-recent-folders');
  if (bcf) bcf.onclick = () => { state.recentFolders = []; saveDashHistory(); renderRecentDashboardSections(); toast('Son açılan klasörler temizlendi'); };
  const bcfi = $('btn-clear-recent-files');
  if (bcfi) bcfi.onclick = () => { state.recentFiles = []; saveDashHistory(); renderRecentDashboardSections(); toast('Son erişilen dosyalar temizlendi'); };
  const btnRecTargets = $('btn-toggle-recent-targets');
  if (btnRecTargets) {
    btnRecTargets.onclick = () => {
      state.recentTargetsOpen = !state.recentTargetsOpen;
      saveUiPrefs();
      renderRecentTransferTargets();
    };
  }
  const cmdTrash = $('btn-open-trash');
  if (cmdTrash) cmdTrash.onclick = () => navigateTo('TRASH');
  const undoBtn = $('btn-undo');
  if (undoBtn) undoBtn.onclick = () => performUndo();
  const trashRestoreBtn = $('btn-trash-restore');
  if (trashRestoreBtn) trashRestoreBtn.onclick = () => restoreFromTrash();
  const trashPermBtn = $('btn-trash-perm-delete');
  if (trashPermBtn) trashPermBtn.onclick = () => deleteFromTrash();
  const trashEmptyBtn = $('btn-trash-empty');
  if (trashEmptyBtn) trashEmptyBtn.onclick = () => emptyTrash();

  $('btn-new-tab').onclick = () => createTab('PC', true);
  $('btn-back').onclick = () => {
    const tab = getActiveTab();
    if (tab && tab.historyIndex > 0) {
      tab.historyIndex--;
      navigateTo(tab.history[tab.historyIndex], { pushHistory: false, restoreScroll: true });
    }
  };
  $('btn-forward').onclick = () => {
    const tab = getActiveTab();
    if (tab && tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      navigateTo(tab.history[tab.historyIndex], { pushHistory: false, restoreScroll: true });
    }
  };
  $('btn-up').onclick = () => {
    const tab = getActiveTab();
    if (!tab || tab.path === 'PC') return;
    if (tab.path === 'TRASH') return navigateTo('PC');
    const clean = tab.path.replace(/\\+$/, '');
    if (/^[a-zA-Z]:$/.test(clean)) return navigateTo('PC');
    const parent = clean.substring(0, clean.lastIndexOf('\\'));
    navigateTo(/^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent);
  };
  $('btn-refresh').onclick = () => {
    const tab = getActiveTab();
    if (tab) navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true });
  };

  // Adres Çubuğu Düzenleme
  $('address-wrapper').onclick = () => {
    const tab = getActiveTab();
    $('breadcrumbs').classList.add('hidden');
    const inp = $('address-input');
    inp.classList.remove('hidden');
    inp.value = tab && tab.path !== 'PC' ? tab.path : '';
    inp.focus();
    inp.select();
  };
  const closeAddressEdit = () => {
    $('address-input').classList.add('hidden');
    $('breadcrumbs').classList.remove('hidden');
  };
  $('address-input').onblur = closeAddressEdit;
  $('address-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const val = $('address-input').value.trim();
      closeAddressEdit();
      navigateTo(val || 'PC');
    } else if (e.key === 'Escape') {
      closeAddressEdit();
    }
  };

  // Arama
  $('search-input').oninput = () => {
    state.searchQuery = $('search-input').value;
    $('btn-clear-search').classList.toggle('hidden', !state.searchQuery);
    clearTimeout(state.searchTimer);
    if ($('search-scope').value === 'folder') {
      applySortAndFilter();
    } else {
      state.searchTimer = setTimeout(executeGlobalSearch, 180);
    }
  };
  $('search-scope').onchange = () => {
    if ($('search-input').value.trim()) executeGlobalSearch();
  };
  $('btn-clear-search').onclick = () => {
    $('search-input').value = '';
    state.searchQuery = '';
    $('btn-clear-search').classList.add('hidden');
    if ($('search-scope').value === 'folder') applySortAndFilter();
    else {
      const tab = getActiveTab();
      if (tab) navigateTo(tab.path, { pushHistory: false });
    }
  };

  // Komut Çubuğu
  $('btn-mkdir').onclick = createNewFolder;
  $('btn-pin').onclick = () => {
    const tab = getActiveTab();
    if (tab && tab.path !== 'PC') togglePin(tab.path, getFolderTitle(tab.path), false);
  };
  $('btn-cut').onclick = () => setClipboard('cut');
  $('btn-copy').onclick = () => setClipboard('copy');
  $('btn-paste').onclick = pasteToCurrentFolder;
  $('btn-rename').onclick = renameSelected;
  $('btn-delete').onclick = () => deleteSelected(false);
  const propsBtn = $('btn-properties');
  if (propsBtn) propsBtn.onclick = () => showPropertiesModal();
  const propsClose = $('btn-props-close');
  if (propsClose) propsClose.onclick = () => $('properties-dialog').close();
  const propsOk = $('btn-props-ok');
  if (propsOk) propsOk.onclick = () => $('properties-dialog').close();
  const propsDlg = $('properties-dialog');
  if (propsDlg) {
    propsDlg.addEventListener('close', () => {
      propsReqSeq++;
      api('/api/fs/properties/cancel', { method: 'POST', body: '{}', silentErrors: true }).catch(() => {});
    });
  }

  $('sort-by').onchange = (e) => {
    state.sortBy = e.target.value;
    saveUiPrefs();
    applySortAndFilter();
  };
  $('btn-sort-dir').onclick = () => {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    $('btn-sort-dir').textContent = state.sortDir === 'asc' ? '▲' : '▼';
    saveUiPrefs();
    applySortAndFilter();
  };
  document.querySelectorAll('#list-header .lh-cell[data-sort]').forEach((el) => {
    el.onclick = (e) => {
      if (Date.now() < state.suppressHeaderSortUntil) return;
      if (e.target.closest('.lh-filter-btn') || e.target.closest('.lh-resizer')) return;
      const col = el.dataset.sort;
      if (state.sortBy === col) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortBy = col; state.sortDir = 'asc'; }
      $('sort-by').value = state.sortBy;
      $('btn-sort-dir').textContent = state.sortDir === 'asc' ? '▲' : '▼';
      saveUiPrefs();
      applySortAndFilter();
    };
  });
  document.querySelectorAll('#list-header .lh-filter-btn[data-col]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openColFilterPopover(btn.dataset.col, btn);
    };
  });
  setupListColumnResizers();
  document.addEventListener('pointerdown', (e) => {
    const pop = $('col-filter-popover');
    if (pop && pop.matches(':popover-open')) {
      if (!e.target.closest('#col-filter-popover') && !e.target.closest('#list-header .lh-filter-btn')) {
        closeColFilterPopover();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeColFilterPopover();
  });

  $('view-mode').onchange = (e) => {
    state.viewMode = e.target.value;
    state.globalViewMode = state.viewMode;
    const tab = getActiveTab();
    if (state.settings.rememberFolderView !== false && tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
      state.folderViews[normalizeFolderKey(tab.path)] = state.viewMode;
      saveFolderViews();
    }
    saveUiPrefs();
    renderVirtualList();
    if (state.thumbMode === 'viewport' || state.thumbMode === 'all') scheduleThumbBatch();
  };

  $('thumb-mode').onchange = (e) => {
    state.thumbMode = e.target.value;
    cancelPendingThumbs();
    if (state.thumbMode !== 'off') scheduleThumbBatch();
  };
  $('btn-stop-thumbs').onclick = cancelPendingThumbs;

  // İndeksleyici Butonu & Durum Hapı
  $('index-pill').onclick = async () => {
    try {
      const st = await api('/api/index/status', { silentErrors: true });
      if (st.running) {
        procModalState.trackIndex = true;
        openProcessModal();
      }
    } catch {}
  };
  $('btn-toggle-index').onclick = async () => {
    const st = await api('/api/index/status');
    if (st.running) {
      await controlTask('index', 'cancel', 'index');
      pollIndexStatus();
    } else {
      const tab = getActiveTab();
      const target = tab && tab.path !== 'PC' ? tab.path.slice(0, 3) : (state.drives.find((d) => d.id === 'D:')?.path || state.drives[0]?.path || 'C:\\');
      await startBackgroundIndex(target);
      procModalState.trackIndex = true;
    }
  };

  // Aralık Seçici Stüdyosu
  $('btn-range-studio').onclick = () => {
    $('range-studio').classList.toggle('hidden');
    $('btn-range-studio').classList.toggle('active', !$('range-studio').classList.contains('hidden'));
    updateStudioMatchPreview();
  };
  $('btn-close-studio').onclick = () => {
    $('range-studio').classList.add('hidden');
    $('btn-range-studio').classList.remove('active');
  };
  ['flt-pattern', 'flt-regex', 'flt-num-min', 'flt-num-max', 'flt-date-min', 'flt-date-max', 'flt-size-min', 'flt-size-min-unit', 'flt-size-max', 'flt-size-max-unit', 'flt-category', 'flt-ext', 'flt-row-min', 'flt-row-max'].forEach((id) => {
    $(id).addEventListener('input', updateStudioMatchPreview);
    $(id).addEventListener('change', updateStudioMatchPreview);
  });

  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.onclick = () => {
      const p = btn.dataset.preset;
      if (p === 'reset') {
        ['flt-pattern', 'flt-num-min', 'flt-num-max', 'flt-date-min', 'flt-date-max', 'flt-size-min', 'flt-size-max', 'flt-ext', 'flt-row-min', 'flt-row-max'].forEach((id) => $(id).value = '');
        $('flt-regex').checked = false;
        $('flt-category').value = 'all';
        state.filterOnlyMatched = false;
        $('btn-flt-clear-view').classList.add('hidden');
        applySortAndFilter();
      } else if (p === 'img') {
        $('flt-pattern').value = 'IMG_*';
        $('flt-regex').checked = false;
      } else if (p === 'vid') {
        $('flt-pattern').value = 'VID_*';
        $('flt-regex').checked = false;
      } else if (p === 'bigvid') {
        $('flt-category').value = 'video';
        $('flt-size-min').value = '100';
        $('flt-size-min-unit').value = '1048576';
      } else if (p === 'dupes') {
        $('flt-pattern').value = '\\(\\d+\\)\\.[^.]+$';
        $('flt-regex').checked = true;
      } else if (p === 'today') {
        const today = new Date().toISOString().slice(0, 10);
        $('flt-date-min').value = today;
        $('flt-date-max').value = today;
      }
      updateStudioMatchPreview();
    };
  });

  $('btn-flt-select').onclick = () => {
    const matched = getMatchedStudioItems();
    state.selectedPaths.clear();
    for (const m of matched) state.selectedPaths.add(m.path);
    renderVirtualList();
    updateStatusCounts();
    updateToolbarButtons();
    toast(`${matched.length} öğe seçildi`);
  };
  $('btn-flt-filter-view').onclick = () => {
    state.filterOnlyMatched = true;
    $('btn-flt-clear-view').classList.remove('hidden');
    applySortAndFilter();
  };
  $('btn-flt-clear-view').onclick = () => {
    state.filterOnlyMatched = false;
    for (const set of Object.values(state.colFilters)) set.clear();
    $('btn-flt-clear-view').classList.add('hidden');
    applySortAndFilter();
  };
  $('btn-flt-basket').onclick = () => addItemsToBasket(getMatchedStudioItems());
  $('btn-flt-copy').onclick = () => setClipboard('copy', getMatchedStudioItems().map((x) => x.path));
  $('btn-flt-delete').onclick = () => deleteSelected(false, getMatchedStudioItems().map((x) => x.path));
  $('btn-flt-move-folder').onclick = async () => {
    const matched = getMatchedStudioItems();
    if (matched.length === 0) return toast('Eşleşen öğe yok', 'error');
    const tab = getActiveTab();
    if (!tab || tab.path === 'PC') return;
    const res = await showPromptModal({
      title: `Seçilen ${matched.length} Öğeyi Yeni Klasöre Taşı`,
      fields: [{ name: 'folderName', label: 'Yeni Klasör Adı', value: 'Filtrelenenler' }],
      okText: 'Klasör Aç ve Taşı',
    });
    if (!res || !res.folderName.trim()) return;
    try {
      const actRes = await api('/api/fs/action', {
        method: 'POST',
        body: JSON.stringify({
          action: 'createFolderWithSelection',
          parentDir: tab.path,
          folderName: res.folderName.trim(),
          paths: matched.map((x) => x.path),
          op: 'move',
        }),
      });
      openProcessModal(actRes.jobId);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // Analizör, Kopya Bulucu, Klasör Boyutları, Tarih Düzenleyici, Çift Panel & Sepet
  const btnSaveSmart = $('btn-studio-save-smart');
  if (btnSaveSmart) {
    btnSaveSmart.onclick = async () => {
      const criteria = {};
      const pat = $('flt-pattern')?.value.trim();
      if (pat) criteria.nameContains = pat.replace(/\*/g, '').replace(/\.\*/g, '').trim();
      const cat = $('flt-category')?.value;
      if (cat && cat !== 'all') criteria.category = cat;
      const extVal = $('flt-ext')?.value.trim();
      if (extVal) criteria.extList = extVal.split(',').map((s) => s.trim()).filter(Boolean);
      const minSz = Number($('flt-size-min')?.value || 0);
      if (minSz > 0) criteria.minSize = minSz * Number($('flt-size-min-unit')?.value || 1048576);
      const maxSz = Number($('flt-size-max')?.value || 0);
      if (maxSz > 0) criteria.maxSize = maxSz * Number($('flt-size-max-unit')?.value || 1048576);
      const tab = getActiveTab();
      if (tab && tab.path && /^[a-zA-Z]:/.test(tab.path)) {
        criteria.driveRoot = tab.path.slice(0, 3);
      }
      const res = await showPromptModal({
        title: '✨ Akıllı Klasör Olarak Kaydet',
        desc: 'Geçerli filtre kriterleri sol menüdeki Akıllı Klasörler altına sanal klasör olarak eklenecek:',
        fields: [{ name: 'name', label: 'Klasör Adı', value: pat || (cat && cat !== 'all' ? `${cat} Görünümü` : 'Özel Akıllı Görünüm') }],
        okText: 'Kaydet',
      });
      if (!res || !res.name.trim()) return;
      state.smartViews.push({
        id: 'sv_' + Date.now().toString(36),
        icon: '✨',
        name: res.name.trim(),
        builtin: false,
        criteria,
      });
      state.smartViewsOpen = true;
      saveSmartViews();
      renderSmartViewsSidebar();
      toast(`✨ "${res.name.trim()}" Akıllı Klasörlere eklendi`, 'success');
    };
  }
  const btnToggleSmart = $('btn-toggle-smart-views');
  if (btnToggleSmart) {
    btnToggleSmart.onclick = () => {
      state.smartViewsOpen = !state.smartViewsOpen;
      try { localStorage.setItem('ld_smart_views_open', state.smartViewsOpen ? '1' : '0'); } catch {}
      renderSmartViewsSidebar();
    };
  }
  if ($('btn-smart-view-refresh')) $('btn-smart-view-refresh').onclick = () => { if (state.smartViewCtx) openSmartView(state.smartViewCtx); };
  if ($('btn-smart-view-close')) $('btn-smart-view-close').onclick = closeSmartView;

  $('btn-analyze').onclick = () => openAnalyzer();
  $('btn-analyzer-live').onclick = () => openAnalyzer($('btn-analyzer-live').dataset.path, 'live');
  $('btn-analyzer-dupes').onclick = () => findAndRenderDuplicates(false);
  $('btn-analyzer-close').onclick = () => {
    const tab = getActiveTab();
    navigateTo(tab ? tab.path : 'PC', { pushHistory: false });
  };

  $('btn-folder-sizes').onclick = (e) => calculateCurrentFolderSizes(Boolean(e?.shiftKey));
  $('btn-organize-date').onclick = organizeCurrentFolderByDate;
  $('btn-install-shortcut').onclick = async () => {
    try {
      await api('/api/system/integration', { method: 'POST', body: JSON.stringify({ action: 'installShortcuts' }) });
      toast('Masaüstü, Başlat Menüsü (Ctrl+Alt+E) ve Sağ Tık menüsü kuruldu!', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  bindIntegrationAndWelcomeHandlers();
  bindVaultHandlers();
  bindRelatedHandlers();
  const btnSettings = $('btn-settings');
  if (btnSettings) btnSettings.onclick = openSettingsDialog;
  const btnSetClose = $('btn-settings-close');
  if (btnSetClose) btnSetClose.onclick = () => $('settings-dialog').close();
  const btnSetDone = $('btn-settings-done');
  if (btnSetDone) btnSetDone.onclick = () => $('settings-dialog').close();

  const swatchesEl = $('set-accent-swatches');
  if (swatchesEl) {
    swatchesEl.onclick = (e) => {
      const btn = e.target.closest('.color-swatch[data-color]');
      if (!btn) return;
      state.settings.accentColor = btn.dataset.color;
      saveAppSettings();
      applyAppSettings();
    };
  }
  const setBind = (id, prop, isCheck = false, extra = null) => {
    const el = $(id);
    if (!el) return;
    el.onchange = () => {
      state.settings[prop] = isCheck ? Boolean(el.checked) : (id === 'set-font-size' ? Number(el.value) : el.value);
      saveAppSettings();
      applyAppSettings();
      if (extra) extra();
    };
  };
  setBind('set-font-size', 'fontSize');
  setBind('set-default-view', 'defaultViewMode', false, () => {
    const tab = getActiveTab();
    if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
      applyViewModeForFolder(tab.path);
      renderVirtualList();
    }
  });
  setBind('set-remember-folder-view', 'rememberFolderView', true, () => {
    const tab = getActiveTab();
    if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
      applyViewModeForFolder(tab.path);
      renderVirtualList();
    }
  });
  setBind('set-folders-first', 'foldersFirst', true, () => applySortAndFilter());
  setBind('set-show-ext', 'showExtensions', true, () => renderVirtualList());
  setBind('set-compact-sidebar', 'compactSidebar', true);
  const bindCustomPathSetting = (modeSelectId, customRowId, inputId, browseBtnId, modeProp, dirProp) => {
    setBind(modeSelectId, modeProp, false, () => {
      const row = $(customRowId);
      if (row) row.classList.toggle('hidden', state.settings[modeProp] !== 'custom');
    });
    const inputEl = $(inputId);
    if (inputEl) {
      inputEl.onchange = () => {
        state.settings[dirProp] = inputEl.value.trim();
        saveAppSettings();
      };
    }
    const browseBtn = $(browseBtnId);
    if (browseBtn) {
      browseBtn.onclick = async () => {
        const picked = await openFolderPickerModal({
          title: 'Klasör Seç',
          initialDir: state.settings[dirProp] || '',
        });
        if (picked) {
          state.settings[dirProp] = picked;
          if ($(inputId)) $(inputId).value = picked;
          saveAppSettings();
        }
      };
    }
  };
  bindCustomPathSetting('set-startup-mode', 'set-startup-custom-row', 'set-startup-path', 'btn-set-startup-browse', 'startupMode', 'startupPath');
  setBind('set-click-mode', 'clickMode');
  setBind('set-trash-confirm', 'trashConfirmMode');
  setBind('set-auto-close-proc', 'autoCloseProcessModal', true);
  setBind('set-default-thumb', 'defaultThumbMode', false, () => {
    state.thumbMode = state.settings.defaultThumbMode;
    $('thumb-mode').value = state.thumbMode;
    cancelPendingThumbs();
    if (state.thumbMode !== 'off') scheduleThumbBatch();
  });
  setBind('set-dblclick-quicklook', 'dblClickQuickLook', true);
  bindCustomPathSetting('set-frame-save-mode', 'set-frame-save-custom-row', 'set-frame-save-dir', 'btn-set-frame-save-browse', 'frameSaveMode', 'frameSaveDir');
  bindCustomPathSetting('set-trim-save-mode', 'set-trim-save-custom-row', 'set-trim-save-dir', 'btn-set-trim-save-browse', 'trimSaveMode', 'trimSaveDir');
  setBind('set-video-autoplay', 'videoAutoplay', true);
  setBind('set-video-loop', 'videoLoop', true);

  const btnClearThumbs = $('btn-set-clear-thumbs');
  if (btnClearThumbs) {
    btnClearThumbs.onclick = async () => {
      try {
        const res = await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'clearThumbCache' }) });
        toast('Kapak resmi önbelleği temizlendi', 'success');
        refreshSettingsCacheStats(res.stats);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
  }
  const btnClearRecents = $('btn-set-clear-recents');
  if (btnClearRecents) {
    btnClearRecents.onclick = () => {
      state.recentFolders = [];
      state.recentFiles = [];
      saveDashHistory();
      renderRecentDashboardSections();
      toast('Son açılan klasör ve dosya geçmişi temizlendi', 'success');
    };
  }
  const btnClearFolderViews = $('btn-set-clear-folder-views');
  if (btnClearFolderViews) {
    btnClearFolderViews.onclick = () => {
      state.folderViews = {};
      saveFolderViews();
      const tab = getActiveTab();
      if (tab && tab.path && tab.path !== 'PC' && tab.path !== 'TRASH') {
        applyViewModeForFolder(tab.path);
        renderVirtualList();
      }
      refreshSettingsCacheStats();
      toast('Kayıtlı klasör görünümleri temizlendi', 'success');
    };
  }
  const btnResetColWidths = $('btn-set-reset-col-widths');
  if (btnResetColWidths) {
    btnResetColWidths.onclick = resetColumnWidths;
  }
  const btnSetShortcut = $('btn-set-update-shortcut');
  if (btnSetShortcut) btnSetShortcut.onclick = () => $('btn-install-shortcut').click();
  const btnSetReset = $('btn-set-reset-defaults');
  if (btnSetReset) {
    btnSetReset.onclick = () => {
      state.settings = { ...DEFAULT_APP_SETTINGS };
      saveAppSettings();
      applyAppSettings();
      syncSettingsForm();
      applySortAndFilter();
      toast('Ayarlar varsayılana sıfırlandı', 'success');
    };
  }

  $('btn-dual-pane').onclick = toggleDualPane;
  $('btn-close-dual').onclick = toggleDualPane;
  $('dual-btn-back').onclick = () => {
    if (state.dualHistoryIdx > 0) {
      state.dualHistoryIdx--;
      navigateDual(state.dualHistory[state.dualHistoryIdx], false);
    }
  };
  $('dual-btn-up').onclick = () => {
    if (!state.dualPath) return;
    const clean = state.dualPath.replace(/\\+$/, '');
    if (/^[a-zA-Z]:$/.test(clean)) return;
    const parent = clean.substring(0, clean.lastIndexOf('\\'));
    navigateDual(/^[a-zA-Z]:$/.test(parent) ? parent + '\\' : parent);
  };
  $('dual-btn-refresh').onclick = () => { if (state.dualPath) navigateDual(state.dualPath, false); };
  $('dual-path-input').onkeydown = (e) => {
    if (e.key === 'Enter') navigateDual($('dual-path-input').value.trim());
  };
  $('dual-quick-select').onchange = (e) => {
    if (e.target.value) {
      navigateDual(e.target.value);
      e.target.value = '';
    }
  };
  $('dual-btn-move-here').onclick = async () => {
    const srcs = Array.from(state.selectedPaths);
    if (!state.dualPath || srcs.length === 0) return toast('Soldan öğe seçin ve sağda hedef açın', 'error');
    await enqueueTransfer('move', srcs, state.dualPath);
  };
  $('dual-btn-copy-here').onclick = async () => {
    const srcs = Array.from(state.selectedPaths);
    if (!state.dualPath || srcs.length === 0) return toast('Soldan öğe seçin ve sağda hedef açın', 'error');
    await enqueueTransfer('copy', srcs, state.dualPath);
  };
  const dualBasketMove = $('dual-btn-basket-move-here');
  if (dualBasketMove) dualBasketMove.onclick = () => transferBasketTo(state.dualPath, 'move');
  $('dual-btn-mkdir').onclick = async () => {
    if (!state.dualPath) return;
    const res = await showPromptModal({ title: 'Sağ Panelde Yeni Klasör', fields: [{ name: 'name', label: 'Klasör Adı', value: 'Yeni Klasör' }], okText: 'Oluştur' });
    if (!res || !res.name.trim()) return;
    await api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'mkdir', parentDir: state.dualPath, name: res.name.trim() }) });
    navigateDual(state.dualPath, false);
  };

  $('btn-basket').onclick = () => $('basket-drawer').classList.toggle('hidden');
  $('btn-close-basket').onclick = () => $('basket-drawer').classList.add('hidden');
  $('btn-basket-clear').onclick = () => { state.basket.clear(); renderBasket(); };
  $('btn-basket-move-here').onclick = () => transferBasketTo(getActiveTab()?.path, 'move');
  $('btn-basket-copy-here').onclick = () => transferBasketTo(getActiveTab()?.path, 'copy');
  const bMoveDual = $('btn-basket-move-dual');
  if (bMoveDual) bMoveDual.onclick = () => transferBasketTo(state.dualPath, 'move');
  const bCopyDual = $('btn-basket-copy-dual');
  if (bCopyDual) bCopyDual.onclick = () => transferBasketTo(state.dualPath, 'copy');

  // Transfer Kontrolleri, İşlem Modalı & Hata Merkezi
  const toggleJobPause = async () => {
    const t = procModalState.activeControlType;
    if (!t) return;
    const nextPause = !procModalState.activePaused;
    procModalState.activePaused = nextPause;
    const pauseBtn = $('btn-proc-pause');
    if (pauseBtn) pauseBtn.textContent = nextPause ? '▶ Devam Et' : '⏸ Duraklat';
    await controlTask(t, nextPause ? 'pause' : 'resume', procModalState.activeControlId);
  };
  const cancelActiveProcess = async () => {
    const t = procModalState.activeControlType;
    if (!t) return;
    await controlTask(t, 'cancel', procModalState.activeControlId);
  };

  $('btn-transfer-pause').onclick = toggleJobPause;
  $('btn-transfer-cancel').onclick = async () => {
    const jobId = $('btn-transfer-cancel').dataset.jobId;
    await api('/api/transfer/control', { method: 'POST', body: JSON.stringify({ action: 'cancel', jobId }) });
    pollTransferStatus();
  };
  $('transfer-pill').onclick = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    openProcessModal();
  };

  $('btn-proc-minimize').onclick = minimizeProcessModal;
  $('btn-proc-close').onclick = closeProcessModal;
  $('btn-proc-done').onclick = () => {
    procModalState.mode = 'closed';
    procModalState.trackedJobId = null;
    procModalState.trackedScanId = null;
    $('process-modal').classList.add('hidden');
  };
  {
    const procOverlay = $('process-modal');
    let procPressedOverlay = false;
    procOverlay.addEventListener('pointerdown', (e) => {
      procPressedOverlay = e.target === procOverlay;
    });
    procOverlay.addEventListener('pointerup', (e) => {
      if (procPressedOverlay && e.target === procOverlay) closeProcessModal();
      procPressedOverlay = false;
    });
  }
  $('btn-proc-details').onclick = () => {
    procModalState.detailsOpen = !procModalState.detailsOpen;
    pollTransferStatus();
  };
  $('btn-proc-pause').onclick = toggleJobPause;
  $('btn-proc-cancel').onclick = cancelActiveProcess;
  $('btn-proc-open-errors').onclick = () => {
    minimizeProcessModal();
    openErrorsDialog();
  };

  $('btn-dock-expand').onclick = () => openProcessModal();
  $('btn-dock-pause').onclick = toggleJobPause;
  $('btn-dock-cancel').onclick = cancelActiveProcess;

  $('btn-errors-center').onclick = openErrorsDialog;
  $('btn-err-close').onclick = () => $('errors-dialog').close();
  $('btn-err-refresh').onclick = () => refreshErrorsDialog(true);
  $('btn-err-open-file').onclick = async () => {
    await api('/api/errors', { method: 'POST', body: JSON.stringify({ action: 'openLogFile' }), silentErrors: true });
  };
  const btnDiagCopy = $('btn-err-diag-copy');
  if (btnDiagCopy) btnDiagCopy.onclick = copyFullDiagnosticsReport;
  $('btn-err-copy').onclick = async () => {
    const text = $('errors-logs-tail').textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('Hata günlüğü panoya kopyalandı', 'success');
    } catch {
      toast('Panoya kopyalanamadı', 'error');
    }
  };
  $('btn-err-clear').onclick = async () => {
    localClientErrors.length = 0;
    await api('/api/errors', { method: 'POST', body: JSON.stringify({ action: 'clear' }), silentErrors: true });
    refreshErrorsDialog(true);
    toast('Oturum hata listesi temizlendi');
  };

  window.addEventListener('error', (ev) => {
    const loc = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno || 0}` : '';
    const stack = ev.error && ev.error.stack ? ev.error.stack : '';
    reportClientError('Arayüz Hatası', ev.message || 'Bilinmeyen JS hatası', loc, stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const msg = ev.reason?.message || String(ev.reason || 'Promise hatası');
    const stack = ev.reason && ev.reason.stack ? ev.reason.stack : '';
    if (msg !== 'İptal edildi') reportClientError('Arayüz Promise', msg, '', stack);
  });

  // Sanal Liste Etkileşimi & Scroll
  const vp = $('virtual-viewport');
  vp.onscroll = () => {
    closeColFilterPopover();
    const cur = getActiveTab();
    if (cur && cur.viewType === 'explorer') cur.scrollTop = vp.scrollTop || 0;
    renderVirtualList();
    if (state.thumbMode === 'viewport') scheduleThumbBatch();
  };

  vp.onclick = (e) => {
    state.activePane = 'left';
    if (state.suppressNextClick) {
      state.suppressNextClick = false;
      return;
    }
    const rowEl = e.target.closest('[data-index]');
    if (!rowEl) {
      if (!e.ctrlKey && !e.shiftKey) {
        state.selectedPaths.clear();
        updateSelectionDomInPlace();
        updateStatusCounts();
        updateToolbarButtons();
      }
      return;
    }
    const idx = Number(rowEl.dataset.index);
    const item = state.viewItems[idx];
    if (!item) return;

    if (e.target.closest('.eye-btn')) {
      e.stopPropagation();
      loadSingleThumb(item);
      return;
    }

    const now = Date.now();
    const isCheckbox = e.target.type === 'checkbox';
    if (!isCheckbox && !e.ctrlKey && !e.shiftKey && state.settings.clickMode === 'single') {
      handleItemSelect(idx, e);
      activateItem(item);
      return;
    }
    if (!isCheckbox && !e.ctrlKey && !e.shiftKey && state.lastClickPath === item.path && now - state.lastClickTime < 400) {
      state.lastClickPath = '';
      state.lastClickTime = 0;
      activateItem(item);
      return;
    }

    if (!isCheckbox) {
      state.lastClickPath = item.path;
      state.lastClickTime = now;
    }
    handleItemSelect(idx, e);
  };

  vp.ondblclick = (e) => {
    if (e.target.type === 'checkbox' || e.target.classList.contains('eye-btn')) return;
    const rowEl = e.target.closest('[data-index]');
    if (!rowEl) return;
    const item = state.viewItems[Number(rowEl.dataset.index)];
    if (!item) return;
    state.lastClickPath = '';
    state.lastClickTime = 0;
    activateItem(item);
  };

  vp.onauxclick = (e) => {
    if (e.button === 1) {
      const rowEl = e.target.closest('[data-index]');
      if (!rowEl) return;
      const item = state.viewItems[Number(rowEl.dataset.index)];
      if (item && item.isDir) createTab(item.path, true);
    }
  };

  const dualListEl = $('dual-list');
  if (dualListEl) {
    dualListEl.onclick = (e) => {
      state.activePane = 'dual';
      if (state.suppressNextClick) {
        state.suppressNextClick = false;
        return;
      }
      const rowEl = e.target.closest('.dual-row[data-index]');
      if (!rowEl) {
        if (!e.ctrlKey && !e.shiftKey) {
          state.dualSelectedPaths.clear();
          updateDualSelectionDomInPlace();
        }
        return;
      }
      const idx = Number(rowEl.dataset.index);
      const item = state.dualItems[idx];
      if (!item) return;
      handleDualItemSelect(idx, e);
      if (!e.ctrlKey && !e.shiftKey && state.settings.clickMode === 'single') {
        if (item.isDir) navigateDual(item.path);
        else openExternally(item.path);
      }
    };

    dualListEl.ondblclick = (e) => {
      const rowEl = e.target.closest('.dual-row[data-index]');
      if (!rowEl) return;
      const item = state.dualItems[Number(rowEl.dataset.index)];
      if (!item) return;
      if (item.isDir) navigateDual(item.path);
      else if (shouldOpenInQuickLook(item)) openQuickLook(item, state.dualItems);
      else openExternally(item.path);
    };

    dualListEl.onauxclick = (e) => {
      if (e.button === 1) {
        const rowEl = e.target.closest('.dual-row[data-index]');
        if (!rowEl) return;
        const item = state.dualItems[Number(rowEl.dataset.index)];
        if (item && item.isDir) createTab(item.path, true);
      }
    };
  }

  $('chk-select-all').onchange = (e) => {
    state.selectedPaths.clear();
    if (e.target.checked) {
      for (const it of state.viewItems) state.selectedPaths.add(it.path);
    }
    renderVirtualList();
    updateStatusCounts();
    updateToolbarButtons();
  };

  // Sağ Tık Menüsü (Uygulama Geneli Dinamik Bağlam Menüsü — Edge Menüsü Engelli)
  const ctxMenu = $('context-menu');
  const supportsPopover = 'showPopover' in HTMLElement.prototype;

  window.revealInExplorer = (targetPath) => {
    if (!targetPath || targetPath === 'PC' || targetPath === 'TRASH') return;
    api('/api/fs/action', { method: 'POST', body: JSON.stringify({ action: 'reveal', path: targetPath }) });
  };

  function hideCustomContextMenu() {
    if (supportsPopover) {
      try {
        if (ctxMenu.matches(':popover-open')) ctxMenu.hidePopover();
      } catch {}
    }
    ctxMenu.classList.add('hidden');
  }

  function showCustomContextMenu(e, entries) {
    const clean = (entries || []).filter(Boolean);
    if (clean.length === 0) return;

    ctxMenu.innerHTML = '';
    for (const entry of clean) {
      if (entry.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = `ctx-item${entry.danger ? ' danger' : ''}${entry.disabled ? ' disabled' : ''}`;
      el.innerHTML = `<span>${entry.bold ? `<strong>${esc(entry.label)}</strong>` : esc(entry.label)}</span>${entry.shortcut ? `<span class="ctx-shortcut">${esc(entry.shortcut)}</span>` : ''}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        if (entry.disabled) return;
        if (!entry.keepOpen) hideCustomContextMenu();
        if (entry.onClick) entry.onClick(ev);
      };
      ctxMenu.appendChild(el);
    }

    ctxMenu.classList.remove('hidden');
    if (supportsPopover) {
      try {
        if (!ctxMenu.matches(':popover-open')) ctxMenu.showPopover();
      } catch {}
    }
    const menuW = ctxMenu.offsetWidth || 240;
    const menuH = ctxMenu.offsetHeight || 260;
    ctxMenu.style.left = `${Math.max(4, Math.min(e.clientX, window.innerWidth - menuW - 6))}px`;
    ctxMenu.style.top = `${Math.max(4, Math.min(e.clientY, window.innerHeight - menuH - 6))}px`;
  }

  document.addEventListener('click', (e) => {
    if (!ctxMenu.contains(e.target)) hideCustomContextMenu();
  });
  window.addEventListener('blur', hideCustomContextMenu);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCustomContextMenu();
  }, true);

  function buildExplorerItemMenu(sel) {
    const first = sel[0];
    const multi = sel.length > 1;
    const tab = getActiveTab();
    const isTrash = tab && tab.path === 'TRASH';

    if (isTrash) {
      return [
        { label: `♻️ Geri Yükle (${sel.length} öğe)`, bold: true, onClick: () => restoreFromTrash(sel.map((s) => s.path)) },
        { label: '🔗 Özgün Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(sel.map((s) => s.origPath || s.path).join('\n')); toast('Özgün yol kopyalandı'); } },
        { sep: true },
        { label: '🔥 Kalıcı Sil', shortcut: 'Del', danger: true, onClick: () => deleteFromTrash(sel.map((s) => s.path)) },
      ];
    }

    const inBasket = sel.every((s) => state.basket.has(s.path));
    return [
      { label: first.isDir ? '📂 Aç' : '🚀 Varsayılan Uygulamada Aç', bold: true, shortcut: 'Enter', onClick: () => (first.isDir ? navigateTo(first.path) : openExternally(first.path)) },
      !first.isDir ? { label: '👁️ Hızlı Önizle', shortcut: 'Space', onClick: () => openQuickLook(first) } : null,
      !multi && !first.isDir ? { label: '✨ Benzer / Yakın Zamanlı Dosyaları Bul...', onClick: () => openRelatedDialog(first) } : null,
      !multi && !first.isDir ? { label: '📅 Aynı Gündeki Dosyaları Göster', onClick: () => runRelatedSearch({ item: first, mode: 'sameDay', scope: 'folder', sameCategoryOnly: 'media' }) } : null,
      first.isDir ? { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(first.path, true) } : null,
      first.isDir ? { label: '📊 Bu Klasörü Analiz Et', onClick: () => openAnalyzer(first.path) } : null,
      { sep: true },
      { label: inBasket ? '🧺 Sepetten Çıkar' : '🧺 Sepete Ekle', shortcut: 'B', onClick: () => toggleSelectedInBasket() },
      first.isDir ? { label: '📌 Sol Menüye Sabitle', onClick: () => togglePin(first.path, first.name, false) } : null,
      { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(first.path) },
      { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(sel.map((s) => s.path).join('\n')); toast('Yol kopyalandı'); } },
      { sep: true },
      { label: '✂️ Kes', shortcut: 'Ctrl+X', onClick: () => setClipboard('cut') },
      { label: '📋 Kopyala', shortcut: 'Ctrl+C', onClick: () => setClipboard('copy') },
      (state.recentTransferTargets && state.recentTransferTargets.length > 0)
        ? {
            label: `⚡ Son Erişilen Yollara Gönder (${state.recentTransferTargets.length})`,
            shortcut: '▸',
            keepOpen: true,
            onClick: (ev) => {
              const selPaths = sel.map((s) => s.path);
              const subEntries = [
                {
                  label: '← Ana Menüye Dön',
                  keepOpen: true,
                  onClick: (ev2) => showCustomContextMenu(ev2, buildExplorerItemMenu(sel)),
                },
                { sep: true },
                ...state.recentTransferTargets.map((rt) => {
                  const autoOp = resolveDragOp(selPaths, rt.path, false, false);
                  return {
                    label: `${autoOp === 'copy' ? '📋 Kopyala' : '📦 Taşı'} → ${rt.name}`,
                    shortcut: rt.path.length > 26 ? '…' + rt.path.slice(-24) : rt.path,
                    onClick: () => enqueueTransfer(autoOp, selPaths, rt.path),
                  };
                }),
              ];
              showCustomContextMenu(ev, subEntries);
            },
          }
        : null,
      state.clipboard.paths.length > 0 && first.isDir && !multi
        ? { label: '📥 Bu Klasöre Yapıştır', onClick: () => enqueueTransfer(state.clipboard.op, state.clipboard.paths, first.path) }
        : null,
      state.basket.size > 0 && first.isDir && !multi
        ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, onClick: () => transferBasketTo(first.path, 'move') }
        : null,
      state.basket.size > 0 && first.isDir && !multi
        ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(first.path, 'copy') }
        : null,
      !multi && !first.isDir && (first.ext || '').toLowerCase() === '.zip'
        ? { label: '📦 ZIP İçeriğini Aç & Yönet', bold: true, onClick: () => openZipManagerModal(first.path) }
        : null,
      !multi && !first.isDir && (first.ext || '').toLowerCase() === '.zip'
        ? { label: '📂 Buraya Ayıkla', onClick: () => extractZipQuickHere(first.path) }
        : null,
      !multi && !first.isDir && (first.ext || '').toLowerCase() === '.zip'
        ? { label: '📁 Klasöre Ayıkla...', onClick: () => extractZipToPicker(first.path) }
        : null,
      { label: multi ? `🗜️ ZIP Olarak Sıkıştır (${sel.length} öğe)...` : '🗜️ ZIP Olarak Sıkıştır...', onClick: () => compressPathsToZip(sel.map((s) => s.path), getActiveTab()?.path || '') },
      { label: multi ? '🔢 Toplu Adlandır' : '✏️ Yeniden Adlandır', shortcut: multi ? '' : 'F2', onClick: () => (multi ? batchRenameSelected(sel) : renameSelected()) },
      { sep: true },
      { label: '🗑️ Çöpe At', shortcut: 'Del', danger: true, onClick: () => deleteSelected(false) },
      { label: '🔥 Kalıcı Sil', shortcut: 'Shift+Del', danger: true, onClick: () => deleteSelected(true) },
      { sep: true },
      { label: 'ℹ️ Dosya Bilgisi / Özellikler', shortcut: 'Alt+Enter', onClick: () => showPropertiesModal(sel.map((s) => s.path)) },
    ];
  }

  function buildFolderBgMenu(tab) {
    if (!tab || tab.path === 'PC') {
      return [
        { label: '🔄 Sürücüleri Yenile', shortcut: 'F5', onClick: () => hydrateInitData(false) },
        { label: '🗑️ Çöp Kutusunu Aç', onClick: () => navigateTo('TRASH') },
        state.undoSummary?.canUndo ? { label: `↩️ Geri Al (${state.undoSummary.topLabel})`, shortcut: 'Ctrl+Z', onClick: () => performUndo() } : null,
      ];
    }
    if (tab.path === 'TRASH') {
      return [
        { label: '🔄 Yenile', shortcut: 'F5', onClick: () => navigateTo('TRASH', { pushHistory: false, forceRefresh: true, preserveScroll: true }) },
        { label: '✅ Tümünü Seç', shortcut: 'Ctrl+A', disabled: state.viewItems.length === 0, onClick: () => $('chk-select-all').click() },
        { sep: true },
        { label: '🧹 Çöp Kutusunu Boşalt', danger: true, disabled: state.rawItems.length === 0, onClick: () => emptyTrash() },
      ];
    }
    return [
      { label: '📥 Yapıştır', shortcut: 'Ctrl+V', onClick: () => pasteToCurrentFolder() },
      state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, bold: true, onClick: () => transferBasketTo(tab.path, 'move') } : null,
      state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(tab.path, 'copy') } : null,
      { label: '📁 Yeni Klasör', shortcut: 'Ctrl+Shift+N', onClick: () => createNewFolder() },
      { sep: true },
      { label: '✅ Tümünü Seç', shortcut: 'Ctrl+A', disabled: state.viewItems.length === 0, onClick: () => { for (const it of state.viewItems) state.selectedPaths.add(it.path); renderVirtualList(); updateStatusCounts(); updateToolbarButtons(); } },
      { label: '↩️ Geri Al', shortcut: 'Ctrl+Z', disabled: !state.undoSummary?.canUndo, onClick: () => performUndo() },
      { label: '🔄 Yenile', shortcut: 'F5', onClick: () => navigateTo(tab.path, { pushHistory: false, forceRefresh: true, preserveScroll: true }) },
      { sep: true },
      { label: '📂 Bulunduğu Yeri Aç (Gezgin)', onClick: () => revealInExplorer(tab.path) },
      { label: '🔗 Klasör Yolunu Kopyala', onClick: () => { navigator.clipboard.writeText(tab.path); toast('Klasör yolu kopyalandı'); } },
      { label: '📌 Sol Menüye Sabitle', onClick: () => togglePin(tab.path, getFolderTitle(tab.path), false) },
      { label: '📊 Bu Klasörü Analiz Et', onClick: () => openAnalyzer(tab.path) },
      { label: 'ℹ️ Klasör Bilgisi / Özellikler', shortcut: 'Alt+Enter', onClick: () => showPropertiesModal([tab.path]) },
    ];
  }

  document.addEventListener('contextmenu', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.target && e.target.closest('.errors-logs-tail, .errors-list, .diag-env-bar, .proc-log-list, .props-val-copy, #errors-dialog, #properties-dialog, #settings-dialog, #vault-dialog, #folder-picker-dialog, #zip-dialog, #ql-text-editor')) {
      return;
    }
    e.preventDefault();

    // 1) QuickLook Önizleme Penceresi
    if ($('quicklook-dialog').open && $('quicklook-dialog').contains(e.target)) {
      const item = state.qlMediaItems[state.qlIndex];
      if (!item) return;
      const inBasket = state.basket.has(item.path);
      showCustomContextMenu(e, [
        { label: '🚀 Varsayılan Uygulamada Aç', bold: true, onClick: () => openExternally(item.path) },
        { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(item.path) },
        { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(item.path); toast('Yol kopyalandı'); } },
        { sep: true },
        { label: inBasket ? '🧺 Sepetten Çıkar' : '🧺 Sepete Ekle ve Sonrakine Geç', shortcut: 'B', onClick: () => triageQuickLookBasket() },
        { label: '◀ Önceki', shortcut: '←', disabled: state.qlIndex <= 0, onClick: () => $('btn-ql-prev').click() },
        { label: 'Sonraki ▶', shortcut: '→', disabled: state.qlIndex >= state.qlMediaItems.length - 1, onClick: () => $('btn-ql-next').click() },
        { label: '🔍 Yakınlaştırmayı Sıfırla (%100)', shortcut: '0', disabled: state.qlZoom <= 1.01, onClick: () => setQuickLookZoom(1) },
        { sep: true },
        { label: '🗑️ Çöpe At', shortcut: 'Del', danger: true, onClick: () => triageQuickLookDelete(false) },
        { label: '🔥 Kalıcı Sil', shortcut: 'Shift+Del', danger: true, onClick: () => triageQuickLookDelete(true) },
        { sep: true },
        { label: 'ℹ️ Dosya Bilgisi / Özellikler', onClick: () => showPropertiesModal([item.path]) },
      ]);
      return;
    }

    // 2) Orta Dosya Listesi (#virtual-viewport)
    if (vp.contains(e.target)) {
      const rowEl = e.target.closest('[data-index]');
      if (rowEl) {
        const idx = Number(rowEl.dataset.index);
        const item = state.viewItems[idx];
        if (item && !state.selectedPaths.has(item.path)) {
          state.selectedPaths.clear();
          state.selectedPaths.add(item.path);
          renderVirtualList();
          updateStatusCounts();
          updateToolbarButtons();
        }
        const sel = getSelectedItems();
        if (sel.length > 0) showCustomContextMenu(e, buildExplorerItemMenu(sel));
      } else {
        showCustomContextMenu(e, buildFolderBgMenu(getActiveTab()));
      }
      return;
    }

    // 3) Sağ Çift Panel (#dual-list)
    const dualListEl = $('dual-list');
    if (dualListEl && dualListEl.contains(e.target)) {
      state.activePane = 'dual';
      const row = e.target.closest('.dual-row');
      const tab = getActiveTab();
      const leftCanReceive = tab && tab.path !== 'PC' && tab.path !== 'TRASH';
      if (row) {
        const p = row.dataset.path;
        const idx = Number(row.dataset.index);
        if (!state.dualSelectedPaths.has(p)) {
          state.dualSelectedPaths.clear();
          state.dualSelectedPaths.add(p);
          if (!Number.isNaN(idx)) state.dualLastClickedIdx = idx;
          updateDualSelectionDomInPlace();
        }
        const dualSelPaths = state.dualSelectedPaths.size > 0 ? Array.from(state.dualSelectedPaths) : [p];
        const dualSelItems = getDualSelectedItems();
        const isDir = row.dataset.isdir === '1';
        const multiCount = dualSelPaths.length;
        const countTag = multiCount > 1 ? ` (${multiCount})` : '';
        const dualItem = state.dualItems.find((x) => x.path === p) || { path: p, isDir, name: getFolderTitle(p), size: 0, mtime: Date.now(), category: 'other' };
        showCustomContextMenu(e, [
          multiCount === 1 ? { label: isDir ? '📂 Sağ Panelde Aç' : '🚀 Varsayılan Uygulamada Aç', bold: true, onClick: () => (isDir ? navigateDual(p) : openExternally(p)) } : null,
          multiCount === 1 && isDir ? { label: '📑 Sol Sekmede Aç', onClick: () => navigateTo(p) } : null,
          multiCount === 1 && !isDir ? { label: '👁️ Hızlı Önizle', onClick: () => openQuickLook(dualItem, state.dualItems) } : null,
          multiCount === 1 ? { sep: true } : null,
          leftCanReceive ? { label: `⬅ Sol Panele Taşı${countTag}`, onClick: () => enqueueTransfer('move', dualSelPaths, tab.path) } : null,
          leftCanReceive ? { label: `📋 Sol Panele Kopyala${countTag}`, onClick: () => enqueueTransfer('copy', dualSelPaths, tab.path) } : null,
          multiCount === 1 && state.basket.size > 0 && isDir ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, bold: true, onClick: () => transferBasketTo(p, 'move') } : null,
          multiCount === 1 && state.basket.size > 0 && isDir ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(p, 'copy') } : null,
          { label: `🧺 Sepete Ekle / Çıkar${countTag}`, onClick: () => toggleSelectedInBasket(dualSelItems.length ? dualSelItems : [dualItem]) },
          { sep: true },
          { label: `✂️ Kes${countTag}`, shortcut: 'Ctrl+X', onClick: () => setClipboard('cut', dualSelPaths) },
          { label: `📋 Kopyala${countTag}`, shortcut: 'Ctrl+C', onClick: () => setClipboard('copy', dualSelPaths) },
          { label: multiCount > 1 ? `✏️ Toplu Yeniden Adlandır (${multiCount})` : '✏️ Yeniden Adlandır', shortcut: 'F2', onClick: () => renameSelected(dualSelItems.length ? dualSelItems : [dualItem]) },
          { sep: true },
          multiCount === 1 ? { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(p) } : null,
          { label: multiCount > 1 ? `🔗 Yolları Kopyala (${multiCount})` : '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(dualSelPaths.join('\n')); toast('Yol kopyalandı'); } },
          { sep: true },
          { label: `🗑️ Çöpe At${countTag}`, shortcut: 'Del', danger: true, onClick: () => deleteSelected(false, dualSelPaths) },
          { label: `🔥 Kalıcı Sil${countTag}`, shortcut: 'Shift+Del', danger: true, onClick: () => deleteSelected(true, dualSelPaths) },
          { sep: true },
          { label: `ℹ️ Özellikler${countTag}`, shortcut: 'Alt+Enter', onClick: () => showPropertiesModal(dualSelPaths) },
        ]);
      } else if (state.dualPath) {
        showCustomContextMenu(e, [
          state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, bold: true, onClick: () => transferBasketTo(state.dualPath, 'move') } : null,
          state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(state.dualPath, 'copy') } : null,
          state.basket.size > 0 ? { sep: true } : null,
          { label: '📥 Buraya Yapıştır', shortcut: 'Ctrl+V', onClick: () => pasteToCurrentFolder(state.dualPath) },
          { label: '📁 Yeni Klasör', onClick: () => $('dual-btn-mkdir').click() },
          { label: '🔄 Yenile', onClick: () => navigateDual(state.dualPath, false) },
          { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(state.dualPath) },
          { label: 'ℹ️ Klasör Bilgisi / Özellikler', onClick: () => showPropertiesModal([state.dualPath]) },
        ]);
      }
      return;
    }

    // 4) Sol Gezinti Menüsü (.sidebar)
    const sidebarEl = document.querySelector('.sidebar');
    if (sidebarEl && sidebarEl.contains(e.target)) {
      const sbItem = e.target.closest('.sidebar-item[data-path]');
      if (sbItem) {
        const p = sbItem.dataset.path;
        if (p === 'PC') {
          showCustomContextMenu(e, [
            { label: '🖥️ Bu Bilgisayar\'ı Aç', bold: true, onClick: () => navigateTo('PC') },
            { label: '🔄 Sürücüleri Yenile', onClick: () => hydrateInitData(false) },
          ]);
        } else if (p === 'TRASH') {
          showCustomContextMenu(e, [
            { label: '🗑️ Çöp Kutusunu Aç', bold: true, onClick: () => navigateTo('TRASH') },
            { label: '📑 Yeni Sekmede Aç', onClick: () => createTab('TRASH', true) },
            { sep: true },
            { label: '🧹 Çöp Kutusunu Boşalt', danger: true, onClick: () => navigateTo('TRASH').then(() => emptyTrash()) },
          ]);
        } else {
          const isPinned = state.pins.some((x) => x.path.toLowerCase() === p.toLowerCase());
          showCustomContextMenu(e, [
            { label: '📂 Aç', bold: true, onClick: () => navigateTo(p) },
            { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(p, true) },
            state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Taşı (${state.basket.size})`, onClick: () => transferBasketTo(p, 'move') } : null,
            state.basket.size > 0 ? { label: `🧺 Sepettekileri Buraya Kopyala (${state.basket.size})`, onClick: () => transferBasketTo(p, 'copy') } : null,
            { sep: true },
            { label: isPinned ? '📌 Sabitlemeyi Kaldır' : '📌 Sabitle', onClick: () => togglePin(p, getFolderTitle(p), isPinned) },
            { label: '📊 Disk / Klasör Analizi', onClick: () => openAnalyzer(p) },
            { label: '📂 Bulunduğu Yeri Aç (Gezgin)', onClick: () => revealInExplorer(p) },
            { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
            { label: 'ℹ️ Özellikler / Toplam Boyut', onClick: () => showPropertiesModal([p]) },
          ]);
        }
        return;
      }
    }

    // 5) Analiz / Kopya Listesi Satırları
    const analyzerRow = e.target.closest('.analyzer-row, .dupe-file-row');
    if (analyzerRow && analyzerRow.title) {
      const p = analyzerRow.title;
      if (analyzerRow.classList.contains('dupe-file-row')) {
        const selectedList = selectDupPathForContextMenu(p);
        const multi = selectedList.length > 1;
        showCustomContextMenu(e, [
          { label: '📂 Bulunduğu Yeri Aç', bold: true, onClick: () => revealInExplorer(p) },
          { label: '👁️ Hızlı Önizle', onClick: () => openQuickLookForSelectedDup() },
          { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(selectedList.join('\n')); toast('Yol kopyalandı'); } },
          { label: 'ℹ️ Dosya Bilgisi / Özellikler', onClick: () => showPropertiesModal(selectedList) },
          { sep: true },
          { label: multi ? `🗑️ Seçilenleri Çöpe At (${selectedList.length})` : '🗑️ Çöpe At', danger: true, onClick: () => deleteSelected(false, selectedList) },
        ]);
        return;
      }
      showCustomContextMenu(e, [
        { label: '📂 Bulunduğu Yeri Aç', bold: true, onClick: () => revealInExplorer(p) },
        { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
        { label: 'ℹ️ Dosya Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) },
        { sep: true },
        { label: '🗑️ Çöpe At', danger: true, onClick: () => deleteSelected(false, [p]) },
      ]);
      return;
    }

    // 5.5) Bu Bilgisayar Dashboard Kartları (Hızlı Erişim / Son Klasörler / Son Dosyalar)
    const recentCard = e.target.closest('.recent-card[data-path]');
    if (recentCard) {
      const p = recentCard.dataset.path;
      const rType = recentCard.dataset.rtype;
      if (rType === 'folder') {
        showCustomContextMenu(e, [
          { label: '📂 Klasörü Aç', bold: true, onClick: () => navigateTo(p) },
          { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(p, true) },
          { label: '📂 Bulunduğu Yeri Aç (Gezgin)', onClick: () => revealInExplorer(p) },
          { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
          { label: 'ℹ️ Klasör Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) },
          { sep: true },
          { label: '✕ Son Klasörlerden Kaldır', onClick: () => removeRecentEntry('folder', p) },
        ]);
      } else {
        const rf = state.recentFiles.find((x) => x.path === p) || { path: p, name: getFolderTitle(p), category: 'other', isDir: false, size: 0, mtime: Date.now() };
        showCustomContextMenu(e, [
          { label: '🚀 Varsayılan Uygulamada Aç', bold: true, onClick: () => openExternally(p) },
          { label: '👁️ Hızlı Önizle', onClick: () => openQuickLook(rf, state.recentFiles) },
          { label: '📂 Bulunduğu Yeri Aç', onClick: () => revealInExplorer(p) },
          { label: '🔗 Yolu Kopyala', onClick: () => { navigator.clipboard.writeText(p); toast('Yol kopyalandı'); } },
          { label: 'ℹ️ Dosya Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) },
          { sep: true },
          { label: '✕ Son Dosyalardan Kaldır', onClick: () => removeRecentEntry('file', p) },
        ]);
      }
      return;
    }

    const quickCard = e.target.closest('.quick-card[data-path]');
    if (quickCard) {
      const p = quickCard.dataset.path;
      showCustomContextMenu(e, [
        { label: '📂 Aç', bold: true, onClick: () => navigateTo(p) },
        { label: '📑 Yeni Sekmede Aç', onClick: () => createTab(p, true) },
        p !== 'TRASH' ? { label: '📂 Windows Gezgini\'nde Aç', onClick: () => revealInExplorer(p) } : null,
        p !== 'TRASH' ? { label: 'ℹ️ Klasör Bilgisi / Özellikler', onClick: () => showPropertiesModal([p]) } : null,
      ]);
      return;
    }

    // 6) Diğer Alanlar (Toolbar, Dashboard vb.) — Edge menüsü yerine program menüsü
    const tab = getActiveTab();
    showCustomContextMenu(e, [
      { label: '🔄 Yenile', shortcut: 'F5', onClick: () => $('btn-refresh').click() },
      { label: '↩️ Geri Al', shortcut: 'Ctrl+Z', disabled: !state.undoSummary?.canUndo, onClick: () => performUndo() },
      { sep: true },
      { label: '🖥️ Bu Bilgisayar', onClick: () => navigateTo('PC') },
      { label: '🗑️ Çöp Kutusu', onClick: () => navigateTo('TRASH') },
      tab && tab.path !== 'PC' && tab.path !== 'TRASH'
        ? { label: '📂 Mevcut Konumu Gezgin\'de Aç', onClick: () => revealInExplorer(tab.path) }
        : null,
      { sep: true },
      { label: '⚙️ Ayarlar', shortcut: 'Ctrl+,', onClick: () => openSettingsDialog() },
    ]);
  });

  // QuickLook Kontrolleri & Yakınlaştırma + Hızlı Ayıklama (Triage)
  $('btn-ql-close').onclick = closeQuickLook;
  $('btn-ql-basket').onclick = triageQuickLookBasket;
  $('btn-ql-delete').onclick = () => triageQuickLookDelete(false);
  if ($('btn-ql-frame-prev')) $('btn-ql-frame-prev').onclick = (e) => stepQuickLookVideoFrame(e?.shiftKey ? -5 : -1);
  if ($('btn-ql-frame-next')) $('btn-ql-frame-next').onclick = (e) => stepQuickLookVideoFrame(e?.shiftKey ? 5 : 1);
  if ($('btn-ql-capture')) $('btn-ql-capture').onclick = captureQuickLookFrame;
  if ($('btn-ql-trim-toggle')) $('btn-ql-trim-toggle').onclick = toggleQuickLookTrimBar;
  if ($('btn-ql-trim-close')) $('btn-ql-trim-close').onclick = () => $('ql-trim-bar')?.classList.add('hidden');
  if ($('btn-ql-set-start')) {
    $('btn-ql-set-start').onclick = () => {
      const vid = $('ql-stage')?.querySelector('video');
      if (vid && $('ql-trim-start')) {
        $('ql-trim-start').value = Number(vid.currentTime || 0).toFixed(1);
        updateTrimDurationUi();
      }
    };
  }
  if ($('btn-ql-set-end')) {
    $('btn-ql-set-end').onclick = () => {
      const vid = $('ql-stage')?.querySelector('video');
      if (vid && $('ql-trim-end')) {
        $('ql-trim-end').value = Number(vid.currentTime || 0).toFixed(1);
        updateTrimDurationUi();
      }
    };
  }
  if ($('ql-trim-start')) $('ql-trim-start').oninput = updateTrimDurationUi;
  if ($('ql-trim-end')) $('ql-trim-end').oninput = updateTrimDurationUi;
  if ($('btn-ql-trim-preview')) {
    $('btn-ql-trim-preview').onclick = () => {
      const vid = $('ql-stage')?.querySelector('video');
      if (!vid) return;
      if (state.qlTrimPreviewLoop) {
        vid.pause();
        state.qlTrimPreviewLoop = false;
        updateTrimPreviewBtnUi();
        return;
      }
      const startSec = Number($('ql-trim-start')?.value || 0);
      const endSec = Number($('ql-trim-end')?.value || 0);
      if (endSec <= startSec + 0.1) return toast('Önizleme için Bitiş > Başlangıç olmalı', 'error');
      vid.currentTime = startSec;
      state.qlTrimPreviewLoop = true;
      updateTrimPreviewBtnUi();
      vid.play().catch(() => {});
    };
  }
  const trimTrack = $('ql-trim-track');
  if (trimTrack) {
    let dragMode = null; // 'a' | 'b' | 'seek'
    const applyTrackPointer = (clientX, mode) => {
      const vid = $('ql-stage')?.querySelector('video');
      const rect = trimTrack.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const dur = getTrimVideoDuration(vid);
      const t = ratio * dur;
      if (mode === 'a') {
        const endSec = Number($('ql-trim-end')?.value || dur);
        const clamped = Math.max(0, Math.min(Math.max(0, endSec - 0.1), t));
        $('ql-trim-start').value = clamped.toFixed(1);
        if (vid) vid.currentTime = clamped;
        updateTrimDurationUi();
      } else if (mode === 'b') {
        const startSec = Number($('ql-trim-start')?.value || 0);
        const clamped = Math.min(dur, Math.max(Math.min(dur, startSec + 0.1), t));
        $('ql-trim-end').value = clamped.toFixed(1);
        if (vid) vid.currentTime = clamped;
        updateTrimDurationUi();
      } else if (vid) {
        vid.currentTime = t;
        updateTrimPlayheadUi();
      }
    };
    trimTrack.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('#ql-trim-handle-a')) dragMode = 'a';
      else if (e.target.closest('#ql-trim-handle-b')) dragMode = 'b';
      else dragMode = 'seek';
      try { trimTrack.setPointerCapture(e.pointerId); } catch {}
      applyTrackPointer(e.clientX, dragMode);
    });
    trimTrack.addEventListener('pointermove', (e) => {
      if (!dragMode) return;
      applyTrackPointer(e.clientX, dragMode);
    });
    const endTrackDrag = (e) => {
      if (!dragMode) return;
      dragMode = null;
      try { trimTrack.releasePointerCapture(e.pointerId); } catch {}
    };
    trimTrack.addEventListener('pointerup', endTrackDrag);
    trimTrack.addEventListener('pointercancel', endTrackDrag);
  }
  if ($('btn-ql-trim-run')) $('btn-ql-trim-run').onclick = runQuickLookTrim;
  $('btn-ql-zoom-in').onclick = () => setQuickLookZoom(state.qlZoom * 1.25);
  $('btn-ql-zoom-out').onclick = () => setQuickLookZoom(state.qlZoom / 1.25);
  $('btn-ql-zoom-reset').onclick = () => setQuickLookZoom(1);
  const brRange = $('ql-brightness-range');
  const brReset = $('btn-ql-bright-reset');
  if (brRange) brRange.oninput = (e) => setQuickLookBrightness(e.target.value);
  if (brReset) brReset.onclick = () => setQuickLookBrightness(100);
  $('btn-ql-prev').onclick = () => {
    if (state.qlIndex > 0) {
      state.qlIndex--;
      renderQuickLookStage(state.qlMediaItems[state.qlIndex]);
    }
  };
  $('btn-ql-next').onclick = () => {
    if (state.qlIndex < state.qlMediaItems.length - 1) {
      state.qlIndex++;
      renderQuickLookStage(state.qlMediaItems[state.qlIndex]);
    }
  };
  const stPrevBtn = $('btn-ql-stage-prev');
  const stNextBtn = $('btn-ql-stage-next');
  if (stPrevBtn) stPrevBtn.onclick = (e) => { e.stopPropagation(); $('btn-ql-prev').click(); };
  if (stNextBtn) stNextBtn.onclick = (e) => { e.stopPropagation(); $('btn-ql-next').click(); };
  $('quicklook-dialog').addEventListener('close', () => {
    $('ql-stage').innerHTML = '';
  });

  const qlStage = $('ql-stage');
  qlStage.addEventListener('wheel', (e) => {
    if (!$('quicklook-dialog').open) return;
    if (!qlStage.querySelector('img, video')) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    setQuickLookZoom(state.qlZoom * factor);
  }, { passive: false });

  let qlPanning = false;
  let qlPanStartX = 0;
  let qlPanStartY = 0;
  let qlOrigX = 0;
  let qlOrigY = 0;
  let qlPanMoved = false;

  qlStage.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || state.qlZoom <= 1.01) return;
    if (e.target.tagName === 'VIDEO' && e.offsetY > e.target.clientHeight - 44) return;
    e.preventDefault();
    qlPanning = true;
    qlPanMoved = false;
    qlPanStartX = e.clientX;
    qlPanStartY = e.clientY;
    qlOrigX = state.qlPanX;
    qlOrigY = state.qlPanY;
    qlStage.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!qlPanning) return;
    const dx = e.clientX - qlPanStartX;
    const dy = e.clientY - qlPanStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) qlPanMoved = true;
    state.qlPanX = qlOrigX + dx;
    state.qlPanY = qlOrigY + dy;
    applyQuickLookTransform();
  });
  window.addEventListener('mouseup', () => {
    if (!qlPanning) return;
    qlPanning = false;
    qlStage.classList.remove('dragging');
  });
  qlStage.addEventListener('click', (e) => {
    if (qlPanMoved) {
      e.preventDefault();
      e.stopPropagation();
      qlPanMoved = false;
    }
  }, true);
  {
    const outsideDialog = (e, dlg) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    for (const dlg of document.querySelectorAll('dialog[closedby="any"]')) {
      let pressedOutside = false;
      dlg.addEventListener('pointerdown', (e) => {
        pressedOutside = dlg.open && outsideDialog(e, dlg);
      });
      dlg.addEventListener('pointerup', (e) => {
        if (pressedOutside && dlg.open && outsideDialog(e, dlg)) {
          if (dlg.id === 'quicklook-dialog') closeQuickLook();
          else dlg.close();
        }
        pressedOutside = false;
      });
    }
  }

  // Fare yan tuşları (Mouse 4 Geri / Mouse 5 İleri)
  window.addEventListener('mousedown', (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      if ($('folder-picker-dialog')?.open) $('btn-fp-back')?.click();
      else if ($('quicklook-dialog').open) $('btn-ql-prev').click();
      else $('btn-back').click();
    } else if (e.button === 4) {
      e.preventDefault();
      if ($('folder-picker-dialog')?.open) $('btn-fp-forward')?.click();
      else if ($('quicklook-dialog').open) $('btn-ql-next').click();
      else $('btn-forward').click();
    }
  });

  // Global Klavye Kısayolları
  document.addEventListener('keydown', (e) => {
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

    if ($('quicklook-dialog').open) {
      if (isInput) {
        if (e.ctrlKey && e.key.toLowerCase() === 's') {
          e.preventDefault();
          saveActiveQuickLookText();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeQuickLook();
        }
        return;
      }
      if (e.key === 'Escape' || e.key === ' ') {
        e.preventDefault();
        closeQuickLook();
      } else if (e.key === 'ArrowLeft') $('btn-ql-prev').click();
      else if (e.key === 'ArrowRight') $('btn-ql-next').click();
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); setQuickLookZoom(state.qlZoom * 1.25); }
      else if (e.key === '-') { e.preventDefault(); setQuickLookZoom(state.qlZoom / 1.25); }
      else if (e.key === '0') { e.preventDefault(); setQuickLookZoom(1); }
      else if (e.key.toLowerCase() === 'b') { e.preventDefault(); triageQuickLookBasket(); }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); captureQuickLookFrame(); }
      else if (!isInput && (e.key === ',' || e.key === '<')) { e.preventDefault(); stepQuickLookVideoFrame(e.shiftKey ? -5 : -1); }
      else if (!isInput && (e.key === '.' || e.key === '>')) { e.preventDefault(); stepQuickLookVideoFrame(e.shiftKey ? 5 : 1); }
      else if (e.key === 'Delete') { e.preventDefault(); triageQuickLookDelete(e.shiftKey); }
      return;
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleDragShelfVisible();
      return;
    }

    if (e.key === 'Escape' && !$('process-modal').classList.contains('hidden')) {
      e.preventDefault();
      closeProcessModal();
      return;
    }

    if (e.key === 'F3') {
      e.preventDefault();
      toggleDualPane();
      return;
    }

    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      openSettingsDialog();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search-input').focus();
      $('search-input').select();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      $('address-wrapper').click();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      createTab('PC', true);
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      closeTab(state.activeTabId);
      return;
    }
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      if ($('folder-picker-dialog')?.open) $('btn-fp-back')?.click();
      else $('btn-back').click();
      return;
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      if ($('folder-picker-dialog')?.open) $('btn-fp-forward')?.click();
      else $('btn-forward').click();
      return;
    }
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); $('btn-up').click(); return; }
    if (e.key === 'F5') { e.preventDefault(); $('btn-refresh').click(); return; }

    if (isInput) return;

    const hasOpenModal = Boolean(document.querySelector('dialog[open]'));
    const activeTab = getActiveTab();
    const inTrash = activeTab && activeTab.path === 'TRASH';
    const inDual = Boolean(state.dualOpen && state.activePane === 'dual');
    const inAnalyzer = Boolean(activeTab && activeTab.viewType === 'analyzer');

    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      performUndo();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (inDual) $('dual-btn-mkdir').click();
      else if (!inTrash) createNewFolder();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      if (hasOpenModal) return;
      e.preventDefault();
      if (inDual) {
        for (const it of state.dualItems) state.dualSelectedPaths.add(it.path);
        updateDualSelectionDomInPlace();
      } else {
        for (const it of state.viewItems) state.selectedPaths.add(it.path);
        renderVirtualList();
        updateStatusCounts();
        updateToolbarButtons();
      }
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      const hasTextSelection = Boolean(window.getSelection && window.getSelection().toString());
      if (hasTextSelection || hasOpenModal) return;
      e.preventDefault();
      if (inDual) setClipboard('copy', Array.from(state.dualSelectedPaths));
      else if (!inTrash) setClipboard('copy');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      if (inDual) setClipboard('cut', Array.from(state.dualSelectedPaths));
      else if (!inTrash) setClipboard('cut');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      if (inDual) pasteToCurrentFolder(state.dualPath);
      else if (!inTrash) pasteToCurrentFolder();
    } else if (e.key === 'F2') {
      e.preventDefault();
      if (inDual) renameSelected(getDualSelectedItems());
      else if (!inTrash) renameSelected();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (inAnalyzer && getDupSelectedPaths().length > 0) deleteSelected(e.shiftKey, getDupSelectedPaths());
      else if (inDual) deleteSelected(e.shiftKey, Array.from(state.dualSelectedPaths));
      else if (inTrash) deleteFromTrash();
      else deleteSelected(e.shiftKey);
    } else if (e.key === 'Escape' && inAnalyzer && getDupSelectedPaths().length > 0) {
      e.preventDefault();
      clearDupSelection();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      if (inDual) $('dual-btn-up').click();
      else $('btn-up').click();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (inAnalyzer && getDupSelectedPaths().length > 0) {
        openQuickLookForSelectedDup();
      } else if (inDual) {
        const sel = getDualSelectedItems();
        if (sel.length > 0 && !sel[0].isDir) openQuickLook(sel[0], state.dualItems);
      } else if (!inTrash) {
        const sel = getSelectedItems();
        if (sel.length > 0 && !sel[0].isDir) openQuickLook(sel[0]);
      }
    } else if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      if (inDual) showPropertiesModal(Array.from(state.dualSelectedPaths));
      else if (!inTrash) showPropertiesModal();
    } else if (e.key === 'Enter') {
      if (inDual) {
        const sel = getDualSelectedItems();
        if (sel.length === 1) {
          if (sel[0].isDir) navigateDual(sel[0].path);
          else openExternally(sel[0].path);
        }
      } else {
        const sel = getSelectedItems();
        if (sel.length === 1) {
          activateItem(sel[0]);
        }
      }
    } else if (e.key.toLowerCase() === 'b' && !e.ctrlKey) {
      e.preventDefault();
      if (inDual) toggleSelectedInBasket(getDualSelectedItems());
      else if (!inTrash) toggleSelectedInBasket();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (inDual) {
        if (state.dualItems.length === 0) return;
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = Math.max(0, Math.min(state.dualItems.length - 1, state.dualLastClickedIdx + step));
        handleDualItemSelect(next, e);
        const listEl = $('dual-list');
        const rowEl = listEl?.querySelector(`.dual-row[data-index="${next}"]`);
        if (rowEl) rowEl.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (state.viewItems.length === 0) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(state.viewItems.length - 1, state.lastClickedIndex + step));
      handleItemSelect(next, e);
      const vp = $('virtual-viewport');
      const { rowHeight, cols } = getLayoutMetrics();
      const rowTop = Math.floor(next / cols) * rowHeight;
      if (rowTop < vp.scrollTop) vp.scrollTop = rowTop;
      else if (rowTop + rowHeight > vp.scrollTop + vp.clientHeight) vp.scrollTop = rowTop + rowHeight - vp.clientHeight;
    }
  });
}


export {
  bindEvents,
};
