'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SERVER_DIR } = require('../config/constants');

function scanJsMtime(dir, maxRef) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'public') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      scanJsMtime(full, maxRef);
    } else if (ent.name.endsWith('.js')) {
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > maxRef.max) maxRef.max = st.mtimeMs;
      } catch {}
    }
  }
}

function getBackendCodeMtimeMs() {
  const maxRef = { max: 0 };
  scanJsMtime(SERVER_DIR, maxRef);
  return Math.floor(maxRef.max);
}

const START_CODE_MTIME = getBackendCodeMtimeMs();

module.exports = {
  getBackendCodeMtimeMs,
  START_CODE_MTIME,
};
