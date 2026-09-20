# TagMix agent guide

## Project description

TagMix is a Docker-first Next.js and TypeScript web app for rehearsing four-part tags from BarbershopTags.com. It filters the public source catalog to records that have all four named learning tracks (Bass, Bari, Lead, Tenor) and sheet music. A selected tag shows automatically cropped music beside a synchronized, pitch-preserving four-part mixer, plus browser-synthesized pitch-pipe and piano reference tools. Mixer preferences are device-local. Email/password accounts store ordered saved folders, personal timestamp marks, and recently viewed history; each folder has one permanent anonymous share URL, with an owner-selected read-only or read/write setting. Users can attach the original with the link’s access or make an independent copy.

## Architecture

- `src/lib/catalog.ts` fetches, tolerantly parses, normalizes, filters, and caches the XML catalog.
- `src/lib/media.ts` securely fetches allowlisted source media and invokes FFmpeg, Poppler, ImageMagick, or FluidSynth for on-demand conversion.
- `src/app/api/` exposes catalog, detail, cropped-score, processed-audio, and health routes.
- `src/components/catalog-browser.tsx` owns search/filter/pagination UI.
- `src/components/tag-workspace.tsx`, `score-viewer.tsx`, and `mixer.tsx` own the rehearsal experience.
- `src/components/note-tools.tsx` and `src/lib/notes.ts` own the reusable, client-only pitch-pipe and piano tools shown below scores and on `/tools`.
- `.data/` is a disposable, versioned runtime cache and must never be committed.
- `src/lib/account-store.ts` owns the durable SQLite account database, separate from `.data/`; `.accounts/` must never be committed or treated as cache.
- `src/app/api/account/[...path]/route.ts` checks sessions, folder roles, mutation origins, and stale-account headers. Owners alone rename folders, manage sharing, and delete folders; editors can change tag contents, order, and pitch, while viewers cannot write. Linked membership references the original folder; copies are independent. Shared-folder responses expose only folder names, owner email, current sharing access, and ordered tag summaries with per-entry pitch settings. Never expose member emails or private marks/history. Saved memberships follow the folder’s current sharing setting; changing access never changes the URL or removes a membership. Owners copy the link with the left side of the fixed-size share button and change permissions through its dropdown arrow, with no revocation, rotation, or per-person controls. Existing folders migrate to read-only; preserve main URLs and redirect legacy edit URLs to them. Folder pitch is independent of personal marks and history; preserve it through sharing and imports.

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
- Pitch adjustment runs only in the browser, using the same-duration AudioWorklet path with `ScriptProcessorNode` as the feature-detected compatibility fallback. Keep both DSP implementations in sync. Do not reintroduce server-rendered pitch variants.
- Treat the four processed voices as one audio cache set. Measure each lossless processed stream, pad only at the end to the longest exact sample count, encode each voice once, and write `audio-set.json` only after all four MP3s are ready. Tag 1482 (`'Less You Listen`) is the unequal-duration regression case.
- Process dual-mono media as mono before `StereoPannerNode`, and keep every voice routed through the shared headroom/limiter/output mix bus. Connecting voice panners directly to `AudioContext.destination` clips coherent four-part sums.
- Keep all four players synchronized after play and seek. Test changes on iOS Safari as well as Chromium when altering transport code.
- Keep reference-note synthesis user-gesture initiated and client-only. It must not request microphone access or send recorded audio, and its output should remain gain-limited. Piano input must use pointer-down interactions and preserve polyphony so simultaneous mobile touches can sound together; pitch-pipe notes remain monophonic. The key button on tag pages plays the tonic with the current rehearsal pitch offset, using the same tone engine as the embedded reference tools.
- Maintain keyboard/focus semantics, visible labels, adequate contrast, reduced-motion behavior, and touch targets. Verify layouts at 360 px and wide desktop widths.
- Treat fetched files as untrusted even though the source is allowlisted: validate identifiers, cap downloads, avoid shell interpolation, and invoke processors with argument arrays.
- Preserve device-local mixer settings in `tagmix:mix:*`. Save new marks to the signed-in account. Silently merge legacy `tagmix:marks:*` records at sign-in and remove a browser record only after successful server confirmation. Never share personal marks or history with folder viewers.
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

When Chromium is available, `TAGMIX_TEST_URL=http://localhost:3000 npm run smoke:browser` provides a dependency-free 360 px interaction check for catalog search, media readiness, browser pitch processing, playback, and marks.
