import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistController } from "../src/controllers/persist_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";

/**
 * Behavioral tests for {@link PersistController}: debounced save to localStorage,
 * restore on connect, password exclusion, clear() / clearOn, key/id fallback, and
 * the flush-on-disconnect path. Storage is the real happy-dom localStorage.
 */

const PREFIX = "stimeo--persist:";
const DEBOUNCE = 400;
const stored = (key: string) => window.localStorage.getItem(`${PREFIX}${key}`);

describe("PersistController", () => {
  let application: Application;

  const mount = async (attrs: string, inner: string) => {
    document.body.innerHTML = `<form data-controller="stimeo--persist" ${attrs}>${inner}</form>`;
    application = Application.start();
    application.register("stimeo--persist", PersistController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
  });

  afterEach(() => {
    application.stop();
    vi.useRealTimers();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  const form = () => query<HTMLFormElement>("form");
  const field = (name: string) => query<HTMLInputElement>(`[name='${name}']`);

  const edit = (name: string, value: string) => {
    field(name).value = value;
    field(name).dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("debounce-saves field values to localStorage", async () => {
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    edit("title", "hello");
    expect(stored("draft")).toBeNull(); // not yet — debounced
    vi.advanceTimersByTime(DEBOUNCE);
    expect(JSON.parse(stored("draft") ?? "{}")).toEqual({ title: "hello" });
  });

  it("restores saved values on connect and marks restored", async () => {
    window.localStorage.setItem(`${PREFIX}draft`, JSON.stringify({ title: "kept", body: "text" }));
    let restoredKey: string | undefined;
    document.addEventListener("stimeo--persist:restore", (e) => {
      restoredKey = (e as CustomEvent).detail.key;
    });

    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="title"><textarea name="body"></textarea>',
    );

    expect(field("title").value).toBe("kept");
    expect(query<HTMLTextAreaElement>("[name='body']").value).toBe("text");
    expect(form().getAttribute("data-persist-restored")).toBe("true");
    expect(restoredKey).toBe("draft");
  });

  it("persists and restores repeated same-name fields individually", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="tags[]"><input name="tags[]">',
    );
    const [first, second] = Array.from(
      document.querySelectorAll<HTMLInputElement>("[name='tags[]']"),
    );
    if (!first || !second) throw new Error("expected two tags[] inputs");
    first.value = "ruby";
    second.value = "rails";
    second.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    // Both occurrences are stored (no last-wins collision on the shared name).
    expect(Object.values(JSON.parse(stored("draft") ?? "{}"))).toEqual(["ruby", "rails"]);

    // A fresh mount restores each value to its own field by occurrence.
    application.stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="tags[]"><input name="tags[]">',
    );
    const restored = Array.from(document.querySelectorAll<HTMLInputElement>("[name='tags[]']"));
    expect(restored.map((input) => input.value)).toEqual(["ruby", "rails"]);
  });

  it("never persists a password field", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      '<input name="title"><input type="password" name="secret">',
    );
    edit("title", "hi");
    edit("secret", "p@ss");
    vi.advanceTimersByTime(DEBOUNCE);

    const data = JSON.parse(stored("draft") ?? "{}");
    expect(data).toEqual({ title: "hi" });
    expect(data).not.toHaveProperty("secret");
  });

  it("clear() drops the draft and the restored marker", async () => {
    window.localStorage.setItem(`${PREFIX}draft`, JSON.stringify({ title: "x" }));
    let cleared = false;
    document.addEventListener("stimeo--persist:clear", () => {
      cleared = true;
    });
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');

    instance().clear();

    expect(stored("draft")).toBeNull();
    expect(form().hasAttribute("data-persist-restored")).toBe(false);
    expect(cleared).toBe(true);
  });

  it("clears on the clearOn event", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft" data-stimeo--persist-clear-on-value="submit"',
      '<input name="title">',
    );
    edit("title", "hi");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(stored("draft")).not.toBeNull();

    form().dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    expect(stored("draft")).toBeNull();
  });

  it("falls back to the element id when no key is set", async () => {
    await mount('id="contact"', '<input name="title">');
    edit("title", "hi");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(JSON.parse(stored("contact") ?? "{}")).toEqual({ title: "hi" });
  });

  it("is disabled when neither key nor id is present", async () => {
    await mount("", '<input name="title">');
    edit("title", "hi");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(window.localStorage.length).toBe(0);
  });

  it("persists and restores checkbox and select state", async () => {
    await mount(
      'data-stimeo--persist-key-value="draft"',
      `<input type="checkbox" name="agree">
       <select name="plan"><option value="a">A</option><option value="b">B</option></select>`,
    );
    const checkbox = field("agree");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    const select = query<HTMLSelectElement>("[name='plan']");
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);

    expect(JSON.parse(stored("draft") ?? "{}")).toEqual({ agree: true, plan: "b" });

    // Re-mount restores them.
    application.stop();
    await mount(
      'data-stimeo--persist-key-value="draft"',
      `<input type="checkbox" name="agree">
       <select name="plan"><option value="a">A</option><option value="b">B</option></select>`,
    );
    expect(field("agree").checked).toBe(true);
    expect(query<HTMLSelectElement>("[name='plan']").value).toBe("b");
  });

  it("flushes a pending save on disconnect", async () => {
    await mount('data-stimeo--persist-key-value="draft"', '<input name="title">');
    edit("title", "flushed");
    form().remove(); // disconnect before the debounce fires
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(stored("draft") ?? "{}")).toEqual({ title: "flushed" });
  });

  it("persists a multiple-select control", async () => {
    // `selected` is set in markup: happy-dom reflects parse-time selection into
    // selectedOptions (programmatic .selected changes are not reflected).
    await mount(
      'data-stimeo--persist-key-value="draft"',
      `<select name="tags" multiple>
         <option value="a" selected>A</option><option value="b">B</option>
         <option value="c" selected>C</option>
       </select>`,
    );
    query<HTMLSelectElement>("[name='tags']").dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(DEBOUNCE);
    expect(JSON.parse(stored("draft") ?? "{}")).toEqual({ tags: ["a", "c"] });
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML = `
      <form data-controller="stimeo--persist" data-stimeo--persist-key-value="draft">
        <label for="t">Title</label>
        <input id="t" name="title">
      </form>`;
    application = Application.start();
    application.register("stimeo--persist", PersistController);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectNoA11yViolations(form());
  });

  const instance = () =>
    application.getControllerForElementAndIdentifier(
      form(),
      "stimeo--persist",
    ) as PersistController;
});
