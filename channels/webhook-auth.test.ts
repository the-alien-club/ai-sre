// Tests for webhook authentication. Run with: npm test
//
// What matters here is that nothing gets in without the secret: a channel that starts
// without one, or a check that lets an empty or partial token through, turns the public
// webhook port into a way to feed the agent forged alerts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPresentedToken,
  isAuthorized,
  requireWebhookToken,
} from "./webhook-auth.js";

const SECRET = "s3cret-shared-with-signoz";

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

test("a configured secret is returned", () => {
  assert.equal(requireWebhookToken({ SIGNOZ_WEBHOOK_TOKEN: SECRET }, "SIGNOZ_WEBHOOK_TOKEN"), SECRET);
});

test("a missing secret refuses to start", () => {
  assert.throws(() => requireWebhookToken({}, "SIGNOZ_WEBHOOK_TOKEN"), /SIGNOZ_WEBHOOK_TOKEN is not set/);
});

test("a blank secret refuses to start", () => {
  assert.throws(() => requireWebhookToken({ TRIVY_WEBHOOK_TOKEN: "   " }, "TRIVY_WEBHOOK_TOKEN"), /not set/);
});

test("a bearer token is extracted", () => {
  assert.equal(extractPresentedToken({ authorization: `Bearer ${SECRET}` }), SECRET);
});

test("basic auth presents the password as the token", () => {
  assert.equal(extractPresentedToken({ authorization: basic("signoz", SECRET) }), SECRET);
});

test("a password containing colons survives basic auth", () => {
  assert.equal(extractPresentedToken({ authorization: basic("signoz", "a:b:c") }), "a:b:c");
});

test("the X-Webhook-Token header is accepted", () => {
  assert.equal(extractPresentedToken({ "x-webhook-token": SECRET }), SECRET);
});

test("a request without credentials presents nothing", () => {
  assert.equal(extractPresentedToken({}), undefined);
});

test("the right secret is authorized", () => {
  assert.equal(isAuthorized(SECRET, SECRET), true);
});

test("a wrong secret is rejected", () => {
  assert.equal(isAuthorized("guess", SECRET), false);
});

test("a prefix of the secret is rejected", () => {
  assert.equal(isAuthorized(SECRET.slice(0, 10), SECRET), false);
});

test("an absent or empty secret is rejected", () => {
  assert.equal(isAuthorized(undefined, SECRET), false);
  assert.equal(isAuthorized("", SECRET), false);
});
