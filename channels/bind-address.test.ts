// Tests for the webhook bind-address policy. Run with: npm test
//
// A public bind puts the webhook secret and alert payloads back on the wire in cleartext.
// The live VM's .env still says 0.0.0.0, and an empty value binds every interface, so
// both must stop the channel from starting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { requireLoopbackHost } from "./bind-address.js";

const NAME = "SIGNOZ_WEBHOOK_HOST";

test("an unset host defaults to loopback", () => {
  assert.equal(requireLoopbackHost({}, NAME), "127.0.0.1");
});

test("loopback addresses are accepted", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", " 127.0.0.1 "]) {
    assert.equal(requireLoopbackHost({ [NAME]: host }, NAME), host.trim());
  }
});

test("a wildcard or public address refuses to start", () => {
  for (const host of ["0.0.0.0", "::", "163.172.138.203", "sre-agent.internal.alien.club"]) {
    assert.throws(() => requireLoopbackHost({ [NAME]: host }, NAME), /is not a loopback address/, host);
  }
});

test("an empty host refuses to start instead of binding every interface", () => {
  assert.throws(() => requireLoopbackHost({ [NAME]: "" }, NAME), /is not a loopback address/);
  assert.throws(() => requireLoopbackHost({ [NAME]: "  " }, NAME), /is not a loopback address/);
});
