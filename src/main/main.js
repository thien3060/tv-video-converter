'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { plan } = require('./planner');
const ff = require('./ffmpeg');

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.avi', '.ts', '.m2ts', '.mts', '.webm', '.wmv', '.flv', '.mpg', '.mpeg', '.vob']);

let win = null;
let caps = null;

// ---------- settings persistence ----------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {
  outputDir: '',                 // '' = "<input folder>/TV Ready"
  videoCodec: 'hevc',
  maxHeight: 2160,
  allowHevc10bit: true,
  hdrMode: 'keep',
  subtitleMode: 'embed',
  quality: 23,
  concurrency: 1,
  deleteSourceOnSuccess: false,
};

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch (e) { console.error(e); }
}

// ---------- queue ----------

/** @type {Map<string, Job>} */
const jobs = new Map();
let nextId = 1;
let running = false;
const active = new Map(); // id -> AbortController

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function stripJob(j) { const { probe, ...rest } = j; return rest; } // probe JSON is large; renderer never needs it
function publish(job) { send('job:update', stripJob(job)); }

function outputPathFor(input) {
  const dir = settings.outputDir || path.join(path.dirname(input), 'TV Ready');
  const base = path.basename(input, path.extname(input));
  let out = path.join(dir, `${base}.mp4`);
  if (path.resolve(out) === path.resolve(input)) out = path.join(dir, `${base}.tv.mp4`);
  return out;
}

async function addFiles(paths) {
  const added = [];
  for (const p of paths) {
    let stat;
    try { stat = await fsp.stat(p); } catch { continue; }
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(p);
      await addFiles(entries.map((e) => path.join(p, e)));
      continue;
    }
    if (!VIDEO_EXT.has(path.extname(p).toLowerCase())) continue;
    if ([...jobs.values()].some((j) => j.input === p && j.status !== 'done' && j.status !== 'error')) continue;
    const job = { id: String(nextId++), input: p, name: path.basename(p), size: stat.size, status: 'queued', percent: 0,
      speed: '', plan: null, output: outputPathFor(p), error: null, reasons: [], startedAt: null, finishedAt: null };
    jobs.set(job.id, job);
    added.push(job);
    publish(job);
    analyze(job); // fire and forget – shows the plan before the user hits Start
  }
  return added;
}

async function analyze(job) {
  job.status = 'analyzing';
  publish(job);
  try {
    const probe = await ff.probe(job.input);
    job.probe = probe;
    job.plan = plan(probe, settings);
    job.reasons = summarizeReasons(job.plan);
    job.status = 'ready';
  } catch (e) {
    job.status = 'error';
    job.error = `probe failed: ${e.stderr || e.message}`.trim();
  }
  publish(job);
}

function summarizeReasons(p) {
  const out = [];
  const v = p.video.source;
  out.push(`Video: ${v.codec} ${v.width}x${v.height} ${v.pix_fmt || ''} ${v.bitrateMbps ? v.bitrateMbps + ' Mbps' : ''}${p.video.hdr ? ' HDR' : ''} → ${p.video.action === 'copy' ? 'copy' : 'encode ' + p.video.codec + (p.video.tenBit ? ' 10-bit' : ' 8-bit')}`);
  for (const r of p.video.reasons) out.push(`  • ${r}`);
  for (const a of p.audio) out.push(`Audio [${a.language}]: ${a.action === 'copy' ? `${a.codec} copy` : `→ ${a.codec} ${a.bitrate} (${a.reasons.join(', ')})`}`);
  for (const s of p.subtitles) out.push(`Subs [${s.language}] ${s.codec}: ${s.action} – ${s.reason}`);
  return out;
}

function replanAll() {
  for (const job of jobs.values()) {
    if (job.probe && (job.status === 'ready' || job.status === 'queued')) {
      job.plan = plan(job.probe, settings);
      job.reasons = summarizeReasons(job.plan);
      job.output = outputPathFor(job.input);
      publish(job);
    }
  }
}

async function runJob(job) {
  const ac = new AbortController();
  active.set(job.id, ac);
  job.status = 'working';
  job.percent = 0;
  job.startedAt = Date.now();
  job.error = null;
  publish(job);
  const tmp = job.output.replace(/\.mp4$/i, '.partial.mp4');
  try {
    if (!job.plan) job.plan = plan(job.probe || (job.probe = await ff.probe(job.input)), settings);
    await fsp.mkdir(path.dirname(job.output), { recursive: true });
    const { args, sidecars } = ff.buildArgs(job.input, tmp, job.plan, caps, job.output);
    job.command = ['ffmpeg', ...args].join(' ');
    let lastPub = 0;
    await ff.runFfmpeg(args, {
      duration: job.plan.duration,
      signal: ac.signal,
      onProgress: (p) => {
        job.percent = p.percent;
        job.speed = p.speed;
        const now = Date.now();
        if (now - lastPub > 300) { lastPub = now; publish(job); }
      },
    });
    for (const sc of sidecars) {
      try { await ff.extractSrt(job.input, sc.index, sc.path); }
      catch (e) { job.reasons.push(`  ! sidecar ${path.basename(sc.path)} failed: ${e.message}`); }
    }
    await fsp.rm(job.output, { force: true });
    await fsp.rename(tmp, job.output);
    job.percent = 100;
    job.status = 'done';
    job.finishedAt = Date.now();
    try { job.outputSize = (await fsp.stat(job.output)).size; } catch {}
    if (settings.deleteSourceOnSuccess) { try { await shell.trashItem(job.input); } catch {} }
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (e.cancelled) { job.status = 'ready'; job.percent = 0; }
    else { job.status = 'error'; job.error = e.message; }
  } finally {
    active.delete(job.id);
    publish(job);
  }
}

async function pump() {
  while (running) {
    const inFlight = active.size;
    const next = [...jobs.values()].find((j) => j.status === 'ready');
    if (!next && inFlight === 0) { running = false; send('queue:state', { running }); return; }
    if (!next || inFlight >= settings.concurrency) { await new Promise((r) => setTimeout(r, 250)); continue; }
    runJob(next); // not awaited – concurrency handled above
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------- IPC ----------

ipcMain.handle('caps:get', async (_e, force) => (caps = await ff.detectCapabilities(force)));
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => { settings = { ...settings, ...patch }; saveSettings(); replanAll(); return settings; });
ipcMain.handle('jobs:list', () => [...jobs.values()].map(stripJob));
ipcMain.handle('jobs:add', async (_e, paths) => (await addFiles(paths)).map(stripJob));
ipcMain.handle('jobs:remove', (_e, id) => { const j = jobs.get(id); if (j && j.status !== 'working') jobs.delete(id); return true; });
ipcMain.handle('jobs:clearDone', () => { for (const [id, j] of jobs) if (j.status === 'done') jobs.delete(id); return true; });
ipcMain.handle('jobs:retry', (_e, id) => { const j = jobs.get(id); if (j && j.status === 'error') { j.error = null; analyze(j); } return true; });
ipcMain.handle('queue:start', () => { if (!running) { running = true; send('queue:state', { running }); pump(); } return running; });
ipcMain.handle('queue:stop', () => { running = false; for (const ac of active.values()) ac.abort(); send('queue:state', { running }); return true; });
ipcMain.handle('dialog:openFiles', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }] });
  return r.canceled ? [] : (await addFiles(r.filePaths)).map(stripJob);
});
ipcMain.handle('dialog:outputDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled) return settings.outputDir;
  settings.outputDir = r.filePaths[0]; saveSettings(); replanAll();
  return settings.outputDir;
});
ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 760, minHeight: 480,
    title: 'TV Converter',
    backgroundColor: '#14161a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

// Files passed on the command line (drag onto the .exe / "Open with") get queued on launch.
function cliFiles(argv) {
  return argv.slice(process.defaultApp ? 2 : 1).filter((a) => !a.startsWith('-') && fs.existsSync(a));
}

app.whenReady().then(async () => {
  loadSettings();
  createWindow();
  const initial = cliFiles(process.argv);
  if (initial.length) win.webContents.once('did-finish-load', () => addFiles(initial));
  if (process.env.TVCONV_SHOT) devScreenshots(process.env.TVCONV_SHOT);
  caps = await ff.detectCapabilities();
  send('caps:ready', caps);
});

// Dev aid: TVCONV_SHOT=<dir> writes PNGs of the window every 2s (used for headless UI checks).
function devScreenshots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const t = setInterval(async () => {
    if (!win || win.isDestroyed()) return clearInterval(t);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `shot-${String(n++).padStart(2, '0')}.png`), img.toPNG());
    if (process.env.TVCONV_SHOT_CLICK && n === 1) win.webContents.executeJavaScript(process.env.TVCONV_SHOT_CLICK).catch(() => {});
  }, 2000);
}
app.on('window-all-closed', () => { running = false; for (const ac of active.values()) ac.abort(); app.quit(); });
