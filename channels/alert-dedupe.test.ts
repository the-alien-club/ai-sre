// Tests for the alert dedupe store. Run with: npm test
//
// The delivery path is tested in alert-delivery.test.ts; this covers the store's own bounds:
// the key, the window, and the cap that keeps a flood from growing it without limit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlertDedupe, dedupeKey, DEDUPE_WINDOW_MS } from "./alert-dedupe.js";

const STARTS_AT = "2026-10-28T08:40:00Z";

function identity(fingerprint: string, status = "firing") {
  return { fingerprint, status, startsAt: STARTS_AT };
}

test("the key is fingerprint, status and startsAt, and nothing else", () => {
  assert.deepEqual(dedupeKey(identity("a1b2")), { key: `a1b2|firing|${STARTS_AT}` });
  assert.deepEqual(dedupeKey({ fingerprint: "", status: "firing", startsAt: STARTS_AT }), { reason: "the alert has no fingerprint" });
  assert.deepEqual(dedupeKey({ fingerprint: "a1b2", status: "firing", startsAt: undefined }), { reason: "the alert has no startsAt" });
  assert.deepEqual(dedupeKey({ fingerprint: 42, status: "firing", startsAt: STARTS_AT }), { reason: "the alert has no fingerprint" });
});

test("a duplicate reports how long ago the first copy was accepted", () => {
  let clock = 1_000_000;
  const dedupe = createAlertDedupe({ now: () => clock });

  assert.equal(dedupe.claim(identity("a")).kind, "first");
  clock += 42_000;
  assert.deepEqual(dedupe.claim(identity("a")), { kind: "duplicate", key: `a|firing|${STARTS_AT}`, ageMs: 42_000 });
});

test("entries past the window are pruned, and the store never holds more than its cap", () => {
  let clock = 0;
  const dedupe = createAlertDedupe({ now: () => clock, maxEntries: 3 });

  for (const fingerprint of ["a", "b", "c", "d"]) {
    assert.equal(dedupe.claim(identity(fingerprint)).kind, "first");
    clock += 1000;
  }
  assert.equal(dedupe.size(), 3);
  // "a" was the oldest and was dropped to make room, so it is accepted again
  assert.equal(dedupe.claim(identity("a")).kind, "first");
  assert.equal(dedupe.claim(identity("d")).kind, "duplicate");

  clock += DEDUPE_WINDOW_MS;
  assert.equal(dedupe.claim(identity("z")).kind, "first");
  assert.equal(dedupe.size(), 1);
});

test("a released key is accepted again", () => {
  const dedupe = createAlertDedupe({ now: () => 0 });
  const first = dedupe.claim(identity("a"));
  assert.equal(first.kind, "first");
  if (first.kind !== "first") return;

  dedupe.release(first.key);
  assert.equal(dedupe.claim(identity("a")).kind, "first");
});

test("a window or cap that bounds nothing is refused", () => {
  assert.throws(() => createAlertDedupe({ windowMs: 0 }), RangeError);
  assert.throws(() => createAlertDedupe({ maxEntries: 0 }), RangeError);
});
