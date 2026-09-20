import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.TAGMIX_ACCOUNT_TEST_PORT ?? 3101);
const baseUrl = `http://localhost:${port}`;
const fixture = await mkdtemp(join(tmpdir(), "tagmix-account-smoke-"));
await mkdir(join(fixture, "cache", "catalog"), { recursive: true });
const tags = [37, 1482].map((id) => ({
  id, title: id === 37 ? "First rehearsal tag" : "Second rehearsal tag", alternateTitle: "", version: "", key: "C Major", style: "Barbershop",
  recording: "single part only", arranger: "", quartet: "", provider: "", lyrics: "", notes: "", rating: null, downloads: null,
  updatedAt: "", sourcePageUrl: `https://www.barbershoptags.com/tag-${id}-fixture`,
  sheet: { type: "png", url: "https://www.barbershoptags.com/file/fixture.png" },
  tracks: Object.fromEntries(["bass", "baritone", "lead", "tenor"].map(voice => [voice, { type: "mp3", url: `https://www.barbershoptags.com/file/${voice}.mp3` }])),
  audioQuality: "isolated"
}));
tags.push(...Array.from({ length: 80 }, (_, index) => ({
  ...tags[0], id: 2000 + index, title: `Old Kentucky Home ${index + 1}`, rating: index % 5,
})));
await writeFile(join(fixture, "cache", "catalog", "catalog-v1.json"), JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), sourceStamp: "test", sourceAvailable: tags.length, tags }));
// Exercise the real upgrade and old-edit-link redirect in a disposable database.
await mkdir(join(fixture, "accounts"));
const legacyMainToken = "1".repeat(48);
const legacyEditToken = "2".repeat(48);
const legacyDatabase = new DatabaseSync(join(fixture, "accounts", "accounts.sqlite"));
legacyDatabase.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL) STRICT;
  CREATE TABLE folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, share_token TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 0) STRICT;
  CREATE TABLE folder_sharing (folder_id TEXT PRIMARY KEY REFERENCES folders(id), view_enabled INTEGER NOT NULL DEFAULT 1, edit_token TEXT UNIQUE) STRICT;
  INSERT INTO users VALUES ('legacy-owner', 'legacy@example.test', 'unused');
  PRAGMA user_version = 3;
`);
legacyDatabase.prepare("INSERT INTO folders (id, user_id, name, share_token) VALUES (?, ?, ?, ?)").run("legacy-folder", "legacy-owner", "Legacy shared folder", legacyMainToken);
legacyDatabase.prepare("INSERT INTO folder_sharing VALUES (?, 1, ?)").run("legacy-folder", legacyEditToken);
legacyDatabase.close();
const serverArgs = process.env.TAGMIX_TEST_STANDALONE === "1"
  ? [".next/standalone/server.js"]
  : ["node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", String(port)];
const server = spawn(process.execPath, serverArgs, {
  // Exercise the default deployment, without an origin override hiding Host mismatches.
  env: { ...process.env, HOSTNAME: "0.0.0.0", PORT: String(port), TAGMIX_DATA_DIR: join(fixture, "cache"), TAGMIX_ACCOUNT_DIR: join(fixture, "accounts"), TAGMIX_APP_ORIGIN: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", chunk => { serverOutput += chunk; });
server.stderr.on("data", chunk => { serverOutput += chunk; });
const chromium = process.env.CHROMIUM_BIN ?? "chromium";
const debugPort = Number(process.env.TAGMIX_DEBUG_PORT ?? 9335);
const profile = await mkdtemp(join(tmpdir(), "tagmix-chromium-"));
const browser = spawn(
  chromium,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    ...(process.env.TAGMIX_IGNORE_CERT_ERRORS === "1" ? ["--ignore-certificate-errors"] : []),
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let browserErrors = "";
browser.stderr.on("data", (chunk) => {
  browserErrors += chunk.toString();
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function pageTarget() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chromium is still starting.
    }
    await wait(100);
  }
  throw new Error(`Chromium did not expose a page target. ${browserErrors.slice(-1_000)}`);
}

class DevTools {
  onEvent;
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) { this.onEvent?.(message); return; }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  async evaluate(expression, userGesture = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await wait(120);
    }
    throw new Error(`Timed out waiting for: ${expression}; page: ${JSON.stringify(await this.evaluate('({ url: location.href, text: document.body.innerText.slice(0, 1200) })'))}`);
  }

  close() {
    this.#socket.close();
  }
}

// Media is fulfilled in Chromium: this suite exercises account flows, not conversion.
const sampleRate = 8000;
const wav = Buffer.alloc(44 + sampleRate * 10 * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let index = 0; index < sampleRate * 10; index++) wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / sampleRate) * 1000), 44 + index * 2);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
let devtools;
let holdFolderWrites = false;
const heldFolderWrites = [];
let holdFolderChoices = false;
const heldFolderChoices = [];
let holdCatalogReads = false;
const heldCatalogReads = [];
const errors = [];
const checks = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function navigate(path) {
  await devtools.send("Page.navigate", { url: `${baseUrl}${path}` });
  await devtools.waitFor('document.readyState === "complete"');
}
async function fill(selector, value) {
  await devtools.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}
async function click(selector) { await devtools.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, true); }
async function api(path, method = "GET", body, userId) {
  return devtools.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(`/api/${path}`)}, {
      method: ${JSON.stringify(method)}, headers: { "Content-Type": "application/json", "X-Tagmix-Account": ${JSON.stringify(userId ?? "")} },
      body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))}
    });
    return { status: response.status, data: await response.json() };
  })()`);
}
async function checkTone(selector, midi) {
  await devtools.evaluate(`if (!window.keyToneProbe) {
    window.keyToneProbe = [];
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function() {
      const oscillator = create.call(this);
      window.keyToneProbe.push(oscillator);
      return oscillator;
    };
  }`);
  const previous = await devtools.evaluate('window.keyToneProbe.length');
  await click(selector);
  const fundamental = 440 * 2 ** ((midi - 69) / 12);
  // AudioParam.value reflects scheduled values only once the audio clock advances.
  await devtools.waitFor(`window.keyToneProbe.slice(${previous}).length === 3 && window.keyToneProbe.slice(${previous}).every((oscillator, index) => Math.abs(oscillator.frequency.value - ${fundamental} * (index + 1)) < 0.001)`);
  const frequencies = await devtools.evaluate(`window.keyToneProbe.slice(${previous}).map(oscillator => oscillator.frequency.value)`);
  assert(frequencies.length === 3 && frequencies.every((frequency, index) => Math.abs(frequency - fundamental * (index + 1)) < 0.001), `Reference tool sounds the wrong note: ${JSON.stringify(frequencies)} for MIDI ${midi}`);
}
async function checkKeyPitch(midi) {
  await checkTone('.key-pitch-pipe', midi);
  assert(await devtools.evaluate('document.querySelector(".workspace-key .key-pitch-pipe")?.getAttribute("aria-label").includes("pitch pipe")'), "Key pitch pipe is missing its accessible label or placement beside the key");
}
async function checkSaveDropdown(label) {
  const state = await devtools.evaluate(`(() => {
    const dropdown = document.querySelector(".save-tag-dropdown");
    const bounds = dropdown.getBoundingClientRect();
    const trigger = document.querySelector(".tag-save-button").getBoundingClientRect();
    const title = document.querySelector(".workspace-title-copy").getBoundingClientRect();
    return { focused: dropdown.contains(document.activeElement),
      modal: !!document.querySelector("dialog:modal"), locked: getComputedStyle(document.documentElement).overflow === "hidden",
      anchored: Math.abs(bounds.left - trigger.left) < 1 && bounds.top >= trigger.bottom,
      beforeTitle: trigger.right <= title.left,
      fits: bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
      overflows: dropdown.scrollWidth > dropdown.clientWidth };
  })()`);
  assert(!state.modal && !state.locked && state.focused && state.anchored && state.beforeTitle && state.fits && !state.overflows, `${label} dropdown failed: ${JSON.stringify(state)}`);
}
async function layout(label) {
  const result = await devtools.evaluate('({ viewport: document.documentElement.clientWidth, width: document.documentElement.scrollWidth })');
  assert(result.width <= result.viewport, `${label} overflows: ${JSON.stringify(result)}`);
  checks.push(`${label}: ${result.viewport}px`);
}
async function screenshot(name) {
  const shot = await devtools.send("Page.captureScreenshot", { format: "png" });
  await writeFile(join(tmpdir(), `tagmix-design-${name}.png`), Buffer.from(shot.data, "base64"));
}
try {
  const deadline = Date.now() + 20_000;
  while (true) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch { /* Startup. */ }
    if (Date.now() > deadline) throw new Error(`Server did not start: ${serverOutput}`);
    await wait(150);
  }
  devtools = new DevTools(await pageTarget());
  await devtools.open();
  devtools.onEvent = (message) => {
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    if (message.method === "Fetch.requestPaused") {
      if (new URL(message.params.request.url).pathname === "/api/tags") {
        if (holdCatalogReads) heldCatalogReads.push(message.params.requestId);
        else void devtools.send("Fetch.continueRequest", { requestId: message.params.requestId });
        return;
      }
      if (new URL(message.params.request.url).pathname === "/api/account/folders") {
        if (holdFolderChoices) heldFolderChoices.push(message.params.requestId);
        else void devtools.send("Fetch.continueRequest", { requestId: message.params.requestId });
        return;
      }
      if (message.params.request.url.includes("/api/account/folders/")) {
        if (holdFolderWrites && message.params.request.method !== "GET") {
          heldFolderWrites.push(message.params);
        } else {
          void devtools.send("Fetch.continueRequest", { requestId: message.params.requestId });
        }
        return;
      }
      if (!message.params.request.url.includes("/audio/") && !new URL(message.params.request.url).pathname.endsWith("/sheet")) {
        void devtools.send("Fetch.continueRequest", { requestId: message.params.requestId });
        return;
      }
      const isAudio = message.params.request.url.includes("/audio/");
      void devtools.send("Fetch.fulfillRequest", {
        requestId: message.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: isAudio ? "audio/wav" : "image/png" }],
        body: isAudio ? wav.toString("base64") : png,
      }).catch((error) => {
        // Back/Forward can cancel an intercepted media request before fulfillment.
        if (!error.message.includes("Invalid InterceptionId")) errors.push(error.message);
      });
    }
  };
  await devtools.send("Page.enable");
  await devtools.send("Runtime.enable");
  await devtools.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await devtools.send("Browser.grantPermissions", { origin: baseUrl, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await devtools.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/tags*" }, { urlPattern: "*/api/account/folders/*" }, { urlPattern: "*/api/account/folders?*" }] });
  const legacyResponse = await fetch(`${baseUrl}/shared/${legacyEditToken}`, { redirect: "manual" });
  // Next.js may already be streaming the layout, in which case the permanent
  // redirect is encoded in the page rather than the initial HTTP headers.
  const legacyRedirectBody = await legacyResponse.text();
  assert((legacyResponse.status === 308 && legacyResponse.headers.get("location")?.endsWith(`/shared/${legacyMainToken}`))
    || (legacyResponse.status === 200 && legacyRedirectBody.includes(`NEXT_REDIRECT;replace;/shared/${legacyMainToken};308;`)), "Legacy edit URL does not redirect permanently to the main URL");
  await navigate(`/shared/${legacyEditToken}`);
  await devtools.waitFor(`location.pathname === "/shared/${legacyMainToken}" && document.querySelector(".folder-owner")?.textContent === "Owner: legacy@example.test"`);
  assert(await devtools.evaluate('document.querySelector(".folder-heading")?.textContent.includes("Read-only")'), "Migrated folder does not start read-only");
  checks.push("Legacy edit URLs redirect to the unchanged main URL; existing folders migrate to read-only");
  for (const width of [360, 1440]) {
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: width === 360 });
    await navigate("/");
    await devtools.waitFor('!!document.querySelector(".tag-grid[aria-busy=false]")');
    assert(await devtools.evaluate('!document.querySelector(".catalog-hero")'), "Catalog hero remains");
    const countBeforeSearch = await devtools.evaluate('document.querySelector("#catalog-heading").textContent');
    holdCatalogReads = true;
    const historyLength = await devtools.evaluate('history.length');
    await devtools.evaluate('document.querySelector("input[type=search]").focus()');
    for (const text of "Old kentucky Home") await devtools.send("Input.insertText", { text });
    await devtools.waitFor('document.querySelector("input[type=search]")?.value === "Old kentucky Home"');
    await devtools.evaluate('document.querySelector("input[type=search]").setSelectionRange(4, 5)');
    await devtools.send("Input.insertText", { text: "K" });
    await devtools.waitFor('document.querySelector("input[type=search]")?.value === "Old Kentucky Home"');
    assert(await devtools.evaluate('document.querySelector("input[type=search]").selectionStart === 5'), "Search editing moved the cursor");
    await fill('.catalog-filters label:first-child select', "Barbershop");
    await fill('.catalog-filters label:last-child select', "rating");
    await wait(400);
    assert(heldCatalogReads.length > 0, "Catalog delay did not intercept the search");
    assert(await devtools.evaluate('document.querySelector("#catalog-heading").textContent') === countBeforeSearch, "Pending search mixed a new query with an old count");
    holdCatalogReads = false;
    for (const requestId of heldCatalogReads.splice(0)) await devtools.send("Fetch.continueRequest", { requestId }).catch(error => { if (!error.message.includes("Invalid InterceptionId")) throw error; });
    await devtools.waitFor('document.querySelector("#catalog-heading")?.textContent.includes("80 matches") && !!document.querySelector(".tag-grid[aria-busy=false]")');
    await click('.pagination button:last-child');
    await devtools.waitFor('document.querySelector(".pagination span")?.textContent === "Page 2 of 3" && !!document.querySelector(".tag-grid[aria-busy=false]")');
    assert(await devtools.evaluate('history.length') === historyLength, "Filters added extra Back entries");
    const snapshot = 'JSON.stringify({ search: location.search, input: document.querySelector("input[type=search]")?.value, filters: [...document.querySelectorAll(".catalog-filters select")].map(el => el.value), page: document.querySelector(".pagination span")?.textContent, tags: [...document.querySelectorAll(".tag-card h3")].map(el => el.textContent) })';
    const expected = await devtools.evaluate(snapshot);
    await devtools.evaluate('document.querySelector(".tag-card:last-child").scrollIntoView({ block: "center", behavior: "instant" })');
    const expectedScroll = await devtools.evaluate('window.scrollY');
    assert(expectedScroll > 1000, "Scroll regression must begin near the end of the results");
    const tagPath = await devtools.evaluate('document.querySelector(".tag-card:last-child").getAttribute("href")');
    await click('.tag-card:last-child');
    await devtools.waitFor('!!document.querySelector(".workspace-heading")');
    holdCatalogReads = true;
    await devtools.evaluate('history.back()');
    await devtools.waitFor('location.pathname === "/" && !document.querySelector(".tag-grid[aria-busy=false]")');
    await wait(600);
    assert(heldCatalogReads.length > 0, "Back did not wait for the delayed catalog");
    holdCatalogReads = false;
    for (const requestId of heldCatalogReads.splice(0)) await devtools.send("Fetch.continueRequest", { requestId });
    await devtools.waitFor('location.pathname === "/" && !!document.querySelector(".tag-grid[aria-busy=false]")');
    await wait(400); // Catch an accidental page reset from a mount-time debounce.
    assert(await devtools.evaluate(snapshot) === expected, "Back lost search, filters, page, or result order");
    assert(Math.abs(await devtools.evaluate('window.scrollY') - expectedScroll) < 3, "Back restored scroll before the full catalog loaded");
    await layout("Restored catalog");
    await devtools.evaluate('history.forward()');
    await devtools.waitFor(`location.pathname === ${JSON.stringify(tagPath)} && !!document.querySelector(".workspace-heading")`);
    await devtools.evaluate('history.back()');
    await devtools.waitFor('location.pathname === "/" && !!document.querySelector(".tag-grid[aria-busy=false]")');
    assert(Math.abs(await devtools.evaluate('window.scrollY') - expectedScroll) < 3, "Repeated Back lost scroll position");
    await devtools.send("Page.reload");
    await devtools.waitFor('!!document.querySelector(".tag-grid[aria-busy=false]")');
    assert(Math.abs(await devtools.evaluate('window.scrollY') - expectedScroll) < 3, "Reload lost the saved result position");
    assert(await devtools.evaluate(snapshot) === expected, "Reload lost catalog state");
    await click('button[aria-label="Clear search"]');
    await devtools.waitFor('document.querySelector("input[type=search]")?.value === "" && document.querySelector(".pagination span")?.textContent === "Page 1 of 3" && !!document.querySelector(".tag-grid[aria-busy=false]")');
    assert(await devtools.evaluate('!new URLSearchParams(location.search).has("q") && !new URLSearchParams(location.search).has("page")'), "Clear search retained stale URL state");
    checks.push(`Catalog keeps pending counts accurate and restores search, filters, page, and bottom-of-page scrolling after delayed Back/Forward and reload at ${width}px`);
  }
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await navigate("/account");
  await devtools.waitFor('!!document.querySelector(".account-form")');
  await layout("Account form");
  await devtools.evaluate('localStorage.setItem("tagmix:marks:37", JSON.stringify([{ id: "old-cue", time: 2, label: "Old browser cue" }])); localStorage.setItem("tagmix:mix:37", "{}")');
  await click(".account-card > button.text-link");
  await fill('input[name="email"]', "singer@example.test");
  await fill('input[name="password"]', "a long smoke test password");
  await devtools.evaluate('document.querySelector(".account-form").requestSubmit()', true);
  await devtools.waitFor('location.pathname === "/folders" && !!document.querySelector(".inline-form")');
  const owner = (await api("account/session")).data.user;
  assert(owner?.email === "singer@example.test", "Signup failed");
  assert((await api("account/marks/37", "GET", undefined, owner.id)).data.marks.length === 1, "Legacy marks not imported");
  assert(await devtools.evaluate('localStorage.getItem("tagmix:marks:37") === null && localStorage.getItem("tagmix:mix:37") === "{}"'), "Migration damaged browser settings");
  checks.push("Signup and silent mark migration");
  await layout("Folder list");
  await click('.menu-toggle');
  await devtools.waitFor('document.querySelector(".menu-toggle").getAttribute("aria-expanded") === "true"');
  assert(await devtools.evaluate('document.querySelectorAll("a[href=\\"/folders\\"]").length === 1 && document.querySelector(".header-nav a[href=\\"/history\\"]").getBoundingClientRect().height >= 44'), "Duplicate or inaccessible library navigation");
  await screenshot("mobile-menu");
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  assert(await devtools.evaluate('document.activeElement.classList.contains("menu-toggle") && document.querySelector(".menu-toggle").getAttribute("aria-expanded") === "false"'), "Menu Escape did not restore focus");
  await fill('.inline-form input[name="name"]', "Quartet night");
  await devtools.evaluate('document.querySelector(".inline-form").requestSubmit()', true);
  await devtools.waitFor('location.pathname.startsWith("/folders/") && document.querySelector("h1")?.textContent === "Quartet night"');
  const folderId = await devtools.evaluate('location.pathname.split("/").pop()');
  await navigate("/tags/37");
  await devtools.waitFor('!!document.querySelector(".mark-button") && !document.querySelector(".mark-button").disabled');
  await layout("Rehearsal account controls");
  const referenceGeometry = `(() => {
    const row = document.querySelector(".note-tools-launcher").getBoundingClientRect();
    const buttons = document.querySelector(".note-tools-launcher-buttons").getBoundingClientRect();
    return JSON.stringify({ height: row.height, buttonsX: buttons.left - row.left, buttonsY: buttons.top - row.top });
  })()`;
  for (const width of [360, 1000, 1440]) {
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width === 360 });
    const beforePitchToggle = await devtools.evaluate(referenceGeometry);
    assert(await devtools.evaluate('document.querySelector(".tools-pitch-toggle").hidden && document.querySelector(".tools-pitch-toggle input").disabled'), "Original key exposes the pitch toggle");
    await click('.mixer-panel [aria-label="Raise pitch one semitone"]');
    await devtools.waitFor('!document.querySelector(".tools-pitch-toggle").hidden');
    assert(await devtools.evaluate(referenceGeometry) === beforePitchToggle, `Pitch toggle changes reference layout at ${width}px`);
    await layout("Stable reference launcher");
    await click('.mixer-panel [aria-label="Lower pitch one semitone"]');
    await devtools.waitFor('document.querySelector(".tools-pitch-toggle").hidden');
  }
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await checkKeyPitch(60);
  await click('[aria-label="Raise pitch one semitone"]');
  await click('[aria-label="Raise pitch one semitone"]');
  await devtools.waitFor('document.querySelector(".pitch-stepper output")?.textContent === "+2 semitones"');
  await checkKeyPitch(62);
  assert(await devtools.evaluate('document.querySelector(".tools-pitch-toggle input")?.checked === false'), "Tag pitch adjustment should default off");
  await click('.note-tools-launcher-buttons button:last-child');
  await devtools.waitFor('!!document.querySelector(".pitch-pipe-notes")');
  await checkTone('.pitch-pipe-notes [aria-label="Play C 4 on the pitch pipe"]', 60);
  await click('.tools-pitch-toggle input');
  await checkTone('.pitch-pipe-notes [aria-label="Play C 4 on the pitch pipe"]', 62);
  assert(await devtools.evaluate('document.querySelector(".pitch-pipe-notes button.is-active")?.getAttribute("aria-label") === "Play C 4 on the pitch pipe" && !document.querySelector(".note-readout")'), "Adjusted pitch changed the selected key or left a readout");
  await click('.note-tools-launcher-buttons button:first-child');
  await devtools.waitFor('!!document.querySelector(".piano-key")');
  await checkTone('.piano [aria-label="Play C 4 on the piano"]', 62);
  await click('.mixer-panel [aria-label="Lower pitch one semitone"]');
  await checkTone('.piano [aria-label="Play C 4 on the piano"]', 61);
  await click('.mixer-panel [aria-label="Lower pitch one semitone"]');
  await devtools.waitFor('document.querySelector(".tools-pitch-toggle").hidden');
  await checkTone('.piano [aria-label="Play C 4 on the piano"]', 60);
  await click('.mixer-panel [aria-label="Raise pitch one semitone"]');
  await click('.mixer-panel [aria-label="Raise pitch one semitone"]');
  await checkTone('.piano [aria-label="Play C 4 on the piano"]', 62);
  await click('.tools-pitch-toggle input');
  await checkTone('.piano [aria-label="Play C 4 on the piano"]', 60);
  await checkKeyPitch(62);
  await layout("Tag reference pitch tools");
  await devtools.evaluate('document.querySelector(".note-tools-launcher").scrollIntoView({ block: "center", behavior: "instant" })');
  await screenshot("mobile-reference-pitch");
  await click('.note-tools-launcher-buttons button:first-child');
  await devtools.evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  await devtools.waitFor('window.scrollY === 0');
  checks.push("Reference pitch defaults off, follows the tag offset when enabled, hides at zero, and does not change the key pitch button");
  const bookmarkBounds = 'JSON.stringify([document.querySelector(".tag-save-button").getBoundingClientRect().width, document.querySelector(".tag-save-button").getBoundingClientRect().height, document.querySelector(".workspace-title-copy").getBoundingClientRect().left])';
  const beforePreload = await devtools.evaluate(bookmarkBounds);
  holdFolderChoices = true;
  await click('.tag-save-button');
  await devtools.waitFor('document.querySelector(".tag-save-button").getAttribute("aria-busy") === "true"');
  await wait(150);
  assert(await devtools.evaluate('!document.querySelector(".save-tag-dropdown, .bookmark-spinner")'), "Fast preloading shows a dropdown or spinner too early");
  assert(heldFolderChoices.length === 1, "Opening the bookmark did not fetch fresh folders");
  await devtools.send("Fetch.continueRequest", { requestId: heldFolderChoices.shift() });
  await devtools.waitFor('!!document.querySelector(".save-folder-option")');
  assert(await devtools.evaluate('!document.querySelector(".bookmark-spinner") && document.querySelector(".tag-save-button").getAttribute("aria-busy") === "false"'), "Bookmark did not leave its loading state");
  await click('.tag-save-button');
  await click('.tag-save-button');
  await devtools.waitFor('!!document.querySelector(".bookmark-spinner")');
  assert(await devtools.evaluate('!document.querySelector(".save-tag-dropdown") && document.querySelector(".tag-save-button").getAttribute("aria-expanded") === "false"'), "Slow preload opened an incomplete dropdown");
  assert(await devtools.evaluate(bookmarkBounds) === beforePreload, "Spinner changed bookmark size or title position");
  await screenshot("mobile-bookmark-loading");
  await devtools.send("Fetch.continueRequest", { requestId: heldFolderChoices.shift() });
  await devtools.waitFor('!!document.querySelector(".save-folder-option") && !document.querySelector(".bookmark-spinner")');
  await click('.tag-save-button');
  await click('.tag-save-button');
  await devtools.waitFor('document.querySelector(".tag-save-button").getAttribute("aria-busy") === "true"');
  await wait(100);
  await devtools.evaluate('document.querySelector(".tag-save-button").focus()');
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await devtools.send("Fetch.continueRequest", { requestId: heldFolderChoices.shift() });
  await wait(600);
  assert(await devtools.evaluate('!document.querySelector(".save-tag-dropdown, .bookmark-spinner")'), "Cancelled preload reopened the dropdown or left a spinner");
  await click('.tag-save-button');
  await devtools.waitFor('document.querySelector(".tag-save-button").getAttribute("aria-busy") === "true"');
  await wait(100);
  await devtools.send("Fetch.fulfillRequest", { requestId: heldFolderChoices.shift(), responseCode: 503, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify({ error: "Folders temporarily unavailable." })).toString("base64") });
  await devtools.waitFor('document.querySelector(".tag-account-actions [role=alert]")?.textContent.includes("Folders temporarily unavailable.")');
  assert(await devtools.evaluate('!document.querySelector(".save-tag-dropdown, .bookmark-spinner")'), "Failed preload displayed an incomplete menu");
  holdFolderChoices = false;
  await click('.tag-account-actions [role=alert] button');
  await devtools.waitFor('!!document.querySelector(".save-folder-option")');
  await click('.tag-save-button');
  checks.push("Bookmark preloads before opening, delays the spinner, preserves button dimensions, cancels pending opening, and recovers from failed loads");
  await devtools.evaluate('document.querySelector(".tag-save-button").focus()');
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  await devtools.waitFor('document.querySelectorAll(".save-tag-dropdown [role=menuitem]").length === 2 && !document.querySelector(".new-folder-option").disabled');
  await checkSaveDropdown("Mobile save");
  await screenshot("mobile-save-dropdown");
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await devtools.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await devtools.waitFor('!document.querySelector(".save-tag-dropdown")');
  assert(await devtools.evaluate('document.activeElement?.getAttribute("aria-haspopup") === "menu" && document.documentElement.style.overflow !== "hidden"'), "Escape did not restore focus and scrolling");
  await click('.tag-account-actions button[aria-expanded]');
  await devtools.waitFor('!!document.querySelector(".save-tag-dropdown [role=menu]")');
  await devtools.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 2, y: 2, button: "left", clickCount: 1 });
  await devtools.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 2, y: 2, button: "left", clickCount: 1 });
  await devtools.waitFor('!document.querySelector(".save-tag-dropdown")');
  await click('.tag-account-actions button[aria-expanded]');
  await devtools.waitFor('!!document.querySelector(".new-folder-option") && !document.querySelector(".new-folder-option").disabled');
  await click(`.save-folder-option[data-folder-id="${folderId}"]`);
  await devtools.waitFor('document.querySelector(".tag-account-actions")?.textContent.includes("Saved to")');
  assert(await devtools.evaluate('!document.querySelector(".save-tag-dropdown") && document.activeElement?.classList.contains("tag-save-button")'), "Saving did not close the dropdown and restore focus");
  assert((await api(`account/folders/${folderId}`, "GET", undefined, owner.id)).data.folder.tags[0].pitchSemitones === 2, "Save did not capture the current mixer pitch");
  await click(".mark-button");
  await devtools.waitFor('document.querySelectorAll(".mark-chip").length === 2');
  await navigate("/tags/37");
  await devtools.waitFor('document.querySelectorAll(".mark-chip").length === 2');
  await devtools.waitFor('document.querySelector(".tag-save-button svg")?.getAttribute("fill") === "currentColor"');
  assert(await devtools.evaluate('!document.querySelector(".folder-membership")'), "Redundant Saved in display remains");
  await checkKeyPitch(62);
  await screenshot("mobile-tag");
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await layout("Rehearsal desktop");
  await screenshot("desktop-tag");
  await click('.note-tools-launcher-buttons button:last-child');
  await devtools.evaluate('document.querySelector(".note-tools-launcher").scrollIntoView({ block: "center", behavior: "instant" })');
  await screenshot("desktop-reference-pitch");
  await click('.note-tools-launcher-buttons button:last-child');
  await devtools.evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  const beforeDropdown = await devtools.evaluate('document.querySelector(".workspace-grid").getBoundingClientRect().top');
  await click('.tag-account-actions button[aria-expanded]');
  await devtools.waitFor('!!document.querySelector(".new-folder-option") && !document.querySelector(".new-folder-option").disabled');
  await checkSaveDropdown("Desktop save");
  assert(await devtools.evaluate('document.querySelector(".workspace-grid").getBoundingClientRect().top') === beforeDropdown, "Save dropdown shifts the page layout");
  await screenshot("desktop-save-dropdown");
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "End", code: "End" });
  assert(await devtools.evaluate('document.activeElement?.classList.contains("new-folder-option")'), "Dropdown keyboard navigation failed");
  await click('.tag-save-button');
  await devtools.waitFor('!document.querySelector(".save-tag-dropdown")');
  await click('.tag-account-actions button[aria-expanded]');
  await devtools.waitFor('!!document.querySelector(".save-tag-dropdown [role=menu]")');
  await devtools.evaluate('document.querySelector(".key-pitch-pipe").focus()');
  await devtools.waitFor('!document.querySelector(".save-tag-dropdown")');
  checks.push("Bookmark appears left of the title; its anchored dropdown fits 360/1440px, supports keyboard navigation, and closes on Escape, outside clicks, focus leaving, or a second click");
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await click('.tag-account-actions button[aria-expanded]');
  await devtools.waitFor('!!document.querySelector(".new-folder-option") && !document.querySelector(".new-folder-option").disabled');
  assert(await devtools.evaluate(`!!document.querySelector('.saved-folder-option[data-folder-id="${folderId}"] a[aria-label="View folder “Quartet night”"]')`), "Already-saved folder is missing its view action");
  await click('.new-folder-option');
  await devtools.waitFor(`document.activeElement === document.querySelector('.save-tag-form input[name="name"]')`);
  await fill('.save-tag-form input[name="name"]', "   ");
  await devtools.evaluate('document.querySelector(".save-tag-form").requestSubmit()', true);
  await devtools.waitFor('document.querySelector(".save-tag-dropdown [role=alert]")?.textContent === "Enter a folder name." && !document.querySelector(".new-folder-option").disabled');
  await fill('.save-tag-form input[name="name"]', "Weekend rehearsal");
  await checkSaveDropdown("New folder");
  await screenshot("mobile-new-folder-dropdown");
  await devtools.evaluate('document.querySelector(".save-tag-form").requestSubmit()', true);
  await devtools.waitFor('!document.querySelector(".save-tag-dropdown") && document.querySelector(".tag-account-actions")?.textContent.includes("Saved to “Weekend rehearsal”")');
  const additionalFolder = (await api("account/folders", "GET", undefined, owner.id)).data.folders.find(folder => folder.name === "Weekend rehearsal");
  assert(additionalFolder?.count === 1, "Creating a folder from a tag did not save the tag");
  await click('.tag-save-button');
  await devtools.waitFor('document.querySelectorAll(".saved-folder-option").length === 2');
  await checkSaveDropdown("Saved folder actions");
  await screenshot("mobile-saved-folder-actions");
  await click(`.saved-folder-option[data-folder-id="${additionalFolder.id}"] .remove-folder-tag`);
  await devtools.waitFor('!document.querySelector(".save-tag-dropdown") && document.querySelector(".tag-account-actions")?.textContent.includes("Removed from “Weekend rehearsal”")');
  assert(await devtools.evaluate('document.activeElement?.classList.contains("tag-save-button")'), "Removing a tag did not restore focus");
  assert((await api(`account/folders/${additionalFolder.id}`, "GET", undefined, owner.id)).data.folder.tags.length === 0, "Dropdown removal did not persist");
  await navigate("/tags/37");
  await devtools.waitFor('!document.querySelector(".tag-save-button").disabled');
  await click('.tag-save-button');
  await devtools.waitFor('document.querySelectorAll(".saved-folder-option").length === 1 && document.querySelectorAll(".save-folder-option").length === 1');
  assert(await devtools.evaluate(`document.querySelector('.save-tag-dropdown [data-folder-id]').dataset.folderId === ${JSON.stringify(folderId)}`), "Folders containing the tag are not first");
  await screenshot("mobile-sorted-folder-actions");
  await click(`.saved-folder-option[data-folder-id="${folderId}"] a`);
  await devtools.waitFor(`location.pathname === "/folders/${folderId}" && document.querySelector("h1")?.textContent === "Quartet night"`);
  checks.push("Saved folders appear first with view/remove icons; removal persists, restores focus, and the view action opens the folder");
  checks.push("Save tag and persist personal marks after reload");
  await navigate("/tags/1482");
  await devtools.waitFor('document.querySelector(".workspace-heading h1")?.textContent.includes("Second")');
  assert((await api(`account/folders/${folderId}/tags`, "POST", { tagId: 1482 }, owner.id)).status === 200, "Second tag save failed");
  await navigate(`/folders/${folderId}`);
  await devtools.waitFor('document.querySelectorAll(".saved-tag-list li").length === 2');
  await click('.folder-tag-actions button[aria-label$="down"]');
  await devtools.waitFor('document.querySelector(".saved-tag-list strong")?.textContent === "Second rehearsal tag"');
  await devtools.waitFor('!document.querySelector(".rename-toggle").hasAttribute("aria-disabled")');
  const pitchButton = '.folder-pitch button[aria-label="Raise pitch for First rehearsal tag"]';
  await devtools.evaluate(`document.querySelector(${JSON.stringify(pitchButton)}).focus()`);
  const folderButtonAppearance = `JSON.stringify([...document.querySelectorAll(".folder-tag-actions button, .rename-toggle, .danger-button")].map(button => {
    const style = getComputedStyle(button);
    return { disabled: button.disabled, opacity: style.opacity, color: style.color, background: style.backgroundColor, bounds: button.getBoundingClientRect().toJSON() };
  }))`;
  const beforePitchSave = await devtools.evaluate(folderButtonAppearance);
  holdFolderWrites = true;
  await click('.folder-pitch button[aria-label="Raise pitch for First rehearsal tag"]');
  await devtools.waitFor('document.querySelector(".rename-toggle").getAttribute("aria-disabled") === "true"');
  assert(await devtools.evaluate(folderButtonAppearance) === beforePitchSave, "Folder controls flicker while pitch is saving");
  assert(await devtools.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(pitchButton)})`), "Pitch save lost keyboard focus");
  // These must remain guarded even though transient saves no longer use native disabled styling.
  await click(pitchButton);
  await click('.folder-tag-actions button[aria-label^="Remove"]');
  const heldDeadline = Date.now() + 5000;
  while (!heldFolderWrites.length && Date.now() < heldDeadline) await wait(20);
  assert(heldFolderWrites.length === 1, "Overlapping folder writes were allowed");
  holdFolderWrites = false;
  await devtools.send("Fetch.continueRequest", { requestId: heldFolderWrites[0].requestId });
  await devtools.waitFor('document.querySelector(".saved-tag-list li:last-child .pitch-stepper output")?.textContent === "+3" && !document.querySelector(".folder-pitch button:last-child").disabled');
  assert(await devtools.evaluate(folderButtonAppearance) === beforePitchSave, "Folder controls changed appearance after pitch saved");
  assert(await devtools.evaluate('document.querySelectorAll(".saved-tag-list li").length === 2'), "Remove ran during a pending pitch save");
  checks.push("Pitch saves preserve button appearance and keyboard focus while preventing overlapping edits");
  assert(await devtools.evaluate('[...document.querySelectorAll(".folder-tag-actions")].every(el => el.firstElementChild.classList.contains("folder-pitch"))'), "Pitch controls are not before reorder/remove controls");
  await navigate(`/folders/${folderId}`);
  await devtools.waitFor('document.querySelector(".saved-tag-list li:last-child .pitch-stepper output")?.textContent === "+3"');
  await devtools.evaluate('localStorage.setItem("tagmix:mix:37", JSON.stringify({ pitchSemitones: -4 })); localStorage.setItem("tagmix:mix:1482", JSON.stringify({ pitchSemitones: 5 }))');
  await click('.saved-tag-link[href="/tags/37?pitch=3"]');
  await devtools.waitFor('document.querySelector(".mixer-panel .pitch-stepper output")?.textContent === "+3 semitones"');
  await checkKeyPitch(63);
  await devtools.evaluate('history.back()');
  await devtools.waitFor('!!document.querySelector(".folder-tag-actions")');
  await click('.saved-tag-link[href="/tags/1482?pitch=0"]');
  await devtools.waitFor('document.querySelector(".mixer-panel .pitch-stepper output")?.textContent === "Original key"');
  await checkKeyPitch(60);
  checks.push("Key pitch pipe plays real oscillators at the tonic, follows mixer edits, restored preferences, and folder pitch overrides");
  await devtools.evaluate('history.back()');
  await devtools.waitFor('!!document.querySelector(".folder-tag-actions")');
  checks.push("Current pitch saved per folder entry; inline edits persist and folder links override device pitch, including zero");
  await layout("Folder editor");
  const shareGeometry = 'JSON.stringify([...document.querySelectorAll(".share-split, .share-split > button, .folder-toolbar")].map(element => element.getBoundingClientRect().toJSON()))';
  assert(await devtools.evaluate('document.querySelectorAll(".share-split > button").length === 2 && document.querySelector(".sharing-toggle").getAttribute("aria-label") === "Sharing permissions"'), "Copy and permissions are not one accessible split control");
  await devtools.evaluate('document.querySelector(".copy-share-link").focus()');
  const beforeCopy = await devtools.evaluate(shareGeometry);
  await devtools.evaluate('window.originalClipboardWrite = navigator.clipboard.writeText; window.copyCalls = 0; navigator.clipboard.writeText = (text) => { window.copyCalls++; return new Promise((resolve, reject) => { window.finishCopy = () => window.originalClipboardWrite.call(navigator.clipboard, text).then(resolve, reject); }); }');
  await click(".copy-share-link");
  await devtools.waitFor('document.querySelector(".copy-share-link")?.textContent === "Copying…"');
  assert(await devtools.evaluate(shareGeometry) === beforeCopy, "Copying changes split-button size or layout");
  await click(".copy-share-link");
  assert(await devtools.evaluate('window.copyCalls') === 1, "Pending copy allows duplicate requests");
  await devtools.evaluate('window.finishCopy()', true);
  await devtools.waitFor('document.querySelector(".copy-share-link")?.textContent === "Copied!"');
  assert(await devtools.evaluate(shareGeometry) === beforeCopy, "Copied confirmation changes split-button size or layout");
  assert(await devtools.evaluate('document.activeElement?.classList.contains("copy-share-link") && !document.querySelector(".sharing-dropdown")'), "Copying loses focus or opens the permissions menu");
  await devtools.evaluate('navigator.clipboard.writeText = window.originalClipboardWrite');
  const shareUrl = await devtools.evaluate('navigator.clipboard.readText()', true);
  assert(shareUrl.startsWith(`${baseUrl}/shared/`), "Copy share link did not write the clipboard");
  await devtools.waitFor('document.querySelector(".copy-share-link")?.textContent === "Copy share link"');
  assert(await devtools.evaluate(shareGeometry) === beforeCopy, "Resetting copy feedback changes split-button size or layout");
  checks.push("Split share button copies without resizing during pending, copied, and reset states; focus and duplicate-click guards work");
  assert(await devtools.evaluate('!document.querySelector(".share-url, .share-panel, .library-links, .inline-form")'), "Folder editor exposes redundant controls");
  // Headless Chromium can return an empty clipboard after repeated writes, even
  // for native writeText. Check the fallback's real selection and command result.
  await devtools.evaluate(`window.originalClipboardWrite = navigator.clipboard.writeText;
    navigator.clipboard.writeText = () => Promise.reject(new Error("blocked"));
    window.originalExecCommand = document.execCommand;
    document.execCommand = function(command, ...args) {
      const selected = String(window.getSelection());
      const result = window.originalExecCommand.call(this, command, ...args);
      window.fallbackCopy = { command, selected, result };
      return result;
    }`);
  await click(".copy-share-link");
  await devtools.waitFor('document.querySelector(".copy-share-link")?.textContent === "Copied!"');
  const fallbackCopy = await devtools.evaluate('window.fallbackCopy');
  assert(fallbackCopy?.command === "copy" && fallbackCopy.selected === shareUrl && fallbackCopy.result, "Clipboard fallback did not copy the selected share URL");
  assert(await devtools.evaluate('!document.querySelector("textarea") && document.activeElement?.classList.contains("copy-share-link")'), "Clipboard fallback leaves an input or loses focus");
  assert(await devtools.evaluate(shareGeometry) === beforeCopy, "Clipboard fallback changes split-button size or layout");
  await devtools.evaluate('navigator.clipboard.writeText = window.originalClipboardWrite; document.execCommand = window.originalExecCommand');
  await screenshot("mobile-folder");
  await click('.rename-toggle');
  await fill('.inline-form input[name="name"]', "Our next rehearsal");
  await devtools.evaluate('document.querySelector(".inline-form").requestSubmit()', true);
  await devtools.waitFor('document.querySelector("h1")?.textContent === "Our next rehearsal"');
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await layout("Folder editor desktop");
  await devtools.waitFor('document.querySelector(".copy-share-link")?.textContent === "Copy share link"');
  const desktopShareGeometry = await devtools.evaluate(shareGeometry);
  await click(".copy-share-link");
  await devtools.waitFor('document.querySelector(".copy-share-link")?.textContent === "Copied!"');
  assert(await devtools.evaluate(shareGeometry) === desktopShareGeometry, "Desktop copy confirmation changes split-button size or layout");
  await screenshot("desktop-folder");
  checks.push("Folder membership, direct clipboard copy with fallback, compact rename, and mobile menu keyboard behavior");
  await navigate("/history");
  await devtools.waitFor('document.querySelectorAll(".saved-tag-list li").length === 2');
  assert(await devtools.evaluate('document.querySelector(".saved-tag-list strong").textContent === "Second rehearsal tag"'), "History order incorrect");
  await devtools.evaluate('window.confirm = () => true');
  await click('.library-page button.button-secondary');
  await devtools.waitFor('document.querySelectorAll(".saved-tag-list li").length === 0');
  assert((await api("account/marks/37", "GET", undefined, owner.id)).data.marks.length === 2, "Clear history deleted marks");
  checks.push("Recent history deduplicates visits and clears independently");
  await navigate("/account");
  await devtools.waitFor('!!document.querySelector(".account-email")');
  await click('.account-card > button');
  await devtools.waitFor('!!document.querySelector(".account-form")');
  await navigate(new URL(shareUrl).pathname);
  await devtools.waitFor('document.querySelector("h1")?.textContent === "Our next rehearsal"');
  assert(await devtools.evaluate('document.querySelector(".saved-tag-list strong").textContent === "Second rehearsal tag" && !document.querySelector(".folder-tag-actions")'), "Anonymous shared view incorrect");
  assert((await api(`account/folders/${folderId}`, "DELETE")).status === 401, "Anonymous folder modification allowed");
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await layout("Anonymous shared folder");
  assert(await devtools.evaluate('document.querySelector(".folder-owner")?.textContent') === `Owner: ${owner.email}`, "Anonymous shared view omits owner email");
  assert(await devtools.evaluate('document.querySelector(".saved-tag-link[href=\\"/tags/37?pitch=3\\"]")?.textContent.includes("+3 semitones")'), "Shared folder lost pitch");
  await navigate("/tags/37");
  await devtools.waitFor('!!document.querySelector(".marks-account-note")');
  assert(await devtools.evaluate('document.querySelectorAll(".mark-chip").length === 0 && document.querySelector(".mark-button").disabled'), "Personal marks leaked to guest");
  checks.push("Anonymous sharing works; private marks and edits remain unavailable");
  await navigate(new URL(shareUrl).pathname);
  await devtools.waitFor('!!document.querySelector("a.import-folder")');
  await click(".import-folder");
  await devtools.waitFor('!!document.querySelector(".account-form")');
  await click(".account-card > button.text-link");
  await fill('input[name="email"]', "other@example.test");
  await fill('input[name="password"]', "another smoke test password");
  await devtools.evaluate('document.querySelector(".account-form").requestSubmit()', true);
  await devtools.waitFor('location.pathname.startsWith("/shared/") && !!document.querySelector("button.import-folder")');
  const other = (await api("account/session")).data.user;
  const isolatedFolder = await api(`account/folders/${folderId}`, "GET", undefined, other.id);
  assert(isolatedFolder.status === 404, `Account isolation failed: ${JSON.stringify({ isolatedFolder, owner, other, folderId, serverOutput: serverOutput.slice(-2500) })}`);
  assert((await api("account/marks/37", "GET", undefined, other.id)).data.marks.length === 0, "Another account got private marks");
  assert((await api("account/history", "GET", undefined, other.id)).data.items.length === 0, "Another account got private history");
  checks.push("Second-account isolation");
  await layout("Shared folder import");
  await click("button.import-folder");
  await devtools.waitFor('location.pathname.startsWith("/folders/") && document.querySelectorAll(".saved-tag-list li").length === 2');
  const importedId = await devtools.evaluate('location.pathname.split("/").pop()');
  assert(importedId !== folderId, "Import returned the source folder");
  const imported = (await api(`account/folders/${importedId}`, "GET", undefined, other.id)).data.folder;
  assert(imported.name === "Our next rehearsal" && imported.tags.map(tag => tag.id).join(",") === "1482,37", "Import lost name or tag order");
  assert(imported.tags.map(tag => tag.pitchSemitones).join(",") === "0,3", "Import lost folder pitches");
  assert(!shareUrl.endsWith(imported.shareToken), "Import reused the source share link");
  assert((await api("account/marks/37", "GET", undefined, other.id)).data.marks.length === 0, "Import copied personal marks");
  assert((await api("account/history", "GET", undefined, other.id)).data.items.length === 0, "Import copied viewing history");
  await click('.folder-tag-actions button[aria-label^="Remove"]');
  await devtools.waitFor('document.querySelectorAll(".saved-tag-list li").length === 1');
  await navigate(new URL(shareUrl).pathname);
  await devtools.waitFor('document.querySelectorAll(".saved-tag-list li").length === 2');
  assert(await devtools.evaluate('document.querySelector(".saved-tag-list strong").textContent === "Second rehearsal tag"'), "Editing imported folder changed the original");
  checks.push("Shared-folder sign-in return, import with preserved order, private-data isolation, and independent editing");
  // Attaching a share keeps the original folder, unlike the copy above.
  assert(await devtools.evaluate('document.querySelector("button.add-shared-folder")?.textContent === "Add to my folders" && document.querySelector("button.import-folder")?.textContent === "Add a copy to my folders"'), "Shared folder actions are inconsistent");
  await click(".add-shared-folder");
  await devtools.waitFor(`location.pathname === "/folders/${folderId}" && document.querySelector(".folder-heading")?.textContent.includes("Read-only")`);
  assert(await devtools.evaluate('!document.querySelector(".folder-tag-actions, .rename-toggle, .danger-button, .copy-share-link, .sharing-toggle")'), "Viewer sees editing or owner controls");
  await layout("Linked read-only folder");
  await navigate("/folders");
  await devtools.waitFor(`!!document.querySelector('.folder-grid a[href="/folders/${folderId}"]')`);
  assert(await devtools.evaluate(`document.querySelector('.folder-grid a[href="/folders/${folderId}"]').textContent.includes("Read-only")`), "Linked folder missing from normal folder list");
  await navigate("/tags/37");
  await devtools.waitFor('!document.querySelector(".tag-save-button").disabled');
  await click('.tag-account-actions button[aria-expanded]');
  await devtools.waitFor(`!!document.querySelector('.saved-folder-option[data-folder-id="${folderId}"]')`);
  assert(await devtools.evaluate(`document.querySelector('.saved-folder-option[data-folder-id="${folderId}"] .remove-folder-tag').disabled && document.querySelector('.saved-folder-option[data-folder-id="${folderId}"]').textContent.includes("Read-only") && !!document.querySelector('.saved-folder-option[data-folder-id="${folderId}"] a[href="/folders/${folderId}"]')`), "Read-only folder does not preserve view-only actions");
  checks.push("Read-only originals appear in My folders and tag memberships without editing controls");

  assert((await api("account/login", "POST", { email: owner.email, password: "a long smoke test password" })).status === 200, "Owner sign-in failed");
  await navigate(`/folders/${folderId}`);
  await devtools.waitFor('!!document.querySelector(".sharing-toggle")');
  const listTop = await devtools.evaluate('document.querySelector(".saved-tag-list").getBoundingClientRect().top');
  await devtools.evaluate('window.dropdownCopyCalls = 0; window.originalDropdownWrite = navigator.clipboard.writeText; navigator.clipboard.writeText = (text) => { window.dropdownCopyCalls++; return window.originalDropdownWrite.call(navigator.clipboard, text); }');
  await click('.sharing-toggle');
  await devtools.waitFor('document.querySelectorAll(".sharing-dropdown [role=menuitemradio]").length === 2');
  assert(await devtools.evaluate('document.querySelector(".saved-tag-list").getBoundingClientRect().top') === listTop, "Sharing dropdown shifts the folder contents");
  assert(await devtools.evaluate('window.dropdownCopyCalls') === 0, "Dropdown arrow copies the link");
  await devtools.evaluate('navigator.clipboard.writeText = window.originalDropdownWrite');
  assert(await devtools.evaluate('document.querySelector(".sharing-dropdown [aria-checked=true]")?.textContent.includes("Read-only")'), "Sharing does not default to read-only");
  assert(await devtools.evaluate('!document.querySelector(".sharing-panel, .sharing-dropdown input, .sharing-dropdown select") && document.querySelectorAll(".sharing-dropdown button").length === 2'), "Sharing exposes extra controls");
  await layout("Sharing dropdown mobile");
  await screenshot("mobile-sharing");
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown" });
  assert(await devtools.evaluate('document.activeElement?.textContent === "Read/write"'), "Sharing keyboard navigation failed");
  await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await devtools.waitFor('!document.querySelector(".sharing-dropdown") && document.activeElement?.classList.contains("sharing-toggle")');
  await click('.sharing-toggle');
  await devtools.waitFor('!!document.querySelector(".sharing-dropdown")');
  await devtools.evaluate('document.querySelector("h1").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))');
  await devtools.waitFor('!document.querySelector(".sharing-dropdown")');
  await click('.sharing-toggle');
  for (const width of [420, 1440]) {
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 640 });
    await devtools.waitFor('document.querySelector(".sharing-dropdown")?.getBoundingClientRect().left >= 0 && document.querySelector(".sharing-dropdown").getBoundingClientRect().right <= document.documentElement.clientWidth');
    await layout("Sharing dropdown");
  }
  await screenshot("desktop-sharing");
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await click('.sharing-dropdown button:last-of-type');
  await devtools.waitFor('!document.querySelector(".sharing-dropdown") && document.querySelector(".sharing-control [role=status]")?.textContent.includes("read/write")');
  const sharedToken = new URL(shareUrl).pathname.split("/").pop();
  const settings = (await api(`account/folders/${folderId}/sharing`, "GET", undefined, owner.id)).data.sharing;
  assert(settings.access === "edit" && Object.keys(settings).length === 1, "Sharing setting is not a single access level");
  assert((await api(`account/folders/${folderId}`, "GET", undefined, owner.id)).data.folder.shareToken === sharedToken, "Permission change replaced the URL");
  checks.push("Compact Sharing dropdown has two choices, keyboard and outside-click dismissal, and preserves layout at 360/420/1440px");

  assert((await api("account/login", "POST", { email: other.email, password: "another smoke test password" })).status === 200, "Member sign-in failed");
  await navigate(new URL(shareUrl).pathname);
  await devtools.waitFor('!!document.querySelector("button.add-shared-folder")');
  assert(await devtools.evaluate('document.querySelector(".folder-heading")?.textContent.includes("Can edit") && !!document.querySelector("button.import-folder")'), "Shared folder lost its actions");
  assert(await devtools.evaluate('document.querySelector(".folder-owner")?.textContent') === `Owner: ${owner.email}`, "Public folder omits owner email");
  await navigate(`/folders/${folderId}`);
  await devtools.waitFor('!!document.querySelector(".folder-tag-actions")');
  assert(await devtools.evaluate('document.querySelector(".folder-owner")?.textContent') === `Owner: ${owner.email}`, "Saved shared folder omits owner email");
  assert(await devtools.evaluate('!document.querySelector(".rename-toggle, .danger-button, .copy-share-link, .sharing-toggle")'), "Editor controls include owner-only actions");
  await click('.folder-pitch button[aria-label="Raise pitch for First rehearsal tag"]');
  await devtools.waitFor('document.querySelector(".saved-tag-list li:last-child .pitch-stepper output")?.textContent === "+4"');
  assert((await api(`shared/${sharedToken}`)).data.folder.tags[1].pitchSemitones === 4, "Editor did not update original folder");
  assert((await api(`account/folders/${importedId}`, "GET", undefined, other.id)).data.folder.tags[0].pitchSemitones === 3, "Editor changed an independent copy");
  assert((await api(`account/folders/${folderId}`, "PATCH", { name: "Renamed by editor" }, other.id)).status === 403, "Editor can rename the folder through the API");
  await layout("Linked editable folder");
  checks.push("One URL grants editing to existing saved folders without rejoining; owner email appears in shared and saved views");

  // Simulate an owner changing permissions while a member still has the folder open.
  assert((await api("account/login", "POST", { email: owner.email, password: "a long smoke test password" })).status === 200, "Owner sign-in failed");
  assert((await api(`account/folders/${folderId}/sharing`, "PATCH", { access: "view" }, owner.id)).status === 200, "Could not change sharing to read-only");
  assert((await api("account/login", "POST", { email: other.email, password: "another smoke test password" })).status === 200, "Member sign-in failed");
  assert((await api(`account/folders/${folderId}/tags/37`, "DELETE", undefined, other.id)).status === 403, "Stale editor can still write");
  await devtools.evaluate('window.dispatchEvent(new Event("focus"))');
  await devtools.waitFor('document.querySelector(".folder-heading")?.textContent.includes("Read-only") && !document.querySelector(".folder-tag-actions")');
  assert((await api(`shared/${sharedToken}`)).data.folder.access === "view", "The original shared URL no longer works read-only");
  await navigate("/folders");
  await devtools.waitFor(`!!document.querySelector('.folder-grid a[href="/folders/${folderId}"]')`);
  assert((await api(`account/folders/${importedId}`, "GET", undefined, other.id)).data.folder.access === "owner", "Permission changes affected an independent copy");
  checks.push("Permission changes preserve the URL and saved folders, reject stale writes, refresh controls on focus, and preserve copies");
  await navigate("/tools");
  await devtools.waitFor('!!document.querySelector(".note-tools-standalone .piano-key")');
  assert(await devtools.evaluate('!document.querySelector(".note-readout, .tools-pitch-toggle") && document.querySelector(".tools-pitch-control output").textContent === "Original key"'), "Standalone pitch controls or removed readout are wrong");
  await checkTone('.pitch-pipe-notes [aria-label="Play C 4 on the pitch pipe"]', 60);
  await click('.tools-pitch-control [aria-label="Lower pitch one semitone"]');
  await click('.tools-pitch-control [aria-label="Lower pitch one semitone"]');
  await checkTone('.pitch-pipe-notes [aria-label="Play C 4 on the pitch pipe"]', 58);
  await checkTone('.piano [aria-label="Play C 4 on the piano"]', 58);
  // Two simultaneous touches should sound both adjusted notes and light the written keys.
  const beforeChord = await devtools.evaluate('window.keyToneProbe.length');
  await devtools.evaluate(`['C', 'E'].forEach((note, index) => document.querySelector('.piano [aria-label="Play ' + note + ' 4 on the piano"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: index + 1, pointerType: 'touch' })))`, true);
  await devtools.waitFor(`window.keyToneProbe.slice(${beforeChord}).length === 6 && window.keyToneProbe.slice(${beforeChord}).every((oscillator, index) => Math.abs(oscillator.frequency.value - 440 * 2 ** (((index < 3 ? 58 : 62) - 69) / 12) * (index % 3 + 1)) < 0.001)`);
  assert(await devtools.evaluate('document.querySelectorAll(".piano-key.is-active").length === 2'), "Adjusted piano lost multi-touch highlighting");
  await layout("Standalone pitch tools");
  await devtools.waitFor('!!document.querySelector(".piano .instrument-description")');
  await screenshot("mobile-tools-pitch");
  await navigate("/tools");
  await devtools.waitFor('document.querySelector(".tools-pitch-control output")?.textContent === "-2 semitones"');
  await checkTone('.pitch-pipe-notes [aria-label="Play C 4 on the pitch pipe"]', 58);
  await navigate("/tags/37");
  await devtools.waitFor('!!document.querySelector(".tools-pitch-toggle input")');
  assert(await devtools.evaluate('!document.querySelector(".tools-pitch-toggle input").checked'), "Standalone session pitch enabled tag adjustment");
  await navigate("/tools");
  await devtools.waitFor('document.querySelector(".tools-pitch-control output")?.textContent === "-2 semitones"');
  await devtools.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await layout("Standalone pitch tools desktop");
  await devtools.waitFor('!document.querySelector(".piano .instrument-description")');
  assert(await devtools.evaluate(`(() => {
    const scroller = document.querySelector(".piano-scroll").getBoundingClientRect();
    const keyboard = document.querySelector(".piano-keyboard").getBoundingClientRect();
    return Math.abs(keyboard.left + keyboard.right - scroller.left - scroller.right) < 2;
  })()`), "Piano is not centered when it fits");
  for (const [key, code, keyCode] of [["Enter", "Enter", 13], [" ", "Space", 32]]) {
    await devtools.evaluate('document.querySelector(".piano-scroll").scrollIntoView({ block: "center", behavior: "instant" }); document.querySelector(".piano-key-white").focus({ preventScroll: true })');
    await devtools.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text: key === "Enter" ? "\r" : " ", unmodifiedText: key === "Enter" ? "\r" : " " });
    await devtools.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await devtools.waitFor('document.querySelector(".piano-key-white").classList.contains("is-active")');
    assert(await devtools.evaluate(`(() => {
      const black = document.querySelector(".piano-key-black");
      const bounds = black.getBoundingClientRect();
      return document.elementFromPoint(bounds.left + 3, bounds.top + 20)?.closest(".piano-key") === black;
    })()`), `${code} raised the white key above the black key`);
  }
  checks.push("Piano stays below black keys during keyboard activation, centers when it fits, and only shows the scroll hint when needed");
  await devtools.evaluate('window.scrollTo({ top: 0, behavior: "instant" })');
  assert(await devtools.evaluate(`(() => {
    const label = document.querySelector(".tools-pitch-control > span").getBoundingClientRect();
    const stepper = document.querySelector(".tools-pitch-control .pitch-stepper").getBoundingClientRect();
    return stepper.left - label.right <= 13 && stepper.left > label.right && Math.abs((label.top + label.bottom - stepper.top - stepper.bottom) / 2) < 1;
  })()`), "Pitch label is not immediately beside the selector");
  await screenshot("desktop-tools-pitch");
  await devtools.evaluate('sessionStorage.setItem("tagmix:tools:pitch", "99")');
  await navigate("/tools");
  await devtools.waitFor('document.querySelector(".tools-pitch-control output")?.textContent === "Original key"');
  checks.push("Standalone pitch shifts both instruments, preserves piano multi-touch, survives reload/navigation in session, rejects invalid stored pitch, and stays separate from tags");
  assert(errors.length === 0, `Browser errors: ${errors.join(", ")}`);
  console.log(JSON.stringify({ passed: true, checks, media: "Browser fixtures; account APIs and SQLite are real" }, null, 2));
} finally {
  devtools?.close();
  browser.kill("SIGTERM");
  server.kill("SIGTERM");
  await Promise.all([new Promise(resolve => (browser.exitCode !== null || browser.signalCode !== null) ? resolve() : browser.once("exit", resolve)), new Promise(resolve => (server.exitCode !== null || server.signalCode !== null) ? resolve() : server.once("exit", resolve))]);
  // Chromium helpers can finish writing the profile just after the parent exits.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(fixture, { recursive: true, force: true });
}
