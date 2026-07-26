import { afterEach, describe, expect, it } from "vitest";
import { readLocalStorage, writeLocalStorage } from "../../src/utils/safe_storage";

/**
 * Unit tests for the guarded `localStorage` helpers {@link readLocalStorage} /
 * {@link writeLocalStorage}: reads fall back to `null` and writes are dropped
 * when storage throws (storage disabled / private mode / quota).
 *
 * happy-dom ships a working `localStorage`, but its `Storage` instance is a
 * Proxy whose `defineProperty` trap makes `vi.spyOn(localStorage, …)`
 * unrestorable (the spy lingers as an own property). The failure paths instead
 * swap the `window.localStorage` property itself for a throwing stub — the
 * same shape as a browser with storage blocked — and restore the original
 * descriptor afterwards.
 */

/** Restores `window.localStorage` after a blocked-storage test (null = nothing to restore). */
let restoreStorage: (() => void) | null = null;

/** Replaces `window.localStorage` with a stub whose reads/writes throw. */
const installBlockedStorage = (): void => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const blocked = {
    getItem(): string | null {
      throw new Error("storage blocked");
    },
    setItem(): void {
      throw new Error("storage blocked");
    },
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: blocked as unknown as Storage,
  });
  restoreStorage = () => {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    else Reflect.deleteProperty(window, "localStorage");
  };
};

afterEach(() => {
  restoreStorage?.();
  restoreStorage = null;
  window.localStorage.clear();
});

describe("readLocalStorage", () => {
  it("returns the stored string", () => {
    window.localStorage.setItem("stimeo-test", "value");
    expect(readLocalStorage("stimeo-test")).toBe("value");
  });

  it("returns null for an unset key", () => {
    expect(readLocalStorage("stimeo-missing")).toBeNull();
  });

  it("returns null when the read throws (storage blocked)", () => {
    window.localStorage.setItem("stimeo-test", "value");
    installBlockedStorage();
    expect(readLocalStorage("stimeo-test")).toBeNull();
  });
});

describe("writeLocalStorage", () => {
  it("stores the value", () => {
    writeLocalStorage("stimeo-test", "value");
    expect(window.localStorage.getItem("stimeo-test")).toBe("value");
  });

  it("swallows a throwing write (quota / private mode) without persisting", () => {
    installBlockedStorage();
    expect(() => writeLocalStorage("stimeo-test", "value")).not.toThrow();
    restoreStorage?.();
    restoreStorage = null;
    expect(window.localStorage.getItem("stimeo-test")).toBeNull();
  });
});
