// The once-a-day slot both daily digests (Trivy, unacknowledged escalations) go out in.

/** Whether today's slot at `hourUtc` has come and nothing went out since `lastAt`. */
export function isDailySlotDue(lastAt: number, now: number, hourUtc: number): boolean {
  const day = new Date(now);
  const slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc);
  return now >= slot && lastAt < slot;
}

/** An hour of the day in UTC, from configuration: an integer 0-23, or an error naming `name`. */
export function parseHourUtc(name: string, raw: string): number {
  const hour = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`${name} must be an integer hour from 0 to 23, got "${raw}"`);
  }
  return hour;
}
