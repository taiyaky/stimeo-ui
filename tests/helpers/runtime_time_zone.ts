import process from "node:process";

/**
 * Runs a body in a different runtime zone, then restores the TZ value it found, or the
 * resolved runtime zone when none was set.
 */
export async function withRuntimeTimeZone(
  timeZone: string,
  body: () => Promise<void>,
): Promise<void> {
  const previous = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = timeZone;
  try {
    await body();
  } finally {
    process.env.TZ = previous;
  }
}
