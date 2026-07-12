"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;

let currentTabId = null;
let pageTitle = "";
let allTabs = false;
const downloadState = new Map();   // id -> download
const itemDownloadId = new Map();  // item.url -> download id (progress binding)
const itemElements = new Map();    // item.url -> rendered element

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const footCount = document.getElementById("foot-count");

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

function baseFilename(item) {
  const t = (item.pageTitle || pageTitle || "").trim();
  if (t) return t;
  return (item.name || "video").replace(/\.(m3u8|mpd)$/i, "");
}

function send(msg) {
  return new Promise((resolve) => {
    api.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

async function init() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) return;
  currentTabId = tabs[0].id;
  pageTitle = tabs[0].title || "";
  await refresh();
}

let helperStatus = { state: "disconnected" };

async function refresh() {
  const resp = await send({ type: "get-media", tabId: currentTabId, allTabs });
  const items = (resp && resp.items) || [];
  if (resp && resp.helper) helperStatus = resp.helper;
  if (resp && resp.downloads) {
    for (const d of resp.downloads) {
      downloadState.set(d.id, d);
      if (d.url) itemDownloadId.set(d.url, d.id); // rebind so in-flight jobs re-render
    }
  }
  render(items);
}

function render(items) {
  listEl.replaceChildren();
  itemElements.clear();
  footCount.textContent = items.length + (items.length === 1 ? " stream" : " streams");
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
    const id = itemDownloadId.get(item.url);
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
    itemElements.set(item.url, el);
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

  // Amber data readout: KIND · quality · bitrate · duration.
  const quality = item.height ? item.height + "p" : (item.resolution || "");
  const metaLine = [kindLabel, quality, bitrateLabel(item), item.duration ? fmtDuration(item.duration) : ""]
    .filter(Boolean).join(" · ");
  const hostLine = [hostOf(item.url), item.size ? humanSize(item.size) : "",
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

  // Prefer the page/stream title over the (often random) playlist filename.
  const displayName = (item.pageTitle || "").trim() || item.name || item.url;

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

  const el = h("div", { class: "item" + (item.junk ? " junk" : ""), dataset: { url: item.url } }, [
    h("div", { class: "item-head" }, [thumb, info]),
    actions,
    slot,
  ]);

  const copyBtn = h("button", {
    class: "btn ghost sm",
    text: "Copy URL",
    onClick: () => {
      navigator.clipboard.writeText(item.url).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy URL"), 1200);
      });
    },
  });

  const cmdBtn = h("button", {
    class: "btn ghost sm",
    title: "Copy a yt-dlp / ffmpeg / streamlink command",
    onClick: () => toggleCommandMenu(item, el),
  }, [h("span", { class: "cmd", text: "⌘ cmd" })]);

  if (item.drm) {
    // DRM can't be saved by any downloader; be explicit and offer command/URL.
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
    showLabel(el, "DRM-protected — can't be saved. Copy URL / command for reference only.", "error");
  } else if ((kind === "hls" || kind === "dash") && item.variants && item.variants.length) {
    // Qualities shown inline (works for HLS masters and DASH).
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
    slot.appendChild(renderQualities(item, el, item.variants));
    if (item.hasAudio) appendNote(slot, "Has separate audio — saved as 2 files; a merge command is provided on completion.");
  } else if ((kind === "hls" || kind === "dash") && item.enrichState === "loading") {
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
    showLabel(el, "Reading qualities…", "");
  } else if (kind === "hls" && item.isMaster === false) {
    if (item.isLive) {
      actions.appendChild(h("button", { class: "btn rec",
        title: "Record this live stream; press Stop, then Save to keep it",
        onClick: () => startRecording(item, el, {}) }, [h("i"), "Record"]));
    } else {
      actions.appendChild(h("button", { class: "btn amber", text: "Download",
        onClick: () => handleDownload(item, el) }));
    }
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
  } else if (kind === "dash") {
    actions.appendChild(h("button", { class: "btn amber", text: "Download",
      onClick: () => startDownload(item, el, {}) }));
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
  } else if (kind === "youtube") {
    actions.appendChild(h("button", { class: "btn amber", text: "Download highest quality",
      onClick: () => startDownload(item, el, {}) }));
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
  } else {
    actions.appendChild(h("button", {
      class: "btn amber",
      text: kind === "hls" ? "Download…" : "Download",
      onClick: () => handleDownload(item, el),
    }));
    actions.appendChild(cmdBtn);
    actions.appendChild(copyBtn);
  }

  const existingId = itemDownloadId.get(item.url);
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
    wrap.appendChild(
      h("button", {
        class: "q-btn",
        text: v.label,
        onClick: () => startDownload(item, el, v.uri ? { variantUrl: v.uri } : { variantId: v.id }),
      })
    );
  }
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

async function startDownload(item, el, selection) {
  selection = selection || {};
  const filename = baseFilename(item);
  showLabel(el, item.kind === "direct" ? "Saving…" : "Starting…", "");
  const resp = await send({
    type: "download", item, tabId: item.tabId || currentTabId, filename,
    variantUrl: selection.variantUrl || null,
    variantId: selection.variantId || null,
  });
  if (resp && resp.ok === false) {
    showLabel(el, resp.error || "Download failed.", "error");
  }
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
  const res = q.resolution || (q.height ? q.height + "p" : "");
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
    children.push(h("div", { class: "savedchip", role: "status" }, [
      h("span", { class: "check", text: "✓" }), "Saved",
      path ? h("span", { class: "path", text: path, title: path }) : null,
    ]));
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

  const pct = dl.progress && dl.progress.total
    ? Math.round((dl.progress.done / dl.progress.total) * 100) : 0;

  let statusText, cls = "";
  if (dl.status === "error") { statusText = dl.error || "Error"; cls = "error"; }
  else if (dl.status === "done") { statusText = "Saved ✓"; cls = "done"; }
  else if (dl.status === "audio") statusText = "Downloading audio track…";
  else if (dl.status === "saving") statusText = "Assembling file…";
  else if (dl.status === "parsing") statusText = "Reading manifest…";
  else if (dl.status === "cancelled") statusText = "Cancelled";
  else statusText = "Downloading";

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

// Live updates from background during HLS downloads.
let refreshTimer = null;
api.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "helper-status") {
    if (msg.helper) helperStatus = msg.helper;
    renderHelperBadge();
  } else if (msg.type === "download-update") {
    const dl = msg.download;
    downloadState.set(dl.id, dl);
    if (dl.url) itemDownloadId.set(dl.url, dl.id);
    const el = itemElements.get(dl.url);
    if (el) renderProgress(el, dl);
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
document.getElementById("alltabs").addEventListener("click", (e) => {
  allTabs = !allTabs;
  e.currentTarget.classList.toggle("active", allTabs);
  statusEl.textContent = allTabs ? "Showing streams from all tabs" : "Watching this tab";
  refresh();
});
document.getElementById("clear").addEventListener("click", async () => {
  await send({ type: "clear", tabId: currentTabId });
  render([]);
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
