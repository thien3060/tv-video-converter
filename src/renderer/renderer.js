'use strict';

const $ = (id) => document.getElementById(id);
const jobs = new Map();
let settings = {};
let caps = null;
let running = false;

// ---------- helpers ----------

function fmtSize(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 2 ? 2 : 0)} ${u[i]}`;
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function dirname(p) { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : ''; }

// ---------- rendering ----------

function renderJob(job) {
  let tr = document.querySelector(`tr[data-id="${job.id}"]`);
  if (!tr) {
    tr = el('tr'); tr.dataset.id = job.id;
    tr.append(el('td', 'name'), el('td', 'size'), el('td', 'plan'), el('td'), el('td'));
    $('jobs-body').append(tr);
  }
  const [tdName, tdSize, tdPlan, tdStatus, tdActions] = tr.children;

  tdName.replaceChildren(el('span', null, job.name), el('span', 'path', dirname(job.input)));
  tdName.title = job.input;
  tdSize.textContent = fmtSize(job.size) + (job.outputSize ? ` → ${fmtSize(job.outputSize)}` : '');

  tdPlan.replaceChildren();
  if (job.plan) {
    const enc = job.plan.video.action === 'encode';
    const pill = el('span', `pill ${enc ? 'encode' : 'remux'}`, enc ? `Encode ${job.plan.video.codec.toUpperCase()}` : 'Remux');
    pill.title = 'Click for details';
    pill.onclick = () => showModal(job.name, job.reasons.join('\n') + (job.command ? `\n\n${job.command}` : ''));
    tdPlan.append(pill);
  }

  const status = el('div', 'status');
  const label = el('div', 'label');
  const bar = el('div', 'bar'); const fill = el('i'); bar.append(fill);
  switch (job.status) {
    case 'queued': label.textContent = 'Queued'; break;
    case 'analyzing': label.textContent = 'Analyzing…'; bar.classList.add('indeterminate'); break;
    case 'ready': label.textContent = 'Ready'; break;
    case 'working':
      label.append(el('span', null, `${job.percent.toFixed(1)}%`), el('span', null, job.speed ? `${job.speed}` : ''));
      fill.style.width = `${job.percent}%`; break;
    case 'done':
      label.classList.add('ok');
      label.append(el('span', null, 'Done'), el('span', null, job.finishedAt && job.startedAt ? fmtDur(job.finishedAt - job.startedAt) : ''));
      fill.style.width = '100%'; bar.classList.add('done'); break;
    case 'error':
      label.classList.add('err'); label.textContent = job.error || 'Error'; label.title = job.error || ''; break;
  }
  status.append(label, bar);
  tdStatus.replaceChildren(status);

  const actions = el('div', 'actions');
  if (job.status === 'done') {
    const b = el('button', 'icon-btn', '📂'); b.title = 'Show output'; b.onclick = () => window.api.showItem(job.output); actions.append(b);
  }
  if (job.status === 'error') {
    const b = el('button', 'icon-btn', '↻'); b.title = 'Retry'; b.onclick = () => window.api.retryJob(job.id); actions.append(b);
    const l = el('button', 'icon-btn', 'ℹ'); l.title = 'Details'; l.onclick = () => showModal(job.name, `${job.error}\n\n${(job.reasons || []).join('\n')}\n\n${job.command || ''}`); actions.append(l);
  }
  if (job.status !== 'working') {
    const b = el('button', 'icon-btn', '✕'); b.title = 'Remove'; b.onclick = async () => { await window.api.removeJob(job.id); jobs.delete(job.id); tr.remove(); refreshChrome(); }; actions.append(b);
  }
  tdActions.replaceChildren(actions);
}

function refreshChrome() {
  const all = [...jobs.values()];
  const has = all.length > 0;
  $('dropzone').hidden = has;
  $('queue-scroll').hidden = !has;
  $('queue-footer').hidden = !has;
  const ready = all.filter((j) => j.status === 'ready').length;
  const done = all.filter((j) => j.status === 'done').length;
  const err = all.filter((j) => j.status === 'error').length;
  const working = all.filter((j) => j.status === 'working').length;
  $('summary').textContent = `${all.length} file${all.length === 1 ? '' : 's'} · ${ready} ready · ${working} working · ${done} done${err ? ` · ${err} failed` : ''}`;
  $('btn-start').disabled = running || ready === 0 || !caps || !!caps.error;
  $('btn-start').hidden = running;
  $('btn-stop').hidden = !running;
}

function renderCaps() {
  const c = caps;
  const bar = $('caps');
  if (!c) { bar.textContent = 'detecting ffmpeg…'; return; }
  if (c.error) { bar.textContent = c.error; bar.className = 'caps bad'; }
  else {
    bar.className = 'caps';
    bar.textContent = `${c.version} · HEVC: ${c.hevc || 'none'} · H.264: ${c.h264 || 'none'}`;
  }
  const d = $('caps-detail');
  d.replaceChildren();
  if (c.error) { d.textContent = c.error; return; }
  const lines = [
    ['ffmpeg', c.ffmpeg],
    ['HEVC encoder', c.hevc || '— none —'],
    ['H.264 encoder', c.h264 || '— none —'],
    ['HDR tonemap', c.filters.zscale ? 'zscale (accurate)' : c.filters.tonemap ? 'tonemap only (approx.)' : 'unavailable'],
    ['Burn-in subs', c.filters.subtitles ? 'yes' : 'no'],
  ];
  for (const [k, v] of lines) { const p = el('div'); p.append(el('b', null, `${k}: `), el('span', null, v)); d.append(p); }
  const hw = (c.hevc || '').replace(/^.*_/, '');
  const note = el('div');
  note.style.marginTop = '8px';
  note.textContent = /nvenc|qsv|amf|videotoolbox/.test(c.hevc || '') ? `Hardware encoding via ${hw.toUpperCase()} ✓` : 'No GPU encoder found – CPU encoding will be slow.';
  d.append(note);
}

function showModal(title, body) { $('modal-title').textContent = title; $('modal-body').textContent = body; $('modal').hidden = false; }

// ---------- settings ----------

const FIELDS = ['videoCodec', 'maxHeight', 'quality', 'allowHevc10bit', 'hdrMode', 'subtitleMode', 'concurrency', 'deleteSourceOnSuccess'];

function fillSettings() {
  $('s-outputDir').value = settings.outputDir || '';
  for (const f of FIELDS) {
    const input = $(`s-${f}`);
    if (input.type === 'checkbox') input.checked = !!settings[f];
    else input.value = String(settings[f]);
  }
}

function bindSettings() {
  for (const f of FIELDS) {
    const input = $(`s-${f}`);
    input.addEventListener('change', async () => {
      let v = input.type === 'checkbox' ? input.checked : input.value;
      if (['maxHeight', 'quality', 'concurrency'].includes(f)) v = +v;
      settings = await window.api.setSettings({ [f]: v });
    });
  }
  $('s-outputDir-pick').onclick = async () => { settings.outputDir = await window.api.chooseOutputDir(); $('s-outputDir').value = settings.outputDir; };
  $('s-outputDir-clear').onclick = async () => { settings = await window.api.setSettings({ outputDir: '' }); $('s-outputDir').value = ''; };
  $('btn-redetect').onclick = async () => { caps = null; renderCaps(); caps = await window.api.getCaps(true); renderCaps(); refreshChrome(); };
}

// ---------- events ----------

function bind() {
  $('btn-add').onclick = async () => { for (const j of await window.api.openFilesDialog()) { jobs.set(j.id, j); renderJob(j); } refreshChrome(); };
  $('dropzone').onclick = () => $('btn-add').click();
  $('btn-start').onclick = () => window.api.start();
  $('btn-stop').onclick = () => window.api.stop();
  $('btn-settings').onclick = () => { $('settings').hidden = !$('settings').hidden; };
  $('btn-clear').onclick = async () => { await window.api.clearDone(); for (const [id, j] of jobs) if (j.status === 'done') { jobs.delete(id); document.querySelector(`tr[data-id="${id}"]`)?.remove(); } refreshChrome(); };
  $('btn-open-out').onclick = () => {
    const first = [...jobs.values()].find((j) => j.status === 'done') || [...jobs.values()][0];
    if (first) window.api.openPath(settings.outputDir || dirname(first.output));
  };
  $('modal-close').onclick = () => { $('modal').hidden = true; };
  $('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').hidden = true; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('modal').hidden = true; });

  const q = $('queue');
  let depth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; q.classList.add('dragover'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; q.classList.remove('dragover'); } });
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; q.classList.remove('dragover');
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    for (const j of await window.api.addPaths(paths)) { jobs.set(j.id, j); renderJob(j); }
    refreshChrome();
  });

  window.api.onJobUpdate((job) => { jobs.set(job.id, job); renderJob(job); refreshChrome(); });
  window.api.onQueueState((s) => { running = s.running; refreshChrome(); });
  window.api.onCapsReady((c) => { caps = c; renderCaps(); refreshChrome(); });
}

// ---------- init ----------

(async () => {
  bind();
  bindSettings();
  settings = await window.api.getSettings();
  fillSettings();
  for (const j of await window.api.listJobs()) { jobs.set(j.id, j); renderJob(j); }
  refreshChrome();
  caps = await window.api.getCaps();
  renderCaps();
  refreshChrome();
})();
