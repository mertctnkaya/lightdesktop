'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runPowerShellEnv } = require('../utils/psRunner');

async function setOsFileClipboard(op, paths = []) {
  const valid = (Array.isArray(paths) ? paths : []).map((p) => path.resolve(p)).filter((p) => fs.existsSync(p));
  if (valid.length === 0) return { ok: false, count: 0 };
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $paths = $env:LD_CLIP_PATHS -split [char]10 | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    if ($paths.Count -gt 0) {
      $col = New-Object System.Collections.Specialized.StringCollection
      foreach ($p in $paths) { [void]$col.Add($p) }
      $data = New-Object System.Windows.Forms.DataObject
      $data.SetFileDropList($col)
      $effectVal = if ($env:LD_CLIP_OP -eq 'cut') { [byte[]](2,0,0,0) } else { [byte[]](5,0,0,0) }
      $ms = New-Object System.IO.MemoryStream(, $effectVal)
      $data.SetData('Preferred DropEffect', $ms)
      [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
    }
    exit 0
  `;
  await runPowerShellEnv(psScript, {
    LD_CLIP_OP: op === 'cut' ? 'cut' : 'copy',
    LD_CLIP_PATHS: valid.join('\n'),
  }, 8000, true);
  return { ok: true, count: valid.length };
}

async function getOsFileClipboard() {
  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    Add-Type -AssemblyName System.Windows.Forms
    $paths = @()
    $op = 'copy'
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      $list = [System.Windows.Forms.Clipboard]::GetFileDropList()
      foreach ($p in $list) { if ($p) { $paths += $p } }
      $data = [System.Windows.Forms.Clipboard]::GetDataObject()
      if ($data -and $data.GetDataPresent('Preferred DropEffect')) {
        $eff = $data.GetData('Preferred DropEffect')
        if ($eff -is [System.IO.MemoryStream]) {
          $bytes = $eff.ToArray()
          if ($bytes.Length -ge 1 -and ($bytes[0] -band 2) -eq 2 -and ($bytes[0] -band 1) -eq 0) {
            $op = 'cut'
          }
        }
      }
    }
    @{ op = $op; paths = $paths } | ConvertTo-Json -Compress
    exit 0
  `;
  try {
    const out = await runPowerShellEnv(psScript, {}, 6000, true);
    const parsed = JSON.parse(String(out || '').trim() || '{}');
    const paths = Array.isArray(parsed.paths) ? parsed.paths : (parsed.paths ? [parsed.paths] : []);
    return { ok: true, op: parsed.op === 'cut' ? 'cut' : 'copy', paths: paths.filter((p) => fs.existsSync(p)) };
  } catch {
    return { ok: false, op: 'copy', paths: [] };
  }
}


module.exports = {
  setOsFileClipboard,
  getOsFileClipboard,
};
