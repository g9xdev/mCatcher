"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;

const FIELDS = ["defaultQuality", "concurrency", "maxConcurrentDownloads", "retries", "filenameTemplate", "saveFolder", "updateExtDir", "updateZipDir", "autoUpdate", "convertH265", "h265Quality", "preferHighestRendition", "minDirectSizeMB", "captureSubtitles", "notifications"];

function send(msg) {
  return new Promise((resolve) => api.runtime.sendMessage(msg, resolve));
}

function get(id) { return document.getElementById(id); }

function apply(settings) {
  for (const f of FIELDS) {
    const el = get(f);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!settings[f];
    else el.value = settings[f];
  }
}

function collect() {
  const out = {};
  for (const f of FIELDS) {
    const el = get(f);
    if (!el) continue;
    if (el.type === "checkbox") out[f] = el.checked;
    else if (el.type === "number") out[f] = parseInt(el.value, 10);
    else out[f] = el.value;
  }
  return out;
}

async function load() {
  const r = await send({ type: "get-settings" });
  if (r && r.settings) apply(r.settings);
  loadHistory();
}

async function loadHistory() {
  const r = await send({ type: "get-history" });
  const ul = get("history");
  ul.replaceChildren();
  const hist = (r && r.history) || [];
  if (!hist.length) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = "No downloads yet.";
    li.appendChild(span);
    ul.appendChild(li);
    return;
  }
  for (const h of hist) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "h-name";
    name.textContent = (h.kind ? "[" + h.kind + "] " : "") + h.name;
    const when = document.createElement("span");
    when.textContent = new Date(h.ts).toLocaleString();
    li.appendChild(name);
    li.appendChild(when);
    ul.appendChild(li);
  }
}

async function save() {
  await send({ type: "set-settings", settings: collect() });
}

get("save").addEventListener("click", async () => {
  await save();
  const s = get("status");
  s.textContent = "Saved ✓";
  setTimeout(() => (s.textContent = ""), 1500);
});

get("reset").addEventListener("click", async () => {
  const r = await send({ type: "get-settings" });
  if (r && r.defaults) {
    await send({ type: "set-settings", settings: r.defaults });
    apply(r.defaults);
    const s = get("status");
    s.textContent = "Reset ✓";
    setTimeout(() => (s.textContent = ""), 1500);
  }
});

get("clearHistory").addEventListener("click", async () => {
  await send({ type: "clear-history" });
  loadHistory();
});

// Native folder picker (requires the helper). Wires a Browse button to a field.
function wireBrowse(btnId, inputId) {
  const btn = get(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const prev = btn.textContent;
    btn.textContent = "…"; btn.disabled = true;
    const r = await send({ type: "pick-folder", dir: get(inputId).value });
    btn.textContent = prev; btn.disabled = false;
    if (r && r.ok && r.dir) { get(inputId).value = r.dir; await save(); }
    else if (r && r.ok === false) {
      const s = get("status");
      s.textContent = r.error || "Folder picker needs the helper.";
      setTimeout(() => (s.textContent = ""), 2500);
    }
  });
}
wireBrowse("browseSave", "saveFolder");
wireBrowse("browseExtDir", "updateExtDir");
wireBrowse("browseZipDir", "updateZipDir");

// Toggle the helper's package-folder watcher when the checkbox changes.
get("autoUpdate").addEventListener("change", async () => {
  await save();
  await send({ type: "watch-updates", enable: get("autoUpdate").checked });
});

// Check for & install an update (helper drives the rest, incl. the restart prompt).
get("checkUpdate").addEventListener("click", async () => {
  await save();                                  // persist paths before the helper reads them
  const s = get("updateStatus");
  s.textContent = "Checking GitHub… watch for the helper's dialog.";
  const r = await send({ type: "update-extension" });
  if (r && r.ok === false) s.textContent = r.error || "Update needs the native helper.";
});

// The helper reports back what it did.
api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "update-result") return;
  const s = get("updateStatus");
  const res = msg.result || {};
  if (res.ok === false) s.textContent = "Update error: " + (res.error || "unknown");
  else if (res.available === false) s.textContent = "Up to date (v" + (res.version || "?") + ").";
  else if (res.deferred) s.textContent = "Update available (" + (res.summary || "") + ") — deferred.";
  else if (res.available) s.textContent = "Guardian installing: " + (res.summary || "update") + " — it will verify, restart Firefox, and revert if anything fails.";
});

// GitHub check progress (arrives before the guardian's own update-result).
api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "github-update") return;
  const s = get("updateStatus");
  const res = msg.result || {};
  if (res.reached === false) s.textContent = "Couldn't reach GitHub — check your connection.";
  else if (res.newer === false) s.textContent = "Up to date (latest release v" + (res.latest || "?") + ").";
  else if (res.newer && res.downloaded && res.downloaded.length) s.textContent = "Found v" + (res.latest || "?") + " on GitHub — downloading…";
});

load();
