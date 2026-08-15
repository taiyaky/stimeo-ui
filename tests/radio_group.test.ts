import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RadioGroupController } from "../src/controllers/radio_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link RadioGroupController}: the APG Radio Group contract
 * for custom radios — single selection via `aria-checked`, roving `tabindex`,
 * arrow navigation with selection-follows-focus, and the hidden-field mirror.
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

    expect(changes).toEqual([{ value: "pro", radio: radios()[1] }]);
    expect(repairs).toEqual([]);
  });

  it("silently reconciles retained radio state and submitted values after a morph", async () => {
    const customChanges: CustomEvent[] = [];
    const nativeChanges: Event[] = [];
    root().addEventListener("stimeo--radio-group:change", (event) => {
      customChanges.push(event as CustomEvent);
    });
    field().addEventListener("change", (event) => nativeChanges.push(event));

    radios()[0]?.setAttribute("aria-checked", "false");
    radios()[2]?.setAttribute("aria-checked", "true");
    await tick();

    expect(checkedValues()).toEqual(["false", "false", "true"]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(field().value).toBe("max");

    radios()[2]?.setAttribute("data-value", "ultimate");
    await tick();
    expect(field().value).toBe("ultimate");
    expect(customChanges).toEqual([]);
    expect(nativeChanges).toEqual([]);
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
});
