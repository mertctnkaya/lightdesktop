'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFile } = require('node:child_process');
const { STORYBOARDS_DIR } = require('../db/sqliteConnection');
const { makeThumbKey } = require('../core/categoryClassifier');
const { getFfmpegBin } = require('./thumbnailEngine');

// ---------- Hover Video Storyboard Üretici (Concurrency = 1, SSD Önbellekli) ----------
const storyboardQueue = [];
const inFlightStoryboards = new Map();
let storyboardRunning = false;

function probeVideoDurationSec(ffmpegBin, filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegBin, ['-nostdin', '-hide_banner', '-i', filePath], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (_err, _stdout, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(stderr || ''));
      if (m) {
        const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
        if (Number.isFinite(secs) && secs > 0) return resolve(secs);
      }
      resolve(15);
    });
  });
}

async function generateStoryboardStrip(ffmpegBin, filePath, outPath) {
  const dur = await probeVideoDurationSec(ffmpegBin, filePath);
  const pcts = [0.08, 0.28, 0.50, 0.72, 0.90];
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  for (const pct of pcts) {
    const sec = dur <= 1.2 ? 0 : Math.max(0.05, Math.min(dur - 0.15, dur * pct)).toFixed(2);
    args.push('-ss', String(sec), '-noaccurate_seek', '-i', filePath);
  }
  const filters = [];
  const labels = [];
  for (let i = 0; i < 5; i++) {
    filters.push(`[${i}:v]scale=256:144:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=256:144:(ow-iw)/2:(oh-ih)/2:color=#111111,setsar=1,setpts=PTS-STARTPTS[v${i}]`);
    labels.push(`[v${i}]`);
  }
  const tmpOut = `${outPath}.tmp.jpg`;
  args.push('-filter_complex', `${filters.join(';')};${labels.join('')}hstack=inputs=5[outv]`, '-map', '[outv]', '-frames:v', '1', '-q:v', '6', tmpOut);

  return new Promise((resolve) => {
    execFile(ffmpegBin, args, { timeout: 14000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err) => {
      if (err || !fs.existsSync(tmpOut)) {
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        return resolve(false);
      }
      try {
        fs.renameSync(tmpOut, outPath);
        resolve(true);
      } catch {
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
        resolve(false);
      }
    });
  });
}

async function processStoryboardQueue() {
  if (storyboardRunning) return;
  storyboardRunning = true;
  try {
    while (storyboardQueue.length > 0) {
      const job = storyboardQueue.shift();
      try {
        if (!fs.existsSync(job.outPath)) {
          await generateStoryboardStrip(job.ffmpegBin, job.filePath, job.outPath);
        }
        job.resolve(fs.existsSync(job.outPath) ? { available: true, filePath: job.outPath, fromCache: false } : { available: false });
      } catch {
        job.resolve({ available: false });
      } finally {
        inFlightStoryboards.delete(job.key);
      }
    }
  } finally {
    storyboardRunning = false;
  }
}

async function getOrCreateVideoStoryboard(filePath) {
  const ffmpegBin = getFfmpegBin();
  if (!ffmpegBin) return { available: false };
  const resolved = path.resolve(filePath);
  let st;
  try {
    st = await fsp.stat(resolved);
    if (!st.isFile()) return { available: false };
  } catch {
    return { available: false };
  }
  const tk = makeThumbKey(resolved, Math.floor(st.mtimeMs || 0), st.size || 0);
  const outPath = path.join(STORYBOARDS_DIR, `${tk}_sb.jpg`);
  if (fs.existsSync(outPath)) {
    return { available: true, filePath: outPath, fromCache: true };
  }
  if (inFlightStoryboards.has(tk)) return inFlightStoryboards.get(tk);

  const p = new Promise((resolve) => {
    storyboardQueue.push({ key: tk, filePath: resolved, outPath, ffmpegBin, resolve });
    processStoryboardQueue();
  });
  inFlightStoryboards.set(tk, p);
  return p;
}


module.exports = {
  probeVideoDurationSec,
  generateStoryboardStrip,
  processStoryboardQueue,
  getOrCreateVideoStoryboard,
};
