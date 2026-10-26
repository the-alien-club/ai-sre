// Bounded request-body reading for the webhook channels.
//
// The channels buffered the whole body before parsing it, with no limit, so one oversized
// POST could exhaust the agent VM's 2 GB of memory and take the agent down with it. Caddy
// caps bodies at the edge as well; this is the same limit enforced where the bytes land,
// so the channels stay safe even when reached without the proxy.

import type { IncomingMessage } from "node:http";

/** Thrown when a request body exceeds its limit; the caller answers 413. */
export class RequestBodyTooLarge extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body exceeds ${limitBytes} bytes`);
    this.name = "RequestBodyTooLarge";
  }
}

/**
 * Read a request body as UTF-8, failing fast once it passes `limitBytes`.
 * @param req The incoming request.
 * @param limitBytes The largest body accepted.
 * @returns The body text.
 * @throws RequestBodyTooLarge when the declared or received size exceeds the limit.
 */
export function readBodyWithLimit(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new RequestBodyTooLarge(limitBytes));
      req.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limitBytes) {
        reject(new RequestBodyTooLarge(limitBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
