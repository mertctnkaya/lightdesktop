import { $ } from '../../utils/dom.js';
import { getClientNameTokensPreview, parseClientRefTime } from '../../core/transferRulesEngine.js';
import { MONTH_NAMES_TR } from '../../constants/uiConstants.js';
import { state } from '../../store/appState.js';
import { closeQuickLook } from './quicklookViewer.js';
import { getActiveTab, navigateTo } from '../navigation/tabsAndRouter.js';
import { api } from '../../services/apiClient.js';
import { applySortAndFilter } from '../scroller/columnHeadersAndStudio.js';
import { getSelectedItems, updateToolbarButtons } from '../scroller/selectionAndMarquee.js';
import { scheduleThumbBatch } from '../scroller/thumbLoaderAndStoryboard.js';
import { toast } from '../shared/toast.js';

function openRelatedDialog(item) {
  if (!item || item.isDir) return;
  const dlg = $('related-dialog');
  if (!dlg) return;
  dlg._targetItem = item;
  const refMs = parseClientRefTime(item);
  const dt = new Date(refMs);
  const dateStr = dt.toLocaleDateString('tr-TR');
  const timeStr = dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const tokens = getClientNameTokensPreview(item.name);

  $('related-dlg-sub').textContent = `${item.name} • Tarih: ${dateStr} ${timeStr}`;
  $('rel-desc-nearTime').textContent = `${dateStr} • ${timeStr} civarı (±1 saat)`;
  $('rel-desc-sameDay').textContent = `${dateStr} günündeki tüm kayıtlar`;
  $('rel-desc-sameWeek').textContent = `${dateStr} merkezli ±3 gün aralığı`;
  $('rel-desc-sameMonth').textContent = `${MONTH_NAMES_TR[dt.getMonth()]} ${dt.getFullYear()} ayındaki dosyalar`;
  $('rel-desc-similarName').textContent = tokens.length > 0
    ? `Anahtar kelimeler: ${tokens.join(', ')}`
    : `Dosya adı başlangıcıyla eşleşen seri dosyalar`;

  if (state.relatedCtx) {
    if ($('rel-dlg-scope')) $('rel-dlg-scope').value = state.relatedCtx.scope || 'folder';
    if ($('rel-dlg-cat')) $('rel-dlg-cat').value = state.relatedCtx.sameCategoryOnly || 'media';
  }
  if (!dlg.open) dlg.showModal();
}

function updateRelatedBarUi() {
  const bar = $('related-bar');
  const ctx = state.relatedCtx;
  if (!bar) return;
  if (!ctx) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const modeNames = {
    nearTime: '±1 Saat',
    sameDay: 'Aynı Gün',
    sameWeek: '±3 Gün',
    sameMonth: 'Aynı Ay',
    similarName: 'Benzer İsim',
  };
  $('related-bar-title').textContent = `✨ ${ctx.item.name}`;
  $('related-bar-summary').textContent = `${modeNames[ctx.mode] || ctx.mode} • ${state.rawItems.length} eşleşme (${ctx.durationMs || 0} ms)`;
  bar.querySelectorAll('.rel-mode-btn[data-rel-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.relMode === ctx.mode);
  });
  if ($('related-bar-scope')) $('related-bar-scope').value = ctx.scope;
  if ($('related-bar-cat')) $('related-bar-cat').value = ctx.sameCategoryOnly;
}

async function runRelatedSearch({ item, mode = 'sameDay', scope = 'folder', sameCategoryOnly = 'media' }) {
  if (!item || item.isDir) return;
  const relDlg = $('related-dialog');
  if (relDlg && relDlg.open) relDlg.close();
  if ($('quicklook-dialog')?.open) closeQuickLook();

  const tab = getActiveTab();
  const returnPath = (state.relatedCtx && state.relatedCtx.returnPath) || (tab && tab.path) || 'PC';

  $('pc-dashboard').classList.add('hidden');
  $('analyzer-view').classList.add('hidden');
  $('trash-bar').classList.add('hidden');
  $('explorer-view').classList.remove('hidden');

  try {
    const data = await api('/api/related', {
      method: 'POST',
      body: JSON.stringify({
        filePath: item.path,
        fileName: item.name,
        mtime: item.mtime,
        category: item.category,
        mode,
        scope,
        sameCategoryOnly,
      }),
    });
    state.relatedCtx = {
      item,
      mode,
      scope: data.scopeUsed || scope,
      sameCategoryOnly,
      returnPath,
      durationMs: data.durationMs || 0,
    };
    state.rawItems = data.items || [];
    state.selectedPaths.clear();
    state.selectedPaths.add(item.path);
    updateRelatedBarUi();
    applySortAndFilter();
    updateToolbarButtons();
    const vp = $('virtual-viewport');
    if (vp) vp.scrollTop = 0;
    if (state.thumbMode === 'viewport' || state.thumbMode === 'all') scheduleThumbBatch();
    $('status-timing').textContent = `${data.durationMs} ms (${data.source === 'sqlite' ? 'SQLite İndeks' : 'Canlı Klasör'})`;
    if (data.fallbackNotice) toast(data.fallbackNotice, 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function exitRelatedMode() {
  const ctx = state.relatedCtx;
  state.relatedCtx = null;
  $('related-bar')?.classList.add('hidden');
  if (ctx && ctx.returnPath && ctx.returnPath !== 'PC' && ctx.returnPath !== 'TRASH') {
    navigateTo(ctx.returnPath, { pushHistory: false, forceRefresh: false });
  } else {
    const tab = getActiveTab();
    navigateTo(tab ? tab.path : 'PC', { pushHistory: false });
  }
}

function bindRelatedHandlers() {
  const btnToolbarRel = $('btn-find-related');
  if (btnToolbarRel) {
    btnToolbarRel.onclick = () => {
      const sel = getSelectedItems();
      if (sel.length === 1 && !sel[0].isDir) openRelatedDialog(sel[0]);
    };
  }
  const btnDlgClose = $('btn-rel-dlg-close');
  if (btnDlgClose) btnDlgClose.onclick = () => $('related-dialog').close();

  document.querySelectorAll('#related-dialog .rel-card[data-rel-pick]').forEach((card) => {
    card.onclick = () => {
      const dlg = $('related-dialog');
      const item = dlg && dlg._targetItem;
      if (!item) return;
      runRelatedSearch({
        item,
        mode: card.dataset.relPick,
        scope: $('rel-dlg-scope')?.value || 'folder',
        sameCategoryOnly: $('rel-dlg-cat')?.value || 'media',
      });
    };
  });

  document.querySelectorAll('#related-bar .rel-mode-btn[data-rel-mode]').forEach((btn) => {
    btn.onclick = () => {
      if (!state.relatedCtx) return;
      runRelatedSearch({
        item: state.relatedCtx.item,
        mode: btn.dataset.relMode,
        scope: $('related-bar-scope')?.value || state.relatedCtx.scope,
        sameCategoryOnly: $('related-bar-cat')?.value || state.relatedCtx.sameCategoryOnly,
      });
    };
  });
  const barScope = $('related-bar-scope');
  if (barScope) {
    barScope.onchange = () => {
      if (!state.relatedCtx) return;
      runRelatedSearch({
        item: state.relatedCtx.item,
        mode: state.relatedCtx.mode,
        scope: barScope.value,
        sameCategoryOnly: $('related-bar-cat')?.value || state.relatedCtx.sameCategoryOnly,
      });
    };
  }
  const barCat = $('related-bar-cat');
  if (barCat) {
    barCat.onchange = () => {
      if (!state.relatedCtx) return;
      runRelatedSearch({
        item: state.relatedCtx.item,
        mode: state.relatedCtx.mode,
        scope: $('related-bar-scope')?.value || state.relatedCtx.scope,
        sameCategoryOnly: barCat.value,
      });
    };
  }
  const btnBarClose = $('btn-related-close');
  if (btnBarClose) btnBarClose.onclick = exitRelatedMode;
}


export {
  bindRelatedHandlers,
  openRelatedDialog,
  runRelatedSearch,
};
