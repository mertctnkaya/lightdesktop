import { $ } from '../utils/dom.js';
import { GENERIC_REL_WORDS } from '../constants/uiConstants.js';

function getDriveRoot(p) {
  const m = /^([a-zA-Z]:)/.exec(String(p || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function isCrossDriveTransfer(paths, targetDir) {
  const dstDrive = getDriveRoot(targetDir);
  if (!dstDrive || !Array.isArray(paths) || paths.length === 0) return false;
  return paths.some((p) => {
    const srcDrive = getDriveRoot(p);
    return srcDrive && srcDrive !== dstDrive;
  });
}

// Windows Dosya Gezgini kuralı: aynı diskte varsayılan Taşı, farklı diske varsayılan Kopyala
function resolveDragOp(paths, targetDir, ctrlKey = false, shiftKey = false) {
  if (isCrossDriveTransfer(paths, targetDir)) {
    return (shiftKey && !ctrlKey) ? 'move' : 'copy';
  }
  return ctrlKey ? 'copy' : 'move';
}



function parseClientRefTime(item) {
  const name = String(item?.name || '');
  let m = /(?:^|[^\d])((?:199\d|20\d\d))(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_\-\s]?([01]\d|2[0-3])([0-5]\d)([0-5]\d)(?:[^\d]|$)/.exec(name);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  m = /(?:^|[^\d])((?:199\d|20\d\d))[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/.exec(name);
  if (m && !(item?.mtime > 0)) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0).getTime();
  return item?.mtime || Date.now();
}

function getClientNameTokensPreview(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const spaced = stem.replace(/([a-zçğıöşü])([A-ZÇĞİÖŞÜ])/g, '$1 $2');
  const words = spaced.toLocaleLowerCase('tr-TR').split(/[^a-zçğıöşü0-9]+/i).filter((w) => {
    if (w.length < 3) return false;
    if (GENERIC_REL_WORDS.has(w) || GENERIC_REL_WORDS.has(w.replace(/ı/g, 'i'))) return false;
    if (/^\d+$/.test(w) && (w.length < 8 || w.length === 6)) return false;
    return true;
  });
  return Array.from(new Set(words)).slice(0, 5);
}


export {
  getClientNameTokensPreview,
  parseClientRefTime,
  resolveDragOp,
};
