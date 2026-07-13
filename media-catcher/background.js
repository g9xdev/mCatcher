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
  updateZipDir: "",             // where update .zip packages land ("" = Downloads)
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

api.storage.local.get(["settings", "pd4done", "dq1done"]).then((r) => {
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
}).catch(() => {});

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
const pendingYtMeta = new Map();    // reqId -> resolver, settled by a host "ytmeta"

api.storage.local.get(["mcLogs", "mcEvents"]).then((r) => {
  // Merge (don't overwrite): lines pushed synchronously during startup — e.g. the
  // "connecting to the native helper…" line — must survive the async restore.
  if (r && Array.isArray(r.mcLogs)) logRing = r.mcLogs.concat(logRing).slice(-LOG_CAP);
  if (r && Array.isArray(r.mcEvents)) updateEvents = r.mcEvents.concat(updateEvents).slice(-EVENT_CAP);
  _persistDiag();
}).catch(() => {});

function _persistDiag() {
  if (_logSaveTimer) return;
  _logSaveTimer = setTimeout(() => {
    _logSaveTimer = null;
    api.storage.local.set({ mcLogs: logRing.slice(-LOG_CAP), mcEvents: updateEvents.slice(-EVENT_CAP) }).catch(() => {});
  }, 800);
}

function pushLog(line) {
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
const pendingFolderPicks = new Map();

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
    error: nativeError,
  };
}

// YouTube (and any yt-dlp-supported site): hand the canonical URL to the native
// helper, which runs yt-dlp (best video+audio, merged) with the PO-token provider
// and Firefox cookies. Progress/done/error arrive as ytdl-* native messages.
async function downloadYouTube(item, tabId, filename, opts) {
  opts = opts || {};
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
  try {
    nativePort = api.runtime.connectNative(NATIVE_HOST);
    nativePort.onMessage.addListener(onNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      const err = api.runtime.lastError && api.runtime.lastError.message;
      dlog("native host disconnected", err || "");
      mclog("warn", "native helper disconnected" + (err ? ": " + err : ""));
      nativePort = null; nativeInfo = null;
      setNativeState("disconnected", err || "Helper not installed.");
    });
    nativePort.postMessage({ cmd: "ping" });
  } catch (e) {
    dlog("native connect failed", e.message || e);
    nativePort = null;
    setNativeState("disconnected", e.message || String(e));
  }
}

function onNativeMessage(msg) {
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
  if (msg.type === "ytmeta") {
    const res = pendingYtMeta.get(msg.reqId);
    if (res) { pendingYtMeta.delete(msg.reqId); res(msg); }
    return;
  }
  if (msg.type === "pong") {
    nativeInfo = msg;
    setNativeState(msg.ffmpeg ? "ready" : "no-ffmpeg",
      msg.ffmpeg ? null : "Helper is installed but ffmpeg was not found.");
    dlog("native helper", msg.ffmpeg ? "ready (ffmpeg ok)" : "connected but ffmpeg missing", msg.ffmpegPath || "");
    mclog("info", "helper ready — v" + (msg.version || "?") + (msg.ffmpeg ? "" : " · ffmpeg MISSING"));
    if (settings.autoUpdate && nativePort) {
      nativePort.postMessage({ cmd: "watch", enable: true,
        extDir: settings.updateExtDir || "", zipDir: settings.updateZipDir || "" });
      nativePort.postMessage({ cmd: "checkGithub", auto: true, extVersion: api.runtime.getManifest().version,
        extDir: settings.updateExtDir || "", zipDir: settings.updateZipDir || "" });
    }
    return;
  }
  if (msg.type === "folder") {
    const cb = pendingFolderPicks.get(msg.reqId);
    if (cb) { pendingFolderPicks.delete(msg.reqId); try { cb({ ok: true, dir: msg.dir || "" }); } catch (e) {} }
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
    dl.status = "downloading";
    const pct = typeof msg.pct === "number" ? Math.max(0, Math.min(100, Math.round(msg.pct)))
                                            : (dl.progress ? dl.progress.done : 0);
    dl.progress = { done: pct, total: 100, unit: "pct", bps: msg.bps || 0,
                    stage: msg.stage || "downloading", note: msg.note || "", live: true };
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "ytdl-done") {
    dl.status = "done"; dl.live = true; dl.savedPath = msg.file || "";
    dl.progress = { done: 100, total: 100, unit: "pct" };
    broadcast({ type: "download-update", download: dl });
    addHistory({ name: dl.name || "YouTube", kind: "youtube", ts: Date.now() });
    notifyDone(dl.name || "YouTube video", fmtBytes(msg.bytes || 0), msg.file ? { path: msg.file } : null);
    setTimeout(() => activeDownloads.delete(dl.id), 120000);
  } else if (msg.type === "ytdl-error") {
    dl.status = "error"; dl.error = msg.error || "YouTube download failed"; dl.errReason = msg.reason || "";
    broadcast({ type: "download-update", download: dl });
  } else if (msg.type === "saved") {
    dl.status = "done"; dl.savedPath = msg.file; dl.convert = msg.convert || null;
    broadcast({ type: "download-update", download: dl });
    addHistory({ name: dl.name || "recording", kind: "hls-live", ts: Date.now() });
    const extra = msg.convert ? convertSummary(msg.convert) : (msg.file || null);
    notifyDone(dl.name || "recording", extra, msg.file ? { path: msg.file } : null);
    setTimeout(() => activeDownloads.delete(dl.id), 120000);
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

function nativeRecord(dl, tabId, videoUrl, audioUrl) {
  const hdr = resolveHeaders(tabId);
  nativePort.postMessage({
    cmd: "record",
    id: dl.id,
    videoUrl: mediaKey(videoUrl),                 // drop stale _HLS_msn, keep session
    audioUrl: audioUrl ? mediaKey(audioUrl) : null,
    referer: hdr.referer || "",
    userAgent: hdr.userAgent || "",
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

function addMedia(tabId, item) {
  if (tabId < 0) return;
  // De-dup key collapses Low-Latency HLS reloads of one playlist (differing only
  // by _HLS_msn / cache-bust params) into a single item. The item keeps its
  // original signed URL for fetching; the map is keyed by this stable key.
  const key = (item.kind === "hls" || item.kind === "dash") ? mediaKey(item.url)
            : item.kind === "direct" ? directGroupKey(item.url) : item.url;
  item.key = key;
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
  } else {
    if (item.kind === "direct") item.mirrors = [item.url];
    map.set(key, item);
    updateBadge(tabId);
    broadcast({ type: "media-updated", tabId });
    if (item.kind === "hls") enrichHls(tabId, key);
    else if (item.kind === "dash") enrichDash(tabId, key);
    else if (item.kind === "direct") enrichDirect(tabId, key);
    else if (item.kind === "youtube") enrichYouTube(tabId, key);
  }
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
    item.hasAudio = parsed.audio.length > 0;
    item.duration = parsed.duration;
    item.enrichState = "done";
  } catch (e) {
    item.enrichState = "error";
    item.enrichError = e.message || String(e);
  } finally {
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
    let size = 0;
    const cr = resp.headers.get("content-range");
    if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) size = parseInt(m[1], 10); }
    if (!size) { const cl = resp.headers.get("content-length"); if (cl) size = parseInt(cl, 10); }
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
    return { status: resp.status, ok, contentType: ct, size, head };
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
    dlog("probed direct", { url: item.url, status: r.status, size: item.size, container, junk: item.junk, kbps: item.estKbps });
  } catch (e) {
    item.enrichState = "error";
    item.probeError = e.message || String(e);
    item.junk = true;
  } finally {
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
  } catch (e) {
    item.enrichState = "error";
    item.enrichError = e.message || String(e);
    dlog("enrich ERROR", item.url, "→", item.enrichError);
  } finally {
    enriching.delete(key);
    dlog("enriched", { url: item.url, master: item.isMaster, live: item.isLive,
      estKbps: item.estKbps, group: renditionGroup(item.url), state: item.enrichState });
    updateBadge(tabId);
    broadcast({ type: "media-updated", tabId });
  }
}

function updateBadge(tabId) {
  const count = visibleFor(tabId).length;
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
    });
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
    addHistory({ name: base, kind: "hls", ts: Date.now() });
    notifyDone(base, mergeCmd ? "Saved video + audio separately — run the merge command." : null,
      videoDlId != null ? { downloadId: videoDlId } : null);
  } catch (e) {
    dl.status = "error";
    dl.error = e.message || String(e);
    broadcast({ type: "download-update", download: dl });
  } finally {
    setTimeout(() => activeDownloads.delete(id), 120000);
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
  if (dl) { dl.status = "done"; broadcast({ type: "download-update", download: dl }); }
  addHistory({ name: pend.base, kind: "hls-live", ts: Date.now() });
  notifyDone(pend.base, pend.mergeCmd
    ? "Saved as video + audio — run the merge command."
    : "Recording saved.",
    mainId != null ? { downloadId: mainId } : null);
  setTimeout(() => activeDownloads.delete(id), 120000);
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
    addHistory({ name: base, kind: "dash", ts: Date.now() });
    notifyDone(base, mergeCmd ? "Saved video + audio separately — run the merge command." : null,
      videoDlId != null ? { downloadId: videoDlId } : null);
  } catch (e) {
    dl.status = "error";
    dl.error = e.message || String(e);
    broadcast({ type: "download-update", download: dl });
  } finally {
    setTimeout(() => activeDownloads.delete(id), 120000);
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

// ---- Messaging ----

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "get-media") {
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
          for (const tid of mediaByTab.keys()) {
            kickYt(tid);
            for (const it of visibleFor(tid)) items.push(decorate(it, tid));
          }
        } else {
          kickYt(tabId);
          items = visibleFor(tabId).map((it) => decorate(it, tabId));
        }
        items.sort((a, b) => b.ts - a.ts);
        sendResponse({ items, downloads: Array.from(activeDownloads.values()), helper: helperStatus() });
      } else if (msg.type === "helper-status") {
        sendResponse({ ok: true, helper: helperStatus() });
      } else if (msg.type === "recheck-helper") {
        if (nativePort) { try { nativePort.postMessage({ cmd: "ping" }); } catch (e) {} }
        else connectNative();
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
      } else if (msg.type === "get-variants") {
        const info = await getVariants(msg.item, msg.tabId);
        sendResponse({ ok: true, info });
      } else if (msg.type === "download") {
        const { item, tabId, filename, variantUrl } = msg;
        if (item.kind === "hls") {
          downloadHls(item, tabId, filename, variantUrl);
        } else if (item.kind === "dash") {
          downloadDash(item, tabId, filename, msg.variantId);
        } else if (item.kind === "youtube") {
          downloadYouTube(item, tabId, filename, { height: msg.ytHeight, audioOnly: msg.ytAudioOnly });
        } else {
          await downloadDirect(item, tabId, filename);
        }
        sendResponse({ ok: true });
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
          const reqId = "fp" + (++downloadCounter);
          pendingFolderPicks.set(reqId, sendResponse);
          nativePort.postMessage({ cmd: "pickFolder", reqId, dir: msg.dir || settings.saveFolder || "" });
          return true;   // sendResponse called when the host replies
        }
        sendResponse({ ok: false, error: "Native helper not available for the folder picker." });
      } else if (msg.type === "discard-recording") {
        const dl = activeDownloads.get(msg.id);
        if (dl && dl.native && nativePort) nativePort.postMessage({ cmd: "discard", id: msg.id });
        else discardRecording(msg.id, "Discarded.");
        sendResponse({ ok: true });
      } else if (msg.type === "get-command") {
        sendResponse({ ok: true, command: buildCommand(msg.item, msg.tabId, msg.tool, msg.variantUrl) });
      } else if (msg.type === "get-settings") {
        sendResponse({ ok: true, settings, defaults: DEFAULT_SETTINGS });
      } else if (msg.type === "set-settings") {
        await saveSettings(msg.settings);
        sendResponse({ ok: true, settings });
      } else if (msg.type === "get-history") {
        const r = await api.storage.local.get("history");
        sendResponse({ ok: true, history: (r && r.history) || [] });
      } else if (msg.type === "clear-history") {
        await api.storage.local.set({ history: [] });
        sendResponse({ ok: true });
      } else if (msg.type === "cancel") {
        const dl = activeDownloads.get(msg.id);
        if (dl) dl.status = "cancelled";
        sendResponse({ ok: true });
      } else if (msg.type === "clear") {
        mediaByTab.delete(msg.tabId);
        childUrls.delete(msg.tabId);
        updateBadge(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === "content-media") {
        // From content script: a <video> element src.
        if (sender.tab) {
          const item = msg.item;
          item.name = item.name || shortName(item.url);
          addMedia(sender.tab.id, item);
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
        // From content script: a JPEG frame of the playing video.
        if (sender.tab && typeof msg.dataUrl === "string" &&
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
