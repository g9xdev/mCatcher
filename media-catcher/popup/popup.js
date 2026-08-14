"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const PopupUI = (typeof McPopupDownloadUi !== "undefined") ? McPopupDownloadUi : null;
const DownloadIntent = (typeof McDownloadIntent !== "undefined") ? McDownloadIntent : null;

let currentTabId = null;
let pageTitle = "";
let allTabs = false;
const downloadState = new Map();   // id -> download
const itemDownloadId = new Map();  // item identity -> download id (progress binding)
const itemElements = new Map();    // item identity -> rendered element

function isSafeOpaqueId(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function itemIdentity(item) {
  if (item && isSafeOpaqueId(item.id)) return "id:" + item.id;
  return "url:" + (item && typeof item.url === "string" ? item.url : "");
}

function downloadItemIdentity(download) {
  if (download && isSafeOpaqueId(download.mediaId)) return "id:" + download.mediaId;
  if (download && typeof download.url === "string" && download.url) return "url:" + download.url;
  return null;
}

function applyLiveJobsUpdate(msg) {
  if (!msg || !Array.isArray(msg.jobs)) return;

  const valid = [];
  for (const job of msg.jobs) {
    try {
      if (!job || typeof job !== "object" ||
          !isSafeOpaqueId(job.id) || !isSafeOpaqueId(job.mediaId)) continue;
      valid.push({ job, id: job.id, identity: "id:" + job.mediaId });
    } catch (e) {
      // Ignore malformed/hostile entries without disturbing the valid snapshot.
    }
  }

  // This message is a full controller snapshot. Remove only controller jobs;
  // legacy URL-backed downloads continue to be owned by download-update.
  for (const [id, existing] of downloadState) {
    let identity = null;
    try {
      if (existing && isSafeOpaqueId(existing.mediaId)) identity = "id:" + existing.mediaId;
    } catch (e) {}
    if (!identity) continue;
    downloadState.delete(id);
    if (itemDownloadId.get(identity) === id) itemDownloadId.delete(identity);
  }

  for (const entry of valid) {
    downloadState.set(entry.id, entry.job);
    itemDownloadId.set(entry.identity, entry.id);
    const el = itemElements.get(entry.identity);
    if (el) renderProgress(el, entry.job);
  }
  renderQueue();
}

// Web Crypto user-action token — minted only on Download / Save-As Confirm / Use Firefox click.
function mintUserActionToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return (
      hex.slice(0, 8) + "-" +
      hex.slice(8, 12) + "-" +
      hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" +
      hex.slice(20)
    );
  }
  throw new Error("Secure user-action token mint unavailable");
}

const SCHEDULER_STATES = new Set([
  "queued", "waiting_provider", "running", "retry_backoff", "pausing_provider",
  "needs_user", "handing_off_firefox", "handed_to_firefox", "failed", "completed", "cancelled",
]);

function schedulerStateOf(dl) {
  if (!dl) return null;
  if (dl.state && SCHEDULER_STATES.has(dl.state)) return dl.state;
  if (dl.status && SCHEDULER_STATES.has(dl.status)) return dl.status;
  return null;
}

function formatJobStatusLabel(dl) {
  if (!PopupUI || !dl) return null;
  const state = schedulerStateOf(dl);
  if (!state) return null;
  return PopupUI.formatJobStatus({
    state,
    providerKey: dl.providerKey,
    reduced: dl.reduced,
    mode: dl.mode,
  });
}

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const footCount = document.getElementById("foot-count");
const railEl = document.getElementById("rail");
const queueEl = document.getElementById("queue");
const queueTitleEl = document.getElementById("queue-title");
const queueCountEl = document.getElementById("queue-count");
const castSlotEl = document.getElementById("cast-slot");
const castTitleEl = document.getElementById("cast-title");
const hdrCastBtn = document.getElementById("hdr-cast");
const leftCountEl = document.getElementById("left-count");
const popCast = document.getElementById("pop-cast");

// Popup layout / feature flags. Real values arrive from get-settings in init();
// these mirror background.js DEFAULT_SETTINGS so first paint matches the default.
let uiSettings = { showRail: true, showQueue: true, enableCasting: false };
// Casting is only offered when the side panel is visible — otherwise a started
// session would have no transport (no pause/stop) anywhere in the UI.
let castUiReady = false;

// Prime <html> from the last-known-good layout so the popup opens at a width that
// already fits the window. A Firefox browser-action popup can't exceed the window
// width — it CLIPS the overflow (taking the header's Settings button with it) rather
// than shrinking — so the width must track the real window (measured in init()).
// First-ever open (no cache) stays at the classic 420px, which never clips; init()
// then widens it once the window width is known.
(function primeLayout() {
  try {
    const raw = localStorage.getItem("mc-layout");
    if (!raw) return;
    const hint = JSON.parse(raw);
    if (hint.cast) document.documentElement.classList.add("cast");
    if (hint.rail) {
      document.documentElement.classList.add("rail");
      // Start at a safe narrow width that fits virtually any window; applyLayout then
      // GROWS it to the measured fit. A Firefox popup grows to its content reliably but
      // often will NOT shrink after first paint — so we must never start wider than the
      // window, or the overflow is clipped (taking the Settings button with it).
      document.documentElement.style.width = "560px";
    }
  } catch (e) {}
})();

function showEl(el, on) { if (el) el.style.display = on ? "" : "none"; }

// Tiny DOM builder — safe by construction (text goes through textContent).
function h(tag, props, children) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "title") el.title = v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.slice(0, 2) === "on" && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v);
    }
  }
  if (children != null) {
    const arr = Array.isArray(children) ? children : [children];
    for (const c of arr) {
      if (c == null) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return el;
}

function humanSize(bytes) {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + " " + u[i];
}

// Managed opaque rows state their size from validated metadata only — an
// unvalidated item.size must never be relabelled as an exact total. Legacy
// rows keep their existing exact transfer size.
function mediaSizeLabel(item) {
  const sizeApi = (typeof McMediaSize !== "undefined") ? McMediaSize : null;
  if (item && typeof item.id === "string") {
    if (!sizeApi) return "Size unknown";
    return sizeApi.sizeLabel(
      { sizeBytes: item.sizeBytes, sizeConfidence: item.sizeConfidence },
      humanSize
    );
  }
  return item && item.size ? humanSize(item.size) : "";
}

// H.265 conversion outcome: before/after sizes, percent, and which version kept.
function h265Note(c) {
  if (!c) return "";
  const label = (c.codec || "h265") === "av1" ? "AV1" : "H.265";
  const src = c.srcBytes, enc = c.hevcBytes;
  if (c.converted) {
    const pct = src ? Math.round((1 - enc / src) * 100) : 0;
    return label + " · " + humanSize(src) + " → " + humanSize(enc) + " · " + pct + "% smaller";
  }
  if (enc == null) return c.note ? "Kept original — " + c.note : "Kept original — " + label + " conversion failed";
  const pct = src ? Math.round((enc / src - 1) * 100) : 0;
  return "Kept original — " + label + " would be " + pct + "% larger";
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

function proposedFilenameOf(item) {
  const p = (item && item.proposedFilename || "").trim();
  if (p) return p;
  const n = (item && item.name || "").trim();
  if (n) return n.replace(/\.(m3u8|mpd)$/i, "");
  return "";
}

function baseFilename(item) {
  const proposed = proposedFilenameOf(item);
  if (proposed) return proposed;
  // Last-resort legacy display only — never preferred over immutable proposal.
  const t = (item.pageTitle || pageTitle || "").trim();
  if (t) return t;
  return "video";
}

function displayNameOf(item) {
  const proposed = proposedFilenameOf(item);
  if (proposed) return proposed;
  const n = (item.name || "").trim();
  if (n) return n;
  const t = (item.pageTitle || pageTitle || "").trim();
  if (t) return t;
  return item.url || "video";
}

function knownExtensionOf(item) {
  if (item && item.knownExtension) {
    const k = String(item.knownExtension);
    return k.charAt(0) === "." ? k : "." + k;
  }
  const src = proposedFilenameOf(item) || (item && item.name) || "";
  const m = String(src).match(/\.(mp4|m4v|webm|mkv|mov|mp3|m4a|aac|flac|ogg|opus|ts|m2ts|mpeg|mpg)$/i);
  if (m) return m[0].toLowerCase();
  if (item && item.container && item.container !== "html") {
    return "." + String(item.container).replace(/^\./, "");
  }
  return ".mp4";
}

function send(msg) {
  return new Promise((resolve) => {
    api.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

async function init() {
  const [tabs, sresp] = await Promise.all([
    api.tabs.query({ active: true, currentWindow: true }),
    send({ type: "get-settings" }),
  ]);
  if (sresp && sresp.settings) uiSettings = Object.assign(uiSettings, sresp.settings);
  await applyLayout();
  if (!tabs.length) return;
  currentTabId = tabs[0].id;
  pageTitle = tabs[0].title || "";
  await refresh();
}

// Size the popup to fit the browser window (never wider, or Firefox clips it),
// show/hide the panel + sections from settings, and cache the result for the next
// open's synchronous prime.
async function applyLayout() {
  const wantRail = !!uiSettings.showRail && (!!uiSettings.showQueue || !!uiSettings.enableCasting);

  // A browser-action popup can't exceed the window width — Firefox clips the
  // overflow rather than shrinking. Measure the real window and size to it; fall
  // back to the classic single column when there isn't room for two panes.
  let winW = 0;
  try { const w = await api.windows.getCurrent(); winW = (w && w.width) || 0; } catch (e) {}
  const avail = winW ? winW - 44 : 0;        // margin so the popup never touches the window edge
  const WIDE_MAX = 640, TWO_PANE_MIN = 560;  // 640 fits a narrow window; below MIN → classic column

  let railOn = false, width = 0;
  if (wantRail) {
    if (avail >= TWO_PANE_MIN) { railOn = true; width = Math.min(WIDE_MAX, avail); }
    else if (!winW) { railOn = true; width = 560; }  // window API unavailable → safe narrow width
    // else: window too narrow for two panes → classic single column, nothing clips
  }

  // Casting is only offered when the panel is visible — a session started with
  // the rail hidden would have no transport (no pause/stop) anywhere in the UI.
  castUiReady = railOn && !!uiSettings.enableCasting;
  document.documentElement.classList.toggle("rail", railOn);
  document.documentElement.style.width = railOn ? width + "px" : "";  // "" → CSS classic 420
  document.documentElement.classList.toggle("cast", castUiReady);
  showEl(castTitleEl, castUiReady);
  showEl(castSlotEl, castUiReady);
  showEl(queueTitleEl, uiSettings.showQueue);
  showEl(queueEl, uiSettings.showQueue);
  try { localStorage.setItem("mc-layout", JSON.stringify({ rail: railOn, w: width, cast: castUiReady })); } catch (e) {}
  if (castUiReady) renderCastSlot();
  renderQueue();
}

let helperStatus = { state: "disconnected" };

async function refresh() {
  const resp = await send({ type: "get-media", tabId: currentTabId, allTabs });
  const items = (resp && resp.items) || [];
  if (resp && resp.helper) helperStatus = resp.helper;
  if (resp && resp.cast && castUiReady) { castState = resp.cast; renderCastSlot(); }
  if (resp && resp.downloads) {
    for (const d of resp.downloads) {
      downloadState.set(d.id, d);
      const identity = downloadItemIdentity(d);
      if (identity) itemDownloadId.set(identity, d.id); // rebind so in-flight jobs re-render
    }
  }
  render(items);
  renderQueue();
}

function render(items) {
  listEl.replaceChildren();
  itemElements.clear();
  footCount.textContent = items.length + (items.length === 1 ? " stream" : " streams");
  if (leftCountEl) leftCountEl.textContent = items.length;
  renderHelperBadge();

  if (!items.length) {
    listEl.appendChild(
      h("div", { class: "empty" }, [
        "No streams captured yet.",
        h("br"), h("br"),
        h("b", { text: "Play the video" }),
        ", then reopen this panel. Streams are detected as they load — if a player is paused, press play so it starts fetching.",
      ])
    );
    statusEl.textContent = "Idle · nothing captured on this tab";
    return;
  }
  // Promote any item with an active recording to the top; dim the idle rest.
  const isHot = (item) => {
    const id = itemDownloadId.get(itemIdentity(item));
    const dl = id != null && downloadState.get(id);
    return dl && dl.live && (dl.status === "recording" || dl.status === "stopped" || dl.status === "saving" || dl.status === "converting" || dl.status === "downloading");
  };
  const hot = items.filter(isHot);
  const anyHot = hot.length > 0;
  const ordered = hot.concat(items.filter((i) => !isHot(i)));

  statusEl.textContent = anyHot
    ? "● On air · " + items.length + " stream" + (items.length === 1 ? "" : "s") + " on this tab"
    : items.length + " candidate stream" + (items.length === 1 ? "" : "s") + " on this tab";

  for (const item of ordered) {
    const el = renderItem(item);
    if (anyHot && !isHot(item)) el.classList.add("dim");
    itemElements.set(itemIdentity(item), el);
    listEl.appendChild(el);
  }
}

// Color-coded native-helper health flag in the footer. Click to re-check.
const HELPER_UI = {
  ready:        { cls: "ok",   label: "helper on",     tip: "Native helper active — recordings use ffmpeg (one muxed file)." },
  "no-ffmpeg":  { cls: "warn", label: "helper: no ffmpeg", tip: "Helper is installed but ffmpeg wasn't found. Re-run the installer or drop ffmpeg.exe next to it." },
  connecting:   { cls: "warn", label: "helper…",       tip: "Connecting to the native helper…" },
  disconnected: { cls: "off",  label: "in-browser",    tip: "Native helper not detected — recording runs in-browser. Click to install it." },
};

function renderHelperBadge() {
  const badge = document.getElementById("helper-badge");
  if (!badge) return;
  const ui = HELPER_UI[helperStatus.state] || HELPER_UI.disconnected;
  badge.replaceChildren(
    h("span", { class: "hdot " + ui.cls }),
    h("span", { class: "hlabel", text: ui.label })
  );
  badge.title = (helperStatus.error ? helperStatus.error + "  ·  " : "") + ui.tip +
    (helperStatus.ffmpegPath ? "\nffmpeg: " + helperStatus.ffmpegPath : "");
  badge.onclick = async () => {
    if (helperStatus.state === "disconnected") {
      send({ type: "open-helper-setup" });   // no helper yet — open the install page
      return;
    }
    badge.title = "Re-checking…";
    const r = await send({ type: "recheck-helper" });
    if (r && r.helper) helperStatus = r.helper;
    setTimeout(refresh, 400); // give a fresh ping time to answer
    renderHelperBadge();
  };
}

function fmtDuration(sec) {
  if (!sec) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}

function bitrateLabel(item) {
  // Master: report the span of variant bitrates. Media playlist: the estimate.
  if (item.variants && item.variants.length) {
    const bws = item.variants.map((v) => v.bandwidth).filter(Boolean);
    if (bws.length) {
      const hi = Math.round(Math.max(...bws) / 1000);
      const lo = Math.round(Math.min(...bws) / 1000);
      return item.variants.length > 1 ? lo + "–" + hi + " kbps" : hi + " kbps";
    }
    return item.variants.length + " qualities";
  }
  if (item.bandwidth) return Math.round(item.bandwidth / 1000) + " kbps";
  if (item.estKbps) return "~" + item.estKbps + " kbps";
  return "";
}

function renderItem(item) {
  const kind = item.kind || "direct";
  const kindLabel = kind === "youtube" ? "YouTube" : kind.toUpperCase();
  const hasUrl = typeof item.url === "string" && item.url.length > 0;
  const identity = itemIdentity(item);

  // Amber data readout: KIND · quality · bitrate · duration.
  const quality = item.height ? item.height + "p" : (item.resolution || "");
  const metaLine = [kindLabel, quality, bitrateLabel(item), item.duration ? fmtDuration(item.duration) : ""]
    .filter(Boolean).join(" · ");
  const hostLine = [hostOf(item.url), mediaSizeLabel(item),
    item.renditionsHidden ? "top of " + (item.renditionsHidden + 1) : ""].filter(Boolean).join("  ·  ");

  const chips = h("div", { class: "chips" });
  chips.appendChild(h("span", { class: "chip type", text: kindLabel }));
  if (item.isLive) chips.appendChild(h("span", { class: "chip live" }, [h("i"), "LIVE"]));
  if (item.drm) chips.appendChild(h("span", { class: "chip drm", text: "DRM" }));
  if (item.hasAudio) chips.appendChild(h("span", { class: "chip", text: "AUDIO" }));
  if (item.hasSubtitles) chips.appendChild(h("span", { class: "chip", text: "SUBS" }));
  // Direct-file verification result (from the probe).
  if (kind === "direct") {
    if (item.enrichState === "loading") chips.appendChild(h("span", { class: "chip", text: "verifying…" }));
    else if (item.junk) chips.appendChild(h("span", { class: "chip bad",
      text: item.probeStatus >= 400 ? "HTTP " + item.probeStatus : (item.container === "html" ? "NOT A VIDEO" : "UNVERIFIED") }));
    else if (item.container) chips.appendChild(h("span", { class: "chip ok", text: item.container.toUpperCase() }));
  }
  if (item.codec) chips.appendChild(h("span", { class: "chip codec", text: item.codec }));

  const actions = h("div", { class: "actions" });
  const slot = h("div", { class: "slot" });

  // Prefer immutable proposedFilename, then name; pageTitle is last-resort display only.
  const displayName = displayNameOf(item);

  // Thumbnail: captured frame if we have one, else a tinted placeholder.
  const camish = kind === "hls" || kind === "dash" || item.isLive;
  const fno = item.isLive ? "LIVE" : (item.duration ? fmtDuration(item.duration) : kindLabel);
  const thumb = h("div", { class: "thumb" + (item.thumb ? "" : " ph " + (camish ? "cam" : "file")) }, [
    item.thumb ? h("img", { src: item.thumb, alt: "" }) : null,
    h("span", { class: "fno", text: fno }),
  ]);

  const info = h("div", { class: "item-info" }, [
    h("div", { class: "name", title: item.url, text: displayName }),
    metaLine ? h("div", { class: "meta", title: item.name || "", text: metaLine }) : null,
    hostLine ? h("div", { class: "host", text: hostLine }) : null,
    chips,
  ]);

  const itemDataset = { identity };
  if (hasUrl) itemDataset.url = item.url;
  const el = h("div", { class: "item" + (item.junk ? " junk" : ""), dataset: itemDataset }, [
    h("div", { class: "item-head" }, [thumb, info]),
    actions,
    slot,
  ]);

  const copyBtn = hasUrl ? h("button", {
    class: "btn ghost sm",
    text: "Copy URL",
    onClick: () => {
      navigator.clipboard.writeText(item.url).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy URL"), 1200);
      });
    },
  }) : null;

  const cmdBtn = hasUrl ? h("button", {
    class: "btn ghost sm",
    title: "Copy a yt-dlp / ffmpeg / streamlink command",
    onClick: () => toggleCommandMenu(item, el),
  }, [h("span", { class: "cmd", text: "⌘ cmd" })]) : null;

  function appendUrlActions() {
    if (!hasUrl) return;
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
  }

  function appendSaveAs(selection) {
    // Managed rows open a persistent extension window: a toolbar popup is
    // destroyed the moment the native folder dialog takes focus. Only opaque
    // IDs cross — never a media or variant URL. Legacy rows keep the inline
    // form, which this repair deliberately leaves alone.
    const managed = typeof item.id === "string";
    actions.appendChild(h("button", {
      class: "btn ghost sm",
      text: "Save As…",
      title: "Edit filename and choose folder before downloading",
      onClick: () => {
        if (!managed) {
          openSaveAsForm(item, el, selection || {});
          return;
        }
        const chosen = selection || {};
        send({
          type: "open-save-as",
          tabId: Number.isInteger(item.tabId) ? item.tabId : currentTabId,
          mediaId: item.id,
          variantId: typeof chosen.variantId === "string" ? chosen.variantId : null,
        });
      },
    }));
  }

  if (item.drm) {
    // DRM can't be saved by any downloader; be explicit and offer command/URL.
    appendUrlActions();
    showLabel(el, hasUrl
      ? "DRM-protected — can't be saved. Copy URL / command for reference only."
      : "DRM-protected — can't be saved.", "error");
  } else if ((kind === "hls" || kind === "dash") && item.variants && item.variants.length) {
    // Qualities shown inline (works for HLS masters and DASH).
    actions.appendChild(h("button", { class: "btn amber", text: "Download",
      onClick: () => startDownload(item, el, {}) }));
    appendSaveAs({});
    appendUrlActions();
    slot.appendChild(renderQualities(item, el, item.variants));
    if (item.hasAudio) appendNote(slot, "Has separate audio — saved as 2 files; a merge command is provided on completion.");
  } else if ((kind === "hls" || kind === "dash") && item.enrichState === "loading") {
    actions.appendChild(h("button", { class: "btn amber", text: "Download",
      onClick: () => handleDownload(item, el) }));
    appendSaveAs({});
    appendUrlActions();
    showLabel(el, "Reading qualities…", "");
  } else if (kind === "hls" && item.isMaster === false) {
    if (item.isLive) {
      actions.appendChild(h("button", { class: "btn rec",
        title: "Record this live stream; press Stop, then Save to keep it",
        onClick: () => startRecording(item, el, {}) }, [h("i"), "Record"]));
    } else {
      actions.appendChild(h("button", { class: "btn amber", text: "Download",
        onClick: () => handleDownload(item, el) }));
      appendSaveAs({});
    }
    appendUrlActions();
  } else if (kind === "dash") {
    actions.appendChild(h("button", { class: "btn amber", text: "Download",
      onClick: () => startDownload(item, el, {}) }));
    appendSaveAs({});
    appendUrlActions();
  } else if (kind === "youtube") {
    actions.appendChild(h("button", { class: "btn amber",
      text: item.height ? "Download " + item.height + "p" : "Download highest quality",
      onClick: () => startDownload(item, el, {}) }));
    appendSaveAs({});
    appendUrlActions();
    if (item.enrichState === "loading") appendNote(slot, "Reading formats…");
    else if (item.ytFormats && item.ytFormats.length) slot.appendChild(renderYtQualities(item, el));
    else if (item.enrichState === "error") appendNote(slot, "Couldn't read formats — the highest-quality download still works.");
  } else {
    actions.appendChild(h("button", {
      class: "btn amber",
      text: kind === "hls" ? "Download…" : "Download",
      onClick: () => handleDownload(item, el),
    }));
    appendSaveAs({});
    appendUrlActions();
  }

  // Cast: direct video files only for now — DLNA renderers play a plain URL,
  // while HLS/DASH manifests and YouTube pages need a remux/serve step (future).
  if (hasUrl && castUiReady && kind === "direct" && !item.drm && !item.junk) {
    actions.appendChild(h("button", {
      class: "btn cast-btn",
      title: "Cast to a TV on your network",
      onClick: (e) => openCastPicker(item, e.currentTarget),
    }, "Cast"));
  }

  const existingId = itemDownloadId.get(identity);
  if (existingId && downloadState.has(existingId)) {
    renderProgress(el, downloadState.get(existingId));
  }
  return el;
}

function appendNote(slot, text) {
  slot.appendChild(h("div", { class: "note", text: text }));
}

// Inline quality chooser — works for HLS (variant.uri) and DASH (variant.id).
function renderQualities(item, el, variants) {
  const wrap = h("div", { class: "qualities" });
  for (const v of variants) {
    const selection = typeof item.url === "string" && item.url
      ? (v.uri ? { variantUrl: v.uri } : { variantId: v.id })
      : { variantId: v.id };
    wrap.appendChild(
      h("button", {
        class: "q-btn",
        text: v.label,
        onClick: () => startDownload(item, el, selection),
      })
    );
  }
  return wrap;
}

// YouTube quality picker — real formats from the helper's yt-dlp probe. Each button
// downloads that height (video+audio, merged); "Audio" grabs the best audio only.
function renderYtQualities(item, el) {
  const wrap = h("div", { class: "qualities" });
  for (const f of item.ytFormats) {
    wrap.appendChild(h("button", {
      class: "q-btn",
      title: [f.tbr ? f.tbr + " kbps" : "", f.size ? humanSize(f.size) : "", f.fps ? f.fps + "fps" : ""].filter(Boolean).join(" · "),
      text: f.height + "p" + (f.codec ? " " + f.codec : ""),
      onClick: () => startDownload(item, el, { ytHeight: f.height }),
    }));
  }
  wrap.appendChild(h("button", {
    class: "q-btn",
    title: item.ytAudioSize ? humanSize(item.ytAudioSize) : "Best audio only",
    text: "Audio",
    onClick: () => startDownload(item, el, { ytAudioOnly: true }),
  }));
  return wrap;
}

// yt-dlp / ffmpeg / streamlink command menu.
async function toggleCommandMenu(item, el) {
  const slot = el.querySelector(".slot");
  if (slot.querySelector(".cmd-menu")) { slot.querySelector(".cmd-menu").remove(); return; }
  const menu = h("div", { class: "cmd-menu" });
  for (const tool of ["yt-dlp", "ffmpeg", "streamlink"]) {
    menu.appendChild(h("button", {
      class: "q-btn", text: tool,
      onClick: async () => {
        const resp = await send({ type: "get-command", item, tabId: item.tabId || currentTabId, tool });
        if (resp && resp.ok) {
          await navigator.clipboard.writeText(resp.command);
          appendNote(slot, "Copied " + tool + " command to clipboard.");
          setTimeout(() => menu.remove(), 200);
        }
      },
    }));
  }
  slot.appendChild(menu);
}

async function handleDownload(item, el) {
  el.querySelector(".slot").replaceChildren();

  if (item.kind === "dash") {
    startDownload(item, el, {});
    return;
  }
  if (item.kind !== "hls") {
    startDownload(item, el, {});
    return;
  }

  showLabel(el, "Reading manifest…", "");
  const resp = await send({ type: "get-variants", item, tabId: currentTabId });
  if (!resp || !resp.ok) {
    showLabel(el, (resp && resp.error) || "Couldn't read the manifest.", "error");
    return;
  }
  const info = resp.info;
  const slot = el.querySelector(".slot");
  slot.replaceChildren();

  if (info.isMaster && info.variants.length) {
    const wrap = h("div", { class: "qualities" });
    for (const v of info.variants) {
      wrap.appendChild(
        h("button", {
          class: "q-btn",
          text: v.label,
          onClick: () => { wrap.remove(); startDownload(item, el, { variantUrl: v.uri }); },
        })
      );
    }
    slot.appendChild(wrap);
  } else if (info.isLive) {
    startRecording(item, el, {});
  } else {
    startDownload(item, el, null);
  }
}

async function startDownload(item, el, selection, intent, options) {
  selection = selection || {};
  options = options || {};
  const preserveFormOnFailure = !!options.preserveFormOnFailure;
  const statusText = item.kind === "direct" ? "Saving…" : "Starting…";

  if (!PopupUI) {
    const err = "Download helper unavailable.";
    if (!preserveFormOnFailure) showLabel(el, err, "error");
    return { ok: false, error: err };
  }
  let msg;
  try {
    const token = intent ? null : mintUserActionToken();
    msg = PopupUI.buildDownloadMessage({
      item,
      tabId: item.tabId || currentTabId,
      selection,
      intent: intent || undefined,
      userActionToken: token || undefined,
      now: () => new Date().toISOString(),
    });
  } catch (e) {
    const err = (e && e.message) || "Couldn't build download.";
    if (!preserveFormOnFailure) showLabel(el, err, "error");
    return { ok: false, error: err };
  }

  // Default Download shows status before send. Save-As Confirm keeps the form
  // attached until enqueue is accepted, then replaces it once.
  if (!preserveFormOnFailure) showLabel(el, statusText, "");

  try {
    const resp = await send(msg);
    if (resp && resp.ok === false) {
      const err = resp.error || "Download failed.";
      if (!preserveFormOnFailure) showLabel(el, err, "error");
      return { ok: false, error: err };
    }
    if (preserveFormOnFailure) showLabel(el, statusText, "");
    return { ok: true, response: resp };
  } catch (e) {
    const err = (e && e.message) || "Download failed.";
    if (!preserveFormOnFailure) showLabel(el, err, "error");
    return { ok: false, error: err };
  }
}

function openSaveAsForm(item, el, selection) {
  selection = selection || {};
  const slot = el.querySelector(".slot");
  if (!slot || !PopupUI) return;

  const proposal = proposedFilenameOf(item) || baseFilename(item);
  const knownExt = knownExtensionOf(item);
  let destinationDirectory = null;

  const feedback = h("div", { class: "saveas-feedback", role: "status" });
  const folderText = h("div", { class: "saveas-folder", text: "Folder: default download location" });
  const input = h("input", {
    class: "saveas-input",
    type: "text",
    value: proposal,
    "aria-label": "Filename",
    spellcheck: "false",
    autocomplete: "off",
  });

  function setFeedback(text, cls) {
    feedback.textContent = text || "";
    feedback.className = "saveas-feedback" + (cls ? " " + cls : "");
  }

  const confirmBtn = h("button", { class: "btn amber sm", type: "button", text: "Confirm" });
  const cancelBtn = h("button", { class: "btn ghost sm", type: "button", text: "Cancel" });
  const folderBtn = h("button", {
    class: "btn ghost sm",
    type: "button",
    text: "Choose folder…",
    title: helperOn() ? "Pick a destination folder via the native helper" : "Native helper unavailable — filename still editable",
  });

  cancelBtn.addEventListener("click", () => {
    if (PopupUI) PopupUI.decideSaveAsForm({ action: "cancel" });
    slot.replaceChildren();
  });

  folderBtn.addEventListener("click", async () => {
    if (!helperOn()) {
      setFeedback("Helper unavailable — you can still edit the filename.", "warn");
      return;
    }
    folderBtn.disabled = true;
    try {
      // Pass current destination so the helper can open at that directory;
      // first click uses "" (default), later clicks reuse a prior pick.
      const resp = await send({ type: "pick-folder", dir: destinationDirectory || "" });
      if (resp && resp.ok && resp.dir) {
        destinationDirectory = resp.dir;
        folderText.textContent = "Folder: " + resp.dir;
        setFeedback("", "");
      } else if (resp && resp.ok === false) {
        setFeedback(resp.error || "Couldn't pick a folder.", "error");
      }
      // Cancel / no-response: leave form and prior destination intact.
    } finally {
      folderBtn.disabled = false;
    }
  });

  confirmBtn.addEventListener("click", async () => {
    if (confirmBtn.disabled) return; // prevent double-submit while pending
    const decision = PopupUI.decideSaveAsForm({
      action: "confirm",
      proposedFilename: proposal,
      editedFilename: input.value,
      knownExtension: knownExt,
      destinationDirectory,
      userActionToken: mintUserActionToken(),
      now: () => new Date().toISOString(),
    });
    if (!decision || !decision.enqueue) {
      const v = PopupUI.validateSaveAsFilename(input.value, knownExt);
      setFeedback(v && !v.ok ? "Enter a valid filename." : "Couldn't confirm Save As.", "error");
      return;
    }
    if (decision.intent && decision.intent.requestedFilename) {
      const v = PopupUI.validateSaveAsFilename(input.value, knownExt);
      if (v && v.warning) setFeedback(v.warning, "warn");
    }
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    folderBtn.disabled = true;
    input.disabled = true;
    const result = await startDownload(item, el, selection, decision.intent, {
      preserveFormOnFailure: true,
    });
    if (!result || !result.ok) {
      // Form stays attached; re-enable controls and surface error for another try.
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      folderBtn.disabled = false;
      input.disabled = false;
      setFeedback((result && result.error) || "Download failed.", "error");
    }
  });

  input.addEventListener("input", () => {
    const v = PopupUI.validateSaveAsFilename(input.value, knownExt);
    if (!v.ok) setFeedback(input.value.trim() ? "Invalid filename." : "", v.ok ? "" : (input.value.trim() ? "error" : ""));
    else if (v.warning) setFeedback(v.warning, "warn");
    else setFeedback("", "");
  });

  const form = h("div", { class: "saveas-form" }, [
    h("label", { class: "saveas-label", text: "Save as" }),
    input,
    folderText,
    feedback,
    h("div", { class: "saveas-actions" }, [confirmBtn, cancelBtn, folderBtn]),
  ]);
  slot.replaceChildren(form);
  setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 0);
}

async function startRecording(item, el, selection) {
  selection = selection || {};
  const filename = baseFilename(item);
  showLabel(el, "Starting recording…", "");
  const resp = await send({
    type: "record-live", item, tabId: item.tabId || currentTabId, filename,
    variantUrl: selection.variantUrl || null,
  });
  if (resp && resp.ok === false) {
    showLabel(el, resp.error || "Couldn't start recording.", "error");
  }
}

function qualityLabel(dl) {
  const q = dl.quality || {};
  const res = q.resolution || (q.height ? q.height + "p" : "") || q.label || "";
  const kbps = (dl.progress && dl.progress.kbps) ? dl.progress.kbps + " kbps"
    : (q.bandwidth ? Math.round(q.bandwidth / 1000) + " kbps" : "");
  return [res, kbps].filter(Boolean).join(" · ");
}

function pad2(n) { return String(n).padStart(2, "0"); }

function renderLiveProgress(el, dl) {
  const p = dl.progress || {};
  const rec = dl.recorded || {};
  const slot = el.querySelector(".slot");

  // Module chrome: recording tints the card + adds the sweeping tally strip.
  el.classList.toggle("recording", dl.status === "recording");
  el.classList.toggle("held", dl.status === "stopped" || dl.status === "saving");
  const bar = el.querySelector(".tallybar");
  if (dl.status === "recording" && !bar) el.insertBefore(h("div", { class: "tallybar" }), el.firstChild);
  else if (dl.status !== "recording" && bar) bar.remove();
  // The idle "Record" row is replaced by the transport controls below.
  const topActions = el.querySelector(":scope > .actions");
  if (topActions) topActions.style.display = "none";

  const children = [];

  if (dl.status === "recording") {
    const secs = p.duration || 0;
    const cs = pad2(Math.floor((secs % 1) * 100));
    children.push(h("div", { class: "tc-row" }, [
      h("span", { class: "tc" }, [fmtDuration(secs) || "0:00", h("small", { text: "·" + cs })]),
      h("span", { class: "rec-flag" }, [h("i"), "REC"]),
    ]));
    children.push(h("div", { class: "g-read" }, [
      h("div", {}, [h("b", { text: humanSize(p.bytes) || "0 B" }), " written · growing"]),
      h("div", {}, [h("b", { text: (p.kbps || 0) + " kbps" }), " live signal"]),
    ]));
    const row = h("div", { class: "actions" });
    const stopLbl = h("span", { text: "Stop" });
    const stopBtn = h("button", { class: "btn stop",
      onClick: () => { stopBtn.disabled = true; stopLbl.textContent = "Finishing…"; send({ type: "stop-recording", id: dl.id }); },
    }, [h("i"), stopLbl]);
    row.appendChild(stopBtn);
    if (dl.native) {
      const saveNow = h("button", { class: "btn ghost sm", text: "⤓ Save now",
        title: "Checkpoint to disk without stopping (crash safety)",
        onClick: () => {
          saveNow.disabled = true; saveNow.textContent = "Saving…";
          send({ type: "snapshot-recording", id: dl.id }).then(() =>
            setTimeout(() => { saveNow.disabled = false; saveNow.textContent = "⤓ Save now"; }, 1500));
        } });
      row.appendChild(saveNow);
    }
    children.push(row);
    if (!dl.native && dl.hasAudio) children.push(h("div", { class: "note", text: "Video + audio → 2 files + merge cmd on save." }));
    if (dl.snapshots) children.push(h("div", { class: "note snap",
      text: "✓ Safety copy" + (dl.snapshots > 1 ? " ×" + dl.snapshots : "") + " · " + (dl.name || "recording") + " (partial).mp4" }));
  } else if (dl.status === "saving") {
    children.push(h("div", { class: "held-line" }, [h("b", { text: "Writing to disk…" })]));
  } else if (dl.status === "converting") {
    const label = dl.convertCodec === "av1" ? "AV1" : "H.265";
    const pct = typeof dl.convertPct === "number" ? dl.convertPct : null;
    children.push(h("div", { class: "held-line" }, [
      h("b", { text: "Converting to " + label + "…" }), pct != null ? "  " + pct + "%" : "  preparing…",
    ]));
    const cfill = h("div", { class: "fill" });
    cfill.style.width = (pct != null ? pct : 0) + "%";
    children.push(h("div", { class: "progress" }, [h("div", { class: "track" }, [cfill])]));
  } else if (dl.status === "stopped") {
    children.push(h("span", { class: "held-flag", text: "CAPTURE HELD" }));
    children.push(h("div", { class: "held-line" }, [
      "Ready to write · ", h("b", { text: fmtDuration(rec.duration) || "0:00" }),
      " · ", h("b", { text: humanSize(rec.bytes) || "—" }),
      dl.native ? " · mp4" : (dl.hasAudio ? " · 2 files" : ""),
    ]));
    const row = h("div", { class: "actions" });
    const saveBtn = h("button", { class: "btn amber", text: "Save",
      title: "Save to the default folder set in Settings",
      onClick: () => { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; send({ type: "save-recording", id: dl.id }); } });
    const saveAsBtn = h("button", { class: "btn", text: "Save as…",
      title: "Choose where to save this file",
      onClick: () => { saveAsBtn.disabled = true; send({ type: "saveas-recording", id: dl.id }); } });
    const discardBtn = h("button", { class: "btn ghost", text: "Discard",
      onClick: () => { discardBtn.disabled = true; send({ type: "discard-recording", id: dl.id }); } });
    row.appendChild(saveBtn); row.appendChild(saveAsBtn); row.appendChild(discardBtn);
    children.push(row);
    if (!dl.native) children.push(h("div", { class: "note",
      text: "Browser save — Firefox may ask where to put it (its “Always ask” setting). Enable the helper for silent saves to your folder." }));
  } else if (dl.status === "done") {
    const path = dl.savedPath || "";
    const chip = h("div", { class: "savedchip" + (path ? " openable" : ""), role: "status",
      title: path ? path + " — click to open" : "" }, [
      h("span", { class: "check", text: "✓" }), "Saved",
      path ? h("span", { class: "path", text: path, title: path }) : null,
    ]);
    if (path) chip.onclick = () => openDlFile(dl);
    children.push(chip);
    children.push(fileActionRow(dl));
    if (dl.convert) children.push(h("div", { class: "note", text: h265Note(dl.convert) }));
  } else if (dl.status === "discarded") {
    children.push(h("div", { class: "note", text: "Discarded." }));
  }

  slot.replaceChildren.apply(slot, children.filter(Boolean));

  // Fallback (in-browser) extras: merge / duration-fix commands.
  if ((dl.status === "stopped" || dl.status === "done") && dl.mergeCommand) {
    const note = h("div", { class: "note" }, ["Video + audio saved separately — merge: "]);
    note.appendChild(h("button", { class: "q-btn", text: "copy ffmpeg", onClick: () => navigator.clipboard.writeText(dl.mergeCommand) }));
    slot.appendChild(note);
  }
  if ((dl.status === "stopped" || dl.status === "done") && dl.fixCommand) {
    const note = h("div", { class: "note" }, [".ts duration fix — remux: "]);
    note.appendChild(h("button", { class: "q-btn", text: "copy ffmpeg", onClick: () => navigator.clipboard.writeText(dl.fixCommand) }));
    slot.appendChild(note);
  }
}

function renderProgress(el, dl) {
  // Live recordings have no known total; show elapsed stats + Stop/Save controls.
  if (dl.live && ["recording", "stopped", "saving", "converting", "done", "discarded"].includes(dl.status)) {
    renderLiveProgress(el, dl);
    return;
  }

  const sched = schedulerStateOf(dl);
  const schedLabel = formatJobStatusLabel(dl);

  // Scheduler-only states: surface exact labels (and needs_user actions on the item card).
  // needs_user always takes this branch even when a prior progress.total is retained —
  // otherwise Retry / Use Firefox / Cancel disappear behind a stale progress bar.
  if (sched && ["queued", "waiting_provider", "retry_backoff", "pausing_provider",
    "needs_user", "handing_off_firefox", "handed_to_firefox", "failed", "completed", "cancelled"].includes(sched)
    && (sched === "needs_user" || !(dl.progress && dl.progress.total))) {
    const cls = (sched === "failed" || sched === "cancelled" || sched === "needs_user") ? "error"
      : (sched === "completed" || sched === "handed_to_firefox") ? "done" : "";
    const children = [
      h("div", { class: "progress-label" + (cls ? " " + cls : "") }, [
        h("span", { text: (dl.error && (sched === "failed" || sched === "needs_user") ? dl.error + " · " : "") + (schedLabel || "") }),
      ]),
    ];
    el.querySelector(".slot").replaceChildren(h("div", { class: "progress" }, children));
    if (sched === "needs_user") {
      const wrap = h("div", { class: "saveas-actions" });
      renderNeedsUserActions(dl, wrap);
      el.querySelector(".slot").appendChild(wrap);
    }
    return;
  }

  // Pre-download resolution phase (YouTube reads cookies, solves the JS challenge,
  // picks formats before any bytes flow). Show a live indeterminate bar, not a dead 0%.
  const p0 = dl.progress || {};
  if ((dl.status === "downloading" || sched === "running") && (p0.stage === "resolving" || p0.stage === "starting")) {
    const note = p0.note ? "Preparing · " + p0.note : "Preparing…";
    el.querySelector(".slot").replaceChildren(
      h("div", { class: "progress" }, [
        h("div", { class: "track indet" }, [h("div", { class: "ind" })]),
        h("div", { class: "progress-label" }, [h("span", { text: note }), h("span", { text: "" })]),
      ])
    );
    return;
  }

  const pct = dl.progress && dl.progress.total
    ? Math.round((dl.progress.done / dl.progress.total) * 100) : 0;

  let statusText, cls = "";
  if (schedLabel && (sched === "running" || sched === "retry_backoff")) statusText = schedLabel;
  else if (dl.status === "error" || sched === "failed") { statusText = dl.error || schedLabel || "Error"; cls = "error"; }
  else if (dl.status === "done" || sched === "completed") { statusText = schedLabel || "Saved ✓"; cls = "done"; }
  else if (dl.status === "audio") statusText = "Downloading audio track…";
  else if (dl.status === "saving") statusText = "Assembling file…";
  else if (dl.status === "parsing") statusText = "Reading manifest…";
  else if (dl.status === "cancelled" || sched === "cancelled") { statusText = schedLabel || "Cancelled"; cls = "error"; }
  else statusText = schedLabel || "Downloading";

  let right = dl.progress && dl.progress.total
    ? (dl.progress.unit === "bytes"
        ? humanSize(dl.progress.done) + " / " + humanSize(dl.progress.total)
        : dl.progress.unit === "pct"
          ? (dl.progress.stage === "merging" ? "merging…" : "")
          : dl.progress.done + "/" + dl.progress.total + " seg")
    : "";
  if (dl.progress && dl.progress.bps > 0 && (dl.status === "downloading" || dl.status === "audio")) {
    right += (right ? "  ·  " : "") + humanSize(dl.progress.bps) + "/s";
  }

  const fill = h("div", { class: "fill" });
  fill.style.width = pct + "%";

  const children = [
    h("div", { class: "track" }, [fill]),
    h("div", { class: "progress-label" + (cls ? " " + cls : "") }, [
      h("span", { text: statusText }),
      h("span", { text: right }),
    ]),
  ];

  el.querySelector(".slot").replaceChildren(h("div", { class: "progress" }, children));

  // A finished download must stay ACTIONABLE from its card — Open / Folder /
  // Cast for the produced file (user report: "Saved ✓" alone dead-ends).
  if (dl.status === "done") {
    const acts = fileActionRow(dl);
    if (acts) el.querySelector(".slot").appendChild(acts);
  }

  // On completion of a separate-audio job, surface the merge command.
  if (dl.status === "done" && dl.mergeCommand) {
    const slot = el.querySelector(".slot");
    const note = h("div", { class: "note" }, [
      h("span", { text: "Video + audio saved separately. Merge: " }),
    ]);
    const copy = h("button", {
      class: "q-btn", text: "copy ffmpeg merge",
      onClick: () => navigator.clipboard.writeText(dl.mergeCommand),
    });
    note.appendChild(copy);
    slot.appendChild(note);
  }
}

function showLabel(el, text, cls) {
  el.querySelector(".slot").replaceChildren(
    h("div", { class: "progress" }, [
      h("div", { class: "progress-label" + (cls ? " " + cls : "") }, [
        h("span", { text: text }),
      ]),
    ])
  );
}

// ========================================================================
// Side panel — global downloads queue + casting (both opt-in via Settings)
// ========================================================================

// Rank groups a download for ordering: active first, then held, done, failed.
function queueRank(dl) {
  const sched = schedulerStateOf(dl);
  if (sched) {
    if (["queued", "waiting_provider", "running", "retry_backoff", "pausing_provider",
      "handing_off_firefox", "needs_user"].includes(sched)) return 0;
    if (sched === "completed" || sched === "handed_to_firefox") return 2;
    return 3; // failed / cancelled
  }
  if (["downloading", "audio", "parsing", "saving", "converting", "recording"].includes(dl.status)) return 0;
  if (dl.status === "stopped") return 1;
  if (dl.status === "done") return 2;
  return 3; // error / cancelled / discarded
}

// The queue mirrors background's activeDownloads (global — every tab), which the
// popup accumulates via get-media + download-update. It re-renders wholesale, but
// the cards carry no focused inputs so there's nothing to disturb.
function renderQueue() {
  if (!queueEl) return;
  if (!uiSettings.showQueue) { queueEl.replaceChildren(); if (queueCountEl) queueCountEl.textContent = "0"; return; }
  const all = Array.from(downloadState.values());
  all.sort((a, b) => queueRank(a) - queueRank(b)); // stable → insertion order within a group
  const active = all.filter((dl) => queueRank(dl) === 0).length;
  if (queueCountEl) queueCountEl.textContent = String(active);
  queueEl.replaceChildren();
  if (!all.length) {
    queueEl.appendChild(h("div", { class: "rail-card queue-empty",
      text: "No downloads yet. Start one from a stream and it shows up here." }));
    return;
  }
  for (const dl of all) queueEl.appendChild(renderQueueItem(dl));
}

function queueSpec(dl) {
  const kind = dl.kind ? (dl.kind === "youtube" ? "YouTube" : dl.kind.toUpperCase()) : "";
  return [kind, qualityLabel(dl)].filter(Boolean).join(" · ");
}

// Open the produced file with the OS default player. Helper-saved files go
// through the native host; browser-API saves use downloads.open (which needs
// this click's user-input context — that's why the popup calls it directly).
function openDlFile(dl) {
  if (dl.savedPath && helperOn()) send({ type: "open-file", path: dl.savedPath });
  else if (dl.downloadId != null) {
    const p = api.downloads.open && api.downloads.open(dl.downloadId);
    if (p && p.catch) p.catch(() => { try { api.downloads.show(dl.downloadId); } catch (e) {} });
  }
}

function helperOn() {
  return helperStatus.state === "ready" || helperStatus.state === "no-ffmpeg";
}

// File actions for a download that has (or is producing) a file on disk. The
// queue card and the item card both use this so starting a download NEVER
// strands the user without Open / Folder / Cast for that file.
function fileActionRow(dl, opts) {
  const row = h("div", { class: "dl-actions" });
  const canFile = (dl.savedPath && helperOn()) || dl.downloadId != null;
  if (canFile) {
    row.appendChild(h("button", { class: "btn ghost sm", text: "▶ Open",
      title: "Open the file in your default player",
      onClick: () => openDlFile(dl) }));
    row.appendChild(h("button", { class: "btn ghost sm", text: "Folder",
      title: "Show the file in its folder",
      onClick: () => {
        if (dl.savedPath && helperOn()) send({ type: "reveal-file", path: dl.savedPath });
        else { try { api.downloads.show(dl.downloadId); } catch (e) {} }
      } }));
  }
  if (castUiReady && dl.savedPath) {
    row.appendChild(h("button", { class: "btn cast-btn sm", text: "Cast",
      title: "Cast this file to a TV on your network",
      onClick: (e) => openCastPicker({ url: dl.savedPath, name: dl.name, pageTitle: dl.name, kind: "direct" }, e.currentTarget) }));
  }
  if (opts && opts.dismiss) {
    row.appendChild(h("button", { class: "btn ghost sm", text: "Dismiss",
      onClick: () => { send({ type: "dismiss-download", id: dl.id }); downloadState.delete(dl.id); renderQueue(); } }));
  }
  return row.childElementCount ? row : null;
}

function renderNeedsUserActions(dl, card) {
  const err = h("div", { class: "progress-label error", role: "status" });
  const retryBtn = h("button", {
    class: "btn amber sm", text: "Retry",
    onClick: () => send({ type: "retry-download", id: dl.id }),
  });
  // Named element so we can disable synchronously before token mint / send.
  const fxBtn = h("button", {
    class: "btn ghost sm", text: "Use Firefox instead",
  });
  const cancelBtn = h("button", {
    class: "btn ghost sm", text: "Cancel",
    onClick: () => send({ type: "cancel", id: dl.id }),
  });

  fxBtn.addEventListener("click", async () => {
    if (fxBtn.disabled) return;
    // Disable before mint/send so a double-click cannot mint two proof tokens.
    fxBtn.disabled = true;
    // Never auto-invoke Firefox; only send on explicit click.
    // Do not call browser downloads API from the popup path.
    if (!DownloadIntent) {
      err.textContent = "Firefox handoff unavailable.";
      fxBtn.disabled = false;
      return;
    }
    const requested = (dl.requestedFilename || "").trim();
    if (!requested) {
      err.textContent = "Missing filename for Firefox handoff.";
      fxBtn.disabled = false;
      return;
    }
    let intent;
    try {
      intent = DownloadIntent.createFirefoxIntent({
        baseIntent: {
          requestedFilename: requested,
          destinationDirectory: dl.destinationDirectory == null ? null : dl.destinationDirectory,
          saveMode: dl.saveMode === "save-as" ? "save-as" : "default",
          userSelectedFirefox: false,
          userActionToken: mintUserActionToken(),
          createdAt: dl.createdAt || new Date().toISOString(),
        },
      });
    } catch (e) {
      err.textContent = (e && e.message) || "Couldn't build Firefox intent.";
      fxBtn.disabled = false;
      return;
    }
    try {
      const resp = await send({ type: "use-firefox", id: dl.id, intent });
      if (!resp || resp.ok === false) {
        err.textContent = (resp && resp.error) || "Firefox handoff failed.";
        fxBtn.disabled = false;
        return;
      }
      // Accepted handoff: keep disabled.
    } catch (e) {
      err.textContent = (e && e.message) || "Firefox handoff failed.";
      fxBtn.disabled = false;
    }
  });

  const row = h("div", { class: "dl-actions" }, [retryBtn, fxBtn, cancelBtn]);
  card.appendChild(row);
  card.appendChild(err);
}

function renderQueueItem(dl) {
  const p = dl.progress || {};
  const card = h("div", { class: "rail-card dl", dataset: { id: String(dl.id) } });
  const sched = schedulerStateOf(dl);
  const schedLabel = formatJobStatusLabel(dl);
  const displayName = dl.requestedFilename || dl.name || "download";

  if (sched === "completed" || dl.status === "done") {
    const size = dl.recorded && dl.recorded.bytes ? humanSize(dl.recorded.bytes)
      : (p.total && p.unit === "bytes" ? humanSize(p.total) : "");
    const name = h("div", { class: "dl-name openable", title: (dl.savedPath || displayName) + " — click to open",
      text: displayName, onClick: () => openDlFile(dl) });
    card.appendChild(h("div", { class: "dl-done-row" }, [
      h("span", { class: "dl-check", text: "✓" }),
      name,
    ]));
    const doneLabel = schedLabel || ("Done" + (size ? " · " + size : ""));
    card.appendChild(h("div", { class: "progress-label done", text: doneLabel + (schedLabel && size ? " · " + size : "") }));
    if (dl.convert) card.appendChild(h("div", { class: "note", text: h265Note(dl.convert) }));
    const acts = fileActionRow(dl, { dismiss: true });
    if (acts) card.appendChild(acts);
    return card;
  }

  if (sched === "handed_to_firefox") {
    card.appendChild(h("div", { class: "dl-done-row" }, [
      h("span", { class: "dl-check", text: "→" }),
      h("div", { class: "dl-name", title: displayName, text: displayName }),
    ]));
    card.appendChild(h("div", { class: "progress-label done", text: schedLabel }));
    card.appendChild(h("div", { class: "dl-actions" }, [
      h("button", { class: "btn ghost sm", text: "Dismiss",
        onClick: () => { downloadState.delete(dl.id); renderQueue(); } }),
    ]));
    return card;
  }

  if (sched === "failed" || sched === "cancelled" ||
      dl.status === "error" || dl.status === "cancelled" || dl.status === "discarded") {
    const isErr = sched === "failed" || dl.status === "error";
    card.appendChild(h("div", { class: "dl-done-row" }, [
      h("span", { class: "dl-x", text: isErr ? "✕" : "—" }),
      h("div", { class: "dl-name", title: displayName, text: displayName }),
    ]));
    card.appendChild(h("div", { class: "progress-label error",
      text: schedLabel || dl.error || (dl.status === "cancelled" || sched === "cancelled" ? "Cancelled" : "Discarded") }));
    card.appendChild(h("div", { class: "dl-actions" }, [
      h("button", { class: "btn ghost sm", text: "Dismiss",
        onClick: () => { downloadState.delete(dl.id); renderQueue(); } }),
    ]));
    return card;
  }

  if (sched === "needs_user") {
    card.appendChild(h("div", { class: "dl-top" }, [
      h("div", { class: "dl-name", title: displayName, text: displayName }),
    ]));
    card.appendChild(h("div", { class: "progress-label error",
      text: (dl.error ? dl.error + " · " : "") + (schedLabel || "Needs attention") }));
    renderNeedsUserActions(dl, card);
    return card;
  }

  // Active. Live recordings (indeterminate) get elapsed + bytes; everything else
  // a determinate bar. A native recording is managed from its card, not here.
  const recording = dl.live && ["recording", "stopped", "saving"].includes(dl.status);
  const top = h("div", { class: "dl-top" }, [
    h("div", { class: "dl-name", title: displayName, text: displayName }),
  ]);
  if (!recording && sched !== "handing_off_firefox") {
    // Pause/resume exists only for downloads the BROWSER transports (a
    // downloads-API id) — segment fetchers and native yt-dlp/pget jobs have no
    // pause mechanism, so no button is shown rather than a dead one.
    if (dl.downloadId != null && (dl.status === "downloading" || sched === "running")) {
      const pb = h("button", { class: "dl-ic", title: "Pause download", text: "⏸" });
      pb.onclick = async () => {
        try {
          if (pb.textContent === "⏸") { await api.downloads.pause(dl.downloadId); pb.textContent = "⏵"; pb.title = "Resume download"; }
          else { await api.downloads.resume(dl.downloadId); pb.textContent = "⏸"; pb.title = "Pause download"; }
        } catch (e) { /* download already finished/interrupted — next update corrects the card */ }
      };
      top.appendChild(pb);
    }
    top.appendChild(h("button", { class: "dl-ic", title: "Cancel download", text: "✕",
      onClick: () => send({ type: "cancel", id: dl.id }) }));
  }
  card.appendChild(top);
  const spec = queueSpec(dl);
  if (spec) card.appendChild(h("div", { class: "dl-spec", text: spec }));

  if (recording) {
    card.appendChild(h("div", { class: "progress-label" }, [
      h("span", { text: dl.status === "recording" ? "Recording · " + (fmtDuration(p.duration) || "0:00") : "Held" }),
      h("span", { text: humanSize(p.bytes) || "" }),
    ]));
    return card;
  }

  // Scheduler states without progress use exact labels (queued, waiting, retrying…).
  if (sched && ["queued", "waiting_provider", "retry_backoff", "pausing_provider", "handing_off_firefox"].includes(sched)) {
    card.appendChild(h("div", { class: "progress-label" }, [
      h("span", { text: schedLabel || statusWord(dl.status) }),
      h("span", { text: "" }),
    ]));
    return card;
  }

  // Pre-download resolution phase — same indeterminate "Preparing…" as the item card.
  if (p.stage === "resolving" || p.stage === "starting") {
    card.appendChild(h("div", { class: "track indet" }, [h("div", { class: "ind" })]));
    card.appendChild(h("div", { class: "progress-label" }, [h("span", { text: p.note ? "Preparing · " + p.note : "Preparing…" })]));
    return card;
  }

  const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  const fill = h("div", { class: "fill" });
  fill.style.width = pct + "%";
  card.appendChild(h("div", { class: "track" }, [fill]));

  let left;
  if (p.unit === "bytes" && p.total) left = pct + "% of " + humanSize(p.total);
  else if (p.unit === "pct") left = pct + "%";
  else if (p.total) left = p.done + "/" + p.total + " seg";
  else left = schedLabel || statusWord(dl.status);
  const right = p.bps > 0 ? humanSize(p.bps) + "/s" : "";
  card.appendChild(h("div", { class: "progress-label" }, [
    h("span", { text: left }),
    h("span", { text: right }),
  ]));
  return card;
}

function statusWord(s) {
  if (s === "audio") return "Audio track…";
  if (s === "saving") return "Assembling…";
  if (s === "parsing") return "Reading…";
  if (s === "converting") return "Converting…";
  return "Downloading…";
}

// ---- casting (DLNA via the native helper) --------------------------------
// The helper discovers renderers (SSDP), serves/proxies the media over local
// HTTP, and streams cast-status once a second. AirPlay devices are listed but
// flagged unsupported until pyatv's video fix lands upstream.
let castState = { state: "idle" };
let scrubbing = false;          // true while the user drags the position or volume slider
let castVolume = 100;           // last volume the user chose — survives the 1 Hz rebuilds
let castPickerGen = 0;          // invalidates in-flight discovery when the picker reopens
let pendingCast = null;         // {d, item, title} held across an AirPlay pairing handshake
let castPickerItem = null;      // what a device click casts — context for renderCastDevices
let castPickerTitle = "";
let castDevList = null;         // the open picker's device-list container (live re-render target)
let castCountEl = null;         // the open picker's "N devices" foot counter
let castPrefetched = false;     // one hover warm-discover per popover lifecycle (closePops resets)
let castPrefetchTimer = null;

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return (hh ? hh + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0");
}

function renderHeaderCast() {
  if (!hdrCastBtn) return;
  const on = castState.state !== "idle";
  hdrCastBtn.classList.toggle("casting", on);
  hdrCastBtn.title = on ? "Casting to " + (castState.device || "TV") : "Cast — no active session";
}

function renderCastSlot() {
  if (!castSlotEl) return;
  renderHeaderCast();
  if (castState.state === "idle") {
    scrubbing = false;   // session over — never leave the drag-guard stuck on
    castSlotEl.replaceChildren(
      h("div", { class: "rail-card cast-empty" }, [
        h("b", { text: "Nothing casting" }),
        "Use a stream's Cast button to send it to a DLNA-capable TV. First cast: accept the permission prompt on the TV.",
      ])
    );
    return;
  }
  if (scrubbing) return;   // don't rebuild under the user's finger

  const st = castState;
  const card = h("div", { class: "rail-card cast-card" });
  card.appendChild(h("div", { class: "cast-topline" }, [
    h("span", { class: "cast-flag" }, [h("i"), st.state === "loading" ? "STARTING" : "CASTING"]),
    h("span", { class: "cast-proto", text: (st.protocol || "dlna").toUpperCase() }),
  ]));
  card.appendChild(h("div", { class: "cast-media" }, [
    h("div", { class: "cast-info" }, [
      h("div", { class: "cast-title", title: st.title || "", text: st.title || "Casting" }),
      h("div", { class: "cast-device" }, [h("span", { text: st.device || "" })]),
    ]),
  ]));

  // Position scrub — only when the TV reports a duration.
  if (st.duration > 0) {
    const scrub = h("input", { class: "scrub", type: "range", min: "0", max: String(st.duration) });
    scrub.value = String(st.position || 0);
    const cur = h("span", { text: fmtClock(st.position) });
    const paint = () => {
      scrub.style.setProperty("--p", (st.duration ? (scrub.value / st.duration) * 100 : 0) + "%");
      cur.textContent = fmtClock(Number(scrub.value));
    };
    paint();
    scrub.addEventListener("input", () => { scrubbing = true; paint(); });
    scrub.addEventListener("change", () => {
      scrubbing = false;
      send({ type: "cast-control", action: "seek", value: Number(scrub.value) });
    });
    card.appendChild(h("div", { class: "scrub-wrap" }, [
      scrub,
      h("div", { class: "scrub-times" }, [cur, h("span", { text: fmtClock(st.duration) })]),
    ]));
  }

  // Transport: play/pause, stop, volume.
  const playBtn = h("button", {
    class: "t-btn main",
    title: st.state === "paused" ? "Play" : "Pause",
    text: st.state === "paused" ? "▶" : "❚❚",
    onClick: () => send({ type: "cast-control", action: "playpause" }),
  });
  const stopBtn = h("button", {
    class: "t-btn", title: "Stop casting", text: "■",
    onClick: () => send({ type: "cast-stop" }),
  });
  const vol = h("input", { class: "scrub", type: "range", min: "0", max: "100" });
  vol.value = String(castVolume);                  // survives the 1 Hz card rebuilds
  vol.style.setProperty("--p", castVolume + "%");
  vol.addEventListener("input", () => {
    scrubbing = true;                              // guard the drag like the position slider
    castVolume = Number(vol.value);
    vol.style.setProperty("--p", vol.value + "%");
  });
  vol.addEventListener("change", () => {
    scrubbing = false;
    send({ type: "cast-control", action: "volume", value: Number(vol.value) });
  });
  card.appendChild(h("div", { class: "transport" }, [
    playBtn, stopBtn,
    h("div", { class: "vol", title: "TV volume" }, [vol]),
  ]));

  castSlotEl.replaceChildren(card);
}

let popAnchor = null;
function closePops() {
  if (popCast) popCast.classList.remove("open");
  popAnchor = null;
  castPrefetched = false;        // next hover may prefetch again
  clearTimeout(castPrefetchTimer);  // a close within the 120ms debounce must not
                                    // let the stale callback claim the NEXT lifecycle
}
function positionPop(pop, btn) {
  pop.classList.add("open");
  popAnchor = btn;
  const pr = document.body.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const left = br.left - pr.left;
  const maxLeft = document.body.clientWidth - pop.offsetWidth - 10;
  pop.style.left = Math.max(10, Math.min(left, maxLeft)) + "px";
  let top = br.bottom - pr.top + 6;
  if (top + pop.offsetHeight > document.body.clientHeight - 8) top = (br.top - pr.top) - pop.offsetHeight - 6;
  pop.style.top = Math.max(8, top) + "px";
}
// Empty-state rows for the picker's device list. "Scanning network…" holds the
// spot while the host's warm rescan runs; the final cast-devices-update replaces
// it with devices, "No devices found", or the scan error.
function castEmptyRow(bold, text) {
  return h("div", { class: "pop-empty" }, [h("b", { text: bold }), text]);
}
function castScanningRow() { return castEmptyRow("Scanning network…", "Looking for TVs on your network."); }
function castNoDevicesRow(err) {
  return err ? castEmptyRow("Scan failed", err)
             : castEmptyRow("No devices found", "Make sure the TV is on and on the same network as this PC.");
}
function updateCastCount(n) {
  if (castCountEl && popCast.contains(castCountEl))
    castCountEl.textContent = n + (n === 1 ? " device" : " devices");
}
// Render the device rows into the picker's list container. Context (which item a
// click casts) comes from castPickerItem/castPickerTitle so live
// cast-devices-update re-renders reuse it; the focused row is preserved (by
// device id) across the rebuild for keyboard users.
function renderCastDevices(list, devices) {
  const item = castPickerItem, title = castPickerTitle;
  const active = document.activeElement;
  const focusId = active && active.classList && active.classList.contains("pop-row") && list.contains(active)
    ? active.dataset.devId : null;
  list.replaceChildren();
  for (const d of devices) {
    const row = h("button", {
      class: "pop-row",
      dataset: { devId: String(d.id) },
      title: item ? "Cast to " + d.name : "Use a stream's Cast button to pick what to send",
      onClick: !item ? null : () => castTo(d, item, title),
    }, [
      h("span", { class: "l" }, [
        h("b", { text: d.name }),
        h("span", { text: [d.model, d.protocol === "dlna" ? "DLNA" : "AirPlay"].filter(Boolean).join(" · ") }),
      ]),
      h("span", { class: "r", text: d.unsupported ? "soon" : "" }),
    ]);
    if (d.unsupported) { row.style.opacity = "0.45"; row.style.cursor = "default"; }
    list.appendChild(row);
    if (focusId != null && String(d.id) === focusId) row.focus();
  }
  updateCastCount(devices.length);
}
async function buildCastPicker(item, btn) {
  const myGen = ++castPickerGen;   // reopening for another item invalidates this build
  const title = item ? ((item.pageTitle || "").trim() || item.name || "this stream") : "";
  castPickerItem = item; castPickerTitle = title;
  castPrefetched = true;           // the open IS this lifecycle's warm discover
  clearTimeout(castPrefetchTimer);
  const head = h("div", { class: "pop-head" }, ["Cast to", item ? h("b", { title: title, text: title }) : null]);
  castDevList = h("div", { class: "pop-devlist" }, [castScanningRow()]);
  popCast.replaceChildren(head, castDevList);
  positionPop(popCast, btn);

  // Warm always: the background answers instantly from its retained list (or the
  // host's cache) and the host rescans in the background — cast-devices-update
  // broadcasts then re-render the open picker live.
  const resp = await send({ type: "cast-discover", warm: true });
  // Stale build: closed while scanning, reopened for a different item (that
  // newer build owns the popover now — else this one could cast the WRONG
  // item), or the pairing PIN view replaced the popover's children (same
  // DOM-ownership guard the live-update path uses; a prefetch can make rows
  // clickable before this await resolves).
  if (myGen !== castPickerGen || !popCast.classList.contains("open")
      || !popCast.contains(castDevList)) return;
  const devices = (resp && resp.devices) || [];
  if (!resp || resp.ok === false) {
    castDevList.replaceChildren(castEmptyRow("Scan failed",
      (resp && resp.error) || "Casting needs the native helper."));
  } else if (devices.length) {
    renderCastDevices(castDevList, devices);
  }
  // An empty ok reply keeps the "Scanning network…" row — the host's rescan is
  // still running and its final cast-devices-update resolves the row either way.
  castCountEl = h("span", { text: devices.length + (devices.length === 1 ? " device" : " devices") });
  popCast.appendChild(h("div", { class: "pop-foot" }, [
    castCountEl,
    h("button", { type: "button", text: "Rescan", onClick: () => buildCastPicker(item, btn) }),
  ]));
  positionPop(popCast, btn);   // re-measure after content changes
}
function openCastPicker(item, btn) {
  if (!popCast) return;
  if (pendingCast) { send({ type: "cast-pair-cancel" }); pendingCast = null; }  // abandon any half-done pairing
  const wasOpen = popCast.classList.contains("open") && popAnchor === btn;
  closePops();
  if (wasOpen) return;
  buildCastPicker(item, btn);
}

// Cast to a chosen device. AirPlay devices that aren't paired yet need a one-time
// PIN handshake first (code shown on the TV); DLNA and already-paired devices start
// immediately.
function castTo(d, item, title) {
  if (d.protocol === "airplay" && !d.paired) {
    pendingCast = { d, item, title };
    send({ type: "cast-pair", deviceId: d.id });   // host begins pairing → code on TV
    // Defer: this same click is still bubbling, and showPinDialog's replaceChildren()
    // detaches the clicked row, so the document outside-click handler would then close
    // the popover (its e.target is no longer inside .popover). Let the click finish.
    setTimeout(() => showPinDialog(d), 0);
    return;
  }
  closePops();
  send({ type: "cast-start", deviceId: d.id, deviceName: d.name, url: item.url, title });
}

function showPinDialog(d, err) {
  if (!popCast) return;
  const input = h("input", { class: "pin-input", type: "text", inputmode: "numeric",
    maxlength: "6", placeholder: "0000", "aria-label": "Pairing code" });
  const submit = h("button", { class: "q-btn", text: "Pair", onClick: () => {
    const pin = input.value.trim();
    if (!pin) { input.focus(); return; }
    send({ type: "cast-pairPin", deviceId: d.id, pin });
    input.disabled = true; submit.disabled = true; submit.textContent = "Pairing…";
  } });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
  popCast.replaceChildren(
    h("div", { class: "pop-head" }, ["Pair with " + d.name, h("b", { text: "Enter the code shown on the TV" })]),
    err ? h("div", { class: "pin-err", text: err }) : null,
    h("div", { class: "pin-row" }, [input, submit]),
    h("div", { class: "pop-foot" }, [
      h("span", { text: "A code appears on the TV screen" }),
      h("button", { type: "button", text: "Cancel", onClick: () => { pendingCast = null; send({ type: "cast-pair-cancel" }); closePops(); } }),
    ])
  );
  // Force the popover open + positioned (it may have been closed by the click that
  // opened this dialog, or by a wrong-PIN re-show after closePops nulled the anchor).
  if (popAnchor) positionPop(popCast, popAnchor);
  else popCast.classList.add("open");
  setTimeout(() => input.focus(), 30);
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".popover") && !e.target.closest(".cast-btn") && !e.target.closest("#hdr-cast")) closePops();
});
if (listEl) listEl.addEventListener("scroll", closePops);

// Live updates from background during HLS downloads.
let refreshTimer = null;
api.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "helper-status") {
    if (msg.helper) helperStatus = msg.helper;
    renderHelperBadge();
  } else if (msg.type === "live-jobs-updated") {
    applyLiveJobsUpdate(msg);
  } else if (msg.type === "download-update") {
    const dl = msg.download;
    downloadState.set(dl.id, dl);
    const identity = downloadItemIdentity(dl);
    if (identity) itemDownloadId.set(identity, dl.id);
    const el = identity ? itemElements.get(identity) : null;
    if (el) renderProgress(el, dl);
    renderQueue();
  } else if (msg.type === "cast-update") {
    if (msg.cast) castState = msg.cast;
    if (castUiReady) renderCastSlot();
    // flashStatus owns its own reset timer — using refreshTimer here would fight
    // the media-updated debounce (either killing the error or refreshing early).
    if (msg.error) { pendingCast = null; flashStatus(msg.error); }
  } else if (msg.type === "cast-devices-update") {
    // Live push from the host's warm rescan → refresh the open picker in place.
    // Guard: the list must still be inside the popover (the pairing PIN view
    // replaces the popover's children, and then this update must not clobber it).
    if (popCast && popCast.classList.contains("open") && castDevList && popCast.contains(castDevList)) {
      const devices = msg.devices || [];
      if (devices.length) {
        renderCastDevices(castDevList, devices);
        // A final that ALSO carries an error means these are cached rows and
        // the refresh failed — say so instead of silently looking fresh.
        if (msg.final && msg.error) flashStatus(msg.error);
      }
      else if (msg.final) {
        // Scan complete and still nothing — clear the "Scanning network…" row.
        castDevList.replaceChildren(castNoDevicesRow(msg.error));
        updateCastCount(0);
      }
      if (popAnchor) positionPop(popCast, popAnchor);   // re-measure after content changes
    }
  } else if (msg.type === "cast-pair") {
    // Ignore replies for a device we're no longer pairing (stale/other selection).
    if (!pendingCast || (msg.id && msg.id !== pendingCast.d.id)) return;
    // Some devices don't show a code (needsPin false) — pair straight through.
    if (!msg.needsPin) send({ type: "cast-pairPin", deviceId: pendingCast.d.id, pin: "" });
  } else if (msg.type === "cast-paired") {
    if (!pendingCast || (msg.id && msg.id !== pendingCast.d.id)) return;   // stale/other device
    if (msg.ok) {
      const { d, item, title } = pendingCast;
      pendingCast = null; d.paired = true;
      closePops();
      send({ type: "cast-start", deviceId: d.id, deviceName: d.name, url: item.url, title });
    } else {
      // Wrong code: the host closed that pairing handler, so a plain retry would hit a
      // dead session. Begin a fresh pairing (new code on the TV) before re-showing.
      send({ type: "cast-pair", deviceId: pendingCast.d.id });
      showPinDialog(pendingCast.d, "That code didn't work — a new code is on the TV. Try again.");
    }
  } else if (msg.type === "media-updated" && msg.tabId === currentTabId) {
    // A stream was detected or a manifest finished parsing — re-render soon.
    // Debounced so bursts of detections don't cause flicker.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  }
});

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("settings").addEventListener("click", () => {
  if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
});
function toggleAllTabs() {
  allTabs = !allTabs;
  document.getElementById("alltabs").classList.toggle("active", allTabs);
  const link = document.getElementById("alltabs2");
  if (link) { link.classList.toggle("active", allTabs); link.textContent = allTabs ? "This tab" : "All tabs"; }
  statusEl.textContent = allTabs ? "Showing streams from all tabs" : "Watching this tab";
  refresh();
}
document.getElementById("alltabs").addEventListener("click", toggleAllTabs);
const allTabsLink = document.getElementById("alltabs2");
if (allTabsLink) allTabsLink.addEventListener("click", toggleAllTabs);
document.getElementById("clear").addEventListener("click", async () => {
  await send({ type: "clear", tabId: currentTabId });
  render([]);
});

// Queue: dismiss every finished/failed entry (keeps the active ones).
const queueClearBtn = document.getElementById("queue-clear");
if (queueClearBtn) queueClearBtn.addEventListener("click", () => {
  for (const [id, dl] of downloadState) if (queueRank(dl) >= 2) downloadState.delete(id);
  renderQueue();
});

// Header cast indicator → open the device picker (preview).
if (hdrCastBtn) hdrCastBtn.addEventListener("click", () => openCastPicker(null, hdrCastBtn));

// Hover prefetch: warm the host's device union (and the background's retained
// list) BEFORE any click, so the picker opens onto a ready list. Debounced,
// fire-and-forget, at most one warm discover per popover lifecycle (closePops
// resets the flag; buildCastPicker's own warm request claims it on open).
function prefetchCastDevices() {
  if (castPrefetched || !castUiReady) return;
  clearTimeout(castPrefetchTimer);
  castPrefetchTimer = setTimeout(() => {
    if (castPrefetched) return;
    castPrefetched = true;
    send({ type: "cast-discover", warm: true });   // fire-and-forget
  }, 120);
}
if (hdrCastBtn) hdrCastBtn.addEventListener("mouseenter", prefetchCastDevices);
// .cast-btn rows are rebuilt on every render — delegate. (mouseover bubbles;
// mouseenter does not, so a document-level mouseenter listener would never fire.)
document.addEventListener("mouseover", (e) => {
  if (e.target && e.target.closest && e.target.closest(".cast-btn")) prefetchCastDevices();
});

// ---- one-click update from the popup (no about:addons needed) ----
// Kicks the same GitHub check the settings page uses: the helper updates itself (guardian)
// and, if the signed extension is behind, we surface a one-tap install of the new .xpi.
const RELEASE_BASE = "https://github.com/g9xdev/mCatcher/releases/download";
let _statusReset = null;
function flashStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.remove("clickable");
  statusEl.onclick = null;
  clearTimeout(_statusReset);
  _statusReset = setTimeout(() => refresh(), 5000);   // restore the tab-watching status
}
document.getElementById("update").addEventListener("click", async () => {
  const btn = document.getElementById("update");
  btn.classList.add("active");
  flashStatus("Checking for updates…");
  clearTimeout(_statusReset);                          // keep 'checking…' until a result lands
  await send({ type: "update-extension" });
  setTimeout(() => btn.classList.remove("active"), 1500);
});
api.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "github-update") {
    const r = msg.result || {};
    if (r.reached === false) flashStatus("Couldn't reach GitHub — check your connection");
    else if (r.newer === false) flashStatus("Up to date ✓");
    else if (r.newer) flashStatus("Downloading update…");
  } else if (msg.type === "update-result") {
    const r = msg.result || {};
    if (r.available === false) flashStatus("Up to date ✓");
    else if (r.deferred) flashStatus("Update ready — deferred");
    else if (r.available) flashStatus("Installing helper — Firefox will restart");
  } else if (msg.type === "ext-update-available" && msg.version) {
    // The signed add-on can only be (re)installed by Firefox — offer a one-tap install.
    const url = RELEASE_BASE + "/v" + msg.version + "/media_catcher-" + msg.version + ".xpi";
    clearTimeout(_statusReset);
    statusEl.textContent = "Install v" + msg.version + " →";
    statusEl.classList.add("clickable");
    statusEl.onclick = () => { api.tabs.create({ url }); window.close(); };
  }
});

init();
