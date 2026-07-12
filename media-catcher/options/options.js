"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;

const FIELDS = ["defaultQuality", "concurrency", "maxConcurrentDownloads", "retries", "filenameTemplate", "saveFolder", "updateExtDir", "updateZipDir", "autoUpdate", "convertCodec", "convertQuality", "convertEncoder", "preferHighestRendition", "minDirectSizeMB", "captureSubtitles", "notifications"];

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
  loadDiagnostics(true);
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

// A signed extension can only be updated by Firefox — surface the new version.
api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "ext-update-available") return;
  const s = get("updateStatus");
  s.textContent = "Version v" + (msg.version || "?") + " available — install the new signed .xpi from the releases page.";
});

// ---- native helper status (connection state + version) ----
let helperState = "disconnected";
function renderHelper(h) {
  const el = get("helperStatus");
  if (!el) return;
  helperState = (h && h.state) || "disconnected";
  const txt = el.querySelector(".htext");
  el.classList.remove("ok", "warn", "off");
  const ver = h && h.version ? " · v" + h.version : "";
  if (helperState === "ready") {
    el.classList.add("ok"); txt.textContent = "Native helper connected" + ver;
  } else if (helperState === "no-ffmpeg") {
    el.classList.add("warn"); txt.textContent = "Helper connected, ffmpeg missing — re-run the installer" + ver;
  } else if (helperState === "connecting") {
    el.classList.add("warn"); txt.textContent = "Connecting to the native helper…";
  } else {
    el.classList.add("off"); txt.textContent = "Native helper not connected — click to install it";
  }
}
get("helperStatus").addEventListener("click", async () => {
  if (helperState === "disconnected") { send({ type: "open-helper-setup" }); return; }
  const r = await send({ type: "recheck-helper" });
  if (r && r.helper) renderHelper(r.helper);
});
api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "helper-status" && msg.helper) renderHelper(msg.helper);
});
try { get("extVer").textContent = api.runtime.getManifest().version; } catch (e) {}
send({ type: "helper-status" }).then((r) => { if (r && r.helper) renderHelper(r.helper); }).catch(() => {});

// ---- diagnostics: versions, update history, live log console --------------
const LEVEL_CLASS = { info: "l-info", warn: "l-warn", error: "l-error", debug: "l-debug" };
const OUTCOME_CLASS = {
  applied: "o-ok", "up-to-date": "o-dim", deferred: "o-warn", "update-available": "o-warn",
  "verify-failed": "o-bad", reverted: "o-bad", error: "o-bad", "guardian-did-not-run": "o-bad", unknown: "o-warn",
};
let histEvents = [];

function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString(); } catch (e) { return ""; } }
function fmtDateTime(ts) { try { return new Date(ts).toLocaleString(); } catch (e) { return ""; } }

function logLineEl(line) {
  const row = document.createElement("div");
  row.className = "log-line " + (LEVEL_CLASS[line.level] || "l-info");
  const t = document.createElement("span"); t.className = "lt"; t.textContent = fmtTime(line.ts);
  const s = document.createElement("span"); s.className = "ls"; s.textContent = line.src || "ext";
  const m = document.createElement("span"); m.className = "lm"; m.textContent = line.msg || "";
  row.append(t, s, m);
  return row;
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 40; }

function appendLog(line) {
  const el = get("logConsole");
  if (!el) return;
  const stick = get("logAutoscroll").checked && nearBottom(el);
  el.appendChild(logLineEl(line));
  while (el.childElementCount > 1000) el.removeChild(el.firstChild);
  if (stick) el.scrollTop = el.scrollHeight;
}

function seedConsole(logs) {
  const el = get("logConsole");
  if (!el) return;
  el.replaceChildren();
  for (const l of (logs || [])) el.appendChild(logLineEl(l));
  el.scrollTop = el.scrollHeight;
}

function renderEvents(events) {
  const tbody = get("updHistory").querySelector("tbody");
  const empty = get("updHistoryEmpty");
  tbody.replaceChildren();
  const evs = (events || []).slice().reverse();   // newest first
  empty.style.display = evs.length ? "none" : "";
  get("updHistory").style.display = evs.length ? "" : "none";
  for (const e of evs) {
    const tr = document.createElement("tr");
    for (const c of [fmtDateTime(e.ts), e.component || "",
                     (e.from || e.to) ? ((e.from || "?") + " → " + (e.to || "?")) : "—", e.source || "—"]) {
      const td = document.createElement("td"); td.textContent = c; tr.appendChild(td);
    }
    const oc = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "obadge " + (OUTCOME_CLASS[e.outcome] || "o-warn");
    badge.textContent = e.outcome || "?";
    oc.appendChild(badge);
    if (e.detail) { const d = document.createElement("div"); d.className = "odetail"; d.textContent = e.detail; oc.appendChild(d); }
    tr.appendChild(oc);
    tbody.appendChild(tr);
  }
}

function renderVersions(resp) {
  const ext = (resp && resp.extVersion) || api.runtime.getManifest().version;
  get("verExt").textContent = "v" + ext;
  const env = resp && resp.report && resp.report.env;
  const hostV = (resp && resp.report && resp.report.host) || (env && env.hostVersion);
  get("verHost").textContent = hostV ? ("v" + hostV) : "not connected";
  const ve = get("verEnv");
  if (env) {
    const mark = (b) => (b ? "✓" : "✗");
    ve.textContent = "PowerShell " + mark(!!env.powershell) + " · Firefox " + mark(!!env.firefox)
      + " · guardian.ps1 " + mark(env.guardianPresent) + " · host dir writable " + mark(env.hostDirWritable)
      + " · elevated " + (env.elevated ? "yes" : "no") + " · " + (env.runningPythonw ? "pythonw" : "python");
    ve.title = "Config variant: " + (env.configVariant || "?") + "\nHost dir: " + (env.hostDir || "?")
      + "\nPython: " + (env.python || "?") + "\nBackups: " + (env.backupRoot || "?")
      + "\nguardian.log: " + (env.guardianLogExists ? "present" : "never written");
    ve.style.display = "";
  } else {
    ve.textContent = "Helper not connected — version, environment, and history come from the helper.";
    ve.style.display = "";
  }
}

async function loadDiagnostics(seed) {
  const resp = await send({ type: "get-update-report" });
  if (!resp) return resp;
  // The host's durable update-history is the source of truth — it survives the Firefox
  // restart a failed update triggers, whereas the in-memory buffer can lose that last
  // outcome. Fall back to the volatile buffer only when the helper isn't connected.
  const durable = (resp.report && resp.report.history) || [];
  histEvents = durable.length ? durable.slice() : (resp.events || []);
  renderVersions(resp);
  renderEvents(histEvents);
  if (seed) seedConsole(resp.logs);
  return resp;
}

// Live streams from the background page.
api.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === "log-line" && msg.line) appendLog(msg.line);
  else if (msg.type === "update-event" && msg.event) { histEvents.push(msg.event); renderEvents(histEvents); }
});

function flashBtn(btnId, text) {
  const b = get(btnId); if (!b) return;
  const prev = b.textContent; b.textContent = text;
  setTimeout(() => (b.textContent = prev), 1200);
}

get("refreshDiag").addEventListener("click", () => loadDiagnostics(true));
get("runDiag").addEventListener("click", async () => {
  const resp = await loadDiagnostics(false);   // helper streams its env line into the console
  const tail = resp && resp.report && resp.report.guardianTail;
  if (tail && tail.trim()) {
    appendLog({ ts: Date.now(), level: "info", src: "guardian", msg: "— guardian.log tail —" });
    for (const ln of tail.split(/\r?\n/)) {
      if (ln.trim()) appendLog({ ts: Date.now(), level: /fail|fatal|error/i.test(ln) ? "error" : "info", src: "guardian", msg: ln });
    }
  }
});
get("copyLog").addEventListener("click", async () => {
  const el = get("logConsole");
  // Join each row's fields with a tab — textContent alone would mash time/src/msg together.
  const text = Array.from(el.children).map((r) => Array.from(r.children).map((c) => c.textContent).join("\t")).join("\n");
  try { await navigator.clipboard.writeText(text); flashBtn("copyLog", "Copied ✓"); }
  catch (e) { flashBtn("copyLog", "Copy failed"); }
});
get("clearLog").addEventListener("click", async () => {
  await send({ type: "clear-logs" });
  get("logConsole").replaceChildren();
});

load();
