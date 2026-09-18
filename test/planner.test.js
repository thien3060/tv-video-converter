'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../src/main/planner');

function probe({ video = {}, audio = [], subs = [], format = {} } = {}) {
  const streams = [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p',
    avg_frame_rate: '24000/1001', bit_rate: '8000000', ...video }];
  audio.forEach((a, i) => streams.push({ index: 1 + i, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' }, ...a }));
  subs.forEach((s, i) => streams.push({ index: 1 + audio.length + i, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' }, disposition: {}, ...s }));
  return { streams, format: { format_name: 'matroska,webm', duration: '5400.0', bit_rate: '9000000', ...format } };
}

test('clean 8-bit H.264 + AAC is a remux', () => {
  const p = plan(probe({ audio: [{}] }));
  assert.equal(p.video.action, 'copy');
  assert.equal(p.audio[0].action, 'copy');
  assert.equal(p.summary, 'remux');
});

test('10-bit H.264 (Hi10P) forces encode', () => {
  const p = plan(probe({ video: { pix_fmt: 'yuv420p10le' } }));
  assert.equal(p.video.action, 'encode');
  assert.match(p.video.reasons.join(), /Hi10P/);
  assert.equal(p.video.codec, 'hevc');
  assert.equal(p.video.tenBit, false);
});

test('HEVC Main10 SDR passes through by default, encodes when disabled', () => {
  const src = { codec_name: 'hevc', width: 3840, height: 2160, pix_fmt: 'yuv420p10le', bit_rate: '30000000' };
  assert.equal(plan(probe({ video: src })).video.action, 'copy');
  assert.equal(plan(probe({ video: src }), { allowHevc10bit: false }).video.action, 'encode');
});

test('bitrate over ceiling triggers encode; falls back to container bitrate when stream has none', () => {
  const p1 = plan(probe({ video: { codec_name: 'hevc', bit_rate: '95000000' } }));
  assert.equal(p1.video.action, 'encode');
  const p2 = plan(probe({ video: { bit_rate: undefined }, format: { bit_rate: '60000000' } }));
  assert.equal(p2.video.action, 'encode');
  assert.match(p2.video.reasons[0], /H\.264 bitrate 60/);
});

test('HDR re-encode keeps 10-bit HEVC even when H.264 is preferred', () => {
  const p = plan(probe({ video: { codec_name: 'vp9', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', color_primaries: 'bt2020' } }), { videoCodec: 'h264' });
  assert.equal(p.video.action, 'encode');
  assert.equal(p.video.codec, 'hevc');
  assert.equal(p.video.tenBit, true);
  assert.equal(p.video.tonemap, false);
});

test('HDR tonemap produces 8-bit output', () => {
  const p = plan(probe({ video: { codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', bit_rate: '20000000' } }), { hdrMode: 'tonemap' });
  assert.equal(p.video.action, 'encode');
  assert.equal(p.video.tonemap, true);
  assert.equal(p.video.tenBit, false);
});

test('4K source with maxHeight 1080 scales down', () => {
  const p = plan(probe({ video: { width: 3840, height: 2160 } }), { maxHeight: 1080 });
  assert.equal(p.video.action, 'encode');
  assert.deepEqual(p.video.scaleTo, { height: 1080 });
});

test('audio: DTS → ac3 (6ch), FLAC stereo → aac, 8ch → 6ch ac3', () => {
  const p = plan(probe({ audio: [
    { codec_name: 'dts', channels: 6 },
    { codec_name: 'flac', channels: 2 },
    { codec_name: 'truehd', channels: 8 },
    { codec_name: 'eac3', channels: 6 },
  ] }));
  assert.deepEqual(p.audio.map((a) => [a.action, a.codec, a.channels]), [
    ['encode', 'ac3', 6], ['encode', 'aac', 2], ['encode', 'ac3', 6], ['copy', 'eac3', 6],
  ]);
});

test('embed mode targets MKV and keeps text + bitmap subs; other modes target MP4', () => {
  const subs = [{ codec_name: 'subrip' }, { codec_name: 'ass' }, { codec_name: 'hdmv_pgs_subtitle' }, { codec_name: 'mov_text' }, { codec_name: 'webvtt' }];
  const p = plan(probe({ subs }));
  assert.equal(p.outputContainer, 'mkv');
  assert.deepEqual(p.subtitles.map((s) => s.action), ['embed', 'embed', 'embed', 'embed', 'embed']);
  assert.deepEqual(p.subtitles.map((s) => s.outCodec), ['copy', 'copy', 'copy', 'srt', 'srt']);
  assert.equal(p.video.action, 'copy');
  for (const subtitleMode of ['sidecar', 'burn', 'none']) assert.equal(plan(probe({ subs }), { subtitleMode }).outputContainer, 'mp4');
  // an MKV source whose streams all copy straight through needs no work in embed mode
  assert.equal(plan(probe({ subs: [{ codec_name: 'subrip' }] })).needsWork, false);
  assert.equal(plan(probe({ subs: [{ codec_name: 'webvtt' }] })).needsWork, true);
  assert.equal(plan(probe({ subs: [{ codec_name: 'subrip' }] }), { subtitleMode: 'sidecar' }).needsWork, true);
});

test('subtitles: sidecar for text, drop PGS unless burning; burn picks forced track only', () => {
  const subs = [{ codec_name: 'subrip' }, { codec_name: 'hdmv_pgs_subtitle', tags: { language: 'jpn' } }, { codec_name: 'ass', disposition: { forced: 1 } }];
  const side = plan(probe({ subs }), { subtitleMode: 'sidecar' });
  assert.deepEqual(side.subtitles.map((s) => s.action), ['sidecar', 'drop', 'sidecar']);
  assert.equal(side.video.action, 'copy');

  const burn = plan(probe({ subs }), { subtitleMode: 'burn' });
  assert.deepEqual(burn.subtitles.map((s) => s.action), ['drop', 'drop', 'burn']);
  assert.equal(burn.video.action, 'encode');

  const none = plan(probe({ subs }), { subtitleMode: 'none' });
  assert.ok(none.subtitles.every((s) => s.action === 'drop'));
});

test('burn mode with no subtitles does not force an encode', () => {
  const p = plan(probe(), { subtitleMode: 'burn' });
  assert.equal(p.video.action, 'copy');
});

test('cover art streams are ignored as video', () => {
  const pr = probe();
  pr.streams.unshift({ index: 9, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 900, disposition: { attached_pic: 1 } });
  const p = plan(pr);
  assert.equal(p.video.index, 0);
});

test('throws without a video stream', () => {
  assert.throws(() => plan({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac' }], format: {} }), /no video/);
});

test('subtitle language: regional/2-letter tags normalise to ISO 639-2, untagged tracks infer from title', () => {
  const subs = [
    { tags: { language: 'es-419', title: 'Spanish (Latin America)' } },
    { tags: { language: 'und', title: 'Español' } },
    { tags: { language: 'pt_BR' } },
    { tags: { title: 'Forced' } },
    { tags: { language: 'zho' } },
  ];
  const p = plan(probe({ subs }));
  assert.deepEqual(p.subtitles.map((s) => s.language), ['spa', 'spa', 'por', 'und', 'chi']);
  assert.deepEqual(p.subtitles.map((s) => s.action), ['embed', 'embed', 'embed', 'embed', 'embed']);
});
