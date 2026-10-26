// Shared-secret authentication for the inbound webhook channels (SigNoz, Trivy).
//
// Both channels listen on a port reachable from outside the VM, and whatever they accept
// is pushed straight into the agent's session and, from there, into its incident log.
// An unauthenticated request is therefore a way to make the agent act on a forged alert,
// so a missing secret is a startup error, never a warning.
//
// The comparison runs in constant time over fixed-length digests: comparing the raw
// strings with `===` returns as soon as a byte differs, which leaks how much of a guess
// was right, and `timingSafeEqual` alone throws on inputs of different length.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Read a webhook secret from the environment, refusing to run without one.
 * @param env The process environment.
 * @param name The variable holding the shared secret.
 * @returns The configured secret.
 * @throws Error when the variable is unset or blank.
 */
export function requireWebhookToken(env: NodeJS.ProcessEnv, name: string): string {
  const token = env[name]?.trim();
  if (!token) {
    throw new Error(`${name} is not set; refusing to accept unauthenticated webhooks`);
  }
  return token;
}

/**
 * Extract the presented secret from a request.
 *
 * Accepted forms, matching what the senders can be configured to send: `Bearer <token>`,
 * `Basic <base64(user:token)>` (SigNoz's webhook channel only offers basic auth, so the
 * secret travels as the password), or an `X-Webhook-Token` header.
 * @param headers The request headers.
 * @returns The presented secret, or `undefined` when the request carries none.
 */
export function extractPresentedToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization ?? "";

  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  if (authorization.startsWith("Basic ")) {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString();
    const separator = decoded.indexOf(":");
    return separator === -1 ? decoded : decoded.slice(separator + 1);
  }

  const header = headers["x-webhook-token"];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Compare a presented secret against the expected one in constant time.
 * @param presented The secret the request carried, if any.
 * @param expected The configured secret.
 * @returns True only when both are present and equal.
 */
export function isAuthorized(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
