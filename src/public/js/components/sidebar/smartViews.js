import { state } from '../../store/appState.js';
import { $, esc } from '../../utils/dom.js';
import { getActiveTab, navigateTo } from '../navigation/tabsAndRouter.js';
import { cancelPendingThumbs, scheduleThumbBatch } from '../scroller/thumbLoaderAndStoryboard.js';
import { api } from '../../services/apiClient.js';
import { applySortAndFilter } from '../scroller/columnHeadersAndStudio.js';
import { updateStatusCounts, updateToolbarButtons } from '../scroller/selectionAndMarquee.js';
import { toast } from '../shared/toast.js';

const DEFAULT_SMART_VIEWS = [
  { id: 'sv_vid_7d', icon: '🎬', name: 'Son 7 Gün Videoları', builtin: true, criteria: { category: 'video', withinDays: 7, sortBy: 'mtime' } },
  { id: 'sv_big_500mb', icon: '🐘', name: '500 MB+ Büyük Dosyalar', builtin: true, criteria: { minSize: 500 * 1024 * 1024, sortBy: 'size' } },
  { id: 'sv_img_30d', icon: '🖼️', name: 'Bu Ay Fotoğrafları', builtin: true, criteria: { category: 'image', withinDays: 30, sortBy: 'mtime' } },
];

function loadSmartViews() {
  let saved = null;
  try {
    const raw = JSON.parse(localStorage.getItem('ld_smart_views') || 'null');
    if (Array.isArray(raw) && raw.length > 0) saved = raw;
  } catch {}
  state.smartViews = saved || DEFAULT_SMART_VIEWS.map((x) => ({ ...x, criteria: { ...x.criteria } }));
  try {
    const openFlag = localStorage.getItem('ld_smart_views_open');
    if (openFlag === '0') state.smartViewsOpen = false;
  } catch {}
}

function saveSmartViews() {
  try {
    localStorage.setItem('ld_smart_views', JSON.stringify(state.smartViews || []));
  } catch {}
}

function renderSmartViewsSidebar() {
  const listEl = $('sb-smart-views-list');
  const cntEl = $('sb-smart-views-count');
  const chevEl = $('sb-smart-views-chevron');
  if (!listEl) return;
  const views = state.smartViews || [];
  if (cntEl) cntEl.textContent = String(views.length);
  if (chevEl) chevEl.textContent = state.smartViewsOpen ? '▾' : '▸';
  listEl.classList.toggle('hidden', !state.smartViewsOpen);
  listEl.innerHTML = '';

  for (const sv of views) {
    const row = document.createElement('div');
    row.className = `sb-smart-view-item${state.smartViewCtx && state.smartViewCtx.id === sv.id ? ' active' : ''}`;
    row.title = sv.name;
    row.innerHTML = `
      <span>${esc(sv.icon || '✨')}</span>
      <span class="sb-smart-view-name">${esc(sv.name)}</span>
    `;
    row.onclick = () => openSmartView(sv);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCustomContextMenu(e, [
        { label: '✨ Akıllı Klasörü Aç', bold: true, onClick: () => openSmartView(sv) },
        !sv.builtin ? { label: '🗑️ Akıllı Klasörden Kaldır', danger: true, onClick: () => {
          state.smartViews = state.smartViews.filter((x) => x.id !== sv.id);
          saveSmartViews();
          renderSmartViewsSidebar();
          if (state.smartViewCtx && state.smartViewCtx.id === sv.id) closeSmartView();
        } } : null,
      ]);
    };
    listEl.appendChild(row);
  }
}

async function openSmartView(sv) {
  if (!sv) return;
  const tab = getActiveTab();
  if (!tab) return;
  try {
    cancelPendingThumbs();
    state.thumbSessionId++;
    state.selectedPaths.clear();
    state.lastClickedIndex = -1;
    state.filterOnlyMatched = false;
    state.relatedCtx = null;
    state.smartViewCtx = sv;
    $('related-bar')?.classList.add('hidden');

    tab.viewType = 'explorer';
    $('analyzer-view').classList.add('hidden');
    $('pc-dashboard').classList.add('hidden');
    $('trash-bar').classList.add('hidden');
    $('explorer-view').classList.remove('hidden');

    const res = await api('/api/smart-view', {
      method: 'POST',
      body: JSON.stringify({ criteria: sv.criteria || {} }),
    });
    const bar = $('smart-view-bar');
    if (bar) bar.classList.remove('hidden');
    if ($('smart-view-title')) $('smart-view-title').textContent = `${sv.icon || '✨'} ${sv.name}`;
    const idxNote = (res.totalIndexed || 0) === 0
      ? ' • ⚠️ İndeks boş: üstteki ⚡ İndeksle butonuyla diski tarayın'
      : ` • ${res.items.length} öğe (${res.durationMs} ms)`;
    if ($('smart-view-summary')) $('smart-view-summary').textContent = `İndeksten Sanal Görünüm${idxNote}`;

    state.rawItems = res.items || [];
    renderSmartViewsSidebar();
    applySortAndFilter();
    updateStatusCounts();
    updateToolbarButtons();
    $('status-timing').textContent = `${res.durationMs} ms (sanal)`;
    if (state.thumbMode === 'viewport' || state.thumbMode === 'all') scheduleThumbBatch();
  } catch (err) {
    toast(`Akıllı klasör açılamadı: ${err.message}`, 'error');
  }
}

function closeSmartView() {
  state.smartViewCtx = null;
  $('smart-view-bar')?.classList.add('hidden');
  renderSmartViewsSidebar();
  const tab = getActiveTab();
  navigateTo(tab && tab.path ? tab.path : 'PC', { pushHistory: false, forceRefresh: false });
}


export {
  closeSmartView,
  loadSmartViews,
  openSmartView,
  renderSmartViewsSidebar,
  saveSmartViews,
};
