# TagMix

TagMix is a responsive rehearsal app for four-part music from [BarbershopTags.com](https://www.barbershoptags.com). It presents only tags with Bass, Baritone, Lead, and Tenor learning tracks plus sheet music, trims empty space from the score, and turns the source recordings into a synchronized four-part mixer.

## What it does

- Searches titles, alternate titles, versions, and arrangers across the live compatible catalog.
- Renders PDF, PNG, JPEG, and GIF scores as cropped, browser-safe PNG images.
- Converts MP3, M4A, WMA, and MIDI learning tracks to normalized dual-mono MP3.
- Pads shorter learning tracks with trailing silence so every voice for a tag has the same duration.
- Includes an in-browser chromatic pitch pipe and polyphonic three-octave piano on every tag and on a standalone tools page.
- Detects and extracts the named voice from either channel when a source track has one part on one side and the other three on the other side.
- Provides volume, pan, mute, solo, and pitch-preserving 0.25×–1× playback controls.
- Transposes the mix by ±6 semitones without changing its speed, using either real-time browser processing or server-rendered audio for direct comparison. Client mode prefers an AudioWorklet and uses a compatibility processor when a plain-HTTP network origin hides that API.
- Routes the four voices through a mono-safe, headroom-adjusted, peak-limited mix bus to prevent summed-track clipping.
- Saves mixer settings and timestamp marks in the current browser without requiring an account.
- Keeps a daily metadata cache and generates media only when someone opens a tag.

Part-predominant or undocumented recordings remain available and are labeled “best-effort,” because quiet backing voices may remain in those sources.

For split-stereo tags, TagMix analyzes all four aligned learning tracks together. It chooses the left/right assignment whose opposite channels can best be reconstructed from the other three named voices, with a lower-energy fallback only when that relationship is ambiguous. The result is cached per tag with the processed audio.

## Run with Docker

Docker is the recommended path because the image includes FFmpeg, Poppler, ImageMagick, FluidSynth, and a compact General MIDI soundfont.

```bash
docker compose up --build
```

Open <http://localhost:3000>. The `tagmix-data` volume retains catalog metadata and generated media between container restarts.

## Run locally

Requirements:

- Node.js 22 or newer
- FFmpeg and FFprobe (FFmpeg's Rubber Band filter is preferred for high-quality server-side pitch shifting; a built-in FFmpeg fallback is used when unavailable)
- Poppler (`pdftoppm`)
- ImageMagick (`magick` or `convert`)
- FluidSynth and a GM `.sf2`/`.sf3` soundfont for the small number of MIDI tracks

Then run:

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` to override the cache directory, refresh interval, or soundfont path. The default runtime cache is `.data/`, which is intentionally excluded from Git.

## Verification

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

With a server running and Chromium installed, the optional browser smoke test checks the 360 px layout, search, four-track readiness/playback, and mark persistence:

```bash
TAGMIX_TEST_URL=http://localhost:3000 npm run smoke:browser
```

The principal runtime endpoints are:

- `GET /api/tags` — filtered search and pagination
- `GET /api/tags/:id` — normalized tag metadata
- `GET /api/tags/:id/sheet` — cropped PNG score
- `GET /api/tags/:id/audio/:voice` — processed MP3 with HTTP range support; an optional whole-number `pitch=-6…6` query renders that many semitones at unchanged duration
- `GET /api/health` — process and catalog-cache status

## Data and media

TagMix does not ship a copy of the source library. It reads the public BarbershopTags API, attributes and links every tag to its source page, and caches requested source/derived files on the server. Server-side pitch variants are generated on first request and remain in that disposable cache; client-side pitch processing does not create another media file. The source site describes its catalog as freely downloadable; deployments should still preserve attribution and avoid removing the original-page links.
