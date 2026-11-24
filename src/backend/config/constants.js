'use strict';

const fs = require('node:fs');
const path = require('node:path');
const idx = require('../../indexer-and-thumbs');

const APP_VERSION = '1.6.0';
const PORT = Number(process.env.LIGHTDESKTOP_PORT) || 3847;
let activePort = PORT;
const HOST = '127.0.0.1';
const SERVER_DIR = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(SERVER_DIR, 'public');
const BOUNDS_FILE = path.join(idx.CACHE_ROOT, 'window-bounds.json');
const CRASH_DUMP_FILE = path.join(idx.CACHE_ROOT, 'crash-last.txt');
const START_TIME = Date.now();

function resolveLogFile() {
  if (process.env.LD_LOG_FILE) {
    try {
      fs.mkdirSync(path.dirname(process.env.LD_LOG_FILE), { recursive: true });
      return process.env.LD_LOG_FILE;
    } catch {}
  }
  return path.join(idx.CACHE_ROOT, 'logs.txt');
}

const LOG_FILE = resolveLogFile();


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
};

function getActivePort() {
  return activePort;
}

function setActivePort(p) {
  activePort = p;
}

module.exports = {
  APP_VERSION,
  PORT,
  HOST,
  SERVER_DIR,
  PUBLIC_DIR,
  BOUNDS_FILE,
  CRASH_DUMP_FILE,
  LOG_FILE,
  START_TIME,
  MIME_TYPES,
  getActivePort,
  setActivePort,
};
