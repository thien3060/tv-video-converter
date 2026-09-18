'use strict';

// Pure decision logic: given an ffprobe result + user settings, decide what
// ffmpeg should do to each stream so the output plays on a Samsung TV.
// No I/O here so it can be unit-tested with canned probe JSON.

const DEFAULT_SETTINGS = {
  videoCodec: 'hevc',          // 'hevc' | 'h264'  (target when re-encoding)
  maxHeight: 2160,             // 2160 | 1080
  allowHevc10bit: true,        // pass through HEVC Main10 without re-encoding
  hdrMode: 'keep',             // 'keep' | 'tonemap'  (only matters on re-encode)
  subtitleMode: 'sidecar',     // 'sidecar' | 'embed' | 'burn' | 'none'
  maxBitrateH264: 50,          // Mbps – above this, re-encode
  maxBitrateHevc: 80,          // Mbps
  quality: 23,                 // CQ / CRF
};

// Samsung TVs choke on these no matter what.
const SAFE_VIDEO = new Set(['h264', 'hevc']);
const SAFE_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3']);
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const BITMAP_SUBS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

const TEN_BIT_FORMATS = /p010|yuv4(20|22|44)p10|yuv4(20|22|44)p12|gbrp10|gbrp12/;

function isHdr(v) {
  return v.color_transfer === 'smpte2084' || v.color_transfer === 'arib-std-b67' ||
    v.color_primaries === 'bt2020';
}

function is10bit(v) {
  return TEN_BIT_FORMATS.test(v.pix_fmt || '') || (v.bits_per_raw_sample && +v.bits_per_raw_sample > 8);
}

function parseFps(rate) {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n;
}

// Video bitrate in Mbps. MKV rarely tags per-stream bitrate, so fall back to
// overall container bitrate, which overstates by the audio share – acceptable.
function videoBitrateMbps(probe, v) {
  const s = +v.bit_rate || +(v.tags && v.tags.BPS) || 0;
  if (s) return s / 1e6;
  const f = +(probe.format && probe.format.bit_rate) || 0;
  return f / 1e6;
}

function langOf(s) {
  return (s.tags && (s.tags.language || s.tags.LANGUAGE)) || 'und';
}

function planVideo(probe, v, settings, burnSubs) {
  const reasons = [];
  const codec = v.codec_name;
  const height = +v.height || 0;
  const width = +v.width || 0;
  const tenBit = is10bit(v);
  const hdr = isHdr(v);
  const fps = parseFps(v.avg_frame_rate || v.r_frame_rate);
  const bitrate = videoBitrateMbps(probe, v);

  if (!SAFE_VIDEO.has(codec)) reasons.push(`codec ${codec} not supported by TV`);
  if (codec === 'h264' && tenBit) reasons.push('10-bit H.264 (Hi10P) cannot be hardware-decoded');
  if (codec === 'hevc' && tenBit && !settings.allowHevc10bit) reasons.push('10-bit HEVC pass-through disabled');
  if (codec === 'h264' && bitrate > settings.maxBitrateH264) reasons.push(`H.264 bitrate ${bitrate.toFixed(0)} Mbps > ${settings.maxBitrateH264}`);
  if (codec === 'hevc' && bitrate > settings.maxBitrateHevc) reasons.push(`HEVC bitrate ${bitrate.toFixed(0)} Mbps > ${settings.maxBitrateHevc}`);
  if (height > settings.maxHeight) reasons.push(`${width}x${height} exceeds max height ${settings.maxHeight}`);
  if (width > 3840) reasons.push(`width ${width} > 3840 (DCI 4K)`);
  if (fps > 60.5) reasons.push(`${fps.toFixed(2)} fps > 60`);
  if (burnSubs) reasons.push('burning subtitles requires re-encode');
  if (hdr && settings.hdrMode === 'tonemap') reasons.push('tonemapping HDR to SDR');

  const encode = reasons.length > 0;
  // Never re-encode HDR to 8-bit without a tonemap – it just looks grey.
  const outputTenBit = encode && hdr && settings.hdrMode !== 'tonemap';
  const targetCodec = settings.videoCodec === 'h264' && !outputTenBit ? 'h264' : 'hevc';

  let scaleTo = null;
  if (encode) {
    if (height > settings.maxHeight) scaleTo = { height: settings.maxHeight };
    else if (width > 3840) scaleTo = { width: 3840 };
  }

  return {
    index: v.index,
    action: encode ? 'encode' : 'copy',
    codec: encode ? targetCodec : codec,
    reasons,
    tenBit: encode ? outputTenBit : tenBit,
    hdr,
    tonemap: encode && hdr && settings.hdrMode === 'tonemap',
    scaleTo,
    capFps: encode && fps > 60.5 ? 60 : null,
    source: { codec, width, height, pix_fmt: v.pix_fmt, fps: +fps.toFixed(3), bitrateMbps: +bitrate.toFixed(1), profile: v.profile, level: v.level },
  };
}

function planAudio(streams) {
  return streams.map((a) => {
    const codec = a.codec_name;
    const channels = +a.channels || 2;
    const reasons = [];
    if (!SAFE_AUDIO.has(codec)) reasons.push(`audio codec ${codec} not supported`);
    if (channels > 6) reasons.push(`${channels} channels > 6`);
    const encode = reasons.length > 0;
    const outChannels = Math.min(channels, 6);
    return {
      index: a.index,
      action: encode ? 'encode' : 'copy',
      codec: encode ? (outChannels > 2 ? 'ac3' : 'aac') : codec,
      channels: outChannels,
      bitrate: encode ? (outChannels > 2 ? '640k' : '192k') : null,
      language: langOf(a),
      title: (a.tags && a.tags.title) || '',
      reasons,
    };
  });
}

function planSubtitles(streams, mode) {
  return streams.map((s) => {
    const codec = s.codec_name;
    const text = TEXT_SUBS.has(codec);
    const bitmap = BITMAP_SUBS.has(codec);
    let action = 'drop';
    let reason = '';
    if (mode === 'none') reason = 'subtitles disabled';
    else if (mode === 'burn') { action = 'burn'; reason = text ? 'burn text sub' : 'burn bitmap sub'; }
    else if (text && mode === 'sidecar') { action = 'sidecar'; reason = 'export as .srt next to output'; }
    else if (text && mode === 'embed') { action = 'embed'; reason = 'embed as mov_text'; }
    else if (bitmap) reason = `${codec} bitmap subs cannot go in MP4 (use burn to keep)`;
    else reason = `unknown subtitle codec ${codec}`;
    return {
      index: s.index,
      action,
      codec,
      language: langOf(s),
      title: (s.tags && s.tags.title) || '',
      forced: !!(s.disposition && s.disposition.forced),
      isDefault: !!(s.disposition && s.disposition.default),
      reason,
    };
  });
}

function plan(probe, userSettings = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...userSettings };
  const streams = probe.streams || [];
  const videos = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  if (!videos.length) throw new Error('no video stream found');

  let subtitles = planSubtitles(subs, settings.subtitleMode);
  // Burn only one track: forced > default > first.
  if (settings.subtitleMode === 'burn' && subtitles.length) {
    const pick = subtitles.find((s) => s.forced) || subtitles.find((s) => s.isDefault) || subtitles[0];
    subtitles = subtitles.map((s) => (s === pick ? s : { ...s, action: 'drop', reason: 'only one subtitle can be burned' }));
  }
  const video = planVideo(probe, videos[0], settings, subtitles.some((s) => s.action === 'burn'));
  const audio = planAudio(audios);

  const container = (probe.format && probe.format.format_name) || '';
  const duration = +(probe.format && probe.format.duration) || 0;
  const needsWork = video.action === 'encode' || audio.some((a) => a.action === 'encode') ||
    subs.length > 0 || !/mp4/.test(container);

  return {
    settings,
    duration,
    container,
    video,
    audio,
    subtitles,
    summary: video.action === 'encode' ? 'encode' : 'remux',
    needsWork,
  };
}

module.exports = { plan, DEFAULT_SETTINGS, isHdr, is10bit };
