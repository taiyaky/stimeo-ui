/**
 * Guarded `localStorage` access shared by the preference-persisting controllers
 * (sidebar, theme).
 *
 * `window.localStorage` can throw on access or read/write — storage disabled by
 * browser policy, sandboxed frames, private modes, or quota exhaustion. These
 * helpers centralize the try/catch so callers treat persistence as best-effort:
 * a failed read behaves like an unset key and a failed write is dropped,
 * leaving the in-DOM state as this session's source of truth.
 *
 * @remarks
 * Only the guarded access lives here — interpreting the stored string
 * (validation, defaults, key derivation) stays in each controller. The
 * `stimeo--persist` controller keeps its own storage layer on purpose: storage
 * *is* its domain (engine selection, per-field bookkeeping, TTL semantics).
 */

/**
 * Reads `key` from `localStorage`.
 *
 * @param key - The storage key to read.
 * @returns The stored string, or `null` when the key is unset or storage is
 * unavailable (the read threw).
 */
export function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes `value` under `key` in `localStorage`, ignoring failures (private
 * mode / quota / storage disabled) — persistence is best-effort by contract.
 *
 * @param key - The storage key to write.
 * @param value - The string to store.
 */
export function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort: the in-DOM state still applies for this session.
  }
}
