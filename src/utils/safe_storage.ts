/** A successful guarded storage operation. */
export interface StorageSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

/** A guarded storage operation rejected by the browser. */
export interface StorageFailure {
  readonly ok: false;
  readonly error: unknown;
}

/** Result of accessing browser storage without allowing an exception to escape. */
export type StorageResult<T> = StorageSuccess<T> | StorageFailure;

/**
 * Guarded `localStorage` access shared by controllers that persist client state.
 *
 * `window.localStorage` can throw while resolving the storage object or while
 * reading, writing, or removing a key. The result keeps an unavailable store
 * distinct from an available store whose key is unset, so callers can expose an
 * accurate success or failure state without duplicating exception guards.
 */

/**
 * Reads `key` from `localStorage`.
 *
 * @param key - The storage key to read.
 * @returns A successful result containing the stored string or `null`, or a
 * failure result when storage is unavailable.
 */
export function readLocalStorage(key: string): StorageResult<string | null> {
  try {
    return { ok: true, value: window.localStorage.getItem(key) };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

/**
 * Writes `value` under `key` in `localStorage`.
 *
 * @param key - The storage key to write.
 * @param value - The string to store.
 * @returns Success only after `setItem` completes; otherwise the browser error.
 */
export function writeLocalStorage(key: string, value: string): StorageResult<void> {
  try {
    window.localStorage.setItem(key, value);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

/**
 * Removes `key` from `localStorage`.
 *
 * @param key - The storage key to remove.
 * @returns Success only after `removeItem` completes; otherwise the browser error.
 */
export function removeLocalStorage(key: string): StorageResult<void> {
  try {
    window.localStorage.removeItem(key);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}
