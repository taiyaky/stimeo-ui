import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DateRangePickerController } from "../src/controllers/date_range_picker_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link DateRangePickerController}: two-point range
 * selection with auto-swap, in-progress preview, presets, grid keyboard
 * navigation with roving focus, Escape-to-cancel, Turbo cache cleanup, and the
 * `change` / `monthchange` events.
 *
 * The hidden fields are pre-filled so the view month and confirmed range are
 * deterministic (no dependence on the current date), except where a preset is
 * exercised explicitly.
 */

/** Builds rows containing `count` cell targets, seven cells per row. */
function gridRows(count = 42): string {
  let rows = "";
  for (let r = 0; r < Math.ceil(count / 7); r++) {
    let cells = "";
    for (let c = 0; c < 7 && r * 7 + c < count; c++) {
      cells += `<button type="button" role="gridcell" tabindex="-1"
        data-stimeo--date-range-picker-target="cell"
        data-action="click->stimeo--date-range-picker#selectDate
                     mouseenter->stimeo--date-range-picker#previewTo
                     focus->stimeo--date-range-picker#previewTo
                     keydown->stimeo--date-range-picker#onKeydown"></button>`;
    }
    rows += `<div role="row">${cells}</div>`;
  }
  return rows;
}

describe("DateRangePickerController", () => {
  let application: Application;

  interface MountOptions {
    start?: string;
    end?: string;
    min?: string;
    max?: string;
    disabledDates?: string[];
    /** Verbatim attribute text, for declarations the typed option cannot express. */
    disabledDatesRaw?: string;
    cellCount?: number;
    includeFields?: boolean;
  }

  const mount = async ({
    start = "2026-06-10",
    end = "2026-06-20",
    min = "",
    max = "",
    disabledDates,
    disabledDatesRaw,
    cellCount = 42,
    includeFields = true,
  }: MountOptions = {}) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--date-range-picker"
           ${min ? `data-stimeo--date-range-picker-min-value="${min}"` : ""}
           ${max ? `data-stimeo--date-range-picker-max-value="${max}"` : ""}
           ${
             disabledDatesRaw !== undefined
               ? `data-stimeo--date-range-picker-disabled-dates-value='${disabledDatesRaw}'`
               : disabledDates
                 ? `data-stimeo--date-range-picker-disabled-dates-value='${JSON.stringify(disabledDates)}'`
                 : ""
}>
        <button type="button" data-action="stimeo--date-range-picker#prev">Prev</button>
        <span id="drp-month" aria-live="polite"
              data-stimeo--date-range-picker-target="monthLabel"></span>
        <button type="button" data-action="stimeo--date-range-picker#next">Next</button>
        <div role="grid" aria-labelledby="drp-month"
             data-stimeo--date-range-picker-target="grid">
          ${gridRows(cellCount)}
        </div>
        <div role="group" aria-label="Presets">
          <button type="button" data-range="today"
                  data-action="stimeo--date-range-picker#applyPreset">Today</button>
          <button type="button" data-range="last7"
                  data-action="stimeo--date-range-picker#applyPreset">Last 7</button>
          <button type="button" data-range="thisMonth"
                  data-action="stimeo--date-range-picker#applyPreset">This month</button>
          <button type="button" data-range="nope"
                  data-action="stimeo--date-range-picker#applyPreset">Unknown</button>
        </div>
        <span role="status" aria-live="polite"
              data-stimeo--date-range-picker-target="status"></span>
        ${
          includeFields
            ? `<input type="hidden" value="${start}" data-stimeo--date-range-picker-target="startField" />
               <input type="hidden" value="${end}" data-stimeo--date-range-picker-target="endField" />`
            : ""
        }
      </div>`;
    application = Application.start();
    application.register("stimeo--date-range-picker", DateRangePickerController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    document.documentElement.lang = "";
    vi.restoreAllMocks();
  });

  const root = () =>
    document.querySelector<HTMLElement>(
      "[data-controller='stimeo--date-range-picker']",
    ) as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--date-range-picker",
    ) as DateRangePickerController;
  const monthLabel = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--date-range-picker-target='monthLabel']",
    ) as HTMLElement;
  const navButton = (action: "prev" | "next") =>
    document.querySelector<HTMLElement>(
      `[data-action='stimeo--date-range-picker#${action}']`,
    ) as HTMLElement;
  const cell = (iso: string) =>
    document.querySelector<HTMLElement>(`[data-date='${iso}']`) as HTMLElement;
  const preset = (name: string) =>
    document.querySelector<HTMLElement>(`[data-range='${name}']`) as HTMLElement;
  const status = () =>
    document.querySelector<HTMLElement>(
      "[data-stimeo--date-range-picker-target='status']",
    ) as HTMLElement;
  const field = (which: "start" | "end") =>
    document.querySelector<HTMLInputElement>(
      `[data-stimeo--date-range-picker-target='${which}Field']`,
    ) as HTMLInputElement;
  const click = (iso: string) =>
    cell(iso).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const hover = (iso: string) =>
    cell(iso).dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));

  it("falls back to English when the document language tag is invalid", async () => {
    document.documentElement.lang = "en_US";
    await mount();

    expect(document.querySelectorAll("[data-date]")).toHaveLength(42);
    expect(document.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(monthLabel().textContent).toBe("June 2026");
  });

  it("connects and paints when the disabled-dates declaration is malformed", async () => {
    // Stimulus's own Array reader runs `JSON.parse` in the value observer,
    // before any callback, and rethrows — which would stop the picker from
    // connecting at all and leave the grid unpainted and unreachable.
    await mount({ disabledDatesRaw: "[not json" });

    expect(document.querySelectorAll("[data-date]")).toHaveLength(42);
    expect(document.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    // Nothing is excluded, so an ordinary day stays selectable.
    expect(cell("2026-06-15").hasAttribute("aria-disabled")).toBe(false);
  });

  it("ignores a disabled-dates declaration that is not a list", async () => {
    await mount({ disabledDatesRaw: '{"2026-06-15": true}' });

    expect(document.querySelectorAll("[data-date]")).toHaveLength(42);
    expect(cell("2026-06-15").hasAttribute("aria-disabled")).toBe(false);
  });

  it("rethrows non-locale Intl failures instead of masking them", async () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const ThrowingDateTimeFormat = new Proxy(NativeDateTimeFormat, {
      construct(target, argumentsList, newTarget) {
        if (argumentsList[0] === "type-error") throw new TypeError("formatter failed");
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: ThrowingDateTimeFormat,
    });
    document.documentElement.lang = "type-error";
    document.body.innerHTML = `
      <div data-controller="stimeo--date-range-picker">
        <span data-stimeo--date-range-picker-target="monthLabel"></span>
        <div role="grid" data-stimeo--date-range-picker-target="grid">${gridRows()}</div>
        <input type="hidden" value="2026-06-10"
               data-stimeo--date-range-picker-target="startField" />
      </div>`;
    application = Application.start();
    const handleError = vi.spyOn(application, "handleError").mockImplementation(() => {});
    application.register("stimeo--date-range-picker", DateRangePickerController);

    try {
      await tick();
    } finally {
      Object.defineProperty(Intl, "DateTimeFormat", {
        configurable: true,
        writable: true,
        value: NativeDateTimeFormat,
      });
    }

    expect(handleError).toHaveBeenCalledTimes(1);
    expect(handleError.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "formatter failed" }),
    );
    expect(document.querySelectorAll("[data-date]")).toHaveLength(0);
  });

  it("normalizes a reversed authored range and reflects it to the fields", async () => {
    await mount({ start: "2026-06-20", end: "2026-06-10" });

    expect(field("start").value).toBe("2026-06-10");
    expect(field("end").value).toBe("2026-06-20");
    expect(cell("2026-06-15").hasAttribute("data-in-range")).toBe(true);
  });

  it("clears an invalid authored endpoint without stopping the grid paint", async () => {
    await mount({ start: "not-a-date", end: "2026-06-20" });

    expect(field("start").value).toBe("");
    expect(field("end").value).toBe("2026-06-20");
    expect(document.querySelectorAll("[data-date]")).toHaveLength(42);
    expect(root().querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("ignores actions whose event target is outside a dated cell", async () => {
    await mount({ cellCount: 43 });
    const outsideClick = new MouseEvent("click");
    Object.defineProperty(outsideClick, "target", { value: root() });
    const outsideFocus = new FocusEvent("focus");
    Object.defineProperty(outsideFocus, "target", { value: root() });
    const outsideKey = new KeyboardEvent("keydown", { key: "ArrowRight" });
    Object.defineProperty(outsideKey, "target", { value: root() });

    expect(() => controller().selectDate(outsideClick)).not.toThrow();
    expect(() => controller().previewTo(outsideFocus)).not.toThrow();
    expect(() => controller().onKeydown(outsideKey)).not.toThrow();
  });

  it("does not repaint or navigate from an undated extra cell", async () => {
    await mount({ cellCount: 43 });
    const extra = root().querySelectorAll<HTMLElement>(
      "[data-stimeo--date-range-picker-target='cell']",
    )[42];
    if (!extra) throw new Error("Expected the extra date-range-picker cell");
    const label = monthLabel();
    const textContent = Object.getOwnPropertyDescriptor(Element.prototype, "textContent");
    if (!textContent?.get || !textContent.set) {
      throw new Error("Expected Element.textContent accessors");
    }
    let renders = 0;
    Object.defineProperty(label, "textContent", {
      configurable: true,
      get: () => textContent.get?.call(label),
      set: (value: string | null) => {
        renders += 1;
        textContent.set?.call(label, value);
      },
    });
    const focus = new FocusEvent("focus");
    Object.defineProperty(focus, "target", { value: extra });
    const keyboard = new KeyboardEvent("keydown", { key: "ArrowRight" });
    Object.defineProperty(keyboard, "target", { value: extra });

    controller().previewTo(focus);
    controller().onKeydown(keyboard);

    expect(renders).toBe(0);
    expect(monthLabel().textContent).toBe("June 2026");
  });

  it("reverses the horizontal arrows under RTL, leaving the week jump alone", async () => {
    // Logical direction. `dir="rtl"` is the authoring contract, but happy-dom
    // does not resolve it into the computed style, so the direction is set
    // inline instead.
    await mount();
    const root = document.querySelector(
      "[data-controller='stimeo--date-range-picker']",
    ) as HTMLElement;
    root.style.direction = "rtl";
    const from = cell("2026-06-12");
    from.focus();

    key(from, "ArrowRight"); // "previous day" under RTL
    expect(document.activeElement).toBe(cell("2026-06-11"));

    key(cell("2026-06-11"), "ArrowLeft"); // "next day"
    expect(document.activeElement).toBe(cell("2026-06-12"));

    key(cell("2026-06-12"), "ArrowUp"); // -7 days regardless of direction
    expect(document.activeElement).toBe(cell("2026-06-05"));
  });

  it("renders the confirmed range: ends selected, inner cells in range", async () => {
    await mount();
    expect(cell("2026-06-10").getAttribute("aria-selected")).toBe("true");
    expect(cell("2026-06-20").getAttribute("aria-selected")).toBe("true");
    expect(cell("2026-06-10").hasAttribute("data-range-start")).toBe(true);
    expect(cell("2026-06-20").hasAttribute("data-range-end")).toBe(true);
    expect(cell("2026-06-15").hasAttribute("data-in-range")).toBe(true);
    expect(cell("2026-06-15").getAttribute("aria-selected")).toBe("false");
    // Boundaries are excluded from the inner-range hook.
    expect(cell("2026-06-10").hasAttribute("data-in-range")).toBe(false);
  });

  it("yields a grid key a descendant widget already consumed", async () => {
    // A widget inside a gridcell that claims Enter must not ALSO commit a range
    // endpoint.
    //
    // The claimed press is the SECOND one: the first `#choose` only parks a
    // pending start and leaves the fields untouched, so asserting on them after
    // one press cannot tell the guard apart from no guard.
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    click("2026-06-05"); // pending start

    const inner = document.createElement("span");
    cell("2026-06-08").append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());
    const claimed = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(detail).toEqual([]); // the range must not confirm
    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(true); // still pending
  });

  it("selects a fresh range over two clicks and dispatches change", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });

    click("2026-06-05"); // pending start
    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(true);
    expect(detail).toEqual([]); // not confirmed yet

    click("2026-06-08"); // confirm end
    expect(detail).toEqual([{ start: "2026-06-05", end: "2026-06-08" }]);
    expect(field("start").value).toBe("2026-06-05");
    expect(field("end").value).toBe("2026-06-08");
    expect(status().textContent).toBe("2026-06-05 – 2026-06-08");
  });

  it("moves the roving stop to the first endpoint selected by click", async () => {
    await mount();

    click("2026-06-05");

    expect(cell("2026-06-05").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("-1");
  });

  it("auto-swaps when the second click precedes the first", async () => {
    await mount();
    click("2026-06-08");
    click("2026-06-05");
    expect(field("start").value).toBe("2026-06-05");
    expect(field("end").value).toBe("2026-06-08");
  });

  it("previews the range up to a hovered cell while selecting", async () => {
    await mount();
    click("2026-06-05"); // pending start
    hover("2026-06-09");
    expect(cell("2026-06-07").hasAttribute("data-in-range")).toBe(true);
    expect(cell("2026-06-09").hasAttribute("data-range-end")).toBe(true);
  });

  it("orders a reverse in-progress preview without changing the pending endpoint", async () => {
    await mount();
    click("2026-06-15");
    hover("2026-06-11");

    expect(cell("2026-06-11").hasAttribute("data-range-start")).toBe(true);
    expect(cell("2026-06-13").hasAttribute("data-in-range")).toBe(true);
    expect(cell("2026-06-15").hasAttribute("data-range-end")).toBe(true);
  });

  it("updates the pending preview as keyboard focus moves", async () => {
    await mount();
    click("2026-06-10");
    key(cell("2026-06-10"), "ArrowRight");
    key(cell("2026-06-11"), "ArrowRight");

    expect(cell("2026-06-11").hasAttribute("data-in-range")).toBe(true);
    expect(cell("2026-06-12").hasAttribute("data-range-end")).toBe(true);
  });

  it("does not preview an aria-disabled endpoint", async () => {
    await mount({ min: "2026-06-10" });
    click("2026-06-15");
    hover("2026-06-05");

    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(false);
    expect(cell("2026-06-15").hasAttribute("data-range-start")).toBe(true);
    expect(cell("2026-06-15").hasAttribute("data-range-end")).toBe(false);
  });

  it("does not tell assistive tech that a previewed cell is selected", async () => {
    // The preview is a pointer affordance, not a choice. Announcing the hovered
    // day as "selected" tells a screen-reader user the range is already set —
    // and the pending start is not committed either. Both live in `data-*`.
    await mount();
    click("2026-06-05"); // pending start
    hover("2026-06-09");

    expect(cell("2026-06-05").getAttribute("aria-selected")).toBe("false");
    expect(cell("2026-06-09").getAttribute("aria-selected")).toBe("false");
  });

  it("marks the confirmed endpoints, and only those, as selected", async () => {
    await mount();
    click("2026-06-05");
    click("2026-06-08");

    expect(cell("2026-06-05").getAttribute("aria-selected")).toBe("true");
    expect(cell("2026-06-08").getAttribute("aria-selected")).toBe("true");
    expect(cell("2026-06-07").getAttribute("aria-selected")).toBe("false");
  });

  it("declares the grid multi-selectable, since a range marks two cells", async () => {
    await mount();
    const grid = document.querySelector(
      "[data-stimeo--date-range-picker-target='grid']",
    ) as HTMLElement;

    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("cancels an in-progress selection on Escape, restoring the confirmed range", async () => {
    await mount();
    click("2026-06-05"); // pending start replaces preview
    key(cell("2026-06-05"), "Escape");
    // Confirmed range is shown again; the abandoned start is no longer marked.
    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(false);
    expect(cell("2026-06-10").getAttribute("aria-selected")).toBe("true");
    expect(field("start").value).toBe("2026-06-10");
  });

  it("keeps the pending start on an Escape that cancels an IME composition", async () => {
    await mount();
    click("2026-06-05");
    // Widget-local half of the shared layered-Escape contract: a composing
    // press steers the IME conversion and never clears the pending range.
    cell("2026-06-05").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }),
    );
    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(true);
  });

  it("leaves a modified arrow to the browser", async () => {
    // A chorded arrow belongs to the browser (history back/forward), not the grid:
    // the press is neither cancelled nor allowed to move the roving tab stop.
    // The local `key` helper builds a non-cancelable event, which could not report
    // a claim either way, so the event is built here.
    await mount();
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("0");

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    cell("2026-06-10").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("-1");
  });

  it("moves roving focus with the arrow keys", async () => {
    await mount();
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-10"), "ArrowRight");
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("-1");
    key(cell("2026-06-11"), "ArrowDown");
    expect(cell("2026-06-18").getAttribute("tabindex")).toBe("0");
  });

  it("re-rolls the roving tab stop when focus lands on a non-stop cell", async () => {
    await mount();
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("0"); // initial stop

    // External focus (Tab / click / programmatic) onto a different, non-stop cell
    // must move the roving tab stop to it, not leave it stale until the next paint.
    cell("2026-06-15").dispatchEvent(new FocusEvent("focus"));
    expect(cell("2026-06-15").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("-1");
  });

  it("leaves the roving stop untouched when focus lands on the current stop", async () => {
    // The guard re-rolls only for a non-stop cell. After the grid's own arrow
    // navigation focuses the new stop, that focus event must be a no-op (the cell
    // is already the tab stop) — this is what prevents a redundant double-render.
    await mount();
    key(cell("2026-06-10"), "ArrowRight"); // roving stop → 06-11, which is focused
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");

    cell("2026-06-11").dispatchEvent(new FocusEvent("focus")); // the focus a real focus() fires
    // Still the only stop; nothing shifted.
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("-1");
  });

  it("renders only once for a same-month keyboard preview move", async () => {
    await mount();
    const label = monthLabel();
    const textContent = Object.getOwnPropertyDescriptor(Element.prototype, "textContent");
    if (!textContent?.get || !textContent.set) {
      throw new Error("Expected Element.textContent accessors");
    }
    let renders = 0;
    Object.defineProperty(label, "textContent", {
      configurable: true,
      get: () => textContent.get?.call(label),
      set: (value: string | null) => {
        renders += 1;
        textContent.set?.call(label, value);
      },
    });
    click("2026-06-10");
    renders = 0;

    key(cell("2026-06-10"), "ArrowRight");

    expect(renders).toBe(1);
  });

  it("confirms a single-day range from the today preset", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    document
      .querySelector<HTMLElement>("[data-range='today']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(detail).toHaveLength(1);
    expect(detail[0]?.start).toBe(detail[0]?.end);
  });

  it("refuses a preset whose endpoint is an unavailable day", async () => {
    // The same date a click refuses cannot become a confirmed edge through a
    // preset either, or a cell ends up painted `aria-disabled="true"` while
    // holding the confirmed range.
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate(),
    ).padStart(2, "0")}`;
    await mount({ disabledDates: [todayIso], start: "", end: "" });
    const detail: unknown[] = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });

    document
      .querySelector<HTMLElement>("[data-range='today']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([]);
    expect(
      document.querySelector<HTMLInputElement>(
        "[data-stimeo--date-range-picker-target='startField']",
      )?.value,
    ).toBe("");
  });

  it("disables out-of-bounds cells", async () => {
    document.body.innerHTML = "";
    application = Application.start();
    application.register("stimeo--date-range-picker", DateRangePickerController);
    document.body.innerHTML = `
      <div data-controller="stimeo--date-range-picker"
           data-stimeo--date-range-picker-min-value="2026-06-05"
           data-stimeo--date-range-picker-max-value="2026-06-25">
        <span id="m" data-stimeo--date-range-picker-target="monthLabel"></span>
        <div role="grid" aria-labelledby="m"
             data-stimeo--date-range-picker-target="grid">${gridRows()}</div>
        <input type="hidden" value="2026-06-10" data-stimeo--date-range-picker-target="startField" />
        <input type="hidden" value="2026-06-20" data-stimeo--date-range-picker-target="endField" />
      </div>`;
    await tick();
    expect(cell("2026-06-04").getAttribute("aria-disabled")).toBe("true");
    expect(cell("2026-06-10").hasAttribute("aria-disabled")).toBe(false);
    // A click on a disabled cell does not start a selection.
    click("2026-06-04");
    expect(cell("2026-06-04").hasAttribute("data-range-start")).toBe(false);
  });

  it("disables a declared unavailable date inside the bounds", async () => {
    await mount({ disabledDates: ["2026-06-12"] });

    expect(cell("2026-06-12").getAttribute("aria-disabled")).toBe("true");
    expect(cell("2026-06-11").hasAttribute("aria-disabled")).toBe(false);
  });

  it("refuses a declared unavailable date from both commit paths", async () => {
    // The paint and the two commit paths read one predicate, so the cell being
    // marked and the cell being unselectable cannot drift apart.
    await mount({ disabledDates: ["2026-06-12"] });

    click("2026-06-12");
    expect(cell("2026-06-12").hasAttribute("data-range-start")).toBe(false);

    key(cell("2026-06-12"), "Enter");
    expect(cell("2026-06-12").hasAttribute("data-range-start")).toBe(false);
  });

  it("repaints when the declared unavailable set changes at runtime", async () => {
    await mount();
    expect(cell("2026-06-12").hasAttribute("aria-disabled")).toBe(false);

    root().setAttribute("data-stimeo--date-range-picker-disabled-dates-value", '["2026-06-12"]');
    await tick();
    expect(cell("2026-06-12").getAttribute("aria-disabled")).toBe("true");

    root().setAttribute("data-stimeo--date-range-picker-disabled-dates-value", "[]");
    await tick();
    expect(cell("2026-06-12").hasAttribute("aria-disabled")).toBe(false);
  });

  it("keeps unavailability attached to the date, not to the recycled cell", async () => {
    // The 42 cells are reused for different dates every month, so availability
    // that lived on the element would follow the wrong day after a navigation.
    await mount({ disabledDates: ["2026-07-04"] });
    const julyFourthInJune = cell("2026-07-04");
    expect(julyFourthInJune.getAttribute("aria-disabled")).toBe("true");

    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(julyFourthInJune.getAttribute("data-date")).not.toBe("2026-07-04");
    expect(julyFourthInJune.hasAttribute("aria-disabled")).toBe(false);
    expect(cell("2026-07-04").getAttribute("aria-disabled")).toBe("true");
  });

  it("spans a declared unavailable day rather than splitting the range", async () => {
    // `disabledDates` excludes endpoints, not interiors: a stay that runs over a
    // blacked-out day is still one range.
    await mount({ disabledDates: ["2026-06-15"] });

    click("2026-06-14");
    click("2026-06-16");

    expect(field("start").value).toBe("2026-06-14");
    expect(field("end").value).toBe("2026-06-16");
    expect(cell("2026-06-15").hasAttribute("data-in-range")).toBe(true);
  });

  it("leaves the preview in place when focus rests on an unavailable day", async () => {
    await mount({ disabledDates: ["2026-06-13"] });
    click("2026-06-11");
    hover("2026-06-12");

    hover("2026-06-13");
    expect(cell("2026-06-12").hasAttribute("data-range-end")).toBe(true);
    expect(cell("2026-06-13").hasAttribute("data-range-end")).toBe(false);

    hover("2026-06-14");
    expect(cell("2026-06-14").hasAttribute("data-range-end")).toBe(true);
    expect(cell("2026-06-13").hasAttribute("data-in-range")).toBe(true);
  });

  it("drops a preview endpoint that a tightened bound stranded mid-selection", async () => {
    await mount();
    click("2026-06-10");
    hover("2026-06-18");
    expect(cell("2026-06-18").hasAttribute("data-range-end")).toBe(true);

    root().setAttribute("data-stimeo--date-range-picker-max-value", "2026-06-14");
    await tick();

    expect(cell("2026-06-18").hasAttribute("data-range-end")).toBe(false);
    expect(cell("2026-06-10").hasAttribute("data-range-start")).toBe(true);
  });

  it("applies max inclusively and blocks dates after it", async () => {
    await mount({ max: "2026-06-15" });

    expect(cell("2026-06-15").getAttribute("aria-disabled")).toBeNull();
    expect(cell("2026-06-16").getAttribute("aria-disabled")).toBe("true");
    click("2026-06-16");
    expect(cell("2026-06-16").hasAttribute("data-range-start")).toBe(false);
  });

  it("anchors an empty picker at a future minimum", async () => {
    await mount({ start: "", end: "", min: "2099-03-15" });

    expect(monthLabel().textContent).toBe("March 2099");
    expect(cell("2099-03-15").getAttribute("tabindex")).toBe("0");
  });

  it("anchors an empty picker at a past maximum", async () => {
    await mount({ start: "", end: "", max: "2000-03-15" });

    expect(monthLabel().textContent).toBe("March 2000");
    expect(cell("2000-03-15").getAttribute("tabindex")).toBe("0");
  });

  it("keeps one tab stop when fewer than 42 cells are authored", async () => {
    await mount({ cellCount: 8, start: "2026-06-20", end: "2026-06-25" });

    expect(document.querySelectorAll("[data-date]")).toHaveLength(8);
    expect(root().querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("removes a second tab stop from cells beyond the 42-cell grid", async () => {
    await mount({ cellCount: 43 });
    const targets = root().querySelectorAll<HTMLElement>(
      "[data-stimeo--date-range-picker-target='cell']",
    );
    const extra = targets[42];
    if (!extra) throw new Error("Expected the extra date-range-picker cell");
    extra.setAttribute("tabindex", "0");

    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(root().querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(extra.getAttribute("tabindex")).toBe("-1");
  });

  it("renders a localized month label and navigates with prev/next", async () => {
    await mount();
    expect(monthLabel().textContent).toBe("June 2026");
    navButton("prev").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(monthLabel().textContent).toBe("May 2026");
    expect(cell("2026-05-15")).not.toBeNull();
    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(monthLabel().textContent).toBe("July 2026");
  });

  it("reports each painted month change after the cells are updated", async () => {
    await mount();
    const details: Array<{ month: string; firstDate: string | null }> = [];
    root().addEventListener("stimeo--date-range-picker:monthchange", (event) => {
      details.push({
        month: (event as CustomEvent<{ month: string }>).detail.month,
        firstDate:
          root().querySelector<HTMLElement>("[data-date]")?.getAttribute("data-date") ?? null,
      });
    });

    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    navButton("prev").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(details).toEqual([
      { month: "2026-07", firstDate: "2026-06-28" },
      { month: "2026-06", firstDate: "2026-05-31" },
    ]);
  });

  it("lets a monthchange listener feed the painted month's availability back in", async () => {
    // The event reports a paint; the answer returns through the Value, so the
    // repaint is the controller's own rather than a listener writing cells.
    await mount();
    root().addEventListener("stimeo--date-range-picker:monthchange", (event) => {
      const { month } = (event as CustomEvent<{ month: string }>).detail;
      root().setAttribute(
        "data-stimeo--date-range-picker-disabled-dates-value",
        JSON.stringify([`${month}-04`]),
      );
    });

    navButton("next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(cell("2026-07-04").getAttribute("aria-disabled")).toBe("true");
    click("2026-07-04");
    expect(cell("2026-07-04").hasAttribute("data-range-start")).toBe(false);
  });

  it("resolves a cross-month preview in the paint that crosses the boundary", async () => {
    // The target month is not on screen when the key is handled, so this only
    // works because availability comes from the Values rather than the cells.
    await mount({ disabledDates: ["2026-07-01"] });
    click("2026-06-30");

    key(cell("2026-06-30"), "ArrowRight");
    await tick();

    expect(cell("2026-07-01").getAttribute("aria-disabled")).toBe("true");
    expect(cell("2026-07-01").hasAttribute("data-range-end")).toBe(false);
    expect(cell("2026-06-30").hasAttribute("data-range-start")).toBe(true);

    key(cell("2026-07-01"), "ArrowRight");
    expect(cell("2026-07-02").hasAttribute("data-range-end")).toBe(true);
  });

  it("confirms a range over two cells via Enter, moving focus with arrows", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    key(cell("2026-06-10"), "Enter"); // pending start
    key(cell("2026-06-10"), "ArrowRight"); // roving focus → 06-11
    expect(cell("2026-06-11").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-11"), " "); // Space confirms
    expect(detail).toEqual([{ start: "2026-06-10", end: "2026-06-11" }]);
  });

  it("moves to week edges with Home/End", async () => {
    await mount();
    // 2026-06-10 is a Wednesday; the week runs Sun 06-07 … Sat 06-13.
    key(cell("2026-06-10"), "Home");
    expect(cell("2026-06-07").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-07"), "End");
    expect(cell("2026-06-13").getAttribute("tabindex")).toBe("0");
  });

  it("moves up a week and crosses months with PageUp", async () => {
    await mount();
    key(cell("2026-06-10"), "ArrowUp"); // → 06-03
    expect(cell("2026-06-03").getAttribute("tabindex")).toBe("0");
    key(cell("2026-06-03"), "PageUp"); // → 05-03 (month transition, deferred focus)
    await tick();
    expect(monthLabel().textContent).toBe("May 2026");
    expect(cell("2026-05-03").getAttribute("tabindex")).toBe("0");
  });

  it("moves by one month with PageDown when Shift is not held", async () => {
    await mount();

    key(cell("2026-06-10"), "PageDown");
    await tick();

    expect(monthLabel().textContent).toBe("July 2026");
    expect(cell("2026-07-10").getAttribute("tabindex")).toBe("0");
  });

  it("moves by year with Shift+PageUp and Shift+PageDown", async () => {
    await mount();
    key(cell("2026-06-10"), "PageDown", { shiftKey: true });
    await tick();
    expect(monthLabel().textContent).toBe("June 2027");
    expect(cell("2027-06-10").getAttribute("tabindex")).toBe("0");

    key(cell("2027-06-10"), "PageUp", { shiftKey: true });
    await tick();
    expect(monthLabel().textContent).toBe("June 2026");
    expect(cell("2026-06-10").getAttribute("tabindex")).toBe("0");
  });

  it("clamps a leap day when Shift+PageDown moves to a non-leap year", async () => {
    await mount({ start: "2024-02-29", end: "2024-02-29" });

    key(cell("2024-02-29"), "PageDown", { shiftKey: true });
    await tick();

    expect(monthLabel().textContent).toBe("February 2025");
    expect(cell("2025-02-28").getAttribute("tabindex")).toBe("0");
  });

  it("applies the last-7-days preset as a 7-day range ending today", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    // Mirror the controller's own date math so the test is timezone/run-date safe.
    const today = new Date();
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const start = new Date(today);
    start.setDate(today.getDate() - 6);

    preset("last7").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([{ start: iso(start), end: iso(today) }]);
  });

  it("focuses the confirmed endpoint after applying a preset", async () => {
    await mount();
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    preset("today").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(cell(todayISO)).toBe(document.activeElement);
    expect(cell(todayISO).getAttribute("tabindex")).toBe("0");
  });

  it("publishes the preset endpoint as the roving stop before monthchange", async () => {
    await mount({ start: "1900-01-01", end: "1900-01-02" });
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
    let stopDuringEvent: string | null = null;
    root().addEventListener("stimeo--date-range-picker:monthchange", () => {
      stopDuringEvent =
        root().querySelector<HTMLElement>('[tabindex="0"]')?.getAttribute("data-date") ?? null;
    });

    preset("thisMonth").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(stopDuringEvent).toBe(expected);
  });

  it("intersects the last-7-days preset with min", async () => {
    const today = new Date();
    const minDate = new Date(today);
    minDate.setDate(today.getDate() - 3);
    const iso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    await mount({ min: iso(minDate) });
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (event) => {
      detail.push((event as CustomEvent<{ start: string; end: string }>).detail);
    });

    preset("last7").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([{ start: iso(minDate), end: iso(today) }]);
  });

  it("intersects the last-7-days preset with max", async () => {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 6);
    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() - 3);
    const iso = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    await mount({ max: iso(maxDate) });
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (event) => {
      detail.push((event as CustomEvent<{ start: string; end: string }>).detail);
    });

    preset("last7").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([{ start: iso(startDate), end: iso(maxDate) }]);
  });

  it("ignores a preset that has no overlap with the selectable interval", async () => {
    await mount({ max: "2000-01-01" });
    const detail: unknown[] = [];
    root().addEventListener("stimeo--date-range-picker:change", (event) => {
      detail.push((event as CustomEvent).detail);
    });

    preset("last7").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([]);
    expect(field("start").value).toBe("2026-06-10");
    expect(field("end").value).toBe("2026-06-20");
  });

  it("applies the this-month preset spanning the whole current month", async () => {
    await mount();
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    preset("thisMonth").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(detail).toEqual([{ start: iso(first), end: iso(last) }]);
  });

  it("ignores an unknown preset name", async () => {
    await mount();
    const detail: unknown[] = [];
    root().addEventListener("stimeo--date-range-picker:change", (e) => {
      detail.push((e as CustomEvent).detail);
    });
    preset("nope").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(detail).toEqual([]);
  });

  it("rewinds an in-progress range before Turbo caches the page", async () => {
    await mount();
    click("2026-06-05");
    hover("2026-06-08");
    expect(cell("2026-06-08").hasAttribute("data-range-end")).toBe(true);

    document.dispatchEvent(new CustomEvent("turbo:before-cache"));

    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(false);
    expect(cell("2026-06-10").hasAttribute("data-range-start")).toBe(true);
    expect(cell("2026-06-20").hasAttribute("data-range-end")).toBe(true);
  });

  it("does not repaint an idle range before Turbo caches the page", async () => {
    await mount();
    const label = monthLabel();
    const textContent = Object.getOwnPropertyDescriptor(Element.prototype, "textContent");
    if (!textContent?.get || !textContent.set) {
      throw new Error("Expected Element.textContent accessors");
    }
    let renders = 0;
    Object.defineProperty(label, "textContent", {
      configurable: true,
      get: () => textContent.get?.call(label),
      set: (value: string | null) => {
        renders += 1;
        textContent.set?.call(label, value);
      },
    });

    document.dispatchEvent(new CustomEvent("turbo:before-cache"));

    expect(renders).toBe(0);
  });

  it("unsubscribes the cache rewind on disconnect", async () => {
    await mount();
    click("2026-06-05");
    hover("2026-06-08");
    controller().disconnect();

    document.dispatchEvent(new CustomEvent("turbo:before-cache"));

    expect(cell("2026-06-05").hasAttribute("data-range-start")).toBe(true);
    expect(cell("2026-06-08").hasAttribute("data-range-end")).toBe(true);
  });

  it("cancels a deferred month-transition focus on disconnect", async () => {
    await mount();
    key(cell("2026-06-10"), "PageUp");
    const target = cell("2026-05-10");
    const focused = vi.fn();
    target.addEventListener("focus", focused);

    controller().disconnect();
    await tick();

    expect(focused).not.toHaveBeenCalled();
  });

  it("selects and announces without hidden fields", async () => {
    await mount({ includeFields: false });
    const detail: Array<{ start: string; end: string }> = [];
    root().addEventListener("stimeo--date-range-picker:change", (event) => {
      detail.push((event as CustomEvent<{ start: string; end: string }>).detail);
    });
    const rendered = Array.from(root().querySelectorAll<HTMLElement>("[data-date]"));
    const start = rendered[0]?.getAttribute("data-date");
    const end = rendered[1]?.getAttribute("data-date");
    if (!start || !end) throw new Error("Expected at least two rendered dates");

    click(start);
    click(end);

    expect(detail).toEqual([{ start, end }]);
    expect(status().textContent).toBe(`${start} – ${end}`);
  });

  it("keeps multiple picker instances isolated", async () => {
    await mount();
    root().insertAdjacentHTML(
      "afterend",
      `<div id="second-picker" data-controller="stimeo--date-range-picker">
        <span id="second-month" data-stimeo--date-range-picker-target="monthLabel"></span>
        <div role="grid" aria-labelledby="second-month"
             data-stimeo--date-range-picker-target="grid">${gridRows()}</div>
        <input type="hidden" value="2027-01-10" data-stimeo--date-range-picker-target="startField" />
        <input type="hidden" value="2027-01-20" data-stimeo--date-range-picker-target="endField" />
      </div>`,
    );
    await tick();
    const second = document.getElementById("second-picker");
    if (!second) throw new Error("Expected the second date-range-picker instance");
    const secondStart = second.querySelector<HTMLInputElement>(
      "[data-stimeo--date-range-picker-target='startField']",
    );
    const secondEnd = second.querySelector<HTMLInputElement>(
      "[data-stimeo--date-range-picker-target='endField']",
    );

    click("2026-06-05");
    click("2026-06-08");

    expect(secondStart?.value).toBe("2027-01-10");
    expect(secondEnd?.value).toBe("2027-01-20");
    expect(second.querySelectorAll('[aria-selected="true"]')).toHaveLength(2);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount();
    await expectNoA11yViolations(root());
  });

  // Speech-order regression scoped to a range endpoint. Pins the gridcell role,
  // the accessible name (the day number), and the selected state so a lost
  // role/name or a dropped aria-selected surfaces as a diff.
  it("announces the endpoint cell's role, name, and selected state", async () => {
    await mount();
    const spoken = await captureSpeech({ container: cell("2026-06-10"), steps: 0 });
    expect(spoken).toEqual(["gridcell, 10, selected"]);
  });

  it("follows min swapped in place by a morph", async () => {
    // The bound decides which day cells are disabled, so a morph that tightens it
    // has to reach the rendered calendar — `connect()` does not run again.
    await mount();
    const picker = document.querySelector(
      "[data-controller='stimeo--date-range-picker']",
    ) as HTMLElement;
    expect(cell("2026-06-05").getAttribute("aria-disabled")).toBeNull();
    picker.setAttribute("data-stimeo--date-range-picker-min-value", "2026-06-10");
    await tick();
    expect(cell("2026-06-05").getAttribute("aria-disabled")).toBe("true");
  });
});
