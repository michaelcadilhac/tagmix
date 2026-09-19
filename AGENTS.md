# TagMix agent guide

## Project description

TagMix is a Docker-first Next.js and TypeScript web app for rehearsing four-part tags from BarbershopTags.com. It filters the public source catalog to records that have all four named learning tracks (Bass, Bari, Lead, Tenor) and sheet music. A selected tag shows automatically cropped music beside a synchronized, pitch-preserving four-part mixer, plus browser-synthesized pitch-pipe and piano reference tools. Mixer preferences and timestamp marks are device-local; there are no user accounts.

## Architecture

- `src/lib/catalog.ts` fetches, tolerantly parses, normalizes, filters, and caches the XML catalog.
- `src/lib/media.ts` securely fetches allowlisted source media and invokes FFmpeg, Poppler, ImageMagick, or FluidSynth for on-demand conversion.
- `src/app/api/` exposes catalog, detail, cropped-score, processed-audio, and health routes.
- `src/components/catalog-browser.tsx` owns search/filter/pagination UI.
- `src/components/tag-workspace.tsx`, `score-viewer.tsx`, and `mixer.tsx` own the rehearsal experience.
- `src/components/note-tools.tsx` and `src/lib/notes.ts` own the reusable, client-only pitch-pipe and piano tools shown below scores and on `/tools`.
- `.data/` is a disposable, versioned runtime cache and must never be committed.

## Source invariants and quirks

- `Learning=Yes` in the upstream API means at least one track, not all four. Always enforce non-empty Bass, Bari, Lead, and Tenor fields locally.
- TagMix also requires sheet music. Do not loosen either eligibility rule without a product decision.
- The legacy XML occasionally contains invalid UTF-8 bytes and numeric entities such as `&#039;`; preserve tolerant decoding and entity normalization.
- “One part on one side” recordings do not use a consistent side across the catalog. Analyze all four aligned tracks with the cross-track reconstruction selector, cache the per-voice decision, extract the detected channel, and duplicate it to stereo. Tag 37 is the regression case: Bass must come from the right channel.
- Single-part sources are downmixed to mono. Part-predominant and undocumented sources are best-effort and must remain visibly labeled as such.
- Browser clients must use same-origin media routes. Do not expose arbitrary proxy URLs or weaken the source-origin allowlist.
- BarbershopTags detail routes require both the numeric ID and a nonempty slug (`/tag-ID-slug`); rebuild `sourcePageUrl` from title/version even for cached catalog records rather than emitting `/tag-ID`.
- Media cache paths include processing-version directory names. Bump the corresponding version when a processing change must invalidate old output.

## Programming guidelines

- Keep TypeScript strict and prefer small pure functions for parsing, ranking, media policy, and range handling.
- Use Server Components by default and add `"use client"` only where browser state or Web Audio APIs require it.
- Do not access BarbershopTags directly from client components. Catalog normalization and media conversion belong on the server.
- Preserve HTTP byte-range support for audio; seeking and browser media loading depend on it.
- Continue using `HTMLAudioElement` playback with `preservesPitch` and Web Audio gain/pan nodes. `AudioBufferSourceNode.playbackRate` changes pitch and is not an equivalent replacement.
- Keep both independent pitch implementations while the product comparison is active: client mode uses the same-duration AudioWorklet path, with `ScriptProcessorNode` only as the feature-detected plain-HTTP compatibility fallback; server mode requests `?pitch=-6…6` variants generated from the original source and cached below `audio-v3/server-pitch-v1/`. Keep the two client DSP implementations in sync, and do not make server variants by transcoding the already-encoded default output.
- Treat the four processed voices as one audio cache set. Measure each lossless processed stream, pad only at the end to the longest exact sample count, encode each voice once, and write `audio-set.json` only after all four MP3s are ready. Tag 1482 (`'Less You Listen`) is the unequal-duration regression case.
- Process dual-mono media as mono before `StereoPannerNode`, and keep every voice routed through the shared headroom/limiter/output mix bus. Connecting voice panners directly to `AudioContext.destination` clips coherent four-part sums.
- Keep all four players synchronized after play and seek. Test changes on iOS Safari as well as Chromium when altering transport code.
- Keep reference-note synthesis user-gesture initiated and client-only. It must not request microphone access or send recorded audio, and its output should remain gain-limited. Piano input must use pointer-down interactions and preserve polyphony so simultaneous mobile touches can sound together; pitch-pipe notes remain monophonic.
- Maintain keyboard/focus semantics, visible labels, adequate contrast, reduced-motion behavior, and touch targets. Verify layouts at 360 px and wide desktop widths.
- Treat fetched files as untrusted even though the source is allowlisted: validate identifiers, cap downloads, avoid shell interpolation, and invoke processors with argument arrays.
- Preserve user settings and marks in namespaced local-storage keys (`tagmix:mix:*`, `tagmix:marks:*`).
- Do not commit `.data`, build output, secrets, downloaded media, or generated coverage.

## Before handing off changes

Run:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

For media changes, also start the production build and exercise at least one PDF score, one image score, a range request, and an audio source matching the modified policy. Prefer adding a focused unit test for every source-data edge case or mixer policy change.

When Chromium is available, `TAGMIX_TEST_URL=http://localhost:3000 npm run smoke:browser` provides a dependency-free 360 px interaction check for catalog search, media readiness, client/server pitch processing, playback, and marks.
