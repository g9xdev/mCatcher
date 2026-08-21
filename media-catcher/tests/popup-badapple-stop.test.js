"use strict";
/*
 * Stopping BadApple from the popup.
 *
 * WHERE THE CONTROL LIVES IS THE POINT. In the Downloads header, beside "Clear
 * done", a bare "Stop" reads as "stop my downloads" — which is not what it
 * does. It sits with the casting UI instead, under "Now casting", where the
 * thing being stopped is plainly the thing being played, and it is labelled so
 * the reading does not depend on where the eye lands.
 *
 * The control is offered only when the helper reports BadApple present, the
 * same gate "Open in BadApple" already uses.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { mediaCatcherRoot } = require("./harness/load-lib.js");

function popupSource() {
  return fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.js"), "utf8");
}

function extractNamedFunction(source, name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const m = re.exec(source);
  if (!m) throw new Error("function not found: " + name);
  let i = source.indexOf("{", m.index);
  if (i < 0) throw new Error("no body for " + name);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  throw new Error("unbalanced braces for " + name);
}

function node(tag, props, children) {
  const el = {
    tag,
    props: props || {},
    children: [],
    childElementCount: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) {
      this.children.push(child);
      this.childElementCount = this.children.length;
      return child;
    },
    replaceChildren() {
      this.children = Array.from(arguments).filter((child) => child != null);
      this.childElementCount = this.children.length;
    },
  };
  const list = children == null ? [] : (Array.isArray(children) ? children : [children]);
  for (const child of list) if (child != null) el.appendChild(child);
  return el;
}

function walk(root, out) {
  out = out || [];
  if (root && typeof root === "object") {
    out.push(root);
    for (const child of root.children || []) walk(child, out);
  }
  return out;
}

function textOf(root) {
  return walk(root)
    .map((n) => {
      const fromProps = n.props && typeof n.props.text === "string" ? n.props.text : "";
      const fromNode = typeof n.textContent === "string" ? n.textContent : "";
      return fromNode || fromProps;
    })
    .join(" ");
}

function buttons(root) {
  return walk(root).filter((n) => n && n.tag === "button");
}

function label(button) {
  return button.textContent != null ? button.textContent : button.props.text;
}

function harness(options) {
  options = options || {};
  const sent = [];
  const slot = node("div");
  const sandbox = {
    console,
    helperStatus: options.helperStatus || { state: "ready", badapple: true },
    badAppleSlotEl: options.noSlot ? null : slot,
    send(message) {
      sent.push(message);
      const reply = options.reply ? options.reply(message) : { ok: true };
      return Promise.resolve(reply);
    },
    h: node,
  };
  const pieces = ["helperOn", "renderBadAppleSlot"]
    .map((name) => extractNamedFunction(popupSource(), name));
  vm.runInNewContext(
    pieces.join("\n") + "\nthis.renderBadAppleSlot = renderBadAppleSlot;",
    sandbox
  );
  return { sandbox, slot, sent };
}

function stopButton(h) {
  return buttons(h.slot).find((b) => /stop/i.test(label(b) || ""));
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the stop control sits in its own slot next to the casting UI", () => {
  const html = fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.html"), "utf8");
  const castSlot = html.indexOf('id="cast-slot"');
  const badApple = html.indexOf('id="badapple-slot"');
  const queueTitle = html.indexOf('id="queue-title"');
  assert.ok(badApple > 0, "the slot exists");
  assert.ok(castSlot < badApple, "it follows the cast slot");
  assert.ok(badApple < queueTitle,
    "and stays above the Downloads header, where it would read as stopping downloads");
});

test("the Downloads header offers no stop control", () => {
  const html = fs.readFileSync(path.join(mediaCatcherRoot, "popup", "popup.html"), "utf8");
  const header = html.slice(html.indexOf('id="queue-title"'), html.indexOf('id="queue"'));
  assert.equal(/stop/i.test(header), false,
    "beside Clear done, a stop control reads as stopping the downloads");
});

test("the label names BadApple, so it cannot be read as stopping a download", () => {
  const h = harness();
  h.sandbox.renderBadAppleSlot();
  const stop = stopButton(h);
  assert.ok(stop, "the control is rendered");
  assert.match(label(stop), /badapple/i);
  assert.equal(/download/i.test(label(stop)), false);
  assert.match(String(stop.props.title), /download/i,
    "and the tooltip says outright that downloads are untouched");
});

test("clicking it sends badapple-stop and nothing else", async () => {
  const h = harness();
  h.sandbox.renderBadAppleSlot();
  stopButton(h).props.onClick();
  await flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, "badapple-stop");
  assert.deepEqual(Object.keys(h.sent[0]), ["type"],
    "the popup names no player, no path and no device");
});

test("a refusal is shown rather than swallowed", async () => {
  const h = harness({ reply: () => ({ ok: false, error: "BadApple is not running" }) });
  h.sandbox.renderBadAppleSlot();
  const stop = stopButton(h);
  stop.props.onClick();
  await flush();
  assert.match(textOf(h.slot), /not running/);
  assert.equal(stop.disabled, false, "and the control is usable again");
});

test("with BadApple absent the slot stays empty", () => {
  const h = harness({ helperStatus: { state: "ready" } });
  h.sandbox.renderBadAppleSlot();
  assert.equal(h.slot.children.length, 0,
    "a control that could only ever fail is not offered");
});

test("with the helper down the slot stays empty", () => {
  const h = harness({ helperStatus: { state: "disconnected", badapple: true } });
  h.sandbox.renderBadAppleSlot();
  assert.equal(h.slot.children.length, 0);
});

test("a helper that reports BadApple after the fact repaints the slot", () => {
  const h = harness({ helperStatus: { state: "disconnected" } });
  h.sandbox.renderBadAppleSlot();
  assert.equal(h.slot.children.length, 0);
  h.sandbox.helperStatus = { state: "ready", badapple: true };
  h.sandbox.renderBadAppleSlot();
  assert.ok(stopButton(h), "the control appears without reopening the popup");
});

// The helper-status push is handled at popup.js top level, where no harness can
// reach it. What is checkable is that the repaint hangs off the one function
// that push already calls.
test("the helper-status repaint reaches the slot", () => {
  const badge = extractNamedFunction(popupSource(), "renderHelperBadge");
  assert.match(badge, /renderBadAppleSlot\(\)/,
    "helper status changing must repaint the control it gates");
  const source = popupSource();
  assert.match(source, /helper-status[\s\S]{0,200}renderHelperBadge\(\)/,
    "and the helper-status message is what calls it");
});

test("nothing in the popup names the BadApple executable", () => {
  const source = popupSource();
  assert.equal(/BadApple\.App/i.test(source), false);
  assert.equal(/--stop/.test(source), false,
    "the popup sends a verb; the host owns the command line");
});
