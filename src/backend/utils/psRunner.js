'use strict';

const { execFile } = require('node:child_process');

function extractPowerShellStderr(rawStderr) {
  const s = String(rawStderr || '').trim();
  if (!s) return '';
  if (!s.startsWith('#< CLIXML')) return s;
  const parts = [];
  const re = /<S S="Error">([\s\S]*?)<\/S>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const decoded = m[1]
      .replace(/_x000D__x000A_/g, ' ')
      .replace(/_x000A_/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();
    if (decoded) parts.push(decoded);
  }
  if (parts.length > 0) return parts.join(' ').trim();
  return s.replace(/^#< CLIXML[\s\S]*/i, '').trim() || 'PowerShell betik hatası';
}

function runPowerShellEnv(script, envVars = {}, timeoutMs = 30000, useSta = false) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const psArgs = ['-NoProfile', '-NonInteractive'];
    if (useSta) psArgs.push('-STA');
    psArgs.push('-EncodedCommand', encoded);
    execFile(
      'powershell.exe',
      psArgs,
      { env: { ...process.env, ...envVars }, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const cleanErr = extractPowerShellStderr(stderr)
            || String(err.message || '').replace(/powershell\.exe[\s\S]*?-EncodedCommand\s+[A-Za-z0-9+/=]+/i, `PowerShell hatası (kod ${err.code || 1})`);
          return reject(new Error(cleanErr || `PowerShell hatası (kod ${err.code || 1})`));
        }
        resolve(stdout);
      }
    );
  });
}


module.exports = {
  extractPowerShellStderr,
  runPowerShellEnv,
};
