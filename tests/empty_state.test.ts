import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmptyStateController } from "../src/controllers/empty_state_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link EmptyStateController}: initial sync, the 0 ↔ 1+
 * toggle driven by a MutationObserver, itemSelector counting and its runtime
 * changes, the boundary-only change event and its ordering against the display,
 * runtime target swaps, announce wiring, and observer teardown.
 */

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
    disconnectAndStopApplication(application);
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

  /** A detached replacement target, as a Turbo Stream would deliver one. */
  const makeTarget = (tag: string, name: "list" | "empty") => {
    const el = document.createElement(tag);
    el.setAttribute("data-stimeo--empty-state-target", name);
    return el;
  };

  const captureChanges = () => {
    const events: Array<{ count: number; empty: boolean }> = [];
    root().addEventListener("stimeo--empty-state:change", (e) => {
      events.push((e as CustomEvent).detail);
    });
    return events;
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

  it("does not emit change on the initial sync, in either direction", async () => {
    const events: unknown[] = [];
    const onChange = (e: Event) => {
      events.push((e as CustomEvent).detail);
    };
    document.addEventListener("stimeo--empty-state:change", onChange);
    try {
      await mount(""); // connects empty
      expect(events).toEqual([]);
      disconnectAndStopApplication(application);

      await mount("<li>a</li>"); // connects non-empty
      expect(events).toEqual([]);
    } finally {
      document.removeEventListener("stimeo--empty-state:change", onChange);
    }
  });

  it("updates the display before it reports the crossing", async () => {
    // A listener must be able to read the state the crossing produced, so the
    // hooks and the visibility toggle are already written when change fires.
    await mount("");
    const seen: Array<{ count: string | null; empty: string | null; placeholderHidden: boolean }> =
      [];
    root().addEventListener("stimeo--empty-state:change", () => {
      seen.push({
        count: root().getAttribute("data-count"),
        empty: root().getAttribute("data-empty"),
        placeholderHidden: empty().hasAttribute("hidden"),
      });
    });

    await addItem(); // 0 → 1
    await removeLast(); // 1 → 0
    expect(seen).toEqual([
      { count: "1", empty: null, placeholderHidden: true },
      { count: "0", empty: "true", placeholderHidden: false },
    ]);
  });

  it("counts every element child with the default itemSelector, whatever the tag", async () => {
    // The default `""` means "all element children", not "list items": a <div> grid or
    // a mixed list must count the same way a <ul> of <li> does.
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state">
        <div data-stimeo--empty-state-target="list"><div>a</div><p>b</p></div>
        <p data-stimeo--empty-state-target="empty" hidden>No items</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();

    expect(root().getAttribute("data-count")).toBe("2");
    expect(root().hasAttribute("data-empty")).toBe(false);
    expect(empty().hidden).toBe(true);
  });

  it("counts element children only, not the text and comment nodes around them", async () => {
    // A server-rendered list is pretty-printed, so an item-less one still holds
    // whitespace (and often a Turbo Stream anchor comment). It is still empty.
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state">
        <ul data-stimeo--empty-state-target="list">
          <!-- Turbo Stream rows -->
        </ul>
        <p data-stimeo--empty-state-target="empty" hidden>No items</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();

    expect(list().childNodes.length).toBeGreaterThan(0); // the fixture really holds nodes
    expect(list().childElementCount).toBe(0);
    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(list().hidden).toBe(true);
    expect(empty().hidden).toBe(false);
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

  it("follows a child that stops — and starts — matching itemSelector", async () => {
    // The count reads the children's own attributes, so rewriting one crosses the
    // boundary just as adding or removing a row does.
    await mount('<li class="item">a</li>', 'data-stimeo--empty-state-item-selector-value=".item"');
    const events = captureChanges();
    const child = list().firstElementChild as HTMLElement;

    child.className = "divider";
    await tick();
    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(empty().hidden).toBe(false);

    child.className = "item";
    await tick();
    expect(root().getAttribute("data-count")).toBe("1");
    expect(empty().hidden).toBe(true);
    expect(events).toEqual([
      { count: 0, empty: true },
      { count: 1, empty: false },
    ]);
  });

  it("re-renders when itemSelector is swapped at runtime", async () => {
    // Turbo morph rewrites the attribute while keeping the element, so connect()
    // never runs again.
    await mount('<li class="item">a</li>', 'data-stimeo--empty-state-item-selector-value=".item"');
    const events = captureChanges();

    root().setAttribute("data-stimeo--empty-state-item-selector-value", ".missing");
    await tick();

    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(empty().hidden).toBe(false);
    expect(events).toEqual([{ count: 0, empty: true }]);
  });

  it("starts watching item attributes when itemSelector arrives at runtime", async () => {
    // Without a selector the count cannot depend on the children's attributes, so
    // they are not watched; gaining one has to widen the observation.
    await mount('<li class="item">a</li>');
    expect(root().getAttribute("data-count")).toBe("1");

    root().setAttribute("data-stimeo--empty-state-item-selector-value", ".item");
    await tick();
    expect(root().getAttribute("data-count")).toBe("1");

    (list().firstElementChild as HTMLElement).className = "divider";
    await tick();
    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
  });

  it("announces the empty crossing through the shared announcer", async () => {
    // A region that only becomes live when the empty state appears is not reliably
    // read; the page's announcer is the one that already exists.
    const seen: string[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await mount("<li>one</li>", 'data-stimeo--empty-state-announce-text-value="No results"');
      await removeLast();
      expect(seen).toEqual(["No results"]);

      // The other direction has no copy here, and the library ships no wording of
      // its own, so crossing back says nothing.
      await addItem();
      expect(seen).toEqual(["No results"]);
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
  });

  it("announces the refilled crossing with its own copy", async () => {
    const seen: string[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await mount(
        "",
        'data-stimeo--empty-state-announce-text-value="No results" ' +
          'data-stimeo--empty-state-announce-filled-text-value="{count} result(s)"',
      );
      await addItem(); // 0 → 1
      expect(seen).toEqual(["1 result(s)"]);
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
  });

  it("leaves the empty target's live-region markup to the consumer", async () => {
    // Announcing is the announcer's job, so the placeholder's ARIA is untouched:
    // an authored politeness stands, and none is invented where there was none.
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state">
        <ul data-stimeo--empty-state-target="list"></ul>
        <p data-stimeo--empty-state-target="empty" aria-live="assertive" hidden>No items</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();
    expect(empty().getAttribute("aria-live")).toBe("assertive");
    expect(empty().hasAttribute("role")).toBe(false);
  });

  it("tolerates an invalid itemSelector without crashing (falls back to all children)", async () => {
    await mount("<li>a</li><li>b</li>", 'data-stimeo--empty-state-item-selector-value=")("');
    expect(root().getAttribute("data-count")).toBe("2"); // counted all, did not throw
    expect(root().hasAttribute("data-empty")).toBe(false);
  });

  it("re-points the observation when the list element is replaced at runtime", async () => {
    await mount("<li>a</li>");
    expect(root().getAttribute("data-count")).toBe("1");

    // Turbo Stream `replace` swaps the <ul> itself; the controller element stays,
    // so connect() never runs again.
    const fresh = makeTarget("ul", "list");
    list().replaceWith(fresh);
    await tick();

    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(fresh.hidden).toBe(true);
    expect(empty().hidden).toBe(false);

    fresh.appendChild(document.createElement("li"));
    await tick();
    expect(root().getAttribute("data-count")).toBe("1");
    expect(fresh.hidden).toBe(false);
    expect(empty().hidden).toBe(true);
  });

  it("re-points the observation when the list element is replaced in two phases", async () => {
    // Turbo Stream `after` + `remove`: while both lists are in the DOM the single-target
    // getter still resolves to the original, so the replacement is only picked up when
    // the original leaves the target set.
    await mount("<li>a</li>");
    const old = list();
    const fresh = makeTarget("ul", "list");

    old.after(fresh);
    await tick();
    old.remove();
    await tick();

    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(fresh.hidden).toBe(true);
    expect(empty().hidden).toBe(false);

    // The observation follows the replacement, not the detached original.
    fresh.appendChild(document.createElement("li"));
    await tick();
    expect(root().getAttribute("data-count")).toBe("1");
  });

  it("reports the crossing exactly once when the list element is replaced", async () => {
    // The swap runs both target callbacks in one batch; only the first of them
    // finds a boundary left to cross.
    await mount("<li>a</li>");
    const events = captureChanges();

    const fresh = makeTarget("ul", "list");
    list().replaceWith(fresh); // 1 → 0 across the swap
    await tick();
    expect(events).toEqual([{ count: 0, empty: true }]);

    fresh.appendChild(document.createElement("li")); // 0 → 1 back
    await tick();
    expect(events).toEqual([
      { count: 0, empty: true },
      { count: 1, empty: false },
    ]);
  });

  it("syncs an empty placeholder swapped in at runtime", async () => {
    await mount("<li>a</li>");
    const fresh = makeTarget("p", "empty");
    fresh.textContent = "No items";
    empty().replaceWith(fresh);
    await tick();

    expect(fresh.hidden).toBe(true); // the list still has an item
  });

  it("syncs an empty placeholder replaced in two phases, once the old one leaves", async () => {
    // Turbo Stream `after` / `before` / `append` + `remove` swaps a placeholder in two
    // steps. While both are in the DOM the single-target getter still resolves to the
    // original, so the replacement is only reachable after the original leaves.
    await mount("<li>a</li>");
    const old = empty();
    const fresh = makeTarget("p", "empty");
    fresh.textContent = "No items";

    old.after(fresh);
    await tick();
    expect(fresh.hidden).toBe(false); // still shadowed by the original

    old.remove();
    await tick();
    expect(fresh.hidden).toBe(true); // the list still has an item
  });

  it("syncs an empty placeholder replaced in two phases while the list is empty", async () => {
    await mount("");
    const old = empty();
    const fresh = makeTarget("p", "empty");
    fresh.textContent = "No items";
    fresh.hidden = true; // authored hidden, as the markup contract has it

    old.after(fresh);
    await tick();
    old.remove();
    await tick();

    expect(fresh.hidden).toBe(false); // the list is empty, so the placeholder shows
    expect(root().getAttribute("data-empty")).toBe("true");
  });

  it("syncs an empty placeholder that arrives after connect", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state">
        <ul data-stimeo--empty-state-target="list"></ul>
      </div>`;
    application = Application.start();
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();

    const fresh = makeTarget("p", "empty");
    fresh.textContent = "No items";
    fresh.hidden = true; // authored hidden, as the markup contract has it
    root().appendChild(fresh);
    await tick();

    expect(fresh.hidden).toBe(false); // the list is empty, so it shows straight away
  });

  it("stays inert when the markup has no list target", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state">
        <p data-stimeo--empty-state-target="empty" hidden>No items</p>
      </div>`;
    application = Application.start();
    // Stimulus reports a lifecycle exception instead of rethrowing it, so a DOM
    // assertion alone cannot tell the guard from a crash.
    const errors: Error[] = [];
    application.handleError = (error) => {
      errors.push(error as Error);
    };
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();

    expect(errors).toEqual([]);
    expect(root().hasAttribute("data-count")).toBe(false);
    expect(root().hasAttribute("data-empty")).toBe(false);
    expect(empty().hidden).toBe(true); // untouched
  });

  it("does not report a crossing when the list target arrives after connect", async () => {
    // Nothing was displayed before the list existed, so its first render is an
    // initial sync — not a 1 → 0 transition to report.
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state">
        <p data-stimeo--empty-state-target="empty" hidden>No items</p>
      </div>`;
    application = Application.start();
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();
    const events = captureChanges();

    root().prepend(makeTarget("ul", "list"));
    await tick();

    expect(root().getAttribute("data-count")).toBe("0");
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(empty().hidden).toBe(false);
    expect(events).toEqual([]);
  });

  it("keeps working when the markup omits the empty placeholder", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--empty-state">
        <ul data-stimeo--empty-state-target="list"></ul>
      </div>`;
    application = Application.start();
    const errors: Error[] = [];
    application.handleError = (error) => {
      errors.push(error as Error);
    };
    application.register("stimeo--empty-state", EmptyStateController);
    await tick();

    expect(errors).toEqual([]);
    expect(root().getAttribute("data-empty")).toBe("true");
    expect(list().hidden).toBe(true);

    list().appendChild(document.createElement("li"));
    await tick();
    expect(root().getAttribute("data-count")).toBe("1");
    expect(list().hidden).toBe(false);
  });

  it("emits change on an in-page move only when the boundary was crossed while away", async () => {
    // Stimulus keeps the controller instance for an element that leaves and
    // re-enters the document, so the last applied state survives the move.
    await mount("<li>a</li>");
    const rootEl = root();
    const listEl = list();
    const parent = rootEl.parentElement as HTMLElement;
    const events: Array<{ count: number; empty: boolean }> = [];
    const onChange = (e: Event) => {
      events.push((e as CustomEvent).detail);
    };
    document.addEventListener("stimeo--empty-state:change", onChange);
    try {
      // Moved with its contents unchanged: nothing crossed, so nothing is reported.
      rootEl.remove();
      await tick();
      parent.appendChild(rootEl);
      await tick();
      expect(events).toEqual([]);

      // Emptied while detached: the boundary was crossed, so re-entry reports it.
      rootEl.remove();
      await tick();
      listEl.replaceChildren();
      parent.appendChild(rootEl);
      await tick();
      expect(events).toEqual([{ count: 0, empty: true }]);
    } finally {
      document.removeEventListener("stimeo--empty-state:change", onChange);
    }
  });

  it("stops observing after disconnect", async () => {
    await mount("");
    const rootEl = root();
    const listEl = list();
    rootEl.remove(); // Turbo navigation: the element leaves the document
    await tick();

    listEl.appendChild(document.createElement("li"));
    await tick();
    // The severed observer must not keep syncing the hooks of a disconnected
    // controller. `data-controller` is still on the detached root, so the targets
    // stay resolvable and a live observer *would* rewrite them — asserting the
    // mutation "does not throw" would pass either way.
    expect(rootEl.getAttribute("data-count")).toBe("0");
    expect(rootEl.getAttribute("data-empty")).toBe("true");
    expect(listEl.hidden).toBe(true);
  });

  it("stops observing after disconnect even when a re-sync ran first", async () => {
    // A re-sync replaces the observation; only the newest one is remembered, so any
    // observation left behind by an earlier sync would survive the teardown below and
    // keep rewriting the hooks of a disconnected controller.
    await mount("");
    const rootEl = root();
    const listEl = list();

    empty().replaceWith(makeTarget("p", "empty")); // target swap → re-sync
    await tick();

    rootEl.remove(); // Turbo navigation
    await tick();

    listEl.appendChild(document.createElement("li"));
    await tick();
    expect(rootEl.getAttribute("data-count")).toBe("0");
    expect(rootEl.getAttribute("data-empty")).toBe("true");
    expect(listEl.hidden).toBe(true);
  });

  it("has no a11y violations (empty state visible)", async () => {
    await mount("");
    await expectNoA11yViolations(root());
  });

  // Speech-order regression: the placeholder the controller reveals for an empty
  // list reads as its role followed by its authored text.
  it("reads the empty placeholder as a paragraph when there are no items", async () => {
    await mount("");
    const speech = await captureSpeech({ container: empty(), steps: 1 });
    expect(speech).toEqual(["paragraph", "No items"]);
  });
});
