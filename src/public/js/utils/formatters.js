import { $ } from './dom.js';
import { state } from '../store/appState.js';

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val >= 100 || i === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


function formatDisplayName(item) {
  if (!item || state.settings.showExtensions !== false || item.isDir || !item.ext) return item?.name || '';
  const name = String(item.name || '');
  const ext = String(item.ext || '');
  if (ext && name.toLowerCase().endsWith(ext.toLowerCase()) && name.length > ext.length) {
    return name.slice(0, name.length - ext.length);
  }
  return name;
}


function formatTrimTime(sec) {
  const clean = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(clean / 60);
  const rem = clean - mins * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${String(mins).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenths}`;
}


function formatDurationShort(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `~${Math.ceil(sec)} sn`;
  const m = Math.floor(sec / 60);
  const s = Math.ceil(sec % 60);
  return `~${m} dk ${s} sn`;
}

function opIconForType(op) {
  if (op === 'delete') return '🗑️';
  if (op === 'move') return '📦';
  if (op === 'copy') return '📋';
  if (op === 'batchRename') return '✏️';
  if (op === 'organizeByDate') return '📅';
  if (op === 'duplicates') return '🧬';
  if (op === 'folderSizes') return '📏';
  if (op === 'analyze') return '📊';
  if (op === 'index') return '⚡';
  return '⚙️';
}


function formatCacheAge(ts) {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'az önce';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} dk önce`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} sa önce`;
  return `${Math.floor(diffHr / 24)} gün önce`;
}


export {
  formatBytes,
  formatCacheAge,
  formatDate,
  formatDisplayName,
  formatDurationShort,
  formatTrimTime,
  opIconForType,
};
