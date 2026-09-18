# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron desktop app ("TV Converter") that turns arbitrary video files into Samsung-TV-safe MP4s. It probes each file with `ffprobe`, decides the *minimum* work needed (remux vs. GPU re-encode per stream), and runs `ffmpeg`. Plain CommonJS, vanilla HTML/CSS/JS renderer, no bundler, no framework, no transpilation.

## Commands

```bash
npm install
brew install ffmpeg        # macOS dev: ffmpeg/ffprobe are picked up from PATH (/opt/homebrew/bin)
npm start                  # run the app; extra args = video paths to queue on launch
npm test                   # node --test test/*.test.js  (planner unit tests + real-ffmpeg e2e)
node --test test/planner.test.js                       # one file
node --test --test-name-pattern="Hi10P" test/*.test.js # one test by name
npm run fetch-ffmpeg       # download BtbN win64 ffmpeg into resources/bin/win32/ (gitignored)
npm run build:win          # fetch-ffmpeg + electron-builder --win → dist/ (NSIS + portable, unsigned)
npm run build:mac          # electron-builder --mac (dir target only)
```

No linter or formatter is configured. Tests use `node:test` + `node:assert/strict`; the e2e tests self-skip when ffmpeg isn't found.

Dev aid: `TVCONV_SHOT=<dir> npm start` writes a PNG of the window every 2s (optionally `TVCONV_SHOT_CLICK=<js>` runs JS in the page after the first shot) for headless UI checks.

## Architecture

Three main-process modules with a deliberate separation, plus a thin renderer:

- **[src/main/planner.js](src/main/planner.js)** — *pure, no I/O.* `plan(probeJson, settings)` → a plan object describing, per stream, `copy`/`encode`/`sidecar`/`embed`/`burn`/`drop` plus human-readable `reasons`. All Samsung-compat policy lives here (safe codec sets, Hi10P rule, bitrate ceilings, HDR keep/tonemap, one-burn-track rule). `DEFAULT_SETTINGS` here is merged under whatever the caller passes. Unit-tested with canned probe JSON in [test/planner.test.js](test/planner.test.js) — add a test here whenever you change a decision rule.
- **[src/main/ffmpeg.js](src/main/ffmpeg.js)** — everything that touches the binaries: `findBinary` (bundled `resources/bin/<platform>/` first, then PATH), `detectCapabilities` (parses `-encoders`/`-filters`, then does a *real test encode* per candidate to pick the first working encoder from NVENC → QSV → AMF → VideoToolbox → libx26x; cached and de-duplicated across callers), `probe`, `buildArgs(plan, caps)` (plan → ffmpeg argv + sidecar list), `runFfmpeg` (spawns with `-progress pipe:1`, parses progress blocks, supports AbortSignal), `extractSrt`.
- **[src/main/main.js](src/main/main.js)** — Electron main: settings persistence (`userData/settings.json`), the job queue (`Map<id, Job>`), IPC handlers, and the `pump()` loop that respects `settings.concurrency`. Jobs are analyzed (probed + planned) immediately on add so the UI shows the plan before Start; `settings:set` triggers `replanAll()` so plans stay in sync with settings. Output is written to `<name>.partial.mp4` then renamed on success. The `probe` field is stripped before sending jobs to the renderer.
- **[src/main/preload.js](src/main/preload.js)** — `contextBridge` exposing `window.api` (invoke wrappers + `onJobUpdate`/`onQueueState`/`onCapsReady` listeners). `contextIsolation: true`, `nodeIntegration: false`; use `webUtils.getPathForFile` for dropped files (Electron ≥32 removed `File.path`).
- **[src/renderer/](src/renderer/)** — one table of jobs re-rendered per `job:update` event; talks to main only via `window.api`.

Data flow: drop/dialog → `jobs:add` → `analyze()` (probe → plan) → `job:update` → Start → `pump()` → `runJob()` (`buildArgs` → `runFfmpeg` → `extractSrt` sidecars → rename).

### Things that are easy to get wrong

- `buildArgs` depends on stream *index* semantics: `-map 0:N` uses the absolute stream index from ffprobe, but the `subtitles=...:si=N` filter uses the index *among subtitle streams* (`plan.subtitles.indexOf(burn)` works because plan order == file order).
- Bitmap subs (PGS/VobSub) can't be burned via the `subtitles` filter; `buildArgs` switches to `-filter_complex ... overlay` and replaces the initial `-map` via `splice`.
- `-hwaccel cuda` is only added for NVENC *and* only when no software filter (tonemap/burn) is in the chain.
- HDR re-encode without tonemap must stay 10-bit HEVC regardless of `videoCodec` preference (8-bit HDR looks grey). Tonemap sets colour tags via `setparams` in-graph because encoders ignore bare `-color_*` flags.
- `encoderArgs` maps the single `quality` setting differently per encoder (`-cq`, `-global_quality`, `-qp_*`, VideoToolbox `-q:v` inverted scale, `-crf`); maxrate/bufsize are tiered by output height.

## Packaging notes

[electron-builder.yml](electron-builder.yml): asar on, `src/**` + `package.json` only. ffmpeg binaries are shipped via `extraResources` to `<install>/resources/bin/<platform>/`, which is exactly where `ffmpeg.js#binDir()` looks when `process.resourcesPath` is set and `process.defaultApp` is not. `resources/bin/*/ffmpeg*` is gitignored — run `npm run fetch-ffmpeg` before a Windows build (the `build:win` script does this).

Test fixtures in [test/fixtures/](test/fixtures/) are tiny synthetic clips (clean H.264, Hi10P+DTS, HEVC10 HDR+FLAC, VP9/Opus, plus an `.srt`) covering each planner branch; the e2e tests convert them into a temp dir and re-probe the result.
