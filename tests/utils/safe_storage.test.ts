import { afterEach, describe, expect, it } from "vitest";
import {
  readLocalStorage,
  removeLocalStorage,
  writeLocalStorage,
} from "../../src/utils/safe_storage";

/**
 * Unit tests for guarded localStorage reads, writes, and removals. An unavailable
 * store is distinguishable from an unset key, and no browser exception escapes.
 */

/** Restores `window.localStorage` after a blocked-storage test. */
let restoreStorage: (() => void) | null = null;

/** Replaces `window.localStorage` with a stub whose operations throw. */
const installBlockedStorage = (): void => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const blocked = {
    getItem(): string | null {
      throw new Error("storage blocked");
    },
    setItem(): void {
      throw new Error("storage blocked");
    },
    removeItem(): void {
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
    expect(readLocalStorage("stimeo-test")).toEqual({ ok: true, value: "value" });
  });

  it("distinguishes an unset key from unavailable storage", () => {
    expect(readLocalStorage("stimeo-missing")).toEqual({ ok: true, value: null });
  });

  it("returns a failure when the read throws", () => {
    installBlockedStorage();
    const result = readLocalStorage("stimeo-test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});

describe("writeLocalStorage", () => {
  it("stores the value and reports success", () => {
    expect(writeLocalStorage("stimeo-test", "value")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(window.localStorage.getItem("stimeo-test")).toBe("value");
  });

  it("returns a failure when the write throws", () => {
    installBlockedStorage();
    const result = writeLocalStorage("stimeo-test", "value");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});

describe("removeLocalStorage", () => {
  it("removes the key and reports success", () => {
    window.localStorage.setItem("stimeo-test", "value");
    expect(removeLocalStorage("stimeo-test")).toEqual({ ok: true, value: undefined });
    expect(window.localStorage.getItem("stimeo-test")).toBeNull();
  });

  it("returns a failure when the removal throws", () => {
    installBlockedStorage();
    const result = removeLocalStorage("stimeo-test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(Error);
  });
});
