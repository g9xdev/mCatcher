/*
 * background.js — persistent background page.
 * Detects media network requests per tab and coordinates downloads.
 */
"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;

// Flip to false to silence. View in about:debugging → Media Catcher → Inspect →
// Console. Logs detection/enrich/collapse decisions so stream issues are visible.
const DEBUG = true;
function dlog() {
  if (!DEBUG) return;
  try { console.log.apply(console, ["[MC]"].concat([].slice.call(arguments))); } catch (e) {}
}

// ---- Settings (persisted) ----
const DEFAULT_SETTINGS = {
  defaultQuality: "highest",    // "ask" | "highest" | "lowest"
  concurrency: 6,               // parallel segment fetches
  maxConcurrentDownloads: 4,    // parallel assembly jobs
  retries: 3,                   // per-segment retry attempts
  filenameTemplate: "{title}",  // see lib/filename.js tokens
  notifications: true,
  captureSubtitles: true,
  preferHighestRendition: true, // show only the top-bitrate rendition of a stream
  minDirectSizeMB: 5,           // hide direct files smaller than this (0 = off)
  saveFolder: "",               // default save folder for the helper ("" = Downloads)
  updateExtDir: "",             // the extension's source folder (for self-update)
  updateZipDir: "",             // where update .zip packages land ("" = the helper's
                                // own updates folder; the browser's download folder
                                // is refused, it is the drive-by plant vector)
  autoUpdate: false,            // helper watches the package folder and auto-installs
  convertCodec: "off",          // "off" | "h265" | "av1" — re-encode saved & downloaded files
  convertQuality: "visually-lossless", // "visually-lossless" | "balanced" | "true-lossless" (h265 only)
  convertEncoder: "auto",       // "auto" (GPU if available) | "cpu" (force software)
  // ---- popup side panel (the wide two-pane layout) ----
  showRail: true,               // show the right-hand panel → wide popup; off = classic single column
  showQueue: true,              // panel: global downloads queue (every tab's active + recent jobs)
  enableCasting: false,         // panel: Now-Casting transport + per-item Cast buttons (preview — network backend pending)
};
let settings = Object.assign({}, DEFAULT_SETTINGS);
let liveController = null;
let liveControllerInitialized = false;

// The controller's tick drives retry_backoff expiry and the detection finalizer's
// deadlines. Nothing else calls it, so without this clock those states never expire.
// MV2 persistent background page (manifest "persistent": true), so a plain interval
// survives; guarded because not every test sandbox defines one.
const LIVE_TICK_MS = 1000;
let liveTickTimer = null;

// A helper that is alive but silent looks exactly like a healthy slow one:
// ping/pong happened once at connect and never again. Keep asking.
const HELPER_PING_MS = 30000;
let helperPingTimer = null;
// Sending was never the hard part: an unanswered beat is what says the helper
// has stopped being usable. Crossing this many makes the pill say so — see
// helperHeartbeat for why it reports rather than disconnects.
const HELPER_MISSED_BEATS_MAX = 4;
let helperMissedBeats = 0;      // pings sent since the last pong

const settingsReady = api.storage.local.get(["settings", "pd4done", "dq1done"]).then((r) => {
  if (r && r.settings) settings = Object.assign({}, DEFAULT_SETTINGS, r.settings);
  // One-time migrations to newer defaults, each guarded by its own flag so a later
  // deliberate choice is respected (won't be re-applied on the next load).
  const flags = {};
  if (!(r && r.pd4done)) {
    if (settings.maxConcurrentDownloads === 2) settings.maxConcurrentDownloads = 4;
    flags.pd4done = true;
  }
  if (!(r && r.dq1done)) {
    if (settings.defaultQuality === "ask") settings.defaultQuality = "highest";
    flags.dq1done = true;
  }
  if (Object.keys(flags).length) api.storage.local.set(Object.assign({ settings }, flags)).catch(() => {});
}, () => {}).then(() => initializeLiveController());

function mintLiveToken() {
  const secure = typeof crypto !== "undefined" ? crypto : self.crypto;
  if (secure && typeof secure.randomUUID === "function") return secure.randomUUID();
  if (secure && typeof secure.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    secure.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Secure token generation unavailable.");
}

function isExtensionPopupSender(sender) {
  return !!sender && sender.id === api.runtime.id &&
    sender.url === api.runtime.getURL("popup/popup.html");
}

// Opaque IDs the controller mints. Deliberately narrow: no separators that
// could smuggle a URL, and bounded so a hostile query cannot grow unbounded.
function isSafeOpaqueActionId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200 &&
    /^[A-Za-z0-9:_-]+$/.test(value);
}

// The Save As page's identity is whatever the background put in the URL when it
// created the window — never anything the page later claims in a message.
function parseSaveAsSender(sender) {
  try {
    if (!sender || sender.id !== api.runtime.id || typeof sender.url !== "string") return null;
    const parsed = new URL(sender.url);
    const base = new URL(api.runtime.getURL("saveas/saveas.html"));
    if (parsed.origin !== base.origin || parsed.pathname !== base.pathname) return null;
    if (parsed.hash) return null;
    const params = parsed.searchParams;
    const keys = Array.from(params.keys());
    if (keys.length !== new Set(keys).size) return null;
    for (const key of keys) {
      if (key !== "tabId" && key !== "mediaId" && key !== "variantId") return null;
    }
    const rawTabId = params.get("tabId");
    if (typeof rawTabId !== "string" || !/^\d{1,9}$/.test(rawTabId)) return null;
    const mediaId = params.get("mediaId");
    if (!isSafeOpaqueActionId(mediaId)) return null;
    const hasVariant = params.has("variantId");
    const variantId = hasVariant ? params.get("variantId") : null;
    if (hasVariant && !isSafeOpaqueActionId(variantId)) return null;
    return { tabId: Number(rawTabId), mediaId, variantId };
  } catch (e) {
    return null;
  }
}

// Managed download actions come from exactly two extension surfaces.
function isExtensionActionSender(sender) {
  return isExtensionPopupSender(sender) || parseSaveAsSender(sender) !== null;
}

function initializeLiveController() {
  if (liveControllerInitialized) return liveController;
  liveControllerInitialized = true;
  const liveAssembler = self.McLiveMediaAssembler.createLiveMediaAssembler({
    HLS: self.HLS,
    DASH: self.DASH,
    Mux: self.Mux,
  });
  liveController = self.McBackgroundAdapters.createBackgroundAdapters({
    maxConcurrent: settings.maxConcurrentDownloads,
    segmentConcurrency: settings.concurrency,
    retries: settings.retries,
    now: () => Date.now(),
    randomToken: () => mintLiveToken(),
    postNative: (command) => {
      if (!nativePort) throw new Error("Native helper unavailable.");
      return nativePort.postMessage(command);
    },
    downloadsDownload: (options) => api.downloads.download(options),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    fetchArrayBuffer: (tabId, url, options) => makeOneShotFetchFn(tabId)(url, options),
    assembleMedia: liveAssembler,
    // Keeps the controller's existing dependency key; the predicate now also
    // admits the exact validated Save As page.
    isPopupSender: isExtensionActionSender,
    getEffectiveDestinationDirectory: () => settings.saveFolder || null,
    publishDetection: () => broadcast({ type: "live-media-updated" }),
    publishJobs: (jobs) => broadcast({ type: "live-jobs-updated", jobs }),
    persistHistory: (entry) => addHistory(entry),
    reportDiagnostic: (diagnostic) => mclog(
      "warn",
      "policy: " + String(diagnostic && diagnostic.code || "unknown")
    ),
  });
  if (liveTickTimer === null && typeof setInterval === "function") {
    liveTickTimer = setInterval(() => {
      try {
        liveController.tick(Date.now());
      } catch (err) {
        mclog("warn", "tick: " + String((err && err.message) || err));
      }
    }, LIVE_TICK_MS);
  }
  return liveController;
}

// ---- diagnostics log + update history (Settings "Log console" panel) -------
// A rolling buffer of structured log lines (extension + host + guardian) and a
// list of durable update-history events. Both stream live to the Settings page and
// persist across background reloads, so a failed update leaves a legible trail
// instead of vanishing. Host/guardian lines arrive as {type:"log"} native messages.
const LOG_CAP = 500;
const EVENT_CAP = 150;
let logRing = [];
let updateEvents = [];
let _logSaveTimer = null;
const pendingReports = new Map();   // reqId -> resolver, settled by a host "report"
const pendingProbes = new Map();    // reqId -> resolver, settled by a host "probe-result"
const pendingYtMeta = new Map();    // reqId -> resolver, settled by a host "ytmeta"

// ---- casting (DLNA via the helper) ----
// The host runs discovery/playback and streams cast-status once a second; the
// popup renders that state and sends control actions. One session at a time.
let castState = { state: "idle" };
const pendingCastDiscover = new Map();   // reqId -> resolver, settled by "cast-devices"
let lastCastDevices = [];                // retained list — warm picker opens answer from it instantly

api.storage.local.get(["mcLogs", "mcEvents"]).then((r) => {
  // Merge (don't overwrite): lines pushed synchronously during startup — e.g. the
  // "connecting to the native helper…" line — must survive the async restore.
  if (r && Array.isArray(r.mcLogs)) {
    logRing = r.mcLogs.map(redactLogLine).concat(logRing).slice(-LOG_CAP);
  }
  if (r && Array.isArray(r.mcEvents)) {
    updateEvents = r.mcEvents.map(redactEventDetail).concat(updateEvents).slice(-EVENT_CAP);
  }
  _persistDiag();
}).catch(() => {});

function _persistDiag() {
  if (_logSaveTimer) return;
  _logSaveTimer = setTimeout(() => {
    _logSaveTimer = null;
    api.storage.local.set({ mcLogs: logRing.slice(-LOG_CAP), mcEvents: updateEvents.slice(-EVENT_CAP) }).catch(() => {});
  }, 800);
}

// Redact before the ring, not at copy time: _persistDiag writes the ring to
// storage.local, so whatever is kept here is readable by anything that can read
// extension storage, not only by whoever clicks Copy in Settings. Origin + path
// is what diagnoses a failure; a signed URL's query is what identifies the user.
// Applied to restored lines too, so a ring written by an older build is
// redacted on the next start rather than waiting to roll over.
function redactLogLine(line) {
  if (line && typeof line === "object") line.msg = self.McPrivacy.redactLogText(line.msg);
  return line;
}

// Update events ride the same persisted write and the same Copy button: they go
// to storage.local beside mcLogs and come back out of get-update-report. Their
// free-text field gets the projection msg gets, for the same reason. Every
// detail updates.py emits today is a literal English string; this is what
// catches the first one that carries a signed URL. Non-string details project
// to "" rather than passing through, and an event without a detail keeps none.
function redactEventDetail(ev) {
  if (ev && typeof ev === "object" && Object.prototype.hasOwnProperty.call(ev, "detail")) {
    ev.detail = self.McPrivacy.redactLogText(ev.detail);
  }
  return ev;
}

function pushLog(line) {
  redactLogLine(line);
  logRing.push(line);
  if (logRing.length > LOG_CAP) logRing = logRing.slice(-LOG_CAP);
  broadcast({ type: "log-line", line });
  _persistDiag();
}

// Log a line originating in the extension itself (connect state, user actions).
function mclog(level, msg) {
  const line = { ts: Date.now(), level: level || "info", src: "ext", msg: String(msg) };
  pushLog(line);
  dlog("[ext/" + line.level + "]", msg);
}

function recordEvent(ev) {
  if (!ev) return;
  redactEventDetail(ev);
  updateEvents.push(ev);
  if (updateEvents.length > EVENT_CAP) updateEvents = updateEvents.slice(-EVENT_CAP);
  broadcast({ type: "update-event", event: ev });
  _persistDiag();
}

function saveSettings(next) {
  settings = Object.assign({}, DEFAULT_SETTINGS, next);
  return api.storage.local.set({ settings });
}

// The H.265 conversion spec sent to the helper with a save, or null when off.
function convertSpec() {
  const c = settings.convertCodec;
  if (c !== "h265" && c !== "av1") return null;
  return { codec: c, quality: settings.convertQuality || "visually-lossless", encoder: settings.convertEncoder || "auto" };
}

// tabId -> Map(url -> mediaItem)
const mediaByTab = new Map();
// Raw webRequest evidence is kept off the enumerable legacy item until the
// existing enrichment path has proved that the candidate is usable media.
const liveNetworkEvidence = new WeakMap();
// Tabs with controller-owned rows may have no remaining legacy map entry.
const liveControllerTabs = new Set();
const liveControllerMediaIds = new Map();
const livePromotedKeys = new Map();
// tabId -> canonical direct source key -> the set of claimants for that
// source. A DOM claimant is the reporting frame's frameId; NETWORK_CLAIM
// stands for the network lane, which is not frame-attributable.
const liveDirectSourceKeys = new Map();
// The network lane's claimant. content_scripts runs in all_frames, so a DOM
// claim is only ever reused by the frame that made it — otherwise an ad iframe
// that reports the top page's media URL first would name the row the user then
// sees for the honest video.
const NETWORK_CLAIM = null;
// tabId -> canonical direct source key -> the opaque media ID that owns it.
// Late evidence for an owned source enriches that row instead of minting a
// second one. Session-only; cleared with the rest of a tab's ownership.
const liveDirectMediaOwners = new Map();
// tabId -> opaque media ID -> the canonical direct source key that DOM-lane row
// was minted for. Read only by the render pass, to recognise a remounted frame's
// repeat of one file. Network rows are absent by design: they carry mirrors, and
// a shared mirror does not make two rows the same clip.
const liveDirectRowSources = new Map();
// opaque media ID -> frozen { sizeBytes, sizeConfidence }. Never holds URLs,
// headers, or any other transport evidence.
const liveSizeMetadata = new Map();
// tabId -> { referer, origin, userAgent, cookieUrl, pageTitle, ogTitle }
const tabContext = new Map();
// tabId -> JPEG data URL of the playing video (from content script)
const tabThumbs = new Map();

// Strip unread-count prefixes like "(3) " that chat/stream tabs accumulate.
function cleanTitle(s) {
  return String(s || "").replace(/^\(\d+\)\s*/, "").trim();
}

// Best display/filename title known for a tab.
function tabTitle(tabId) {
  const ctx = tabContext.get(tabId) || {};
  return cleanTitle(ctx.ogTitle || ctx.pageTitle);
}
// Active downloads: id -> { status, progress, ... }
const activeDownloads = new Map();
const pgetFallback = new Map();   // pget id -> { item, finalName } for the browser fallback
let downloadCounter = 0;

// Recordings that have been stopped but not yet saved. The captured bytes live
// here in memory (our "temp cache") until the user clicks Save; if the source
// tab is closed first, the entry is dropped and the recording is discarded.
// id -> { tabId, base, files: [{bytes, mime, ext, suffix}], mergeCmd }
const pendingSaves = new Map();

// reqId -> sendResponse, for the settings-page "Browse folder" round trip.
// requestId -> { respond, timer }. Every request settles exactly once: on a
// terminal native frame, on the timeout, or when the helper disconnects.
const pendingFolderPicks = new Map();
const FOLDER_PICK_TIMEOUT_MS = 180000;

// Maps one native folder frame to the extension-facing response. A frame for an
// unknown or already-settled request is inert, so a late selection after a
// timeout can never revive a resolved picker.
function finishFolderPick(requestId, nativeFrame) {
  const pending = pendingFolderPicks.get(requestId);
  if (!pending) return;
  pendingFolderPicks.delete(requestId);
  if (pending.timer !== null) { try { clearTimeout(pending.timer); } catch (e) {} }
  let response;
  const status = nativeFrame && nativeFrame.status;
  if (status === "selected") {
    response = typeof nativeFrame.directory === "string" && nativeFrame.directory
      ? { ok: true, status: "selected", dir: nativeFrame.directory }
      : { ok: false, error: "folder_picker_failed" };
  } else if (status === "cancelled") {
    response = { ok: true, status: "cancelled" };
  } else if (status === "error") {
    response = { ok: false, error: "folder_picker_failed" };
  } else if (status === "timeout") {
    response = { ok: false, error: "folder_picker_timeout" };
  } else if (nativeFrame && typeof nativeFrame.dir === "string") {
    // Legacy frame: a nonempty dir meant selected, an empty one meant cancelled.
    response = nativeFrame.dir
      ? { ok: true, status: "selected", dir: nativeFrame.dir }
      : { ok: true, status: "cancelled" };
  } else {
    response = { ok: false, error: "folder_picker_failed" };
  }
  try { pending.respond(response); } catch (e) {}
}

function failAllFolderPicks() {
  for (const requestId of Array.from(pendingFolderPicks.keys())) {
    finishFolderPick(requestId, { status: "error" });
  }
}

// ---- Native helper (ffmpeg via native messaging) ----
// When the companion host is installed, recording is handed off to it: ffmpeg
// records live HLS to a temp file, muxes the paired audio, and finalizes on
// Stop. Save moves the temp file to Downloads; Discard/tab-close deletes it.
const NATIVE_HOST = "com.mediacatcher.host";
// Where regular-Firefox users get the native helper. The installer asset keeps the
// same filename every release, so "latest/download/<name>" always points at the newest.
const HELPER_INSTALLER_URL = "https://github.com/g9xdev/mCatcher/releases/latest/download/MediaCatcherHostSetup.exe";
const HELPER_SETUP_PAGE = "setup/setup.html";
const RELEASES_PAGE = "https://github.com/g9xdev/mCatcher/releases/latest";
let nativePort = null;
let nativeReady = false;          // true once the host confirms ffmpeg is available
let nativeInfo = null;
// "ready" (green) | "no-ffmpeg" (amber) | "connecting" | "disconnected" (gray)
let nativeState = "disconnected";
let nativeError = null;
// The helper exits with Firefox, can be killed, and is replaced by every host
// update, so a dropped port is routine rather than proof it is uninstalled.
// Nothing else reconnects — connectNative runs only at extension startup or on
// an explicit re-check — so one drop used to disable the helper for the whole
// session. `handshook` gates automatic re-dial on having actually reached a
// live helper. A single immediate re-dial covered a helper replaced by an
// update, but not one that is slow to come back. A bounded backoff replaces
// it: four growing waits, then stop — still bounded, so a helper that is
// truly gone cannot spin. An explicit recheck-helper resets the budget, and
// so does a pong - but only one from a connection that lasted (see
// HELPER_REDIAL_RESET_MS), or the bound would be per-outage rather than per
// helper.
let nativeHandshook = false;      // a pong has been seen on some connection
// The heartbeat below sends the same {cmd:"ping"} the connect path does, so the
// host answers EVERY beat with a full pong. Pong is therefore no longer a
// per-connection event, and the connection-time work keyed off it (announcing
// the helper, arming the host's folder watch, asking GitHub about updates) was
// re-running every 30s: a watcher thread and a directory handle leaked per beat
// (stop_watch only sets a flag the parked ReadDirectoryChangesW never re-reads),
// and the release API took 120 hits an hour against a 60/hour budget and a
// designed 6-hour interval. This says "the current connection has already been
// handshaken"; it is reset where a new port is assigned, so the first pong of
// every connection still does the work, exactly once.
let nativeHandshakeApplied = false;
const HELPER_REDIAL_MS = [1000, 4000, 15000, 60000];
let nativeRedialAttempt = 0;
let nativeRedialTimer = null;
// Restoring the budget on any pong made the bound per-outage rather than
// per-helper: a helper that answers the connect ping and then dies gets a
// full budget every cycle, so connect → pong → disconnect → 1000ms →
// connect → … runs at about 1 Hz for the whole browser session, never
// reaching a terminal state and rotating the 500-line persisted log ring in
// roughly four minutes. Only a connection that proved USEFUL earns the
// budget back. Pongs come only in answer to a ping, and the only ping sent
// long after the port was assigned is a heartbeat beat — so requiring the
// connection to have outlived one full beat interval means "this connection
// answered a beat", not "this connection said hello once". A genuinely
// healthy helper clears that in its first 30 seconds; a flapper never does.
const HELPER_REDIAL_RESET_MS = HELPER_PING_MS;
let nativePortSince = 0;         // Date.now() when the live port was assigned

function setNativeState(state, error) {
  nativeState = state;
  nativeError = error || null;
  nativeReady = state === "ready";
  broadcast({ type: "helper-status", helper: helperStatus() });
}

function helperStatus() {
  return {
    state: nativeState,
    ready: nativeReady,
    ffmpegPath: nativeInfo ? nativeInfo.ffmpegPath : "",
    version: nativeInfo ? nativeInfo.version : "",
    ytdlp: nativeInfo ? !!nativeInfo.ytdlp : false,
    ytdlpVersion: nativeInfo ? (nativeInfo.ytdlpVersion || "") : "",
    node: nativeInfo ? !!nativeInfo.node : false,
    pot: nativeInfo ? !!nativeInfo.pot : false,
    // Whether the helper found BadApple installed. The popup shows the
    // "Open in BadApple" action only when this is true, so a machine without
    // it never gets a button that could only fail.
    badapple: nativeInfo ? !!nativeInfo.badapple : false,
    error: nativeError,
  };
}

// YouTube (and any yt-dlp-supported site): hand the canonical URL to the native
// helper, which runs yt-dlp (best video+audio, merged) with the PO-token provider
// and Firefox cookies. Progress/done/error arrive as ytdl-* native messages.
// Statuses that mean a job still owns its output path.
const YT_IN_FLIGHT = new Set(["downloading", "converting"]);

async function downloadYouTube(item, tabId, filename, opts) {
  opts = opts || {};
  // One yt-dlp per URL. A second click used to mint a fresh id and start a
  // competing process writing the SAME output template: the two then fought
  // over one .part file ("WinError 32: used by another process"), one wedged,
  // and cancelling a row killed only its own job while the survivors kept
  // reporting progress — which read as "cancel doesn't work, it keeps
  // re-adding". Terminal rows (done/error/cancelled) are not in flight, so a
  // deliberate retry still works.
  for (const existing of activeDownloads.values()) {
    if (existing.kind === "youtube" && existing.url === item.url &&
        YT_IN_FLIGHT.has(existing.status)) {
      mclog("info", "yt-dlp: already downloading " + item.url + " — ignoring duplicate request");
      broadcast({ type: "download-update", download: existing });   // resurface the live row
      return;
    }
  }
  const id = ++downloadCounter;
  const dl = { id, url: item.url, name: sanitizeFilename(filename || item.name || "YouTube video"),
               kind: "youtube", status: "downloading", live: true, tabId,
               quality: opts.audioOnly ? { label: "Audio" } : (opts.height ? { height: opts.height } : null),
               thumb: item.thumb || null,
               progress: { done: 0, total: 100, unit: "pct", live: true, stage: "resolving", note: "Preparing" } };
  activeDownloads.set(id, dl);
  broadcast({ type: "download-update", download: dl });
  if (!nativeReady || !nativePort) {
    dl.status = "error";
    dl.error = "YouTube needs the native helper (yt-dlp). Install/enable it, then retry.";
    broadcast({ type: "download-update", download: dl });
    promptInstallHelper();
    return;
  }
  // Format selector from the quality picker; blank → helper's default (best).
  let format = "";
  if (opts.audioOnly) format = "ba/bestaudio";
  else if (opts.height) format = "bv*[height<=" + opts.height + "]+ba/b[height<=" + opts.height + "]";
  try {
    nativePort.postMessage({ cmd: "ytdl", id, url: item.url, dir: settings.saveFolder || "", format });
    mclog("info", "yt-dlp: requested " + item.url + (format ? " [" + format + "]" : ""));
  } catch (e) {
    dl.status = "error"; dl.error = "Couldn't reach the helper.";
    broadcast({ type: "download-update", download: dl });
  }
}

function connectNative() {
  if (nativePort) return;
  setNativeState("connecting");
  mclog("info", "connecting to the native helper…");
  let port;
  try {
    port = api.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    dlog("native connect failed", e.message || e);
    setNativeState("disconnected", e.message || String(e));
    return;
  }
  nativePort = port;
  nativePortSince = Date.now();
  // Re-arm here rather than in the disconnect handler: this is the sole
  // assignment of a new port, so every reconnect route passes through it (the
  // re-dial timer and recheck-helper both land here), and the `if (nativePort)
  // return;` above keeps a no-op call from clearing a live connection's guard.
  nativeHandshakeApplied = false;
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener(function nativeDisconnect() {
    // runtime.lastError is only readable inside the event itself, so read it
    // here and hand it to the shared teardown.
    dropNativePort(port, api.runtime.lastError && api.runtime.lastError.message);
  });
  try {
    port.postMessage({ cmd: "ping" });
  } catch (e) {
    // The port and both listeners above are already live; a failed initial
    // ping (the helper is already gone, or about to be) is not the same as
    // "nothing is connected" — leave nativePort and state alone and let the
    // real onDisconnect event above drive cleanup and the re-dial backoff,
    // exactly like any other disconnect. But say so somewhere the user can
    // see: dlog alone is DEBUG-gated, and a live port that never manages to
    // send would otherwise park the UI on "connecting" with no visible sign
    // anything went wrong while waiting for the real disconnect to arrive.
    mclog("warn", "native ping failed: " + (e.message || String(e)));
    dlog("native ping failed", e.message || e);
  }
  // That connect ping is the first outstanding one. The heartbeat is armed
  // here, at the one site that assigns a port, rather than in the pong
  // handler: a port that connects and never answers its FIRST ping used to
  // arm no heartbeat at all and park the UI on "connecting" with no deadline
  // for the rest of the session. Same counter, same teardown, no second
  // mechanism.
  helperMissedBeats = 1;
  if (helperPingTimer === null && typeof setInterval === "function") {
    helperPingTimer = setInterval(helperHeartbeat, HELPER_PING_MS);
  }
}

// Tear one native port down: the single cleanup-and-re-dial path, reached by
// the port's own onDisconnect. `err` is the reason to report.
//
// Nothing else calls this, and in particular the heartbeat does not: EOF is
// destructive at the host end. Its read loop runs cleanup_file_sinks() in a
// finally, which removes every live sink's .part file, and it has no handle on
// the yt-dlp/ffmpeg/deno children it spawned, so they are orphaned still
// writing. Before automatic re-dial existed, EOF only ever arrived because the
// browser had gone away and the user was done; a helper that is merely slow
// must not be handed the same ending. See helperHeartbeat.
//
// A disconnect schedules a re-dial instead of running one inline, so the
// listener that reconnects outlives the event that queued it — a newer
// connection's listener can already be live when an older one's real
// disconnect arrives. Compare against the exact port the caller holds, not
// whether the mutable nativePort variable currently holds any value: the
// connect ping can fail while that same port and its listeners are still very
// much live (see its try/catch), so "nativePort is null" does not reliably
// mean "port is gone" — only "nativePort points at a different port" does.
// That check is also what makes this idempotent, so a real disconnect arriving
// after a heartbeat teardown of the same port is a no-op.
function dropNativePort(port, err) {
  if (nativePort !== port) return;
  const controller = liveController;
  if (controller) {
    Promise.resolve().then(() => controller.helperDisconnected()).catch((e) => {
      mclog("warn", "policy disconnect: " + (e && e.message ? e.message : String(e)));
    });
  }
  dlog("native host disconnected", err || "");
  mclog("warn", "native helper disconnected" + (err ? ": " + err : ""));
  nativePort = null; nativeInfo = null;
  if (helperPingTimer !== null) {
    clearInterval(helperPingTimer);
    helperPingTimer = null;
  }
  // No helper means no dialog will ever answer; settle every waiter now.
  failAllFolderPicks();
  if (nativeHandshook && nativeRedialAttempt < HELPER_REDIAL_MS.length) {
    const wait = HELPER_REDIAL_MS[nativeRedialAttempt];
    nativeRedialAttempt += 1;
    // Say so now, not when the timer fires. nativePort is already null above,
    // so downloadYouTube refuses for the whole wait — up to 60s on the last
    // backoff step — and without this the pill stayed green the entire time:
    // "Helper ready" and "YouTube needs the native helper" at once.
    setNativeState("connecting", err || "Helper disconnected — reconnecting…");
    mclog("info", "native helper disconnected — reconnecting in " + wait + "ms…");
    if (nativeRedialTimer !== null) clearTimeout(nativeRedialTimer);
    nativeRedialTimer = setTimeout(function nativeRedial() {
      nativeRedialTimer = null;
      connectNative();        // sets state to "connecting" and re-pings
    }, wait);
  } else {
    // Only claim it is missing when we never reached a live helper; a drop
    // after a good handshake is a disconnect, and saying otherwise sent
    // people to reinstall software that was already there.
    setNativeState("disconnected", err ||
      (nativeHandshook ? "Helper disconnected." : "Helper not installed."));
  }
  // The host owned the cast session and its status poller — without it the
  // session is gone; don't leave the popup showing a live transport forever.
  if (castState.state !== "idle") {
    castState = { state: "idle" };
    broadcast({ type: "cast-update", cast: castState, error: "Casting ended — the helper disconnected." });
  }
  for (const [id, res] of pendingCastDiscover) { pendingCastDiscover.delete(id); res(null); }
}

// The user's manual re-check, from the popup badge or the options row.
//
// Re-pinging a port the heartbeat has already reported unresponsive is
// pointless — that is precisely what the beats have been doing — and with the
// port left open nothing else would ever re-dial it, so before this a wedged
// helper could not be recovered without restarting Firefox. An explicit
// re-check therefore drops that port and dials again.
//
// This is the one place allowed to do that, and only because a person asked:
// the drop ends in-flight work (dropNativePort fails the running jobs to
// needs_user, and the host deletes every live sink's .part on EOF), which is
// exactly why the heartbeat must never reach for it on its own. The pill says
// so before the click.
function recheckHelper() {
  nativeRedialAttempt = 0;
  if (nativeRedialTimer !== null) { clearTimeout(nativeRedialTimer); nativeRedialTimer = null; }
  if (nativePort && helperMissedBeats >= HELPER_MISSED_BEATS_MAX) {
    const port = nativePort;
    mclog("info", "re-check on a helper that stopped answering — reconnecting");
    try {
      if (typeof port.disconnect === "function") port.disconnect();
    } catch (e) {
      dlog("native disconnect failed", e.message || e);
    }
    dropNativePort(port, "Helper was not answering — reconnected at your request.");
    // dropNativePort arms the backoff timer an unplanned drop needs. This drop
    // was planned and the user is waiting, so reconnect now, with a full
    // budget and no stray timer left behind.
    if (nativeRedialTimer !== null) { clearTimeout(nativeRedialTimer); nativeRedialTimer = null; }
    nativeRedialAttempt = 0;
    connectNative();
    return;
  }
  if (nativePort) { try { nativePort.postMessage({ cmd: "ping" }); } catch (e) {} }
  else connectNative();
}

// One heartbeat beat. A host that wedges with the pipe still open answers
// nothing, and with no missed-beat counter the pill stayed green and
// nativeReady true while every job posted into it was swallowed forever — the
// UI claimed a helper that was silently eating work.
//
// What an unanswered beat proves is exactly that: no answer. It does not say
// whether the host is dead, or merely busy on its own read loop — this side of
// the port cannot tell those apart, and which handlers the host happens to run
// inline is its business and changes release to release, so nothing here may
// depend on that. Silence therefore means "not usable right now", never
// "dead", and the response is to SAY so rather than to disconnect: EOF makes
// the host delete every live sink's .part and orphan its children (see
// dropNativePort), which would turn a slow helper into lost downloads.
//
// Reporting is cheap and reversible, so the threshold can be modest: the
// fourth consecutive ping with no answer — about two minutes of silence — is
// enough to stop calling the helper ready, and the pill goes back to green by
// itself the moment a pong arrives (see the pong handler). The beats keep
// going out afterwards, because a pong is only ever an answer to one.
function helperHeartbeat() {
  const port = nativePort;
  if (!port) return;
  helperMissedBeats += 1;
  if (helperMissedBeats === HELPER_MISSED_BEATS_MAX) {
    // Once per silent stretch, not once per beat: this writes to the persisted
    // log ring and broadcasts to every open surface.
    mclog("warn", "native helper has not answered " + helperMissedBeats +
      " pings — reporting it unusable, connection left open");
    // "connecting" is the existing state for a port that is live but not usable
    // yet and may become usable without the user doing anything — which is
    // exactly this. It makes nativeReady false, so no new job is posted into a
    // helper that is not answering, and both the popup badge and the options
    // row already have copy for it. "disconnected" would be a lie that offers
    // to reinstall a helper that is running, and "no-ffmpeg" still counts as
    // usable.
    setNativeState("connecting", nativeHandshakeApplied
      ? "Helper has stopped answering — still connected, waiting for it. " +
        "Re-check to reconnect; anything still transferring is lost if you do."
      : "Helper has not answered yet — still connected, waiting for it. " +
        "Re-check to reconnect.");
  }
  try {
    port.postMessage({ cmd: "ping" });
  } catch (err) {
    mclog("warn", "heartbeat: " + String((err && err.message) || err));
  }
}

function onNativeMessage(msg) {
  const controller = liveController;
  if (!controller) {
    onLegacyNativeMessage(msg);
    return;
  }
  Promise.resolve().then(() => controller.handleNativeMessage(msg)).then((handled) => {
    if (handled !== true) onLegacyNativeMessage(msg);
  }).catch((e) => {
    mclog("warn", "policy native frame: " + (e && e.message ? e.message : String(e)));
  });
}

function onLegacyNativeMessage(msg) {
  if (!msg) return;
  if (msg.type === "log") {
    // a structured line from the host or guardian → the live console
    pushLog({ ts: msg.ts || Date.now(), level: msg.level || "info",
      src: msg.src || "host", msg: String(msg.msg == null ? "" : msg.msg) });
    return;
  }
  if (msg.type === "update-event") {
    recordEvent(msg.event);
    return;
  }
  if (msg.type === "report") {
    const res = pendingReports.get(msg.reqId);
    if (res) { pendingReports.delete(msg.reqId); res(msg); }
    return;
  }
  if (msg.type === "probe-result") {
    // The per-check narration already arrived as {type:"log", src:"probe"} lines;
    // this is the single summary the card renders from.
    const res = pendingProbes.get(msg.reqId);
    if (res) { pendingProbes.delete(msg.reqId); res(msg); }
    return;
  }
  if (msg.type === "ytmeta") {
    const res = pendingYtMeta.get(msg.reqId);
    if (res) { pendingYtMeta.delete(msg.reqId); res(msg); }
    return;
  }
  if (msg.type === "cast-devices") {
    lastCastDevices = msg.devices || [];
    const res = pendingCastDiscover.get(msg.reqId);
    if (res) { pendingCastDiscover.delete(msg.reqId); res(msg.devices || []); }
    return;
  }
  if (msg.type === "cast-devices-update") {
    // Unsolicited push after a warm rescan (final:true = scan complete; error rides
    // along when the rescan failed). Keep the retained list fresh and let any open
    // picker re-render live.
    lastCastDevices = msg.devices || [];
    broadcast({ type: "cast-devices-update", devices: msg.devices || [], final: msg.final, error: msg.error });
    return;
  }
  if (msg.type === "cast-status") {
    castState = msg.state === "idle" ? { state: "idle" } : {
      state: msg.state || "playing",
      id: msg.id || castState.id,
      device: msg.device || castState.device || "",
      title: msg.title || castState.title || "",
      position: msg.position || 0,
      duration: msg.duration || 0,
      protocol: msg.protocol || castState.protocol || "dlna",
    };
    broadcast({ type: "cast-update", cast: castState });
    return;
  }
  if (msg.type === "cast-pair") {
    broadcast({ type: "cast-pair", id: msg.id, needsPin: msg.needsPin });
    return;
  }
  if (msg.type === "cast-paired") {
    broadcast({ type: "cast-paired", id: msg.id, ok: msg.ok });
    return;
  }
  if (msg.type === "cast-error") {
    mclog("warn", "cast: " + (msg.error || "unknown error"));
    // A failed discover carries its reqId — settle the waiting promise so the
    // popup's picker shows the error instead of spinning until the timeout.
    if (msg.reqId && pendingCastDiscover.has(msg.reqId)) {
      const res = pendingCastDiscover.get(msg.reqId);
      pendingCastDiscover.delete(msg.reqId);
      res(null);
      return;
    }
    castState = { state: "idle" };
    broadcast({ type: "cast-update", cast: castState, error: msg.error || "Casting failed." });
    return;
  }
  if (msg.type === "pong") {
    nativeInfo = msg;
    // A pong with no live nativePort is not a connection to trust — the
    // same reasoning the re-dial cancellation below relies on. Without this,
    // a stray/late pong could mark the helper "ready" (and broadcast that)
    // with nothing actually connected, which is worse than the state it
    // would otherwise be left in: at least "connecting"/"disconnected" is
    // honest about there being no live port.
    if (!nativePort) return;
    // A live helper answered: remember that. The re-dial budget comes back
    // only once this connection has outlived a full heartbeat interval —
    // answering the connect ping proves a process started, not that it is
    // worth reconnecting to (see HELPER_REDIAL_RESET_MS). A backoff timer can
    // still be pending here if this pong arrived on a connection made outside
    // that timer (e.g. a manual recheck-helper beat it to a live helper) —
    // cancel it, since the wait it was counting down is now moot and letting
    // it fire later would just be a stray, if harmless, no-op reconnect.
    nativeHandshook = true;
    // An answered beat is never a missed one, however many have gone by. This
    // is also the whole recovery path for a helper the heartbeat has reported
    // unusable: the setNativeState below runs on every pong, so a late answer
    // puts the pill back to green with nothing asked of the user.
    helperMissedBeats = 0;
    if (Date.now() - nativePortSince >= HELPER_REDIAL_RESET_MS) nativeRedialAttempt = 0;
    if (nativeRedialTimer !== null) {
      clearTimeout(nativeRedialTimer);
      nativeRedialTimer = null;
    }
    setNativeState(msg.ffmpeg ? "ready" : "no-ffmpeg",
      msg.ffmpeg ? null : "Helper is installed but ffmpeg was not found.");
    dlog("native helper", msg.ffmpeg ? "ready (ffmpeg ok)" : "connected but ffmpeg missing", msg.ffmpegPath || "");
    // Connection-time work, not per-pong work: the heartbeat's ping draws a
    // pong every 30s, and repeating any of this on a beat leaks host watcher
    // threads, burns the GitHub rate limit, and floods the persisted log ring.
    // The dlog above stays unconditional — it is DEBUG-gated and costs nothing.
    if (!nativeHandshakeApplied) {
      nativeHandshakeApplied = true;
      mclog("info", "helper ready — v" + (msg.version || "?") + (msg.ffmpeg ? "" : " · ffmpeg MISSING"));
      if (settings.autoUpdate && nativePort) {
        nativePort.postMessage({ cmd: "watch", enable: true,
          extDir: settings.updateExtDir || "", zipDir: settings.updateZipDir || "" });
        nativePort.postMessage({ cmd: "checkGithub", auto: true, extVersion: api.runtime.getManifest().version,
          extDir: settings.updateExtDir || "", zipDir: settings.updateZipDir || "" });
      }
    }
    return;
  }
  if (msg.type === "folder") {
    const requestId = msg.requestId !== undefined ? msg.requestId : msg.reqId;
    finishFolderPick(requestId, msg);
    return;
  }
  if (msg.type === "update-result") {
    dlog("update result", msg);
    broadcast({ type: "update-result", result: msg });   // options page shows it
    return;
  }
  if (msg.type === "github-update") {
    dlog("github update", msg);
    broadcast({ type: "github-update", result: msg });    // options page shows it
    if (msg.newer && Array.isArray(msg.downloaded) && msg.downloaded.length && api.notifications) {
      api.notifications.create({ type: "basic", iconUrl: api.runtime.getURL("icons/icon-96.png"),
        title: "Media Catcher " + (msg.latest ? "v" + msg.latest : "update"),
        message: "Downloading the latest release…" });
    }
    return;
  }
  if (msg.type === "ext-update-available") {
    dlog("extension update available", msg.version);
    broadcast({ type: "ext-update-available", version: msg.version });
    if (api.notifications) {
      const id = "mc-ext-update";
      // Point the click at the signed .xpi (GitHub serves it as application/x-xpinstall),
      // so Firefox shows its native "Add Media Catcher?" install prompt — no GitHub detour.
      // (Firefox also auto-updates the add-on via update_url on its own schedule anyway.)
      const xpi = msg.version
        ? "https://github.com/g9xdev/mCatcher/releases/download/v" + msg.version + "/media_catcher-" + msg.version + ".xpi"
        : RELEASES_PAGE;
      try {
        api.notifications.create(id, { type: "basic", iconUrl: api.runtime.getURL("icons/icon-96.png"),
          title: "Media Catcher " + (msg.version ? "v" + msg.version : "update") + " available",
          message: msg.version ? "Click to install it — Firefox will ask you to confirm."
                               : "A newer version is ready. Click to open the download." });
        notifyActions.set(id, { url: xpi });
      } catch (e) {}
    }
    return;
  }
  if (msg.type === "pget-progress") {
    let d = activeDownloads.get(msg.id);
    if (!d) {                                   // first progress -> create the tracked row
      const fb = pgetFallback.get(msg.id);
      if (!fb) return;
      d = { id: msg.id, name: fb.finalName, kind: "direct", live: true, status: "downloading", url: fb.item.url };
      activeDownloads.set(msg.id, d);
    }
    d.status = "downloading"; d.live = true;
    d.progress = { done: msg.bytes || 0, total: msg.total || 0, unit: "bytes", live: false };
    broadcast({ type: "download-update", download: d });
    return;
  }
  if (msg.type === "pget-done") {
    pgetFallback.delete(msg.id);
    const d = activeDownloads.get(msg.id);
    if (d) {
      d.status = "done"; d.live = true; d.savedPath = msg.file || ""; d.convert = msg.convert || null;
      d.progress = { done: msg.bytes || 0, total: msg.bytes || 0, unit: "bytes", live: false };
      broadcast({ type: "download-update", download: d });
      const extra = msg.convert ? convertSummary(msg.convert) : fmtBytes(msg.bytes || 0);
      notifyDone(d.name, extra, msg.file ? { path: msg.file } : null);
    }
    return;
  }
  if (msg.type === "pget-fallback") {
    dlog("pget fallback -> browser download", msg.reason || "");
    const fb = pgetFallback.get(msg.id);
    pgetFallback.delete(msg.id);
    activeDownloads.delete(msg.id);
    if (fb) { try { api.downloads.download({ url: fb.item.url, filename: fb.finalName, saveAs: true }); } catch (e) {} }
    return;
  }
  const dl = activeDownloads.get(msg.id);
  // A host error that names no live row. `open`, `reveal` and `badapple` are
  // sent without an id, so a refusal from any of them — a suffix outside
  // MEDIA_EXTS, a file that has since been moved, BadApple not installed —
  // arrives with nothing to attach to and fell off here into silence. The log
  // console is somewhere the user can actually read it.
  if (!dl && msg.type === "error") {
    pushLog({ ts: Date.now(), level: "error", src: "host",
      msg: String(msg.error == null ? "Helper error" : msg.error) });
    return;
  }
  if (!dl) return;
  if (msg.type === "started") {
    dl.status = "recording";
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "progress") {
    const secs = msg.seconds || 0;
    const kbps = secs > 0 ? Math.round((msg.bytes * 8) / secs / 1000) : 0;
    dl.progress = { done: 0, total: 0, live: true, bytes: msg.bytes || 0, duration: secs, kbps };
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "snapshot") {
    // A "save now" checkpoint landed on disk; recording continues.
    dl.snapshots = (dl.snapshots || 0) + 1;
    dl.lastSnapshot = { file: msg.file, bytes: msg.bytes || 0, seconds: msg.seconds || 0 };
    broadcast({ type: "download-update", download: dl });
    notifyDone((dl.name || "recording") + " (partial)", "Safety copy saved — still recording.", msg.file ? { path: msg.file } : null);
  } else if (msg.type === "stopped") {
    dl.status = "stopped";                       // temp file on disk, awaiting Save
    dl.recorded = { bytes: msg.bytes || 0, duration: msg.seconds || 0 };
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "converting") {
    // The saved/downloaded file is being re-encoded (H.265 or AV1); the original is
    // kept only if the re-encode turns out not smaller, so it's never larger.
    dl.status = "converting";
    dl.convertCodec = msg.codec || "h265";
    dl.convertPct = null;                       // indeterminate until first progress tick
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "convert-progress") {
    dl.status = "converting";
    if (msg.codec) dl.convertCodec = msg.codec;
    if (typeof msg.pct === "number") dl.convertPct = msg.pct;
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "ytdl-progress") {
    // The cancel is still travelling to the helper while the helper's frames
    // travel back, so one written before it saw the cancel arrives after this
    // row was settled. Dropping it is what makes the cancel stick: a wedge the
    // helper cannot break — one with no live child to kill — sends no terminal
    // frame afterwards to correct a row this put back on "downloading", and
    // while the row reads as in flight YT_IN_FLIGHT refuses to start that URL
    // again. ytdl-done is deliberately NOT dropped the same way: it names a
    // file already on disk.
    if (dl.status === "cancelled") return;
    dl.status = "downloading";
    const pct = typeof msg.pct === "number" ? Math.max(0, Math.min(100, Math.round(msg.pct)))
                                            : (dl.progress ? dl.progress.done : 0);
    // `total` is the percent DENOMINATOR — the bar divides by it — so the real
    // byte total rides beside it as totalBytes rather than overloading it. The
    // helper stops reporting a size once it has nothing new to say (unknown
    // length, or the merge), so the last one it gave is carried forward: it is
    // still the size of the file being written.
    const totalBytes = msg.total > 0 ? msg.total
                                     : ((dl.progress && dl.progress.totalBytes) || 0);
    dl.progress = { done: pct, total: 100, unit: "pct", totalBytes, bps: msg.bps || 0,
                    stage: msg.stage || "downloading", note: msg.note || "", live: true };
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "ytdl-done") {
    dl.status = "done"; dl.live = true; dl.savedPath = msg.file || "";
    // The size of the file on disk, kept on the row and not only in the
    // notification: progress stops here, so this is all a finished row has
    // left to state its size from. `recorded` is where both panes already
    // look for a produced file's size.
    if (msg.bytes > 0) dl.recorded = { bytes: msg.bytes };
    dl.progress = { done: 100, total: 100, unit: "pct",
                    totalBytes: msg.bytes > 0 ? msg.bytes
                                              : ((dl.progress && dl.progress.totalBytes) || 0) };
    broadcast({ type: "download-update", download: dl });
    addHistory({ name: dl.name || "YouTube", kind: "youtube", ts: Date.now() });
    notifyDone(dl.name || "YouTube video", fmtBytes(msg.bytes || 0), msg.file ? { path: msg.file } : null);
    setTimeout(() => activeDownloads.delete(dl.id), DONE_RETAIN_MS);
  } else if (msg.type === "ytdl-error") {
    // Killing yt-dlp makes it exit non-zero, so a user cancel arrives here as a
    // failure. Settle the row as "Cancelled" rather than a red error — trust the
    // helper's own verdict as well as our local flag.
    if (msg.reason === "cancelled" || dl.status === "cancelled") {
      dl.status = "cancelled";
      broadcast({ type: "download-update", download: dl });
      return;
    }
    dl.status = "error"; dl.error = msg.error || "YouTube download failed"; dl.errReason = msg.reason || "";
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "saved") {
    dl.status = "done"; dl.savedPath = msg.file; dl.convert = msg.convert || null;
    // The size of the file that actually landed. `recorded` already carries
    // what the recorder captured, but a convert re-encodes between there and
    // here, so the finished row states the size of the file on disk rather
    // than the size of the temp it came from.
    if (msg.bytes > 0) dl.recorded = Object.assign({}, dl.recorded, { bytes: msg.bytes });
    broadcast({ type: "download-update", download: dl });
    addHistory({ name: dl.name || "recording", kind: "hls-live", ts: Date.now() });
    const extra = msg.convert ? convertSummary(msg.convert) : (msg.file || null);
    notifyDone(dl.name || "recording", extra, msg.file ? { path: msg.file } : null);
    setTimeout(() => activeDownloads.delete(dl.id), DONE_RETAIN_MS);
  } else if (msg.type === "save-cancelled") {
    dl.status = "stopped";   // user cancelled Save-As — keep it ready to save
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "discarded") {
    dl.status = "discarded";
    broadcast({ type: "download-update", download: dl });
    setTimeout(() => activeDownloads.delete(dl.id), 30000);
  } else if (msg.type === "error") {
    dl.status = "error"; dl.error = msg.error || "Helper error";
    broadcast({ type: "download-update", download: dl });
  }
}

// Reject C0, DEL and C1 controls in a value that becomes an HTTP header. Same
// rule as the message router's isSafeHttpContextString; this lane never enters
// the router, whose export surface is deliberately three functions wide.
function isSafeHttpContextString(v) {
  return typeof v === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
}

// A URL the helper may open. Mirrors the router's isAbsoluteHttpUrl, which
// gates the pget lanes: nonblank, trim-stable, control-free, absolute http(s)
// by both scheme text and parse.
function isAbsoluteHttpUrl(v) {
  if (typeof v !== "string" || v.trim().length === 0) return false;
  if (v.trim() !== v || !isSafeHttpContextString(v)) return false;
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const parsed = new URL(v);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (e) {
    return false;
  }
}

// The record lane is a raw postMessage — it never passes through the message
// router, so the router's URL gate never sees it. It needs one of its own more
// than the other lanes do: its URLs come from the body of a fetched manifest
// rather than from webRequest or a gated content script, and an absolute URI
// in a playlist resolves to itself, so a page can name any scheme it likes.
// ffmpeg opens file://host/share as a UNC path, which is an outbound SMB
// handshake carrying the user's NTLM credentials.
//
// Refusal throws: recordLiveHls's catch turns that into a failed row with a
// reason on it, which is what the user needs to see. Silently recording
// nothing, or dropping just the audio track, would leave the row waiting for
// a stream that is never coming.
function nativeRecord(dl, tabId, videoUrl, audioUrl) {
  const hdr = resolveHeaders(tabId);
  const video = mediaKey(videoUrl);              // drop stale _HLS_msn, keep session
  const audio = audioUrl ? mediaKey(audioUrl) : null;
  if (!isAbsoluteHttpUrl(video) || (audio !== null && !isAbsoluteHttpUrl(audio))) {
    throw new Error("Refused to record: the stream URL is not http(s).");
  }
  nativePort.postMessage({
    cmd: "record",
    id: dl.id,
    videoUrl: video,
    audioUrl: audio,
    // Page context becomes an ffmpeg -headers argument. The host gates control
    // characters too; a value that would fail there is dropped rather than
    // sent, and losing a Referer only costs the recording its page context.
    referer: isSafeHttpContextString(hdr.referer) ? hdr.referer : "",
    userAgent: isSafeHttpContextString(hdr.userAgent) ? hdr.userAgent : "",
    base: sanitizeFilename(dl.name || "recording"),
  });
}

// Requests we originate for segment/manifest fetching, tagged so the blocking
// header listener can rewrite Referer/Origin. token -> {referer, origin}
const taggedRequests = new Map();

// Eager HLS parsing so the popup can show qualities without a click.
const hlsCache = new Map();   // playlistUrl -> parsed result (bounded)
const enriching = new Set();  // playlistUrls currently being fetched/parsed
const childUrls = new Map();  // tabId -> Set(variant playlist URLs owned by a master)
const HLS_CACHE_MAX = 200;

function rememberParsed(url, parsed) {
  hlsCache.set(url, parsed);
  if (hlsCache.size > HLS_CACHE_MAX) {
    // Drop oldest inserted entry.
    hlsCache.delete(hlsCache.keys().next().value);
  }
}

// Child suppression matches by path (origin+pathname), ignoring query — a
// master lists variant URIs without the ?session=…&_HLS_msn=… params the player
// later adds, so a full-URL/key match would miss them.
function pathSig(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch (e) { return url; }
}
function isChild(tabId, url) {
  const set = childUrls.get(tabId);
  return !!(set && set.has(pathSig(url)));
}
function addChild(tabId, url) {
  const set = childUrls.get(tabId) || new Set();
  set.add(pathSig(url));
  childUrls.set(tabId, set);
}
// Drop any already-surfaced items that are now known to be children.
function purgeChildren(tabId) {
  const map = mediaByTab.get(tabId);
  const set = childUrls.get(tabId);
  if (!map || !set) return;
  let changed = false;
  for (const [k, it] of Array.from(map.entries())) {
    if (set.has(pathSig(it.url))) { map.delete(k); changed = true; }
  }
  if (changed) { updateBadge(tabId); broadcast({ type: "media-updated", tabId }); }
}

const DIRECT_EXT = /\.(mp4|m4v|webm|mov|mkv|flv|ogv|ogg|m4a|mp3|aac|wav)(\?|#|$)/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;
const DASH_EXT = /\.mpd(\?|#|$)/i;

const MEDIA_CONTENT_TYPES = [
  { re: /application\/(x-mpegurl|vnd\.apple\.mpegurl)/i, kind: "hls" },
  { re: /application\/dash\+xml/i, kind: "dash" },
  { re: /^video\//i, kind: "direct" },
  { re: /^audio\//i, kind: "direct" },
];

// Ignore tiny/keepalive/analytics noise.
const IGNORE_URL = /(\.(js|css|png|jpe?g|gif|webp|svg|woff2?|ttf|ico)(\?|#|$))|google-analytics|doubleclick|\/collect\?/i;

// HLS/DASH media segments — these are the *pieces* of a stream, not standalone
// downloadable files. A live stream emits one every ~2s, so surfacing them
// individually floods the list and hides the real playlist. Detect them by
// container extension, by common segment-naming patterns, and (below) by
// membership in a playlist we've parsed.
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|cmft|fmp4|dat)(\?|#|$)/i;
// Conservative name patterns — only tokens that virtually never appear in real
// video filenames. Words like "part"/"media"/"dash" are omitted on purpose (they
// collide with human names, e.g. "lecture-part1.mp4"); the content-type,
// extension, and playlist-directory checks already catch those real segments.
const SEGMENT_NAME = new RegExp(
  [
    "\\/init[^\\/]*\\.(mp4|m4s|cmf[vat])(\\?|#|$)",   // init.mp4 / init-stream0.m4s
    "\\/\\d+\\.(mp4|m4s|ts|aac)(\\?|#|$)",             // 1234.mp4  (all-numeric segment name)
    "(seg(ment)?|chunk|frag(ment)?)[-_]?\\d+",         // seg-12, chunk_0001, fragment5
    "\\/\\d{6,}[-_.]\\d+",                              // 1700000000-42  epoch-seq
  ].join("|"),
  "i"
);

// tabId -> Set(segment "directory" URL prefixes) learned from parsed playlists.
const segDirsByTab = new Map();

// tabId -> Map(stream directory -> freshest full audio-track playlist URL). The
// page's player fetches the real audio chunklist (correct id + session), so we
// stash it here to pair with the video during recording — deriving it by name
// fails when the CDN gives audio a different id than video.
const audioTrackByTab = new Map();

// origin + directory (exact) — video and its audio track share this.
function streamDir(url) {
  try { const u = new URL(url); return u.origin + u.pathname.replace(/[^/]*$/, ""); }
  catch (e) { return url; }
}
// Does this HLS URL name an audio track?
function isAudioUrl(url) {
  return swapTrack(url, "audio", "video") !== url;
}
function rememberAudioTrack(tabId, url) {
  const m = audioTrackByTab.get(tabId) || new Map();
  m.set(streamDir(url), url);   // keep freshest (has a current session token)
  audioTrackByTab.set(tabId, m);
}

function segmentDir(url) {
  const i = url.split(/[?#]/)[0].lastIndexOf("/");
  return i >= 0 ? url.slice(0, i + 1) : url;
}

// True if this URL is a stream segment rather than a standalone file.
function looksLikeSegment(tabId, url, contentType) {
  // MPEG-TS is a transport-stream segment container — never a standalone file.
  if (/video\/(mp2t|mpeg-?ts)/i.test(contentType || "")) return true;
  if (SEGMENT_EXT.test(url)) return true;
  if (SEGMENT_NAME.test(url)) return true;
  const dirs = segDirsByTab.get(tabId);
  if (dirs) {
    for (const d of dirs) if (url.startsWith(d)) return true;
  }
  return false;
}

// Learn a playlist's segment locations, then drop any segments we already
// surfaced as "direct" items before the manifest was understood.
function registerSegments(tabId, media) {
  const dirs = segDirsByTab.get(tabId) || new Set();
  const uris = [];
  if (media.map && media.map.uri) uris.push(media.map.uri);
  for (const s of media.segments) uris.push(s.uri);
  for (const u of uris) dirs.add(segmentDir(u));
  segDirsByTab.set(tabId, dirs);

  const map = mediaByTab.get(tabId);
  if (!map) return;
  let purged = false;
  const known = new Set(uris);
  for (const [url, item] of Array.from(map.entries())) {
    if (item.kind !== "direct") continue;
    if (known.has(url) || looksLikeSegment(tabId, url, item.contentType)) {
      map.delete(url);
      purged = true;
    }
  }
  if (purged) {
    updateBadge(tabId);
    broadcast({ type: "media-updated", tabId });
  }
}

function getHeader(headers, name) {
  if (!headers) return null;
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function classify(url, contentType) {
  if (contentType) {
    for (const c of MEDIA_CONTENT_TYPES) if (c.re.test(contentType)) return c.kind;
  }
  if (HLS_EXT.test(url)) return "hls";
  if (DASH_EXT.test(url)) return "dash";
  if (DIRECT_EXT.test(url)) return "direct";
  return null;
}

function shortName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return decodeURIComponent(last);
  } catch (e) {
    return url.slice(0, 60);
  }
}

// Volatile query params a Low-Latency HLS player mutates on every playlist
// reload (RFC 8216bis blocking-reload / rendition-report directives) plus common
// cache-busters. They make each reload look like a distinct URL, so one live
// playlist can appear dozens of times. Stripped from the de-dup key.
const VOLATILE_PARAM = /^(_hls_msn|_hls_part|_hls_skip|_hls_report|_hls_push|_nc|_|nocache|cachebuster|cb|rnd)$/i;

// Short param names some CDNs rotate per reload as a cache-bust *when their
// value is a bare timestamp*. Stripped from the de-dup key only (never fetched),
// so this can't break a signed URL that happens to include t=<time>.
const TIMESTAMPY = /^(t|ts|r|time|start|end|_ts)$/i;

// A stable de-dup key for a manifest URL: same live playlist reloaded with
// different LL-HLS directives / cache-busters collapses to one key. NOT used to
// fetch — the item keeps its original, fully-signed URL for that.
function mediaKey(url) {
  try {
    const u = new URL(url);
    const kept = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (VOLATILE_PARAM.test(k)) continue;
      if (TIMESTAMPY.test(k) && /^\d{6,}$/.test(v)) continue; // rotating timestamp
      kept.push(k + "=" + v);
    }
    kept.sort(); // order-independent so reordered reloads still match
    u.search = "";
    u.hash = "";
    return u.href + (kept.length ? "?" + kept.join("&") : "");
  } catch (e) {
    return url;
  }
}

// Swap the track token in a split-A/V URL, e.g. ..._video_.. <-> ..._audio_..
// Returns the input unchanged if the token isn't present.
function swapTrack(url, from, to) {
  return url.replace(new RegExp("([_\\-/.])" + from + "([_\\-/.])", "i"), "$1" + to + "$2");
}

// Group direct mirrors of the same file: same base domain + path, ignoring the
// subdomain (video2.host vs host) and the query token. Collapses CDN duplicates
// into one item that carries every mirror URL (used only for direct downloads).
function directGroupKey(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase().split(".");
    const base = h.length >= 2 ? h.slice(-2).join(".") : h.join(".");
    return "direct|" + base + "|" + u.pathname.toLowerCase();
  } catch (e) {
    return url;
  }
}

function directSourceKey(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (e) {
    return url;
  }
}

function hasLiveMediaKey(tabId, key) {
  const keys = livePromotedKeys.get(tabId);
  return !!keys && keys.has(key);
}

function hasLiveDirectSource(tabId, url) {
  const keys = liveDirectSourceKeys.get(tabId);
  return !!keys && keys.has(directSourceKey(url));
}

// The frameId a content-script message is attributed to. Absent/hostile frame
// ids collapse to the top frame rather than minting an unbounded claimant.
function senderFrameKey(sender) {
  return Number.isInteger(sender && sender.frameId) ? sender.frameId : 0;
}

// True when this frame may reuse an existing claim on the source: its own
// earlier DOM claim, or any network claim.
function domSourceAlreadyClaimed(tabId, url, frameKey) {
  const keys = liveDirectSourceKeys.get(tabId);
  const claimants = keys && keys.get(directSourceKey(url));
  if (!claimants) return false;
  return claimants.has(NETWORK_CLAIM) || claimants.has(frameKey);
}

// The opaque media ID that already owns this exact direct source, if any.
function getLiveDirectOwner(tabId, url) {
  const bySource = liveDirectMediaOwners.get(tabId);
  return bySource ? bySource.get(directSourceKey(url)) || null : null;
}

// Store a validated size only when it actually improves what the row shows.
// Exact evidence outranks estimates; identical values broadcast nothing.
function rememberLiveSize(mediaId, candidate, tabId) {
  if (typeof mediaId !== "string" || !mediaId) return false;
  const current = liveSizeMetadata.get(mediaId) || null;
  const next = self.McMediaSize.chooseSize(current, candidate);
  if (!next || (current && current.sizeBytes === next.sizeBytes &&
      current.sizeConfidence === next.sizeConfidence)) return false;
  liveSizeMetadata.set(mediaId, next);
  broadcast({ type: "media-updated", tabId });
  return true;
}

// Exact total from already-copied response headers. A 206 chunk length is not
// a total, so this returns null unless a valid Content-Range total is present.
function exactSizeFromEvidence(evidence) {
  const details = evidence && evidence.details;
  if (!details) return null;
  return self.McMediaSize.exactSizeFromHttp({
    statusCode: details.statusCode,
    responseHeaders: details.responseHeaders,
  });
}

// Bitrate × duration, used only when no exact total is known for this row.
function estimatedSizeForItem(item, selectedBandwidth) {
  if (!item) return null;
  return self.McMediaSize.estimatedSizeFromBitrate({
    durationSeconds: item.duration,
    selectedBandwidth,
    bandwidth: item.bandwidth,
    sampledKbps: item.estKbps,
  });
}

function forgetLiveSizesForTab(tabId) {
  const ids = liveControllerMediaIds.get(tabId);
  if (ids) for (const id of ids) liveSizeMetadata.delete(id);
  liveDirectMediaOwners.delete(tabId);
  liveDirectRowSources.delete(tabId);
}

// Remember which canonical direct source a DOM-lane row was minted for, so the
// render pass can recognise a remounted frame's repeat of one file.
function rememberLiveDirectRowSource(tabId, mediaId, url) {
  if (typeof mediaId !== "string" || !mediaId) return;
  const sources = liveDirectRowSources.get(tabId) || new Map();
  sources.set(mediaId, directSourceKey(url));
  liveDirectRowSources.set(tabId, sources);
}

// Network and DOM are independent evidence producers for the same direct file.
// Claim their shared identity at ingress so the controller receives one source,
// while different directGroupKey values remain separate media. `claimant` says
// who claimed: a reporting frame's frameId, or NETWORK_CLAIM.
function claimLiveMediaKey(tabId, key, mediaId, directUrls, claimGroupKey, claimant) {
  liveControllerTabs.add(tabId);
  const ids = liveControllerMediaIds.get(tabId) || new Set();
  ids.add(mediaId);
  liveControllerMediaIds.set(tabId, ids);
  if (claimGroupKey !== false) {
    const keys = livePromotedKeys.get(tabId) || new Set();
    keys.add(key);
    livePromotedKeys.set(tabId, keys);
  }
  if (Array.isArray(directUrls) && directUrls.length) {
    const sources = liveDirectSourceKeys.get(tabId) || new Map();
    const owners = liveDirectMediaOwners.get(tabId) || new Map();
    for (const url of directUrls) {
      const sourceKey = directSourceKey(url);
      const claimants = sources.get(sourceKey) || new Set();
      claimants.add(claimant === undefined ? NETWORK_CLAIM : claimant);
      sources.set(sourceKey, claimants);
      // First claimant keeps ownership. liveDirectSourceKeys is scoped per
      // frame, so a later frame reporting the same src still mints its own
      // detection — but enrichment follows this map, and letting that later
      // claim repoint it handed the exact Content-Range total to whoever
      // reported last (an ad iframe echoing the page's src) and left the
      // honest row on a bitrate estimate.
      if (!owners.has(sourceKey)) owners.set(sourceKey, mediaId);
    }
    liveDirectSourceKeys.set(tabId, sources);
    liveDirectMediaOwners.set(tabId, owners);
  }

  const map = mediaByTab.get(tabId);
  const legacy = map && map.get(key);
  if (legacy) {
    map.delete(key);
    liveNetworkEvidence.delete(legacy);
  }
}

function addMedia(tabId, item, networkEvidence) {
  if (tabId < 0) return;
  // De-dup key collapses Low-Latency HLS reloads of one playlist (differing only
  // by _HLS_msn / cache-bust params) into a single item. The item keeps its
  // original signed URL for fetching; the map is keyed by this stable key.
  const key = (item.kind === "hls" || item.kind === "dash") ? mediaKey(item.url)
            : item.kind === "direct" ? directGroupKey(item.url) : item.url;
  item.key = key;
  if (item.kind === "direct") {
    // An owned source keeps its single opaque row; late transport evidence only
    // enriches it. Never mint a second detection for the same file.
    const owner = getLiveDirectOwner(tabId, item.url);
    if (owner) {
      rememberLiveSize(owner, exactSizeFromEvidence(networkEvidence), tabId);
      return;
    }
    if (hasLiveDirectSource(tabId, item.url)) return;
  }
  if (hasLiveMediaKey(tabId, key)) return;
  // Stash any audio-track playlist URL (even one we're about to suppress) so the
  // recorder can pair it with the video by directory.
  if (item.kind === "hls" && isAudioUrl(item.url)) rememberAudioTrack(tabId, item.url);
  // Don't surface variant playlists that belong to a master we've parsed —
  // they're shown as quality rows under the master instead.
  if (isChild(tabId, key)) return;
  // Name items after the page/stream, not the (often random) playlist URL.
  if (item.pageTitle) item.pageTitle = cleanTitle(item.pageTitle);
  else item.pageTitle = tabTitle(tabId) || undefined;
  if (!mediaByTab.has(tabId)) mediaByTab.set(tabId, new Map());
  const map = mediaByTab.get(tabId);
  // Split-A/V streams: when the video half appears, make sure its audio-only
  // sibling never shows as a standalone item (its audio is captured with the
  // video during recording). Works whichever half is detected first.
  if (item.kind === "hls") {
    const audioSib = swapTrack(item.url, "video", "audio");
    if (audioSib !== item.url) {
      addChild(tabId, audioSib);
      purgeChildren(tabId);
    }
  }
  if (map.has(key)) {
    // Merge newly-known fields (e.g. size) but keep the original URL/key stable
    // — the popup binds progress to item.url, so it mustn't change mid-stream.
    const existing = map.get(key);
    const stableUrl = existing.url;
    const mirrors = existing.mirrors || [existing.url];
    if (item.kind === "direct" && item.url && !mirrors.includes(item.url)) mirrors.push(item.url);
    Object.assign(existing, item, { url: stableUrl, key, mirrors });
    if (networkEvidence &&
        existing.enrichState !== "done" &&
        existing.enrichState !== "error" &&
        !liveNetworkEvidence.has(existing)) {
      liveNetworkEvidence.set(existing, networkEvidence);
    }
  } else {
    if (item.kind === "direct") item.mirrors = [item.url];
    if (networkEvidence) liveNetworkEvidence.set(item, networkEvidence);
    map.set(key, item);
    updateBadge(tabId);
    broadcast({ type: "media-updated", tabId });
    if (item.kind === "hls") enrichHls(tabId, key);
    else if (item.kind === "dash") enrichDash(tabId, key);
    else if (item.kind === "direct") enrichDirect(tabId, key);
    else if (item.kind === "youtube") enrichYouTube(tabId, key);
  }
}

function copyLiveResponseHeaders(headers) {
  if (!Array.isArray(headers)) return [];
  const out = [];
  for (const header of headers) {
    if (!header || typeof header.name !== "string" || typeof header.value !== "string") continue;
    out.push({ name: header.name, value: header.value });
  }
  return out;
}

function buildLiveNetworkEvidence(details, mediaKind) {
  const ctx = tabContext.get(details.tabId) || {};
  const safeDetails = {
    url: details.url,
    tabId: details.tabId,
    frameId: Number.isInteger(details.frameId) ? details.frameId : 0,
    timeStamp: Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now(),
    responseHeaders: copyLiveResponseHeaders(details.responseHeaders),
  };
  // Safe scalar; the controller allowlists it away but size policy needs it to
  // tell a 206 chunk length from a real resource total.
  if (Number.isInteger(details.statusCode)) safeDetails.statusCode = details.statusCode;
  if (typeof details.documentId === "string") safeDetails.documentId = details.documentId;
  if (typeof details.documentUrl === "string") safeDetails.documentUrl = details.documentUrl;
  if (typeof details.originUrl === "string") safeDetails.originUrl = details.originUrl;

  const hints = {
    topLevelUrlHint: typeof ctx.topLevelPageUrl === "string"
      ? ctx.topLevelPageUrl
      : (typeof details.documentUrl === "string" ? details.documentUrl : ""),
    frameOrigin: "",
  };
  try {
    hints.frameOrigin = new URL(details.originUrl || details.documentUrl).origin;
  } catch (e) {
    hints.frameOrigin = typeof ctx.origin === "string" ? ctx.origin : "";
  }
  const transport = { mediaKind, requestHeaders: null };
  if (mediaKind === "direct") transport.mirrors = [details.url];
  if (typeof ctx.referer === "string" && ctx.referer) transport.referer = ctx.referer;
  if (typeof ctx.userAgent === "string" && ctx.userAgent) transport.userAgent = ctx.userAgent;
  return { details: safeDetails, hints, transport };
}

async function promoteLiveNetworkItem(tabId, key, item, variants, probeSizeMetadata) {
  await settingsReady;
  const controller = liveController;
  const evidence = liveNetworkEvidence.get(item);
  if (!controller || !evidence) return false;
  // The candidate must still be the live legacy owner after enrichment I/O.
  // Clear/navigation or a DOM claim removes it and invalidates this result.
  const current = mediaByTab.get(tabId);
  if (!current || current.get(key) !== item) {
    liveNetworkEvidence.delete(item);
    return false;
  }
  // A matching DOM report may have claimed this file while the network probe
  // awaited I/O. Recheck after the await and before minting a second media ID.
  if (item.kind === "direct" && Array.isArray(item.mirrors) &&
      item.mirrors.some((url) => hasLiveDirectSource(tabId, url))) return false;
  if (hasLiveMediaKey(tabId, key)) return false;
  if (item.kind === "direct" && Array.isArray(item.mirrors)) {
    evidence.transport.mirrors = item.mirrors.slice();
  }

  let mediaId;
  try {
    mediaId = controller.captureNetwork(evidence);
  } catch (e) {
    dlog("live promotion rejected", item.kind, e && e.message);
    return false;
  }
  if (Array.isArray(variants) && variants.length) {
    try { controller.registerVariants(mediaId, variants); }
    catch (e) { dlog("live variant registration rejected", item.kind, e && e.message); }
  }

  claimLiveMediaKey(
    tabId,
    key,
    mediaId,
    item.kind === "direct" ? (item.mirrors || [item.url]) : null,
    true,
    NETWORK_CLAIM
  );
  // Trusted probe/header totals first; a bitrate estimate only fills the gap
  // when nothing exact is known for this row.
  rememberLiveSize(mediaId, exactSizeFromEvidence(evidence), tabId);
  rememberLiveSize(mediaId, probeSizeMetadata, tabId);
  if (!liveSizeMetadata.has(mediaId)) {
    rememberLiveSize(mediaId, estimatedSizeForItem(item), tabId);
  }
  liveNetworkEvidence.delete(item);
  return true;
}

// Ask the helper (yt-dlp -J) for a YouTube URL's real formats so the popup can show
// codec / resolution / bitrate / size + a quality picker. Mirrors the HLS/DASH enrich
// pattern; needs the native helper, and is a no-op (leaves the bare item) without it.
function requestYtMeta(url) {
  return new Promise((resolve) => {
    const reqId = "ytm-" + (++downloadCounter);
    pendingYtMeta.set(reqId, resolve);
    try { nativePort.postMessage({ cmd: "ytmeta", reqId, url }); }
    catch (e) { pendingYtMeta.delete(reqId); resolve(null); }
    // Longer than the host's 45s probe timeout so a completed probe is never orphaned.
    setTimeout(() => { if (pendingYtMeta.has(reqId)) { pendingYtMeta.delete(reqId); resolve(null); } }, 60000);
  });
}

async function enrichYouTube(tabId, key) {
  if (!nativePort || !nativeReady) return;   // needs the helper to run yt-dlp
  const map = mediaByTab.get(tabId);
  const item = map && map.get(key);
  if (!item || item.kind !== "youtube") return;
  // Probe once per item. "error" is included so a failed probe doesn't re-fire on
  // every get-media (its own media-updated would otherwise loop it forever). The
  // helper-not-ready case below returns before setting a state, so it still retries.
  if (["done", "loading", "error"].includes(item.enrichState) || enriching.has(key)) return;
  enriching.add(key);
  item.enrichState = "loading";
  broadcast({ type: "media-updated", tabId });
  try {
    const meta = await requestYtMeta(item.url);
    if (meta && meta.ok) {
      if (meta.duration) item.duration = meta.duration;
      if (meta.title && !item.pageTitle) item.pageTitle = meta.title;
      const fmts = (meta.formats || []).filter((f) => f.height);
      if (fmts.length) {
        item.ytFormats = fmts;                 // for the quality picker
        item.ytAudioSize = meta.audioSize || 0;
        item.hasAudio = true;                  // YouTube video always carries audio
        const best = fmts[0];                  // highest height (host sorts desc)
        item.height = best.height;
        item.codec = best.codec || item.codec;
        item.bandwidth = best.tbr ? best.tbr * 1000 : item.bandwidth;
        item.size = best.size || item.size;
      }
      item.enrichState = "done";
    } else {
      item.enrichState = "error";
      item.enrichError = (meta && meta.error) || "Couldn't read formats";
    }
  } catch (e) {
    item.enrichState = "error";
    item.enrichError = e.message || String(e);
  } finally {
    enriching.delete(key);
    broadcast({ type: "media-updated", tabId });
  }
}

// Parse a DASH .mpd on detection so the popup can show qualities + DRM state.
async function enrichDash(tabId, key) {
  if (enriching.has(key)) return;
  const map = mediaByTab.get(tabId);
  if (!map || !map.has(key)) return;
  const item = map.get(key);
  if (item.enrichState === "done") return;
  enriching.add(key);
  item.enrichState = "loading";
  broadcast({ type: "media-updated", tabId });
  try {
    const text = await fetchText(tabId, item.url);
    const parsed = self.DASH.parse(text, item.url);
    item.isMaster = parsed.variants.length > 1;
    item.variants = parsed.variants;      // {id,label,height,bandwidth,resolution}
    item.codec = codecLabel((parsed.variants[0] || {}).codecs || "");
    item.drm = parsed.drm;
    item.isDynamic = parsed.isDynamic;
    item.hasAudio = parsed.audio.length > 0;
    item.duration = parsed.duration;
    item.unsupported = !Array.isArray(parsed.video) || parsed.video.length === 0;
    item.enrichState = "done";
    if (!item.isDynamic && !item.drm && !item.unsupported) {
      const variants = parsed.video.map((v) => {
        const out = { url: item.url };
        if (v.width > 0 && v.height > 0) out.label = v.width + "x" + v.height +
          (v.bandwidth > 0 ? " · " + Math.round(v.bandwidth / 1000) + " kbps" : "");
        else if (v.height > 0) out.label = v.height + "p";
        if (v.width > 0) out.width = v.width;
        if (v.height > 0) out.height = v.height;
        if (v.bandwidth > 0) out.bandwidth = v.bandwidth;
        if (/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(v.mimeType || "")) out.mime = v.mimeType;
        return out;
      });
      await promoteLiveNetworkItem(tabId, key, item, variants);
    }
  } catch (e) {
    item.enrichState = "error";
    item.enrichError = e.message || String(e);
  } finally {
    liveNetworkEvidence.delete(item);
    enriching.delete(key);
    updateBadge(tabId);
    broadcast({ type: "media-updated", tabId });
  }
}

// ---- Direct-file probe ----
// Two links that look identical (same title/host) are common — one real, one an
// expired/HTML/junk placeholder. Fetch the first ~256 KB with a Range request to
// learn the true size, confirm it's real media (magic bytes), catch HTTP errors,
// and (for faststart mp4) read the duration to derive a bitrate.
async function probeDirect(tabId, url) {
  const ctx = tabContext.get(tabId) || {};
  const token = "mc_" + Math.random().toString(36).slice(2) + Date.now();
  taggedRequests.set(token, { referer: ctx.referer, origin: ctx.origin });
  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 20000);
  try {
    const resp = await fetch(url, {
      credentials: "include",
      headers: { "X-MC-Token": token, "Range": "bytes=0-262143" },
      signal: controller.signal,
    });
    const ct = resp.headers.get("content-type") || "";
    // A ranged probe's Content-Length describes the 256 KB chunk, never the
    // file. Only a valid Content-Range total (or a full 200) is a real total.
    const sizeMetadata = self.McMediaSize.exactSizeFromHttp({
      statusCode: resp.status,
      responseHeaders: [
        { name: "Content-Range", value: resp.headers.get("content-range") || "" },
        { name: "Content-Length", value: resp.headers.get("content-length") || "" },
      ],
    });
    const size = sizeMetadata ? sizeMetadata.sizeBytes : 0;
    const ok = resp.ok || resp.status === 206;
    // Read up to 256 KB, then abort so we never pull a whole file that ignored Range.
    const LIMIT = 262144, chunks = [];
    let recv = 0;
    if (resp.body) {
      const reader = resp.body.getReader();
      while (recv < LIMIT) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value); recv += r.value.length;
      }
    }
    try { controller.abort(); } catch (e) {}
    const head = new Uint8Array(recv);
    let off = 0;
    for (const c of chunks) { head.set(c, off); off += c.length; }
    return { status: resp.status, ok, contentType: ct, size, sizeMetadata, head };
  } finally {
    clearTimeout(timer);
    taggedRequests.delete(token);
  }
}

// Identify a container from the first bytes (and content-type as a fallback).
function sniffContainer(b, ct) {
  if (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "mp4";
  if (b.length >= 4) {
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
    if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return "ogg";
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "avi";
    if (b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56) return "flv";
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return "mp3";
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";
  }
  if (/text\/html|application\/(json|xml)|^text\//i.test(ct)) return "html";
  if (/^video\//i.test(ct)) return "video";
  if (/^audio\//i.test(ct)) return "audio";
  return "";
}
const MEDIA_CONTAINER = /^(mp4|webm|ogg|avi|flv|mp3|video|audio)$/;

// Duration (seconds) from a faststart mp4 whose moov sits in the probed head.
function mp4DurationFromHead(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fourcc = (p) => String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    function child(type, start, end) {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p), hdr = 8;
        if (size === 1) { if (p + 16 > end) break; size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
        else if (size === 0) size = end - p;
        if (fourcc(p) === type) return { dataStart: p + hdr, dataEnd: Math.min(p + size, end) };
        if (size < hdr || p + size > end) break;    // truncated non-match — can't skip safely
        p += size;
      }
      return null;
    }
    const moov = child("moov", 0, bytes.length);
    if (!moov) return 0;
    const mvhd = child("mvhd", moov.dataStart, moov.dataEnd);
    if (!mvhd) return 0;
    const d = mvhd.dataStart, ver = bytes[d];
    const ts = ver === 1 ? dv.getUint32(d + 20) : dv.getUint32(d + 12);
    const dur = ver === 1 ? Number(dv.getBigUint64(d + 24)) : dv.getUint32(d + 16);
    return ts ? dur / ts : 0;
  } catch (e) { return 0; }
}

// Short label for a video codec — from an HLS/DASH CODECS string (avc1.640028,…)
// or an mp4 sample-entry fourcc.
function codecLabel(codecs) {
  if (!codecs) return "";
  const map = [[/av01|av1\b/i, "AV1"], [/hvc1|hev1|hevc|h\.?265/i, "HEVC"],
               [/avc[13]|h\.?264/i, "AVC"], [/vp0?9/i, "VP9"], [/vp0?8/i, "VP8"],
               [/mp4v/i, "MPEG-4"], [/theora/i, "Theora"]];
  for (const [re, label] of map) if (re.test(codecs)) return label;
  return "";
}

// Video codec from a faststart mp4 whose moov sits in the probed head. Walks
// moov -> trak -> mdia -> minf -> stbl -> stsd and reads the sample-entry fourcc.
function mp4CodecFromHead(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fourcc = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    function children(start, end) {
      const out = []; let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p), hdr = 8;
        if (size === 1) { if (p + 16 > end) break; size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
        else if (size === 0) size = end - p;
        if (size < hdr || p + size > end) break;
        out.push({ type: fourcc(p + 4), dataStart: p + hdr, dataEnd: p + size });
        p += size;
      }
      return out;
    }
    const first = (t, s, e) => children(s, e).find((b) => b.type === t) || null;
    const VIDEO = { avc1: "AVC", avc3: "AVC", hev1: "HEVC", hvc1: "HEVC",
                    av01: "AV1", vp09: "VP9", vp08: "VP8", mp4v: "MPEG-4" };
    const moov = first("moov", 0, bytes.length);
    if (!moov) return "";
    for (const trak of children(moov.dataStart, moov.dataEnd).filter((b) => b.type === "trak")) {
      const mdia = first("mdia", trak.dataStart, trak.dataEnd); if (!mdia) continue;
      const minf = first("minf", mdia.dataStart, mdia.dataEnd); if (!minf) continue;
      const stbl = first("stbl", minf.dataStart, minf.dataEnd); if (!stbl) continue;
      const stsd = first("stsd", stbl.dataStart, stbl.dataEnd); if (!stsd) continue;
      const entry = stsd.dataStart + 8;            // skip version/flags + entry_count
      if (entry + 8 > stsd.dataEnd) continue;
      const cc = fourcc(entry + 4);
      if (VIDEO[cc]) return VIDEO[cc];
    }
    return "";
  } catch (e) { return ""; }
}

async function enrichDirect(tabId, key) {
  if (enriching.has(key)) return;
  const map = mediaByTab.get(tabId);
  if (!map || !map.has(key)) return;
  const item = map.get(key);
  if (item.enrichState === "done") return;
  enriching.add(key);
  item.enrichState = "loading";
  broadcast({ type: "media-updated", tabId });
  try {
    const r = await probeDirect(tabId, item.url);
    item.probeStatus = r.status;
    if (r.contentType) item.contentType = r.contentType;
    if (r.size) item.size = r.size;
    const container = sniffContainer(r.head, r.contentType);
    item.container = container;
    const isMedia = MEDIA_CONTAINER.test(container) || /^video\/|^audio\//i.test(r.contentType);
    item.junk = !r.ok || container === "html" || !isMedia;
    if (container === "mp4") {
      const dur = mp4DurationFromHead(r.head);
      if (dur > 0) {
        item.duration = dur;
        if (item.size) item.estKbps = Math.round((item.size * 8) / dur / 1000);
      }
      const codec = mp4CodecFromHead(r.head);
      if (codec) item.codec = codec;
    }
    item.enrichState = "done";
    if (!item.junk) await promoteLiveNetworkItem(tabId, key, item, null, r.sizeMetadata);
    dlog("probed direct", { url: item.url, status: r.status, size: item.size, container, junk: item.junk, kbps: item.estKbps });
  } catch (e) {
    item.enrichState = "error";
    item.probeError = e.message || String(e);
    item.junk = true;
  } finally {
    liveNetworkEvidence.delete(item);
    enriching.delete(key);
    updateBadge(tabId);
    broadcast({ type: "media-updated", tabId });
  }
}

// Estimate a media playlist's bitrate (kbps) from one real segment. Best-effort:
// returns 0 on any failure. Samples the newest segment (freshest for live).
async function estimateBitrate(tabId, media) {
  try {
    const seg = media.segments[media.segments.length - 1];
    if (!seg || !seg.duration) return 0;
    const range = seg.byteRange
      ? { range: "bytes=" + seg.byteRange.offset + "-" + (seg.byteRange.offset + seg.byteRange.length - 1) }
      : undefined;
    const buf = await makeFetchFn(tabId)(seg.uri, range);
    const bytes = buf.byteLength;
    if (!bytes) return 0;
    return Math.round((bytes * 8) / seg.duration / 1000); // kbps
  } catch (e) {
    return 0;
  }
}

// Fetch + parse an HLS playlist as soon as it's seen, so the popup can render
// quality/bitrate options (for masters) or duration (for media playlists)
// without the user clicking to expand first. Failures fall back gracefully to
// the click-to-expand path.
async function enrichHls(tabId, key) {
  if (enriching.has(key)) return;
  const map = mediaByTab.get(tabId);
  if (!map || !map.has(key)) return;
  const item = map.get(key);
  if (item.enrichState === "done") return;
  const url = item.url;

  enriching.add(key);
  item.enrichState = "loading";
  broadcast({ type: "media-updated", tabId });

  try {
    let parsed = hlsCache.get(url);
    if (!parsed) {
      const text = await fetchText(tabId, url);
      parsed = self.HLS.parsePlaylist(text, url);
      rememberParsed(url, parsed);
    }

    if (parsed.type === "master") {
      item.isMaster = true;
      item.variants = parsed.variants.map((v) => ({
        uri: v.uri,
        height: v.height,
        bandwidth: v.bandwidth,
        resolution: v.resolution,
        label:
          (v.resolution || (v.height ? v.height + "p" : "auto")) +
          (v.bandwidth ? " · " + Math.round(v.bandwidth / 1000) + " kbps" : ""),
      }));
      // Register every variant/audio rendition as a child (matched by path so
      // ?session=… differences don't defeat it), then drop any already surfaced
      // as their own row — the master's quality menu represents them instead.
      for (const v of parsed.variants) addChild(tabId, v.uri);
      if (parsed.audioGroups) {
        for (const g of Object.values(parsed.audioGroups))
          for (const a of g) addChild(tabId, a.uri);
      }
      purgeChildren(tabId);
      item.hasAudio = parsed.variants.some((v) => v.audioGroup) &&
        Object.keys(parsed.audioGroups || {}).length > 0;
      item.hasSubtitles = Object.keys(parsed.subtitleGroups || {}).length > 0;
      // Probe the top variant so we can suppress its segments (they'd otherwise
      // flood the list) and learn whether the master is a live broadcast.
      const top = parsed.variants[0];
      if (top && top.codecs) item.codec = codecLabel(top.codecs);
      if (top) {
        try {
          const vtext = await fetchText(tabId, top.uri);
          const vparsed = self.HLS.parsePlaylist(vtext, top.uri);
          if (vparsed.type === "media") {
            item.isLive = vparsed.isLive;
            item.encrypted = !!vparsed.encryption;
            item.drm = !!(vparsed.encryption &&
              (vparsed.encryption.method !== "AES-128" ||
               (vparsed.encryption.keyFormat && vparsed.encryption.keyFormat !== "identity")));
            registerSegments(tabId, vparsed);
          }
        } catch (e) { /* best-effort — pattern-based filtering still applies */ }
      }
    } else {
      item.isMaster = false;
      item.isLive = parsed.isLive;
      item.segmentCount = parsed.segments.length;
      item.encrypted = !!parsed.encryption;
      // Learn this playlist's segments so their network requests stop flooding
      // the list (and purge any already surfaced before we parsed the manifest).
      registerSegments(tabId, parsed);
      item.drm = !!(parsed.encryption &&
        (parsed.encryption.method !== "AES-128" ||
         (parsed.encryption.keyFormat && parsed.encryption.keyFormat !== "identity")));
      item.duration = parsed.segments.reduce((a, s) => a + (s.duration || 0), 0);
      // A media playlist declares no bitrate, so estimate one by sampling the
      // most recent segment (bytes ÷ its EXTINF duration) — gives the popup a
      // "what am I about to record" number even without a master.
      if (!item.drm) {
        item.estKbps = await estimateBitrate(tabId, parsed);
      }
    }
    item.enrichState = "done";
    if (item.isLive === false && !item.drm) {
      const variants = parsed.type === "master" ? parsed.variants.map((v) => {
        const out = { url: v.uri };
        const resolution = typeof v.resolution === "string" ? v.resolution.match(/^(\d+)x(\d+)$/) : null;
        if (resolution) out.width = parseInt(resolution[1], 10);
        if (v.height > 0) out.height = v.height;
        if (v.bandwidth > 0) out.bandwidth = v.bandwidth;
        out.label = (v.resolution || (v.height > 0 ? v.height + "p" : "auto")) +
          (v.bandwidth > 0 ? " · " + Math.round(v.bandwidth / 1000) + " kbps" : "");
        return out;
      }) : [];
      await promoteLiveNetworkItem(tabId, key, item, variants);
    }
  } catch (e) {
    item.enrichState = "error";
    item.enrichError = e.message || String(e);
    dlog("enrich ERROR", item.url, "→", item.enrichError);
  } finally {
    liveNetworkEvidence.delete(item);
    enriching.delete(key);
    dlog("enriched", { url: item.url, master: item.isMaster, live: item.isLive,
      estKbps: item.estKbps, group: renditionGroup(item.url), state: item.enrichState });
    updateBadge(tabId);
    broadcast({ type: "media-updated", tabId });
  }
}

function updateBadge(tabId) {
  const count = visibleFor(tabId).length + liveRowsForTab(tabId).length;
  const text = count > 0 ? String(count) : "";
  try {
    api.browserAction.setBadgeText({ tabId, text });
    api.browserAction.setBadgeBackgroundColor({ color: "#3DD4C8" });
  } catch (e) {}
}

// ---- Detection listeners ----

api.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    // Capture page context for later Referer injection.
    const referer = getHeader(details.requestHeaders, "Referer");
    const origin = getHeader(details.requestHeaders, "Origin");
    const ua = getHeader(details.requestHeaders, "User-Agent");
    if (referer || origin) {
      const ctx = tabContext.get(details.tabId) || {};
      if (referer) ctx.referer = referer;
      if (origin) ctx.origin = origin;
      if (ua) ctx.userAgent = ua;
      tabContext.set(details.tabId, ctx);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

api.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    // YouTube's media rides PO-token-gated googlevideo requests we can't reuse;
    // suppress that noise — the tab's single YouTube item is handled via yt-dlp.
    try { if (/(^|\.)googlevideo\.com$/i.test(new URL(details.url).hostname)) return; } catch (e) {}
    if (IGNORE_URL.test(details.url)) return;

    const ct = getHeader(details.responseHeaders, "content-type") || "";
    const clRaw = getHeader(details.responseHeaders, "content-length");
    const size = clRaw ? parseInt(clRaw, 10) : 0;
    const kind = classify(details.url, ct);
    if (!kind) return;

    // Skip HLS/DASH segments — we want manifests & standalone files, not the
    // per-2s pieces of a live stream (which would flood the list).
    if (kind === "direct" && looksLikeSegment(details.tabId, details.url, ct)) return;

    addMedia(details.tabId, {
      url: details.url,
      kind,
      contentType: ct,
      size,
      name: shortName(details.url),
      source: "network",
      ts: Date.now(),
    }, buildLiveNetworkEvidence(details, kind));
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---- Header injection for our own fetches ----
// We tag outgoing fetches with X-MC-Token; this blocking listener swaps the
// marker for the real Referer/Origin so segment servers that gate on them
// respond correctly. (Extension fetch cannot set Referer/Origin directly.)

api.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const tokenHeader = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === "x-mc-token"
    );
    if (!tokenHeader) return {};
    const ctx = taggedRequests.get(tokenHeader.value);
    let headers = details.requestHeaders.filter(
      (h) => h.name.toLowerCase() !== "x-mc-token"
    );
    if (ctx) {
      headers = headers.filter(
        (h) => !["referer", "origin"].includes(h.name.toLowerCase())
      );
      if (ctx.referer) headers.push({ name: "Referer", value: ctx.referer });
      if (ctx.origin) headers.push({ name: "Origin", value: ctx.origin });
    }
    return { requestHeaders: headers };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);

// Returns a fetchFn(url, opts)->ArrayBuffer bound to a tab's context.
// opts.range -> Range header value. Retries with exponential backoff.
function makeFetchFn(tabId) {
  const ctx = tabContext.get(tabId) || {};
  return async function (url, opts) {
    opts = opts || {};
    const maxAttempts = Math.max(1, settings.retries + 1);
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const token = "mc_" + Math.random().toString(36).slice(2) + Date.now();
      taggedRequests.set(token, { referer: ctx.referer, origin: ctx.origin });
      try {
        const headers = { "X-MC-Token": token };
        if (opts.range) headers["Range"] = opts.range; // Range is settable directly
        const resp = await fetch(url, { credentials: "include", headers });
        if (!resp.ok && resp.status !== 206) throw new Error("HTTP " + resp.status);
        return await resp.arrayBuffer();
      } catch (e) {
        lastErr = e;
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        }
      } finally {
        taggedRequests.delete(token);
      }
    }
    throw lastErr;
  };
}

// One authenticated browser fetch bound to the immutable source tab context.
// Retry ownership belongs to the live scheduler/assembler path.
function makeOneShotFetchFn(tabId) {
  const ctx = tabContext.get(tabId) || {};
  return async function (url, opts) {
    opts = opts || {};
    const token = "mc_" + mintLiveToken();
    taggedRequests.set(token, { referer: ctx.referer, origin: ctx.origin });
    try {
      const headers = { "X-MC-Token": token };
      if (opts.range) headers.Range = opts.range;
      const resp = await fetch(url, { credentials: "include", headers });
      if (!resp.ok && resp.status !== 206) throw new Error("HTTP " + resp.status);
      return await resp.arrayBuffer();
    } finally {
      taggedRequests.delete(token);
    }
  };
}

async function fetchText(tabId, url) {
  const buf = await makeFetchFn(tabId)(url);
  return new TextDecoder("utf-8").decode(buf);
}

// ---- Downloads ----

function sanitizeFilename(name) {
  return (name || "video")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function broadcast(msg) {
  api.runtime.sendMessage(msg).catch(() => {}); // popup may be closed
}

async function downloadDirect(item, tabId, filename) {
  const name = sanitizeFilename(filename || item.name);
  const finalName = /\.[a-z0-9]{2,4}$/i.test(name) ? name : name + guessExt(item);
  // A ready helper downloads with several parallel range connections (and, when
  // the file has mirrors, fails a segment over to another mirror). The host emits
  // "pget-fallback" if ranges aren't supported or anything fails, and we hand back
  // to the browser download below (which carries cookies).
  const urls = (item.mirrors && item.mirrors.length) ? item.mirrors.slice() : [item.url];
  if (nativePort && nativeReady) {
    const id = "pget:" + (item.key || item.url);
    const ctx = tabContext.get(tabId) || {};
    pgetFallback.set(id, { item, finalName });
    try {
      nativePort.postMessage({ cmd: "pget", id, urls, name: finalName, convert: convertSpec(),
        dir: settings.saveFolder || "", referer: ctx.referer || "", userAgent: ctx.userAgent || "" });
      return;
    } catch (e) {
      pgetFallback.delete(id);
    }
  }
  // Browser fallback (carries cookies automatically).
  await api.downloads.download({ url: item.url, filename: finalName, saveAs: true });
}

function guessExt(item) {
  const m = item.url.match(DIRECT_EXT);
  if (m) return "." + m[1].toLowerCase();
  if (/mp4/i.test(item.contentType || "")) return ".mp4";
  if (/webm/i.test(item.contentType || "")) return ".webm";
  return ".mp4";
}

// Download one media playlist (video or audio) to bytes.
async function downloadPlaylist(playlistUrl, tabId, dl, containerHint) {
  const text = await fetchText(tabId, playlistUrl);
  const parsed = self.HLS.parsePlaylist(text, playlistUrl);
  if (parsed.type !== "media") throw new Error("Expected a media playlist.");
  return self.HLS.downloadMedia(parsed, {
    fetchFn: makeFetchFn(tabId),
    concurrency: settings.concurrency,
    allowLive: false,
    containerHint: containerHint,
    onProgress: (p) => {
      // Smooth the download speed (bytes/s) from cumulative bytes over time, so bursts
      // of parallel segment completions read as a steady MB/s rather than spiking.
      const now = Date.now();
      if (p.bytes != null) {
        if (dl._spT == null) { dl._spT = now; dl._spB = p.bytes; }
        else {
          const dt = (now - dl._spT) / 1000;
          if (dt >= 0.4) {
            const inst = (p.bytes - dl._spB) / dt;
            dl._bps = dl._bps != null ? dl._bps * 0.65 + inst * 0.35 : inst;
            dl._spT = now; dl._spB = p.bytes;
          }
        }
      }
      dl.progress = { done: p.done, total: p.total, bytes: p.bytes, bps: dl._bps };
      broadcast({ type: "download-update", download: dl });
    },
    shouldAbort: () => dl.status === "cancelled",
  });
}

// Concatenate WebVTT subtitle segments into one .vtt (keep first header only).
async function downloadSubtitles(subPlaylistUrl, tabId) {
  const text = await fetchText(tabId, subPlaylistUrl);
  const parsed = self.HLS.parsePlaylist(text, subPlaylistUrl);
  if (parsed.type !== "media" || !parsed.segments.length) return null;
  const fetchFn = makeFetchFn(tabId);
  let out = "WEBVTT\n";
  for (const seg of parsed.segments) {
    const buf = await fetchFn(seg.uri);
    let vtt = new TextDecoder("utf-8").decode(buf);
    vtt = vtt.replace(/^\uFEFF?WEBVTT[^\n]*\n?/, "").trim();
    if (vtt) out += "\n" + vtt + "\n";
  }
  return out;
}

function pickVariant(variants, chosenUri) {
  if (chosenUri) {
    const found = variants.find((v) => v.uri === chosenUri);
    if (found) return found;
  }
  if (settings.defaultQuality === "lowest") return variants[variants.length - 1];
  return variants[0]; // highest (variants are sorted desc)
}

// Finished downloads stay in the queue long enough to be USED (open / reveal /
// cast from the popup) — the old 2-minute eviction stranded the user with no way
// back to the file once the toast was gone. Discard timers stay short; error
// flows keep whatever timer they already had (their cards carry Dismiss).
const DONE_RETAIN_MS = 30 * 60 * 1000;

// Remember the browser-download identity on a queue entry so the popup can
// open/reveal/cast the produced file later. Native-helper flows learn savedPath
// from the helper's own messages; browser-API flows only hold a downloads-API id
// until we search it for the on-disk filename.
async function recordSavedFile(dl, downloadId) {
  if (dl == null || downloadId == null) return;
  dl.downloadId = downloadId;
  try {
    const res = await api.downloads.search({ id: downloadId });
    if (res && res[0] && res[0].filename) dl.savedPath = res[0].filename;
  } catch (e) { /* filename unknown — Open/Folder still work via the id */ }
  broadcast({ type: "download-update", download: dl });
}

async function saveBytes(bytes, mime, filename, ext, opts) {
  opts = opts || {};
  const saveAs = opts.saveAs !== false;   // default: show the Save-As dialog
  // In-browser downloads land in the browser's Downloads dir; only the native
  // helper can honor a custom save folder.
  const blob = new Blob([bytes], { type: mime });
  const objUrl = URL.createObjectURL(blob);
  const dlId = await api.downloads.download({ url: objUrl, filename: filename + "." + ext, saveAs });
  setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  return dlId;
}

async function downloadHls(item, tabId, filename, chosenVariantUrl) {
  const id = ++downloadCounter;
  const dl = { id, url: item.url, status: "parsing", progress: { done: 0, total: 0 }, name: filename };
  activeDownloads.set(id, dl);
  broadcast({ type: "download-update", download: dl });

  try {
    let text = await fetchText(tabId, item.url);
    let parsed = self.HLS.parsePlaylist(text, item.url);

    let videoUrl = chosenVariantUrl || item.url;
    let audioUrl = null;
    let subUrl = null;

    if (parsed.type === "master") {
      if (!parsed.variants.length) throw new Error("Master playlist had no variants.");
      const variant = pickVariant(parsed.variants, chosenVariantUrl);
      videoUrl = variant.uri;
      // Separate audio rendition (if the variant references an AUDIO group).
      if (variant.audioGroup && parsed.audioGroups[variant.audioGroup]) {
        const group = parsed.audioGroups[variant.audioGroup];
        const chosen = group.find((a) => a.default) || group[0];
        if (chosen && chosen.uri !== videoUrl) audioUrl = chosen.uri;
      }
      // Subtitles.
      if (settings.captureSubtitles && variant.subtitleGroup && parsed.subtitleGroups[variant.subtitleGroup]) {
        const sg = parsed.subtitleGroups[variant.subtitleGroup];
        const chosen = sg.find((s) => s.default) || sg[0];
        if (chosen) subUrl = chosen.uri;
      }
    } else if (parsed.type === "media" && parsed.isLive) {
      // Live media playlist — record it (poll-and-append) instead of failing.
      return recordLiveHls(item, tabId, filename, item.url, dl);
    }

    // A selected master variant may itself be live (webcam / broadcast). Probe
    // it once; if live, switch to recording (with the paired audio track, if
    // any) instead of a one-shot VOD grab.
    if (parsed.type === "master") {
      const probeText = await fetchText(tabId, videoUrl);
      const probe = self.HLS.parsePlaylist(probeText, videoUrl);
      if (probe.type === "media" && probe.isLive) {
        const v = pickVariant(parsed.variants, chosenVariantUrl);
        const quality = v ? { resolution: v.resolution, height: v.height, bandwidth: v.bandwidth } : null;
        return recordLiveHls(item, tabId, filename, videoUrl, dl, audioUrl, quality);
      }
    }

    dl.status = "downloading";
    dl.hasAudio = !!audioUrl;
    broadcast({ type: "download-update", download: dl });

    const base = sanitizeFilename(filename || item.name || "video").replace(/\.m3u8.*$/i, "");

    // Video (or muxed) track.
    const video = await downloadPlaylist(videoUrl, tabId, dl, null);
    const videoDlId = await saveBytes(video.data, video.mime, audioUrl ? base + "-video" : base, video.ext);

    // Separate audio track, if any.
    let mergeCmd = null;
    if (audioUrl) {
      dl.status = "audio";
      broadcast({ type: "download-update", download: dl });
      const audio = await downloadPlaylist(audioUrl, tabId, dl, null);
      await saveBytes(audio.data, audio.mime, base + "-audio", audio.ext);
      mergeCmd = self.Commands.ffmpegMerge(base + "-video." + video.ext, base + "-audio." + audio.ext, base);
      dl.mergeCommand = mergeCmd;
    }

    // Subtitles sidecar.
    if (subUrl) {
      try {
        const vtt = await downloadSubtitles(subUrl, tabId);
        if (vtt) await saveBytes(new TextEncoder().encode(vtt), "text/vtt", base, "vtt");
      } catch (e) { /* subtitles are best-effort */ }
    }

    dl.status = "done";
    broadcast({ type: "download-update", download: dl });
    recordSavedFile(dl, videoDlId);
    addHistory({ name: base, kind: "hls", ts: Date.now() });
    notifyDone(base, mergeCmd ? "Saved video + audio separately — run the merge command." : null,
      videoDlId != null ? { downloadId: videoDlId } : null);
  } catch (e) {
    dl.status = "error";
    dl.error = e.message || String(e);
    broadcast({ type: "download-update", download: dl });
  } finally {
    setTimeout(() => activeDownloads.delete(id), DONE_RETAIN_MS);
  }
}

// Some LL-HLS setups (Chaturbate among them) split A/V into parallel chunklists
// named ..._video_.. and ..._audio_.. . If we're about to record a video-only
// playlist and weren't handed an audio track, probe for the sibling so the
// recording actually has sound.
async function findSiblingAudio(tabId, videoUrl) {
  // 1) The real audio chunklist the page fetched, matched by stream directory —
  //    correct even when audio uses a different id/name than video.
  const seen = audioTrackByTab.get(tabId);
  if (seen) {
    const real = seen.get(streamDir(videoUrl));
    if (real) {
      try {
        const u = mediaKey(real); // drop stale _HLS_msn, keep session/auth
        const text = await fetchText(tabId, u);
        const parsed = self.HLS.parsePlaylist(text, u);
        if (parsed.type === "media" && parsed.segments.length) { dlog("paired audio (observed)", u); return u; }
      } catch (e) { dlog("observed audio unusable", real, e.message); }
    }
  }
  // 2) Fallback: derive by swapping the track token (works when ids match).
  const cand = swapTrack(videoUrl, "video", "audio");
  if (cand !== videoUrl) {
    try {
      const text = await fetchText(tabId, cand);
      const parsed = self.HLS.parsePlaylist(text, cand);
      if (parsed.type === "media" && parsed.segments.length) { dlog("paired audio (derived)", cand); return cand; }
    } catch (e) { /* fall through */ }
  }
  dlog("no audio track found for", videoUrl);
  return null;
}

// ---- Live HLS recording ----
// Buffers segments in memory as they arrive and saves when the user stops
// (dl.stopRequested) or the broadcast ends. Cancel (dl.status === "cancelled")
// discards. If a separate audio track exists it's recorded concurrently and
// saved as a second file with an ffmpeg merge command. Reuses `dl` when called
// mid-flow from downloadHls.
async function recordLiveHls(item, tabId, filename, videoUrl, existingDl, audioUrl, quality) {
  const id = existingDl ? existingDl.id : ++downloadCounter;
  const dl = existingDl || { id, url: item.url, name: filename };
  dl.status = "recording";
  dl.live = true;
  dl.tabId = tabId;               // so tab-close can abort an in-flight recording
  dl.stopRequested = false;
  dl.quality = quality || null;   // { resolution, height, bandwidth } if known
  dl.progress = { done: 0, total: 0, live: true, bytes: 0, duration: 0, kbps: 0 };
  activeDownloads.set(id, dl);
  broadcast({ type: "download-update", download: dl });

  try {
    const base = sanitizeFilename(filename || item.name || "live").replace(/\.m3u8.*$/i, "");

    // Auto-discover a sibling audio track for video-only live playlists.
    if (!audioUrl) audioUrl = await findSiblingAudio(tabId, videoUrl);
    dl.hasAudio = !!audioUrl;

    // Preferred path: hand off to the native helper (ffmpeg) — it records to a
    // temp file, muxes the audio, and produces one clean mp4. Falls through to
    // the in-browser recorder when the helper isn't installed.
    if (nativeReady && nativePort) {
      dl.native = true;
      dl.name = base;
      nativeRecord(dl, tabId, videoUrl, audioUrl);
      dlog("recording via native helper", { id, videoUrl, audioUrl });
      return;
    }

    const fetchFn = makeFetchFn(tabId);
    const fetchTextFn = (u) => fetchText(tabId, u);

    // Two independent record loops. Either finishing naturally (ENDLIST) signals
    // the other to wrap up so the two files stay roughly the same length.
    let vBytes = 0, aBytes = 0, videoEnded = false, audioEnded = false;
    const commonAbort = () => dl.status === "cancelled";

    const videoP = self.HLS.recordLive(videoUrl, {
      fetchFn, fetchText: fetchTextFn,
      onProgress: (p) => {
        vBytes = p.bytes;
        const total = vBytes + aBytes;
        // Measured bitrate across everything captured so far (video + audio).
        const kbps = p.duration > 0 ? Math.round((total * 8) / p.duration / 1000) : 0;
        dl.progress = { done: p.segments, total: 0, live: true, bytes: total, duration: p.duration, kbps };
        broadcast({ type: "download-update", download: dl });
      },
      shouldStop: () => dl.stopRequested || audioEnded,
      shouldAbort: commonAbort,
    }).then((r) => { videoEnded = true; return r; });

    const audioP = audioUrl
      ? self.HLS.recordLive(audioUrl, {
          fetchFn, fetchText: fetchTextFn,
          onProgress: (p) => { aBytes = p.bytes; },
          shouldStop: () => dl.stopRequested || videoEnded,
          shouldAbort: commonAbort,
        }).then((r) => { audioEnded = true; return r; })
          .catch(() => null) // audio failure must not lose the video recording
      : Promise.resolve(null);

    const [video, audio] = await Promise.all([videoP, audioP]);

    if (!video || !video.data.length) throw new Error("Nothing captured — no segments were recorded.");

    // Assemble the file(s) but DON'T write to disk yet — hold them in the temp
    // cache and let the user commit with Save (or drop them by closing the tab).
    const files = [];
    let mergeCmd = null;
    if (audio && audio.data.length) {
      // Preferred path: mux video + audio into ONE mp4 in-browser. Only fMP4
      // (both have an init segment → ext "mp4") can be combined this way.
      let muxed = null;
      if (video.ext === "mp4" && audio.ext === "mp4" && self.Mux) {
        try {
          muxed = self.Mux.combineFmp4(video.data, audio.data);
          dlog("muxed video+audio into one mp4", muxed.length + " bytes");
        } catch (e) {
          dlog("mux failed, falling back to two files:", e.message);
        }
      }
      if (muxed) {
        files.push({ bytes: muxed, mime: "video/mp4", ext: "mp4", suffix: "" });
      } else {
        // Fallback: two files + a one-line ffmpeg merge (never lose the capture).
        files.push({ bytes: video.data, mime: video.mime, ext: video.ext, suffix: "-video" });
        files.push({ bytes: audio.data, mime: audio.mime, ext: audio.ext, suffix: "-audio" });
        mergeCmd = self.Commands.ffmpegMerge(base + "-video." + video.ext, base + "-audio." + audio.ext, base);
      }
    } else {
      files.push({ bytes: video.data, mime: video.mime, ext: video.ext, suffix: "" });
      // fMP4 was timeline-reset in-browser; a raw .ts can't be, so offer a remux
      // command that rebuilds its duration (fixes the "hours-long in VLC" seek bar).
      if (video.ext === "ts") dl.fixCommand = self.Commands.ffmpegRemux(base + ".ts", base + "-fixed");
    }
    pendingSaves.set(id, { tabId, base, files, mergeCmd });

    dl.status = "stopped";              // recorded, awaiting Save
    dl.mergeCommand = mergeCmd;
    dl.recorded = { bytes: vBytes + aBytes, duration: video.duration, segments: video.segments };
    broadcast({ type: "download-update", download: dl });
    dlog("recording stopped, held for save", id, dl.recorded);
  } catch (e) {
    dl.status = "error";
    dl.error = e.message || String(e);
    broadcast({ type: "download-update", download: dl });
    setTimeout(() => activeDownloads.delete(id), 120000);
  }
  // Note: a "stopped" recording is intentionally NOT auto-expired — it lives
  // until Save, Discard, or its tab closes.
}

// Commit a held (in-browser) recording to disk. opts.saveAs shows the dialog.
// On failure the cache is kept so the user can retry.
async function saveRecording(id, opts) {
  opts = opts || {};
  const pend = pendingSaves.get(id);
  const dl = activeDownloads.get(id);
  if (!pend) return;
  if (dl) { dl.status = "saving"; broadcast({ type: "download-update", download: dl }); }
  let mainId = null;
  try {
    for (const f of pend.files) {
      const dlId = await saveBytes(f.bytes, f.mime, pend.base + f.suffix, f.ext, { saveAs: opts.saveAs !== false });
      if (mainId == null || f.suffix === "") mainId = dlId; // prefer the single/base file
    }
  } catch (e) {
    if (dl) { dl.status = "stopped"; dl.error = e.message || String(e); broadcast({ type: "download-update", download: dl }); }
    return; // keep it cached so the user can retry
  }
  pendingSaves.delete(id);
  if (dl) { dl.status = "done"; broadcast({ type: "download-update", download: dl }); recordSavedFile(dl, mainId); }
  addHistory({ name: pend.base, kind: "hls-live", ts: Date.now() });
  notifyDone(pend.base, pend.mergeCmd
    ? "Saved as video + audio — run the merge command."
    : "Recording saved.",
    mainId != null ? { downloadId: mainId } : null);
  setTimeout(() => activeDownloads.delete(id), DONE_RETAIN_MS);
}

// Throw away a held recording without saving (explicit Discard, or tab closed).
function discardRecording(id, reason) {
  if (!pendingSaves.has(id)) return;
  pendingSaves.delete(id);           // drop the bytes -> eligible for GC
  const dl = activeDownloads.get(id);
  if (dl) {
    dl.status = "discarded";
    dl.error = reason || null;
    broadcast({ type: "download-update", download: dl });
  }
  dlog("recording discarded", id, reason || "");
  setTimeout(() => activeDownloads.delete(id), 30000);
}

// Drop any unsaved recordings captured from a tab that's going away.
function discardTabRecordings(tabId) {
  for (const [id, pend] of pendingSaves.entries()) {
    if (pend.tabId === tabId) discardRecording(id, "Source tab closed before saving.");
  }
}

// Resolve the media playlist URL to record: a given variant, or (for a master)
// the default-quality variant, or the item URL itself for a media playlist.
async function resolveVideoUrl(item, tabId, variantUrl) {
  if (variantUrl) return variantUrl;
  const text = await fetchText(tabId, item.url);
  const parsed = self.HLS.parsePlaylist(text, item.url);
  if (parsed.type === "master") {
    if (!parsed.variants.length) throw new Error("Master playlist had no variants.");
    return pickVariant(parsed.variants, null).uri;
  }
  return item.url;
}

// ---- DASH download ----
async function downloadDash(item, tabId, filename, chosenVariantId) {
  const id = ++downloadCounter;
  const dl = { id, url: item.url, status: "parsing", progress: { done: 0, total: 0 }, name: filename };
  activeDownloads.set(id, dl);
  broadcast({ type: "download-update", download: dl });
  try {
    const text = await fetchText(tabId, item.url);
    const parsed = self.DASH.parse(text, item.url);
    if (parsed.drm) throw new Error("DASH stream is DRM-protected (ContentProtection present). Not supported.");
    if (parsed.isDynamic) throw new Error("Live DASH — only a recording window can be captured.");
    if (!parsed.video.length) throw new Error("No video representations found.");

    const rep =
      (chosenVariantId && parsed.video.find((v) => v.id === chosenVariantId)) ||
      (settings.defaultQuality === "lowest" ? parsed.video[parsed.video.length - 1] : parsed.video[0]);

    const toMedia = (r) => ({
      map: r.init ? { uri: r.init.uri } : null,
      segments: r.segments.map((s, i) => ({ uri: s.uri, byteRange: s.byteRange || null, key: null, seq: i })),
      isLive: false, encryption: null,
    });

    const base = sanitizeFilename(filename || item.name || "video").replace(/\.mpd.*$/i, "");
    const hasAudio = parsed.audio.length > 0;
    dl.status = "downloading";
    dl.hasAudio = hasAudio;
    broadcast({ type: "download-update", download: dl });

    const video = await self.HLS.downloadMedia(toMedia(rep), {
      fetchFn: makeFetchFn(tabId), concurrency: settings.concurrency, containerHint: "mp4",
      onProgress: (p) => { dl.progress = p; broadcast({ type: "download-update", download: dl }); },
      shouldAbort: () => dl.status === "cancelled",
    });
    const videoDlId = await saveBytes(video.data, video.mime, hasAudio ? base + "-video" : base, "mp4");

    let mergeCmd = null;
    if (hasAudio) {
      dl.status = "audio";
      broadcast({ type: "download-update", download: dl });
      const arep = parsed.audio[0];
      const audio = await self.HLS.downloadMedia(toMedia(arep), {
        fetchFn: makeFetchFn(tabId), concurrency: settings.concurrency, containerHint: "m4a",
        onProgress: (p) => { dl.progress = p; broadcast({ type: "download-update", download: dl }); },
        shouldAbort: () => dl.status === "cancelled",
      });
      await saveBytes(audio.data, audio.mime, base + "-audio", "m4a");
      mergeCmd = self.Commands.ffmpegMerge(base + "-video.mp4", base + "-audio.m4a", base);
      dl.mergeCommand = mergeCmd;
    }

    dl.status = "done";
    broadcast({ type: "download-update", download: dl });
    recordSavedFile(dl, videoDlId);
    addHistory({ name: base, kind: "dash", ts: Date.now() });
    notifyDone(base, mergeCmd ? "Saved video + audio separately — run the merge command." : null,
      videoDlId != null ? { downloadId: videoDlId } : null);
  } catch (e) {
    dl.status = "error";
    dl.error = e.message || String(e);
    broadcast({ type: "download-update", download: dl });
  } finally {
    setTimeout(() => activeDownloads.delete(id), DONE_RETAIN_MS);
  }
}

// ---- Command export, history, notifications ----
function resolveHeaders(tabId) {
  const ctx = tabContext.get(tabId) || {};
  return { referer: ctx.referer, userAgent: ctx.userAgent };
}

function buildCommand(item, tabId, tool, variantUrl) {
  const hdr = resolveHeaders(tabId);
  const url = variantUrl || item.url;
  const out = self.Filename.render(settings.filenameTemplate, {
    title: item.pageTitle || item.name, host: (function () { try { return new URL(item.url).hostname; } catch (e) { return ""; } })(),
    name: item.name,
  });
  return self.Commands.build(tool, url, { referer: hdr.referer, userAgent: hdr.userAgent, output: out });
}

async function addHistory(entry) {
  try {
    const r = await api.storage.local.get("history");
    const hist = (r && r.history) || [];
    hist.unshift(entry);
    await api.storage.local.set({ history: hist.slice(0, 100) });
  } catch (e) {}
}

// notification id -> how to open the saved file when the notification is clicked
const notifyActions = new Map();
let notifCounter = 0;

// `action`: { path } to open a disk file via the helper, or { downloadId } to
// open a browser download. Clicking the notification opens the file.
function fmtBytes(n) {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB"]; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

// One notification line describing the re-encode outcome: before/after sizes,
// percent change, and which version was kept.
function convertSummary(c) {
  if (!c) return null;
  const label = (c.codec || "h265") === "av1" ? "AV1" : "H.265";
  const src = c.srcBytes, enc = c.hevcBytes;
  if (c.converted) {
    const pct = src ? Math.round((1 - enc / src) * 100) : 0;
    return "Kept " + label + " · " + fmtBytes(src) + " → " + fmtBytes(enc) + " · " + pct + "% smaller";
  }
  if (enc == null) return c.note ? "Kept original · " + c.note : "Kept original · " + label + " conversion failed";
  const pct = src ? Math.round((enc / src - 1) * 100) : 0;
  return "Kept original · " + label + " would be " + fmtBytes(enc) + " vs " + fmtBytes(src) + " (" + pct + "% larger)";
}

function notifyDone(name, extra, action) {
  if (!settings.notifications) return;
  const id = "mc-" + (++notifCounter);
  try {
    api.notifications.create(id, {
      type: "basic",
      iconUrl: api.runtime.getURL("icons/icon-96.png"),
      title: "Media Catcher",
      message: "Saved " + name + (extra ? "\n" + extra : "") + "\nClick to open.",
    });
    if (action) notifyActions.set(id, action);
  } catch (e) {}
}

// Open the bundled setup page that walks the user through installing the native
// helper. Focuses an existing setup tab instead of piling up duplicates.
function openSetupPage() {
  const url = api.runtime.getURL(HELPER_SETUP_PAGE);
  try {
    if (api.tabs && api.tabs.query) {
      api.tabs.query({}, (tabs) => {
        const open = (tabs || []).find((t) => t.url && t.url.indexOf(url) === 0);
        if (open) api.tabs.update(open.id, { active: true });
        else api.tabs.create({ url });
      });
    } else {
      api.tabs.create({ url });
    }
  } catch (e) { try { api.tabs.create({ url }); } catch (e2) {} }
}

// Nudge once per session when the helper is missing; clicking opens the setup page.
let helperMissingNotified = false;
function promptInstallHelper() {
  if (helperMissingNotified) return;
  helperMissingNotified = true;
  if (!api.notifications) { openSetupPage(); return; }
  try {
    const id = "mc-helper-missing";
    api.notifications.create(id, {
      type: "basic",
      iconUrl: api.runtime.getURL("icons/icon-96.png"),
      title: "Media Catcher — recorder helper needed",
      message: "Recording to a file needs a small helper. Click to set it up.",
    });
    notifyActions.set(id, { url: api.runtime.getURL(HELPER_SETUP_PAGE) });
  } catch (e) {}
}

if (api.notifications && api.notifications.onClicked) {
  api.notifications.onClicked.addListener((id) => {
    const action = notifyActions.get(id);
    if (!action) return;
    notifyActions.delete(id);
    try { api.notifications.clear(id); } catch (e) {}
    if (action.path) {
      if (nativePort) nativePort.postMessage({ cmd: "open", path: action.path });
    } else if (action.url) {
      try { api.tabs.create({ url: action.url }); } catch (e) {}
    } else if (action.downloadId != null && api.downloads) {
      const openIt = api.downloads.open && api.downloads.open(action.downloadId);
      if (openIt && openIt.catch) openIt.catch(() => { try { api.downloads.show(action.downloadId); } catch (e) {} });
      else { try { api.downloads.show(action.downloadId); } catch (e) {} }
    }
  });
  // Drop the mapping if the user dismisses the notification.
  if (api.notifications.onClosed) {
    api.notifications.onClosed.addListener((id) => notifyActions.delete(id));
  }
}

// Fetch and parse a master playlist to list quality options for the popup.
async function getVariants(item, tabId) {
  const text = await fetchText(tabId, item.url);
  const parsed = self.HLS.parsePlaylist(text, item.url);
  if (parsed.type === "master") {
    return {
      isMaster: true,
      variants: parsed.variants.map((v) => ({
        uri: v.uri,
        label:
          (v.resolution || (v.height ? v.height + "p" : "unknown")) +
          (v.bandwidth ? " · " + Math.round(v.bandwidth / 1000) + " kbps" : ""),
        height: v.height,
        bandwidth: v.bandwidth,
      })),
    };
  }
  return {
    isMaster: false,
    isLive: parsed.isLive,
    segments: parsed.segments.length,
    encrypted: !!parsed.encryption,
  };
}

// Best-known bitrate for ranking renditions (bps). Prefers a declared master
// bandwidth, falls back to the sampled estimate.
function itemBitrate(it) {
  if (it.bandwidth) return it.bandwidth;
  if (it.estKbps) return it.estKbps * 1000;
  return 0;
}

// Group signature = the stream's DIRECTORY (digit-normalized), not the filename.
// Every rendition AND the separate audio track of one live stream live in the
// same directory (…/streams/origin.name.<id>/chunklist_<level>_<video|audio>_…),
// so grouping by directory collapses all of them together — then the single
// highest-bitrate member (always the top video) is what survives. Filename-based
// grouping failed here because video/audio use different names and ids.
function renditionGroup(url) {
  try {
    const u = new URL(url);
    const dir = u.pathname.replace(/[^/]*$/, "");   // keep trailing slash
    return u.origin + dir.replace(/\d+/g, "#");
  } catch (e) { return url; }
}

// A direct file below the size floor is almost always noise (tip sounds, avatars,
// preview loops). Applies only to direct items with a known content-length —
// HLS/DASH manifests are tiny by nature and must never be size-filtered.
function isTooSmall(it) {
  const min = (settings.minDirectSizeMB || 0) * 1024 * 1024;
  return min > 0 && it.kind === "direct" && it.size > 0 && it.size < min;
}

// An HLS/DASH playlist whose manifest couldn't be fetched/parsed (403, dead
// token, gone offline) is not recordable — hide it rather than offer a button
// that only 403s.
function isDeadPlaylist(it) {
  return (it.kind === "hls" || it.kind === "dash") && it.enrichState === "error";
}

// The probe confirmed this direct URL is a web page (HTML) or a dead link (4xx/5xx) —
// not a downloadable video. Hide it instead of showing a "NOT A VIDEO" row with a
// Download button. Merely "unverified" items (probe inconclusive) still show.
function isNotVideo(it) {
  return it.kind === "direct" && it.junk && (it.container === "html" || it.probeStatus >= 400);
}

// The items a tab should actually surface: not a master's child, not sub-floor
// noise, not a dead playlist, not a confirmed non-video, and collapsed to the highest
// rendition. Shared by the popup list and the toolbar badge so the two always agree.
function visibleFor(tabId) {
  const map = mediaByTab.get(tabId);
  if (!map) return [];
  let items = Array.from(map.values())
    .filter((it) => !isChild(tabId, it.url) && !isTooSmall(it) && !isDeadPlaylist(it) && !isNotVideo(it));
  if (settings.preferHighestRendition) items = keepHighestRendition(items);
  return items;
}

// When several renditions of one stream are present, keep only the highest
// bitrate; drop the rest. Non-HLS, masters, and single-member groups pass
// through untouched.
function keepHighestRendition(items) {
  const groups = new Map();
  const passthrough = [];
  for (const it of items) {
    if (it.kind !== "hls" || it.isMaster || it.drm) { passthrough.push(it); continue; }
    const g = renditionGroup(it.url);
    (groups.get(g) || groups.set(g, []).get(g)).push(it);
  }
  const kept = [];
  for (const [sig, members] of groups.entries()) {
    if (members.length === 1) { kept.push(members[0]); continue; }
    let best = members[0];
    for (const m of members) if (itemBitrate(m) > itemBitrate(best)) best = m;
    dlog("collapse group", sig, "kept", Math.round(itemBitrate(best) / 1000) + "kbps",
      "from", members.map((m) => Math.round(itemBitrate(m) / 1000) + "k").join("/"));
    best = Object.assign({}, best, { renditionsHidden: members.length - 1 });
    kept.push(best);
  }
  return passthrough.concat(kept);
}

function copyLiveVariantRow(row) {
  const out = {};
  if (!row || typeof row !== "object") return out;
  for (const key of ["id", "label", "width", "height", "bandwidth", "mime"]) {
    const value = row[key];
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

function liveRowsForTab(tabId) {
  if (!liveController || !liveControllerTabs.has(tabId)) return [];
  try {
    const rows = liveController.popupMedia(tabId);
    const ids = liveControllerMediaIds.get(tabId);
    if (!Array.isArray(rows) || !ids) return [];
    return foldRemountedDirectRows(tabId, rows.filter((row) => row && ids.has(row.id)));
  } catch (e) {
    dlog("live popupMedia failed", e && e.message);
    return [];
  }
}

// An SPA that remounts its player iframe gives the new frame a new frameId and
// an empty boundUrls set, so it reports the file the old mount already reported
// and mints a second detection with nothing to tell the two rows apart.
//
// Folded here rather than by keying the claim on frame origin: an origin-scoped
// claim would let any frame sharing the page's origin take the single row and
// leave the other frame with none, which is the suppression per-frame claim
// scoping exists to prevent — and a frame's origin reaches us through the
// content script, where its frameId comes from the browser. So a row folds only
// when it names the same canonical source AND is indistinguishable in what the
// popup shows. A frame proposing its own name for the page's file still gets
// its own row. Of a folded pair the owning row is kept: enrichment lands there.
function foldRemountedDirectRows(tabId, rows) {
  const sources = liveDirectRowSources.get(tabId);
  if (!sources || rows.length < 2) return rows;
  const owners = liveDirectMediaOwners.get(tabId);
  const firstAt = new Map();
  const out = [];
  for (const row of rows) {
    const sourceKey = sources.get(row.id);
    if (typeof sourceKey !== "string") { out.push(row); continue; }
    const identity = [
      sourceKey,
      typeof row.kind === "string" ? row.kind : "",
      typeof row.proposedFilename === "string" ? row.proposedFilename : "",
    ].join("\n");
    const at = firstAt.get(identity);
    if (at === undefined) {
      firstAt.set(identity, out.length);
      out.push(row);
    } else if (owners && owners.get(sourceKey) === row.id) {
      out[at] = row;
    }
  }
  return out;
}

function decorateLiveRow(row, tabId) {
  if (!row || typeof row !== "object" || typeof row.id !== "string") return null;
  const out = {
    id: row.id,
    proposedFilename: typeof row.proposedFilename === "string" ? row.proposedFilename : "download",
    kind: typeof row.kind === "string" ? row.kind : "direct",
    variants: Array.isArray(row.variants) ? row.variants.map(copyLiveVariantRow) : [],
    tabId,
    thumb: tabThumbs.get(tabId) || null,
  };
  // Only the validated scalar pair crosses into the public row — never the
  // record itself and never any raw evidence it was derived from.
  const size = liveSizeMetadata.get(row.id);
  if (size) {
    out.sizeBytes = size.sizeBytes;
    out.sizeConfidence = size.sizeConfidence;
  }
  const title = tabTitle(tabId);
  if (title) out.pageTitle = title;
  return out;
}

function livePopupJobs() {
  if (!liveController) return [];
  try {
    const jobs = liveController.popupJobs();
    if (!Array.isArray(jobs)) return [];
    return jobs.map((job) => Object.assign({}, job));
  } catch (e) {
    dlog("live popupJobs failed", e && e.message);
    return [];
  }
}

function readOwnActionId(record) {
  try {
    if (!record || (typeof record !== "object" && typeof record !== "function")) {
      return { present: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, "id");
    if (!descriptor) return { present: false };
    if (descriptor.get || descriptor.set || !("value" in descriptor)) {
      return { present: true, kind: "invalid" };
    }
    if (typeof descriptor.value === "string") {
      return { present: true, kind: "string", value: descriptor.value };
    }
    if (typeof descriptor.value === "number" && Number.isFinite(descriptor.value)) {
      return { present: true, kind: "number", value: descriptor.value };
    }
    return { present: true, kind: "invalid" };
  } catch (e) {
    return { present: true, kind: "invalid" };
  }
}

async function runLiveControllerAction(sender, action) {
  try {
    await settingsReady;
    if (!liveController || !isExtensionActionSender(sender)) {
      return { ok: false, error: "Download action rejected." };
    }
    const job = await action(liveController);
    if (!job || typeof job !== "object") {
      return { ok: false, error: "Download action rejected." };
    }
    return { ok: true, job };
  } catch (e) {
    return { ok: false, error: "Download action rejected." };
  }
}

// The main UI is an extension window, not a browser-action popup. A popup
// derives its size from its content and Firefox clips it, which left the
// Downloads rail cut off; a window has a real viewport, is resizable, and
// cannot clip. Same ownership pattern as the Save As window below.
let mainWindowId = null;

// A browser-action popup could ask for {active:true, currentWindow:true}; an
// extension window IS the current window, so it would find no tabs. The
// background tracks the browsing tab instead and the page asks for it.
let lastActiveTabId = null;

function noteActiveTab(tabId) {
  if (Number.isInteger(tabId) && tabId >= 0) lastActiveTabId = tabId;
}

api.tabs.onActivated.addListener((info) => { noteActiveTab(info && info.tabId); });

async function resolveActiveTab() {
  // Prefer the remembered browsing tab; fall back to querying, ignoring any
  // tab that belongs to one of our own extension windows.
  try {
    if (Number.isInteger(lastActiveTabId)) {
      const tab = await api.tabs.get(lastActiveTabId);
      if (tab && tab.windowId !== mainWindowId) return tab;
    }
  } catch (e) { lastActiveTabId = null; }
  try {
    const tabs = await api.tabs.query({ active: true });
    const usable = tabs.filter((tab) => tab && tab.windowId !== mainWindowId);
    if (usable.length) {
      noteActiveTab(usable[usable.length - 1].id);
      return usable[usable.length - 1];
    }
  } catch (e) {}
  return null;
}

async function openMainWindow() {
  if (!api.windows || typeof api.windows.create !== "function") return;
  if (mainWindowId !== null) {
    try {
      await api.windows.update(mainWindowId, { focused: true });
      return;
    } catch (e) {
      mainWindowId = null;
    }
  }
  await settingsReady;
  // Two panes need room; a single column does not.
  const wantRail = !!settings.showRail && (!!settings.showQueue || !!settings.enableCasting);
  try {
    const created = await api.windows.create({
      url: api.runtime.getURL("popup/popup.html"),
      type: "popup",
      width: wantRail ? 860 : 470,
      height: 680,
    });
    if (created && Number.isInteger(created.id)) mainWindowId = created.id;
  } catch (e) {
    dlog("main window failed", e && e.message);
  }
}

api.browserAction.onClicked.addListener(() => { openMainWindow(); });

// One Save As window per media/variant. Repeat clicks focus the live one.
const saveAsWindows = new Map();

function saveAsWindowKey(tabId, mediaId, variantId) {
  return tabId + "|" + mediaId + "|" + (variantId || "");
}

if (api.windows && api.windows.onRemoved) {
  api.windows.onRemoved.addListener((windowId) => {
    if (windowId === mainWindowId) mainWindowId = null;
    for (const [key, id] of saveAsWindows) {
      if (id === windowId) saveAsWindows.delete(key);
    }
  });
}

function knownExtensionFromFilename(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(typeof name === "string" ? name : "");
  return match ? "." + match[1].toLowerCase() : ".mp4";
}

// Fresh allowlist projection of an owned row. Never a spread, never a URL, and
// only the exact variant the caller already owns.
function safeSaveAsContext(tabId, mediaId, variantId) {
  const row = liveRowsForTab(tabId).find((candidate) => candidate && candidate.id === mediaId);
  if (!row) return null;
  const safe = decorateLiveRow(row, tabId);
  if (!safe) return null;
  let ownedVariantId = null;
  if (variantId !== null && variantId !== undefined) {
    const variant = safe.variants.find((candidate) => candidate && candidate.id === variantId);
    if (!variant) return null;
    ownedVariantId = variant.id;
  }
  const context = {
    tabId,
    mediaId: safe.id,
    variantId: ownedVariantId,
    proposedFilename: safe.proposedFilename,
    knownExtension: knownExtensionFromFilename(safe.proposedFilename),
    kind: safe.kind,
  };
  if (Number.isInteger(safe.sizeBytes) && typeof safe.sizeConfidence === "string") {
    context.sizeBytes = safe.sizeBytes;
    context.sizeConfidence = safe.sizeConfidence;
  }
  return context;
}

async function openSaveAsWindow(tabId, mediaId, variantId) {
  if (!api.windows || typeof api.windows.create !== "function") {
    return { ok: false, error: "Save As window unavailable." };
  }
  const key = saveAsWindowKey(tabId, mediaId, variantId);
  const existing = saveAsWindows.get(key);
  if (existing !== undefined) {
    try {
      await api.windows.update(existing, { focused: true });
      return { ok: true, focused: true };
    } catch (e) {
      saveAsWindows.delete(key);
    }
  }
  let relative = "saveas/saveas.html?tabId=" + encodeURIComponent(String(tabId)) +
    "&mediaId=" + encodeURIComponent(mediaId);
  if (variantId) relative += "&variantId=" + encodeURIComponent(variantId);
  try {
    const created = await api.windows.create({
      url: api.runtime.getURL(relative),
      type: "popup",
      width: 520,
      height: 360,
    });
    if (created && Number.isInteger(created.id)) saveAsWindows.set(key, created.id);
    return { ok: true, focused: false };
  } catch (e) {
    return { ok: false, error: "Save As window unavailable." };
  }
}

function isUnpromotedManagedMedia(item) {
  if (!item || typeof item !== "object") return false;
  if (item.kind === "direct") return true;
  if (item.kind === "hls" || item.kind === "dash") return true;
  return false;
}

// ---- Messaging ----

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "get-media") {
        await settingsReady;
        const tabId = msg.tabId;
        let items;
        // decorate() attaches per-tab extras: thumbnail + backfilled title for
        // items detected before the content script reported the page info.
        const decorate = (it, tid) => Object.assign({}, it, {
          tabId: tid,
          thumb: tabThumbs.get(tid) || null,
          pageTitle: it.pageTitle || tabTitle(tid) || undefined,
        });
        // Kick a YouTube format probe for any not-yet-enriched item on the tab(s) —
        // covers the case where the helper connected after the item was detected.
        const kickYt = (tid) => { const m = mediaByTab.get(tid); if (m) for (const [k, it] of m) if (it.kind === "youtube") enrichYouTube(tid, k); };
        if (msg.allTabs) {
          items = [];
          const tids = new Set(mediaByTab.keys());
          for (const tid of liveControllerTabs) tids.add(tid);
          for (const tid of tids) {
            kickYt(tid);
            for (const it of visibleFor(tid)) items.push(decorate(it, tid));
            for (const row of liveRowsForTab(tid)) {
              const safe = decorateLiveRow(row, tid);
              if (safe) items.push(safe);
            }
          }
        } else {
          kickYt(tabId);
          items = visibleFor(tabId).map((it) => decorate(it, tabId));
          for (const row of liveRowsForTab(tabId)) {
            const safe = decorateLiveRow(row, tabId);
            if (safe) items.push(safe);
          }
        }
        items.sort((a, b) => (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0));
        sendResponse({
          items,
          downloads: livePopupJobs().concat(Array.from(activeDownloads.values())),
          helper: helperStatus(),
          cast: castState,
        });
      } else if (msg.type === "page-snapshot-context") {
        if (!sender.tab || !Number.isInteger(sender.tab.id)) {
          sendResponse({ ok: false });
        } else {
          if (typeof sender.tab.url === "string") {
            const ctx = tabContext.get(sender.tab.id) || {};
            ctx.topLevelPageUrl = sender.tab.url;
            tabContext.set(sender.tab.id, ctx);
          }
          sendResponse({
            ok: true,
            tabId: sender.tab.id,
            frameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
            documentId: typeof sender.documentId === "string" ? sender.documentId : null,
            topLevelPageUrl: typeof sender.tab.url === "string" ? sender.tab.url : "",
          });
        }
      } else if (msg.type === "page-snapshot") {
        await settingsReady;
        if (sender.tab && Number.isInteger(sender.tab.id) && typeof msg.topLevelPageUrl === "string") {
          const ctx = tabContext.get(sender.tab.id) || {};
          ctx.topLevelPageUrl = msg.topLevelPageUrl;
          tabContext.set(sender.tab.id, ctx);
        }
        if (liveController) liveController.acceptPageSnapshot(msg);
        sendResponse({ ok: true });
      } else if (msg.type === "helper-status") {
        sendResponse({ ok: true, helper: helperStatus() });
      } else if (msg.type === "recheck-helper") {
        recheckHelper();
        sendResponse({ ok: true, helper: helperStatus() });
      } else if (msg.type === "open-helper-setup") {
        openSetupPage();
        sendResponse({ ok: true });
      } else if (msg.type === "get-logs") {
        sendResponse({ logs: logRing.slice(-LOG_CAP), events: updateEvents.slice(-EVENT_CAP) });
      } else if (msg.type === "clear-logs") {
        logRing = [];
        api.storage.local.set({ mcLogs: [] }).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === "get-update-report") {
        // Ask the helper for a fresh diagnostics report (env + history tail + guardian
        // log tail), resolved when it replies with {type:"report"}. Falls back to the
        // buffered data if the helper isn't connected or doesn't answer in time.
        const extVersion = api.runtime.getManifest().version;
        let report = null;
        if (nativePort) {   // connected is enough — the report is useful even when ffmpeg is missing
          report = await new Promise((resolve) => {
            const reqId = "rpt-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
            pendingReports.set(reqId, resolve);
            try { nativePort.postMessage({ cmd: "getReport", reqId, extVersion }); }
            catch (e) { pendingReports.delete(reqId); resolve(null); }
            setTimeout(() => { if (pendingReports.has(reqId)) { pendingReports.delete(reqId); resolve(null); } }, 5000);
          });
        }
        sendResponse({ ok: true, extVersion, helper: helperStatus(), report,
          events: updateEvents.slice(-EVENT_CAP), logs: logRing.slice(-LOG_CAP) });
      } else if (msg.type === "run-probe") {
        // The probe times a real yt-dlp launch, so it is slower than the old
        // diagnostics call — allow for that rather than resolving null early and
        // reporting "no result" for a probe that is still working.
        let result = null;
        if (nativePort) {
          result = await new Promise((resolve) => {
            const reqId = "prb-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
            pendingProbes.set(reqId, resolve);
            try { nativePort.postMessage({ cmd: "probe", reqId }); }
            catch (e) { pendingProbes.delete(reqId); resolve(null); }
            // Must outlast the host's worst-case collection (a 60s launch timing
            // plus three 20s PowerShell calls). At 120s a slow-but-working probe
            // reported "no result" — the same silent-failure shape it exists to
            // expose. Keep in step with probe.UI_WAIT_SECONDS.
            setTimeout(() => { if (pendingProbes.has(reqId)) { pendingProbes.delete(reqId); resolve(null); } }, 300000);
          });
        }
        sendResponse({ ok: !!result, result, helper: helperStatus() });
      } else if (msg.type === "get-variants") {
        const info = await getVariants(msg.item, msg.tabId);
        sendResponse({ ok: true, info });
      } else if (msg.type === "download") {
        const { item, tabId, filename, variantUrl } = msg;
        const itemId = readOwnActionId(item);
        if (itemId.kind === "string") {
          sendResponse(await runLiveControllerAction(sender, (controller) => controller.enqueueDownload(msg, sender)));
        } else if (itemId.present) {
          sendResponse({ ok: false, error: "Download action rejected." });
        } else if (isUnpromotedManagedMedia(item)) {
          sendResponse({ ok: false, error: "This static media is not ready for the managed download queue." });
        } else if (item.kind === "hls") {
          downloadHls(item, tabId, filename, variantUrl);
          sendResponse({ ok: true });
        } else if (item.kind === "dash") {
          downloadDash(item, tabId, filename, msg.variantId);
          sendResponse({ ok: true });
        } else if (item.kind === "youtube") {
          downloadYouTube(item, tabId, filename, { height: msg.ytHeight, audioOnly: msg.ytAudioOnly });
          sendResponse({ ok: true });
        } else {
          await downloadDirect(item, tabId, filename);
          sendResponse({ ok: true });
        }
      } else if (msg.type === "get-active-tab") {
        // The main UI runs in an extension window, where a currentWindow query
        // would resolve to itself. Answer with the browsing tab instead.
        const tab = await resolveActiveTab();
        sendResponse(tab
          ? { ok: true, tabId: tab.id, title: tab.title || "", url: tab.url || "" }
          : { ok: false });
      } else if (msg.type === "open-save-as") {
        await settingsReady;
        const mediaId = readOwnActionId({ id: msg.mediaId });
        const variantId = msg.variantId == null ? null : msg.variantId;
        if (!isExtensionPopupSender(sender) ||
            mediaId.kind !== "string" || !isSafeOpaqueActionId(mediaId.value) ||
            !Number.isInteger(msg.tabId) || msg.tabId < 0 ||
            (variantId !== null && !isSafeOpaqueActionId(variantId)) ||
            !safeSaveAsContext(msg.tabId, mediaId.value, variantId)) {
          sendResponse({ ok: false, error: "Save As is unavailable for this item." });
        } else {
          sendResponse(await openSaveAsWindow(msg.tabId, mediaId.value, variantId));
        }
      } else if (msg.type === "get-save-as-context") {
        await settingsReady;
        const identity = parseSaveAsSender(sender);
        const context = identity
          ? safeSaveAsContext(identity.tabId, identity.mediaId, identity.variantId)
          : null;
        sendResponse(context
          ? { ok: true, context, helper: helperStatus() }
          : { ok: false, error: "Save As context unavailable." });
      } else if (msg.type === "save-as-download") {
        const identity = parseSaveAsSender(sender);
        const itemId = readOwnActionId(msg.item);
        const messageVariantId = msg.variantId == null ? null : msg.variantId;
        // The window's own URL is the authority; a mismatched message is inert.
        if (!identity || itemId.kind !== "string" ||
            itemId.value !== identity.mediaId ||
            msg.tabId !== identity.tabId ||
            messageVariantId !== identity.variantId) {
          sendResponse({ ok: false, error: "Download action rejected." });
        } else {
          sendResponse(await runLiveControllerAction(sender,
            (controller) => controller.enqueueDownload(msg, sender)));
        }
      } else if (msg.type === "retry-download") {
        const retryId = readOwnActionId(msg);
        if (retryId.kind !== "string") {
          sendResponse({ ok: false, error: "Download action rejected." });
        } else {
          sendResponse(await runLiveControllerAction(sender, (controller) => controller.manualRetry(retryId.value)));
        }
      } else if (msg.type === "use-firefox") {
        const firefoxId = readOwnActionId(msg);
        if (firefoxId.kind !== "string") {
          sendResponse({ ok: false, error: "Download action rejected." });
        } else {
          sendResponse(await runLiveControllerAction(sender, (controller) => controller.requestFirefoxHandoff(msg, sender)));
        }
      } else if (msg.type === "record-live") {
        const { item, tabId, filename, variantUrl } = msg;
        if (!nativePort) promptInstallHelper();   // works in-browser, but the helper is better — nudge once
        const videoUrl = await resolveVideoUrl(item, tabId, variantUrl);
        const quality = (item.bandwidth || item.estKbps || item.height)
          ? { resolution: item.resolution, height: item.height,
              bandwidth: item.bandwidth || (item.estKbps ? item.estKbps * 1000 : 0) }
          : null;
        recordLiveHls(item, tabId, filename, videoUrl, undefined, undefined, quality);
        sendResponse({ ok: true });
      } else if (msg.type === "stop-recording") {
        const dl = activeDownloads.get(msg.id);
        if (dl && dl.native && nativePort) nativePort.postMessage({ cmd: "stop", id: msg.id });
        else if (dl) dl.stopRequested = true;   // in-browser: finish window, then hold for Save
        sendResponse({ ok: true });
      } else if (msg.type === "snapshot-recording") {
        // Save what's captured so far without stopping (crash safety).
        const dl = activeDownloads.get(msg.id);
        if (dl && dl.native && nativePort) {
          nativePort.postMessage({ cmd: "snapshot", id: msg.id, base: sanitizeFilename(dl.name || "recording"), dir: settings.saveFolder || "" });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "Save-now needs the native helper." });
        }
      } else if (msg.type === "save-recording") {
        // Save = auto to the configured folder (helper) / Downloads (in-browser).
        const dl = activeDownloads.get(msg.id);
        if (dl && dl.native && nativePort) {
          dl.status = "saving"; broadcast({ type: "download-update", download: dl });
          nativePort.postMessage({ cmd: "save", id: msg.id, base: sanitizeFilename(dl.name || "recording"), dir: settings.saveFolder || "", convert: convertSpec() });
        } else {
          saveRecording(msg.id, { saveAs: false });
        }
        sendResponse({ ok: true });
      } else if (msg.type === "saveas-recording") {
        // Save As = choose the path per file (native dialog / browser Save-As).
        const dl = activeDownloads.get(msg.id);
        if (dl && dl.native && nativePort) {
          dl.status = "saving"; broadcast({ type: "download-update", download: dl });
          nativePort.postMessage({ cmd: "saveAs", id: msg.id, base: sanitizeFilename(dl.name || "recording"), dir: settings.saveFolder || "", convert: convertSpec() });
        } else {
          saveRecording(msg.id, { saveAs: true });
        }
        sendResponse({ ok: true });
      } else if (msg.type === "update-extension") {
        // Check GitHub for a newer release, then install the newest package
        // available (downloaded from GitHub or dropped in the folder manually).
        if (nativePort) {
          nativePort.postMessage({ cmd: "checkGithub", extVersion: api.runtime.getManifest().version, extDir: settings.updateExtDir || "", zipDir: settings.updateZipDir || "" });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "Native helper not connected — install it first." });
        }
      } else if (msg.type === "watch-updates") {
        // Turn the helper's package-folder watcher on/off.
        if (nativePort) {
          nativePort.postMessage({ cmd: "watch", enable: !!msg.enable,
            extDir: settings.updateExtDir || "", zipDir: settings.updateZipDir || "" });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "Native helper not connected." });
        }
      } else if (msg.type === "pick-folder") {
        if (nativePort) {
          const requestId = "fp" + (++downloadCounter);
          const timer = setTimeout(
            () => finishFolderPick(requestId, { status: "timeout" }),
            FOLDER_PICK_TIMEOUT_MS
          );
          pendingFolderPicks.set(requestId, { respond: sendResponse, timer });
          try {
            nativePort.postMessage({
              cmd: "pickFolder", requestId, reqId: requestId,
              dir: msg.dir || settings.saveFolder || "",
            });
          } catch (e) {
            finishFolderPick(requestId, { status: "error" });
          }
          return true;   // sendResponse called when the host replies
        }
        sendResponse({ ok: false, error: "folder_picker_failed" });
      } else if (msg.type === "discard-recording") {
        const dl = activeDownloads.get(msg.id);
        if (dl && dl.native && nativePort) nativePort.postMessage({ cmd: "discard", id: msg.id });
        else discardRecording(msg.id, "Discarded.");
        sendResponse({ ok: true });
      } else if (msg.type === "cast-discover") {
        if (!nativePort || !nativeReady) {
          sendResponse({ ok: false, error: "Casting needs the native helper — install/enable it first." });
        } else if (msg.warm && lastCastDevices.length) {
          // Warm open with a retained list: answer instantly (zero host round-trip)
          // while STILL kicking the host's warm rescan. No resolver is registered,
          // so the host's cached "cast-devices" reply can't double-settle this
          // response — the refresh reaches the popup via the "cast-devices-update"
          // broadcast instead.
          const reqId = "cd" + (++downloadCounter);
          try { nativePort.postMessage({ cmd: "cast", sub: "discover", reqId, warm: true }); } catch (e) {}
          sendResponse({ ok: true, devices: lastCastDevices });
        } else {
          const reqId = "cd" + (++downloadCounter);
          const devices = await new Promise((resolve) => {
            pendingCastDiscover.set(reqId, resolve);
            const req = { cmd: "cast", sub: "discover", reqId };
            if (msg.warm) req.warm = true;   // host replies from its cache, then rescans
            try { nativePort.postMessage(req); }
            catch (e) { pendingCastDiscover.delete(reqId); resolve(null); }
            // Generous: SSDP (5s) + per-device description fetches + the AirPlay listing scan.
            setTimeout(() => { if (pendingCastDiscover.has(reqId)) { pendingCastDiscover.delete(reqId); resolve(null); } }, 45000);
          });
          sendResponse({ ok: devices != null, devices: devices || [],
                         error: devices == null ? "Scan timed out — is the helper running?" : undefined });
        }
      } else if (msg.type === "cast-start") {
        if (!nativePort || !nativeReady) {
          sendResponse({ ok: false, error: "Casting needs the native helper." });
        } else {
          nativePort.postMessage({ cmd: "cast", sub: "start", id: msg.deviceId,
            device: msg.deviceName || "", url: msg.url || "", title: msg.title || "" });
          castState = { state: "loading", id: msg.deviceId, device: msg.deviceName || "",
                        title: msg.title || "", position: 0, duration: 0, protocol: "dlna" };
          broadcast({ type: "cast-update", cast: castState });
          mclog("info", "cast: " + (msg.title || msg.url) + " → " + (msg.deviceName || msg.deviceId));
          sendResponse({ ok: true });
        }
      } else if (msg.type === "cast-pair") {
        if (nativePort) nativePort.postMessage({ cmd: "cast", sub: "pair", id: msg.deviceId });
        sendResponse({ ok: !!nativePort, error: nativePort ? undefined : "Casting needs the native helper." });
      } else if (msg.type === "cast-pairPin") {
        if (nativePort) nativePort.postMessage({ cmd: "cast", sub: "pairPin", id: msg.deviceId, pin: msg.pin });
        sendResponse({ ok: !!nativePort });
      } else if (msg.type === "cast-pair-cancel") {
        if (nativePort) nativePort.postMessage({ cmd: "cast", sub: "pairCancel" });
        sendResponse({ ok: true });
      } else if (msg.type === "cast-control") {
        if (nativePort) nativePort.postMessage({ cmd: "cast", sub: "control", action: msg.action, value: msg.value });
        sendResponse({ ok: !!nativePort });
      } else if (msg.type === "cast-stop") {
        if (nativePort) nativePort.postMessage({ cmd: "cast", sub: "stop" });
        castState = { state: "idle" };
        broadcast({ type: "cast-update", cast: castState });
        sendResponse({ ok: true });
      } else if (msg.type === "get-command") {
        sendResponse({ ok: true, command: buildCommand(msg.item, msg.tabId, msg.tool, msg.variantUrl) });
      } else if (msg.type === "get-settings") {
        sendResponse({ ok: true, settings, defaults: DEFAULT_SETTINGS });
      } else if (msg.type === "set-settings") {
        const previousMaxConcurrent = settings.maxConcurrentDownloads;
        await saveSettings(msg.settings);
        if (liveController && settings.maxConcurrentDownloads !== previousMaxConcurrent) {
          await liveController.setMaxConcurrent(settings.maxConcurrentDownloads);
        }
        sendResponse({ ok: true, settings });
      } else if (msg.type === "get-history") {
        const r = await api.storage.local.get("history");
        sendResponse({ ok: true, history: (r && r.history) || [] });
      } else if (msg.type === "clear-history") {
        await api.storage.local.set({ history: [] });
        sendResponse({ ok: true });
      } else if (msg.type === "cancel") {
        const cancelId = readOwnActionId(msg);
        if (cancelId.kind === "string") {
          sendResponse(await runLiveControllerAction(sender, (controller) => controller.cancel(cancelId.value)));
        } else if (cancelId.kind === "number") {
          const dl = activeDownloads.get(cancelId.value);
          if (dl) dl.status = "cancelled";
          // Browser-run loops poll dl.status, but yt-dlp runs INSIDE the helper —
          // a flag it never sees, so the process kept downloading and the row sat
          // on "Preparing" forever. Legacy yt-dlp ops are keyed by id alone, so
          // OMIT attemptToken: the host treats a PRESENT key as a token check and
          // would no-op the cancel. Unknown ids are a host-side no-op.
          if (nativePort) {
            try { nativePort.postMessage({ cmd: "pget-cancel", id: cancelId.value }); }
            catch (e) { /* helper gone — the flag above still stops browser-run work */ }
          }
          if (dl) broadcast({ type: "download-update", download: dl });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "Download action rejected." });
        }
      } else if (msg.type === "open-file") {
        // Popup "Open" on a helper-saved file. Browser-API saves are opened by
        // the popup itself via downloads.open (that call needs the user-input
        // context of the popup click).
        if (nativePort && nativeReady) { nativePort.postMessage({ cmd: "open", path: msg.path }); sendResponse({ ok: true }); }
        else sendResponse({ ok: false, error: "Native helper not available." });
      } else if (msg.type === "reveal-file") {
        if (nativePort && nativeReady) { nativePort.postMessage({ cmd: "reveal", path: msg.path }); sendResponse({ ok: true }); }
        else sendResponse({ ok: false, error: "Native helper not available." });
      } else if (msg.type === "open-in-badapple") {
        // Only the file crosses the port. The helper decides which executable
        // BadApple is; naming one from here is the arbitrary-execution hole
        // the open/reveal allowlist exists to close, so there is no field for
        // it in the frame and none is added.
        if (nativePort && nativeReady) { nativePort.postMessage({ cmd: "badapple", path: msg.path }); sendResponse({ ok: true }); }
        else sendResponse({ ok: false, error: "Native helper not available." });
      } else if (msg.type === "dismiss-download") {
        activeDownloads.delete(msg.id);
        sendResponse({ ok: true });
      } else if (msg.type === "clear") {
        mediaByTab.delete(msg.tabId);
        forgetLiveSizesForTab(msg.tabId);
        liveControllerTabs.delete(msg.tabId);
        liveControllerMediaIds.delete(msg.tabId);
        livePromotedKeys.delete(msg.tabId);
        liveDirectSourceKeys.delete(msg.tabId);
        childUrls.delete(msg.tabId);
        updateBadge(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === "content-media") {
        // From content script: a <video> element src.
        if (sender.tab) {
          const item = msg.item;
          if (item && item.kind === "direct" && msg.snapshot) {
            await settingsReady;
          }
          if (item && item.kind === "direct" && msg.snapshot && liveController) {
            const mediaUrl = item.url;
            const key = directGroupKey(mediaUrl);
            const frameKey = senderFrameKey(sender);
            if (!domSourceAlreadyClaimed(sender.tab.id, mediaUrl, frameKey)) {
              let mediaOrigin = "";
              try { mediaOrigin = new URL(mediaUrl).origin; } catch (e) {}
              const mediaId = liveController.captureDomMedia({
                mediaUrl,
                mediaOrigin,
                contentDisposition: null,
                referrerUrl: typeof msg.referrerUrl === "string" ? msg.referrerUrl : "",
                frameOrigin: typeof msg.frameOrigin === "string" ? msg.frameOrigin : "",
                ts: Number.isFinite(item.ts) ? item.ts : 0,
                snapshot: msg.snapshot,
                transport: { mediaKind: "direct", requestHeaders: null },
              });
              // DOM owns only this exact canonical media URL. The broader
              // directGroupKey is a network mirror policy and must not collapse
              // distinct query-addressed DOM media.
              claimLiveMediaKey(sender.tab.id, key, mediaId, [mediaUrl], false, frameKey);
              rememberLiveDirectRowSource(sender.tab.id, mediaId, mediaUrl);
            }
          } else {
            item.name = item.name || shortName(item.url);
            addMedia(sender.tab.id, item);
          }
        }
        sendResponse({ ok: true });
      } else if (msg.type === "page-info") {
        // From content script (top frame): page + og:title for naming.
        if (sender.tab) {
          const tid = sender.tab.id;
          const ctx = tabContext.get(tid) || {};
          ctx.pageTitle = msg.title;
          ctx.ogTitle = msg.ogTitle;
          tabContext.set(tid, ctx);
          if (mediaByTab.has(tid)) broadcast({ type: "media-updated", tabId: tid });
        }
        sendResponse({ ok: true });
      } else if (msg.type === "content-thumb") {
        // From the top frame's content script: a JPEG frame of the playing
        // video. tabThumbs holds one picture per tab and decorate() attaches it
        // to every row of that tab, so a subframe must not be able to set it.
        if (sender.tab && senderFrameKey(sender) === 0 &&
            typeof msg.dataUrl === "string" &&
            msg.dataUrl.startsWith("data:image/jpeg") && msg.dataUrl.length < 200000) {
          tabThumbs.set(sender.tab.id, msg.dataUrl);
          if (mediaByTab.has(sender.tab.id)) broadcast({ type: "media-updated", tabId: sender.tab.id });
        }
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async
});

// ---- Cleanup ----
// Abort any in-flight recording on a tab and drop its unsaved cache — the
// recording is only as durable as its source tab until it's Saved.
function endTabRecordings(tabId) {
  for (const dl of activeDownloads.values()) {
    if (dl.tabId !== tabId || !dl.live) continue;
    // Native jobs: tell the helper to drop the temp file (recording or stopped).
    if (dl.native && nativePort && (dl.status === "recording" || dl.status === "stopped")) {
      nativePort.postMessage({ cmd: "discard", id: dl.id });
    } else if (dl.status === "recording") {
      dl.status = "cancelled";       // in-browser: abort the poll loop
    }
  }
  discardTabRecordings(tabId);
}

api.tabs.onRemoved.addListener((tabId) => {
  endTabRecordings(tabId);
  mediaByTab.delete(tabId);
  forgetLiveSizesForTab(tabId);
  liveControllerTabs.delete(tabId);
  liveControllerMediaIds.delete(tabId);
  livePromotedKeys.delete(tabId);
  liveDirectSourceKeys.delete(tabId);
  tabContext.delete(tabId);
  childUrls.delete(tabId);
  tabThumbs.delete(tabId);
  segDirsByTab.delete(tabId);
  audioTrackByTab.delete(tabId);
});
// Clear a tab's captured list on top-level navigation to a new page.
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    endTabRecordings(tabId);
    mediaByTab.delete(tabId);
    forgetLiveSizesForTab(tabId);
    liveControllerTabs.delete(tabId);
    liveControllerMediaIds.delete(tabId);
    livePromotedKeys.delete(tabId);
    liveDirectSourceKeys.delete(tabId);
    tabContext.delete(tabId);
    childUrls.delete(tabId);
    tabThumbs.delete(tabId);
    segDirsByTab.delete(tabId);
    audioTrackByTab.delete(tabId);
    updateBadge(tabId);
  }
});

// ---- Context menu: copy a yt-dlp command for a link/media element ----
function setupContextMenu() {
  if (!api.contextMenus) return;
  try {
    api.contextMenus.removeAll(() => {
      api.contextMenus.create({
        id: "mc-ytdlp",
        title: "Media Catcher: copy yt-dlp command",
        contexts: ["link", "video", "audio"],
      });
    });
  } catch (e) {}
}
setupContextMenu();
api.runtime.onInstalled && api.runtime.onInstalled.addListener((details) => {
  setupContextMenu();
  // First install (e.g. the signed .xpi on regular Firefox): walk the user
  // through installing the native helper.
  if (details && details.reason === "install") openSetupPage();
});

// Connect to the native helper (if installed) so recording can hand off to it.
connectNative();

api.contextMenus &&
  api.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "mc-ytdlp") return;
    const url = info.linkUrl || info.srcUrl;
    if (!url || !tab) return;
    const hdr = resolveHeaders(tab.id);
    const cmd = self.Commands.ytdlp(url, {
      referer: hdr.referer || tab.url,
      userAgent: hdr.userAgent,
      output: self.Filename.render(settings.filenameTemplate, { title: tab.title }),
    });
    // Copy via an injected snippet (context-menu click is a user gesture).
    const escaped = JSON.stringify(cmd);
    api.tabs.executeScript(tab.id, {
      code:
        "navigator.clipboard.writeText(" + escaped + ").catch(function(){" +
        "var t=document.createElement('textarea');t.value=" + escaped + ";" +
        "document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();});",
    }).catch(() => {});
    notifyDone("command copied", "Paste into a terminal with yt-dlp installed.");
  });
