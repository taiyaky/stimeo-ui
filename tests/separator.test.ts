import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeparatorController } from "../src/controllers/separator_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { captureStateEvents, type StateEventCapture } from "./helpers/state_events";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SeparatorController}: the `separator` role
 * semantics for a decorative divider, plus the Window Splitter side of the
 * optional focusable/value-bearing variant — `aria-valuenow` sync and
 * arrow-key adjustment on the axis the orientation selects.
 */

describe("SeparatorController", () => {
  let application: Application;

  const start = async (markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--separator", SeparatorController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const separator = () => query("[data-controller='stimeo--separator']");
  const key = (k: string) =>
    separator().dispatchEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));

  describe("decorative", () => {
    beforeEach(async () => {
      await start(`
        <div data-controller="stimeo--separator"
             data-stimeo--separator-orientation-value="horizontal"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
    });

    it("adds role and aria-orientation", () => {
      expect(separator().getAttribute("role")).toBe("separator");
      expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    });

    it("is not focusable and ignores arrow keys", () => {
      expect(separator().hasAttribute("tabindex")).toBe(false);
      key("ArrowUp");
      expect(separator().hasAttribute("aria-valuenow")).toBe(false);
    });

    it("has no machine-detectable a11y violations", async () => {
      await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
    });
  });

  describe("focusable / value-bearing", () => {
    beforeEach(async () => {
      await start(`
        <div data-controller="stimeo--separator" role="separator" tabindex="0"
             aria-label="Resize sidebar" aria-orientation="vertical"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
             data-stimeo--separator-focusable-value="true"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
    });

    it("increases the value on ArrowRight (vertical orientation)", () => {
      key("ArrowRight");
      expect(separator().getAttribute("aria-valuenow")).toBe("51");
    });

    it("decreases the value on ArrowLeft", () => {
      key("ArrowLeft");
      expect(separator().getAttribute("aria-valuenow")).toBe("49");
    });

    it("ignores the cross-axis arrows for a vertical separator", () => {
      key("ArrowUp");
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });

    it("jumps to min/max on Home/End", () => {
      key("Home");
      expect(separator().getAttribute("aria-valuenow")).toBe("0");
      key("End");
      expect(separator().getAttribute("aria-valuenow")).toBe("100");
    });

    it("clamps at the bounds", () => {
      const changes = vi.fn();
      separator().addEventListener("stimeo--separator:change", changes);
      key("Home");
      changes.mockClear();
      key("ArrowLeft");
      expect(separator().getAttribute("aria-valuenow")).toBe("0");
      expect(changes).not.toHaveBeenCalled();
    });

    it("reports nothing for a key at the upper edge", () => {
      const changes = vi.fn();
      separator().addEventListener("stimeo--separator:change", changes);
      key("End");
      expect(changes).toHaveBeenCalledOnce();
      changes.mockClear();

      key("End");
      key("ArrowRight");

      expect(separator().getAttribute("aria-valuenow")).toBe("100");
      expect(changes).not.toHaveBeenCalled();
    });

    it("dispatches a change event with the new value", () => {
      let value: number | null = null;
      separator().addEventListener("stimeo--separator:change", (event) => {
        value = (event as CustomEvent<{ value: number }>).detail.value;
      });
      key("ArrowRight");
      expect(value).toBe(51);
    });

    it("leaves a modified arrow to the browser", () => {
      // A chorded arrow is the browser's (history back/forward and the like), so
      // the separator neither consumes the key nor moves its value.
      const chord = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        altKey: true,
        cancelable: true,
      });
      separator().dispatchEvent(chord);

      expect(chord.defaultPrevented).toBe(false);
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });

    it("prevents default on a handled key", () => {
      const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
      separator().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("respects a custom step", async () => {
      disconnectAndStopApplication(application);
      await start(`
        <div data-controller="stimeo--separator" role="separator" tabindex="0"
             aria-label="Resize" aria-orientation="vertical"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
             data-stimeo--separator-focusable-value="true"
             data-stimeo--separator-step-value="10"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
      key("ArrowRight");
      expect(separator().getAttribute("aria-valuenow")).toBe("60");
    });

    it("has no machine-detectable a11y violations", async () => {
      await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
    });

    it("announces the separator role, name, and value", async () => {
      const spoken = await captureSpeech({ container: separator(), steps: 0 });
      expect(spoken).toEqual([
        "separator, Resize sidebar, orientated vertically, max value 100, min value 0, 50",
      ]);
    });
  });

  describe("focusable / horizontal orientation", () => {
    beforeEach(async () => {
      await start(`
        <div data-controller="stimeo--separator" role="separator" tabindex="0"
             aria-label="Resize panel" aria-orientation="horizontal"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
             data-stimeo--separator-focusable-value="true"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
    });

    it("increases on ArrowUp and decreases on ArrowDown (vertical axis)", () => {
      key("ArrowUp");
      expect(separator().getAttribute("aria-valuenow")).toBe("51");
      key("ArrowDown");
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });

    it("ignores the cross-axis arrows for a horizontal separator", () => {
      key("ArrowRight");
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
    });
  });

  it("seeds default value bounds when the consumer omits them", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="separator"
           aria-label="Resize" aria-orientation="vertical"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    // connect() fills in min/max/now so arrow keys have a bounded range to clamp to.
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-valuenow")).toBe("0");

    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("1");
  });

  it("hydrates authored range state and restores every attribute on disconnect", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="presentation" tabindex="-1"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="20" aria-valuemax="80" aria-valuenow="50"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("role")).toBe("separator");
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().getAttribute("aria-valuemin")).toBe("20");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
    expect(separator().getAttribute("data-stimeo--separator-min-value")).toBe("20");
    expect(separator().getAttribute("data-stimeo--separator-max-value")).toBe("80");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("50");

    application.unload("stimeo--separator");

    expect(separator().getAttribute("role")).toBe("presentation");
    expect(separator().getAttribute("tabindex")).toBe("-1");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().getAttribute("aria-valuemin")).toBe("20");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
  });

  it("defaults the orientation when neither input spelling is authored", async () => {
    await start('<div data-controller="stimeo--separator"></div>');

    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("uses explicit Values as the canonical source for every rendered output", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="presentation" tabindex="-1"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="20" aria-valuemax="80" aria-valuenow="50"
           data-stimeo--separator-orientation-value="horizontal"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="10"
           data-stimeo--separator-max-value="90"
           data-stimeo--separator-value-value="30"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("role")).toBe("separator");
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("10");
    expect(separator().getAttribute("aria-valuemax")).toBe("90");
    expect(separator().getAttribute("aria-valuenow")).toBe("30");
  });

  it("writes keyboard changes back to the value Value", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="20"
           data-stimeo--separator-max-value="80"
           data-stimeo--separator-step-value="5"
           data-stimeo--separator-value-value="50"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    key("ArrowRight");

    expect(separator().getAttribute("aria-valuenow")).toBe("55");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("55");
  });

  it("reports batched runtime Value changes that move the value as one reconcile", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="0"
           data-stimeo--separator-max-value="100"
           data-stimeo--separator-value-value="50"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    const events = captureStateEvents("stimeo--separator", ["change", "reconcile"]);

    separator().setAttribute("data-stimeo--separator-orientation-value", "horizontal");
    separator().setAttribute("data-stimeo--separator-min-value", "10");
    separator().setAttribute("data-stimeo--separator-max-value", "40");
    separator().setAttribute("data-stimeo--separator-value-value", "90");
    await tick();

    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("10");
    expect(separator().getAttribute("aria-valuemax")).toBe("40");
    expect(separator().getAttribute("aria-valuenow")).toBe("40");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("90");
    expect(events.seen.map(({ name, detail }) => ({ name, detail }))).toEqual([
      { name: "reconcile", detail: { value: 40 } },
    ]);
    events.stop();
  });

  it("removes and restores focusable semantics when focusable changes", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="20"
           data-stimeo--separator-max-value="80"
           data-stimeo--separator-value-value="50"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    const events = captureStateEvents("stimeo--separator", ["change", "reconcile"]);
    separator().setAttribute("data-stimeo--separator-focusable-value", "false");
    await tick();

    expect(separator().hasAttribute("tabindex")).toBe(false);
    expect(separator().hasAttribute("aria-valuemin")).toBe(false);
    expect(separator().hasAttribute("aria-valuemax")).toBe(false);
    expect(separator().hasAttribute("aria-valuenow")).toBe(false);
    key("ArrowRight");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("50");

    separator().setAttribute("data-stimeo--separator-focusable-value", "true");
    await tick();

    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-valuemin")).toBe("20");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
    // Withdrawing and restoring the semantics leaves the value where it was.
    expect(events.seen).toEqual([]);
    events.stop();
  });

  it("normalizes invalid and inverted ranges for publishing, leaving the declaration as written", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="sideways"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="80"
           data-stimeo--separator-max-value="20"
           data-stimeo--separator-step-value="0"
           data-stimeo--separator-value-value="150"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("80");
    expect(separator().getAttribute("aria-valuemax")).toBe("80");
    expect(separator().getAttribute("aria-valuenow")).toBe("80");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("150");

    separator().setAttribute("data-stimeo--separator-min-value", "0");
    separator().setAttribute("data-stimeo--separator-max-value", "100");
    separator().setAttribute("data-stimeo--separator-value-value", "10");
    await tick();
    key("ArrowUp");
    expect(separator().getAttribute("aria-valuenow")).toBe("11");
  });

  it("uses finite defaults for non-finite Value inputs", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="NaN"
           data-stimeo--separator-max-value="Infinity"
           data-stimeo--separator-value-value="NaN"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-valuenow")).toBe("0");
    expect(separator().getAttribute("data-stimeo--separator-value-value")).toBe("NaN");
  });

  it("does not hydrate non-finite authored ARIA into Values", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           aria-valuemin="Infinity" aria-valuemax="-Infinity" aria-valuenow="Infinity"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("aria-valuemin")).toBe("0");
    expect(separator().getAttribute("aria-valuemax")).toBe("100");
    expect(separator().getAttribute("aria-valuenow")).toBe("0");
    expect(separator().hasAttribute("data-stimeo--separator-min-value")).toBe(false);
    expect(separator().hasAttribute("data-stimeo--separator-max-value")).toBe(false);
    expect(separator().hasAttribute("data-stimeo--separator-value-value")).toBe(false);
  });

  it("keeps off-grid finite endpoints reachable", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="0"
           data-stimeo--separator-max-value="94"
           data-stimeo--separator-step-value="10"
           data-stimeo--separator-value-value="94"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    key("ArrowLeft");
    expect(separator().getAttribute("aria-valuenow")).toBe("90");
    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("94");
  });

  it("returns managed attributes before Turbo caches the page", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="presentation" tabindex="-1"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="1" aria-valuemax="9" aria-valuenow="4"
           data-stimeo--separator-orientation-value="horizontal"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-min-value="10"
           data-stimeo--separator-max-value="90"
           data-stimeo--separator-value-value="30"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);

    expect(separator().getAttribute("role")).toBe("separator");
    expect(separator().getAttribute("tabindex")).toBe("0");
    expect(separator().getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator().getAttribute("aria-valuemin")).toBe("10");
    expect(separator().getAttribute("aria-valuemax")).toBe("90");
    expect(separator().getAttribute("aria-valuenow")).toBe("30");

    // A morph can queue a repaint immediately before Turbo snapshots the page.
    // The rewind must invalidate that pending pass as well as return the leases,
    // so the pass neither re-applies them nor reports the move it would have found.
    const events = captureStateEvents("stimeo--separator", ["change", "reconcile"]);
    separator().setAttribute("data-stimeo--separator-value-value", "40");
    document.dispatchEvent(new CustomEvent("turbo:before-cache"));
    await tick();

    expect(separator().getAttribute("role")).toBe("presentation");
    expect(separator().getAttribute("tabindex")).toBe("-1");
    expect(separator().getAttribute("aria-orientation")).toBe("vertical");
    expect(separator().getAttribute("aria-valuemin")).toBe("1");
    expect(separator().getAttribute("aria-valuemax")).toBe("9");
    expect(separator().getAttribute("aria-valuenow")).toBe("4");
    expect(events.seen).toEqual([]);
    events.stop();
  });

  it("keeps multiple separator instances independent", async () => {
    await start(`
      <div data-controller="stimeo--separator" aria-label="First"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-value-value="20"
           data-action="keydown->stimeo--separator#onKeydown"></div>
      <div data-controller="stimeo--separator" aria-label="Second"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="true"
           data-stimeo--separator-value-value="70"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    const separators = Array.from(
      document.querySelectorAll<HTMLElement>("[data-controller='stimeo--separator']"),
    );

    separators[1]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }),
    );

    expect(separators[0]?.getAttribute("aria-valuenow")).toBe("20");
    expect(separators[1]?.getAttribute("aria-valuenow")).toBe("71");
  });

  it("becomes inert after disconnect", async () => {
    await start(`
      <div data-controller="stimeo--separator" role="separator" tabindex="0"
           aria-label="Resize" aria-orientation="vertical"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"
           data-stimeo--separator-focusable-value="true"
           data-action="keydown->stimeo--separator#onKeydown"></div>`);
    application.unload("stimeo--separator");
    key("ArrowRight");
    expect(separator().getAttribute("aria-valuenow")).toBe("50");
  });

  // --- Page-driven reconciliation ---

  describe("page-driven reconciliation", () => {
    let events: StateEventCapture;

    const controller = () =>
      application.getControllerForElementAndIdentifier(
        separator(),
        "stimeo--separator",
      ) as SeparatorController;
    const declared = () => separator().getAttribute("data-stimeo--separator-value-value");
    const reports = () => events.seen.map(({ name, detail }) => ({ name, detail }));
    /** Writes `value` the way a morph does and delivers its callback directly. */
    const declare = async (value: string) => {
      separator().setAttribute("data-stimeo--separator-value-value", value);
      controller().valueValueChanged();
      await flushMicrotasks();
    };
    /** Flips `focusable` the way a morph does and delivers its callback directly. */
    const setFocusable = async (focusable: boolean) => {
      separator().setAttribute("data-stimeo--separator-focusable-value", String(focusable));
      controller().focusableValueChanged();
      await flushMicrotasks();
    };
    const splitter = (value: string, focusable = "true") => `
      <div data-controller="stimeo--separator" aria-label="Resize"
           data-stimeo--separator-orientation-value="vertical"
           data-stimeo--separator-focusable-value="${focusable}"
           data-stimeo--separator-min-value="0"
           data-stimeo--separator-max-value="100"
           data-stimeo--separator-step-value="10"
           data-stimeo--separator-value-value="${value}"
           data-action="keydown->stimeo--separator#onKeydown"></div>`;

    beforeEach(() => {
      events = captureStateEvents("stimeo--separator", ["change", "reconcile"]);
    });

    afterEach(() => {
      events.stop();
    });

    it("keeps an off-grid declaration on connect and publishes the snapped value silently", async () => {
      await start(splitter("47"));
      await tick();

      expect(declared()).toBe("47");
      expect(separator().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([]);
    });

    it("hydrates an undeclared value from authored ARIA without reporting", async () => {
      await start(`
        <div data-controller="stimeo--separator" aria-label="Resize"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="30"
             data-stimeo--separator-focusable-value="true"
             data-stimeo--separator-step-value="10"
             data-action="keydown->stimeo--separator#onKeydown"></div>`);
      await tick();

      expect(declared()).toBe("30");
      expect(separator().getAttribute("aria-valuenow")).toBe("30");
      expect(reports()).toEqual([]);
    });

    it("reports a declaration that snaps to a new published value once as reconcile", async () => {
      await start(splitter("50"));

      await declare("67");

      expect(declared()).toBe("67");
      expect(separator().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 70 } }]);
    });

    it("reports a move once, so a later pass that finds the same value stays silent", async () => {
      await start(splitter("50"));

      await declare("70");
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 70 } }]);
    });

    it("takes a new baseline silently when it connects again after the declaration moved", async () => {
      await start(splitter("50"));

      controller().disconnect();
      separator().setAttribute("data-stimeo--separator-value-value", "70");
      controller().connect();
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(separator().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([]);
    });

    it("stays silent when a page change leaves the published value where it was", async () => {
      await start(splitter("50"));

      // 52 snaps back onto 50, and a lower maximum still contains it.
      await declare("52");
      separator().setAttribute("data-stimeo--separator-max-value", "90");
      controller().maxValueChanged();
      await flushMicrotasks();

      expect(separator().getAttribute("aria-valuenow")).toBe("50");
      expect(separator().getAttribute("aria-valuemax")).toBe("90");
      expect(reports()).toEqual([]);
    });

    it("reports a key the user pressed as change only, and the pass its Value write starts stays silent", async () => {
      await start(splitter("50"));

      key("ArrowRight");
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(declared()).toBe("60");
      expect(reports()).toEqual([{ name: "change", detail: { value: 60 } }]);
    });

    it("steps from the published value when the declaration is off the grid", async () => {
      await start(splitter("47"));

      key("ArrowRight");

      expect(separator().getAttribute("aria-valuenow")).toBe("60");
      expect(declared()).toBe("60");
      expect(reports()).toEqual([{ name: "change", detail: { value: 60 } }]);
    });

    it("publishes no value, and so reports none, while it is decorative", async () => {
      await start(splitter("50", "false"));

      await declare("80");

      expect(separator().hasAttribute("aria-valuenow")).toBe(false);
      expect(reports()).toEqual([]);
    });

    it("reports a value that moved while decorative once it publishes again", async () => {
      await start(splitter("50"));

      await setFocusable(false);
      await declare("80");
      expect(reports()).toEqual([]);
      await setFocusable(true);

      expect(separator().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([{ name: "reconcile", detail: { value: 80 } }]);
    });

    it("publishes its first value silently when it becomes focusable after connecting decorative", async () => {
      await start(splitter("50", "false"));

      await declare("80");
      await setFocusable(true);

      expect(separator().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([]);
    });

    it("reports a move a reconcile subscriber makes on the next pass, from the new baseline", async () => {
      await start(splitter("50"));
      let redirected = false;
      separator().addEventListener("stimeo--separator:reconcile", () => {
        if (redirected) return;
        redirected = true;
        separator().setAttribute("data-stimeo--separator-value-value", "20");
        controller().valueValueChanged();
      });

      await declare("70");
      await tick();

      expect(separator().getAttribute("aria-valuenow")).toBe("20");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { value: 70 } },
        { name: "reconcile", detail: { value: 20 } },
      ]);
    });

    it("keeps the baseline in step when a change subscriber moves again synchronously", async () => {
      await start(splitter("50"));
      let again = true;
      // Registered after the capture, so the capture records each report before
      // this subscriber answers it.
      const moveAgain = (): void => {
        if (!again) return;
        again = false;
        key("ArrowRight");
      };
      document.addEventListener("stimeo--separator:change", moveAgain);

      key("ArrowRight");
      controller().valueValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--separator:change", moveAgain);

      expect(separator().getAttribute("aria-valuenow")).toBe("70");
      expect(reports()).toEqual([
        { name: "change", detail: { value: 60 } },
        { name: "change", detail: { value: 70 } },
      ]);
    });

    it("drops a pass queued before disconnect", async () => {
      await start(splitter("50"));

      separator().setAttribute("data-stimeo--separator-value-value", "70");
      controller().valueValueChanged();
      controller().disconnect();
      await flushMicrotasks();

      expect(reports()).toEqual([]);
    });

    it.each([
      ["a script writes the value just before the key", false],
      ["a keydown listener ahead of the separator writes the value", true],
    ] as const)(
      "reports a page write folded into a key once, as that key's change, when %s",
      async (_case, ahead) => {
        await start(splitter("50"));
        const write = (): void => {
          separator().setAttribute("data-stimeo--separator-value-value", "100");
        };
        const writeAhead = (event: Event): void => {
          if ((event as KeyboardEvent).key === "End") write();
        };
        if (ahead) document.addEventListener("keydown", writeAhead, true);
        else write();

        key("End");
        document.removeEventListener("keydown", writeAhead, true);
        controller().valueValueChanged();
        await flushMicrotasks();

        expect(separator().getAttribute("aria-valuenow")).toBe("100");
        expect(reports()).toEqual([{ name: "change", detail: { value: 100 } }]);
      },
    );

    it("reports nothing when a page write and a key in one task end on the value last published", async () => {
      await start(splitter("50"));

      separator().setAttribute("data-stimeo--separator-value-value", "60");
      key("ArrowLeft");
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(separator().getAttribute("aria-valuenow")).toBe("50");
      expect(reports()).toEqual([]);
    });

    it.each([
      ["an out-of-range declaration at the upper edge", "150", ["ArrowRight", "End"], "100"],
      ["an unreadable declaration at the lower edge", "abc", ["ArrowLeft", "Home"], "0"],
    ] as const)("reports nothing for a key on %s", async (_case, declaration, keys, published) => {
      await start(splitter(declaration));

      for (const name of keys) key(name);
      controller().valueValueChanged();
      await flushMicrotasks();

      expect(separator().getAttribute("aria-valuenow")).toBe(published);
      expect(reports()).toEqual([]);
    });

    it("keeps a key pressed inside a reconcile listener a change, and reports nothing after it", async () => {
      await start(splitter("50"));
      let spent = false;
      // Registered after the capture, so the recording keeps dispatch order.
      const pressOnce = (): void => {
        if (spent) return;
        spent = true;
        key("ArrowRight");
      };
      document.addEventListener("stimeo--separator:reconcile", pressOnce);

      await declare("70");
      controller().valueValueChanged();
      await flushMicrotasks();
      document.removeEventListener("stimeo--separator:reconcile", pressOnce);

      expect(separator().getAttribute("aria-valuenow")).toBe("80");
      expect(reports()).toEqual([
        { name: "reconcile", detail: { value: 70 } },
        { name: "change", detail: { value: 80 } },
      ]);
    });
  });
});
