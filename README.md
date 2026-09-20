# TagMix

TagMix is a responsive rehearsal app for four-part music from [BarbershopTags.com](https://www.barbershoptags.com). It presents only tags with Bass, Baritone, Lead, and Tenor learning tracks plus sheet music, trims empty space from the score, and turns the source recordings into a synchronized four-part mixer.

## What it does

- Searches titles, alternate titles, versions, and arrangers across the live compatible catalog.
- Renders PDF, PNG, JPEG, and GIF scores as cropped, browser-safe PNG images.
- Converts MP3, M4A, WMA, and MIDI learning tracks to normalized dual-mono MP3.
- Pads shorter learning tracks with trailing silence so every voice for a tag has the same duration.
- Includes an in-browser chromatic pitch pipe and polyphonic three-octave piano on every tag and on a standalone tools page. Tag reference tools can follow the rehearsal pitch with the optional **Pitch adjusted** switch (off by default). The standalone tools have their own pitch control, remembered for the browser session.
- Detects and extracts the named voice from either channel when a source track has one part on one side and the other three on the other side.
- Provides volume, pan, mute, solo, and pitch-preserving 0.25×–1× playback controls.
- Transposes the mix by ±6 semitones without changing its speed, using real-time browser processing. It prefers an AudioWorklet and uses a compatibility processor when a plain-HTTP network origin hides that API.
- Routes the four voices through a mono-safe, headroom-adjusted, peak-limited mix bus to prevent summed-track clipping.
- Provides email/password accounts without email verification.
- Saves ordered folders of tags with read-only or read/write sharing, linked membership, and independent copies. Shared URLs work without signing in.
- Saves personal timestamp marks and recently viewed tags on your account across devices. Existing browser marks import silently on sign-in; mixer settings remain device-local.
- Keeps a daily metadata cache and generates media only when someone opens a tag.

Part-predominant or undocumented recordings remain available and are labeled “best-effort,” because quiet backing voices may remain in those sources.

For split-stereo tags, TagMix analyzes all four aligned learning tracks together. It chooses the left/right assignment whose opposite channels can best be reconstructed from the other three named voices, with a lower-energy fallback only when that relationship is ambiguous. The result is cached per tag with the processed audio.

## Run with Docker

Docker is the recommended path because the image includes FFmpeg, Poppler, ImageMagick, FluidSynth, and a compact General MIDI soundfont.

```bash
docker compose up --build
```

Open <http://localhost:3000>. The `tagmix-data` volume retains catalog metadata and generated media between container restarts.

The separate **`tagmix-accounts` volume contains durable account data**: accounts, sessions, folders, marks, and history. Keep it when rebuilding or clearing media caches. `docker compose down -v` deletes both volumes, including all accounts. Back up the account volume with the app stopped, or use SQLite's online backup mechanism; copying only the live `.sqlite` file can omit pending WAL changes.

For a reverse proxy, set `TAGMIX_APP_ORIGIN` to the public origin (for example `https://tags.example.com`). This enables Secure session cookies over HTTPS and validates account mutations against that origin. Without an override, direct access uses the request's Host header, so localhost and LAN addresses work even when the server listens on `0.0.0.0`. Forwarded host headers do not override this check. Local plain-HTTP use remains supported. SQLite is intended for a single app deployment with a local persistent volume.

For a Linux server, [setup/README.md](setup/README.md) provides nginx HTTPS
configuration, a systemd service for Docker Compose, and certificate setup steps.

## Accounts and folders

Use **Sign in → Create an account** to register with an email address and a password of 12–128 characters. There is no verification email or email-based password recovery. Passwords are salted and hashed with scrypt; sessions expire after 30 days and are revoked when signing out. Authentication attempts are rate-limited in the database.

Open any tag and use the bookmark beside its title to save directly to a folder or create a new one. Under **My folders**, rename folders, remove tags, or reorder them using the up/down buttons. Saving a tag also saves its current pitch (−6 to +6 semitones) in that folder. Adjust it with the pitch −/+ control beside each folder entry; opening the tag from that folder uses the saved pitch. The same tag can have different pitches in different folders. Existing entries start at the original pitch. Each folder automatically gets an unguessable share URL. Anyone with the URL can view its current name and ordered tags, without an account. The arrow beside **Copy share link** opens a dropdown that sets the one permanent link to **Read-only** or **Read/write**. With read/write enabled, people can sign in and add the original folder to edit its tags. Shared folders show the owner’s email. Editors can add, remove, reorder, or change pitch of tags. Only the owner can rename or delete the folder or manage sharing. Deleting a folder removes it from every member’s folders and invalidates its share URL; marks and history never appear in shared-folder responses.

Every shared folder offers **Add to my folders** and **Add a copy to my folders**. Adding the original keeps the same folder and grants read-only or editing access according to the link; it appears alongside your owned folders. Changes are visible on reopening the folder or returning to its browser window. Adding a copy creates an independent folder with the same name, order, and pitches, and its own share URL. Marks and history remain personal. Signed-out visitors are prompted to sign in and then returned to the shared folder.

Sharing changes apply to everyone who saved the original folder, without changing its URL or removing it from their folders. There are no link-disable, link-replacement, or per-person controls. Independent copies are unaffected. Members can choose **Remove from my folders** to leave without deleting the original.

Existing folders migrate to read-only while retaining their main URL, saved memberships, and pitches. Old edit URLs redirect to the main URL and use its current permission. Owners can switch to read/write from the dropdown.

New marks require sign-in and belong to the user and tag, regardless of which folder led to that tag. On sign-in, old `tagmix:marks:*` browser records merge into the account automatically. A browser record is removed only after the server confirms saving it; failed imports retain the browser copy and offer retry. **Recently viewed** lists each tag once, ordered by its latest visit, and includes a **Clear history** button.

## Run locally

Requirements:

- Node.js 22.13 or newer (uses built-in SQLite)
- FFmpeg and FFprobe
- Poppler (`pdftoppm`)
- ImageMagick (`magick` or `convert`)
- FluidSynth and a GM `.sf2`/`.sf3` soundfont for the small number of MIDI tracks

Then run:

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` to override the cache directory, refresh interval, or soundfont path. The default runtime cache is `.data/`, which is intentionally excluded from Git. The account database defaults to `.accounts/accounts.sqlite`, outside the disposable cache, and is also excluded from Git. Override its directory with `TAGMIX_ACCOUNT_DIR`.

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

The media smoke test creates a test account unless `TAGMIX_TEST_EMAIL` and `TAGMIX_TEST_PASSWORD` supply existing test credentials. Use a disposable account database when running it.

After a build, `npm run smoke:accounts` starts its own production server with a temporary SQLite database and fixture catalog. It checks signup, silent mark migration, folder ordering and sharing, marks after reload, history, account isolation, and 360 px / desktop layouts in Chromium, then removes its test data. Score and audio responses are browser fixtures in this suite; use `smoke:browser` for real media processing.

The principal runtime endpoints are:

- `GET /api/tags` — filtered search and pagination
- `GET /api/tags/:id` — normalized tag metadata
- `GET /api/tags/:id/sheet` — cropped PNG score
- `GET /api/tags/:id/audio/:voice` — processed MP3 with HTTP range support
- `GET /api/health` — process and catalog-cache status

Account endpoints:

- `/api/account/session`, `/api/account/signup`, `/api/account/login`, `/api/account/logout` — account sessions
- `/api/account/folders` and `/api/account/folders/:id` — owned and linked folders; tag changes require owner/editor access; renaming and deletion require ownership
- `POST /api/account/folders/add-shared` — attach the original using a read-only or read/write token
- `POST /api/account/folders/import` — create an independent copy
- `/api/account/folders/:id/sharing` — owner-only link management
- `DELETE /api/account/folders/:id/membership` — leave a linked folder
- `/api/account/marks/:tagId` — personal marks; `DELETE /api/account/marks/:tagId/:markId` removes a mark
- `/api/account/history` — view, record, or clear recently viewed tags
- `GET /api/shared/:token` — anonymous folder contents and the access granted by the link

Account APIs use `Cache-Control: private, no-store`. Authenticated library requests include `X-Tagmix-Account` with the current user ID to prevent stale tabs from applying changes to a different signed-in account. Mutations require a matching Origin header; JSON request bodies are size-limited.

## Data and media

TagMix does not ship a copy of the source library. It reads the public BarbershopTags API, attributes and links every tag to its source page, and caches requested source/derived files on the server. Pitch adjustment runs in the browser and does not create another media file. The source site describes its catalog as freely downloadable; deployments should still preserve attribution and avoid removing the original-page links.
