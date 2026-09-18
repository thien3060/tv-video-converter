'use strict';
// End-to-end: real ffmpeg on the synthetic fixtures (skipped if ffmpeg is missing).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ff = require('../src/main/ffmpeg');
const { plan } = require('../src/main/planner');

const FIX = path.join(__dirname, 'fixtures');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tvconv-'));
const have = !!(ff.BIN.ffmpeg && ff.BIN.ffprobe);

async function convert(name, settings = {}) {
  const caps = await ff.detectCapabilities();
  const input = path.join(FIX, name);
  const probe = await ff.probe(input);
  const p = plan(probe, settings);
  const output = path.join(OUT, name.replace(/\.\w+$/, `.${Object.keys(settings).join('_') || 'default'}.${p.outputContainer}`));
  const { args, sidecars } = ff.buildArgs(input, output, p, caps);
  const progress = [];
  await ff.runFfmpeg(args, { duration: p.duration, onProgress: (x) => progress.push(x.percent) });
  for (const sc of sidecars) await ff.extractSrt(input, sc.index, sc.path);
  const out = await ff.probe(output);
  return { plan: p, out, sidecars, progress, args, output };
}

const vid = (pr) => pr.streams.find((s) => s.codec_type === 'video');
const aud = (pr) => pr.streams.filter((s) => s.codec_type === 'audio');

test('clean H.264/AAC MKV → remux + sidecar srt', { skip: !have }, async () => {
  const r = await convert('clean_h264.mkv', { subtitleMode: 'sidecar' });
  assert.equal(r.plan.video.action, 'copy');
  assert.ok(r.args.includes('copy'));
  assert.equal(vid(r.out).codec_name, 'h264');
  assert.equal(aud(r.out)[0].codec_name, 'aac');
  assert.match(r.out.format.format_name, /mp4/);
  assert.equal(r.sidecars.length, 1);
  assert.ok(fs.existsSync(r.sidecars[0].path), 'sidecar srt written');
  assert.match(fs.readFileSync(r.sidecars[0].path, 'utf8'), /Hello from the sidecar/);
  assert.ok(r.progress.length > 0 && r.progress.at(-1) > 50, `progress reported (${r.progress.at(-1)})`);
});

test('Hi10P + DTS → 8-bit HEVC + AC3 5.1', { skip: !have }, async () => {
  const r = await convert('hi10p_dts.mkv');
  assert.equal(r.plan.video.action, 'encode');
  const v = vid(r.out);
  assert.equal(v.codec_name, 'hevc');
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.equal(aud(r.out)[0].codec_name, 'ac3');
  assert.equal(+aud(r.out)[0].channels, 6);
});

test('HEVC10 HDR + FLAC → video copied with tags, audio aac', { skip: !have }, async () => {
  const r = await convert('hevc10_hdr_flac.mkv');
  assert.equal(r.plan.video.action, 'copy');
  const v = vid(r.out);
  assert.equal(v.pix_fmt, 'yuv420p10le');
  assert.equal(v.color_transfer, 'smpte2084');
  assert.equal(aud(r.out)[0].codec_name, 'aac');
});

test('HEVC10 HDR with 10-bit disallowed → re-encoded, still 10-bit HDR (no tonemap)', { skip: !have }, async () => {
  const r = await convert('hevc10_hdr_flac.mkv', { allowHevc10bit: false });
  assert.equal(r.plan.video.action, 'encode');
  const v = vid(r.out);
  assert.equal(v.codec_name, 'hevc');
  assert.match(v.pix_fmt, /10/);
  assert.equal(v.color_transfer, 'smpte2084');
});

test('HEVC10 HDR tonemap → 8-bit SDR', { skip: !have }, async () => {
  const caps = await ff.detectCapabilities();
  if (!caps.filters.tonemap) return; // build without tonemap filter
  const r = await convert('hevc10_hdr_flac.mkv', { hdrMode: 'tonemap' });
  const v = vid(r.out);
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.notEqual(v.color_transfer, 'smpte2084');
});

test('VP9/Opus webm → HEVC + AAC, H.264 when preferred', { skip: !have }, async () => {
  const r = await convert('vp9.webm');
  assert.equal(vid(r.out).codec_name, 'hevc');
  assert.equal(aud(r.out)[0].codec_name, 'aac');
  const r2 = await convert('vp9.webm', { videoCodec: 'h264' });
  assert.equal(vid(r2.out).codec_name, 'h264');
});

test('burn-in subtitles forces encode and drops sub streams', { skip: !have }, async () => {
  const caps = await ff.detectCapabilities();
  if (!caps.filters.subtitles) return;
  const r = await convert('clean_h264.mkv', { subtitleMode: 'burn' });
  assert.equal(r.plan.video.action, 'encode');
  assert.ok(r.args.some((a) => a.startsWith('subtitles=')), 'subtitles filter present');
  assert.equal(r.out.streams.filter((s) => s.codec_type === 'subtitle').length, 0);
  assert.equal(r.sidecars.length, 0);
});

test('embed subtitles → MKV with the SubRip track copied and tagged', { skip: !have }, async () => {
  const r = await convert('clean_h264.mkv', { subtitleMode: 'embed' });
  assert.match(r.output, /\.mkv$/);
  assert.match(r.out.format.format_name, /matroska/);
  assert.equal(vid(r.out).codec_name, 'h264');
  const subs = r.out.streams.filter((s) => s.codec_type === 'subtitle');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].codec_name, 'subrip');
  assert.equal(subs[0].tags.language, 'eng');
  assert.equal(subs[0].tags.title, 'English');
  assert.ok(!r.args.includes('hvc1') && !r.args.includes('+faststart'));
});

test('downscale to 1080p from a larger source', { skip: !have }, async () => {
  // fixtures are 360p; synthesize a quick 4K-ish plan check via maxHeight=240 instead
  const r = await convert('clean_h264.mkv', { maxHeight: 240 });
  assert.equal(r.plan.video.action, 'encode');
  assert.equal(+vid(r.out).height, 240);
});

test('cancel via AbortSignal kills ffmpeg', { skip: !have }, async () => {
  const caps = await ff.detectCapabilities();
  const input = path.join(FIX, 'hi10p_dts.mkv');
  const p = plan(await ff.probe(input), {});
  const { args } = ff.buildArgs(input, path.join(OUT, 'cancel.mp4'), p, caps);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(ff.runFfmpeg(args, { duration: p.duration, signal: ac.signal }), (e) => e.cancelled === true);
});
