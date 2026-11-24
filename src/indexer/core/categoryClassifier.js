'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts', '.3gp', '.vob', '.mts']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif', '.tiff', '.tif', '.raw', '.cr2', '.nef', '.arw', '.dng', '.svg', '.ico']);
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.aac', '.ogg', '.m4a', '.wma', '.opus', '.mid']);
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.img', '.cab', '.zst']);
const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt', '.ods', '.epub', '.log']);
const APP_EXTS = new Set(['.exe', '.msi', '.apk', '.dll', '.sys', '.bat', '.cmd', '.lnk']);
const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sql', '.c', '.cpp', '.h', '.cs', '.java', '.go', '.rs', '.php', '.sh', '.ps1']);

function getCategory(ext, isDir) {
  if (isDir) return 'folder';
  const e = (ext || '').toLowerCase();
  if (VIDEO_EXTS.has(e)) return 'video';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (ARCHIVE_EXTS.has(e)) return 'archive';
  if (DOC_EXTS.has(e)) return 'document';
  if (APP_EXTS.has(e)) return 'app';
  if (CODE_EXTS.has(e)) return 'code';
  return 'other';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeParentDir(p) {
  if (!p) return '';
  let resolved = path.resolve(p);
  if (/^[a-zA-Z]:$/.test(resolved)) resolved += '\\';
  return resolved.toLowerCase();
}


function escapeLikePrefix(prefix) {
  return prefix.replace(/[\\%_]/g, '\\$&') + '%';
}


const SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'winsxs',
  'installer',
  '$windows.~bt',
  'recovery',
  'node_modules',
  '.git',
  '.lightdesktopvault',
]);


function makeThumbKey(filePath, mtime, size) {
  return crypto.createHash('sha1').update(`${filePath.toLowerCase()}|${mtime}|${size}`).digest('hex');
}


module.exports = {
  VIDEO_EXTS,
  IMAGE_EXTS,
  AUDIO_EXTS,
  ARCHIVE_EXTS,
  DOC_EXTS,
  APP_EXTS,
  CODE_EXTS,
  SKIP_DIRS,
  getCategory,
  sleep,
  normalizeParentDir,
  escapeLikePrefix,
  makeThumbKey,
};
