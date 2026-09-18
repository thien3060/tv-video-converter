// Downloads a static ffmpeg + ffprobe into resources/bin/<platform>/ so it can be
// bundled with the app. Windows: BtbN GPL build (NVENC/QSV/AMF, libass, libzimg).
// Usage: node scripts/fetch-ffmpeg.mjs [win32|darwin|all]
import { createWriteStream, existsSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const BIN = path.join(ROOT, 'resources', 'bin');

const SOURCES = {
  win32: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    files: ['ffmpeg.exe', 'ffprobe.exe'],
  },
  darwin: {
    // Dev only – macOS builds usually just use brew ffmpeg from PATH.
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    urlProbe: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
    files: ['ffmpeg', 'ffprobe'],
  },
};

async function download(url, dest) {
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function unzip(zip, dir) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zip}' -DestinationPath '${dir}'`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-oq', zip, '-d', dir], { stdio: 'inherit' });
  }
}

function findFile(dir, name) {
  const out = execFileSync(process.platform === 'win32' ? 'where' : 'find', process.platform === 'win32' ? ['/r', dir, name] : [dir, '-name', name, '-type', 'f'], { encoding: 'utf8' });
  const first = out.split(/\r?\n/).find(Boolean);
  if (!first) throw new Error(`${name} not found in ${dir}`);
  return first;
}

async function fetchPlatform(platform) {
  const src = SOURCES[platform];
  const outDir = path.join(BIN, platform);
  mkdirSync(outDir, { recursive: true });
  if (src.files.every((f) => existsSync(path.join(outDir, f)))) { console.log(`✓ ${platform}: already present`); return; }
  const tmp = path.join(os.tmpdir(), `ffmpeg-fetch-${platform}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const urls = [src.url, src.urlProbe].filter(Boolean);
  for (let i = 0; i < urls.length; i++) {
    const zip = path.join(tmp, `dl${i}.zip`);
    await download(urls[i], zip);
    unzip(zip, path.join(tmp, `x${i}`));
  }
  for (const f of src.files) {
    const found = findFile(tmp, f);
    const dest = path.join(outDir, f);
    execFileSync(process.platform === 'win32' ? 'cmd' : 'cp', process.platform === 'win32' ? ['/c', 'copy', '/y', found, dest] : [found, dest]);
    if (platform !== 'win32') chmodSync(dest, 0o755);
    console.log(`✓ ${path.relative(ROOT, dest)}`);
  }
  rmSync(tmp, { recursive: true, force: true });
}

const want = process.argv[2] || 'win32';
const targets = want === 'all' ? Object.keys(SOURCES) : [want];
for (const t of targets) await fetchPlatform(t);
