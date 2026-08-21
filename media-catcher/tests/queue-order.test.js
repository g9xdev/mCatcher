"use strict";
/*
 * Ordering rule for the Downloads pane.
 *
 * Two properties are pinned here, because the pane had neither:
 *
 *   1. GROUPING is unchanged — the caller's rank (active, held, done, failed)
 *      still decides which block a row sits in.
 *   2. WITHIN a block the NEWEST row is first. The popup has no field it can
 *      order every row by: background.js builds its legacy download records
 *      without a createdAt, and lib/privacy.js projects createdAt onto a
 *      controller job only when that job carries one. So this module keeps its
 *      own arrival sequence, assigned the first time an id is seen.
 *
 * The sequence lives beside the rows rather than on them: popup.js drops and
 * re-inserts the projected job OBJECTS on every controller snapshot, so a stamp
 * written onto an object is gone by the next snapshot. Keyed by id it survives,
 * and ids that leave the list are pruned so the map cannot grow without bound.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./harness/load-lib.js");

const QueueOrder = loadLib("lib/queue-order.js");

function rows(list) {
  return list.map((entry) => entry.id);
}

const byId = { idOf: (entry) => entry.id, rankOf: (entry) => entry.rank };

test("module exports a factory and a locked global", () => {
  assert.equal(typeof QueueOrder.createQueueOrder, "function");
  assert.equal(Object.isFrozen(QueueOrder), true);
});

test("within one rank the newest arrival comes first", () => {
  const order = QueueOrder.createQueueOrder();
  order.order([{ id: "a", rank: 0 }], byId);
  order.order([{ id: "a", rank: 0 }, { id: "b", rank: 0 }], byId);
  const out = order.order(
    [{ id: "a", rank: 0 }, { id: "b", rank: 0 }, { id: "c", rank: 0 }],
    byId
  );
  assert.deepEqual(rows(out), ["c", "b", "a"]);
});

test("rank still groups: every active row precedes held, done and failed", () => {
  const order = QueueOrder.createQueueOrder();
  const out = order.order([
    { id: "done-old", rank: 2 },
    { id: "active-old", rank: 0 },
    { id: "failed", rank: 3 },
    { id: "held", rank: 1 },
    { id: "active-new", rank: 0 },
    { id: "done-new", rank: 2 },
  ], byId);
  assert.deepEqual(rows(out), [
    "active-new", "active-old", "held", "done-new", "done-old", "failed",
  ]);
});

test("a row keeps its place when its object is replaced wholesale", () => {
  const order = QueueOrder.createQueueOrder();
  order.order([{ id: "a", rank: 0 }, { id: "b", rank: 0 }], byId);
  // What a controller snapshot does: brand new objects for the same ids.
  const out = order.order([{ id: "a", rank: 0 }, { id: "b", rank: 0 }], byId);
  assert.deepEqual(rows(out), ["b", "a"]);
});

test("a row that changes rank keeps its arrival, so it lands newest in its new block", () => {
  const order = QueueOrder.createQueueOrder();
  order.order([{ id: "first", rank: 2 }], byId);
  order.order([{ id: "first", rank: 2 }, { id: "second", rank: 0 }], byId);
  const out = order.order(
    [{ id: "first", rank: 2 }, { id: "second", rank: 2 }],
    byId
  );
  assert.deepEqual(rows(out), ["second", "first"]);
});

test("the input array is not reordered in place", () => {
  const order = QueueOrder.createQueueOrder();
  const input = [{ id: "a", rank: 0 }, { id: "b", rank: 0 }];
  const out = order.order(input, byId);
  assert.deepEqual(rows(input), ["a", "b"]);
  assert.deepEqual(rows(out), ["b", "a"]);
  assert.notEqual(out, input);
});

test("ids that leave the list are forgotten, so the map tracks the live rows", () => {
  const order = QueueOrder.createQueueOrder();
  order.order([{ id: "a", rank: 0 }, { id: "b", rank: 0 }, { id: "c", rank: 0 }], byId);
  assert.equal(order.size(), 3);
  order.order([{ id: "b", rank: 0 }], byId);
  assert.equal(order.size(), 1, "dismissed rows must not be remembered forever");
  order.order([], byId);
  assert.equal(order.size(), 0);
});

test("a row that leaves and returns is treated as a fresh arrival", () => {
  const order = QueueOrder.createQueueOrder();
  order.order([{ id: "a", rank: 0 }, { id: "b", rank: 0 }], byId);
  order.order([{ id: "b", rank: 0 }], byId);
  const out = order.order([{ id: "a", rank: 0 }, { id: "b", rank: 0 }], byId);
  assert.deepEqual(rows(out), ["a", "b"],
    "it was re-added after b, and the pane says so");
});

test("numeric and string ids never collide", () => {
  const order = QueueOrder.createQueueOrder();
  const out = order.order([{ id: 7, rank: 0 }, { id: "7", rank: 0 }], byId);
  assert.equal(order.size(), 2);
  assert.deepEqual(rows(out), ["7", 7], "the second one seen is the newer one");
});

test("rows with no usable id sort oldest and keep their given order", () => {
  const order = QueueOrder.createQueueOrder();
  const out = order.order([
    { id: null, rank: 0 },
    { id: "real", rank: 0 },
    { id: undefined, rank: 0 },
  ], byId);
  assert.deepEqual(rows(out), ["real", null, undefined]);
  assert.equal(order.size(), 1, "an unusable id is not remembered");
});

test("a rank that is not a number sorts last rather than scrambling the list", () => {
  const order = QueueOrder.createQueueOrder();
  const out = order.order([
    { id: "junk", rank: NaN },
    { id: "active", rank: 0 },
    { id: "failed", rank: 3 },
  ], byId);
  assert.deepEqual(rows(out), ["active", "failed", "junk"]);
});

test("a throwing idOf or rankOf cannot break the render", () => {
  const order = QueueOrder.createQueueOrder();
  const out = order.order([{ id: "a", rank: 0 }, { id: "b", rank: 0 }], {
    idOf(entry) { if (entry.id === "a") throw new Error("hostile"); return entry.id; },
    rankOf(entry) { if (entry.id === "b") throw new Error("hostile"); return entry.rank; },
  });
  assert.equal(out.length, 2);
});

test("a non-array list yields an empty list rather than a throw", () => {
  const order = QueueOrder.createQueueOrder();
  assert.deepEqual(order.order(null, byId), []);
  assert.deepEqual(order.order(undefined, byId), []);
  assert.deepEqual(order.order({ length: 2 }, byId), []);
});

test("two orderers keep separate sequences", () => {
  const a = QueueOrder.createQueueOrder();
  const b = QueueOrder.createQueueOrder();
  a.order([{ id: "x", rank: 0 }], byId);
  a.order([{ id: "x", rank: 0 }, { id: "y", rank: 0 }], byId);
  assert.deepEqual(rows(a.order([{ id: "x", rank: 0 }, { id: "y", rank: 0 }], byId)), ["y", "x"]);
  assert.deepEqual(rows(b.order([{ id: "y", rank: 0 }, { id: "x", rank: 0 }], byId)), ["x", "y"]);
});
