import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RatingController } from "../src/controllers/rating_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureFieldCommits } from "./helpers/field_commits";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link RatingController}: DOM-ordered ordinal values,
 * APG Radio Group state, roving focus, preview, readonly ownership, dynamic
 * reconciliation, exact events, and Turbo-safe teardown.
 */

interface FixtureOptions {
  count?: number;
  field?: boolean;
  rootAttributes?: string;
  value?: string | null;
}

const actions = [
  "click->stimeo--rating#select",
  "mouseenter->stimeo--rating#preview",
  "mouseleave->stimeo--rating#endPreview",
  "focus->stimeo--rating#preview",
  "blur->stimeo--rating#endPreview",
  "keydown->stimeo--rating#onKeydown",
].join(" ");

const markup = ({
  count = 3,
  field = true,
  rootAttributes = "",
  value = "2",
}: FixtureOptions = {}) => {
  const valueAttribute = value === null ? "" : `data-stimeo--rating-value-value="${value}"`;
  const symbols = Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const label = ordinal === 1 ? "1 star" : `${ordinal} stars`;
    return `
      <span role="radio" aria-checked="false" aria-label="${label}" tabindex="-1"
            data-symbol-id="${ordinal}" data-stimeo--rating-target="symbol"
            data-action="${actions}"></span>`;
  }).join("");

  return `
    <div data-controller="stimeo--rating" role="radiogroup" aria-label="Rating"
         ${valueAttribute} ${rootAttributes}>
      ${symbols}
      ${field ? '<input type="hidden" data-stimeo--rating-target="field" />' : ""}
    </div>`;
};

describe("RatingController", () => {
  let application: Application | undefined;

  const app = () => {
    if (!application) throw new Error("Rating test application has not started");
    return application;
  };

  const start = async (options: FixtureOptions = {}) => {
    document.body.innerHTML = markup(options);
    application = Application.start();
    application.register("stimeo--rating", RatingController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--rating']") as HTMLElement;
  const symbols = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--rating-target='symbol']"));
  const field = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--rating-target='field']",
    ) as HTMLInputElement;
  const controller = () =>
    app().getControllerForElementAndIdentifier(root(), "stimeo--rating") as RatingController;
  const checked = () => symbols().map((symbol) => symbol.getAttribute("aria-checked"));
  const fill = () => symbols().map((symbol) => symbol.hasAttribute("data-rating-hover"));
  const tabindexes = () => symbols().map((symbol) => symbol.tabIndex);
  const key = (index: number, value: string) => {
    const event = new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
    });
    symbols()[index]?.dispatchEvent(event);
    return event;
  };
  const declared = () => root().getAttribute("data-stimeo--rating-value-value");

  /** Every `change` and `reconcile` the root dispatches, in order, with its detail. */
  const reports = () => {
    const seen: Array<{ type: string; value: number }> = [];
    for (const type of ["change", "reconcile"]) {
      root().addEventListener(`stimeo--rating:${type}`, (event) => {
        seen.push({ type, value: (event as CustomEvent<{ value: number }>).detail.value });
      });
    }
    return seen;
  };

  /** A symbol built the way a Turbo Stream or a morph inserts one. */
  const buildSymbol = (ordinal: number) => {
    const symbol = document.createElement("span");
    symbol.setAttribute("role", "radio");
    symbol.setAttribute("aria-checked", "false");
    symbol.setAttribute("aria-label", `${ordinal} stars`);
    symbol.setAttribute("data-stimeo--rating-target", "symbol");
    symbol.setAttribute("data-action", actions);
    symbol.tabIndex = -1;
    return symbol;
  };

  it("declares the public actions, events, and three render Values", () => {
    expect(RatingController.actions).toEqual(["endPreview", "onKeydown", "preview", "select"]);
    expect(RatingController.events).toEqual(["change", "reconcile"]);
    expect(Object.keys(RatingController.values)).toEqual(["value", "clearable", "readonly"]);
  });

  it("reflects the initial ordinal into ARIA, roving, fill, and the field", async () => {
    await start();

    expect(checked()).toEqual(["false", "true", "false"]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
    expect(fill()).toEqual([true, true, false]);
    expect(field().value).toBe("2");
  });

  it("defaults to an unrated value when value is omitted", async () => {
    await start({ value: null });

    expect(checked()).toEqual(["false", "false", "false"]);
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(fill()).toEqual([false, false, false]);
    expect(field().value).toBe("0");
  });

  it("selects symbols by DOM order without a per-symbol value attribute", async () => {
    await start();
    symbols()[2]?.click();

    expect(checked()).toEqual(["false", "false", "true"]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(fill()).toEqual([true, true, true]);
    expect(field().value).toBe("3");
  });

  it("ignores a data-rating-value attribute in favor of DOM order", async () => {
    await start();
    symbols()[0]?.setAttribute("data-rating-value", "30");
    symbols()[1]?.setAttribute("data-rating-value", "10");
    symbols()[2]?.setAttribute("data-rating-value", "20");

    symbols()[0]?.click();

    expect(field().value).toBe("1");
    expect(checked()).toEqual(["true", "false", "false"]);
  });

  it("clears a selected symbol and returns focus to the first Tab stop", async () => {
    await start();
    symbols()[1]?.click();

    expect(checked()).toEqual(["false", "false", "false"]);
    expect(fill()).toEqual([false, false, false]);
    expect(field().value).toBe("0");
    expect(tabindexes()).toEqual([0, -1, -1]);
    expect(document.activeElement).toBe(symbols()[0]);
  });

  it("does not go below one when clearable is false", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-clearable-value="false"' });

    key(1, "ArrowDown");
    expect(field().value).toBe("1");
    key(0, "ArrowLeft");
    key(0, "Home");

    expect(field().value).toBe("1");
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("increments and decrements with every arrow pair and clamps at bounds", async () => {
    await start();

    key(1, "ArrowRight");
    expect(field().value).toBe("3");
    key(2, "ArrowUp");
    expect(field().value).toBe("3");
    key(2, "ArrowLeft");
    expect(field().value).toBe("2");
    key(1, "ArrowDown");
    expect(field().value).toBe("1");
  });

  it.each(["Delete", "Backspace"])("clears the rating with %s when clearable", async (name) => {
    await start();
    const changes: number[] = [];
    root().addEventListener("stimeo--rating:change", (event) => {
      changes.push((event as CustomEvent).detail.value);
    });

    const event = key(1, name);

    expect(checked()).toEqual(["false", "false", "false"]);
    expect(fill()).toEqual([false, false, false]);
    expect(field().value).toBe("0");
    expect(changes).toEqual([0]);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each(["Delete", "Backspace"])("leaves %s to the browser when not clearable", async (name) => {
    await start({ rootAttributes: 'data-stimeo--rating-clearable-value="false"' });

    const event = key(1, name);

    // The value is untouched and the key was not consumed, so a consumer
    // shortcut bound further up still sees it.
    expect(checked()[1]).toBe("true");
    expect(field().value).toBe("2");
    expect(event.defaultPrevented).toBe(false);
  });

  it("uses Home, End, Space, and Enter over the live DOM range", async () => {
    await start();

    key(1, "Home");
    expect(field().value).toBe("0");
    key(0, "End");
    expect(field().value).toBe("3");
    symbols()[2]?.click();
    expect(field().value).toBe("0");
    key(0, " ");
    expect(field().value).toBe("1");
    symbols()[0]?.click();
    key(0, "Enter");
    expect(field().value).toBe("1");
  });

  it("reverses only horizontal arrows under RTL", async () => {
    await start();
    root().style.direction = "rtl";

    key(1, "ArrowLeft");
    expect(field().value).toBe("3");
    key(2, "ArrowRight");
    expect(field().value).toBe("2");
    key(1, "ArrowUp");
    expect(field().value).toBe("3");
    key(2, "ArrowDown");
    expect(field().value).toBe("2");
  });

  it("yields a key a descendant widget already consumed", async () => {
    await start();
    symbols()[0]?.focus();
    const inner = document.createElement("span");
    symbols()[0]?.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());
    const claimed = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });

    expect(inner.dispatchEvent(claimed)).toBe(false);
    expect(field().value).toBe("2");
    expect(document.activeElement).toBe(symbols()[0]);
  });

  it("leaves modified arrows to the browser", async () => {
    await start();
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
      altKey: true,
    });
    symbols()[1]?.dispatchEvent(chord);

    expect(chord.defaultPrevented).toBe(false);
    expect(field().value).toBe("2");
  });

  it("previews and restores the fill on both pointer and focus paths", async () => {
    await start();

    symbols()[2]?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(fill()).toEqual([true, true, true]);
    symbols()[2]?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(fill()).toEqual([true, true, false]);

    symbols()[0]?.focus();
    expect(fill()).toEqual([true, false, false]);
    symbols()[0]?.blur();
    expect(fill()).toEqual([true, true, false]);
    expect(field().value).toBe("2");
  });

  it("dispatches change only for user operations that move the value", async () => {
    await start({
      value: "3",
      rootAttributes: 'data-stimeo--rating-clearable-value="false"',
    });
    const values: number[] = [];
    root().addEventListener("stimeo--rating:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });

    key(2, "ArrowRight");
    key(2, "ArrowUp");
    key(2, "End");
    key(2, " ");
    key(2, "Enter");
    symbols()[2]?.click();
    expect(values).toEqual([]);

    key(2, "ArrowDown");
    expect(values).toEqual([2]);
  });

  it("dispatches numeric change details for distinct pointer selections", async () => {
    await start();
    const values: number[] = [];
    root().addEventListener("stimeo--rating:change", (event) => {
      values.push((event as CustomEvent<{ value: number }>).detail.value);
    });

    symbols()[2]?.click();
    symbols()[0]?.click();

    expect(values).toEqual([3, 1]);
  });

  it("emits neither change nor reconcile during initial reflection", async () => {
    const events: string[] = [];
    const handler = (event: Event) => events.push(event.type);
    document.addEventListener("stimeo--rating:change", handler);
    document.addEventListener("stimeo--rating:reconcile", handler);

    await start({ value: "9" });

    document.removeEventListener("stimeo--rating:change", handler);
    document.removeEventListener("stimeo--rating:reconcile", handler);
    expect(events).toEqual([]);
    expect(field().value).toBe("3");
  });

  it("reports a value the page moves to as reconcile, never as change", async () => {
    await start();
    const seen = reports();

    root().setAttribute("data-stimeo--rating-value-value", "3");
    await tick();

    expect(checked()).toEqual(["false", "false", "true"]);
    expect(field().value).toBe("3");
    expect(seen).toEqual([{ type: "reconcile", value: 3 }]);
  });

  it("stays silent when the page writes the value already on screen", async () => {
    await start({ value: "2" });
    const seen = reports();

    root().setAttribute("data-stimeo--rating-value-value", "2.2");
    await tick();

    expect(checked()).toEqual(["false", "true", "false"]);
    expect(seen).toEqual([]);
  });

  it("normalizes for display only, leaving the value Value as the page wrote it", async () => {
    await start({ value: "9" });
    expect(field().value).toBe("3");
    expect(declared()).toBe("9");
    const seen = reports();

    root().setAttribute("data-stimeo--rating-value-value", "-4");
    await tick();

    expect(field().value).toBe("0");
    expect(checked()).toEqual(["false", "false", "false"]);
    expect(declared()).toBe("-4");
    expect(seen).toEqual([{ type: "reconcile", value: 0 }]);
  });

  it("reports a normalized value once, not again on a later pass that leaves it", async () => {
    await start({ count: 5, value: "1" });
    const seen = reports();

    root().setAttribute("data-stimeo--rating-value-value", "9");
    await tick();
    expect(seen).toEqual([{ type: "reconcile", value: 5 }]);

    root().setAttribute("data-stimeo--rating-clearable-value", "false");
    await tick();
    root().setAttribute("data-stimeo--rating-readonly-value", "true");
    await tick();
    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();

    expect(field().value).toBe("5");
    expect(seen).toEqual([{ type: "reconcile", value: 5 }]);
  });

  it("reports one batch that moves value and clearable together once", async () => {
    await start({ value: "2" });
    const seen = reports();

    root().setAttribute("data-stimeo--rating-value-value", "1");
    root().setAttribute("data-stimeo--rating-clearable-value", "false");
    await tick();

    expect(field().value).toBe("1");
    expect(seen).toEqual([{ type: "reconcile", value: 1 }]);
  });

  it("gives a clamped value back once the scale reaches it again", async () => {
    await start({ count: 5, value: "5" });
    const seen = reports();

    symbols()[4]?.remove();
    await tick();
    expect(field().value).toBe("4");

    root().insertBefore(buildSymbol(5), field());
    await tick();

    expect(field().value).toBe("5");
    expect(checked()).toEqual(["false", "false", "false", "false", "true"]);
    expect(declared()).toBe("5");
    expect(seen).toEqual([
      { type: "reconcile", value: 4 },
      { type: "reconcile", value: 5 },
    ]);
  });

  it("gives value zero back once clearable allows it again", async () => {
    await start({ value: "0" });
    const seen = reports();

    root().setAttribute("data-stimeo--rating-clearable-value", "false");
    await tick();
    root().setAttribute("data-stimeo--rating-clearable-value", "true");
    await tick();

    expect(field().value).toBe("0");
    expect(declared()).toBe("0");
    expect(seen).toEqual([
      { type: "reconcile", value: 1 },
      { type: "reconcile", value: 0 },
    ]);
  });

  it("writes the value Value for a user move, and the pass it starts reports nothing", async () => {
    await start({ value: "1" });
    const seen = reports();

    symbols()[2]?.click();
    await tick();

    expect(declared()).toBe("3");
    expect(seen).toEqual([{ type: "change", value: 3 }]);
  });

  it("writes the user's value into the value Value before the field's native change and change report it", async () => {
    await start({ value: "1" });
    const readings: string[] = [];
    field().addEventListener("change", () => readings.push(`native ${declared()}`));
    root().addEventListener("stimeo--rating:change", () => readings.push(`change ${declared()}`));

    symbols()[2]?.click();

    expect(readings).toEqual(["native 3", "change 3"]);
  });

  it("measures a user move from the value on screen when the page wrote another in the same task", async () => {
    await start({ value: "1" });
    const seen = reports();

    // The page's write has not been painted when the key lands on the third symbol.
    root().setAttribute("data-stimeo--rating-value-value", "3");
    key(2, "Enter");
    await tick();

    expect(field().value).toBe("3");
    expect(seen).toEqual([{ type: "change", value: 3 }]);
  });

  it("measures a move a reconcile listener makes from the value just reported", async () => {
    await start({ value: "2" });
    const seen = reports();
    let answered = false;
    root().addEventListener("stimeo--rating:reconcile", () => {
      if (answered) return;
      answered = true;
      key(2, "ArrowLeft");
    });

    root().setAttribute("data-stimeo--rating-value-value", "9");
    await tick();

    expect(field().value).toBe("2");
    expect(declared()).toBe("2");
    expect(seen).toEqual([
      { type: "reconcile", value: 3 },
      { type: "change", value: 2 },
    ]);
  });

  it("normalizes fractional and non-finite initial values without an event", async () => {
    await start({ value: "2.6" });
    expect(field().value).toBe("3");

    disconnectAndStopApplication(app());
    await start({ value: "not-a-number" });
    expect(field().value).toBe("0");
  });

  it("reports a runtime invalid value normalization as reconcile", async () => {
    await start();
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--rating:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    root().setAttribute("data-stimeo--rating-value-value", "not-a-number");
    await tick();

    expect(field().value).toBe("0");
    expect(repairs).toEqual([{ value: 0 }]);
  });

  it("reconciles value zero when clearable becomes false at runtime", async () => {
    await start({ value: "0" });
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--rating:change", (event) => changes.push(event));
    root().addEventListener("stimeo--rating:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    root().setAttribute("data-stimeo--rating-clearable-value", "false");
    await tick();

    expect(field().value).toBe("1");
    expect(checked()).toEqual(["true", "false", "false"]);
    expect(repairs).toEqual([{ value: 1 }]);
    expect(changes).toEqual([]);
  });

  it("enters and leaves readonly mode while restoring authored semantics", async () => {
    await start();

    root().setAttribute("data-stimeo--rating-readonly-value", "true");
    await tick();
    expect(root().getAttribute("role")).toBe("img");
    expect(symbols().map((symbol) => symbol.getAttribute("role"))).toEqual([null, null, null]);
    expect(symbols().map((symbol) => symbol.getAttribute("aria-hidden"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(tabindexes()).toEqual([-1, -1, -1]);

    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();
    expect(root().getAttribute("role")).toBe("radiogroup");
    expect(symbols().map((symbol) => symbol.getAttribute("role"))).toEqual([
      "radio",
      "radio",
      "radio",
    ]);
    expect(symbols().map((symbol) => symbol.hasAttribute("aria-hidden"))).toEqual([
      false,
      false,
      false,
    ]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("keeps a consumer attribute written while readonly through a reconciliation", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });
    root().setAttribute("role", "presentation");
    symbols()[0]?.setAttribute("aria-hidden", "false");

    // A Value morph while still readonly re-applies the snapshot semantics. The
    // consumer's value is what the lease must restore afterwards, not the value
    // that was authored before readonly began.
    root().setAttribute("data-stimeo--rating-value-value", "3");
    await tick();

    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();

    expect(root().getAttribute("role")).toBe("presentation");
    expect(symbols()[0]?.getAttribute("aria-hidden")).toBe("false");
  });

  it("rewinds readonly borrowings before the Turbo snapshot", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });

    // Turbo clones the page at `turbo:before-cache`, while the controller is
    // still connected: anything left borrowed is what a restored page treats as
    // the authored markup.
    document.dispatchEvent(new Event("turbo:before-cache"));
    const snapshot = document.body.innerHTML;

    // The rewound Tab stop is the selected symbol, so the cached page is
    // reachable by Tab without waiting for an interaction.
    expect(tabindexes().indexOf(0)).toBe(1);
    expect(snapshot).not.toContain('role="img"');
    expect(snapshot).not.toContain('aria-hidden="true"');

    disconnectAndStopApplication(app());
    document.body.innerHTML = snapshot;
    application = Application.start();
    application.register("stimeo--rating", RatingController);
    await tick();

    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();

    expect(root().getAttribute("role")).toBe("radiogroup");
    expect(symbols()[0]?.getAttribute("role")).toBe("radio");
    expect(symbols()[0]?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("rewinds the Tab stop to the first symbol for an unrated snapshot", async () => {
    await start({ value: "0", rootAttributes: 'data-stimeo--rating-readonly-value="true"' });

    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(tabindexes().indexOf(0)).toBe(0);
  });

  it("does not overwrite consumer attribute changes made while readonly", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });
    root().setAttribute("role", "presentation");
    symbols()[0]?.setAttribute("role", "presentation");
    symbols()[0]?.setAttribute("aria-hidden", "false");

    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();

    expect(root().getAttribute("role")).toBe("presentation");
    expect(symbols()[0]?.getAttribute("role")).toBe("presentation");
    expect(symbols()[0]?.getAttribute("aria-hidden")).toBe("false");
  });

  it("lands focus on the img root instead of a symbol leaving the a11y tree", async () => {
    await start();
    const focused = symbols()[1] as HTMLElement;
    focused.focus();

    root().setAttribute("data-stimeo--rating-readonly-value", "true");
    await tick();

    expect(document.activeElement).toBe(root());
    expect(root().getAttribute("tabindex")).toBe("-1");
    expect(focused.getAttribute("aria-hidden")).toBe("true");
  });

  it("returns rescued focus to the Tab stop and the borrowed tabindex on release", async () => {
    await start();
    (symbols()[1] as HTMLElement).focus();
    root().setAttribute("data-stimeo--rating-readonly-value", "true");
    await tick();
    expect(document.activeElement).toBe(root());

    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();

    expect(document.activeElement).toBe(symbols()[1]);
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("leaves an authored root Tab stop alone while rescuing focus", async () => {
    await start({ rootAttributes: 'tabindex="0"' });
    (symbols()[1] as HTMLElement).focus();

    root().setAttribute("data-stimeo--rating-readonly-value", "true");
    await tick();
    expect(document.activeElement).toBe(root());
    expect(root().getAttribute("tabindex")).toBe("0");

    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();
    expect(root().getAttribute("tabindex")).toBe("0");
  });

  it("does not claim focus the consumer put on the root itself", async () => {
    await start({ rootAttributes: 'tabindex="0"' });
    root().focus();

    root().setAttribute("data-stimeo--rating-readonly-value", "true");
    await tick();
    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();

    expect(document.activeElement).toBe(root());
  });

  it("keeps focus untouched when readonly begins with focus outside the group", async () => {
    await start();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    root().setAttribute("data-stimeo--rating-readonly-value", "true");
    await tick();
    root().setAttribute("data-stimeo--rating-readonly-value", "false");
    await tick();

    expect(document.activeElement).toBe(outside);
    expect(root().hasAttribute("tabindex")).toBe(false);
    outside.remove();
  });

  it("keeps every readonly interaction inert and unconsumed", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });
    const before = fill();

    symbols()[2]?.click();
    symbols()[2]?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    symbols()[2]?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    symbols()[2]?.dispatchEvent(new FocusEvent("focus"));
    symbols()[2]?.dispatchEvent(new FocusEvent("blur"));
    const arrow = key(2, "ArrowRight");

    expect(field().value).toBe("2");
    expect(fill()).toEqual(before);
    expect(arrow.defaultPrevented).toBe(false);
  });

  it("leaves a consumer-mutated preview untouched when readonly endPreview is invoked", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });
    symbols()[2]?.setAttribute("data-rating-hover", "");

    controller().endPreview();

    expect(fill()).toEqual([true, true, true]);
    expect(field().value).toBe("2");
  });

  it("ignores pointer and keyboard actions hosted outside a symbol target", async () => {
    await start();
    const changes: unknown[] = [];
    root().addEventListener("stimeo--rating:change", (event) => changes.push(event));

    controller().select({ currentTarget: root() } as unknown as Event);
    const space = new KeyboardEvent("keydown", { key: " ", cancelable: true });
    controller().onKeydown(space);

    expect(field().value).toBe("2");
    expect(changes).toEqual([]);
    expect(space.defaultPrevented).toBe(false);
  });

  it("normalizes a dynamically added symbol's authored Tab stop", async () => {
    await start();
    const late = document.createElement("span");
    late.setAttribute("role", "radio");
    late.setAttribute("aria-checked", "true");
    late.setAttribute("aria-label", "4 stars");
    late.setAttribute("data-stimeo--rating-target", "symbol");
    late.setAttribute("data-action", actions);
    late.tabIndex = 0;
    root().insertBefore(late, field());
    await tick();

    expect(checked()).toEqual(["false", "true", "false", "false"]);
    expect(tabindexes()).toEqual([-1, 0, -1, -1]);
  });

  it("uses the remaining DOM order after a middle symbol is removed", async () => {
    await start({ count: 5, value: "5" });
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--rating:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    symbols()[1]?.remove();
    await tick();

    expect(symbols().map((symbol) => symbol.dataset.symbolId)).toEqual(["1", "3", "4", "5"]);
    expect(checked()).toEqual(["false", "false", "false", "true"]);
    expect(tabindexes()).toEqual([-1, -1, -1, 0]);
    expect(field().value).toBe("4");
    expect(repairs).toEqual([{ value: 4 }]);
  });

  it("reconciles a removed upper symbol as repair, never change", async () => {
    await start({ value: "3" });
    const changes: unknown[] = [];
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--rating:change", (event) => changes.push(event));
    root().addEventListener("stimeo--rating:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    symbols()[2]?.remove();
    await tick();

    expect(field().value).toBe("2");
    expect(checked()).toEqual(["false", "true"]);
    expect(tabindexes()).toEqual([-1, 0]);
    expect(repairs).toEqual([{ value: 2 }]);
    expect(changes).toEqual([]);
  });

  it("also reconciles removed symbols while readonly", async () => {
    await start({
      value: "3",
      rootAttributes: 'data-stimeo--rating-readonly-value="true"',
    });
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--rating:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });

    symbols()[2]?.remove();
    await tick();

    expect(root().getAttribute("role")).toBe("img");
    expect(field().value).toBe("2");
    expect(fill()).toEqual([true, true]);
    expect(repairs).toEqual([{ value: 2 }]);
  });

  it("reflects the current value into a field replaced after settlement", async () => {
    await start();
    const replacement = field().cloneNode() as HTMLInputElement;
    replacement.value = "";
    field().replaceWith(replacement);
    await tick();

    expect(field()).toBe(replacement);
    expect(replacement.value).toBe("2");
  });

  it("supports a missing optional field", async () => {
    await start({ field: false });
    symbols()[2]?.click();

    expect(checked()).toEqual(["false", "false", "true"]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("cancels a queued repaint and action bindings when unloaded", async () => {
    await start();
    const repairs: unknown[] = [];
    root().addEventListener("stimeo--rating:reconcile", (event) => repairs.push(event));
    root().setAttribute("data-stimeo--rating-value-value", "8");
    controller().valueValueChanged();

    app().unload("stimeo--rating");
    await flushMicrotasks();
    symbols()[2]?.click();

    expect(field().value).toBe("2");
    expect(checked()).toEqual(["false", "true", "false"]);
    expect(repairs).toEqual([]);
  });

  it("hands authored readonly semantics back when unloaded", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });

    app().unload("stimeo--rating");

    expect(root().getAttribute("role")).toBe("radiogroup");
    expect(symbols().map((symbol) => symbol.getAttribute("role"))).toEqual([
      "radio",
      "radio",
      "radio",
    ]);
    expect(symbols().map((symbol) => symbol.hasAttribute("aria-hidden"))).toEqual([
      false,
      false,
      false,
    ]);
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  it("leaves readonly attributes a consumer rewrote alone when unloaded", async () => {
    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });
    root().setAttribute("role", "presentation");
    symbols()[0]?.setAttribute("aria-hidden", "false");

    app().unload("stimeo--rating");

    expect(root().getAttribute("role")).toBe("presentation");
    expect(symbols()[0]?.getAttribute("aria-hidden")).toBe("false");
    expect(symbols()[1]?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("announces role, name, state, and DOM position in order", async () => {
    await start();
    const speech = await captureSpeech({ container: root(), steps: 4 });

    expect(speech).toEqual([
      "radiogroup, Rating",
      "radio, 1 star, not checked, position 1, set size 3",
      "radio, 2 stars, checked, position 2, set size 3",
      "radio, 3 stars, not checked, position 3, set size 3",
      "end of radiogroup, Rating",
    ]);
  });

  it("has no machine-detectable violations in interactive and readonly modes", async () => {
    await start();
    await expectNoA11yViolations(root());
    disconnectAndStopApplication(app());

    await start({ rootAttributes: 'data-stimeo--rating-readonly-value="true"' });
    await expectNoA11yViolations(root());
  });

  // --- Hidden form field ---

  describe("hidden form field", () => {
    let commits: ReturnType<typeof captureFieldCommits>;

    beforeEach(() => {
      commits = captureFieldCommits();
    });

    afterEach(() => {
      commits.stop();
    });

    it("seeds the field without reporting a commit", async () => {
      await start({ value: "3" });

      expect(field().value).toBe("3");
      expect(commits.seen).toEqual([]);
    });

    it("writes and reports once per rating the user set", async () => {
      await start({ value: "3" });
      commits.clear();

      symbols()[0]?.click();

      expect(field().value).toBe("1");
      expect(commits.seen).toEqual([field()]);
    });

    it("stays silent when the same rating is set again", async () => {
      await start({ value: "3", rootAttributes: 'data-stimeo--rating-clearable-value="false"' });
      commits.clear();

      symbols()[2]?.click();

      expect(field().value).toBe("3");
      expect(commits.seen).toEqual([]);
    });

    it("writes a value changed by application code without reporting a commit", async () => {
      await start({ value: "3" });
      commits.clear();

      controller().valueValue = 2;
      await tick();

      expect(field().value).toBe("2");
      expect(commits.seen).toEqual([]);
    });
  });
});
