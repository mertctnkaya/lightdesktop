import { $, esc } from '../../utils/dom.js';
import { formatBytes } from '../../utils/formatters.js';
import { api } from '../../services/apiClient.js';
import { toast } from '../shared/toast.js';

const TEXT_EDIT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.log', '.csv', '.tsv', '.xml', '.yaml', '.yml',
  '.ini', '.cfg', '.conf', '.env', '.toml', '.gitignore', '.editorconfig',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.html', '.htm', '.css', '.scss', '.less',
  '.py', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.java', '.go', '.rs', '.php', '.rb',
  '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.vue', '.svelte', '.mk', '.mak', '.gradle',
]);

const TEXT_BASENAMES = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'license', 'licence', 'readme', 'changelog',
  'authors', 'notice', 'procfile', 'gemfile', 'rakefile', 'vagrantfile', 'justfile', 'brewfile',
  '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.npmrc', '.nvmrc',
  '.env', '.env.local', '.env.example', '.prettierrc', '.eslintrc',
]);

let activeTextItemPath = '';
let activeTextOriginal = '';
let activeTextEditable = false;
let activeTextDirty = false;
let activeTextReqSeq = 0;

function isTextPreviewable(item) {
  if (!item || item.isDir) return false;
  const ext = (item.ext || '').toLowerCase();
  const base = (item.name || '').toLowerCase();
  if (TEXT_EDIT_EXTS.has(ext) || item.category === 'code') return true;
  if (TEXT_BASENAMES.has(base)) return true;
  return base.startsWith('.env.') || base.startsWith('dockerfile.') || base.startsWith('makefile.');
}

function isPdfPreviewable(item) {
  if (!item || item.isDir) return false;
  return (item.ext || '').toLowerCase() === '.pdf';
}

function syncDirtyState(ta) {
  activeTextDirty = Boolean(activeTextEditable && ta && ta.value !== activeTextOriginal);
  const dirtyEl = $('ql-text-dirty');
  if (dirtyEl) dirtyEl.classList.toggle('hidden', !activeTextDirty);
}

function parseCsvRows(rawText, delimiter = ',', maxRows = 300) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const len = rawText.length;

  for (let i = 0; i < len; i++) {
    const ch = rawText[i];
    if (inQuotes) {
      if (ch === '"' && rawText[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && rawText[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) break;
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function buildCsvTableHtml(rawText, ext) {
  const delim = ext === '.tsv' ? '\t' : (rawText.split('\n')[0]?.includes(';') && !rawText.split('\n')[0]?.includes(',') ? ';' : ',');
  const rows = parseCsvRows(rawText, delim, 300);
  if (rows.length === 0) return '<div class="muted-text" style="padding:14px;">Boş tablo.</div>';
  const head = rows[0] || [];
  const bodyRows = rows.slice(1);
  const thHtml = head.map((c) => `<th>${esc(c)}</th>`).join('');
  const trHtml = bodyRows
    .map((r) => `<tr>${head.map((_, idx) => `<td>${esc(r[idx] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="ql-csv-table-wrap"><table class="ql-csv-table"><thead><tr>${thHtml}</tr></thead><tbody>${trHtml}</tbody></table></div>`;
}

function formatMdInline(raw) {
  const codeTokens = [];
  const withCodePlaceholders = String(raw || '').replace(/`([^`]+)`/g, (_m, code) => {
    const tok = `\u0000CODE${codeTokens.length}\u0000`;
    codeTokens.push(`<code>${esc(code)}</code>`);
    return tok;
  });

  let s = esc(withCodePlaceholders);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt) => `<span class="ql-md-img-tag">🖼️ ${alt || 'Görsel'}</span>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => {
    if (/^https?:\/\//i.test(href)) {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return `<code>${label}</code>`;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^\w*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx) => codeTokens[Number(idx)] || '');
  return s;
}

function renderMarkdownToHtml(rawMd) {
  const lines = String(rawMd || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  let listTag = '';

  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = '';
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(.*)$/.exec(line.trim());
    if (fence) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLang = fence[1].trim();
        codeBuf = [];
      } else {
        const langAttr = codeLang ? ` data-lang="${esc(codeLang)}"` : '';
        out.push(`<pre${langAttr}><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
        codeLang = '';
        codeBuf = [];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    if (/^([-*_]){3,}$/.test(trimmed)) {
      closeList();
      out.push('<hr />');
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeList();
      const lvl = heading[1].length;
      out.push(`<h${lvl}>${formatMdInline(heading[2])}</h${lvl}>`);
      continue;
    }

    if (trimmed.startsWith('>')) {
      closeList();
      out.push(`<blockquote>${formatMdInline(trimmed.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    // GFM Tablo
    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1].trim())) {
      closeList();
      const splitCells = (ln) => ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const headers = splitCells(trimmed);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        body.push(splitCells(lines[i]));
        i++;
      }
      i--;
      const ths = headers.map((h) => `<th>${formatMdInline(h)}</th>`).join('');
      const trs = body.map((r) => `<tr>${headers.map((_, ci) => `<td>${formatMdInline(r[ci] || '')}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="ql-md-table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }

    const ulMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      if (listTag !== 'ul') {
        closeList();
        listTag = 'ul';
        out.push('<ul>');
      }
      const itemText = ulMatch[1];
      const cbMatch = /^\[(x|X| )\]\s+(.+)$/.exec(itemText);
      if (cbMatch) {
        const checked = cbMatch[1].toLowerCase() === 'x' ? ' checked' : '';
        out.push(`<li class="ql-md-task"><input type="checkbox" disabled${checked} /> ${formatMdInline(cbMatch[2])}</li>`);
      } else {
        out.push(`<li>${formatMdInline(itemText)}</li>`);
      }
      continue;
    }

    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      if (listTag !== 'ol') {
        closeList();
        listTag = 'ol';
        out.push('<ol>');
      }
      out.push(`<li>${formatMdInline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${formatMdInline(line)}</p>`);
  }

  closeList();
  if (inCode) {
    out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  }
  return out.join('\n');
}

async function saveActiveQuickLookText() {
  const ta = $('ql-text-editor');
  if (!ta || !activeTextItemPath || !activeTextEditable) return false;
  const saveBtn = $('btn-ql-text-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await api('/api/file/text', {
      method: 'POST',
      body: JSON.stringify({ path: activeTextItemPath, content: ta.value }),
    });
    activeTextOriginal = ta.value;
    syncDirtyState(ta);
    toast(`💾 Kaydedildi (${formatBytes(res.size)})`, 'success');
    return true;
  } catch (err) {
    toast(`Kaydetme hatası: ${err.message}`, 'error');
    return false;
  } finally {
    if (saveBtn) saveBtn.disabled = !activeTextEditable;
  }
}

async function renderQuickLookTextEditor(stageEl, item) {
  const seq = ++activeTextReqSeq;
  activeTextItemPath = item.path;
  activeTextOriginal = '';
  activeTextEditable = false;
  activeTextDirty = false;
  stageEl.innerHTML = '<div class="muted-text" style="padding:20px;">Dosya içeriği yükleniyor...</div>';

  try {
    const data = await api(`/api/file/text?path=${encodeURIComponent(item.path)}`);
    if (seq !== activeTextReqSeq) return;
    activeTextEditable = Boolean(data.editable);
    activeTextOriginal = data.content || '';

    const ext = (item.ext || '').toLowerCase();
    const isJson = ext === '.json';
    const isCsv = ext === '.csv' || ext === '.tsv';
    const isMd = ext === '.md' || ext === '.markdown';
    const lineCount = activeTextOriginal.split(/\r?\n/).length;

    stageEl.innerHTML = `
      <div class="ql-text-wrap">
        <div class="ql-text-toolbar">
          <div class="ql-text-info">
            <span id="ql-text-stats" class="muted-text">${lineCount.toLocaleString('tr-TR')} satır • ${activeTextOriginal.length.toLocaleString('tr-TR')} karakter</span>
            ${data.truncated ? '<span class="ql-text-readonly">⚠️ İlk 512 KB önizleme (Salt Okunur)</span>' : ''}
            <span id="ql-text-dirty" class="ql-text-dirty hidden">● Kaydedilmedi</span>
          </div>
          <div class="ql-text-actions">
            ${isMd ? '<button type="button" id="btn-ql-md-toggle" class="cmd-btn small">📝 Düzenle</button>' : ''}
            ${isJson ? '<button type="button" id="btn-ql-json-fmt" class="cmd-btn small">{ } Biçimlendir</button>' : ''}
            ${isCsv ? '<button type="button" id="btn-ql-csv-toggle" class="cmd-btn small">📊 Tablo Görünümü</button>' : ''}
            <button type="button" id="btn-ql-text-wrap" class="cmd-btn small">↩️ Satır Kaydır</button>
            <button type="button" id="btn-ql-text-copy" class="cmd-btn small">📋 Kopyala</button>
            <button type="button" id="btn-ql-text-save" class="cmd-btn primary small" ${activeTextEditable ? '' : 'disabled title="2 MB üstü dosyalar düzenlenemez"'}>💾 Kaydet (Ctrl+S)</button>
          </div>
        </div>
        <textarea id="ql-text-editor" class="ql-text-editor" spellcheck="false" ${activeTextEditable ? '' : 'readonly'}></textarea>
        <div id="ql-csv-preview" class="ql-csv-preview hidden"></div>
        <div id="ql-md-preview" class="ql-md-preview hidden"></div>
      </div>
    `;

    const ta = $('ql-text-editor');
    const statsEl = $('ql-text-stats');
    ta.value = activeTextOriginal;

    const updateStats = () => {
      if (!statsEl) return;
      const lines = ta.value.split(/\r?\n/).length;
      statsEl.textContent = `${lines.toLocaleString('tr-TR')} satır • ${ta.value.length.toLocaleString('tr-TR')} karakter`;
    };

    ta.oninput = () => {
      syncDirtyState(ta);
      updateStats();
    };

    ta.onkeydown = (e) => {
      if (e.key === 'Tab' && activeTextEditable) {
        e.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = `${ta.value.slice(0, start)}  ${ta.value.slice(end)}`;
        ta.selectionStart = ta.selectionEnd = start + 2;
        syncDirtyState(ta);
        updateStats();
      }
    };

    const wrapBtn = $('btn-ql-text-wrap');
    if (wrapBtn) {
      wrapBtn.onclick = () => {
        const wrapped = ta.classList.toggle('wrap');
        wrapBtn.classList.toggle('primary', wrapped);
      };
    }

    const copyBtn = $('btn-ql-text-copy');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(ta.value);
        toast('İçerik panoya kopyalandı', 'success');
      };
    }

    const saveBtn = $('btn-ql-text-save');
    if (saveBtn) saveBtn.onclick = () => saveActiveQuickLookText();

    const jsonBtn = $('btn-ql-json-fmt');
    if (jsonBtn) {
      jsonBtn.onclick = () => {
        try {
          ta.value = JSON.stringify(JSON.parse(ta.value), null, 2);
          syncDirtyState(ta);
          updateStats();
          toast('JSON biçimlendirildi', 'success');
        } catch (err) {
          toast(`Geçersiz JSON: ${err.message}`, 'error');
        }
      };
    }

    const csvBtn = $('btn-ql-csv-toggle');
    const csvPreview = $('ql-csv-preview');
    if (csvBtn && csvPreview) {
      let tableMode = false;
      csvBtn.onclick = () => {
        tableMode = !tableMode;
        if (tableMode) {
          csvPreview.innerHTML = buildCsvTableHtml(ta.value, ext);
          csvPreview.classList.remove('hidden');
          ta.classList.add('hidden');
          csvBtn.textContent = '📝 Metin Editörü';
        } else {
          csvPreview.classList.add('hidden');
          ta.classList.remove('hidden');
          csvBtn.textContent = '📊 Tablo Görünümü';
        }
      };
    }

    const mdBtn = $('btn-ql-md-toggle');
    const mdPreview = $('ql-md-preview');
    if (isMd && mdBtn && mdPreview) {
      let previewMode = true;
      const applyMdMode = () => {
        if (previewMode) {
          mdPreview.innerHTML = renderMarkdownToHtml(ta.value);
          mdPreview.classList.remove('hidden');
          ta.classList.add('hidden');
          mdBtn.textContent = '📝 Düzenle';
        } else {
          mdPreview.classList.add('hidden');
          ta.classList.remove('hidden');
          mdBtn.textContent = '👁️ Markdown Önizle';
          ta.focus();
        }
      };
      applyMdMode();
      mdBtn.onclick = () => {
        previewMode = !previewMode;
        applyMdMode();
      };
    }
  } catch (err) {
    if (seq !== activeTextReqSeq) return;
    stageEl.innerHTML = `<div class="empty-state">Metin okunamadı: ${esc(err.message)}</div>`;
  }
}

export {
  isPdfPreviewable,
  isTextPreviewable,
  renderQuickLookTextEditor,
  saveActiveQuickLookText,
};
