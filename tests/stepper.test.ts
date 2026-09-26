import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { StepperController } from "../src/controllers/stepper_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link StepperController}: `next`/`prev`/`goto`
 * navigation, derived `data-state`/`aria-current`, out-of-range and `linear`
 * guards, the `change` event, and the `reconcile` event for a current step the
 * page moves.
 */

const markup = (attrs = "") => `
  <div data-controller="stimeo--stepper" ${attrs}>
    <ol>
      <li data-stimeo--stepper-target="step">
        <button data-stimeo--stepper-index-param="0"
                data-action="click->stimeo--stepper#goto">Account</button>
      </li>
      <li data-stimeo--stepper-target="step">
        <button data-stimeo--stepper-index-param="1"
                data-action="click->stimeo--stepper#goto">Profile</button>
      </li>
      <li data-stimeo--stepper-target="step">
        <button data-stimeo--stepper-index-param="2"
                data-action="click->stimeo--stepper#goto">Confirm</button>
      </li>
    </ol>
    <button id="previous" data-action="stimeo--stepper#prev">Previous</button>
    <button id="next" data-action="stimeo--stepper#next">Next</button>
  </div>`;

/** A stepper that records the `index` each `indexValueChanged` delivery sees. */
const countingStepper = (deliveries: string[]) =>
  class extends StepperController {
    override indexValueChanged(): void {
      deliveries.push(String(this.indexValue));
      super.indexValueChanged();
    }
  };

const INDEX_ATTR = "data-stimeo--stepper-index-value";

describe("StepperController", () => {
  let application: Application;

  const start = async (attrs = "", controller = StepperController) => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--stepper", controller);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--stepper']") as HTMLElement;
  const steps = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--stepper-target='step']"));
  const buttons = () => steps().map((step) => step.querySelector("button") as HTMLButtonElement);
  const states = () => steps().map((step) => step.dataset.state);
  const currents = () => buttons().map((button) => button.getAttribute("aria-current"));
  const indexAttr = () => root().getAttribute(INDEX_ATTR);

  /** Records the value the `index` attribute held before each write to it. */
  const recordIndexWrites = () => {
    const previousValues: Array<string | null> = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) previousValues.push(record.oldValue);
    });
    observer.observe(root(), {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [INDEX_ATTR],
    });
    return { previousValues, stop: () => observer.disconnect() };
  };

  type ChangeDetail = { index: number; previous: number; total: number; step: HTMLElement };
  const recordChanges = () => {
    const details: ChangeDetail[] = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      details.push((event as CustomEvent<ChangeDetail>).detail);
    });
    return details;
  };

  /** Every `change` and `reconcile` the root dispatches, in order, with its detail. */
  const recordReports = () => {
    const reports: Array<ChangeDetail & { type: string }> = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--stepper:${type}`, (event) => {
        reports.push({ type, ...(event as CustomEvent<ChangeDetail>).detail });
      });
    }
    return reports;
  };

  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--stepper",
    ) as StepperController;

  /** A step built the way a Turbo Stream or a morph inserts one. */
  const buildStep = (label: string) => {
    const step = document.createElement("li");
    step.setAttribute("data-stimeo--stepper-target", "step");
    const button = document.createElement("button");
    button.textContent = label;
    step.append(button);
    return step;
  };

  /**
   * Target callbacks are delivered unreliably under happy-dom, so the one Stimulus
   * makes for an inserted or removed step is made here directly as well.
   */
  const addStep = (label: string) => {
    const step = buildStep(label);
    root().querySelector("ol")?.append(step);
    controller().stepTargetConnected();
    return step;
  };
  const removeStep = (step: HTMLElement | undefined) => {
    step?.remove();
    controller().stepTargetDisconnected();
  };
  /** Inserts a step ahead of every other step, the way `addStep` appends one. */
  const prependStep = (label: string) => {
    const step = buildStep(label);
    root().querySelector("ol")?.prepend(step);
    controller().stepTargetConnected();
    return step;
  };

  it("derives data-state and aria-current from the initial index", async () => {
    await start();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  const previous = () => document.getElementById("previous") as HTMLButtonElement;
  const next = () => document.getElementById("next") as HTMLButtonElement;

  it("advances and retreats with next/prev, completing passed steps", async () => {
    await start();
    next().click();
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(currents()).toEqual([null, "step", null]);
    previous().click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
  });

  it("ignores moves past either end", async () => {
    await start();
    previous().click(); // already at the first step
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    next().click();
    next().click();
    next().click(); // already at the last step
    expect(states()).toEqual(["complete", "complete", "current"]);
  });

  it("clamps an out-of-range initial index for display, leaving the declaration as written", async () => {
    await start('data-stimeo--stepper-index-value="99"');
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
    expect(indexAttr()).toBe("99");
  });

  it("reflects an out-of-range index set at runtime without writing it back", async () => {
    // The Value is the page's input: the display clamps it, and the callback the
    // page's write delivers is the only one, because nothing is written in reply.
    const deliveries: string[] = [];
    await start('data-stimeo--stepper-index-value="0"', countingStepper(deliveries));
    const writes = recordIndexWrites();
    const changes = recordChanges();
    deliveries.length = 0;

    root().setAttribute(INDEX_ATTR, "99");
    await tick();
    writes.stop();

    expect(deliveries).toEqual(["99"]);
    expect(writes.previousValues).toEqual(["0"]);
    expect(indexAttr()).toBe("99");
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
    expect(changes).toEqual([]);
  });

  it("moves from the clamped step, writing the Value only for a move the user makes", async () => {
    await start('data-stimeo--stepper-index-value="99"');
    const changes = recordChanges();

    next().click(); // the last step is already the one shown
    expect(changes).toEqual([]);
    expect(indexAttr()).toBe("99");

    previous().click();
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(changes).toEqual([{ index: 1, previous: 2, total: 3, step: steps()[1] }]);
    expect(indexAttr()).toBe("1");
  });

  it.each([
    { declared: "-1", index: 1, previous: 0 },
    { declared: "NaN", index: 1, previous: 0 },
    { declared: "1.9", index: 2, previous: 1 },
  ])(
    "advances from the step a declared $declared is clamped to",
    async ({ declared, index, previous }) => {
      // `next` counts from the step on screen, not from the declaration: one past a
      // raw -1 or NaN is no step at all, and one past 1.9 is not an integer.
      await start(`data-stimeo--stepper-index-value="${declared}"`);
      const changes = recordChanges();

      next().click();

      expect(changes).toEqual([{ index, previous, total: 3, step: steps()[index] }]);
      expect(indexAttr()).toBe(String(index));
    },
  );

  it("goto jumps to a step via its index param", async () => {
    await start();
    buttons()[2]?.click();
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
  });

  it("rejects a fractional goto param instead of rendering no current step", async () => {
    await start();
    buttons()[1]?.setAttribute("data-stimeo--stepper-index-param", "1.5");
    buttons()[1]?.click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  it("ignores goto when the index param is missing or not numeric", async () => {
    await start();
    buttons()[1]?.removeAttribute("data-stimeo--stepper-index-param");
    buttons()[1]?.click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);

    buttons()[2]?.setAttribute("data-stimeo--stepper-index-param", "abc");
    buttons()[2]?.click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  it("ignores goto when the index param is empty", async () => {
    await start();
    buttons()[1]?.click();
    buttons()[0]?.setAttribute("data-stimeo--stepper-index-param", "");
    buttons()[0]?.click();
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(currents()).toEqual([null, "step", null]);
  });

  // Stimulus parses a param as JSON, so these arrive as a boolean, null and an
  // array — values `Number()` would turn into step 0 or 1.
  it.each(["true", "false", "null", "[1]"])(
    "ignores goto when the index param reads as the JSON literal %s",
    async (literal) => {
      await start();
      buttons()[2]?.click();
      buttons()[0]?.setAttribute("data-stimeo--stepper-index-param", literal);
      buttons()[0]?.click();
      expect(states()).toEqual(["complete", "complete", "current"]);
      expect(currents()).toEqual([null, null, "step"]);
    },
  );

  it("clamps non-finite, fractional, and negative initial indexes for display only", async () => {
    await start('data-stimeo--stepper-index-value="NaN"');
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(indexAttr()).toBe("NaN");

    disconnectAndStopApplication(application);
    await start('data-stimeo--stepper-index-value="1.9"');
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    expect(indexAttr()).toBe("1.9");

    disconnectAndStopApplication(application);
    await start('data-stimeo--stepper-index-value="-1"');
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(indexAttr()).toBe("-1");
  });

  it("re-renders when the index value changes at runtime", async () => {
    await start();
    const changes: CustomEvent[] = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      changes.push(event as CustomEvent);
    });
    root().setAttribute("data-stimeo--stepper-index-value", "2");
    await tick();
    expect(states()).toEqual(["complete", "complete", "current"]);
    expect(currents()).toEqual([null, null, "step"]);
    // A re-derivation from a Value write is not a move: `change` must not fire.
    expect(changes).toEqual([]);
  });

  it("reports an index the page writes as reconcile, never as change", async () => {
    await start();
    const reports = recordReports();

    root().setAttribute(INDEX_ATTR, "2");
    await tick();

    expect(reports).toEqual([
      { type: "reconcile", index: 2, previous: 0, total: 3, step: steps()[2] },
    ]);
  });

  it("measures each page move from the step the one before it showed", async () => {
    await start();
    const reports = recordReports();

    root().setAttribute(INDEX_ATTR, "2");
    await tick();
    root().setAttribute(INDEX_ATTR, "1");
    await tick();
    root().setAttribute(INDEX_ATTR, "1.5");
    await tick();

    expect(reports).toEqual([
      { type: "reconcile", index: 2, previous: 0, total: 3, step: steps()[2] },
      { type: "reconcile", index: 1, previous: 2, total: 3, step: steps()[1] },
    ]);
  });

  it("follows a removed current step and reports the step it clamps to", async () => {
    await start('data-stimeo--stepper-index-value="2"');
    const reports = recordReports();

    removeStep(steps()[2]);
    await tick();

    expect(states()).toEqual(["complete", "current"]);
    expect(currents()).toEqual([null, "step"]);
    expect(indexAttr()).toBe("2");
    expect(reports).toEqual([
      { type: "reconcile", index: 1, previous: 2, total: 2, step: steps()[1] },
    ]);
  });

  it("gives the declared step back once added steps reach it", async () => {
    await start('data-stimeo--stepper-index-value="5"');
    const reports = recordReports();

    const added = addStep("Done");
    await tick();

    expect(states()).toEqual(["complete", "complete", "complete", "current"]);
    expect(reports).toEqual([{ type: "reconcile", index: 3, previous: 2, total: 4, step: added }]);
  });

  it("reports nothing while the position stays, whichever step stands there", async () => {
    await start('data-stimeo--stepper-index-value="1"');
    const reports = recordReports();
    const [first, second] = steps();

    // A step added ahead of the current one puts another step at position 1.
    prependStep("Intro");
    await tick();
    expect(steps()[1]).toBe(first);
    expect(states()).toEqual(["complete", "current", "upcoming", "upcoming"]);
    expect(currents()).toEqual([null, "step", null, null]);

    // Removing the current step brings the next one to the same position.
    removeStep(steps()[1]);
    await tick();
    expect(steps()[1]).toBe(second);
    expect(states()).toEqual(["complete", "current", "upcoming"]);

    expect(reports).toEqual([]);
  });

  it("reports a position that moves even when the same step stays current", async () => {
    await start('data-stimeo--stepper-index-value="2"');
    const reports = recordReports();
    const last = steps()[2];

    // Removing the first step clamps the declared 2 to position 1, where the same
    // step still stands.
    removeStep(steps()[0]);
    await tick();

    expect(steps()[1]).toBe(last);
    expect(currents()).toEqual([null, "step"]);
    expect(reports).toEqual([{ type: "reconcile", index: 1, previous: 2, total: 2, step: last }]);
  });

  it("derives the state of an added step without reporting a step that stayed", async () => {
    await start('data-stimeo--stepper-index-value="1"');
    const reports = recordReports();

    addStep("Done");
    await tick();
    root().setAttribute(INDEX_ATTR, "1.5");
    await tick();

    expect(states()).toEqual(["complete", "current", "upcoming", "upcoming"]);
    expect(reports).toEqual([]);
  });

  it("reports one batch that moves the index and the steps together once", async () => {
    await start();
    const reports = recordReports();

    root().setAttribute(INDEX_ATTR, "3");
    const added = addStep("Done");
    await tick();

    expect(currents()).toEqual([null, null, null, "step"]);
    expect(reports).toEqual([{ type: "reconcile", index: 3, previous: 0, total: 4, step: added }]);
  });

  it("keeps the step it showed while no step is left, and measures from it when steps return", async () => {
    await start('data-stimeo--stepper-index-value="2"');
    const reports = recordReports();

    for (const step of steps()) removeStep(step);
    await tick();
    expect(reports).toEqual([]);

    addStep("Account");
    const second = addStep("Profile");
    await tick();

    expect(currents()).toEqual([null, "step"]);
    expect(reports).toEqual([{ type: "reconcile", index: 1, previous: 2, total: 2, step: second }]);
  });

  it("starts from the first steps a stepper connected without, silently", async () => {
    await start('data-stimeo--stepper-index-value="1"');
    for (const step of steps()) step.remove();
    disconnectAndStopApplication(application);
    application = Application.start();
    application.register("stimeo--stepper", StepperController);
    await tick();
    const reports = recordReports();

    addStep("Account");
    addStep("Profile");
    await tick();

    expect(states()).toEqual(["complete", "current"]);
    expect(reports).toEqual([]);
  });

  it("reports nothing on connect, whatever the declaration clamps to", async () => {
    document.body.innerHTML = markup('data-stimeo--stepper-index-value="99"');
    const reports: string[] = [];
    const listening = new AbortController();
    for (const type of ["change", "reconcile"]) {
      document.addEventListener(`stimeo--stepper:${type}`, () => reports.push(type), {
        signal: listening.signal,
      });
    }
    application = Application.start();
    application.register("stimeo--stepper", StepperController);
    await tick();
    listening.abort();

    expect(currents()).toEqual([null, null, "step"]);
    expect(reports).toEqual([]);
  });

  it("reports a move as change alone, and nothing for its own Value write", async () => {
    await start();
    const reports = recordReports();

    next().click();
    await tick();

    expect(reports).toEqual([
      { type: "change", index: 1, previous: 0, total: 3, step: steps()[1] },
    ]);
  });

  it("measures a move a reconcile listener makes from the reported step", async () => {
    await start();
    const reports = recordReports();
    let answered = false;
    root().addEventListener("stimeo--stepper:reconcile", () => {
      if (answered) return;
      answered = true;
      next().click();
    });

    root().setAttribute(INDEX_ATTR, "1");
    await tick();

    expect(currents()).toEqual([null, null, "step"]);
    expect(indexAttr()).toBe("2");
    expect(reports).toEqual([
      { type: "reconcile", index: 1, previous: 0, total: 3, step: steps()[1] },
      { type: "change", index: 2, previous: 1, total: 3, step: steps()[2] },
    ]);
  });

  it("drops a pass still pending when it disconnects", async () => {
    await start();
    const reports = recordReports();

    root().setAttribute(INDEX_ATTR, "2");
    controller().indexValueChanged();
    controller().disconnect();
    await flushMicrotasks();

    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(reports).toEqual([]);
  });

  it("blocks skipping ahead under linear (but allows going back)", async () => {
    await start('data-stimeo--stepper-linear-value="true"');
    buttons()[2]?.click(); // skip from 0 to 2 is blocked
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    buttons()[1]?.click(); // one step ahead is allowed
    expect(states()).toEqual(["complete", "current", "upcoming"]);
    buttons()[0]?.click(); // going back is always allowed
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
  });

  it("dispatches change with index, previous, total, and the step element", async () => {
    await start();
    type Detail = { index: number; previous: number; total: number; step: HTMLElement };
    const details: Detail[] = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      details.push((event as CustomEvent<Detail>).detail);
    });
    buttons()[1]?.click();
    expect(details).toEqual([{ index: 1, previous: 0, total: 3, step: steps()[1] }]);
  });

  it("does not dispatch change for no-op or blocked moves", async () => {
    await start('data-stimeo--stepper-linear-value="true"');
    const changes: CustomEvent[] = [];
    root().addEventListener("stimeo--stepper:change", (event) => {
      changes.push(event as CustomEvent);
    });

    buttons()[0]?.click(); // already current
    previous().click(); // before the first step
    buttons()[2]?.click(); // blocked by linear mode
    expect(changes).toEqual([]);
  });

  it("becomes inert after the Stimulus binding is unloaded", async () => {
    await start();
    application.unload("stimeo--stepper");
    next().click();
    expect(states()).toEqual(["current", "upcoming", "upcoming"]);
    expect(currents()).toEqual(["step", null, null]);
  });

  it("announces the current step on its button", async () => {
    await start();
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual([
      "list",
      "listitem, level 1, position 1, set size 3",
      "button, Account, current step",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });
});
