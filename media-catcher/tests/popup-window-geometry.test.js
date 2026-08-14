"use strict";
/*
 * Rendered geometry regression for the main UI.
 *
 * WHY A HEADLESS WINDOW IS THE RIGHT MODEL NOW. An earlier version of this test
 * loaded popup.html as an ordinary page while the real surface was a
 * browser-action popup. A popup derives its size from its content; a page's
 * width is imposed by the window. So the test ran real Firefox layout in the
 * WRONG LAYOUT MODE, passed at both widths, and missed a change that collapsed
 * the popup to a sliver in the browser.
 *
 * The main UI is now opened with windows.create, so a headless window at the
 * same size reproduces the actual layout mode rather than approximating it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

const FIREFOX = "C:\\Program Files\\Firefox Developer Edition\\firefox.exe";
// background.js opens the rail at this width; the test must use the same one.
const WINDOW_WIDTH = 860;
const WINDOW_HEIGHT = 680;

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const BROWSER_FAKE = `
<script>
(function () {
  const settings = { showRail: true, showQueue: true, enableCasting: false,
                     maxConcurrentDownloads: 2, concurrency: 2, retries: 1 };
  const items = [{ id: "media:opaque:1", tabId: 1, kind: "direct",
                   proposedFilename: "11475-makemebi.net.mp4",
                   sizeBytes: 1395864371, sizeConfidence: "exact", variants: [] }];
  const downloads = [{ id: "job:opaque:1", state: "completed", mediaId: "media:opaque:1",
                       name: "11475-makemebi.net.mp4", saveMode: "default" }];
  function respond(message) {
    if (!message) return {};
    if (message.type === "get-settings") return { settings: settings };
    if (message.type === "get-active-tab") return { ok: true, tabId: 1, title: "Watch", url: "https://site.example/watch" };
    if (message.type === "get-media") {
      return { items: items, downloads: downloads, helper: { state: "ready" }, cast: { state: "idle" } };
    }
    return { ok: true };
  }
  window.browser = {
    runtime: {
      id: "media-catcher@test",
      sendMessage(m, cb) { const v = respond(m); if (typeof cb === "function") { cb(v); return undefined; } return Promise.resolve(v); },
      onMessage: { addListener() {} },
      getManifest() { return { version: "1.10.0" }; },
      getURL(rel) { return rel; }, openOptionsPage() {},
    },
    tabs: { query() { return Promise.resolve([]); }, create() { return Promise.resolve(); } },
    downloads: { open() {}, show() {}, pause() {}, resume() {} },
    windows: { getCurrent() { return Promise.resolve({ width: ${WINDOW_WIDTH}, height: ${WINDOW_HEIGHT} }); } },
  };
})();
</script>
`;

const PROBE = `
<script>
(function () {
  function frame() { return new Promise((r) => requestAnimationFrame(r)); }
  async function report() {
    await frame(); await frame(); await frame();
    const right = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().right : null;
    };
    await fetch("/__metrics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewportWidth: window.innerWidth,
        rootScrollWidth: document.documentElement.scrollWidth,
        bodyRight: document.body.getBoundingClientRect().right,
        paneRight: right(".pane-right"),
        queueClearRight: right("#queue-clear"),
        footerRight: right(".foot") ,
        railVisible: document.querySelector(".pane-right")
          ? getComputedStyle(document.querySelector(".pane-right")).display !== "none" : false,
        railMode: document.documentElement.classList.contains("rail"),
      }),
    });
  }
  window.addEventListener("load", () => setTimeout(report, 500));
})();
</script>
`;

function startServer(onMetrics) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__metrics") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        res.writeHead(204).end();
        try { onMetrics(JSON.parse(body)); } catch (e) { onMetrics({ error: String(e) }); }
      });
      return;
    }
    const rel = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
    const target = path.join(mediaCatcherRoot, rel);
    if (!target.startsWith(mediaCatcherRoot)) { res.writeHead(403).end(); return; }
    let data;
    try { data = fs.readFileSync(target); } catch (e) { res.writeHead(404).end(); return; }
    if (rel === "popup/popup.html") {
      let html = data.toString("utf8");
      html = html.replace("</head>", BROWSER_FAKE + "</head>");
      html = html.replace("</body>", PROBE + "</body>");
      data = Buffer.from(html, "utf8");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function writeProfile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    "",
  ].join("\n"), "utf8");
}

async function measure(width, height) {
  let server = null, child = null, profileDir = null;
  let resolveMetrics, rejectMetrics;
  const metrics = new Promise((res, rej) => { resolveMetrics = res; rejectMetrics = rej; });
  const timer = setTimeout(() => rejectMetrics(new Error("no metrics at " + width)), 90000);
  try {
    server = await startServer(resolveMetrics);
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-win-"));
    writeProfile(profileDir);
    child = spawn(FIREFOX, ["--headless", "--no-remote", "--profile", profileDir,
      "http://127.0.0.1:" + server.address().port + "/popup/popup.html"], {
      env: Object.assign({}, process.env, {
        MOZ_HEADLESS_WIDTH: String(width), MOZ_HEADLESS_HEIGHT: String(height),
      }),
      stdio: "ignore",
    });
    child.on("error", rejectMetrics);
    return await metrics;
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (e) {}
      await new Promise((r) => { const t = setTimeout(r, 5000); child.on("exit", () => { clearTimeout(t); r(); }); });
    }
    if (server) await new Promise((r) => server.close(r));
    if (profileDir) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

const hasFirefox = fs.existsSync(FIREFOX);
const opts = { skip: hasFirefox ? false : "Firefox Developer Edition not installed", timeout: 180000 };

test("the main window renders the rail without clipping anything", opts, async () => {
  const m = await measure(WINDOW_WIDTH, WINDOW_HEIGHT);
  assert.ok(Math.abs(m.viewportWidth - WINDOW_WIDTH) <= 25,
    "expected a ~" + WINDOW_WIDTH + "px viewport, got " + m.viewportWidth);
  assert.equal(m.railMode, true, "rail mode must be on");
  assert.equal(m.railVisible, true, "the Downloads rail must be visible");

  const limit = m.viewportWidth + 1;
  assert.ok(m.rootScrollWidth <= limit,
    "horizontal overflow: scrollWidth " + m.rootScrollWidth + " > " + limit);
  assert.ok(m.bodyRight <= limit, "body right " + m.bodyRight + " > " + limit);
  assert.ok(m.paneRight !== null && m.paneRight <= limit,
    "rail clipped: right edge " + m.paneRight + " > " + limit);
  // "Clear done" sat outside the old popup; it is the visible symptom.
  assert.ok(m.queueClearRight !== null && m.queueClearRight <= limit,
    "Clear done clipped: right edge " + m.queueClearRight + " > " + limit);
});

test("the document fills the window rather than a fixed width", opts, async () => {
  const m = await measure(WINDOW_WIDTH, WINDOW_HEIGHT);
  // The old popup pinned html to 560px; in a window that leaves dead space and
  // still clips the rail. body must span the viewport it was given.
  assert.ok(m.bodyRight >= m.viewportWidth - 30,
    "body right " + m.bodyRight + " should fill a " + m.viewportWidth + "px window");
});
