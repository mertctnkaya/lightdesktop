'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { runPowerShellEnv } = require('../utils/psRunner');
const { markDirMutated, makeUniquePath } = require('./mutationTracker');
const { recordAppError } = require('./loggerService');

function makeTempJsonFile(prefix, data) {
  const file = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

async function listZipEntries(zipPath) {
  const resolved = path.resolve(String(zipPath || ''));
  if (!fs.existsSync(resolved)) {
    throw new Error('ZIP dosyası bulunamadı');
  }
  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = $null
    try {
      $zip = [System.IO.Compression.ZipFile]::OpenRead($env:LD_ZIP_PATH)
      $list = New-Object System.Collections.Generic.List[object]
      foreach ($e in $zip.Entries) {
        $isDir = $e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\\') -or [string]::IsNullOrEmpty($e.Name)
        $ms = 0
        try { $ms = [long]([DateTimeOffset]$e.LastWriteTime).ToUnixTimeMilliseconds() } catch {}
        $list.Add([PSCustomObject]@{
          fullName = $e.FullName
          name = if ($e.Name) { $e.Name } else { $e.FullName.TrimEnd('/','\\') }
          isDir = $isDir
          size = [long]$e.Length
          compressedSize = [long]$e.CompressedLength
          mtimeMs = $ms
        })
      }
      if ($list.Count -eq 0) { Write-Output '[]' }
      elseif ($list.Count -eq 1) { Write-Output ('[' + ($list[0] | ConvertTo-Json -Compress) + ']') }
      else { Write-Output ($list | ConvertTo-Json -Depth 4 -Compress) }
    } finally {
      if ($zip) { $zip.Dispose() }
    }
    exit 0
  `;
  const raw = await runPowerShellEnv(psScript, { LD_ZIP_PATH: resolved }, 25000);
  let entries = [];
  try {
    const parsed = JSON.parse(raw || '[]');
    entries = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch {
    entries = [];
  }
  let fileCount = 0;
  let dirCount = 0;
  let totalSize = 0;
  let totalCompressedSize = 0;
  for (const e of entries) {
    if (e.isDir) dirCount++;
    else {
      fileCount++;
      totalSize += Number(e.size) || 0;
      totalCompressedSize += Number(e.compressedSize) || 0;
    }
  }
  const st = await fsp.stat(resolved);
  return {
    zipPath: resolved,
    name: path.basename(resolved),
    archiveSize: st.size,
    fileCount,
    dirCount,
    totalSize,
    totalCompressedSize,
    entries,
  };
}

async function extractZipEntries(zipPath, destDir, selectedEntries = null) {
  const resolvedZip = path.resolve(String(zipPath || ''));
  const resolvedDest = path.resolve(String(destDir || ''));
  if (!fs.existsSync(resolvedZip)) throw new Error('ZIP dosyası bulunamadı');
  await fsp.mkdir(resolvedDest, { recursive: true });

  const hasFilter = Array.isArray(selectedEntries) && selectedEntries.length > 0;
  const entriesFile = hasFilter ? makeTempJsonFile('ld_zip_sel', selectedEntries) : '';

  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $baseFull = [System.IO.Path]::GetFullPath($env:LD_DEST_DIR)
    if (-not $baseFull.EndsWith('\\')) { $baseFull += '\\' }
    $selectedSet = $null
    $selectedDirs = New-Object System.Collections.Generic.List[string]
    if ($env:LD_ENTRIES_FILE -and (Test-Path -LiteralPath $env:LD_ENTRIES_FILE)) {
      $raw = Get-Content -LiteralPath $env:LD_ENTRIES_FILE -Raw -Encoding UTF8
      $arr = $raw | ConvertFrom-Json
      if ($arr -isnot [System.Array]) { $arr = @($arr) }
      $selectedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      foreach ($s in $arr) {
        if ($null -ne $s) {
          $n = ([string]$s).Replace('\\', '/').TrimStart('/')
          [void]$selectedSet.Add($n)
          if ($n.EndsWith('/')) { $selectedDirs.Add($n) }
        }
      }
    }
    $zip = $null
    $extracted = 0
    try {
      $zip = [System.IO.Compression.ZipFile]::OpenRead($env:LD_ZIP_PATH)
      foreach ($e in $zip.Entries) {
        $normEntry = $e.FullName.Replace('\\', '/').TrimStart('/')
        if ($selectedSet -ne $null) {
          $match = $selectedSet.Contains($normEntry)
          if (-not $match) {
            foreach ($dp in $selectedDirs) {
              if ($normEntry.StartsWith($dp, [StringComparison]::OrdinalIgnoreCase)) { $match = $true; break }
            }
          }
          if (-not $match) { continue }
        }
        $relOs = $normEntry.Replace('/', '\\')
        if ([string]::IsNullOrWhiteSpace($relOs)) { continue }
        $targetFull = [System.IO.Path]::GetFullPath((Join-Path $baseFull $relOs))
        if (-not $targetFull.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $isDir = $e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\\') -or [string]::IsNullOrEmpty($e.Name)
        if ($isDir) {
          [System.IO.Directory]::CreateDirectory($targetFull) | Out-Null
        } else {
          $parent = [System.IO.Path]::GetDirectoryName($targetFull)
          if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $targetFull, $true)
          $extracted++
        }
      }
      Write-Output $extracted
    } finally {
      if ($zip) { $zip.Dispose() }
    }
    exit 0
  `;

  try {
    const out = await runPowerShellEnv(
      psScript,
      {
        LD_ZIP_PATH: resolvedZip,
        LD_DEST_DIR: resolvedDest,
        LD_ENTRIES_FILE: entriesFile,
      },
      120000
    );
    markDirMutated(resolvedDest);
    return {
      ok: true,
      destDir: resolvedDest,
      extractedFiles: Number(String(out || '0').trim()) || 0,
    };
  } catch (err) {
    recordAppError('ZIP Ayıklama', resolvedZip, err.message);
    throw err;
  } finally {
    if (entriesFile) await fsp.unlink(entriesFile).catch(() => {});
  }
}

async function createZipArchive(sourcePaths = [], destZipPath) {
  const validSources = (Array.isArray(sourcePaths) ? sourcePaths : [])
    .map((p) => path.resolve(String(p || '')))
    .filter((p) => fs.existsSync(p));
  if (validSources.length === 0) throw new Error('Sıkıştırılacak geçerli öğe bulunamadı');

  let targetZip = path.resolve(String(destZipPath || ''));
  if (!targetZip.toLowerCase().endsWith('.zip')) targetZip += '.zip';
  await fsp.mkdir(path.dirname(targetZip), { recursive: true });
  if (fs.existsSync(targetZip)) targetZip = makeUniquePath(targetZip);

  const sourcesFile = makeTempJsonFile('ld_zip_src', validSources);
  const psScript = `
    $OutputEncoding = [System.Text.Encoding]::UTF8
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $raw = Get-Content -LiteralPath $env:LD_SOURCES_FILE -Raw -Encoding UTF8
    $arr = $raw | ConvertFrom-Json
    if ($arr -isnot [System.Array]) { $arr = @($arr) }
    $zip = $null
    $added = 0
    try {
      $zip = [System.IO.Compression.ZipFile]::Open($env:LD_OUT_ZIP, [System.IO.Compression.ZipArchiveMode]::Create)
      $level = [System.IO.Compression.CompressionLevel]::Optimal
      foreach ($src in $arr) {
        if (-not $src -or -not (Test-Path -LiteralPath $src)) { continue }
        $fullSrc = [System.IO.Path]::GetFullPath($src)
        $rootName = [System.IO.Path]::GetFileName($fullSrc.TrimEnd('\\'))
        if (-not $rootName) { $rootName = 'Arsiv' }
        if (Test-Path -LiteralPath $fullSrc -PathType Container) {
          $basePrefix = $fullSrc.TrimEnd('\\') + '\\'
          $items = Get-ChildItem -LiteralPath $fullSrc -Recurse -Force -ErrorAction SilentlyContinue
          $hasAny = $false
          foreach ($it in $items) {
            $rel = $it.FullName.Substring($basePrefix.Length).Replace('\\', '/')
            $entryName = $rootName + '/' + $rel
            if ($it.PSIsContainer) {
              [void]$zip.CreateEntry($entryName.TrimEnd('/') + '/')
            } else {
              [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $it.FullName, $entryName, $level) | Out-Null
              $added++
            }
            $hasAny = $true
          }
          if (-not $hasAny) {
            [void]$zip.CreateEntry($rootName + '/')
          }
        } else {
          [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $fullSrc, $rootName, $level) | Out-Null
          $added++
        }
      }
      Write-Output $added
    } finally {
      if ($zip) { $zip.Dispose() }
    }
    exit 0
  `;

  try {
    const out = await runPowerShellEnv(
      psScript,
      {
        LD_SOURCES_FILE: sourcesFile,
        LD_OUT_ZIP: targetZip,
      },
      180000
    );
    const st = await fsp.stat(targetZip);
    markDirMutated(path.dirname(targetZip));
    return {
      ok: true,
      zipPath: targetZip,
      name: path.basename(targetZip),
      size: st.size,
      addedFiles: Number(String(out || '0').trim()) || 0,
    };
  } catch (err) {
    await fsp.unlink(targetZip).catch(() => {});
    recordAppError('ZIP Sıkıştırma', targetZip, err.message);
    throw err;
  } finally {
    await fsp.unlink(sourcesFile).catch(() => {});
  }
}

module.exports = {
  listZipEntries,
  extractZipEntries,
  createZipArchive,
};
