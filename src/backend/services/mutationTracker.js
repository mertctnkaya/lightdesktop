'use strict';

const fs = require('node:fs');
const path = require('node:path');

const dirMutationMap = new Map();

function normalizeMutKey(p) {
  const res = path.resolve(String(p || 'C:\\'));
  return res.replace(/[\\/]+$/, '').toLowerCase() || res.toLowerCase();
}

function markDirMutated(p) {
  if (!p) return;
  try {
    const resolved = path.resolve(String(p));
    const now = Date.now();
    dirMutationMap.set(normalizeMutKey(resolved), now);
    const root = path.parse(resolved).root;
    if (root) dirMutationMap.set(normalizeMutKey(root), now);
  } catch {}
}

function markDirsMutated(dirs = []) {
  for (const d of dirs) markDirMutated(d);
}

function getLastMutationFor(targetPath) {
  if (!targetPath) return 0;
  try {
    const resolved = path.resolve(String(targetPath));
    const t1 = dirMutationMap.get(normalizeMutKey(resolved)) || 0;
    const root = path.parse(resolved).root;
    const t2 = root ? (dirMutationMap.get(normalizeMutKey(root)) || 0) : 0;
    return Math.max(t1, t2);
  } catch {
    return 0;
  }
}


function makeUniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let i = 1;
  while (true) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}


module.exports = {
  dirMutationMap,
  normalizeMutKey,
  markDirMutated,
  markDirsMutated,
  getLastMutationFor,
  makeUniquePath,
};
