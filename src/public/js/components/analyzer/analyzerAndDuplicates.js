import { state } from '../../store/appState.js';
import { $, esc } from '../../utils/dom.js';
import { getActiveTab, navigateTo, renderBreadcrumbs, renderTabs, updateNavButtons } from '../navigation/tabsAndRouter.js';
import { renderSidebarAndDashboard, updateSidebarActive } from '../sidebar/treeAndDashboard.js';
import { formatBytes, formatCacheAge } from '../../utils/formatters.js';
import { buildCacheBannerHtml } from '../shared/cacheBanner.js';
import { pollTransferStatus } from '../operations/processAndErrorCenter.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';
import { CAT_META, ICONS } from '../../constants/uiConstants.js';
import { openQuickLook } from '../quicklook/quicklookViewer.js';
import { openExternally } from '../operations/fileActions.js';
import { applySortAndFilter } from '../scroller/columnHeadersAndStudio.js';
import { findAndRenderDuplicates, renderDuplicatesResult } from './duplicatesPanel.js';

// ---------- Disk & Klasör Analizörü ----------
function restoreTabAnalyzerView(tab) {
  if (!tab) return;
  const targetPath = tab.analyzerPath || (tab.path !== 'PC' ? tab.path : state.drives[0]?.path || 'C:\\');
  $('pc-dashboard').classList.add('hidden');
  $('explorer-view').classList.add('hidden');
  $('analyzer-view').classList.remove('hidden');

  renderBreadcrumbs(targetPath);
  updateNavButtons();
  updateSidebarActive(targetPath);

  $('analyzer-title').textContent = `📊 Doluluk Analizi: ${targetPath}`;
  $('btn-analyzer-live').dataset.path = targetPath;
  $('btn-analyzer-dupes').dataset.path = targetPath;

  const cacheBanner = $('analyzer-cache-banner');
  if (tab.analyzerLoading) {
    if (cacheBanner) cacheBanner.classList.add('hidden');
    $('analyzer-loading').classList.remove('hidden');
    $('analyzer-subtitle').textContent = 'Tarama / analiz devam ediyor...';
    $('stacked-bar').innerHTML = '';
    $('category-cards').innerHTML = '';
    $('top-files-list').innerHTML = '';
    $('top-folders-list').innerHTML = '';
  } else {
    $('analyzer-loading').classList.add('hidden');
    if (tab.analyzerData) {
      const d = tab.analyzerData;
      $('analyzer-subtitle').textContent = `${d.totalFiles.toLocaleString('tr-TR')} dosya • ${formatBytes(d.totalBytes)} (${d.fromCache ? 'Önbellekten' : (d.source === 'sqlite-cache' ? 'SSD İndeksinden Anında' : 'Canlı Tarama')}${d.cancelled ? ' • Kısmi' : ''})`;
      if (cacheBanner) {
        const html = buildCacheBannerHtml(d, 'btn-cache-rescan-analyzer');
        cacheBanner.classList.toggle('hidden', !html);
        cacheBanner.classList.toggle('stale', Boolean(d.stale));
        cacheBanner.innerHTML = html;
        const rBtn = $('btn-cache-rescan-analyzer');
        if (rBtn) rBtn.onclick = () => openAnalyzer(targetPath, 'live');
      }
      renderAnalyzerResult(d);
    } else if (cacheBanner) {
      cacheBanner.classList.add('hidden');
    }
  }

  const panel = $('dupes-panel');
  if (tab.dupesLoading) {
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="analyzer-loading"><div class="spinner"></div><span>Kopya dosyalar arka planda taranıyor (sol alt panelden durdurup devam ettirebilirsiniz)...</span></div>';
  } else if (tab.dupesData) {
    panel.classList.remove('hidden');
    renderDuplicatesResult(tab.dupesData);
  } else if (tab.dupesError) {
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="muted-text">${esc(tab.dupesError)}</div>`;
  } else {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  }
}

async function openAnalyzer(targetPath, mode = 'auto') {
  const originTab = getActiveTab();
  const pathToAnalyze = targetPath || (originTab && originTab.path !== 'PC' ? originTab.path : state.drives[0]?.path || 'C:\\');

  if (originTab) {
    const pathChanged = originTab.analyzerPath && originTab.analyzerPath !== pathToAnalyze;
    originTab.viewType = 'analyzer';
    originTab.analyzerPath = pathToAnalyze;
    originTab.analyzerLoading = true;
    if (pathChanged) {
      originTab.dupesData = null;
      originTab.dupesLoading = false;
      originTab.dupesError = '';
    }
    renderTabs();
    restoreTabAnalyzerView(originTab);
  }

  try {
    if (mode === 'live') setTimeout(pollTransferStatus, 80);
    const data = await api(`/api/analyze?path=${encodeURIComponent(pathToAnalyze)}&mode=${mode}`);
    if (originTab) {
      originTab.analyzerLoading = false;
      originTab.analyzerData = data;
      renderTabs();
      if (state.activeTabId === originTab.id && originTab.viewType === 'analyzer') {
        restoreTabAnalyzerView(originTab);
      } else if (!data.cancelled) {
        toast(`📊 ${pathToAnalyze} disk analizi tamamlandı`, 'success');
      }
    }
  } catch (err) {
    if (originTab) originTab.analyzerLoading = false;
    $('analyzer-loading').classList.add('hidden');
    toast(`Analiz hatası: ${err.message}`, 'error');
  } finally {
    pollTransferStatus();
  }
}

function renderAnalyzerResult(data) {
  const bar = $('stacked-bar');
  const cards = $('category-cards');
  bar.innerHTML = '';
  cards.innerHTML = '';

  for (const c of data.categories) {
    const meta = CAT_META[c.category] || CAT_META.other;
    if (c.percent > 0) {
      const seg = document.createElement('div');
      seg.className = 'stacked-seg';
      seg.style.width = `${Math.max(1, c.percent)}%`;
      seg.style.background = meta.color;
      seg.title = `${meta.label}: ${formatBytes(c.bytes)} (%${c.percent})`;
      bar.appendChild(seg);
    }

    const card = document.createElement('div');
    card.className = 'cat-card';
    card.style.borderLeftColor = meta.color;
    card.innerHTML = `
      <div class="cat-card-title">${meta.icon} ${meta.label}</div>
      <div class="cat-card-size">${formatBytes(c.bytes)}</div>
      <div class="cat-card-meta">${c.count.toLocaleString('tr-TR')} dosya • %${c.percent}</div>
    `;
    cards.appendChild(card);
  }

  const tf = $('top-files-list');
  tf.innerHTML = '';
  const topFilesNorm = (data.topFiles || []).map((x) => ({ ...x, isDir: false }));
  for (const f of topFilesNorm) {
    const row = document.createElement('div');
    row.className = 'analyzer-row';
    row.title = f.path;
    row.innerHTML = `
      <span>${ICONS[f.category] || '📃'}</span>
      <span class="analyzer-row-name">${esc(f.name)}</span>
      <span class="analyzer-row-size">${formatBytes(f.size)}</span>
    `;
    row.onclick = () => openQuickLook(f, topFilesNorm);
    row.ondblclick = () => openExternally(f.path);
    tf.appendChild(row);
  }

  const tdir = $('top-folders-list');
  tdir.innerHTML = '';
  if (!data.topFolders || data.topFolders.length === 0) {
    tdir.innerHTML = '<div class="muted-text" style="padding:10px">Alt klasör dökümü için "Canlı Tara & Güncelle" butonunu kullanın.</div>';
  } else {
    for (const d of data.topFolders) {
      const row = document.createElement('div');
      row.className = 'analyzer-row';
      row.innerHTML = `
        <span>📁</span>
        <span class="analyzer-row-name">${esc(d.name)}</span>
        <span class="analyzer-row-size">${formatBytes(d.bytes)}</span>
      `;
      row.onclick = () => navigateTo(d.path);
      tdir.appendChild(row);
    }
  }
}

// ---------- Klasör Boyutu, Tarihle Klasörle, Kopya Bulucu & Çift Panel ----------
async function cancelPendingFolderSizes(showToast = false) {
  if (!state.folderSizeRunning) return;
  state.folderSizeRunning = false;
  await fetch('/api/transfer/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'scan', action: 'cancel' }),
  }).catch(() => {});
  const btn = $('btn-folder-sizes');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '📏 Boyutlar';
  }
  if (showToast) toast('Klasör boyutu hesaplama iptal edildi');
  pollTransferStatus();
}

async function calculateCurrentFolderSizes(force = false) {
  if (state.folderSizeRunning) {
    await cancelPendingFolderSizes(true);
    return;
  }
  const tab = getActiveTab();
  if (!tab || tab.path === 'PC') return;
  const dirs = state.rawItems.filter((it) => it.isDir);
  if (dirs.length === 0) return toast('Bu klasörde alt klasör yok');

  const btn = $('btn-folder-sizes');
  const startPath = tab.path;
  state.folderSizeRunning = true;
  state.folderSizePath = startPath;
  btn.disabled = false;
  btn.textContent = '⏹️ Boyut İptal';
  setTimeout(pollTransferStatus, 80);

  try {
    const res = await api('/api/folder-sizes', {
      method: 'POST',
      body: JSON.stringify({ parentDir: startPath, paths: dirs.map((d) => d.path), force: Boolean(force) }),
    });
    if (res.sizes) {
      for (const [fp, bytes] of Object.entries(res.sizes)) {
        state.folderSizesCache.set(fp, bytes);
      }
    }
    if (res.cancelled) return;

    let totalFolderBytes = 0;
    for (const val of Object.values(res.sizes || {})) totalFolderBytes += val || 0;

    const curTab = getActiveTab();
    if (curTab && curTab.path === startPath && curTab.viewType === 'explorer') {
      for (const item of state.rawItems) {
        if (item.isDir && res.sizes && res.sizes[item.path] !== undefined) {
          item.size = res.sizes[item.path];
          item.sizeCalculated = true;
        }
      }
      state.sortBy = 'size';
      state.sortDir = 'desc';
      $('sort-by').value = 'size';
      $('btn-sort-dir').textContent = '▼';
      applySortAndFilter();
    }
    if (res.fromCache) {
      toast(
        res.stale
          ? `💡 Boyutlar önbellekten yüklendi (${formatCacheAge(res.cachedAt)}) — değişiklik algılandı! Yenilemek için Shift + 📏 Boyutlar tıklayın`
          : `⚡ ${dirs.length} klasör boyutu önbellekten yüklendi (Canlı tarama için Shift+Tık)`,
        res.stale ? 'info' : 'success'
      );
    } else {
      toast(`${dirs.length} klasör boyutu hesaplandı (${startPath} • Toplam: ${formatBytes(totalFolderBytes)})`, 'success');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    toast(err.message, 'error');
  } finally {
    state.folderSizeRunning = false;
    state.folderSizePath = '';
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📏 Boyutlar';
    }
    pollTransferStatus();
  }
}


// ---------- Arka Plan İndeksleyici & Arama ----------
let indexPollTimer = null;
async function startBackgroundIndex(targetPath) {
  try {
    await api('/api/index/start', { method: 'POST', body: JSON.stringify({ path: targetPath }) });
    toast(`${targetPath} arka planda HDD dostu şekilde indeksleniyor...`);
    pollIndexStatus();
    pollTransferStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pollIndexStatus() {
  clearTimeout(indexPollTimer);
  try {
    const st = await api('/api/index/status');
    const pill = $('index-pill');
    const btn = $('btn-toggle-index');
    if (st.running) {
      pill.classList.add('indexing');
      $('index-pill-text').textContent = `İndeksleniyor: ${st.indexedFiles.toLocaleString('tr-TR')}`;
      btn.textContent = '⏹ Durdur';
      indexPollTimer = setTimeout(pollIndexStatus, 900);
    } else {
      pill.classList.remove('indexing');
      $('index-pill-text').textContent = `İndeks: ${(st.totalEntries || 0).toLocaleString('tr-TR')} öğe`;
      btn.textContent = '⚡ İndeksle';
    }
    const cnt = (st.cachedThumbCount || 0).toLocaleString('tr-TR');
    const mb = formatBytes(st.cachedThumbBytes || 0);
    $('cache-badge').textContent = `🛡️ SSD Önbellek: ${cnt} kapak (${mb})`;
  } catch {}
}

async function togglePin(targetPath, name, remove = false) {
  try {
    const res = await api('/api/pins', { method: 'POST', body: JSON.stringify({ path: targetPath, name, remove }) });
    state.pins = res.pins;
    renderSidebarAndDashboard();
    toast(remove ? 'Sabitleme kaldırıldı' : 'Sol menüye sabitlendi', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function executeGlobalSearch() {
  const q = $('search-input').value.trim();
  const scope = $('search-scope').value;
  if (scope === 'folder') {
    applySortAndFilter();
    return;
  }
  if (!q) {
    const tab = getActiveTab();
    if (tab) navigateTo(tab.path, { pushHistory: false });
    return;
  }

  const tab = getActiveTab();
  let scopePath = '';
  if (scope === 'drive' && tab && tab.path !== 'PC') {
    scopePath = tab.path.slice(0, 3);
  }

  $('pc-dashboard').classList.add('hidden');
  $('analyzer-view').classList.add('hidden');
  $('explorer-view').classList.remove('hidden');

  const t0 = performance.now();
  try {
    const data = await api('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: q, scopePath, limit: 1000 }),
    });
    const ms = (performance.now() - t0).toFixed(1);
    state.rawItems = data.items;
    state.selectedPaths.clear();
    $('status-timing').textContent = `Arama: ${ms} ms (${data.source})`;
    applySortAndFilter();
  } catch (err) {
    toast(err.message, 'error');
  }
}


export {
  calculateCurrentFolderSizes,
  executeGlobalSearch,
  findAndRenderDuplicates,
  openAnalyzer,
  pollIndexStatus,
  restoreTabAnalyzerView,
  startBackgroundIndex,
  togglePin,
};
