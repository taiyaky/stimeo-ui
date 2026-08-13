import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ProgressController } from "../src/controllers/progress_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ProgressController}: ARIA value-attribute sync,
 * `--stimeo--progress-ratio`, the indeterminate state, and the change/complete
 * events.
 */

describe("ProgressController", () => {
  let application: Application;

  const start = async (attrs = "", inner = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--progress" role="progressbar" aria-label="Upload"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" ${attrs}
           data-action="progress:set->stimeo--progress#setValue">
        <div data-stimeo--progress-target="bar"></div>
        ${inner}
      </div>`;
    application = Application.start();
    application.register("stimeo--progress", ProgressController);
    await tick();
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--progress']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--progress",
    ) as ProgressController;

  it("reflects the initial value onto ARIA and the ratio on connect", async () => {
    await start('data-stimeo--progress-value-value="40"');
    expect(root().getAttribute("aria-valuenow")).toBe("40");
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("0.4");
    expect(root().getAttribute("data-state")).toBe("determinate");
  });

  // Pin the declared defaults: every other case supplies a value first, so a
  // changed `value` default would otherwise go unnoticed.
  it("starts from the declared default value when no value attribute is given", async () => {
    await start();
    expect(root().getAttribute("aria-valuenow")).toBe("0");
    expect(root().getAttribute("aria-valuemin")).toBe("0");
    expect(root().getAttribute("aria-valuemax")).toBe("100");
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("0");
    expect(root().getAttribute("data-state")).toBe("determinate");
  });

  it("updates the value from an event detail and syncs ARIA", async () => {
    await start();
    root().dispatchEvent(new CustomEvent("progress:set", { detail: { value: 25 } }));
    expect(root().getAttribute("aria-valuenow")).toBe("25");
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("0.25");
  });

  // Both bounds are read from the configured range, so the fixture uses a
  // non-zero `min`: a lower bound of `0` is indistinguishable from a hard-coded
  // one.
  it("clamps out-of-range values into [min, max]", async () => {
    await start('data-stimeo--progress-min-value="20" data-stimeo--progress-max-value="120"');
    instance().setValue({ params: { amount: 250 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("120");
    instance().setValue({ params: { amount: -10 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("20");
  });

  // Action params arrive as strings (`data-...-amount-param`); cover the string
  // form so a regression in the coercion path is caught.
  it("accepts a string action-param amount", async () => {
    await start();
    instance().setValue({ params: { amount: "60" } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("60");
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("0.6");
  });

  it("clamps an out-of-range initial value when computing the ratio", async () => {
    await start('data-stimeo--progress-value-value="250"');
    expect(root().getAttribute("aria-valuenow")).toBe("100");
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("1");
  });

  // A non-zero `min` is what pins the subtraction in `(value - min) / span`: with
  // `min = 0` the numerator is the raw value, so an implementation that forgot to
  // shift the origin would still land on the same ratio. `aria-valuetext` is
  // asserted alongside because the percentage assistive tech speaks is derived
  // from the same normalized ratio.
  it("honors custom min/max when normalizing the ratio", async () => {
    await start(
      'data-stimeo--progress-min-value="20" data-stimeo--progress-max-value="120" data-stimeo--progress-value-value="45" data-stimeo--progress-value-text-value="{percent}%"',
    );
    expect(root().getAttribute("aria-valuemin")).toBe("20");
    expect(root().getAttribute("aria-valuemax")).toBe("120");
    expect(root().getAttribute("aria-valuenow")).toBe("45");
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("0.25");
    expect(root().getAttribute("aria-valuetext")).toBe("25%");
  });

  // An empty range would divide by zero. `aria-valuetext` is asserted alongside
  // the ratio because a NaN percentage reaches assistive tech as spoken text.
  it("keeps the ratio at 0 when the range is empty", async () => {
    await start(
      'data-stimeo--progress-min-value="5" data-stimeo--progress-max-value="5" data-stimeo--progress-value-value="5" data-stimeo--progress-value-text-value="{percent}%"',
    );
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("0");
    expect(root().getAttribute("aria-valuetext")).toBe("0%");
  });

  // An inverted range divides by a negative span, which would report a full bar
  // for a clamped value.
  it("keeps the ratio at 0 when min is greater than max", async () => {
    await start(
      'data-stimeo--progress-min-value="80" data-stimeo--progress-max-value="20" data-stimeo--progress-value-value="50"',
    );
    expect(root().style.getPropertyValue("--stimeo--progress-ratio")).toBe("0");
  });

  it("dispatches change on every update with value and ratio", async () => {
    await start();
    let detail: { value: number; ratio: number } | null = null;
    root().addEventListener("stimeo--progress:change", (event) => {
      detail = (event as CustomEvent<{ value: number; ratio: number }>).detail;
    });
    instance().setValue({ params: { amount: 60 } } as unknown as Event);
    expect(detail).toEqual({ value: 60, ratio: 0.6 });
  });

  // Freeze the whole detail object, not just the fact that the event fired: the
  // reached value is part of the published contract, so a consumer reading
  // `detail.value` must keep working. A listener that never runs leaves `detail`
  // null, so this also pins the firing condition itself.
  it("carries the reached value in the complete detail", async () => {
    await start();
    let detail: { value: number } | null = null;
    root().addEventListener("stimeo--progress:complete", (event) => {
      detail = (event as CustomEvent<{ value: number }>).detail;
    });
    instance().setValue({ params: { amount: 100 } } as unknown as Event);
    expect(detail).toEqual({ value: 100 });
  });

  it("drops aria-valuenow in the indeterminate state", async () => {
    await start('data-stimeo--progress-indeterminate-value="true"');
    expect(root().hasAttribute("aria-valuenow")).toBe(false);
    expect(root().getAttribute("data-state")).toBe("indeterminate");
  });

  // Connecting with the attribute already present exercises Stimulus's
  // initialization callback, which `connect` would cover anyway. Toggling the
  // attribute after connect is the only case that isolates the value-changed
  // path, so cover both directions of the toggle.
  it("re-renders when the indeterminate flag is toggled after connect", async () => {
    await start(
      'data-stimeo--progress-value-value="40" data-stimeo--progress-value-text-value="{percent}% uploaded"',
    );
    expect(root().getAttribute("aria-valuenow")).toBe("40");
    expect(root().getAttribute("aria-valuetext")).toBe("40% uploaded");

    root().setAttribute("data-stimeo--progress-indeterminate-value", "true");
    await tick();
    expect(root().hasAttribute("aria-valuenow")).toBe(false);
    // `aria-valuetext` outranks `aria-valuenow` for assistive tech, so a left-over
    // one would announce the stale value that dropping `aria-valuenow` avoids.
    expect(root().hasAttribute("aria-valuetext")).toBe(false);
    expect(root().hasAttribute("data-stimeo--progress-owns-valuetext")).toBe(false);
    expect(root().getAttribute("data-state")).toBe("indeterminate");

    root().setAttribute("data-stimeo--progress-indeterminate-value", "false");
    await tick();
    expect(root().getAttribute("aria-valuenow")).toBe("40");
    expect(root().getAttribute("aria-valuetext")).toBe("40% uploaded");
    expect(root().getAttribute("data-state")).toBe("determinate");
  });

  it("leaving the indeterminate state via setValue restores aria-valuenow", async () => {
    await start('data-stimeo--progress-indeterminate-value="true"');
    instance().setValue({ detail: { value: 30 } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("30");
    expect(root().getAttribute("data-state")).toBe("determinate");
  });

  // Ownership is asserted alongside the text because the take-back below is only
  // possible if a controller-written value is distinguishable from an authored one.
  it("fills aria-valuetext from the template", async () => {
    await start(
      'data-stimeo--progress-value-value="40" data-stimeo--progress-value-text-value="{value} of 100 MB, {percent}% uploaded"',
    );
    expect(root().getAttribute("aria-valuetext")).toBe("40 of 100 MB, 40% uploaded");
    expect(root().hasAttribute("data-stimeo--progress-owns-valuetext")).toBe(true);
  });

  // `aria-valuetext` is shared: the consumer may author it instead of giving a
  // template, and that text stays theirs across renders — including the
  // indeterminate one, where only a controller-derived number would go stale.
  it("keeps a consumer-authored aria-valuetext through an indeterminate toggle", async () => {
    await start('data-stimeo--progress-value-value="40" aria-valuetext="Uploading photos"');
    expect(root().getAttribute("aria-valuetext")).toBe("Uploading photos");
    expect(root().hasAttribute("data-stimeo--progress-owns-valuetext")).toBe(false);

    root().setAttribute("data-stimeo--progress-indeterminate-value", "true");
    await tick();
    expect(root().getAttribute("aria-valuetext")).toBe("Uploading photos");
  });

  // The other side of the same rule: a text derived from a value would announce a
  // stale reading once its template is gone, so it is taken back.
  it("clears its own aria-valuetext when the template is removed", async () => {
    await start(
      'data-stimeo--progress-value-value="40" data-stimeo--progress-value-text-value="{percent}% uploaded"',
    );
    expect(root().getAttribute("aria-valuetext")).toBe("40% uploaded");
    root().removeAttribute("data-stimeo--progress-value-text-value");
    instance().setValue({ params: { amount: 60 } } as unknown as Event);
    expect(root().hasAttribute("aria-valuetext")).toBe(false);
    expect(root().hasAttribute("data-stimeo--progress-owns-valuetext")).toBe(false);
  });

  it("ignores missing and non-numeric updates", async () => {
    await start('data-stimeo--progress-value-value="40"');
    instance().setValue({ detail: {} } as unknown as Event);
    instance().setValue({ params: { amount: "abc" } } as unknown as Event);
    instance().setValue({ detail: { value: "" } } as unknown as Event);
    expect(root().getAttribute("aria-valuenow")).toBe("40");
  });

  it("has no machine-detectable a11y violations", async () => {
    await start('data-stimeo--progress-value-value="40"');
    await expectNoA11yViolations(document.body, { rules: { region: { enabled: false } } });
  });

  it("announces the progressbar role, name, and value", async () => {
    await start('data-stimeo--progress-value-value="40"');
    const spoken = await captureSpeech({ container: root(), steps: 0 });
    // Freeze the whole ordered array (not a name-only `toContain`): the progressbar
    // role, name, and value range are all the AT announces.
    expect(spoken).toEqual(["progressbar, Upload, max value 100, min value 0, current value 40%"]);
  });

  it.each([
    ["value", "60", () => root().getAttribute("aria-valuenow"), "60"],
    ["min", "20", () => root().getAttribute("aria-valuemin"), "20"],
    ["max", "200", () => root().getAttribute("aria-valuemax"), "200"],
    ["value-text", "Half way", () => root().getAttribute("aria-valuetext"), "Half way"],
    ["indeterminate", "true", () => root().getAttribute("data-state"), "indeterminate"],
  ])("follows %s swapped in place by a morph", async (name, next, read, expected) => {
    // One Value per case: swapping several at once would let the repaint any single
    // callback triggers cover for the others.
    await start('data-stimeo--progress-value-value="40"');
    root().setAttribute(`data-stimeo--progress-${name}-value`, next);
    await tick();
    expect(read()).toBe(expected);
  });

  it("repaints once when a morph swaps several render inputs together", async () => {
    await start('data-stimeo--progress-value-value="40"');
    let repaints = 0;
    const style = root().style;
    const original = style.setProperty.bind(style);
    style.setProperty = (...args: Parameters<CSSStyleDeclaration["setProperty"]>) => {
      if (args[0] === "--stimeo--progress-ratio") repaints += 1;
      original(...args);
    };
    root().setAttribute("data-stimeo--progress-value-value", "60");
    root().setAttribute("data-stimeo--progress-min-value", "10");
    root().setAttribute("data-stimeo--progress-max-value", "110");
    await tick();
    expect(repaints).toBe(1);
  });

  it("announces the completion once the consumer supplies wording", async () => {
    // The transition is what gets read out, not the running numbers.
    const seen: string[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await start(
        'data-stimeo--progress-value-value="0" data-stimeo--progress-announce-text-value="Upload complete ({percent}%)"',
      );
      root().dispatchEvent(new CustomEvent("progress:set", { detail: { value: 50 } }));
      expect(seen).toEqual([]); // still running: nothing to read
      root().dispatchEvent(new CustomEvent("progress:set", { detail: { value: 100 } }));
      expect(seen).toEqual(["Upload complete (100%)"]);
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
  });

  it("stays silent when no announcement wording is set", async () => {
    // The library ships no English strings, so announcing is opt-in.
    const seen: string[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await start('data-stimeo--progress-value-value="0"');
      root().dispatchEvent(new CustomEvent("progress:set", { detail: { value: 100 } }));
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
  });
});
