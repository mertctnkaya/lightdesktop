'use strict';

const path = require('node:path');

// ---------- Açık Medya Akışlarını Anında Serbest Bırakma & Sıcak Çöp Kutusu İşçisi ----------
const activeOpenStreams = new Map(); // normPath -> Set<{ rs, res }>

function registerOpenStream(filePath, entry) {
  const key = path.resolve(filePath).toLowerCase();
  if (!activeOpenStreams.has(key)) activeOpenStreams.set(key, new Set());
  activeOpenStreams.get(key).add(entry);
  return key;
}

function unregisterOpenStream(key, entry) {
  const set = activeOpenStreams.get(key);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) activeOpenStreams.delete(key);
}

async function releaseOpenStreamsForPaths(paths = []) {
  const targets = (paths || []).filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  if (targets.length === 0 || activeOpenStreams.size === 0) return false;
  let released = false;
  for (const [streamPath, set] of Array.from(activeOpenStreams.entries())) {
    const match = targets.some((t) => streamPath === t || streamPath.startsWith(t.replace(/\\$/, '') + '\\'));
    if (!match) continue;
    for (const entry of Array.from(set)) {
      released = true;
      try { if (entry.rs && !entry.rs.destroyed) entry.rs.destroy(); } catch {}
      try { if (entry.res && !entry.res.writableEnded && !entry.res.destroyed) entry.res.end(); } catch {}
      set.delete(entry);
    }
    if (set.size === 0) activeOpenStreams.delete(streamPath);
  }
  if (released) {
    await new Promise((r) => setTimeout(r, 35));
  }
  return released;
}


module.exports = {
  activeOpenStreams,
  registerOpenStream,
  unregisterOpenStream,
  releaseOpenStreamsForPaths,
};
