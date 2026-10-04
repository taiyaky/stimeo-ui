import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RadioGroupController } from "../src/controllers/radio_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link RadioGroupController}: the APG Radio Group contract
 * for custom radios — single selection via `aria-checked`, roving `tabindex`,
 * arrow navigation with selection-follows-focus, the hidden-field mirror, and the
 * `change` / `reconcile` notifications.
 */

describe("RadioGroupController", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--radio-group" role="radiogroup" aria-label="Plan">
        <div role="radio" aria-checked="true" tabindex="0" data-value="basic"
             data-stimeo--radio-group-target="radio"
             data-action="click->stimeo--radio-group#select
                          keydown->stimeo--radio-group#onKeydown">Basic</div>
        <div role="radio" aria-checked="false" tabindex="-1" data-value="pro"
             data-stimeo--radio-group-target="radio"
             data-action="click->stimeo--radio-group#select
                          keydown->stimeo--radio-group#onKeydown">Pro</div>
        <div role="radio" aria-checked="false" tabindex="-1" data-value="max"
             data-stimeo--radio-group-target="radio"
             data-action="click->stimeo--radio-group#select
                          keydown->stimeo--radio-group#onKeydown">Max</div>
        <input type="hidden" data-stimeo--radio-group-target="field" />
      </div>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--radio-group']") as HTMLElement;
  const radios = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--radio-group-target='radio']"));
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--radio-group-target='field']",
    ) as HTMLInputElement;
  const checkedValues = () => radios().map((radio) => radio.getAttribute("aria-checked"));
  const tabindexes = () => radios().map((radio) => radio.tabIndex);
  const key = (index: number, k: string) =>
    radios()[index]?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("settles author selection without repeated roving writes", async () => {
    let writes = 0;
    const observer = new MutationObserver((records) => {
      writes += records.length;
    });
    observer.observe(root(), { subtree: true, attributes: true, attributeFilter: ["tabindex"] });
    try {
      radios()[0]?.setAttribute("aria-checked", "false");
      radios()[1]?.setAttribute("aria-checked", "true");
      // Finite microtask windows keep the assertion reachable even when a
      // reconciliation pass keeps scheduling another pass before the next task.
      for (let i = 0; i < 12; i++) await flushMicrotasks();
      const settled = writes;
      for (let i = 0; i < 12; i++) await flushMicrotasks();
      expect(tabindexes()).toEqual([-1, 0, -1]);
      expect(checkedValues()).toEqual(["false", "true", "false"]);
      expect(field().value).toBe("pro");
      expect(settled).toBeGreaterThan(0);
      expect(writes).toBe(settled);
    } finally {
      observer.disconnect();
      disconnectAndStopApplication(application);
    }
  });

  it("yields a key a descendant widget already consumed", () => {
    // A composed widget that claims the key must not ALSO move the selection —
    // composition depends on this yield.
    radios()[0]?.focus();
    const inner = document.createElement("span");
    radios()[0]?.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());

    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("leaves a modified arrow to the browser", () => {
    // A chorded arrow belongs to the browser (history navigation and friends):
    // the group neither consumes it nor moves the selection.
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
      altKey: true,
    });
    radios()[0]?.dispatchEvent(chord);

    expect(chord.defaultPrevented).toBe(false);
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("leaves modified Home and End shortcuts to the browser", () => {
    for (const shortcut of [
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true, ctrlKey: true }),
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true, metaKey: true }),
    ]) {
      radios()[0]?.dispatchEvent(shortcut);
      expect(shortcut.defaultPrevented).toBe(false);
    }

    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("moves and checks with the horizontal arrows under LTR", () => {
    // The APG Radio Group pattern pairs `ArrowRight` with `ArrowDown` and
    // `ArrowLeft` with `ArrowUp`; this case covers the horizontal half.
    key(0, "ArrowRight");
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(checkedValues()).toEqual(["false", "true", "false"]);

    key(1, "ArrowLeft");
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("reverses the horizontal arrows under RTL, leaving Down/Up alone", () => {
    // Logical direction: APG describes the horizontal pair as "next / previous",
    // so it reverses with the writing direction. `dir="rtl"` is the authoring
    // contract, but happy-dom does not resolve it into the computed style, so the
    // direction is set as an inline style instead.
    root().style.direction = "rtl";

    key(0, "ArrowLeft"); // "next" under RTL
    expect(tabindexes()).toEqual([-1, 0, -1]);

    key(1, "ArrowRight"); // "previous"
    expect(tabindexes()).toEqual([0, -1, -1]);

    key(0, "ArrowDown"); // the vertical pair carries no direction
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("sets up roving from the preselected radio and mirrors the field", () => {
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(field().value).toBe("basic");
  });

  it("selects on click and updates roving, field, and aria-checked", () => {
    radios()[1]?.click();
    expect(checkedValues()).toEqual(["false", "true", "false"]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(field().value).toBe("pro");
  });

  it("yields consumed pointer activation and ignores actions on non-targets", async () => {
    const inner = document.createElement("span");
    inner.textContent = "Consumed";
    inner.addEventListener("click", (event) => event.preventDefault());
    radios()[1]?.append(inner);
    inner.click();

    const outsider = document.createElement("div");
    outsider.setAttribute("role", "radio");
    outsider.setAttribute("aria-checked", "false");
    outsider.setAttribute(
      "data-action",
      "click->stimeo--radio-group#select keydown->stimeo--radio-group#onKeydown",
    );
    root().append(outsider);
    await tick();
    outsider.click();
    outsider.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(checkedValues()).toEqual(["true", "false", "false"]);
    expect(field().value).toBe("basic");
    expect(outsider.getAttribute("aria-checked")).toBe("false");
  });

  it("leaves keyboard events from non-radio descendants alone", () => {
    const button = document.createElement("button");
    button.type = "button";
    root().append(button);
    const event = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });

    expect(button.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("does not lose the Tab stop when a non-radio descendant receives focus", () => {
    const button = document.createElement("button");
    button.type = "button";
    root().append(button);

    button.focus();

    expect(document.activeElement).toBe(button);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("fires a native change on the field when the selection changes", () => {
    const changes: string[] = [];
    field().addEventListener("change", () => changes.push(field().value));
    radios()[1]?.click();
    expect(changes).toEqual(["pro"]);
    // Re-selecting the same radio does not re-fire (value unchanged).
    radios()[1]?.click();
    expect(changes).toEqual(["pro"]);
  });

  it("does not fire a native change for the connect-time reflection", () => {
    // The preselected radio is mirrored on connect, but that is not a user edit:
    // a listener attached after connect must not see a change until interaction.
    const changes: string[] = [];
    field().addEventListener("change", () => changes.push(field().value));
    expect(changes).toEqual([]);
  });

  it("moves and selects with ArrowDown, wrapping at the end", () => {
    key(0, "ArrowDown");
    expect(checkedValues()).toEqual(["false", "true", "false"]);
    expect(document.activeElement).toBe(radios()[1]);

    key(1, "ArrowDown");
    key(2, "ArrowDown"); // wrap back to first
    expect(checkedValues()).toEqual(["true", "false", "false"]);
    expect(document.activeElement).toBe(radios()[0]);
  });

  it("wraps backward with ArrowUp and jumps with Home/End", () => {
    key(0, "ArrowUp"); // wrap to last
    expect(document.activeElement).toBe(radios()[2]);
    expect(field().value).toBe("max");

    key(2, "Home");
    expect(document.activeElement).toBe(radios()[0]);
    key(0, "End");
    expect(document.activeElement).toBe(radios()[2]);
  });

  it("selects the focused radio on Space", () => {
    radios()[2]?.focus();
    key(2, " ");
    expect(checkedValues()).toEqual(["false", "false", "true"]);
    expect(field().value).toBe("max");
  });

  it("dispatches change with the value and the radio element", () => {
    const details: Array<{ value: string; radio: HTMLElement }> = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      details.push((event as CustomEvent).detail);
    });
    radios()[1]?.click();
    expect(details).toHaveLength(1);
    expect(details[0]?.value).toBe("pro");
    expect(details[0]?.radio).toBe(radios()[1]);
  });

  it("dispatches no change event when the selected radio is activated again", () => {
    const details: CustomEvent[] = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      details.push(event as CustomEvent);
    });

    radios()[0]?.click();
    key(0, " ");

    expect(details).toEqual([]);
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("distinguishes a new selected radio from an unchanged submitted value", () => {
    radios()[1]?.setAttribute("data-value", "basic");
    const customChanges: Array<{ radio: HTMLElement }> = [];
    const nativeChanges: string[] = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      customChanges.push((event as CustomEvent).detail);
    });
    field().addEventListener("change", () => nativeChanges.push(field().value));

    radios()[1]?.click();

    expect(customChanges.map(({ radio }) => radio)).toEqual([radios()[1]]);
    expect(nativeChanges).toEqual([]);
    expect(checkedValues()).toEqual(["false", "true", "false"]);
  });

  it("normalizes runtime additions and delegates activation without per-item actions", async () => {
    const added = document.createElement("div");
    added.setAttribute("role", "radio");
    added.setAttribute("aria-checked", "true");
    added.setAttribute("tabindex", "0");
    added.setAttribute("data-value", "enterprise");
    added.setAttribute("data-stimeo--radio-group-target", "radio");
    added.textContent = "Enterprise";
    root().append(added);
    await tick();

    expect(checkedValues()).toEqual(["true", "false", "false", "false"]);
    expect(tabindexes()).toEqual([0, -1, -1, -1]);

    added.click();
    expect(checkedValues()).toEqual(["false", "false", "false", "true"]);
    expect(tabindexes()).toEqual([-1, -1, -1, 0]);
    expect(field().value).toBe("enterprise");
  });

  it("recovers focus and clears stale form state when the selected radio is removed", async () => {
    radios()[1]?.click();
    radios()[1]?.focus();
    expect(document.activeElement).toBe(radios()[1]);

    radios()[1]?.remove();
    await tick();

    expect(checkedValues()).toEqual(["false", "false"]);
    expect(tabindexes()).toEqual([-1, 0]);
    expect(document.activeElement).toBe(radios()[1]);
    expect(field().value).toBe("");
  });

  it("recovers focus past a hidden sibling to the radio nearest the removal", async () => {
    // A `hidden` radio stays a target but never takes the Tab stop. The saved
    // position and the search for a survivor therefore have to read the same
    // population, or the destination lands one radio past the removal.
    const legacy = document.createElement("div");
    legacy.setAttribute("role", "radio");
    legacy.setAttribute("aria-checked", "false");
    legacy.setAttribute("data-value", "legacy");
    legacy.setAttribute("data-stimeo--radio-group-target", "radio");
    legacy.hidden = true;
    root().prepend(legacy);
    await tick();

    // Order is [legacy(hidden), basic, pro, max]; focus and remove basic.
    radios()[1]?.focus();
    radios()[1]?.remove();
    await tick();

    expect(radios()[1]?.getAttribute("data-value")).toBe("pro");
    expect(document.activeElement).toBe(radios()[1]);
  });

  it("recovers focus backwards when the last radio is the one removed", async () => {
    // Nothing survives at or after the removal, so the destination is the last
    // radio before it.
    radios()[2]?.focus();
    radios()[2]?.remove();
    await tick();

    expect(radios()).toHaveLength(2);
    expect(document.activeElement).toBe(radios()[1]);
    expect(tabindexes()).toEqual([-1, 0]);
  });

  it("releases ownership when an author's write shares a task with its own", async () => {
    // Both writes land on one radio in one task, so the observer delivers two
    // records that read back the same final value. This pass filed a claim for
    // one of them; the record left over is the author's, and it takes the
    // supplied attribute out of this controller's hands.
    const late = document.createElement("div");
    late.setAttribute("role", "radio");
    late.setAttribute("data-value", "enterprise");
    late.setAttribute("data-stimeo--radio-group-target", "radio");
    root().appendChild(late);
    await tick();
    expect(late.getAttribute("aria-checked")).toBe("false");

    late.setAttribute("aria-checked", "true");
    // Selecting a third radio makes this pass write `late` back to "false", so
    // the author's record and its own both read "false" back.
    radios()[1]?.click();
    await tick();

    late.remove();
    await tick();

    expect(late.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps ownership of a supplied checked state across two writes in one task", async () => {
    // Two selections in the same task write `aria-checked` on the same radio
    // twice, and both observer records read back the final value. Taking the
    // second one for an author's edit would drop this controller's ownership and
    // leave the supplied attribute behind when the radio leaves the group.
    const late = document.createElement("div");
    late.setAttribute("role", "radio");
    late.setAttribute("data-value", "enterprise");
    late.setAttribute("data-stimeo--radio-group-target", "radio");
    root().appendChild(late);
    await tick();
    expect(late.getAttribute("aria-checked")).toBe("false");

    late.click();
    radios()[0]?.click();
    await tick();
    expect(late.getAttribute("aria-checked")).toBe("false");

    late.remove();
    await tick();

    expect(late.hasAttribute("aria-checked")).toBe(false);
  });

  it("reports a selection lost to target removal as reconcile, not change", async () => {
    radios()[1]?.click();
    const changes: unknown[] = [];
    const repairs: Array<{ value: string; radio: HTMLElement | null }> = [];
    const natives: string[] = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--radio-group:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    field().addEventListener("change", () => natives.push(field().value));

    radios()[1]?.remove();
    await tick();

    // The group, not the user, decided the selection is gone.
    expect(repairs).toEqual([{ value: "", radio: null }]);
    expect(changes).toEqual([]);
    // Form automation reads native change as a user edit, so it stays silent.
    expect(natives).toEqual([]);
    expect(field().value).toBe("");
  });

  it("reports a morph that moves the selection as reconcile once", async () => {
    const changes: unknown[] = [];
    const repairs: Array<{ value: string; radio: HTMLElement | null }> = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--radio-group:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    radios()[0]?.setAttribute("aria-checked", "false");
    radios()[2]?.setAttribute("aria-checked", "true");
    await tick();

    expect(repairs).toEqual([{ value: "max", radio: radios()[2] }]);
    expect(changes).toEqual([]);
    expect(field().value).toBe("max");
  });

  it("does not report a reconciliation that leaves the selection where it was", async () => {
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--radio-group:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    // Removing an unselected radio repairs the Tab stop but not the selection.
    radios()[2]?.remove();
    await tick();

    expect(repairs).toEqual([]);
  });

  it("keeps change for user selection and never pairs it with reconcile", async () => {
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      changes.push((event as CustomEvent).detail);
    });
    root().addEventListener("stimeo--radio-group:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    radios()[1]?.click();
    await tick();

    expect(changes).toEqual([{ value: "pro", radio: radios()[1], reason: "user" }]);
    expect(repairs).toEqual([]);
  });

  it("reports a morph that moves the selection or its submitted value as reconcile, never as change", async () => {
    const customChanges: CustomEvent[] = [];
    const repairs: Array<{ value: string; radio: HTMLElement | null }> = [];
    const nativeChanges: Event[] = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      customChanges.push(event as CustomEvent);
    });
    root().addEventListener("stimeo--radio-group:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    field().addEventListener("change", (event) => nativeChanges.push(event));

    radios()[0]?.setAttribute("aria-checked", "false");
    radios()[2]?.setAttribute("aria-checked", "true");
    await tick();

    expect(checkedValues()).toEqual(["false", "false", "true"]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(field().value).toBe("max");

    // The selected radio keeps its identity while the value it submits changes.
    radios()[2]?.setAttribute("data-value", "ultimate");
    await tick();
    expect(field().value).toBe("ultimate");
    expect(repairs).toEqual([
      { value: "max", radio: radios()[2] },
      { value: "ultimate", radio: radios()[2] },
    ]);
    expect(customChanges).toEqual([]);
    expect(nativeChanges).toEqual([]);
  });

  it("reports a value a reconcile listener rewrites with a second reconcile", async () => {
    const events = captureStateEvents("stimeo--radio-group", ["change", "reconcile"]);
    let spent = false;
    // Registered after the capture, so the recording keeps dispatch order. The
    // listener writes the attribute the way a page script does, so only
    // observation can bring it to a pass.
    const rewrite = (): void => {
      if (spent) return;
      spent = true;
      radios()[2]?.setAttribute("data-value", "max-2");
    };
    document.addEventListener("stimeo--radio-group:reconcile", rewrite);

    radios()[0]?.setAttribute("aria-checked", "false");
    radios()[2]?.setAttribute("aria-checked", "true");
    await tick();
    await tick();
    document.removeEventListener("stimeo--radio-group:reconcile", rewrite);

    // Observation resumes before the report, so the listener's write is a page
    // change of its own: the next pass reports it and the field follows it.
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { value: "max", radio: radios()[2] } },
      { name: "reconcile", detail: { value: "max-2", radio: radios()[2] } },
    ]);
    expect(field().value).toBe("max-2");
    events.stop();
  });

  it("does not report a new value on a radio that is not selected", async () => {
    const events = captureStateEvents("stimeo--radio-group", ["change", "reconcile"]);

    radios()[1]?.setAttribute("data-value", "pro-2");
    await tick();
    radios()[0]?.setAttribute("data-value", "basic");
    await tick();

    expect(events.names()).toEqual([]);
    expect(field().value).toBe("basic");
    events.stop();
  });

  it("reports a page move the user activates again before it is reconciled", async () => {
    const events = captureStateEvents("stimeo--radio-group", ["change", "reconcile"]);

    /** The user's confirmation includes the page write that has not settled yet. */
    radios()[0]?.setAttribute("aria-checked", "false");
    radios()[2]?.setAttribute("aria-checked", "true");
    radios()[2]?.click();
    await tick();

    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "change", detail: { value: "max", radio: radios()[2], reason: "user" } },
    ]);
    events.stop();
  });

  it("reports nothing on connect, or when it connects again to a value moved while away", async () => {
    const events = captureStateEvents("stimeo--radio-group", ["change", "reconcile"]);
    const group = root();

    group.removeAttribute("data-controller");
    await tick();
    radios()[0]?.setAttribute("data-value", "starter");
    group.setAttribute("data-controller", "stimeo--radio-group");
    await tick();

    expect(field().value).toBe("starter");
    expect(events.names()).toEqual([]);

    // The value read on connect is the one the next move is measured from.
    radios()[0]?.setAttribute("data-value", "basic");
    await tick();
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { value: "basic", radio: radios()[0] } },
    ]);
    events.stop();
  });

  it("measures a later repair from a selection made inside a native change listener", async () => {
    const events = captureStateEvents("stimeo--radio-group", ["change", "reconcile"]);
    let spent = false;
    // happy-dom removes a `once` listener only after it returns, so a flag keeps
    // this listener from answering the change its own selection fires.
    field().addEventListener("change", () => {
      if (spent) return;
      spent = true;
      radios()[2]?.click();
    });

    radios()[1]?.click();
    await tick();
    // An unrelated repair runs a pass; the selection has not moved since the user made it.
    radios()[0]?.remove();
    await tick();

    expect(events.names()).toEqual(["change"]);
    expect(field().value).toBe("max");
    events.stop();
  });

  it("reports nothing once a focus listener disconnects the group during its repair", async () => {
    const events = captureStateEvents("stimeo--radio-group", ["change", "reconcile"]);
    radios()[1]?.focus();
    root().addEventListener("focusin", () => application.unload("stimeo--radio-group"));

    // Removing the focused radio moves focus inside the repair pass, and the
    // listener disconnects the group before the pass would report.
    radios()[1]?.remove();
    await tick();

    expect(events.names()).toEqual([]);
    events.stop();
  });

  it("synchronizes a field target added or replaced at runtime", async () => {
    field().remove();
    const replacement = document.createElement("input");
    replacement.type = "hidden";
    replacement.value = "stale";
    replacement.setAttribute("data-stimeo--radio-group-target", "field");
    root().append(replacement);
    await tick();

    expect(replacement.value).toBe("basic");
  });

  it("keeps aria-disabled radios discoverable while blocking activation", async () => {
    radios()[1]?.setAttribute("aria-disabled", "true");
    const changes: CustomEvent[] = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      changes.push(event as CustomEvent);
    });

    key(0, "ArrowDown");
    expect(document.activeElement).toBe(radios()[1]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(checkedValues()).toEqual(["true", "false", "false"]);

    const replacement = document.createElement("input");
    replacement.type = "hidden";
    replacement.setAttribute("data-stimeo--radio-group-target", "field");
    field().replaceWith(replacement);
    await tick();
    expect(document.activeElement).toBe(radios()[1]);
    expect(tabindexes()).toEqual([-1, 0, -1]);

    radios()[1]?.click();
    key(1, " ");
    expect(checkedValues()).toEqual(["true", "false", "false"]);
    expect(changes).toEqual([]);

    key(1, "ArrowDown");
    expect(document.activeElement).toBe(radios()[2]);
    expect(checkedValues()).toEqual(["false", "false", "true"]);
  });

  it("skips hidden radios during navigation", async () => {
    radios()[1]?.setAttribute("hidden", "");
    await tick();

    radios()[1]?.click();
    expect(checkedValues()).toEqual(["true", "false", "false"]);

    key(0, "ArrowDown");
    expect(document.activeElement).toBe(radios()[2]);
    expect(checkedValues()).toEqual(["false", "false", "true"]);
  });

  it("inherits aria-disabled activation suppression from the group", () => {
    root().setAttribute("aria-disabled", "true");
    radios()[1]?.click();
    key(0, "ArrowDown");

    expect(checkedValues()).toEqual(["true", "false", "false"]);
    expect(document.activeElement).toBe(radios()[1]);
  });

  it("isolates delegated events from a nested Radio Group", async () => {
    const outerRadios = radios();
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--radio-group");
    nested.setAttribute("role", "radiogroup");
    nested.setAttribute("aria-label", "Nested");
    nested.innerHTML = `<div role="radio" aria-checked="false" tabindex="0" data-value="nested"
      data-stimeo--radio-group-target="radio">Nested</div>`;
    radios()[1]?.append(nested);
    await tick();

    const nestedRadio = nested.querySelector<HTMLElement>("[role='radio']");
    nestedRadio?.click();
    nestedRadio?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    nested.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );

    expect(nestedRadio?.getAttribute("aria-checked")).toBe("true");
    expect(outerRadios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(field().value).toBe("basic");
  });

  it("tears down delegated listeners, mutation observation, and queued reconciliation", async () => {
    const instance = application.controllers.find(
      (controller) => controller.identifier === "stimeo--radio-group",
    ) as RadioGroupController;
    instance.disconnect();

    const added = document.createElement("div");
    added.setAttribute("role", "radio");
    added.setAttribute("aria-checked", "false");
    added.setAttribute("tabindex", "-1");
    added.setAttribute("data-value", "after-disconnect");
    added.setAttribute("data-stimeo--radio-group-target", "radio");
    root().append(added);
    added.click();
    radios()[0]?.setAttribute("aria-checked", "false");
    await tick();

    expect(added.getAttribute("aria-checked")).toBe("false");
    expect(field().value).toBe("basic");
  });

  it("does not steal focus after an ordinary focus departure and target removal", async () => {
    const outside = document.createElement("button");
    outside.type = "button";
    document.body.append(outside);
    radios()[1]?.click();
    radios()[1]?.focus();
    outside.focus();
    await tick();

    radios()[1]?.remove();
    await tick();

    expect(document.activeElement).toBe(outside);
    expect(tabindexes()).toEqual([0, -1]);
  });

  it("tracks the newest focused radio across queued focusout work", async () => {
    radios()[0]?.focus();
    radios()[1]?.focus();
    await tick();

    radios()[1]?.remove();
    await tick();

    expect(document.activeElement).toBe(radios()[1]);
    expect(tabindexes()).toEqual([-1, 0]);
  });

  it("repairs a target added and removed before its first reconciliation", async () => {
    const instance = application.controllers.find(
      (controller) => controller.identifier === "stimeo--radio-group",
    ) as RadioGroupController;
    const added = document.createElement("div");
    added.setAttribute("role", "radio");
    added.setAttribute("aria-checked", "false");
    added.setAttribute("tabindex", "0");
    added.setAttribute("data-stimeo--radio-group-target", "radio");
    root().append(added);

    instance.radioTargetConnected(added);
    expect(added.tabIndex).toBe(-1);
    added.focus();
    added.remove();
    instance.radioTargetDisconnected(added);
    await tick();

    expect(document.activeElement).toBe(radios()[0]);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("keeps DOM state inert after disconnect, then releases stale target ownership", async () => {
    const instance = application.controllers.find(
      (controller) => controller.identifier === "stimeo--radio-group",
    ) as RadioGroupController;
    const added = document.createElement("div");
    added.setAttribute("role", "radio");
    added.setAttribute("data-stimeo--radio-group-target", "radio");
    root().append(added);
    await tick();
    expect(added.getAttribute("aria-checked")).toBe("false");
    expect(added.getAttribute("tabindex")).toBe("-1");

    instance.disconnect();
    added.removeAttribute("data-stimeo--radio-group-target");
    await tick();
    expect(added.getAttribute("aria-checked")).toBe("false");
    expect(added.getAttribute("tabindex")).toBe("-1");

    instance.connect();
    expect(added.hasAttribute("aria-checked")).toBe(false);
    expect(added.hasAttribute("tabindex")).toBe(false);
  });

  it("prevents repeated Space from triggering a native button activation", async () => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.setAttribute("data-stimeo--radio-group-target", "radio");
    root().append(button);
    await tick();
    const repeated = new KeyboardEvent("keydown", {
      key: " ",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });

    expect(button.dispatchEvent(repeated)).toBe(false);
    expect(repeated.defaultPrevented).toBe(true);
    expect(button.getAttribute("aria-checked")).toBe("false");
  });

  it("safely consumes navigation when no radio can receive focus", async () => {
    for (const radio of radios()) radio.hidden = true;
    await tick();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });

    expect(radios()[0]?.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(tabindexes()).toEqual([-1, -1, -1]);
  });

  it("writes aria-checked only on radios whose state actually changes", async () => {
    const changed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) changed.push((record.target as HTMLElement).textContent ?? "");
    });
    observer.observe(root(), {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-checked"],
    });

    radios()[1]?.click();
    await tick();
    observer.disconnect();

    expect(changed.sort()).toEqual(["Basic", "Pro"]);
  });

  it("stops pointer and Space activation of an aria-disabled radio before its own listeners", () => {
    const disabled = radios()[1] as HTMLElement;
    disabled.setAttribute("aria-disabled", "true");
    const reached = vi.fn();
    disabled.addEventListener("click", reached);
    disabled.addEventListener("keydown", reached);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    expect(disabled.dispatchEvent(click)).toBe(false);
    expect(disabled.dispatchEvent(space)).toBe(false);
    expect(reached).not.toHaveBeenCalled();
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("consumes Space on an aria-disabled radio when only its per-radio action resolves the key", () => {
    // The group's own listeners resolve no radio from a text-node target, so the
    // per-radio action is the only handler that acts on the key.
    const disabled = radios()[1] as HTMLElement;
    disabled.setAttribute("aria-disabled", "true");
    const text = disabled.firstChild;
    if (!(text instanceof Text)) throw new Error("Missing radio label text");
    const later = vi.fn();
    root().addEventListener("keydown", later);
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    text.dispatchEvent(space);

    expect(space.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("consumes Space so that selecting a radio does not scroll the page", () => {
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });

    expect(radios()[2]?.dispatchEvent(space)).toBe(false);
    expect(checkedValues()).toEqual(["false", "false", "true"]);
  });

  it("moves the Tab stop to a radio that receives focus without selecting it", () => {
    radios()[2]?.focus();

    expect(document.activeElement).toBe(radios()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(checkedValues()).toEqual(["true", "false", "false"]);
  });

  it("applies the key map through a per-radio action when the key never reaches the group", () => {
    radios()[0]?.addEventListener("keydown", (event) => event.stopPropagation());

    key(0, "ArrowDown");

    expect(checkedValues()).toEqual(["false", "true", "false"]);
    expect(document.activeElement).toBe(radios()[1]);
  });

  it("supplies a newly connected radio's checked state before the batch pass", async () => {
    const instance = application.controllers.find(
      (controller) => controller.identifier === "stimeo--radio-group",
    ) as RadioGroupController;
    const added = document.createElement("div");
    added.setAttribute("role", "radio");
    added.setAttribute("data-stimeo--radio-group-target", "radio");
    root().append(added);

    instance.radioTargetConnected(added);

    expect(added.getAttribute("aria-checked")).toBe("false");
    expect(added.tabIndex).toBe(-1);
    await tick();
    expect(added.getAttribute("aria-checked")).toBe("false");
  });

  it("reconciles an element that joins the group by gaining the radio target token", async () => {
    const joined = document.createElement("div");
    joined.setAttribute("role", "radio");
    joined.setAttribute("aria-checked", "true");
    joined.setAttribute("data-value", "joined");
    root().prepend(joined);
    await tick();

    joined.setAttribute("data-stimeo--radio-group-target", "radio");
    await tick();

    expect(checkedValues()).toEqual(["true", "false", "false", "false"]);
    expect(tabindexes()).toEqual([0, -1, -1, -1]);
    expect(field().value).toBe("joined");
  });

  it("repairs the group when the selected radio loses its target token in place", async () => {
    const events = captureStateEvents("stimeo--radio-group", ["change", "reconcile"]);

    radios()[0]?.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(tabindexes()).toEqual([0, -1]);
    expect(field().value).toBe("");
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { value: "", radio: null } },
    ]);
    events.stop();
  });

  it("mirrors the selection into the input left holding the field target token", async () => {
    const previous = field();
    const next = document.createElement("input");
    next.type = "hidden";
    next.value = "stale";
    root().append(next);
    await tick();
    next.setAttribute("data-stimeo--radio-group-target", "field");
    await tick();
    expect(next.value).toBe("stale");

    previous.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(next.value).toBe("basic");
  });

  it("hands a checked state a pass supplied to an author who writes it afterwards", async () => {
    const pro = radios()[1] as HTMLElement;
    pro.removeAttribute("aria-checked");
    await tick();
    expect(pro.getAttribute("aria-checked")).toBe("false");

    pro.setAttribute("aria-checked", "false");
    await tick();
    pro.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(pro.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps a tabindex an author writes after a morph pass settled the same value", async () => {
    const basic = radios()[0] as HTMLElement;
    radios()[1]?.click();
    await tick();
    root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await tick();

    basic.setAttribute("tabindex", "-1");
    await tick();
    basic.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(basic.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps an author's tabindex write that lands between a batch and its pass", async () => {
    const basic = radios()[0] as HTMLElement;
    radios()[1]?.click();
    basic.setAttribute("tabindex", "7");
    queueMicrotask(() => basic.setAttribute("tabindex", "-1"));
    await tick();

    basic.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(basic.getAttribute("tabindex")).toBe("-1");
  });

  it("still releases the defaults it supplied to a radio moved within the group", async () => {
    const moved = document.createElement("div");
    moved.setAttribute("role", "radio");
    moved.setAttribute("data-value", "moved");
    moved.setAttribute("data-stimeo--radio-group-target", "radio");
    root().append(moved);
    await tick();
    expect(moved.getAttribute("aria-checked")).toBe("false");
    expect(moved.getAttribute("tabindex")).toBe("-1");

    root().prepend(moved);
    await tick();
    moved.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(moved.hasAttribute("aria-checked")).toBe(false);
    expect(moved.hasAttribute("tabindex")).toBe(false);
  });

  it("restores an authored tabindex to a radio moved within the group", async () => {
    const basic = radios()[0] as HTMLElement;
    radios()[1]?.click();
    expect(basic.tabIndex).toBe(-1);

    radios()[2]?.after(basic);
    await tick();
    basic.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(basic.getAttribute("tabindex")).toBe("0");
  });

  it("announces role, name, and state in order", async () => {
    const before = await captureSpeech({ container: root(), steps: 4 });
    expect(before).toEqual([
      "radiogroup, Plan",
      "radio, Basic, checked, position 1, set size 3",
      "radio, Pro, not checked, position 2, set size 3",
      "radio, Max, not checked, position 3, set size 3",
      "end of radiogroup, Plan",
    ]);

    radios()[1]?.click();
    const after = await captureSpeech({ container: root(), steps: 4 });
    expect(after).toEqual([
      "radiogroup, Plan",
      "radio, Basic, not checked, position 1, set size 3",
      "radio, Pro, checked, position 2, set size 3",
      "radio, Max, not checked, position 3, set size 3",
      "end of radiogroup, Plan",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await expectNoA11yViolations(root());
  });
});

/**
 * With no radio preselected, the first radio is the (unchecked) Tab entry point.
 */
describe("RadioGroupController with no initial selection", () => {
  let application: Application;

  beforeEach(async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--radio-group" role="radiogroup" aria-label="Plan">
        <div role="radio" aria-checked="false" tabindex="-1" data-value="a"
             data-stimeo--radio-group-target="radio"
             data-action="keydown->stimeo--radio-group#onKeydown">A</div>
        <div role="radio" aria-checked="false" tabindex="-1" data-value="b"
             data-stimeo--radio-group-target="radio"
             data-action="keydown->stimeo--radio-group#onKeydown">B</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("makes the first radio tabbable without checking it", () => {
    const radios = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--radio-group-target='radio']"),
    );
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false"]);
  });

  it("selects without an optional field target", () => {
    const radios = Array.from(
      document.querySelectorAll<HTMLElement>("[data-stimeo--radio-group-target='radio']"),
    );

    radios[1]?.click();
    radios[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });
});

/** Initialization and host-shape contracts that need their own pre-connect fixtures. */
describe("RadioGroupController initialization and hosts", () => {
  let application: Application | undefined;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const start = async (content: string): Promise<void> => {
    document.body.innerHTML = `<div data-controller="stimeo--radio-group" role="radiogroup"
      aria-label="Plan">${content}</div>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
  };

  const item = (name: string, checked?: string, extra = ""): string => `<div role="radio"
    ${checked === undefined ? "" : `aria-checked="${checked}"`} tabindex="-1" data-value="${name}"
    data-stimeo--radio-group-target="radio" ${extra}>${name}</div>`;

  const instance = (): RadioGroupController => {
    const group = document.querySelector<HTMLElement>("[data-controller~='stimeo--radio-group']");
    const found =
      group && application?.getControllerForElementAndIdentifier(group, "stimeo--radio-group");
    if (!(found instanceof RadioGroupController)) throw new Error("Missing radio group controller");
    return found;
  };

  it("normalizes missing, invalid, and multiple checked states with first true winning", async () => {
    await start(
      `${item("missing")}${item("invalid", "mixed")}${item("first", "true")}${item("second", "true")}
       <input type="hidden" value="stale" data-stimeo--radio-group-target="field">`,
    );
    const radios = Array.from(document.querySelectorAll<HTMLElement>("[role='radio']"));
    const field = document.querySelector<HTMLInputElement>("input");

    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0, -1]);
    expect(field?.value).toBe("first");
  });

  it("uses a non-first preselected radio as the Tab entry point", async () => {
    await start(`${item("first", "false")}${item("second", "true")}${item("third", "false")}`);
    const radios = Array.from(document.querySelectorAll<HTMLElement>("[role='radio']"));
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("clears a stale field when the group starts without a selection", async () => {
    await start(
      `${item("first", "false")}${item("second", "false")}
       <input type="hidden" value="stale" data-stimeo--radio-group-target="field">`,
    );
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("");
  });

  it("does not emit native change during connect-time reflection", async () => {
    document.body.innerHTML = `<div data-controller="stimeo--radio-group" role="radiogroup"
      aria-label="Plan">${item("selected", "true")}
      <input type="hidden" data-stimeo--radio-group-target="field"></div>`;
    const changes: Event[] = [];
    const listener = (event: Event): void => {
      if (event.target instanceof HTMLInputElement) changes.push(event);
    };
    document.addEventListener("change", listener);
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
    document.removeEventListener("change", listener);

    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("selected");
    expect(changes).toEqual([]);
  });

  it("skips native-disabled buttons and buttons disabled by a fieldset", async () => {
    await start(`<fieldset disabled>
      <button type="button" role="radio" aria-checked="false" tabindex="0" data-value="disabled"
        data-stimeo--radio-group-target="radio">Disabled</button>
      </fieldset>
      <button type="button" role="radio" aria-checked="true" tabindex="-1" data-value="enabled"
        data-stimeo--radio-group-target="radio">Enabled</button>`);
    const radios = Array.from(document.querySelectorAll<HTMLElement>("[role='radio']"));

    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    radios[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(radios[1]);
  });

  it("takes the Tab stop away when a fieldset around the group disables it after connecting", async () => {
    document.body.innerHTML = `<fieldset id="outer"><div data-controller="stimeo--radio-group"
      role="radiogroup" aria-label="Plan">
      <button type="button" role="radio" aria-checked="true" tabindex="0" data-value="a"
        data-stimeo--radio-group-target="radio">A</button>
      <button type="button" role="radio" aria-checked="false" tabindex="-1" data-value="b"
        data-stimeo--radio-group-target="radio">B</button>
    </div></fieldset>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
    const radios = Array.from(document.querySelectorAll<HTMLElement>("[role='radio']"));
    const fieldset = document.getElementById("outer") as HTMLFieldSetElement;

    fieldset.disabled = true;
    await tick();
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1]);
    fieldset.disabled = false;
    await tick();
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1]);
  });

  it("does not apply native fieldset disabled semantics to generic radio hosts", async () => {
    await start(`<fieldset disabled>
      ${item("generic", "false")}
      </fieldset>
      ${item("selected", "true")}`);
    const radios = Array.from(document.querySelectorAll<HTMLElement>("[role='radio']"));

    radios[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(document.activeElement).toBe(radios[0]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("stands down on native interactive hosts with conflicting activation", async () => {
    await start(`<a href="/billing" role="radio" aria-checked="false" tabindex="0" data-value="link"
      data-stimeo--radio-group-target="radio">Billing</a>
      ${item("supported", "true")}`);
    const link = document.querySelector<HTMLAnchorElement>("a");
    const supported = document.querySelectorAll<HTMLElement>("[role='radio']")[1];

    link?.click();
    expect(link?.getAttribute("aria-checked")).toBe("false");
    expect(supported?.getAttribute("aria-checked")).toBe("true");
    expect(supported?.tabIndex).toBe(0);
  });

  it("restores owned defaults when an element leaves target ownership", async () => {
    await start(item("owned"));
    const radio = document.querySelector<HTMLElement>("[role='radio']");
    expect(radio?.getAttribute("aria-checked")).toBe("false");
    expect(radio?.tabIndex).toBe(0);

    radio?.click();
    await tick();

    radio?.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(radio?.hasAttribute("aria-checked")).toBe(false);
    expect(radio?.hasAttribute("tabindex")).toBe(true);
    expect(radio?.getAttribute("tabindex")).toBe("-1");
  });

  it("restores an externally replaced tabindex when target ownership ends", async () => {
    await start(item("morphed", "false"));
    const radio = document.querySelector<HTMLElement>("[role='radio']");
    radio?.setAttribute("tabindex", "5");
    await tick();

    radio?.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(radio?.getAttribute("tabindex")).toBe("5");
  });

  it("suppresses a button radio's native Enter activation before its own listeners", async () => {
    await start(`<button type="button" role="radio" aria-checked="true" data-value="a"
      data-stimeo--radio-group-target="radio">A</button>`);
    const button = document.querySelector<HTMLButtonElement>("button") as HTMLButtonElement;
    const reached = vi.fn();
    button.addEventListener("keydown", reached);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

    expect(button.dispatchEvent(enter)).toBe(false);
    expect(reached).not.toHaveBeenCalled();
  });

  it("leaves pointer, keyboard, and focus events alone once disconnected", async () => {
    await start(`${item("a", "true")}${item("b", "false", 'aria-disabled="true"')}
      <button type="button" role="radio" aria-checked="false" data-value="c"
        data-stimeo--radio-group-target="radio">c</button>`);
    const [a, b, c] = Array.from(document.querySelectorAll<HTMLElement>("[role='radio']"));
    instance().disconnect();

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const arrow = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    expect(b?.dispatchEvent(click)).toBe(true);
    expect(c?.dispatchEvent(enter)).toBe(true);
    expect(a?.dispatchEvent(arrow)).toBe(true);
    b?.focus();

    expect([a, b, c].map((radio) => radio?.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect([a, b, c].map((radio) => radio?.tabIndex)).toEqual([0, -1, -1]);
  });

  it("removes every delegated listener it adds when it disconnects", async () => {
    await start(item("a", "true"));
    const group = document.querySelector<HTMLElement>("[role='radiogroup']") as HTMLElement;
    instance().disconnect();
    const added = vi.spyOn(group, "addEventListener");
    const removed = vi.spyOn(group, "removeEventListener");

    instance().connect();
    // Listeners registered with an options object (the morph subscription) carry an
    // abort signal and are released by aborting it rather than by a removal.
    const delegated = added.mock.calls.filter(([, , options]) => typeof options !== "object");
    instance().disconnect();

    expect(new Set(delegated.map(([type]) => type))).toEqual(
      new Set(["click", "keydown", "focusin", "focusout"]),
    );
    for (const call of delegated) expect(removed).toHaveBeenCalledWith(...call);
  });

  it("mirrors the selection into an input that gains the field target token in place", async () => {
    await start(`${item("a", "true")}<input type="hidden" value="stale">`);
    const input = document.querySelector<HTMLInputElement>("input") as HTMLInputElement;

    input.setAttribute("data-stimeo--radio-group-target", "field");
    await tick();

    expect(input.value).toBe("a");
  });

  it("stands down on a radio whose host becomes a submit button", async () => {
    await start(`<button type="button" role="radio" data-value="a"
      data-stimeo--radio-group-target="radio">A</button>${item("b", "true")}`);
    const button = document.querySelector<HTMLButtonElement>("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.getAttribute("tabindex")).toBe("-1");

    button.setAttribute("type", "submit");
    await tick();
    expect(button.hasAttribute("aria-checked")).toBe(false);
    expect(button.hasAttribute("tabindex")).toBe(false);

    button.setAttribute("tabindex", "3");
    await tick();
    expect(button.getAttribute("tabindex")).toBe("3");
  });

  it("treats checked and tabindex writes made after connect as the author's", async () => {
    await start(`${item("a", "true")}<div role="radio" data-value="b"
      data-stimeo--radio-group-target="radio">b</div>`);
    const supplied = document.querySelectorAll<HTMLElement>("[role='radio']")[1] as HTMLElement;
    expect(supplied.getAttribute("aria-checked")).toBe("false");
    expect(supplied.getAttribute("tabindex")).toBe("-1");

    supplied.setAttribute("aria-checked", "false");
    supplied.setAttribute("tabindex", "-1");
    await tick();
    supplied.removeAttribute("data-stimeo--radio-group-target");
    await tick();

    expect(supplied.getAttribute("aria-checked")).toBe("false");
    expect(supplied.getAttribute("tabindex")).toBe("-1");
  });
});

/** Verifies settled-state comparisons and synchronous nested commits. */
describe("RadioGroupController settled reports", () => {
  let application: Application;
  const root = () =>
    document.querySelector<HTMLElement>('[data-controller="stimeo--radio-group"]') as HTMLElement;
  const items = () =>
    Array.from(root().querySelectorAll<HTMLElement>('[data-stimeo--radio-group-target="radio"]'));
  const act = (index: number) => {
    items()[index]?.click();
  };
  const write = (index: number) => {
    items().forEach((item, position) => {
      item.setAttribute("aria-checked", String(position === index));
    });
  };
  const submitted = () =>
    Array.from(root().querySelectorAll<HTMLInputElement>("input"))
      .map((field) => field.value)
      .join(",");
  const record = () => {
    const seen: string[] = [];
    for (const name of ["change", "reconcile"])
      root().addEventListener(`stimeo--radio-group:${name}`, (event) => {
        const detail = (event as CustomEvent<{ value: string }>).detail;
        seen.push(`${name}:${detail.value}`);
      });
    return seen;
  };
  beforeEach(async () => {
    document.body.innerHTML = `<div role="radiogroup" data-controller="stimeo--radio-group"><div role="radio" aria-checked="true" tabindex="0" data-value="a" data-stimeo--radio-group-target="radio" data-action="click->stimeo--radio-group#select">a</div><div role="radio" aria-checked="false" tabindex="-1" data-value="b" data-stimeo--radio-group-target="radio" data-action="click->stimeo--radio-group#select">b</div><div role="radio" aria-checked="false" tabindex="-1" data-value="c" data-stimeo--radio-group-target="radio" data-action="click->stimeo--radio-group#select">c</div><input type="hidden" data-stimeo--radio-group-target="field"></div>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
  });
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });
  it("retains authored tabindex ownership from a restored-focus subscriber", async () => {
    const focused = items()[1] as HTMLElement;
    const destination = items()[2] as HTMLElement;
    focused.focus();
    root().addEventListener("focusin", () => destination.setAttribute("tabindex", "5"));
    focused.remove();
    await tick();
    await tick();
    expect(destination.tabIndex).toBe(-1);
    destination.removeAttribute("data-stimeo--radio-group-target");
    await tick();
    expect(destination.getAttribute("tabindex")).toBe("5");
  });
  it("prepares the restored radio's tab stop before its focus subscriber runs", async () => {
    const removed = items()[1] as HTMLElement;
    const destination = items()[2] as HTMLElement;
    removed.focus();
    const duringFocus: number[][] = [];
    destination.addEventListener("focus", () => {
      duringFocus.push(items().map((item) => item.tabIndex));
    });
    removed.remove();
    await tick();
    expect(duringFocus).toEqual([[-1, 0]]);
    expect(document.activeElement).toBe(destination);
    expect(items().map((item) => item.tabIndex)).toEqual([-1, 0]);
  });
  it("consumes queued authored attributes before its own reconciliation writes", async () => {
    const added = document.createElement("div");
    added.setAttribute("data-stimeo--radio-group-target", "radio");
    root().append(added);
    const instance = application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--radio-group",
    ) as RadioGroupController;
    instance.radioTargetConnected(added);
    await tick();
    instance.fieldTargetConnected();
    added.setAttribute("aria-checked", "true");
    added.setAttribute("tabindex", "5");
    await tick();
    added.removeAttribute("data-stimeo--radio-group-target");
    await tick();
    expect(added.getAttribute("aria-checked")).toBe("false");
    expect(added.getAttribute("tabindex")).toBe("5");
  });
  it("observes an authored checked write inside restored focus", async () => {
    const focused = items()[1] as HTMLElement;
    const destination = items()[2] as HTMLElement;
    focused.focus();
    destination.addEventListener("focusin", () => destination.setAttribute("aria-checked", "true"));
    focused.remove();
    await tick();
    await tick();
    expect(document.activeElement).toBe(destination);
    expect(items().map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(submitted()).toBe("a");
  });
  it("drops outer writes and reports after focus commits another radio", async () => {
    const seen = record();
    const native: string[] = [];
    root().addEventListener("change", () => native.push(submitted()));
    const destination = items()[1] as HTMLElement;
    let spent = false;
    destination.addEventListener("focusin", () => {
      if (spent) return;
      spent = true;
      act(2);
    });
    items()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await tick();
    expect(seen).toEqual(["change:c"]);
    expect(native).toEqual(["c"]);
    expect(submitted()).toBe("c");
    expect(items().map((item) => item.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true",
    ]);
  });
  it("suppresses a replaced repair report after restored focus commits a radio", async () => {
    act(1);
    const removed = items()[1] as HTMLElement;
    const destination = items()[2] as HTMLElement;
    removed.focus();
    const seen = record();
    destination.addEventListener("focusin", () => act(0), { once: true });
    removed.remove();
    await tick();
    expect(seen).toEqual(["change:a"]);
    expect(submitted()).toBe("a");
  });
  it("includes an undelivered page write in the user's settled change", async () => {
    const seen = record();
    write(1);
    act(1);
    await tick();
    expect(seen).toEqual(["change:b"]);
    expect(submitted()).toBe("b");
  });
  it("publishes nothing when the action returns to the last settled selection", async () => {
    const seen = record();
    let native = 0;
    root().addEventListener("change", () => {
      native += 1;
    });
    write(1);
    act(0);
    await tick();
    expect(seen).toEqual([]);
    expect(native).toBe(0);
    expect(submitted()).toBe("a");
  });
  it("drops the outer report after a native subscriber commits a newer selection", async () => {
    const seen = record();
    let spent = false;
    root().addEventListener("change", () => {
      if (spent) return;
      spent = true;
      act(2);
    });
    act(1);
    await tick();
    expect(seen).toEqual(["change:c"]);
    expect(submitted()).toBe("c");
  });
  it("keeps the outer report when a native subscriber only reads the selection", async () => {
    const seen = record();
    const reads: string[] = [];
    root().addEventListener("change", () => reads.push(submitted()));
    act(1);
    await tick();
    expect(reads).toEqual(["b"]);
    expect(seen).toEqual(["change:b"]);
  });
  it("keeps the outer report when a native subscriber confirms the same selection", async () => {
    const seen = record();
    let spent = false;
    root().addEventListener("change", () => {
      if (spent) return;
      spent = true;
      act(1);
    });
    act(1);
    await tick();
    expect(seen).toEqual(["change:b"]);
    expect(submitted()).toBe("b");
  });
});

/** Explicit target calls share the DOM action while retaining their own provenance. */
describe("RadioGroupController target API", () => {
  let application: Application;
  const element = (id: string): HTMLElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing API fixture ${id}`);
    return found;
  };
  const instance = (): RadioGroupController =>
    application.getControllerForElementAndIdentifier(
      element("api-root"),
      "stimeo--radio-group",
    ) as RadioGroupController;
  beforeEach(async () => {
    document.body.innerHTML = `<button id="api-outside">Outside</button><div id="api-root" data-controller="stimeo--radio-group" role="radiogroup"><button type="button" id="api-a" data-stimeo--radio-group-target="radio" role="radio" tabindex="-1" aria-checked="false" data-value="a" data-action="click->stimeo--radio-group#select"><span>a</span></button><button type="button" id="api-b" data-stimeo--radio-group-target="radio" role="radio" tabindex="-1" aria-checked="false" data-value="b" data-action="click->stimeo--radio-group#select"><span>b</span></button><input type="hidden" data-stimeo--radio-group-target="field"></div>`;
    application = Application.start();
    application.register("stimeo--radio-group", RadioGroupController);
    await tick();
  });
  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("retains the existing DOM Event success as a positive control", () => {
    const reports: Array<{ reason?: string }> = [];
    element("api-root").addEventListener("stimeo--radio-group:change", (event) => {
      reports.push((event as CustomEvent<{ reason?: string }>).detail);
    });
    element("api-b").click();
    expect(element("api-b").getAttribute("aria-checked")).toBe("true");
    expect(reports).toHaveLength(1);
  });

  it.each([false, true])(
    "accepts an owned target or its descendant (%s) after an Event positive control",
    (descendant) => {
      const reports: Array<{ reason?: string }> = [];
      element("api-root").addEventListener("stimeo--radio-group:change", (event) => {
        reports.push((event as CustomEvent<{ reason?: string }>).detail);
      });
      element("api-b").click();
      expect(element("api-b").getAttribute("aria-checked")).toBe("true");
      expect(reports).toHaveLength(1);
      element("api-outside").focus();
      const target = descendant ? element("api-a").querySelector("span") : element("api-a");
      if (!(target instanceof HTMLElement)) throw new Error("Missing API descendant");
      instance().select(target);
      expect(element("api-a").getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(element("api-outside"));
      expect(reports.at(-1)?.reason).toBe("api");
      expect(reports[0]?.reason).toBe("user");
    },
  );
  it.each(["foreign", "undeclared", "detached", "nested"])(
    "rejects %s targets through element and Event entry points before accepting an owned target",
    (kind) => {
      const reports: unknown[] = [];
      element("api-root").addEventListener("stimeo--radio-group:change", (event) => {
        reports.push((event as CustomEvent<unknown>).detail);
      });
      const invalid = element("api-b").cloneNode(true);
      if (!(invalid instanceof HTMLElement)) throw new Error("Missing cloned target");
      invalid.id = "api-invalid";
      invalid.removeAttribute("data-action");
      if (kind === "foreign") document.body.append(invalid);
      if (kind === "undeclared") {
        invalid.removeAttribute("data-stimeo--radio-group-target");
        element("api-root").append(invalid);
      }
      if (kind === "nested") {
        const nested = document.createElement("div");
        nested.setAttribute("data-controller", "stimeo--radio-group");
        nested.append(invalid);
        element("api-a").append(nested);
      }
      element("api-outside").focus();
      const before = element("api-root").innerHTML;
      instance().select(invalid);
      invalid.addEventListener("probe", (event) => instance().select(event));
      invalid.dispatchEvent(new Event("probe"));
      expect(element("api-root").innerHTML).toBe(before);
      expect(reports).toEqual([]);
      expect(document.activeElement).toBe(element("api-outside"));
      instance().select(element("api-b"));
      expect(element("api-b").getAttribute("aria-checked")).toBe("true");
      expect(reports).toHaveLength(1);
    },
  );

  it.each([
    ["focusin", "focus"],
    ["pointerenter", "pointer"],
    ["click", "user"],
  ])("retains %s Event provenance for an action bound on a target descendant", (type, reason) => {
    const reports: Array<{ reason: string }> = [];
    element("api-root").addEventListener("stimeo--radio-group:change", (event) => {
      reports.push((event as CustomEvent<{ reason: string }>).detail);
    });
    const child = element("api-b").querySelector("span");
    if (!(child instanceof HTMLElement)) throw new Error("Missing action descendant");
    child.addEventListener(type, (event) => instance().select(event));
    child.dispatchEvent(new Event(type));
    expect(element("api-b").getAttribute("aria-checked")).toBe("true");
    expect(reports.map((detail) => detail.reason)).toEqual([reason]);
  });

  it("rejects a nested origin even when the Event handler belongs to an owned outer target", () => {
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--radio-group");
    const child = document.createElement("span");
    child.setAttribute("data-stimeo--radio-group-target", "radio");
    nested.append(child);
    element("api-b").append(nested);
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--radio-group:change", reports);
    const before = element("api-root").innerHTML;
    element("api-b").addEventListener("probe", (event) => instance().select(event));
    child.dispatchEvent(new Event("probe", { bubbles: true }));
    expect(element("api-root").innerHTML).toBe(before);
    expect(reports).not.toHaveBeenCalled();
    instance().select(element("api-b"));
    expect(reports).toHaveBeenCalledOnce();
  });
  it("keeps native field publication ahead of a reentrant API report and discards the replaced outer report", async () => {
    const seen: string[] = [];
    const submitted = (): string =>
      element("api-root").querySelector<HTMLInputElement>("input")?.value ?? "";
    let reentered = false;
    element("api-root").addEventListener("change", () => {
      seen.push(`native:${submitted()}`);
      if (reentered) return;
      reentered = true;
      instance().select(element("api-a"));
    });
    element("api-root").addEventListener("stimeo--radio-group:change", (event) => {
      const detail = (event as CustomEvent<{ reason: string }>).detail;
      seen.push(`${detail.reason}:${submitted()}`);
    });
    element("api-b").click();
    await tick();
    expect(seen).toEqual(["native:b", "native:a", "api:a"]);
    expect(submitted()).toBe("a");
  });
  it("rejects an unmarked API descendant of a nested controller even when its nearest radio is owned", () => {
    const nested = document.createElement("div");
    nested.setAttribute("data-controller", "stimeo--radio-group");
    const child = document.createElement("span");
    nested.append(child);
    element("api-b").append(nested);
    const reports = vi.fn();
    element("api-root").addEventListener("stimeo--radio-group:change", reports);
    const before = element("api-root").innerHTML;
    instance().select(child);
    expect(element("api-root").innerHTML).toBe(before);
    expect(reports).not.toHaveBeenCalled();
    instance().select(element("api-b"));
    expect(element("api-b").getAttribute("aria-checked")).toBe("true");
    expect(reports).toHaveBeenCalledOnce();
  });
});
