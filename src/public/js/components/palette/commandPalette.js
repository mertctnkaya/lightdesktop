import { $, esc } from '../../utils/dom.js';
import { organizeCurrentFolderByDate } from '../operations/propertiesAndOrganize.js';
import { calculateCurrentFolderSizes, findAndRenderDuplicates, openAnalyzer } from '../analyzer/analyzerAndDuplicates.js';
import { renderBasket, toggleDualPane } from '../operations/basketAndDualPane.js';
import { toggleDragShelfVisible } from '../sidebar/dragShelf.js';
import { openSettingsDialog } from '../settings/settingsAndWelcome.js';
import { state } from '../../store/appState.js';
import { toast } from '../shared/toast.js';
import { openSmartView } from '../sidebar/smartViews.js';
import { getFolderTitle, navigateTo } from '../navigation/tabsAndRouter.js';
import { QUICK_ICONS } from '../../constants/uiConstants.js';
import { applySortAndFilter, updateStudioMatchPreview } from '../scroller/columnHeadersAndStudio.js';

let cmdPaletteActiveIdx = 0;
let cmdPaletteEntries = [];

function buildCommandPaletteEntries(rawQuery) {
  const q = String(rawQuery || '').trim();
  const qLow = q.toLocaleLowerCase('tr-TR');
  const results = [];

  // 1) Hızlı Tek-Satır Akıllı Filtre Yorumlayıcı
  if (q && (q.includes('>') || q.includes('<') || q.startsWith('.') || /\b(mb|gb|video|foto|görsel|bugün|kopya)\b/i.test(q))) {
    results.push({
      icon: '🎯',
      title: `Klasörde Hızlı Filtre Uygula: "${q}"`,
      sub: 'Gelişmiş Filtre Stüdyosu kriterlerini doldur ve uygula',
      badge: 'Hızlı Filtre',
      run: () => applyQuickStudioQuery(q),
    });
  }

  const actions = [
    { icon: '📅', title: 'Tarihe Göre Klasörle', sub: 'Dosyaları Yıl/Ay alt klasörlerine kopyala veya taşı', badge: 'Eylem', run: organizeCurrentFolderByDate },
    { icon: '📊', title: 'Disk ve Klasör Analizi Aç', sub: 'Kategori dökümü ve en büyük dosyalar', badge: 'Eylem', run: () => openAnalyzer() },
    { icon: '🧬', title: 'Kopya Dosyaları Bul', sub: 'Birebir aynı dosyaları bul ve temizle', badge: 'Eylem', run: () => findAndRenderDuplicates(false) },
    { icon: '📏', title: 'Klasör Boyutlarını Hesapla', sub: 'Açık klasördeki alt klasör boyutlarını sırala', badge: 'Eylem', run: () => calculateCurrentFolderSizes(false) },
    { icon: '◫', title: 'Çift Panel Aç / Kapat (F3)', sub: 'Yan yana dosya yönetimi', badge: 'Eylem', run: toggleDualPane },
    { icon: '🧲', title: 'Geçici Yüzen Rafı Aç / Kapat (Ctrl+Shift+S)', sub: 'Dosyaları park edip başka klasöre taşı', badge: 'Eylem', run: () => toggleDragShelfVisible() },
    { icon: '🎯', title: 'Gelişmiş Filtre & Aralık Stüdyosu', sub: 'Numara, tarih, boyut ve RegExp filtresi', badge: 'Eylem', run: () => $('btn-range-studio')?.click() },
    { icon: '⚙️', title: 'Ayarlar Merkezi (Ctrl+,)', sub: 'Görünüm, medya ve Windows entegrasyonu', badge: 'Eylem', run: openSettingsDialog },
    { icon: '🧹', title: 'Sepeti Temizle', sub: 'Toplama sepetindeki tüm öğeleri çıkar', badge: 'Eylem', run: () => { state.basket.clear(); renderBasket(); toast('Sepet temizlendi'); } },
  ];

  for (const act of actions) {
    if (!qLow || act.title.toLocaleLowerCase('tr-TR').includes(qLow) || act.sub.toLocaleLowerCase('tr-TR').includes(qLow)) {
      results.push(act);
    }
  }

  for (const sv of state.smartViews || []) {
    if (!qLow || sv.name.toLocaleLowerCase('tr-TR').includes(qLow)) {
      results.push({
        icon: sv.icon || '✨',
        title: `Akıllı Klasör: ${sv.name}`,
        sub: 'İndeksten anlık sanal görünüm',
        badge: 'Sanal',
        run: () => openSmartView(sv),
      });
    }
  }

  const seenPaths = new Set();
  const addNav = (icon, name, p, badge) => {
    if (!p || seenPaths.has(p.toLowerCase())) return;
    seenPaths.add(p.toLowerCase());
    if (!qLow || name.toLocaleLowerCase('tr-TR').includes(qLow) || p.toLocaleLowerCase('tr-TR').includes(qLow)) {
      results.push({ icon, title: name, sub: p, badge, run: () => navigateTo(p) });
    }
  };
  for (const d of state.drives || []) addNav('💽', d.label || d.path, d.path, 'Disk');
  for (const qItem of state.quickAccess || []) addNav(QUICK_ICONS[qItem.icon] || '📁', qItem.name, qItem.path, 'Hızlı');
  for (const pItem of state.pins || []) addNav('📌', pItem.name || getFolderTitle(pItem.path), pItem.path, 'Sabit');
  for (const rt of state.recentTransferTargets || []) addNav('🕒', rt.name || getFolderTitle(rt.path), rt.path, 'Son Yol');

  return results.slice(0, 24);
}

function applyQuickStudioQuery(q) {
  const studio = $('range-studio');
  if (studio && studio.classList.contains('hidden')) {
    studio.classList.remove('hidden');
    $('btn-range-studio')?.classList.add('active');
  }
  ['flt-pattern', 'flt-num-min', 'flt-num-max', 'flt-date-min', 'flt-date-max', 'flt-size-min', 'flt-size-max', 'flt-ext'].forEach((id) => {
    if ($(id)) $(id).value = '';
  });
  $('flt-regex').checked = false;
  $('flt-category').value = 'all';

  let rest = String(q || '');
  const szMatch = /([<>])\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb)?/i.exec(rest);
  if (szMatch) {
    const mult = szMatch[3]?.toLowerCase() === 'gb' ? 1073741824 : (szMatch[3]?.toLowerCase() === 'kb' ? 1024 : 1048576);
    if (szMatch[1] === '>') {
      $('flt-size-min').value = szMatch[2];
      $('flt-size-min-unit').value = String(mult);
    } else {
      $('flt-size-max').value = szMatch[2];
      $('flt-size-max-unit').value = String(mult);
    }
    rest = rest.replace(szMatch[0], '');
  }
  if (/\bvideo\w*\b/i.test(rest)) { $('flt-category').value = 'video'; rest = rest.replace(/\bvideo\w*\b/gi, ''); }
  else if (/\b(foto\w*|resim\w*|görsel\w*|img)\b/i.test(rest)) { $('flt-category').value = 'image'; rest = rest.replace(/\b(foto\w*|resim\w*|görsel\w*|img)\b/gi, ''); }
  else if (/\bbugün\b/i.test(rest)) {
    const today = new Date().toISOString().slice(0, 10);
    $('flt-date-min').value = today;
    $('flt-date-max').value = today;
    rest = rest.replace(/\bbugün\b/gi, '');
  }
  else if (/\bkopya\b/i.test(rest)) {
    $('flt-pattern').value = '\\(\\d+\\)\\.[^.]+$';
    $('flt-regex').checked = true;
    rest = rest.replace(/\bkopya\b/gi, '');
  }
  const extMatch = /(^|\s)(\.[a-z0-9]{2,6})\b/i.exec(rest);
  if (extMatch) {
    $('flt-ext').value = extMatch[2];
    rest = rest.replace(extMatch[0], '');
  }
  const leftover = rest.trim();
  if (leftover && !$('flt-pattern').value) $('flt-pattern').value = `*${leftover}*`;

  state.filterOnlyMatched = true;
  $('btn-flt-clear-view')?.classList.remove('hidden');
  updateStudioMatchPreview();
  applySortAndFilter();
}

function renderCommandPaletteList(query) {
  const listEl = $('cmd-palette-list');
  if (!listEl) return;
  cmdPaletteEntries = buildCommandPaletteEntries(query);
  if (cmdPaletteActiveIdx >= cmdPaletteEntries.length) cmdPaletteActiveIdx = 0;
  listEl.innerHTML = '';
  if (cmdPaletteEntries.length === 0) {
    listEl.innerHTML = '<div class="muted-text" style="padding:14px;text-align:center;">Eşleşen komut veya yol bulunamadı</div>';
    return;
  }
  cmdPaletteEntries.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = `cmd-palette-item${idx === cmdPaletteActiveIdx ? ' active' : ''}`;
    row.innerHTML = `
      <div class="cmd-palette-item-left">
        <span>${esc(item.icon)}</span>
        <span class="cmd-palette-item-title">${esc(item.title)}</span>
        <span class="cmd-palette-item-sub">${esc(item.sub)}</span>
      </div>
      <span class="cmd-palette-badge">${esc(item.badge)}</span>
    `;
    row.onclick = () => {
      $('command-palette-dialog')?.close();
      item.run();
    };
    listEl.appendChild(row);
  });
}

function openCommandPalette() {
  const dlg = $('command-palette-dialog');
  const inp = $('cmd-palette-input');
  if (!dlg || !inp) return;
  cmdPaletteActiveIdx = 0;
  inp.value = '';
  renderCommandPaletteList('');
  if (!dlg.open) dlg.showModal();
  inp.focus();
}

function bindCommandPaletteHandlers() {
  const btn = $('btn-cmd-palette');
  const inp = $('cmd-palette-input');
  const dlg = $('command-palette-dialog');
  if (btn) btn.onclick = openCommandPalette;
  if (inp) {
    inp.oninput = () => {
      cmdPaletteActiveIdx = 0;
      renderCommandPaletteList(inp.value);
    };
    inp.onkeydown = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (cmdPaletteEntries.length > 0) {
          cmdPaletteActiveIdx = (cmdPaletteActiveIdx + 1) % cmdPaletteEntries.length;
          renderCommandPaletteList(inp.value);
          $('cmd-palette-list')?.children[cmdPaletteActiveIdx]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (cmdPaletteEntries.length > 0) {
          cmdPaletteActiveIdx = (cmdPaletteActiveIdx - 1 + cmdPaletteEntries.length) % cmdPaletteEntries.length;
          renderCommandPaletteList(inp.value);
          $('cmd-palette-list')?.children[cmdPaletteActiveIdx]?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const picked = cmdPaletteEntries[cmdPaletteActiveIdx];
        if (picked) {
          dlg?.close();
          picked.run();
        }
      }
    };
  }
}


export {
  bindCommandPaletteHandlers,
  openCommandPalette,
};
