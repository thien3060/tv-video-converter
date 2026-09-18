'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { languageName } = require('./planner');

// ---------- binary location ----------

function binDir() {
  // Packaged: <app>/resources/bin/<platform>/ ; dev: <repo>/resources/bin/<platform>/
  const base = process.resourcesPath && !process.defaultApp
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '..', '..', 'resources', 'bin');
  return path.join(base, process.platform);
}

function findBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = path.join(binDir(), exe);
  if (fs.existsSync(bundled)) return bundled;
  // Fall back to PATH (dev on mac with brew ffmpeg).
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (d && fs.existsSync(p)) return p;
  }
  return null;
}

const BIN = {
  get ffmpeg() { return findBinary('ffmpeg'); },
  get ffprobe() { return findBinary('ffprobe'); },
};

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

// ---------- capabilities ----------

const HEVC_CHAIN = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_videotoolbox', 'libx265'];
const H264_CHAIN = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'libx264'];

let capsCache = null;
let capsInflight = null;

// Renderer and main both ask at startup; share one detection run.
function detectCapabilities(force = false) {
  if (capsCache && !force) return Promise.resolve(capsCache);
  if (!capsInflight) capsInflight = detectCapabilitiesUncached().finally(() => { capsInflight = null; });
  return capsInflight;
}

async function detectCapabilitiesUncached() {
  const ffmpeg = BIN.ffmpeg;
  const ffprobe = BIN.ffprobe;
  const caps = { ffmpeg, ffprobe, version: null, encoders: {}, filters: {}, hevc: null, h264: null, error: null };
  if (!ffmpeg || !ffprobe) {
    caps.error = 'ffmpeg/ffprobe not found. Run "npm run fetch-ffmpeg" or install ffmpeg.';
    capsCache = caps;
    return caps;
  }
  try {
    const v = await run(ffmpeg, ['-version']);
    caps.version = v.stdout.split('\n')[0].replace(/ Copyright.*$/, '');
    const enc = (await run(ffmpeg, ['-hide_banner', '-encoders'])).stdout;
    const flt = (await run(ffmpeg, ['-hide_banner', '-filters'])).stdout;
    for (const name of [...HEVC_CHAIN, ...H264_CHAIN, 'aac', 'ac3']) {
      caps.encoders[name] = new RegExp(`^\\s*V[\\w.]+\\s+${name}\\s|^\\s*A[\\w.]+\\s+${name}\\s`, 'm').test(enc);
    }
    for (const name of ['zscale', 'tonemap', 'subtitles', 'scale', 'format']) {
      caps.filters[name] = new RegExp(`\\s${name}\\s`).test(flt);
    }
    // An encoder being listed doesn't mean the driver is there – actually try it.
    caps.hevc = await firstWorking(ffmpeg, HEVC_CHAIN.filter((n) => caps.encoders[n]));
    caps.h264 = await firstWorking(ffmpeg, H264_CHAIN.filter((n) => caps.encoders[n]));
  } catch (e) {
    caps.error = `ffmpeg failed to start: ${e.message}`;
  }
  capsCache = caps;
  return caps;
}

async function firstWorking(ffmpeg, names) {
  for (const name of names) {
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=0.2:r=25',
        '-c:v', name, '-f', 'null', '-'], { timeout: 20000 });
      return name;
    } catch { /* try next */ }
  }
  return null;
}

// ---------- probe ----------

async function probe(file) {
  const { stdout } = await run(BIN.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(stdout);
}

// ---------- command building ----------

function encoderArgs(encoder, plan, settings) {
  const q = String(settings.quality);
  const { height } = plan.video.source;
  const outH = plan.video.scaleTo && plan.video.scaleTo.height ? plan.video.scaleTo.height : height;
  // Cap the max rate so bitrate spikes can't exceed what the TV decodes.
  const maxrate = outH > 1080 ? '40M' : outH > 720 ? '14M' : '6M';
  const bufsize = outH > 1080 ? '80M' : outH > 720 ? '28M' : '12M';
  const tenBit = plan.video.tenBit;
  const args = [];

  switch (encoder) {
    case 'hevc_nvenc':
    case 'h264_nvenc':
      args.push('-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', q, '-b:v', '0', '-maxrate', maxrate, '-bufsize', bufsize,
        '-spatial-aq', '1', '-temporal-aq', '1', '-bf', '3', '-b_ref_mode', 'middle');
      if (encoder === 'hevc_nvenc') args.push('-profile:v', tenBit ? 'main10' : 'main', '-tag:v', 'hvc1');
      else args.push('-profile:v', 'high', '-level', '5.1');
      break;
    case 'hevc_qsv':
    case 'h264_qsv':
      args.push('-preset', 'slower', '-global_quality', q, '-look_ahead', '1', '-maxrate', maxrate, '-bufsize', bufsize);
      if (encoder === 'hevc_qsv') args.push('-profile:v', tenBit ? 'main10' : 'main', '-tag:v', 'hvc1');
      break;
    case 'hevc_amf':
    case 'h264_amf':
      args.push('-quality', 'quality', '-rc', 'vbr_peak', '-qp_i', q, '-qp_p', q, '-maxrate', maxrate, '-bufsize', bufsize);
      if (encoder === 'hevc_amf') args.push('-tag:v', 'hvc1');
      break;
    case 'hevc_videotoolbox':
    case 'h264_videotoolbox':
      args.push('-q:v', String(Math.max(1, 100 - settings.quality * 2)), '-maxrate', maxrate, '-bufsize', bufsize);
      if (encoder === 'hevc_videotoolbox') args.push('-profile:v', tenBit ? 'main10' : 'main', '-tag:v', 'hvc1');
      break;
    case 'libx265':
      args.push('-preset', 'medium', '-crf', q, '-maxrate', maxrate, '-bufsize', bufsize,
        '-x265-params', `vbv-maxrate=${parseInt(maxrate)}000:vbv-bufsize=${parseInt(bufsize)}000`, '-tag:v', 'hvc1');
      if (tenBit) args.push('-profile:v', 'main10');
      break;
    case 'libx264':
      args.push('-preset', 'medium', '-crf', q, '-maxrate', maxrate, '-bufsize', bufsize, '-profile:v', 'high', '-level', '5.1');
      break;
    default:
      throw new Error(`unknown encoder ${encoder}`);
  }
  args.push('-pix_fmt', tenBit ? (encoder.includes('nvenc') || encoder.includes('qsv') ? 'p010le' : 'yuv420p10le') : 'yuv420p');
  return args;
}

function escapeFilterPath(p) {
  // ffmpeg filter option escaping: backslash, colon, and quote need escaping; on Windows also the drive colon.
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function buildVideoFilter(plan, caps, inputFile, subIndexInFile) {
  const filters = [];
  const v = plan.video;
  if (v.tonemap) {
    if (caps.filters.zscale) {
      filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=hable:desat=0',
        'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
    } else {
      // Fallback without libzimg: less accurate but keeps colours sane.
      filters.push('format=gbrpf32le', 'tonemap=hable:desat=0', 'format=yuv420p');
    }
    // Encoders take colour tags from frame metadata, so -color_* alone is ignored; set them in-graph.
    filters.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709');
  }
  if (v.scaleTo) {
    if (v.scaleTo.height) filters.push(`scale=-2:${v.scaleTo.height}`);
    else filters.push(`scale=${v.scaleTo.width}:-2`);
  }
  if (v.capFps) filters.push(`fps=${v.capFps}`);
  if (subIndexInFile != null) {
    const sub = plan.subtitles.find((s) => s.action === 'burn');
    const isBitmap = sub && !['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(sub.codec);
    if (!isBitmap) filters.push(`subtitles='${escapeFilterPath(inputFile)}':si=${subIndexInFile}`);
    // Bitmap subs are handled via overlay in buildArgs (needs a second input map).
  }
  return filters.join(',');
}

// Track name shown by players that list titles: keep the source title, else build one from the
// language, and number tracks that would otherwise be indistinguishable ("Spanish", "Spanish 2").
function embedTitle(x, all) {
  if (x.title) return x.title;
  let name = languageName(x.language);
  if (x.forced) name += ' (forced)';
  const same = all.filter((o) => !o.title && o.language === x.language && !!o.forced === !!x.forced);
  if (same.length > 1) name += ` ${same.indexOf(x) + 1}`;
  return name;
}

// Returns { args, sidecars: [{index, path}] }
function buildArgs(inputFile, outputFile, plan, caps, finalOutput = outputFile) {
  const s = plan.settings;
  const args = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-stats_period', '0.5', '-progress', 'pipe:1', '-nostats'];

  // Hardware decode on NVIDIA speeds things up a lot; only when we're encoding with nvenc.
  const encoder = plan.video.action === 'encode' ? (plan.video.codec === 'h264' ? caps.h264 : caps.hevc) : null;
  if (encoder && encoder.includes('nvenc') && !plan.video.tonemap && !plan.subtitles.some((x) => x.action === 'burn')) {
    args.push('-hwaccel', 'cuda');
  }
  args.push('-i', inputFile);

  const mkv = plan.outputContainer === 'mkv';

  // --- video ---
  args.push('-map', `0:${plan.video.index}`);
  if (plan.video.action === 'copy') {
    args.push('-c:v', 'copy');
    if (plan.video.codec === 'hevc' && !mkv) args.push('-tag:v', 'hvc1');
  } else {
    if (!encoder) throw new Error('no usable video encoder found');
    const burn = plan.subtitles.find((x) => x.action === 'burn');
    const burnIsBitmap = burn && ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'].includes(burn.codec);
    // The subtitles filter's `si` is the index among the file's subtitle streams (plan.subtitles is in file order).
    const subIdx = burn && !burnIsBitmap ? plan.subtitles.indexOf(burn) : null;
    const vf = buildVideoFilter(plan, caps, inputFile, subIdx);
    if (burnIsBitmap) {
      // overlay bitmap subtitle stream on the video
      const chain = vf ? `[0:${plan.video.index}]${vf}[v0];[v0][0:${burn.index}]overlay[vout]` : `[0:${plan.video.index}][0:${burn.index}]overlay[vout]`;
      args.splice(args.indexOf('-map'), 2, '-filter_complex', chain, '-map', '[vout]');
    } else if (vf) {
      args.push('-vf', vf);
    }
    args.push('-c:v', encoder, ...encoderArgs(encoder, plan, s));
    if (plan.video.hdr && plan.video.tenBit && !plan.video.tonemap) {
      args.push('-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc');
    } else if (plan.video.tonemap) {
      args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    }
  }

  // --- audio ---
  plan.audio.forEach((a, i) => {
    args.push('-map', `0:${a.index}`);
    if (a.action === 'copy') args.push(`-c:a:${i}`, 'copy');
    else args.push(`-c:a:${i}`, a.codec, `-b:a:${i}`, a.bitrate, `-ac:${i}`, String(a.channels));
    if (a.language && a.language !== 'und') args.push(`-metadata:s:a:${i}`, `language=${a.language}`);
    if (a.title) args.push(`-metadata:s:a:${i}`, `title=${a.title}`);
  });

  // --- embedded subtitles (MKV only: the planner never picks 'embed' for an MP4 target) ---
  const embed = plan.subtitles.filter((x) => x.action === 'embed');
  embed.forEach((x, i) => {
    args.push('-map', `0:${x.index}`, `-c:s:${i}`, x.outCodec === 'copy' ? 'copy' : 'srt');
    // Always set the language ourselves: source tags like 'es-419' get normalised by the planner
    // so the TV shows a language name rather than "Language N".
    args.push(`-metadata:s:s:${i}`, `language=${x.language}`);
    args.push(`-metadata:s:s:${i}`, `title=${embedTitle(x, embed)}`);
  });
  if (!embed.length) args.push('-sn');

  args.push('-map_metadata', '0', '-map_chapters', '0');
  if (mkv) args.push('-f', 'matroska', outputFile);
  else args.push('-movflags', '+faststart', '-f', 'mp4', outputFile);

  // --- sidecar .srt ---
  const sidecars = plan.subtitles.filter((x) => x.action === 'sidecar').map((x, i, all) => {
    const base = finalOutput.replace(/\.(mp4|mkv)$/i, '');
    const dupes = all.filter((o) => o.language === x.language).length;
    const suffix = dupes > 1 ? `.${x.language}.${i + 1}` : `.${x.language}`;
    return { index: x.index, path: `${base}${suffix}.srt` };
  });

  return { args, sidecars };
}

// ---------- execution with progress ----------

function parseProgressBlock(text, state) {
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k === 'out_time_us' || k === 'out_time_ms') state.outTimeSec = +v / 1e6;
    else if (k === 'speed') state.speed = v;
    else if (k === 'fps') state.fps = +v;
    else if (k === 'progress') state.done = v === 'end';
  }
}

function runFfmpeg(args, { duration, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { outTimeSec: 0, speed: '', fps: 0, done: false };
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const idx = buf.lastIndexOf('progress=');
      if (idx < 0) return;
      const end = buf.indexOf('\n', idx);
      if (end < 0) return;
      parseProgressBlock(buf.slice(0, end + 1), state);
      buf = buf.slice(end + 1);
      const pct = duration ? Math.min(99.9, (state.outTimeSec / duration) * 100) : 0;
      onProgress && onProgress({ percent: pct, speed: state.speed, fps: state.fps, outTimeSec: state.outTimeSec });
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      if (code === 0) resolve({ stderr });
      else reject(Object.assign(new Error(stderr.trim().split('\n').slice(-3).join(' | ') || `ffmpeg exited with ${code}`), { stderr }));
    });
  });
}

async function extractSrt(inputFile, streamIndex, outPath) {
  await run(BIN.ffmpeg, ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-i', inputFile, '-map', `0:${streamIndex}`, '-c:s', 'srt', outPath]);
}

module.exports = { BIN, detectCapabilities, probe, buildArgs, runFfmpeg, extractSrt, encoderArgs };
