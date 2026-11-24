'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { MIME_TYPES } = require('../config/constants');
const { registerOpenStream, unregisterOpenStream } = require('../services/streamRegistry');
const { recordAppError } = require('../services/loggerService');

function sendJson(res, status, data) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function pipeFileStream(req, res, filePath, streamOpts = undefined) {
  const rs = fs.createReadStream(filePath, streamOpts);
  const streamEntry = { rs, res };
  const streamKey = registerOpenStream(filePath, streamEntry);
  const cleanup = () => {
    unregisterOpenStream(streamKey, streamEntry);
    try {
      if (!rs.destroyed) rs.destroy();
    } catch {}
  };
  rs.on('error', (err) => {
    cleanup();
    if (!res.headersSent && !res.writableEnded) {
      res.writeHead(404);
      res.end('Dosya okunamadı');
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
    if (err && err.code !== 'ENOENT' && err.code !== 'ECONNRESET') {
      recordAppError('Dosya Akışı', filePath, err.message);
    }
  });
  rs.on('close', () => unregisterOpenStream(streamKey, streamEntry));
  res.on('close', cleanup);
  req.on('aborted', cleanup);
  rs.pipe(res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > 10 * 1024 * 1024) {
        req.destroy();
        return reject(new Error('İstek boyutu çok büyük'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Geçersiz JSON gövdesi'));
      }
    });
    req.on('error', reject);
  });
}


// ---------- Medya Akışı (HTTP Range Destekli QuickLook) ----------
async function streamMedia(req, res, filePath) {
  try {
    const resolved = path.resolve(filePath);
    const st = await fsp.stat(resolved);
    if (!st.isFile()) {
      res.writeHead(404);
      return res.end('Dosya bulunamadı');
    }
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const start = match ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? Math.min(parseInt(match[2], 10), st.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, st.size - 1);
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
      });
      pipeFileStream(req, res, resolved, { start, end });
    } else {
      res.writeHead(200, {
        'Content-Length': st.size,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
      });
      pipeFileStream(req, res, resolved);
    }
  } catch (err) {
    res.writeHead(404);
    res.end(err.message);
  }
}


module.exports = {
  sendJson,
  pipeFileStream,
  readJsonBody,
  streamMedia,
};
