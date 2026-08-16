import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirtyFormController } from "../src/controllers/dirty_form_controller";
import { PersistController } from "../src/controllers/persist_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral contract for {@link PersistController}: validated versioned drafts,
 * exact success/error events, runtime Value changes, dynamic fields, and complete
 * Turbo teardown.
 */

type PersistValue = string | boolean | string[];

interface StoredPayload {
  readonly version: number;
  readonly fields: Array<{ readonly key: string; readonly value: PersistValue }>;
}

interface ErrorDetail {
  readonly key: string;
  readonly operation: "read" | "write" | "remove";
  readonly reason: "unavailable" | "invalid-payload";
}

const PREFIX = "stimeo--persist:";
const DEBOUNCE = 400;

describe("PersistController", () => {
  let application: Application | null = null;
  let restoreStorage: (() => void) | null = null;
  let listenerAbort: AbortController;

  const stop = (): void => {
    if (application) disconnectAndStopApplication(application);
    application = null;
  };

  const mount = async (attrs: string, inner: string): Promise<void> => {
    stop();
    // Persist accepts any HTMLElement. Using a neutral host keeps happy-dom's
    // form-owner bookkeeping from manufacturing duplicate node wrappers when
    // the controller writes its restored marker.
    document.body.innerHTML = `<div data-controller="stimeo--persist" ${attrs}>${inner}</div>`;
    application = new Application(document.body);
    application.register("stimeo--persist", PersistController);
    await application.start();
    await vi.advanceTimersByTimeAsync(0);
  };

  const root = (): HTMLElement => query<HTMLElement>("[data-controller~='stimeo--persist']");

  const instance = (): PersistController => {
    const controller = application?.getControllerForElementAndIdentifier(root(), "stimeo--persist");
    if (!(controller instanceof PersistController)) throw new Error("expected PersistController");
    return controller;
  };

  const input = (name: string): HTMLInputElement =>
    query<HTMLInputElement>(`input[name='${name}']`);

  const edit = (name: string, value: string): void => {
    const element = input(name);
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const storageKey = (key: string): string => `${PREFIX}${key}`;
  const stored = (key: string): string | null => window.localStorage.getItem(storageKey(key));

  const writeDraft = (key: string, fields: Record<string, PersistValue>): void => {
    window.localStorage.setItem(
      storageKey(key),
      JSON.stringify({
        version: 1,
        fields: Object.entries(fields).map(([fieldKey, value]) => ({ key: fieldKey, value })),
      }),
    );
  };

  const payload = (key: string): StoredPayload => {
    const raw = stored(key);
    if (raw === null) throw new Error(`expected stored payload for ${key}`);
    return JSON.parse(raw) as StoredPayload;
  };

  const values = (key: string): Record<string, PersistValue> =>
    Object.fromEntries(payload(key).fields.map(({ key: fieldKey, value }) => [fieldKey, value]));

  const listen = <T>(name: string, details: T[]): void => {
    document.addEventListener(name, (event) => details.push((event as CustomEvent<T>).detail), {
      signal: listenerAbort.signal,
    });
  };

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

  const restoreAvailableStorage = (): void => {
    restoreStorage?.();
    restoreStorage = null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    listenerAbort = new AbortController();
  });

  afterEach(() => {
    listenerAbort.abort();
    stop();
    restoreAvailableStorage();
    vi.useRealTimers();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  it("saves a versioned payload after the default debounce", async () => {
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    edit("title", "hello");
    vi.advanceTimersByTime(DEBOUNCE - 1);
    expect(stored("draft")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(payload("draft")).toEqual({
      version: 1,
      fields: [{ key: "title", value: "hello" }],
    });
  });

  it("uses a custom debounce and coalesces rapid edits into one save", async () => {
    const saves: Array<{ key: string }> = [];
    listen("stimeo--persist:save", saves);
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-debounce-value="25"',
      '<input name="title">',
    );
    edit("title", "first");
    vi.advanceTimersByTime(20);
    edit("title", "second");
    vi.advanceTimersByTime(24);
    expect(stored("draft")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(values("draft")).toEqual({ title: "second" });
    expect(saves).toEqual([{ key: "draft" }]);
  });

  it("normalizes a negative debounce to the documented default", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-debounce-value="-1"',
      '<input name="title">',
    );
    edit("title", "hello");
    vi.advanceTimersByTime(DEBOUNCE - 1);
    expect(stored("draft")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(values("draft")).toEqual({ title: "hello" });
  });

  it("reschedules a pending save when debounce changes", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-debounce-value="100"',
      '<input name="title">',
    );
    edit("title", "hello");
    vi.advanceTimersByTime(50);
    instance().debounceValue = 10;
    instance().debounceValueChanged();
    vi.advanceTimersByTime(9);
    expect(stored("draft")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(values("draft")).toEqual({ title: "hello" });
  });

  it("restores typed values, marks the host, and emits no native input", async () => {
    writeDraft("draft", { title: "kept", body: "text", agree: true });
    const restores: Array<{ key: string }> = [];
    const nativeEvents: string[] = [];
    listen("stimeo--persist:restore", restores);
    document.addEventListener("input", () => nativeEvents.push("input"), {
      signal: listenerAbort.signal,
    });
    document.addEventListener("change", () => nativeEvents.push("change"), {
      signal: listenerAbort.signal,
    });

    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="missing" value="authored"><input name="title"><textarea name="body"></textarea><input type="checkbox" name="agree">',
    );

    expect(input("missing").value).toBe("authored");
    expect(input("title").value).toBe("kept");
    expect(query<HTMLTextAreaElement>("[name='body']").value).toBe("text");
    expect(input("agree").checked).toBe(true);
    expect(root().getAttribute("data-persist-restored")).toBe("true");
    expect(restores).toEqual([{ key: "draft" }]);
    expect(nativeEvents).toEqual([]);
  });

  it("removes a stale restored marker when no draft exists", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-persist-restored="true"',
      '<input name="title">',
    );
    expect(root().hasAttribute("data-persist-restored")).toBe(false);
  });

  it.each([
    ["null", "null"],
    ["number", "123"],
    ["string", '"text"'],
    ["array", "[]"],
    ["empty object", "{}"],
    ["legacy object", '{"title":"legacy"}'],
    ["wrong version", '{"version":2,"fields":[]}'],
    ["non-record field", '{"version":1,"fields":[null]}'],
    ["duplicate keys", '{"version":1,"fields":[{"key":"x","value":"a"},{"key":"x","value":"b"}]}'],
    ["invalid field value", '{"version":1,"fields":[{"key":"x","value":1}]}'],
    ["malformed JSON", "not json"],
  ])("discards an invalid %s payload and remains operational", async (_label, raw) => {
    const errors: ErrorDetail[] = [];
    listen("stimeo--persist:error", errors);
    window.localStorage.setItem(storageKey("draft"), raw);
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');

    expect(stored("draft")).toBeNull();
    expect(errors).toEqual([{ key: "draft", operation: "read", reason: "invalid-payload" }]);
    edit("title", "alive");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ title: "alive" });
  });

  it("reports cleanup failure after detecting an invalid payload", async () => {
    const errors: ErrorDetail[] = [];
    listen("stimeo--persist:error", errors);
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const invalid = '{"version":2,"fields":[]}';
    const storage = {
      getItem: (): string => invalid,
      setItem: (): void => undefined,
      removeItem: (): never => {
        throw new Error("storage blocked");
      },
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage as unknown as Storage,
    });
    restoreStorage = () => {
      if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
      else Reflect.deleteProperty(window, "localStorage");
    };

    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');

    expect(errors).toEqual([
      { key: "draft", operation: "read", reason: "invalid-payload" },
      { key: "draft", operation: "remove", reason: "unavailable" },
    ]);
  });

  it("lets an invalid-payload consumer replace the discarded value", async () => {
    window.localStorage.setItem(storageKey("draft"), "null");
    document.addEventListener(
      "stimeo--persist:error",
      (event) => {
        const detail = (event as CustomEvent<ErrorDetail>).detail;
        if (detail.reason === "invalid-payload") writeDraft("draft", { title: "repaired" });
      },
      { signal: listenerAbort.signal },
    );

    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');

    expect(values("draft")).toEqual({ title: "repaired" });
  });

  it("reports an unavailable read and can save after storage recovers", async () => {
    const errors: ErrorDetail[] = [];
    listen("stimeo--persist:error", errors);
    installBlockedStorage();
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    expect(errors).toEqual([{ key: "draft", operation: "read", reason: "unavailable" }]);

    restoreAvailableStorage();
    edit("title", "recovered");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ title: "recovered" });
  });

  it("emits error instead of save when a write fails", async () => {
    const saves: Array<{ key: string }> = [];
    const errors: ErrorDetail[] = [];
    listen("stimeo--persist:save", saves);
    listen("stimeo--persist:error", errors);
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    installBlockedStorage();
    edit("title", "not stored");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(saves).toEqual([]);
    expect(errors).toEqual([{ key: "draft", operation: "write", reason: "unavailable" }]);
  });

  it("preserves the draft and marker when removal fails", async () => {
    writeDraft("draft", { title: "kept" });
    const clears: Array<{ key: string }> = [];
    const errors: ErrorDetail[] = [];
    listen("stimeo--persist:clear", clears);
    listen("stimeo--persist:error", errors);
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    installBlockedStorage();
    instance().clear();
    expect(root().getAttribute("data-persist-restored")).toBe("true");
    expect(clears).toEqual([]);
    expect(errors).toEqual([{ key: "draft", operation: "remove", reason: "unavailable" }]);
    restoreAvailableStorage();
    expect(stored("draft")).not.toBeNull();
  });

  it("reaches clear through the declared action and emits exact detail", async () => {
    writeDraft("draft", { title: "kept" });
    const clears: Array<{ key: string }> = [];
    listen("stimeo--persist:clear", clears);
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="title"><button type="button" data-action="stimeo--persist#clear">Clear</button>',
    );
    query<HTMLButtonElement>("button").click();
    expect(stored("draft")).toBeNull();
    expect(root().hasAttribute("data-persist-restored")).toBe(false);
    expect(clears).toEqual([{ key: "draft" }]);
  });

  it("keeps connect idempotent when a host invokes it twice", async () => {
    writeDraft("draft", { title: "restored" });
    const restores: Array<{ key: string }> = [];
    listen("stimeo--persist:restore", restores);
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    instance().connect();
    expect(restores).toEqual([{ key: "draft" }]);
  });

  it("flushes a pending save through the normal save event on disconnect", async () => {
    const saves: Array<{ key: string }> = [];
    listen("stimeo--persist:save", saves);
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    edit("title", "flushed");
    instance().disconnect();
    expect(values("draft")).toEqual({ title: "flushed" });
    expect(saves).toEqual([{ key: "draft" }]);
  });

  it("leaves input, clearOn, timers, and observers inert after disconnect", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-clear-on-value="submit"',
      '<input name="title">',
    );
    instance().disconnect();
    edit("title", "ignored");
    root().dispatchEvent(new Event("submit", { bubbles: true }));
    root().insertAdjacentHTML("beforeend", '<input name="late" value="ignored">');
    vi.advanceTimersByTime(DEBOUNCE * 2);
    expect(stored("draft")).toBeNull();
  });

  it("rebinds clearOn and removes the exact registered listener", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-clear-on-value="submit"',
      '<input name="title">',
    );
    edit("title", "kept");
    vi.advanceTimersByTime(DEBOUNCE);
    instance().clearOnValue = "reset";
    instance().clearOnValueChanged();
    root().dispatchEvent(new Event("submit", { bubbles: true }));
    expect(stored("draft")).not.toBeNull();
    root().dispatchEvent(new Event("reset", { bubbles: true }));
    expect(stored("draft")).toBeNull();
  });

  it("leaves listener order unchanged when clearOn has not changed", async () => {
    writeDraft("draft", { title: "kept" });
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-clear-on-value="submit"',
      '<input name="title">',
    );
    const clearedBeforeConsumer: boolean[] = [];
    root().addEventListener("submit", () => clearedBeforeConsumer.push(stored("draft") === null));
    instance().clearOnValueChanged();
    root().dispatchEvent(new Event("submit"));
    expect(clearedBeforeConsumer).toEqual([true]);
  });

  it("ignores a clearOn Value that is not one event type", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-clear-on-value="bad event"',
      '<input name="title">',
    );
    edit("title", "kept");
    vi.advanceTimersByTime(DEBOUNCE);
    root().dispatchEvent(new Event("bad event", { bubbles: true }));
    const addEventListener = vi.spyOn(root(), "addEventListener");
    instance().clearOnValue = "submit";
    instance().clearOnValueChanged();
    instance().clearOnValue = "bad event";
    instance().clearOnValueChanged();
    expect(addEventListener.mock.calls.map(([type]) => type)).toEqual(["submit"]);
    addEventListener.mockRestore();
    root().dispatchEvent(new Event("null", { bubbles: true }));
    expect(stored("draft")).not.toBeNull();
  });

  it("flushes the old key before restoring a runtime replacement key", async () => {
    writeDraft("second", { title: "second value" });
    const saves: Array<{ key: string }> = [];
    const restores: Array<{ key: string }> = [];
    listen("stimeo--persist:save", saves);
    listen("stimeo--persist:restore", restores);
    await mount('data-stimeo--persist-key-value="first"', '<input name="title">');
    edit("title", "first value");
    instance().keyValue = "second";
    instance().keyValueChanged();
    expect(values("first")).toEqual({ title: "first value" });
    expect(input("title").value).toBe("second value");
    expect(saves).toEqual([{ key: "first" }]);
    expect(restores).toEqual([{ key: "second" }]);
  });

  it("does not flush or reload when the logical key has not changed", async () => {
    const saves: Array<{ key: string }> = [];
    listen("stimeo--persist:save", saves);
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    edit("title", "pending");
    instance().keyValueChanged();
    expect(saves).toEqual([]);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(saves).toEqual([{ key: "draft" }]);
  });

  it("falls back to the host id and follows an id replacement", async () => {
    writeDraft("second", { title: "restored" });
    await mount('id="first"', '<input name="title">');
    edit("title", "saved first");
    root().id = "second";
    await vi.advanceTimersByTimeAsync(0);
    expect(values("first")).toEqual({ title: "saved first" });
    expect(input("title").value).toBe("restored");
  });

  it("is disabled without a key or id but can be enabled at runtime", async () => {
    const clears: Array<{ key: string }> = [];
    listen("stimeo--persist:clear", clears);
    await mount("", '<input name="title">');
    instance().clear();
    expect(clears).toEqual([]);
    edit("title", "ignored");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(window.localStorage.length).toBe(0);
    instance().keyValue = "draft";
    instance().keyValueChanged();
    edit("title", "saved");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ title: "saved" });
  });

  it("limits persistence to explicit field targets", async () => {
    const saves: Array<{ key: string }> = [];
    listen("stimeo--persist:save", saves);
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="kept" data-stimeo--persist-target="field"><input name="ignored">',
    );
    edit("ignored", "no");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(stored("draft")).toBeNull();
    expect(saves).toEqual([]);

    edit("kept", "yes");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ kept: "yes" });
    expect(saves).toEqual([{ key: "draft" }]);
  });

  it("restores the untargeted controls that removing the last field target admits", async () => {
    writeDraft("draft", { kept: "restored kept", admitted: "restored admitted" });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="kept" data-stimeo--persist-target="field"><input name="admitted" value="server">',
    );
    expect(input("kept").value).toBe("restored kept");
    // Outside the target set at connect, so it is neither restored nor known yet.
    expect(input("admitted").value).toBe("server");

    // Dropping the last target widens the scope to every owned control. The newly
    // admitted one carries no mutation record of its own, so only the unknown-field
    // sweep can reach it.
    input("kept").removeAttribute("data-stimeo--persist-target");
    await vi.advanceTimersByTimeAsync(0);

    expect(input("admitted").value).toBe("restored admitted");
  });

  it("ignores a field target placed on an unsupported element without disconnecting", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<div data-stimeo--persist-target="field"><input name="nested"></div>',
    );
    edit("nested", "ignored");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(stored("draft")).toBeNull();
  });

  it("uses a field id fallback and ignores unnamed controls and non-value inputs", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input id="fallback"><input value="unnamed"><input type="file" name="upload"><button name="button" value="x">X</button>',
    );
    query<HTMLInputElement>("#fallback").value = "kept";
    query<HTMLInputElement>("#fallback").dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ fallback: "kept" });
  });

  it("does not write for input events from unnamed or excluded controls", async () => {
    const saves: Array<{ key: string }> = [];
    listen("stimeo--persist:save", saves);
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-exclude-value=\'["ignored"]\'',
      '<input value="unnamed"><input name="ignored">',
    );
    const controls = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    for (const control of controls) control.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(stored("draft")).toBeNull();
    expect(saves).toEqual([]);
  });

  it("never persists passwords and excludes Rails request metadata by default", async () => {
    await mount(
      `data-stimeo--persist-key-value="draft" data-stimeo--persist-exclude-value='[]'`,
      '<input type="password" name="secret" value="hidden"><input type="hidden" name="authenticity_token" value="token"><input type="hidden" name="_method" value="patch"><input type="hidden" name="rating" value="5"><input name="title">',
    );
    edit("title", "hello");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({
      authenticity_token: "token",
      _method: "patch",
      rating: "5",
      title: "hello",
    });
    expect(values("draft")).not.toHaveProperty("secret");

    stop();
    window.localStorage.clear();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input type="hidden" name="authenticity_token" value="token"><input type="hidden" name="_method" value="patch"><input type="hidden" name="rating" value="5"><input name="title">',
    );
    edit("title", "hello");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ rating: "5", title: "hello" });
  });

  it("excludes controls by name and every control's semantic type", async () => {
    await mount(
      `data-stimeo--persist-key-value="draft" data-stimeo--persist-exclude-value='["nickname","textarea","select-one"]'`,
      '<input name="title"><input name="nickname"><textarea name="body"></textarea><select name="plan"><option value="a">A</option></select>',
    );
    edit("title", "kept");
    edit("nickname", "ignored");
    query<HTMLTextAreaElement>("textarea").value = "ignored";
    query<HTMLTextAreaElement>("textarea").dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLSelectElement>("select").dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ title: "kept" });
  });

  it("falls back to the default exclusions when exclude JSON is malformed", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-exclude-value="[not json"',
      '<input type="hidden" name="authenticity_token" value="token"><input name="title">',
    );
    edit("title", "kept");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ title: "kept" });
  });

  it("restores a field when an exclude change makes it eligible", async () => {
    writeDraft("draft", { title: "restored", note: "saved note" });
    await mount(
      `data-stimeo--persist-key-value="draft" data-stimeo--persist-exclude-value='["title"]'`,
      '<input name="title" value="server"><input name="note">',
    );
    expect(input("title").value).toBe("server");
    input("note").value = "current note";
    instance().excludeValue = "";
    instance().excludeValueChanged();
    await Promise.resolve();
    expect(input("title").value).toBe("restored");
    expect(input("note").value).toBe("current note");
  });

  it("restores a released field that had already been restored once", async () => {
    writeDraft("draft", { title: "restored", note: "saved note" });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="title" value="server"><input name="note">',
    );
    // Eligible at connect, so the next batch alone would treat it as already handled.
    expect(input("title").value).toBe("restored");
    input("note").value = "current note";

    instance().excludeValue = '["title"]';
    instance().excludeValueChanged();
    await Promise.resolve();
    input("title").value = "changed while excluded";

    instance().excludeValue = "";
    instance().excludeValueChanged();
    await Promise.resolve();

    expect(input("title").value).toBe("restored");
    expect(input("note").value).toBe("current note");
  });

  it("round-trips checkbox true and false without coercion", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input type="checkbox" name="agree" checked>',
    );
    input("agree").checked = false;
    input("agree").dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ agree: false });
    stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input type="checkbox" name="agree" checked>',
    );
    expect(input("agree").checked).toBe(false);
  });

  it("round-trips one checked radio and preserves authored state for a missing value", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input type="radio" name="plan" value="a"><input type="radio" name="plan" value="b" checked>',
    );
    input("plan").dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ plan: "b" });
    stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input id="a" type="radio" name="plan" value="a" checked><input id="b" type="radio" name="plan" value="b">',
    );
    expect(query<HTMLInputElement>("#b").checked).toBe(true);

    stop();
    writeDraft("draft", { plan: "gone" });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input id="current" type="radio" name="plan" value="current" checked>',
    );
    expect(query<HTMLInputElement>("#current").checked).toBe(true);
  });

  it("keeps radio and non-radio controls with the same name in distinct slots", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input id="choice-a" type="radio" name="choice" value="a" checked><input id="note" name="choice" value="details">',
    );
    query<HTMLInputElement>("#note").dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(payload("draft").fields).toEqual([
      { key: "choice", value: "a" },
      { key: "choice\u00001", value: "details" },
    ]);

    stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input id="choice-a" type="radio" name="choice" value="a"><input id="note" name="choice">',
    );
    expect(query<HTMLInputElement>("#choice-a").checked).toBe(true);
    expect(query<HTMLInputElement>("#note").value).toBe("details");
  });

  it("keeps same-name radio groups with different form owners independent", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<form><input id="first-a" type="radio" name="choice" value="a" checked><input type="radio" name="choice" value="b"></form><form><input type="radio" name="choice" value="a"><input id="second-b" type="radio" name="choice" value="b" checked></form>',
    );
    query<HTMLInputElement>("#second-b").dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(payload("draft").fields).toEqual([
      { key: "choice", value: "a" },
      { key: "choice\u00001", value: "b" },
    ]);

    stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<form><input id="first-a" type="radio" name="choice" value="a"><input type="radio" name="choice" value="b" checked></form><form><input type="radio" name="choice" value="a" checked><input id="second-b" type="radio" name="choice" value="b"></form>',
    );
    expect(query<HTMLInputElement>("#first-a").checked).toBe(true);
    expect(query<HTMLInputElement>("#second-b").checked).toBe(true);
  });

  it("keeps an authored single-select value when the saved option is absent", async () => {
    writeDraft("draft", { plan: "gone" });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<select name="plan"><option value="current" selected>Current</option></select>',
    );
    expect(query<HTMLSelectElement>("select").value).toBe("current");
    expect(root().hasAttribute("data-persist-restored")).toBe(false);
  });

  it("round-trips multiple selections and supports an intentional empty selection", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<select name="tags" multiple><option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option></select>',
    );
    query<HTMLSelectElement>("select").dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ tags: ["a", "c"] });
    stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<select name="tags" multiple><option value="a">A</option><option value="b" selected>B</option><option value="c">C</option></select>',
    );
    expect(
      Array.from(query<HTMLSelectElement>("select").options)
        .filter((option) => option.selected)
        .map((option) => option.value),
    ).toEqual(["a", "c"]);

    stop();
    writeDraft("draft", { tags: [] });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<select name="tags" multiple><option value="a" selected>A</option></select>',
    );
    expect(query<HTMLOptionElement>("option").selected).toBe(false);
  });

  it("leaves a multiple select untouched when none of the saved options remain", async () => {
    writeDraft("draft", { tags: ["gone"] });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<select name="tags" multiple><option value="current" selected>Current</option></select>',
    );
    expect(query<HTMLOptionElement>("option").selected).toBe(true);
  });

  it("restores valid fields while ignoring type-incompatible entries", async () => {
    writeDraft("draft", {
      agree: "not boolean",
      tags: "not an array",
      title: true,
      body: "restored",
    });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input type="checkbox" name="agree" checked><select name="tags" multiple><option value="current" selected>Current</option></select><input name="title" value="authored"><textarea name="body"></textarea>',
    );
    expect(input("agree").checked).toBe(true);
    expect(query<HTMLOptionElement>("option").selected).toBe(true);
    expect(input("title").value).toBe("authored");
    expect(query<HTMLTextAreaElement>("textarea").value).toBe("restored");
    expect(root().getAttribute("data-persist-restored")).toBe("true");
  });

  it("round-trips repeated same-name fields by occurrence", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="tags[]"><input name="tags[]">',
    );
    const fields = Array.from(document.querySelectorAll<HTMLInputElement>("[name='tags[]']"));
    const first = fields[0];
    const second = fields[1];
    if (!first || !second) throw new Error("expected repeated fields");
    first.value = "ruby";
    second.value = "rails";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(payload("draft").fields.map(({ value }) => value)).toEqual(["ruby", "rails"]);
    stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="tags[]"><input name="tags[]">',
    );
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>("[name='tags[]']")).map(
        (element) => element.value,
      ),
    ).toEqual(["ruby", "rails"]);
  });

  it("restores a field inserted after connect", async () => {
    writeDraft("draft", { late: "restored" });
    await mount('data-stimeo--persist-key-value="draft"', "");
    root().insertAdjacentHTML("beforeend", '<input name="late" value="server">');
    await vi.advanceTimersByTimeAsync(0);
    expect(input("late").value).toBe("restored");
  });

  it("restores a known field after its name starts matching a saved entry", async () => {
    writeDraft("draft", { current: "restored" });
    await mount('data-stimeo--persist-key-value="draft"', '<input name="previous" value="server">');
    input("previous").name = "current";
    await vi.advanceTimersByTimeAsync(0);
    expect(input("current").value).toBe("restored");
  });

  it("keeps a debounced edit when a host attribute unrelated to ownership changes", async () => {
    writeDraft("draft", { title: "saved draft" });
    await mount('id="editor" data-stimeo--persist-key-value="draft"', '<input name="title">');
    expect(input("title").value).toBe("saved draft");
    edit("title", "what the user just typed");

    // The logical key is pinned by the Value, so this id change is not a namespace
    // switch and must not re-apply the stored draft over the pending edit.
    root().setAttribute("id", "editor-2");
    await vi.advanceTimersByTimeAsync(0);

    expect(input("title").value).toBe("what the user just typed");
  });

  it("keeps a debounced edit when a wrapper inside the host changes an attribute", async () => {
    writeDraft("draft", { title: "saved draft" });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<div id="wrapper"><input name="title"></div>',
    );
    expect(input("title").value).toBe("saved draft");
    edit("title", "what the user just typed");

    query<HTMLElement>("#wrapper").setAttribute("name", "renamed");
    await vi.advanceTimersByTimeAsync(0);

    expect(input("title").value).toBe("what the user just typed");
  });

  it("ignores inserted text while restoring a field from the same mutation batch", async () => {
    writeDraft("draft", { late: "restored" });
    await mount('data-stimeo--persist-key-value="draft"', "");
    root().append(document.createTextNode("separator"));
    root().insertAdjacentHTML("beforeend", '<input name="late" value="server">');
    await vi.advanceTimersByTimeAsync(0);
    expect(input("late").value).toBe("restored");
  });

  it("restores a select when its saved option appears later", async () => {
    writeDraft("draft", { plan: "later" });
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<select name="plan"><option value="current">Current</option></select>',
    );
    const select = query<HTMLSelectElement>("select");
    expect(select.value).toBe("current");
    select.insertAdjacentHTML("beforeend", '<option value="later">Later</option>');
    await vi.advanceTimersByTimeAsync(0);
    expect(select.value).toBe("later");
  });

  it("saves delegated input from a field inserted after connect", async () => {
    await mount('data-stimeo--persist-key-value="draft"', "");
    root().insertAdjacentHTML("beforeend", '<input name="late">');
    await vi.advanceTimersByTimeAsync(0);
    edit("late", "saved");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("draft")).toEqual({ late: "saved" });
  });

  it("keeps nested Persist instances inside their own field scope", async () => {
    writeDraft("outer", { outer: "restored outer" });
    writeDraft("inner", { inner: "restored inner" });
    document.body.innerHTML = `
      <div id="outer" data-controller="stimeo--persist" data-stimeo--persist-key-value="outer">
        <input id="outer-field" name="outer">
        <div id="inner" data-controller="stimeo--persist" data-stimeo--persist-key-value="inner">
          <input id="inner-field" name="inner">
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--persist", PersistController);
    await vi.advanceTimersByTimeAsync(0);

    const outerField = query<HTMLInputElement>("#outer-field");
    const innerField = query<HTMLInputElement>("#inner-field");
    expect(outerField.value).toBe("restored outer");
    expect(innerField.value).toBe("restored inner");
    window.localStorage.removeItem(storageKey("outer"));
    innerField.value = "saved inner";
    innerField.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(stored("outer")).toBeNull();
    expect(values("inner")).toEqual({ inner: "saved inner" });

    outerField.value = "saved outer";
    outerField.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("outer")).toEqual({ outer: "saved outer" });
  });

  it("restores a target when it moves out of a nested Persist scope", async () => {
    writeDraft("outer", { late: "restored" });
    document.body.innerHTML = `
      <div id="outer" data-controller="stimeo--persist" data-stimeo--persist-key-value="outer">
        <div id="nested" data-controller="stimeo--persist">
          <input name="late" value="server" data-stimeo--persist-target="field">
        </div>
      </div>`;
    application = Application.start();
    application.register("stimeo--persist", PersistController);
    await vi.advanceTimersByTimeAsync(0);
    expect(input("late").value).toBe("server");

    query<HTMLElement>("#nested").removeAttribute("data-controller");
    await vi.advanceTimersByTimeAsync(0);
    expect(input("late").value).toBe("restored");
  });

  it("isolates distinct instance keys and documents last-writer-wins for a shared key", async () => {
    document.body.innerHTML = `
      <form id="first" data-controller="stimeo--persist" data-stimeo--persist-key-value="one">
        <input name="title">
      </form>
      <form id="second" data-controller="stimeo--persist" data-stimeo--persist-key-value="two">
        <input name="title">
      </form>`;
    application = Application.start();
    application.register("stimeo--persist", PersistController);
    await vi.advanceTimersByTimeAsync(0);
    const first = query<HTMLInputElement>("#first input");
    const second = query<HTMLInputElement>("#second input");
    first.value = "one";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    second.value = "two";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("one")).toEqual({ title: "one" });
    expect(values("two")).toEqual({ title: "two" });

    stop();
    document.body.innerHTML = `
      <form id="first" data-controller="stimeo--persist" data-stimeo--persist-key-value="shared"><input name="title"></form>
      <form id="second" data-controller="stimeo--persist" data-stimeo--persist-key-value="shared"><input name="title"></form>`;
    application = Application.start();
    application.register("stimeo--persist", PersistController);
    await vi.advanceTimersByTimeAsync(0);
    const shared = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    const left = shared[0];
    const right = shared[1];
    if (!left || !right) throw new Error("expected shared-key fields");
    left.value = "first write";
    left.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    right.value = "last write";
    right.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(values("shared")).toEqual({ title: "last write" });
  });

  it.each([
    ["Dirty Form is registered first", true],
    ["Persist is registered first", false],
  ])(
    "lets Dirty Form treat restored values as its clean baseline when %s",
    async (_label, dirtyFirst) => {
      writeDraft("draft", { title: "restored", early: "early draft", late: "late draft" });
      document.body.innerHTML = `
        <form data-controller="stimeo--dirty-form stimeo--persist"
            data-action="stimeo--persist:restore->stimeo--dirty-form#acceptRestore"
            data-stimeo--persist-key-value="draft">
          <input name="title">
      </form>`;
      application = Application.start();
      if (dirtyFirst) {
        application.register("stimeo--dirty-form", DirtyFormController);
        application.register("stimeo--persist", PersistController);
      } else {
        application.register("stimeo--persist", PersistController);
        application.register("stimeo--dirty-form", DirtyFormController);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(input("title").value).toBe("restored");
      expect(root().hasAttribute("data-dirty")).toBe(false);
      input("title").dispatchEvent(new Event("input", { bubbles: true }));
      expect(root().hasAttribute("data-dirty")).toBe(false);

      root().insertAdjacentHTML("beforeend", '<input name="early">');
      await vi.advanceTimersByTimeAsync(0);
      expect(input("early").value).toBe("early draft");
      expect(root().hasAttribute("data-dirty")).toBe(false);

      edit("title", "changed");
      expect(root().getAttribute("data-dirty")).toBe("true");
      root().insertAdjacentHTML("beforeend", '<input name="late">');
      await vi.advanceTimersByTimeAsync(0);
      expect(input("late").value).toBe("late draft");
      expect(root().getAttribute("data-dirty")).toBe("true");
    },
  );

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML = `
      <form data-controller="stimeo--persist" data-stimeo--persist-key-value="draft">
        <label for="t">Title</label>
        <input id="t" name="title">
      </form>`;
    application = Application.start();
    application.register("stimeo--persist", PersistController);
    await tick();
    await expectNoA11yViolations(root());
  });
});
