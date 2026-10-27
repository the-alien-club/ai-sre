// Bounded awaits. Every call that waits on something outside this process (Slack, Jira, the
// Claude session over stdio) goes through this, so a hung peer fails one operation with a
// named error instead of wedging a channel forever (CLAUDE_ERROR_PATTERNS.md §14).

export class OperationTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number
  ) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = "OperationTimeoutError";
  }
}

/**
 * Settles with `work`, or rejects with OperationTimeoutError once `timeoutMs` has passed.
 * The timer never keeps the process alive, and is cleared as soon as `work` settles.
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`${operation}: timeout must be a positive number of ms, got ${timeoutMs}`);
  }

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(operation, timeoutMs)), timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
