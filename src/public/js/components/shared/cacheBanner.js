import { formatCacheAge } from '../../utils/formatters.js';
import { $, esc } from '../../utils/dom.js';

function buildCacheBannerHtml(data, btnId, freshLabel = '🔄 Canlı Yenile') {
  if (!data || !data.fromCache) return '';
  const age = formatCacheAge(data.cachedAt);
  if (data.stale) {
    return `
      <span>💡 <strong>${esc(data.staleReason || 'Değişiklik algılandı')}</strong> — önbellekten (${esc(age)}) gösteriliyor; tekrar taramanız önerilir.</span>
      <button type="button" id="${btnId}" class="cmd-btn small primary">🔄 Şimdi Yeniden Tara</button>
    `;
  }
  return `
    <span>⚡ <strong>Önbellekten anında yüklendi</strong> (${esc(age)})</span>
    <button type="button" id="${btnId}" class="cmd-btn small">${esc(freshLabel)}</button>
  `;
}


export {
  buildCacheBannerHtml,
};
