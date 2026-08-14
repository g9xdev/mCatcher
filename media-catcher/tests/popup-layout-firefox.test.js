"use strict";
/*
 * Rendered geometry regression. Loads the REAL popup.html/css/js in headless
 * Firefox Developer Edition at two viewport widths and proves nothing crosses
 * the viewport edge. Node built-ins only — no test runner, no driver.
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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// A bounded stand-in for the extension APIs popup.js touches at startup.
const BROWSER_FAKE = `
<script>
(function () {
  const settings = {
    showRail: true, showQueue: true, enableCasting: false,
    maxConcurrentDownloads: 2, concurrency: 2, retries: 1,
  };
  const items = [{
    id: "media:opaque:1", tabId: 1, kind: "direct",
    proposedFilename: "11474-makemebi.net.mp4",
    sizeBytes: 1395864371, sizeConfidence: "exact",
    variants: [],
  }];
  const downloads = [{
    id: "job:opaque:1", state: "completed", mediaId: "media:opaque:1",
    name: "11474-makemebi.net.mp4", saveMode: "default",
  }];
  function respond(message) {
    if (!message) return {};
    if (message.type === "get-settings") return { settings: settings };
    if (message.type === "get-media") {
      return { items: items, downloads: downloads, helper: { state: "ready" }, cast: { state: "idle" } };
    }
    return { ok: true };
  }
  window.browser = {
    runtime: {
      id: "media-catcher@test",
      sendMessage(message, callback) {
        const value = respond(message);
        if (typeof callback === "function") { callback(value); return undefined; }
        return Promise.resolve(value);
      },
      onMessage: { addListener() {} },
      getManifest() { return { version: "1.10.0" }; },
      getURL(rel) { return rel; },
      openOptionsPage() {},
    },
    tabs: {
      query() { return Promise.resolve([{ id: 1, title: "Movie Night", url: "https://site.example/watch" }]); },
      create() { return Promise.resolve(); },
    },
    downloads: { open() {}, show() {}, pause() {}, resume() {} },
    // Deliberately huge: the popup must obey its own viewport, not this.
    windows: { getCurrent() { return Promise.resolve({ width: 2048, height: 1440 }); } },
  };
})();
</script>
`;

const PROBE = `
<script>
(function () {
  function frame() { return new Promise((r) => requestAnimationFrame(r)); }
  async function report() {
    await frame();
    await frame();
    await frame();
    const rect = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().right : null;
    };
    const metrics = {
      viewportWidth: window.visualViewport ? window.visualViewport.width : window.innerWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
      bodyRight: document.body.getBoundingClientRect().right,
      paneRight: rect(".pane-right"),
      queueClearRight: rect("#queue-clear"),
      railVisible: document.querySelector(".pane-right")
        ? getComputedStyle(document.querySelector(".pane-right")).display !== "none"
        : false,
      stacked: document.documentElement.classList.contains("rail-stacked"),
      railMode: document.documentElement.classList.contains("rail"),
    };
    await fetch("/__metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metrics),
    });
  }
  // Give init()'s async settings/media round-trip a moment to apply layout.
  window.addEventListener("load", () => setTimeout(report, 400));
})();
</script>
`;

function startServer(onMetrics) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__metrics") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(204).end();
        try { onMetrics(JSON.parse(body)); } catch (e) { onMetrics({ error: String(e) }); }
      });
      return;
    }
    const relative = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
    const target = path.join(mediaCatcherRoot, relative);
    // Never serve outside the extension root.
    if (!target.startsWith(mediaCatcherRoot)) { res.writeHead(403).end(); return; }
    let data;
    try { data = fs.readFileSync(target); } catch (e) { res.writeHead(404).end(); return; }
    const extension = path.extname(target).toLowerCase();
    if (relative === "popup/popup.html") {
      let html = data.toString("utf8");
      html = html.replace("</head>", BROWSER_FAKE + "</head>");
      html = html.replace("</body>", PROBE + "</body>");
      data = Buffer.from(html, "utf8");
    }
    res.writeHead(200, { "Content-Type": MIME[extension] || "application/octet-stream" });
    res.end(data);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function writeProfile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("datareporting.healthreport.uploadEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("app.update.auto", false);',
    "",
  ].join("\n"), "utf8");
}

// Renders the popup once at the given headless viewport and returns its metrics.
async function measureAt(width, height) {
  let server = null;
  let child = null;
  let profileDir = null;
  let resolveMetrics;
  let rejectMetrics;
  const metricsPromise = new Promise((resolve, reject) => {
    resolveMetrics = resolve;
    rejectMetrics = reject;
  });
  const timer = setTimeout(
    () => rejectMetrics(new Error("popup did not report metrics at " + width + "x" + height)),
    90000
  );
  try {
    server = await startServer((metrics) => resolveMetrics(metrics));
    const port = server.address().port;
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ff-"));
    writeProfile(profileDir);

    child = spawn(FIREFOX, [
      "--headless",
      "--no-remote",
      "--profile", profileDir,
      "http://127.0.0.1:" + port + "/popup/popup.html",
    ], {
      env: Object.assign({}, process.env, {
        MOZ_HEADLESS_WIDTH: String(width),
        MOZ_HEADLESS_HEIGHT: String(height),
      }),
      stdio: "ignore",
    });
    child.on("error", (error) => rejectMetrics(error));
    return await metricsPromise;
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) {
      try { child.kill(); } catch (e) {}
      await new Promise((resolve) => {
        const done = setTimeout(resolve, 5000);
        child.on("exit", () => { clearTimeout(done); resolve(); });
      });
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (profileDir) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

function assertContained(metrics, label) {
  const limit = metrics.viewportWidth + 1;
  assert.ok(metrics.rootScrollWidth <= limit,
    label + ": root scrollWidth " + metrics.rootScrollWidth + " > " + limit);
  assert.ok(metrics.bodyRight <= limit,
    label + ": body right " + metrics.bodyRight + " > " + limit);
  assert.ok(metrics.paneRight !== null && metrics.paneRight <= limit,
    label + ": rail right " + metrics.paneRight + " > " + limit);
  assert.ok(metrics.queueClearRight !== null && metrics.queueClearRight <= limit,
    label + ": Clear done right " + metrics.queueClearRight + " > " + limit);
}

const hasFirefox = fs.existsSync(FIREFOX);

test("rendered popup fills 800x600 as two columns without clipping",
  { skip: hasFirefox ? false : "Firefox Developer Edition not installed", timeout: 180000 },
  async () => {
    const metrics = await measureAt(800, 600);
    // Guards against a silently vacuous run if MOZ_HEADLESS_WIDTH stops applying.
    assert.ok(Math.abs(metrics.viewportWidth - 800) <= 20,
      "expected an ~800px viewport, got " + metrics.viewportWidth);
    assert.equal(metrics.railMode, true, "rail mode must be on");
    assert.equal(metrics.railVisible, true, "Downloads rail must be visible");
    assert.equal(metrics.stacked, false, "800 wide has room for two columns");
    assertContained(metrics, "800x600");
  });

test("rendered popup stacks at a clamped viewport and keeps Downloads visible",
  { skip: hasFirefox ? false : "Firefox Developer Edition not installed", timeout: 180000 },
  async () => {
    const metrics = await measureAt(560, 600);
    assert.ok(Math.abs(metrics.viewportWidth - 560) <= 20,
      "expected an ~560px viewport, got " + metrics.viewportWidth);
    assert.equal(metrics.railMode, true, "rail mode must survive a clamped viewport");
    assert.equal(metrics.railVisible, true, "Downloads must never be hidden");
    assert.equal(metrics.stacked, true, "560 wide must stack the panes");
    assertContained(metrics, "560x600");
  });
