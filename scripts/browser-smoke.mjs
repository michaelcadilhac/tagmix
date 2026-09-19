import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.TAGMIX_TEST_URL ?? "http://localhost:3000";
const chromium = process.env.CHROMIUM_BIN ?? "chromium";
const debugPort = Number(process.env.TAGMIX_DEBUG_PORT ?? 9333);
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
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await wait(120);
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  close() {
    this.#socket.close();
  }
}

let devtools;
try {
  devtools = new DevTools(await pageTarget());
  await devtools.open();
  await devtools.send("Page.enable");
  await devtools.send("Runtime.enable");
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await devtools.send("Emulation.setTouchEmulationEnabled", { enabled: true });

  await devtools.send("Page.navigate", { url: `${baseUrl}/` });
  await devtools.waitFor(`document.readyState === "complete"`);
  await devtools.waitFor(`document.querySelector(".catalog-heading-row h2")?.textContent.includes("rehearsal-ready")`);
  const home = await devtools.evaluate(`({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    cards: document.querySelectorAll(".tag-card:not(.tag-card-skeleton)").length,
    count: document.querySelector(".hero-stat strong")?.textContent,
    prominentQualityLabels: document.querySelectorAll(".quality-pill").length,
    pitchToolsLink: document.querySelector('.hero-actions a[href="/tools"]')?.textContent
  })`);
  if (home.width > home.viewport
    || home.cards < 1
    || home.prominentQualityLabels !== 0
    || !home.pitchToolsLink?.includes("pitch pipe & piano")) {
    throw new Error(`Mobile catalog layout failed: ${JSON.stringify(home)}`);
  }

  await devtools.evaluate(`(() => {
    const input = document.querySelector("input[type=search]");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Blue Skies");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await devtools.waitFor(`document.querySelector(".catalog-heading-row h2")?.textContent.includes("matches for")`);

  await devtools.send("Page.navigate", { url: `${baseUrl}/tags/1890` });
  await devtools.waitFor(`document.readyState === "complete"`);
  await devtools.waitFor(`document.querySelector(".track-readiness")?.textContent.includes("All four parts ready")`, 45_000);
  const detail = await devtools.evaluate(`({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    title: document.querySelector(".workspace-heading h1")?.textContent,
    voices: document.querySelectorAll(".voice-strip").length,
    prominentQualityLabels: document.querySelectorAll(".quality-pill").length,
    audioNote: document.querySelector(".tag-notes-grid .note-wide p")?.textContent,
    sourceLink: document.querySelector(".tag-notes .source-link")?.href,
    pitchModes: [...document.querySelectorAll('.pitch-mode-control input[type="radio"]')].map(input => input.value),
    selectedPitchMode: document.querySelector('.pitch-mode-control input[type="radio"]:checked')?.value,
    pitchValue: document.querySelector(".pitch-stepper output")?.textContent,
    noteToolsClosed: !document.querySelector(".note-tools-embedded")?.classList.contains("is-open"),
    noteToolButtons: [...document.querySelectorAll(".note-tools-launcher-buttons button")].map(button => ({
      label: button.textContent?.trim(),
      expanded: button.getAttribute("aria-expanded")
    })),
    pitchControlsVisible: [
      document.querySelector(".speed-control button:last-child"),
      document.querySelector(".pitch-stepper"),
      document.querySelector('.pitch-mode-control input[value="server"] + span')
    ].every(element => {
      const bounds = element?.getBoundingClientRect();
      return bounds && bounds.left >= 0 && bounds.right <= window.innerWidth;
    })
  })`);
  if (detail.width > detail.viewport
    || detail.voices !== 4
    || detail.prominentQualityLabels !== 0
    || !detail.audioNote?.includes("Parts cleanly extracted")
    || !/\/tag-1890-.+/.test(detail.sourceLink ?? "")
    || detail.pitchModes.join(",") !== "client,server"
    || detail.selectedPitchMode !== "client"
    || detail.pitchValue !== "Original key"
    || !detail.noteToolsClosed
    || JSON.stringify(detail.noteToolButtons) !== JSON.stringify([
      { label: "Piano", expanded: "false" },
      { label: "Pitchpipe", expanded: "false" }
    ])
    || !detail.pitchControlsVisible) {
    throw new Error(`Mobile rehearsal layout failed: ${JSON.stringify(detail)}`);
  }

  await devtools.evaluate(`document.querySelector(".note-tools-launcher-buttons button:last-child").click()`, true);
  await devtools.waitFor(`document.querySelectorAll(".note-tools-embedded .pitch-pipe-notes button").length === 12`);
  await devtools.evaluate(`document.querySelector('.note-tools-embedded [aria-label="Play C 4 on the pitch pipe"]').click()`, true);
  await devtools.waitFor(`document.querySelector(".note-tools-embedded .note-readout strong")?.textContent === "C4"`);
  await devtools.evaluate(`document.querySelector(".note-tools-launcher-buttons button:first-child").click()`, true);
  await devtools.waitFor(`document.querySelectorAll(".note-tools-embedded .piano-key").length === 37`);
  await devtools.evaluate(`(() => {
    const touches = [
      [document.querySelector('.note-tools-embedded [aria-label="Play C 4 on the piano"]'), 11],
      [document.querySelector('.note-tools-embedded [aria-label="Play E 4 on the piano"]'), 12]
    ];
    for (const [key, pointerId] of touches) {
      key.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        cancelable: true,
        isPrimary: pointerId === 11,
        pointerId,
        pointerType: "touch"
      }));
    }
  })()`, true);
  await devtools.waitFor(`document.querySelectorAll(".note-tools-embedded .piano-key.is-active").length === 2`);
  const embeddedTools = await devtools.evaluate(`({
    pageWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    selectedTool: document.querySelector(".note-tools-launcher-buttons button.is-active")?.textContent?.trim(),
    activePianoKeys: [...document.querySelectorAll(".note-tools-embedded .piano-key.is-active")].map(key => key.getAttribute("aria-label")),
    readout: document.querySelector(".note-tools-embedded .note-readout")?.textContent,
    pianoScrollContained: (() => {
      const scroller = document.querySelector(".note-tools-embedded .piano-scroll");
      return scroller && scroller.scrollWidth > scroller.clientWidth;
    })()
  })`);
  if (embeddedTools.pageWidth > embeddedTools.viewport
    || embeddedTools.selectedTool !== "Piano"
    || embeddedTools.activePianoKeys.length !== 2
    || !embeddedTools.activePianoKeys.some(label => label.includes("C 4"))
    || !embeddedTools.activePianoKeys.some(label => label.includes("E 4"))
    || !embeddedTools.readout?.includes("329.6 Hz")
    || !embeddedTools.pianoScrollContained) {
    throw new Error(`Embedded pitch tools failed: ${JSON.stringify(embeddedTools)}`);
  }
  if (process.env.TAGMIX_SCREENSHOT_DIR) {
    const screenshot = await devtools.send("Page.captureScreenshot", { captureBeyondViewport: true, format: "png" });
    await writeFile(`${process.env.TAGMIX_SCREENSHOT_DIR}/tag-tools.png`, screenshot.data, "base64");
  }
  await devtools.evaluate(`document.querySelector(".note-tools-launcher-buttons button:first-child").click()`, true);

  const clientPitch = await devtools.evaluate(`(async () => {
    const sampleRate = 48_000;
    const frameCount = sampleRate * 2;
    const context = new OfflineAudioContext(1, frameCount, sampleRate);
    if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") {
      return { available: false };
    }
    await context.audioWorklet.addModule("/audio/pitch-shifter.worklet.js?v=2");
    const source = context.createBufferSource();
    const buffer = context.createBuffer(1, frameCount, sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(2 * Math.PI * 220 * index / sampleRate) * 0.5;
    }
    source.buffer = buffer;
    const shifter = new AudioWorkletNode(context, "tagmix-pitch-shifter", {
      channelCount: 1,
      channelCountMode: "explicit",
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      parameterData: { pitchRatio: 2 ** (3 / 12) },
      processorOptions: { latencySamples: 2048 }
    });
    source.connect(shifter).connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    const output = rendered.getChannelData(0);
    const start = 8192;
    const length = 24_000;
    let bestFrequency = 0;
    let bestMagnitude = -1;
    let energy = 0;
    for (let index = start; index < start + length; index += 1) energy += output[index] ** 2;
    for (let frequency = 240; frequency <= 280; frequency += 0.25) {
      let real = 0;
      let imaginary = 0;
      for (let offset = 0; offset < length; offset += 1) {
        const phase = 2 * Math.PI * frequency * offset / sampleRate;
        const sample = output[start + offset];
        real += sample * Math.cos(phase);
        imaginary -= sample * Math.sin(phase);
      }
      const magnitude = real * real + imaginary * imaginary;
      if (magnitude > bestMagnitude) {
        bestMagnitude = magnitude;
        bestFrequency = frequency;
      }
    }
    return {
      available: true,
      duration: rendered.duration,
      expectedFrequency: 220 * (2 ** (3 / 12)),
      measuredFrequency: bestFrequency,
      rms: Math.sqrt(energy / length)
    };
  })()`);
  if (clientPitch.available && (Math.abs(clientPitch.duration - 2) > 0.001
    || Math.abs(clientPitch.measuredFrequency - clientPitch.expectedFrequency) > 3
    || clientPitch.rms < 0.01)) {
    throw new Error(`Client pitch processing failed: ${JSON.stringify(clientPitch)}`);
  }

  await devtools.evaluate(`document.querySelector('[aria-label="Raise pitch one semitone"]').click()`, true);
  await devtools.waitFor(`document.querySelector(".pitch-stepper output")?.textContent === "+1 semitone"`);
  await devtools.evaluate(`document.querySelector(".play-button").click()`, true);
  await devtools.waitFor(`document.querySelector(".play-button")?.getAttribute("aria-label") === "Pause all parts"`, 15_000);
  await devtools.waitFor(`document.querySelector(".mixer-panel")?.dataset.clientPitchBackend`);
  await wait(1_200);
  const clientBackend = await devtools.evaluate(`document.querySelector(".mixer-panel")?.dataset.clientPitchBackend`);
  const expectedClientBackend = clientPitch.available ? "worklet" : "fallback";
  if (clientBackend !== expectedClientBackend) {
    throw new Error(`Wrong client pitch backend: expected ${expectedClientBackend}, got ${clientBackend}.`);
  }
  const playbackTime = await devtools.evaluate(`Math.max(...[...document.querySelectorAll("audio")].map(a => a.currentTime), 0)`);
  // Audio elements are deliberately detached from the DOM, so verify transport text too.
  const transportTime = await devtools.evaluate(`document.querySelector(".time-row span")?.textContent`);
  if (playbackTime === 0 && transportTime === "0:00") throw new Error("Mixer playback did not advance.");
  await devtools.evaluate(`document.querySelector(".mark-button").click()`, true);
  await devtools.waitFor(`document.querySelectorAll(".mark-chip").length === 1`);
  await devtools.evaluate(`document.querySelector(".play-button").click()`, true);

  await devtools.evaluate(`document.querySelector('.pitch-mode-control input[value="server"]').click()`, true);
  await devtools.waitFor(`document.querySelector('.pitch-mode-control input[value="server"]')?.checked === true`);
  await devtools.waitFor(`performance.getEntriesByType("resource").some(entry => entry.name.includes("/audio/") && entry.name.includes("pitch=1"))`, 120_000);
  await devtools.waitFor(`document.querySelector(".track-readiness")?.textContent.includes("All four parts ready")`, 120_000);
  const serverPitch = await devtools.evaluate(`({
    selectedPitchMode: document.querySelector('.pitch-mode-control input[type="radio"]:checked')?.value,
    requestedVariant: performance.getEntriesByType("resource").some(entry => entry.name.includes("/audio/") && entry.name.includes("pitch=1")),
    transportTime: document.querySelector(".time-row span")?.textContent
  })`);
  if (serverPitch.selectedPitchMode !== "server" || !serverPitch.requestedVariant || serverPitch.transportTime !== "0:00") {
    throw new Error(`Server pitch source switching failed: ${JSON.stringify(serverPitch)}`);
  }

  await devtools.send("Page.navigate", { url: `${baseUrl}/tools` });
  await devtools.waitFor(`document.readyState === "complete"`);
  await devtools.waitFor(`document.querySelector(".note-tools-standalone .piano-key") !== null`);
  await devtools.evaluate(`document.querySelector('.note-tools-standalone [aria-label="Play A sharp or B flat 4 on the pitch pipe"]').click()`, true);
  await devtools.waitFor(`document.querySelector(".note-tools-standalone .note-readout strong")?.textContent === "A♯ / B♭4"`);
  const standaloneTools = await devtools.evaluate(`({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
    heading: document.querySelector(".tools-page-hero h1")?.textContent,
    pitchPipeNotes: document.querySelectorAll(".note-tools-standalone .pitch-pipe-notes button").length,
    pianoKeys: document.querySelectorAll(".note-tools-standalone .piano-key").length,
    readout: document.querySelector(".note-tools-standalone .note-readout")?.textContent,
    backLink: document.querySelector('.tools-page a[href="/"]')?.textContent,
    textFits: [
      document.querySelector(".tools-page-hero h1"),
      document.querySelector(".tools-page-hero > p:last-child"),
      document.querySelector(".note-tools-header > p")
    ].every(element => element && element.scrollWidth <= element.clientWidth)
  })`);
  if (standaloneTools.width > standaloneTools.viewport
    || standaloneTools.heading !== "Find your note."
    || standaloneTools.pitchPipeNotes !== 12
    || standaloneTools.pianoKeys !== 37
    || !standaloneTools.readout?.includes("466.2 Hz")
    || !standaloneTools.backLink?.includes("Back to tag library")
    || !standaloneTools.textFits) {
    throw new Error(`Standalone pitch tools failed: ${JSON.stringify(standaloneTools)}`);
  }
  if (process.env.TAGMIX_SCREENSHOT_DIR) {
    const screenshot = await devtools.send("Page.captureScreenshot", { captureBeyondViewport: true, format: "png" });
    await writeFile(`${process.env.TAGMIX_SCREENSHOT_DIR}/standalone-tools.png`, screenshot.data, "base64");
  }

  console.log(JSON.stringify({ home, detail, embeddedTools, clientPitch, clientBackend, serverPitch, standaloneTools, transportTime, markSaved: true }, null, 2));
} finally {
  devtools?.close();
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await Promise.race([exited, wait(3_000)]);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
