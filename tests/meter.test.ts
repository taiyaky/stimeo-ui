import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MeterController } from "../src/controllers/meter_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link MeterController}: ARIA value-attribute sync, the
 * `--stimeo-meter-ratio`, threshold-based `data-state` segmentation, the
 * `aria-valuetext` template, and the change event.
 */

describe("MeterController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--meter" role="meter" aria-label="Disk usage"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" ${attrs}
           data-action="meter:set->stimeo--meter#setValue">
        <div data-stimeo--meter-target="bar"></div>
      </div>`;
    application = Application.start();
    application.register("stimeo--meter", MeterController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--meter']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(root(), "stimeo--meter") as MeterController;

  it("reflects the initial value onto ARIA and the ratio", async () => {
    await start('data-stimeo--meter-value-value="72"');
    expect(root().getAttribute("aria-valuenow")).toBe("72");
    expect(root().style.getPropertyValue("--stimeo-meter-ratio")).toBe("0.72");
  });

  it("classifies values into low/medium/high by threshold", async () => {
    await start(
      'data-stimeo--meter-value-value="30" data-stimeo--meter-low-value="50" data-stimeo--meter-high-value="80"',
    );
    expect(root().getAttribute("data-state")).toBe("low");
    // Action-param amounts can arrive as strings (`data-...-amount-param`).
    instance().setValue({ params: { amount: "65" } } as unknown as Event);
    expect(root().getAttribute("data-state")).toBe("medium");
    instance().setValue({ params: { amount: "90" } } as unknown as Event);
    expect(root().getAttribute("data-state")).toBe("high");
  });

  // The segment edges are inclusive on both sides, so the values *equal* to a
  // threshold are the only ones that separate `<=`/`>=` from `<`/`>`; the
  // neighbouring values pin that the segment still changes one step away.
  it("treats the threshold edges as inclusive", async () => {
    await start(
      'data-stimeo--meter-low-value="50" data-stimeo--meter-high-value="80" data-stimeo--meter-value-value="0"',
    );
    const stateAt = (value: number) => {
      instance().setValue({ params: { amount: value } } as unknown as Event);
      return root().getAttribute("data-state");
    };
    expect(stateAt(50)).toBe("low");
    expect(stateAt(51)).toBe("medium");
    expect(stateAt(79)).toBe("medium");
    expect(stateAt(80)).toBe("high");
  });

  it("is medium everywhere when no thresholds are set", async () => {
    await start('data-stimeo--meter-value-value="10"');
    expect(root().getAttribute("data-state")).toBe("medium");
  });

  it("honors custom min/max when normalizing the ratio", async () => {
    await start(
      'data-stimeo--meter-min-value="200" data-stimeo--meter-max-value="400" data-stimeo--meter-value-value="300"',
    );
    expect(root().getAttribute("aria-valuenow")).toBe("300");
    expect(root().getAttribute("aria-valuemin")).toBe("200");
    expect(root().getAttribute("aria-valuemax")).toBe("400");
    expect(root().style.getPropertyValue("--stimeo-meter-ratio")).toBe("0.5");
  });

  // An empty range would divide by zero. The template is part of the assertion
  // because a `NaN` ratio reaches assistive tech verbatim through `aria-valuetext`.
  it("keeps the ratio at 0 when the range is empty", async () => {
    await start(
      'data-stimeo--meter-min-value="50" data-stimeo--meter-max-value="50" data-stimeo--meter-value-value="50" data-stimeo--meter-value-text-value="{percent}% ({state})"',
    );
    expect(root().style.getPropertyValue("--stimeo-meter-ratio")).toBe("0");
    expect(root().getAttribute("aria-valuetext")).toBe("0% (medium)");
  });

  it("keeps the ratio at 0 when min is greater than max", async () => {
    await start(
      'data-stimeo--meter-min-value="80" data-stimeo--meter-max-value="20" data-stimeo--meter-value-value="50"',
    );
    expect(root().style.getPropertyValue("--stimeo-meter-ratio")).toBe("0");
  });

  it("dispatches change with value, ratio, and state", async () => {
    await start('data-stimeo--meter-high-value="80"');
    let detail: { value: number; ratio: number; state: string } | null = null;
    root().addEventListener("stimeo--meter:change", (event) => {
      detail = (event as CustomEvent<{ value: number; ratio: number; state: string }>).detail;
    });
    root().dispatchEvent(new CustomEvent("meter:set", { detail: { value: 90 } }));
    expect(detail).toEqual({ value: 90, ratio: 0.9, state: "high" });
  });

  // A single event can carry both forms; the action param is the more specific
  // one (it is authored on the element that handles the action), so it wins.
  it("prefers the action-param amount over the event detail value", async () => {
    await start('data-stimeo--meter-value-value="0"');
    instance().setValue({
      params: { amount: 30 },
      detail: { value: 90 },
    } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("30");
  });

  // All three tokens go through the same `replaceAll` chain, but each is a
  // separate call: dropping one leaves the raw `{token}` in what AT announces.
  // Ownership is asserted here because the take-back below depends on it.
  it("fills aria-valuetext from the template including the segment", async () => {
    await start(
      'data-stimeo--meter-value-value="72" data-stimeo--meter-high-value="80" data-stimeo--meter-value-text-value="{value} units, {percent}% ({state})"',
    );
    expect(root().getAttribute("aria-valuetext")).toBe("72 units, 72% (medium)");
    expect(root().hasAttribute("data-stimeo--meter-owns-valuetext")).toBe(true);
  });

  // `aria-valuetext` is shared: a consumer may author it instead of giving a
  // template, and that text is then the only one carrying the segment to readers
  // who cannot see the colour, so a render must not take it away.
  it("keeps a consumer-authored aria-valuetext when no template is given", async () => {
    await start('data-stimeo--meter-value-value="72" aria-valuetext="72 GB of 100 GB used"');
    expect(root().getAttribute("aria-valuetext")).toBe("72 GB of 100 GB used");
    expect(root().hasAttribute("data-stimeo--meter-owns-valuetext")).toBe(false);
    instance().setValue({ params: { amount: 90 } } as unknown as Event);
    expect(root().getAttribute("aria-valuetext")).toBe("72 GB of 100 GB used");
  });

  // The other side of the same rule: a text this controller derived from a value
  // would announce a stale reading once its template is gone, so it is taken back.
  it("clears its own aria-valuetext when the template is removed", async () => {
    await start(
      'data-stimeo--meter-value-value="72" data-stimeo--meter-value-text-value="{percent}%"',
    );
    expect(root().getAttribute("aria-valuetext")).toBe("72%");
    root().removeAttribute("data-stimeo--meter-value-text-value");
    instance().setValue({ params: { amount: 40 } } as unknown as Event);
    expect(root().hasAttribute("aria-valuetext")).toBe(false);
    expect(root().hasAttribute("data-stimeo--meter-owns-valuetext")).toBe(false);
  });

  it("clamps out-of-range values (including the string form)", async () => {
    await start('data-stimeo--meter-value-value="0"');
    instance().setValue({ params: { amount: 500 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("100");
    instance().setValue({ params: { amount: "-20" } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("0");
  });

  // An empty string is "no value", not `0`: coercing it would silently reset the
  // meter and, with thresholds present, move the segment as well.
  it("ignores missing, non-numeric, and empty updates", async () => {
    await start(
      'data-stimeo--meter-value-value="72" data-stimeo--meter-low-value="50" data-stimeo--meter-high-value="80"',
    );
    instance().setValue({ detail: {} } as unknown as Event);
    instance().setValue({ params: { amount: "abc" } } as unknown as Event);
    instance().setValue({ detail: { value: "" } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("72");
    expect(root().getAttribute("data-state")).toBe("medium");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start('data-stimeo--meter-value-value="72"');
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the meter role, name, and value", async () => {
    await start('data-stimeo--meter-value-value="72"');
    const spoken = await captureSpeech({ container: root(), steps: 0 });
    // Freeze the whole ordered array (not a name-only `toContain`): the meter role,
    // name, and value range are all the AT announces.
    expect(spoken).toEqual(["meter, Disk usage, min value 0, max value 100, 72"]);
  });

  it.each([
    ["value", "60", () => root().getAttribute("aria-valuenow"), "60"],
    ["min", "50", () => root().getAttribute("aria-valuemin"), "50"],
    ["max", "200", () => root().getAttribute("aria-valuemax"), "200"],
    ["low", "80", () => root().getAttribute("data-state"), "low"],
    ["high", "10", () => root().getAttribute("data-state"), "high"],
    ["value-text", "Almost full", () => root().getAttribute("aria-valuetext"), "Almost full"],
  ])("follows %s swapped in place by a morph", async (name, next, read, expected) => {
    // One Value per case: swapping several at once would let the repaint any single
    // callback triggers cover for the others.
    await start('data-stimeo--meter-value-value="40"');
    root().setAttribute(`data-stimeo--meter-${name}-value`, next);
    await tick();
    expect(read()).toBe(expected);
  });

  it("repaints once when a morph swaps several render inputs together", async () => {
    await start('data-stimeo--meter-value-value="40"');
    let repaints = 0;
    const style = root().style;
    const original = style.setProperty.bind(style);
    style.setProperty = (...args: Parameters<CSSStyleDeclaration["setProperty"]>) => {
      if (args[0] === "--stimeo-meter-ratio") repaints += 1;
      original(...args);
    };
    root().setAttribute("data-stimeo--meter-value-value", "60");
    root().setAttribute("data-stimeo--meter-min-value", "10");
    root().setAttribute("data-stimeo--meter-max-value", "110");
    await tick();
    expect(repaints).toBe(1);
  });
});
