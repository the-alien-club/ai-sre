// Tests for bounded awaits. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationTimeoutError, withTimeout } from "./with-timeout.js";

test("withTimeout passes a prompt result and error through", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, "fast"), 42);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000, "failing"), /boom/);
});

test("withTimeout rejects a hung operation with a named error", async () => {
  const hung = new Promise<never>(() => {});
  await assert.rejects(withTimeout(hung, 20, "slack chat.postMessage"), (err: unknown) => {
    assert.ok(err instanceof OperationTimeoutError);
    assert.equal(err.message, "slack chat.postMessage timed out after 20 ms");
    return true;
  });
});

test("withTimeout refuses a meaningless timeout", async () => {
  await assert.rejects(withTimeout(Promise.resolve(1), 0, "x"), RangeError);
  await assert.rejects(withTimeout(Promise.resolve(1), Number.NaN, "x"), RangeError);
});
