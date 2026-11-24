'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const readline = require('node:readline');
const {
  THUMBS_DIR,
  db,
  cachedThumbSet,
  addCachedThumbBytes,
  resetCachedThumbBytes,
  stmtUpsertThumb,
} = require('../db/sqliteConnection');
const { VIDEO_EXTS, IMAGE_EXTS, makeThumbKey, sleep } = require('../core/categoryClassifier');
const { getIndexStats } = require('./backgroundIndexer');

function getThumbCacheInfo(filePath, mtime, size) {
  const key = makeThumbKey(filePath, mtime, size);
  const thumbFile = `${key}.jpg`;
  return {
    key,
    thumbFile,
    fullPath: path.join(THUMBS_DIR, thumbFile),
    cached: cachedThumbSet.has(thumbFile),
  };
}

// JPEG dosyalarının yalnızca ilk 64 KB başlığını okuyup gömülü EXIF kapak resmini çıkarır
async function tryExtractExifThumb(filePath, outPath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, 65536, 0);
    if (bytesRead < 200 || buf[0] !== 0xff || buf[1] !== 0xd8) return false;

    const slice = buf.subarray(0, bytesRead);
    // İkinci SOI işaretini (0xFF 0xD8 0xFF) ara — gömülü EXIF thumbnail
    let start = -1;
    for (let i = 4; i < slice.length - 4; i++) {
      if (slice[i] === 0xff && slice[i + 1] === 0xd8 && slice[i + 2] === 0xff) {
        start = i;
        break;
      }
    }
    if (start === -1) return false;

    let end = -1;
    for (let j = start + 100; j < slice.length - 1; j++) {
      if (slice[j] === 0xff && slice[j + 1] === 0xd9) {
        end = j + 2;
        break;
      }
    }
    if (end === -1 || end - start < 1024) return false;

    await fsp.writeFile(outPath, slice.subarray(start, end));
    return true;
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

let resolvedFfmpegBin; // undefined = henüz kontrol edilmedi, null = yok, string = tam yol
function getFfmpegBin() {
  if (resolvedFfmpegBin !== undefined) return resolvedFfmpegBin;
  const localCandidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(path.dirname(process.execPath || __dirname), 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const c of localCandidates) {
    try {
      if (fs.existsSync(c)) {
        resolvedFfmpegBin = c;
        return resolvedFfmpegBin;
      }
    } catch {}
  }
  try {
    execFileSync('ffmpeg', ['-version'], { timeout: 2000, windowsHide: true, stdio: 'ignore' });
    resolvedFfmpegBin = 'ffmpeg';
    return resolvedFfmpegBin;
  } catch {
    resolvedFfmpegBin = null;
    return null;
  }
}

function runFfmpegThumb(filePath, outPath, seekSec) {
  const ffmpegBin = getFfmpegBin();
  if (!ffmpegBin) return Promise.resolve(false);
  return new Promise((resolve) => {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
    if (seekSec) {
      args.push('-ss', seekSec);
    }
    args.push('-i', filePath, '-frames:v', '1', '-vf', 'scale=240:240:force_original_aspect_ratio=decrease', '-q:v', '5', outPath);
    execFile(ffmpegBin, args, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err) => {
      if (err) {
        if (err.code === 'ENOENT') resolvedFfmpegBin = null;
        return resolve(false);
      }
      try {
        resolve(fs.existsSync(outPath) && fs.statSync(outPath).size > 100);
      } catch {
        resolve(false);
      }
    });
  });
}

// FFmpeg kurulu olmayan sistemlerde 0 MB ek boyutla Windows yerleşik Shell Thumbnail (IShellItemImageFactory) işçisi
let warmShellThumbWorker = null;
let shellThumbSeq = 0;

function getWarmShellThumbWorker() {
  if (warmShellThumbWorker && !warmShellThumbWorker.dead) return warmShellThumbWorker;

  const psScript = `
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Drawing
    $cs = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class LdShellThumb {
  [StructLayout(LayoutKind.Sequential)]
  public struct SIZE { public int cx; public int cy; }

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
  interface IShellItemImageFactory {
    [PreserveSig]
    int GetImage([In, MarshalAs(UnmanagedType.Struct)] SIZE size, [In] int flags, out IntPtr phbm);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr hObject);

  public static bool SaveThumb(string srcPath, string outPath, int maxSize) {
    Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory factory = null;
    IntPtr hbm = IntPtr.Zero;
    try {
      int hr = SHCreateItemFromParsingName(srcPath, IntPtr.Zero, ref iid, out factory);
      if (hr != 0 || factory == null) return false;
      SIZE sz = new SIZE { cx = maxSize, cy = maxSize };
      // 0x04 = SIIGBF_THUMBNAILONLY, 0x00 = SIIGBF_RESIZETOFIT fallback
      hr = factory.GetImage(sz, 0x04, out hbm);
      if (hr != 0 || hbm == IntPtr.Zero) {
        hr = factory.GetImage(sz, 0x00, out hbm);
      }
      if (hr != 0 || hbm == IntPtr.Zero) return false;
      using (Bitmap bmp = Image.FromHbitmap(hbm)) {
        ImageCodecInfo jpgEnc = null;
        foreach (var c in ImageCodecInfo.GetImageEncoders()) {
          if (c.FormatID == ImageFormat.Jpeg.Guid) { jpgEnc = c; break; }
        }
        if (jpgEnc != null) {
          using (EncoderParameters ep = new EncoderParameters(1)) {
            ep.Param[0] = new EncoderParameter(Encoder.Quality, 82L);
            bmp.Save(outPath, jpgEnc, ep);
          }
        } else {
          bmp.Save(outPath, ImageFormat.Jpeg);
        }
      }
      return true;
    } finally {
      if (hbm != IntPtr.Zero) DeleteObject(hbm);
      if (factory != null) Marshal.FinalReleaseComObject(factory);
    }
  }
}
'@
    Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try {
        $req = $line | ConvertFrom-Json
        $reqId = if ($req -and $req.id) { $req.id } else { 0 }
        $ok = [LdShellThumb]::SaveThumb($req.src, $req.out, 240)
        $res = @{ id = $reqId; ok = [bool]$ok } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine('RES|' + $res)
      } catch {
        $reqId = if ($req -and $req.id) { $req.id } else { 0 }
        $errRes = @{ id = $reqId; ok = $false; err = $_.Exception.Message } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine('RES|' + $errRes)
      }
      [Console]::Out.Flush()
    }
  `;

  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });

  const worker = {
    proc,
    pending,
    dead: false,
    readyPromise,
    queueTail: Promise.resolve(),
  };

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line === 'READY') {
      readyResolve(true);
      return;
    }
    if (line.startsWith('RES|')) {
      try {
        const res = JSON.parse(line.slice(4));
        const cb = pending.get(res.id);
        if (cb) {
          pending.delete(res.id);
          cb.resolve(Boolean(res.ok));
        }
      } catch {}
    }
  });

  const failAll = () => {
    worker.dead = true;
    if (warmShellThumbWorker === worker) warmShellThumbWorker = null;
    readyResolve(false);
    for (const cb of pending.values()) cb.resolve(false);
    pending.clear();
  };
  proc.on('error', failAll);
  proc.on('close', failAll);

  warmShellThumbWorker = worker;
  return worker;
}

function runWindowsShellThumb(filePath, outPath) {
  const worker = getWarmShellThumbWorker();
  const job = async () => {
    const ready = await Promise.race([
      worker.readyPromise,
      new Promise((r) => setTimeout(() => r(false), 10000)),
    ]);
    if (!ready || worker.dead) return false;
    return await new Promise((resolve) => {
      const id = ++shellThumbSeq;
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        try {
          if (worker.proc && worker.proc.pid) {
            execFile('taskkill', ['/PID', String(worker.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
          }
        } catch {}
        resolve(false);
      }, 6000);
      worker.pending.set(id, {
        resolve: (ok) => {
          clearTimeout(timer);
          try {
            resolve(Boolean(ok) && fs.existsSync(outPath) && fs.statSync(outPath).size > 100);
          } catch {
            resolve(false);
          }
        },
      });
      try {
        worker.proc.stdin.write(`${JSON.stringify({ id, src: filePath, out: outPath })}\n`, 'utf8');
      } catch {
        clearTimeout(timer);
        worker.pending.delete(id);
        resolve(false);
      }
    });
  };

  const p = worker.queueTail.then(job, job);
  worker.queueTail = p.catch(() => false);
  return p;
}

const thumbQueue = [];
const inFlightThumbs = new Map();
let thumbWorkerActive = false;

async function processThumbQueue() {
  if (thumbWorkerActive) return;
  thumbWorkerActive = true;

  try {
    while (thumbQueue.length > 0) {
      const job = thumbQueue.shift();
      if (job.cancelled) continue;

      try {
        if (fs.existsSync(job.outPath)) {
          cachedThumbSet.add(job.thumbFile);
          job.resolve(job.outPath);
        } else {
          const ext = path.extname(job.filePath).toLowerCase();
          let ok = false;

          if (ext === '.jpg' || ext === '.jpeg') {
            ok = await tryExtractExifThumb(job.filePath, job.outPath);
          }
          if (!ok && VIDEO_EXTS.has(ext)) {
            if (getFfmpegBin()) {
              ok = await runFfmpegThumb(job.filePath, job.outPath, '00:00:02');
              if (!ok) ok = await runFfmpegThumb(job.filePath, job.outPath, '00:00:00');
            }
            if (!ok) ok = await runWindowsShellThumb(job.filePath, job.outPath);
          } else if (!ok) {
            if (getFfmpegBin()) {
              ok = await runFfmpegThumb(job.filePath, job.outPath, null);
            }
            if (!ok) ok = await runWindowsShellThumb(job.filePath, job.outPath);
          }

          if (ok) {
            if (!cachedThumbSet.has(job.thumbFile)) {
              try { addCachedThumbBytes(fs.statSync(job.outPath).size); } catch {}
            }
            cachedThumbSet.add(job.thumbFile);
            try {
              stmtUpsertThumb.run(job.key, job.filePath, job.mtime, job.size, job.thumbFile, Date.now());
            } catch {}
            job.resolve(job.outPath);
          } else {
            job.reject(new Error('Kapak oluşturulamadı'));
          }
        }
      } catch (err) {
        job.reject(err);
      } finally {
        inFlightThumbs.delete(job.key);
      }

      // HDD okuma kafası dinlendirme aralığı (Concurrency=1 garantisi)
      await sleep(40);
    }
  } finally {
    thumbWorkerActive = false;
  }
}

function getOrCreateThumbnail(filePath, mtime, size, sessionId = 'default') {
  const info = getThumbCacheInfo(filePath, mtime, size);
  if (info.cached && fs.existsSync(info.fullPath)) {
    return Promise.resolve(info.fullPath);
  }
  if (inFlightThumbs.has(info.key)) {
    return inFlightThumbs.get(info.key);
  }

  const p = new Promise((resolve, reject) => {
    thumbQueue.push({
      key: info.key,
      filePath,
      mtime: Number(mtime) || 0,
      size: Number(size) || 0,
      thumbFile: info.thumbFile,
      outPath: info.fullPath,
      sessionId,
      cancelled: false,
      resolve,
      reject,
    });
    processThumbQueue();
  });

  inFlightThumbs.set(info.key, p);
  return p;
}

function cancelThumbQueue(sessionId = null) {
  let cancelledCount = 0;
  for (let i = thumbQueue.length - 1; i >= 0; i--) {
    const job = thumbQueue[i];
    if (!sessionId || job.sessionId === sessionId) {
      job.cancelled = true;
      thumbQueue.splice(i, 1);
      inFlightThumbs.delete(job.key);
      job.reject(Object.assign(new Error('İptal edildi'), { cancelled: true }));
      cancelledCount++;
    }
  }
  return cancelledCount;
}


async function clearThumbCache() {
  cancelThumbQueue();
  try {
    const files = await fsp.readdir(THUMBS_DIR);
    for (const f of files) {
      if (f.endsWith('.jpg')) {
        await fsp.unlink(path.join(THUMBS_DIR, f)).catch(() => {});
      }
    }
  } catch {}
  try {
    db.exec('DELETE FROM thumbs;');
  } catch {}
  cachedThumbSet.clear();
  resetCachedThumbBytes();
  return getIndexStats();
}


module.exports = {
  makeThumbKey,
  getThumbCacheInfo,
  tryExtractExifThumb,
  getFfmpegBin,
  runFfmpegThumb,
  getWarmShellThumbWorker,
  runWindowsShellThumb,
  processThumbQueue,
  getOrCreateThumbnail,
  cancelThumbQueue,
  clearThumbCache,
};
