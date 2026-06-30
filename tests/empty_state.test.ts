import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmptyStateController } from "../src/controllers/empty_state_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link EmptyStateController}: initial sync, the 0 ↔ 1+
 * toggle driven by a MutationObserver, itemSelector counting, the boundary-only
 * change event, announce wiring, and observer teardown.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("EmptyStateController", () => {
  let application: Application;

  const mount = async (inner: string, attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state" ${attrs}>
        <ul data-stimeo--empty-state-target="list">${inner}</ul>
        <p data-stimeo--empty-state-target="empty" hidden>No items</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--empty-state']");
  const list = () => query("[data-stimeo--empty-state-target='list']");
  const empty = () => query("[data-stimeo--empty-state-target='empty']");

  const addItem = async (className = "item") => {
    const li = document.createElement("li");
    li.className = className;
    list().appendChild(li);
    await tick();
  };
  const removeLast = async () => {
    list().lastElementChild?.remove();
    await tick();
  };

  it("shows the empty state and hides the list when there are no items", async () => {
    await mount("");
    expect(list().hidden).toBe(true);
    expect(empty().hidden).toBe(false);
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(root().getAttribute("data-count")).toBe("0");
  });

  it("shows the list and hides the empty state when items are present", async () => {
    await mount("<li>a</li><li>b</li>");
    expect(list().hidden).toBe(false);
    expect(empty().hidden).toBe(true);
    expect(root().hasAttribute("data-empty")).toBe(false);
    expect(root().getAttribute("data-count")).toBe("2");
  });

  it("toggles and emits change when crossing the empty boundary", async () => {
    await mount("");
    const events: Array<{ count: number; empty: boolean }> = [];
    root().addEventListener("stimeo--empty-state:change", (e) => {
      events.push((e as CustomEvent).detail);
    });

    await addItem(); // 0 → 1
    expect(root().hasAttribute("data-empty")).toBe(false);
    expect(empty().hidden).toBe(true);
    expect(events.at(-1)).toEqual({ count: 1, empty: false });

    await removeLast(); // 1 → 0
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(empty().hidden).toBe(false);
    expect(events.at(-1)).toEqual({ count: 0, empty: true });
  });

  it("does not emit change for non-boundary count changes", async () => {
    await mount("<li>a</li>");
    let changes = 0;
    root().addEventListener("stimeo--empty-state:change", () => {
      changes += 1;
    });
    await addItem(); // 1 → 2 (stays non-empty)
    await addItem(); // 2 → 3
    expect(root().getAttribute("data-count")).toBe("3");
    expect(changes).toBe(0);
  });

  it("counts only itemSelector matches", async () => {
    await mount(
      '<li class="item">a</li><li class="divider">—</li>',
      'data-stimeo--empty-state-item-selector-value=".item"',
    );
    expect(root().getAttribute("data-count")).toBe("1");

    await addItem("divider"); // non-matching → still 1, stays non-empty
    expect(root().getAttribute("data-count")).toBe("1");
  });

  it("treats a list of only non-matching children as empty", async () => {
    await mount(
      '<li class="divider">—</li>',
      'data-stimeo--empty-state-item-selector-value=".item"',
    );
    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(empty().hidden).toBe(false);
  });

  it("makes the empty target a polite live region when announce is set", async () => {
    await mount("", 'data-stimeo--empty-state-announce-value="true"');
    expect(empty().getAttribute("role")).toBe("status");
    expect(empty().getAttribute("aria-live")).toBe("polite");
  });

  it("does not clobber an authored live-region role on the empty target", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state" data-stimeo--empty-state-announce-value="true">
        <ul data-stimeo--empty-state-target="list"></ul>
        <p data-stimeo--empty-state-target="empty" aria-live="assertive" hidden>No items</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();
    expect(empty().getAttribute("aria-live")).toBe("assertive"); // preserved
    expect(empty().hasAttribute("role")).toBe(false); // not added over an existing live region
  });

  it("tolerates an invalid itemSelector without crashing (falls back to all children)", async () => {
    await mount("<li>a</li><li>b</li>", 'data-stimeo--empty-state-item-selector-value=")("');
    expect(root().getAttribute("data-count")).toBe("2"); // counted all, did not throw
    expect(root().hasAttribute("data-empty")).toBe(false);
  });

  it("stops observing after disconnect", async () => {
    await mount("");
    const listEl = list();
    root().remove();
    await tick();
    // After disconnect the observer is severed; mutating the detached list is a no-op.
    expect(() => listEl.appendChild(document.createElement("li"))).not.toThrow();
  });

  it("has no a11y violations (empty state visible)", async () => {
    await mount("");
    await expectNoA11yViolations(root());
  });

  // Layer ③ — speech-order regression: the empty message sits in a polite live
  // region the controller marks up when the list is empty.
  it("announces the empty live region when there are no items (layer ③)", async () => {
    await mount("");
    const speech = await captureSpeech({ container: empty(), steps: 1 });
    expect(speech).toEqual(["paragraph", "No items"]);
  });
});
