# TV Converter

Drop video files in, get Samsung-TV-safe MP4s out. Each input becomes one `.mp4`
with the same name (plus sidecar `.srt` files for text subtitles).

It probes every file with `ffprobe` and does the **minimum** needed:

| Source                                        | Action                                   |
|-----------------------------------------------|------------------------------------------|
| 8-bit H.264 / HEVC under the bitrate ceiling  | remux only (seconds, no quality loss)    |
| 10-bit H.264 (Hi10P), VP9, AV1, MPEG-4, VC-1… | re-encode → HEVC (or H.264) via GPU      |
| Bitrate > 50 Mbps (H.264) / 80 Mbps (HEVC)    | re-encode with a capped max-rate         |
| HDR sources needing re-encode                 | kept as 10-bit HEVC HDR, or tonemapped   |
| DTS / TrueHD / FLAC / Opus / PCM audio        | → AC3 5.1 (640k) or AAC stereo (192k)    |
| AAC / AC3 / E-AC3 / MP3 audio                 | copied                                   |
| Text subtitles                                | sidecar `.srt` (default), embed, or burn |
| PGS/VobSub bitmap subtitles                   | dropped unless "burn" is chosen          |

Encoder priority: NVENC → QSV → AMF → VideoToolbox → libx265/libx264 (CPU).
Detected at startup with a real test encode, shown in the title bar.

## Development (macOS or Windows)

```bash
brew install ffmpeg        # macOS dev only; Windows build bundles its own
npm install
npm test                   # planner unit tests + real-ffmpeg e2e on tiny fixtures
npm start                  # run the app; you can pass video paths as args
```

## Build the Windows app (from macOS)

```bash
npm run build:win
```

This downloads the BtbN win64 GPL ffmpeg build into `resources/bin/win32/`
(NVENC, libass, libzimg included) and produces:

- `dist/TV Converter-Setup-0.1.0.exe` – NSIS installer
- `dist/TV Converter-Portable-0.1.0.exe` – single-file portable

The build is unsigned; Windows SmartScreen will show "More info → Run anyway" once.

## Layout

- `src/main/planner.js` – pure decision logic (probe JSON + settings → plan). Unit-tested.
- `src/main/ffmpeg.js` – binary lookup, capability detection, ffmpeg arg building, progress parsing.
- `src/main/main.js` – Electron main: queue, IPC, settings persistence.
- `src/renderer/` – the UI (vanilla HTML/CSS/JS, no framework).
- `scripts/fetch-ffmpeg.mjs` – downloads static ffmpeg builds for bundling.
