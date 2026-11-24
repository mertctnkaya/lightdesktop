'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const idx = require('../../indexer-and-thumbs');
const { markDirMutated, makeUniquePath } = require('./mutationTracker');
const { recordAppError } = require('./loggerService');

const VAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VAULT_DIR_NAME = '.LightDesktopVault';
const CONFIG_FILE = path.join(idx.CACHE_ROOT, 'vault-config.json');
const MANIFEST_FILE = path.join(idx.CACHE_ROOT, 'vault-manifest.json');

let cachedConfig = null;
const hiddenAttrMarkedDirs = new Set();

function normalizeDirPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  let resolved = path.resolve(raw);
  if (/^[a-zA-Z]:$/.test(resolved)) resolved += '\\';
  if (resolved.length > 3) resolved = resolved.replace(/[\\/]+$/, '');
  return resolved.toLowerCase();
}

function formatDisplayDir(p) {
  let resolved = path.resolve(String(p || '').trim());
  if (/^[a-zA-Z]:$/.test(resolved)) resolved += '\\';
  if (resolved.length > 3) resolved = resolved.replace(/[\\/]+$/, '');
  return resolved;
}

function loadVaultConfig() {
  if (cachedConfig) return cachedConfig;
  let protectedPaths = [];
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.protectedPaths)) {
        protectedPaths = parsed.protectedPaths
          .map((x) => String(x || '').trim())
          .filter(Boolean);
      }
    }
  } catch {}
  cachedConfig = { protectedPaths };
  return cachedConfig;
}

function saveVaultConfig(nextPaths = []) {
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(nextPaths) ? nextPaths : []) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    const norm = normalizeDirPath(trimmed);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    clean.push(formatDisplayDir(trimmed));
  }
  cachedConfig = { protectedPaths: clean };
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cachedConfig, null, 2), 'utf8');
  } catch (err) {
    recordAppError('Koruma Kasası Ayarı', CONFIG_FILE, err.message);
  }
  return cachedConfig;
}

function isPathProtected(targetPath) {
  const normTarget = normalizeDirPath(targetPath);
  if (!normTarget) return false;
  if (normTarget.includes(VAULT_DIR_NAME.toLowerCase())) return false;
  const { protectedPaths } = loadVaultConfig();
  for (const prot of protectedPaths) {
    const normProt = normalizeDirPath(prot);
    if (!normProt) continue;
    if (normProt.endsWith('\\')) {
      if (normTarget.startsWith(normProt)) return true;
    } else if (normTarget === normProt || normTarget.startsWith(normProt + '\\')) {
      return true;
    }
  }
  return false;
}

function loadManifest() {
  try {
    if (!fs.existsSync(MANIFEST_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveManifest(entries) {
  try {
    fs.mkdirSync(path.dirname(MANIFEST_FILE), { recursive: true });
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    recordAppError('Koruma Kasası Manifest', MANIFEST_FILE, err.message);
  }
}

function resolveVaultDirForSource(srcPath) {
  const driveRoot = path.parse(srcPath).root;
  if (driveRoot) {
    const candidate = path.join(driveRoot, VAULT_DIR_NAME);
    try {
      fs.mkdirSync(candidate, { recursive: true });
      if (!hiddenAttrMarkedDirs.has(candidate.toLowerCase())) {
        hiddenAttrMarkedDirs.add(candidate.toLowerCase());
        execFile('attrib', ['+h', '+s', candidate], { windowsHide: true }, () => {});
      }
      return candidate;
    } catch {}
  }
  const fallback = path.join(idx.CACHE_ROOT, 'Vault');
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

async function movePathCrossSafe(src, dest) {
  try {
    await fsp.rename(src, dest);
    return;
  } catch (err) {
    if (err && err.code !== 'EXDEV') {
      // Farklı disk veya yetki fallback'i dene
    }
    await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

async function moveToProtectedVault(srcPath, sourceTag = 'permanent-delete', overrideOrigPath = '') {
  const src = path.resolve(String(srcPath || ''));
  const origPath = overrideOrigPath ? path.resolve(String(overrideOrigPath)) : src;
  if (!fs.existsSync(src)) return { ok: false };

  const st = await fsp.lstat(src);
  const isDir = st.isDirectory();
  const size = isDir ? 0 : (Number(st.size) || 0);
  const vaultDir = resolveVaultDirForSource(src);
  const id = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const safeName = (path.basename(origPath) || 'item').replace(/[<>:"/\\|?*]/g, '_');
  const destVaultPath = path.join(vaultDir, `${id}_${safeName}`);

  await movePathCrossSafe(src, destVaultPath);

  const deletedAt = Date.now();
  const expiresAt = deletedAt + VAULT_TTL_MS;
  const entries = loadManifest();
  entries.push({
    id,
    origPath,
    name: path.basename(origPath) || origPath,
    isDir,
    size,
    vaultPath: destVaultPath,
    deletedAt,
    expiresAt,
    source: sourceTag,
  });
  saveManifest(entries);
  return { ok: true, id };
}

async function purgeExpiredVaultEntries() {
  const entries = loadManifest();
  if (entries.length === 0) return { purged: 0 };
  const now = Date.now();
  const kept = [];
  let purged = 0;

  for (const e of entries) {
    const expired = now >= (Number(e.expiresAt) || 0);
    const missing = !e.vaultPath || !fs.existsSync(e.vaultPath);
    if (expired || missing) {
      if (e.vaultPath && fs.existsSync(e.vaultPath)) {
        try {
          await fsp.rm(e.vaultPath, { recursive: true, force: true });
        } catch (err) {
          recordAppError('Koruma Kasası Süre Temizliği', e.vaultPath, err.message);
        }
      }
      purged++;
    } else {
      kept.push(e);
    }
  }

  if (purged > 0) saveManifest(kept);
  return { purged };
}

async function listVaultItems() {
  await purgeExpiredVaultEntries();
  const now = Date.now();
  const entries = loadManifest();
  return entries
    .map((e) => ({
      ...e,
      daysLeft: Math.max(0, Math.ceil(((Number(e.expiresAt) || 0) - now) / 86400000)),
    }))
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

async function restoreVaultEntries(ids = []) {
  const idSet = new Set(Array.isArray(ids) ? ids : []);
  if (idSet.size === 0) return { ok: true, restored: [], errors: [] };

  const entries = loadManifest();
  const kept = [];
  const restored = [];
  const errors = [];

  for (const e of entries) {
    if (!idSet.has(e.id)) {
      kept.push(e);
      continue;
    }
    if (!e.vaultPath || !fs.existsSync(e.vaultPath)) {
      errors.push({ id: e.id, path: e.origPath, message: 'Kasadaki dosya diskte bulunamadı' });
      continue;
    }
    try {
      const parentDir = path.dirname(e.origPath);
      await fsp.mkdir(parentDir, { recursive: true });
      const targetPath = fs.existsSync(e.origPath) ? makeUniquePath(e.origPath) : e.origPath;
      await movePathCrossSafe(e.vaultPath, targetPath);
      markDirMutated(parentDir);
      restored.push({ id: e.id, origPath: e.origPath, restoredPath: targetPath });
    } catch (err) {
      kept.push(e);
      errors.push({ id: e.id, path: e.origPath, message: err.message });
      recordAppError('Koruma Kasasından Geri Yükleme', e.origPath, err.message);
    }
  }

  saveManifest(kept);
  return { ok: errors.length === 0 || restored.length > 0, restored, errors };
}

async function purgeVaultEntries(ids = [], purgeAll = false) {
  const idSet = new Set(Array.isArray(ids) ? ids : []);
  if (!purgeAll && idSet.size === 0) return { ok: true, deleted: 0, errors: [] };

  const entries = loadManifest();
  const kept = [];
  let deleted = 0;
  const errors = [];

  for (const e of entries) {
    if (!purgeAll && !idSet.has(e.id)) {
      kept.push(e);
      continue;
    }
    try {
      if (e.vaultPath && fs.existsSync(e.vaultPath)) {
        await fsp.rm(e.vaultPath, { recursive: true, force: true });
      }
      deleted++;
    } catch (err) {
      kept.push(e);
      errors.push({ id: e.id, path: e.origPath, message: err.message });
      recordAppError('Koruma Kasasından Kalıcı Silme', e.vaultPath || e.origPath, err.message);
    }
  }

  saveManifest(kept);
  return { ok: errors.length === 0 || deleted > 0, deleted, errors };
}

function getVaultSummary() {
  const { protectedPaths } = loadVaultConfig();
  const now = Date.now();
  const activeEntries = loadManifest().filter((e) => (Number(e.expiresAt) || 0) > now);
  let totalBytes = 0;
  for (const e of activeEntries) totalBytes += Number(e.size) || 0;
  return {
    protectedPaths,
    itemCount: activeEntries.length,
    totalBytes,
    ttlDays: 30,
  };
}

module.exports = {
  VAULT_DIR_NAME,
  isPathProtected,
  loadVaultConfig,
  saveVaultConfig,
  moveToProtectedVault,
  purgeExpiredVaultEntries,
  listVaultItems,
  restoreVaultEntries,
  purgeVaultEntries,
  getVaultSummary,
};
