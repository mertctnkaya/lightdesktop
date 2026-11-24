import { toast } from '../components/shared/toast.js';

const $ = (id) => document.getElementById(id);


// ---------- Yardımcılar ----------
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


async function copyTextSafe(text, toastMsg = 'Panoya kopyalandı') {
  const val = String(text ?? '');
  if (!val) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(val);
      if (toastMsg) toast(toastMsg, 'success');
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok && toastMsg) toast(toastMsg, 'success');
    return ok;
  } catch {
    toast('Panoya kopyalanamadı', 'error');
    return false;
  }
}


export {
  $,
  copyTextSafe,
  esc,
};
