import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterController } from "../src/controllers/filter_controller";
import { ToggleGroupController } from "../src/controllers/toggle_group_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FilterController}: initial all-visible state, AND/ANY
 * token matching, native-change reactivity, the apply/clear actions, group + empty
 * syncing, the change event payload and when it is reported, machine a11y, and
 * disconnect teardown.
 */

describe("FilterController", () => {
  let application: Application;

  const mount = async (inner: string, attrs = "") => {
    document.body.innerHTML = `<div data-controller="stimeo--filter" ${attrs}>${inner}</div>`;
    application = Application.start();
    application.register("stimeo--filter", FilterController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () => query<HTMLElement>("[data-controller='stimeo--filter']");
  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--filter-target='item']"));
  const controllerFor = () =>
    application.getControllerForElementAndIdentifier(root(), "stimeo--filter") as FilterController;
  // A checkbox control whose token is its data-value; toggling it bubbles a change.
  const control = (token: string) =>
    `<input type="checkbox" data-stimeo--filter-target="control" data-value="${token}">`;
  const item = (tokens: string) =>
    `<div data-stimeo--filter-target="item" data-stimeo--filter-tokens="${tokens}"></div>`;

  const setChecked = (el: HTMLInputElement, checked: boolean) => {
    el.checked = checked;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("shows every item while no control is active", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("hides items that lack the active token (single facet)", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    setChecked(query<HTMLInputElement>("input"), true);

    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);
  });

  it("combines multiple active tokens with AND by default (match=all)", async () => {
    await mount(`${control("a")}${control("b")}${item("a b")}${item("a")}`);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    for (const input of inputs) setChecked(input, true);

    expect(items()[0]?.hidden).toBe(false); // has both a and b
    expect(items()[1]?.hidden).toBe(true); // missing b
  });

  it("combines with OR when match='any'", async () => {
    await mount(
      `${control("a")}${control("b")}${item("a")}${item("c")}`,
      'data-stimeo--filter-match-value="any"',
    );
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    for (const input of inputs) setChecked(input, true);

    expect(items()[0]?.hidden).toBe(false); // matches a
    expect(items()[1]?.hidden).toBe(true); // matches neither a nor b
  });

  it("reads aria-pressed button controls when apply() is invoked", async () => {
    await mount(
      `<button type="button" aria-pressed="false" data-value="a"
               data-stimeo--filter-target="control">A</button>
       ${item("a")}${item("b")}`,
    );
    // Buttons emit no native change; the consumer wires their event to apply().
    query<HTMLButtonElement>("button").setAttribute("aria-pressed", "true");
    controllerFor().apply();

    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);
  });

  it("hides a group with no visible item and reveals the empty element", async () => {
    await mount(
      `${control("a")}
       <section data-stimeo--filter-target="group">${item("b")}</section>
       <p data-stimeo--filter-target="empty" hidden>none</p>`,
    );
    setChecked(query<HTMLInputElement>("input"), true);

    expect(query<HTMLElement>("[data-stimeo--filter-target='group']").hidden).toBe(true);
    expect(query<HTMLElement>("[data-stimeo--filter-target='empty']").hidden).toBe(false);
  });

  it("clear() turns every control off and restores all items", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    const checkbox = query<HTMLInputElement>("input");
    setChecked(checkbox, true);
    expect(items()[1]?.hidden).toBe(true);

    controllerFor().clear();

    expect(checkbox.checked).toBe(false);
    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("dispatches stimeo--filter:change with the active tokens and counts", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    // Attach after connect so we capture only the change-driven evaluation.
    const onChange = vi.fn();
    root().addEventListener("stimeo--filter:change", onChange);
    setChecked(query<HTMLInputElement>("input"), true);

    expect(onChange).toHaveBeenCalled();
    const detail = onChange.mock.calls[0]?.[0]?.detail;
    expect(detail?.active).toEqual(["a"]);
    expect(detail?.visibleCount).toBe(1);
    expect(detail?.total).toBe(2);
  });

  it("clear() un-presses aria-pressed button controls (not just checkboxes)", async () => {
    await mount(
      `<button type="button" aria-pressed="false" data-value="a"
               data-stimeo--filter-target="control">A</button>
       ${item("a")}${item("b")}`,
    );
    const button = query<HTMLButtonElement>("button");
    button.setAttribute("aria-pressed", "true");
    controllerFor().apply();
    expect(items()[1]?.hidden).toBe(true);

    controllerFor().clear();

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("resolves a control's token from data-stimeo--filter-token, then the value", async () => {
    await mount(
      `<input type="checkbox" data-stimeo--filter-target="control"
              data-stimeo--filter-token="a">
       <input type="checkbox" value="b" data-stimeo--filter-target="control">
       ${item("a")}${item("b")}`,
      'data-stimeo--filter-match-value="any"',
    );
    const explicit = query<HTMLInputElement>("[data-stimeo--filter-token='a']");
    const valueOnly = query<HTMLInputElement>("input[value='b']");

    // Explicit data-stimeo--filter-token wins.
    setChecked(explicit, true);
    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);

    // With no data-* token, the control falls back to its `value` attribute.
    setChecked(explicit, false);
    setChecked(valueOnly, true);
    expect(items()[0]?.hidden).toBe(true);
    expect(items()[1]?.hidden).toBe(false);
  });

  it("has no machine-detectable a11y violations", async () => {
    await mount(
      `<div role="group" aria-label="Filters">
         <button type="button" aria-pressed="true" data-value="a"
                 data-stimeo--filter-target="control">Tag A</button>
       </div>
       <ul>
         <li data-stimeo--filter-target="item" data-stimeo--filter-tokens="a">Item A</li>
         <li data-stimeo--filter-target="item" data-stimeo--filter-tokens="b">Item B</li>
       </ul>
       <p role="status" data-stimeo--filter-target="empty" hidden>No matches</p>`,
    );
    await expectNoA11yViolations(root());
  });

  it("re-evaluates when the match declaration changes at runtime", async () => {
    // A morph swaps the attribute on the live element without re-running connect,
    // and the declaration decides which items are shown — so the display has to
    // follow it rather than wait for the next control interaction.
    await mount(`${control("a")}${control("b")}${item("a")}${item("c")}`);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    for (const input of inputs) setChecked(input, true);
    expect(items()[0]?.hidden).toBe(true); // AND: "a" alone does not carry "b"

    root().setAttribute("data-stimeo--filter-match-value", "any");
    await tick();

    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);
  });

  it("evaluates once on connect, not once per declaration callback", async () => {
    // Stimulus delivers the value callback before connect, so an ungated one
    // would make merely connecting emit an extra evaluation.
    document.body.innerHTML = `<div data-controller="stimeo--filter" data-stimeo--filter-match-value="any">${control("a")}${item("a")}${item("b")}</div>`;
    const seen: unknown[] = [];
    root().addEventListener("stimeo--filter:change", (event) => {
      seen.push((event as CustomEvent).detail);
    });
    application = Application.start();
    application.register("stimeo--filter", FilterController);
    await tick();

    expect(seen).toHaveLength(1);
  });

  it("shows every item under match='any' while no control is active", async () => {
    // The empty-active guard is the only thing keeping "any" from hiding
    // everything: an empty set satisfies "every" by vacuity but never "some".
    await mount(`${control("a")}${item("a")}${item("b")}`, 'data-stimeo--filter-match-value="any"');

    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("takes no token from a non-input control that declares none", async () => {
    // The value fallback is for form controls; a button's `value` is not a facet
    // declaration, so such a control contributes nothing and nothing is filtered.
    await mount(
      `<button type="button" aria-pressed="true" value="a"
               data-stimeo--filter-target="control">A</button>
       ${item("a")}${item("b")}`,
    );

    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("evaluates the authored control state on connect", async () => {
    // The restore path: a control that arrives already on has to filter before
    // anyone interacts, and the initial evaluation has to report itself.
    document.body.innerHTML = `<div data-controller="stimeo--filter"><input type="checkbox" checked data-stimeo--filter-target="control" data-value="a">${item("a")}${item("b")}</div>`;
    const seen: Array<{ active: string[]; visibleCount: number; total: number }> = [];
    root().addEventListener("stimeo--filter:change", (event) => {
      seen.push(
        (event as CustomEvent<{ active: string[]; visibleCount: number; total: number }>).detail,
      );
    });
    application = Application.start();
    application.register("stimeo--filter", FilterController);
    await tick();

    expect(items()[0]?.hidden).toBe(false);
    expect(items()[1]?.hidden).toBe(true);
    expect(seen).toEqual([{ active: ["a"], visibleCount: 1, total: 2 }]);
  });

  it("removes its change listener on disconnect (teardown)", async () => {
    await mount(`${control("a")}${item("a")}${item("b")}`);
    controllerFor().disconnect();

    // After teardown, toggling a control + firing change must NOT re-filter.
    const checkbox = query<HTMLInputElement>("input");
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  // --- Reporting a moved outcome ---

  /**
   * `change` reports the outcome of an evaluation — the active tokens and the
   * counts they leave visible — when it moves from the one last reported. An
   * evaluation that lands where the last report left off reports nothing; the
   * first one after connect always reports.
   */
  describe("reporting a moved outcome", () => {
    type Outcome = { active: string[]; visibleCount: number; total: number };
    const heard: Outcome[] = [];

    /** Records every `change` from the current root, after connect. */
    const listen = (): void => {
      heard.length = 0;
      root().addEventListener("stimeo--filter:change", (event) => {
        heard.push((event as CustomEvent<Outcome>).detail);
      });
    };

    const checkboxes = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));

    it("reports a native change that moves the outcome once, and one that moves nothing, never", async () => {
      await mount(`${control("a")}${control("b")}${item("a")}${item("b")}`);
      listen();

      setChecked(checkboxes()[0] as HTMLInputElement, true);
      expect(heard).toEqual([{ active: ["a"], visibleCount: 1, total: 2 }]);

      // The same box reported again, and a change bubbling from outside the controls.
      checkboxes()[0]?.dispatchEvent(new Event("change", { bubbles: true }));
      root().dispatchEvent(new Event("change", { bubbles: true }));
      expect(heard).toHaveLength(1);

      setChecked(checkboxes()[0] as HTMLInputElement, false);
      expect(heard).toEqual([
        { active: ["a"], visibleCount: 1, total: 2 },
        { active: [], visibleCount: 2, total: 2 },
      ]);
    });

    it("reports a button pressed through apply once, and a repeated apply never", async () => {
      await mount(
        `<button type="button" aria-pressed="false" data-value="a"
                 data-stimeo--filter-target="control">A</button>
         ${item("a")}${item("b")}`,
      );
      listen();

      query<HTMLButtonElement>("button").setAttribute("aria-pressed", "true");
      controllerFor().apply();
      controllerFor().apply();

      expect(heard).toEqual([{ active: ["a"], visibleCount: 1, total: 2 }]);
    });

    it("reports a new active set even when the visible count stays", async () => {
      await mount(`${control("a")}${item("a b")}${item("a")}`);
      listen();

      // Both items carry "a", so turning it on keeps both visible.
      setChecked(checkboxes()[0] as HTMLInputElement, true);

      expect(items().every((node) => !node.hidden)).toBe(true);
      expect(heard).toEqual([{ active: ["a"], visibleCount: 2, total: 2 }]);
    });

    it("reports a switch to another token that leaves as many items visible", async () => {
      await mount(
        `<input type="radio" name="facet" value="a" data-stimeo--filter-target="control" checked>
         <input type="radio" name="facet" value="b" data-stimeo--filter-target="control">
         ${item("a")}${item("b")}`,
      );
      listen();

      // One active token before and after, one item visible before and after: only
      // which token is active moves, and with it which item is shown.
      const [first, second] = Array.from(
        document.querySelectorAll<HTMLInputElement>("input[type='radio']"),
      );
      setChecked(second as HTMLInputElement, true);

      expect(first?.checked).toBe(false);
      expect(items().map((node) => node.hidden)).toEqual([true, false]);
      expect(heard).toEqual([{ active: ["b"], visibleCount: 1, total: 2 }]);
    });

    it("reports items that came or changed tokens even when the active set stays", async () => {
      await mount(`${control("a")}${item("a")}${item("b")}`);
      setChecked(checkboxes()[0] as HTMLInputElement, true);
      listen();

      root().insertAdjacentHTML("beforeend", item("c"));
      controllerFor().apply();
      items()[1]?.setAttribute("data-stimeo--filter-tokens", "a");
      controllerFor().apply();

      expect(heard).toEqual([
        { active: ["a"], visibleCount: 1, total: 3 },
        { active: ["a"], visibleCount: 2, total: 3 },
      ]);
    });

    it("syncs the group and the empty element on the move it reports, and a repeat changes neither", async () => {
      await mount(
        `${control("a")}
         <section data-stimeo--filter-target="group">${item("b")}</section>
         <p data-stimeo--filter-target="empty" hidden>none</p>`,
      );
      listen();
      const group = query<HTMLElement>("[data-stimeo--filter-target='group']");
      const empty = query<HTMLElement>("[data-stimeo--filter-target='empty']");

      setChecked(checkboxes()[0] as HTMLInputElement, true);
      expect([group.hidden, empty.hidden]).toEqual([true, false]);
      controllerFor().apply();

      expect([group.hidden, empty.hidden]).toEqual([true, false]);
      expect(heard).toEqual([{ active: ["a"], visibleCount: 0, total: 1 }]);
    });

    it("reports a match change that moves the outcome, and not one that leaves it", async () => {
      await mount(`${control("a")}${control("b")}${item("a")}${item("c")}`);
      setChecked(checkboxes()[0] as HTMLInputElement, true);
      listen();

      // One active token selects the same items under either rule.
      root().setAttribute("data-stimeo--filter-match-value", "any");
      await tick();
      expect(heard).toEqual([]);

      setChecked(checkboxes()[1] as HTMLInputElement, true);
      root().setAttribute("data-stimeo--filter-match-value", "all");
      await tick();
      expect(heard).toEqual([
        { active: ["a", "b"], visibleCount: 1, total: 2 },
        { active: ["a", "b"], visibleCount: 0, total: 2 },
      ]);
    });

    it("reports the first evaluation after it connects again, even unmoved", async () => {
      await mount(`${control("a")}${item("a")}${item("b")}`);
      const host = root();
      const seen: Outcome[] = [];
      host.addEventListener("stimeo--filter:change", (event) => {
        seen.push((event as CustomEvent<Outcome>).detail);
      });

      host.removeAttribute("data-controller");
      await tick();
      host.setAttribute("data-controller", "stimeo--filter");
      await tick();

      expect(seen).toEqual([{ active: [], visibleCount: 2, total: 2 }]);
    });
  });
});

/**
 * Integration of the cross-controller wiring: a toggle-group chip click
 * dispatches `stimeo--toggle-group:change`, and a pressed set the page moves
 * dispatches `stimeo--toggle-group:reconcile`; a `data-action` on the filter root
 * routes both to `stimeo--filter#apply`. Unit tests
 * above prove each controller in isolation; this proves they compose in the
 * exact shape used in practice (chip = toggle-group item AND filter control).
 */
describe("FilterController + ToggleGroupController wiring", () => {
  let application: Application;

  const items = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--filter-target='item']"));

  const mount = async (inner: string) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--filter" data-stimeo--filter-match-value="all"
           data-action="stimeo--toggle-group:change->stimeo--filter#apply
                        stimeo--toggle-group:reconcile->stimeo--filter#apply">${inner}</div>`;
    application = Application.start();
    application.register("stimeo--filter", FilterController);
    application.register("stimeo--toggle-group", ToggleGroupController);
    await tick();
  };

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("filters items when a chip is clicked (custom event → apply)", async () => {
    await mount(
      `<div role="group" aria-label="Tags" data-controller="stimeo--toggle-group">
         <button type="button" class="chip" aria-pressed="false" tabindex="0" data-value="a"
                 data-stimeo--toggle-group-target="item"
                 data-stimeo--filter-target="control"
                 data-action="click->stimeo--toggle-group#toggle
                              keydown->stimeo--toggle-group#onKeydown">A</button>
       </div>
       <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="a"></div>
       <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="b"></div>`,
    );
    const chip = query<HTMLButtonElement>(".chip");
    expect(items().every((node) => !node.hidden)).toBe(true);

    // Real click: toggle-group flips aria-pressed and dispatches its change event,
    // which the root data-action routes to filter#apply.
    chip.click();
    await tick();

    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(items()[0]?.hidden).toBe(false); // token "a" kept
    expect(items()[1]?.hidden).toBe(true); // token "b" filtered out

    // Clicking again releases the chip → every item returns.
    chip.click();
    await tick();

    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(items().every((node) => !node.hidden)).toBe(true);
  });

  it("re-filters when the page moves the pressed set (reconcile event → apply)", async () => {
    await mount(
      `<div role="group" aria-label="Tags" data-controller="stimeo--toggle-group">
         <button type="button" id="chip-a" aria-pressed="false" tabindex="0" data-value="a"
                 data-stimeo--toggle-group-target="item"
                 data-stimeo--filter-target="control">A</button>
         <button type="button" id="chip-b" aria-pressed="false" tabindex="-1" data-value="b"
                 data-stimeo--toggle-group-target="item"
                 data-stimeo--filter-target="control">B</button>
       </div>
       <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="a"></div>
       <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="b"></div>
       <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="a b"></div>`,
    );
    const visible = () => items().map((node) => !node.hidden);
    expect(visible()).toEqual([true, true, true]);

    // A script (or a morph) presses both chips: no click, so no change event —
    // the group reports the moved set as reconcile.
    query<HTMLButtonElement>("#chip-a").setAttribute("aria-pressed", "true");
    query<HTMLButtonElement>("#chip-b").setAttribute("aria-pressed", "true");
    await tick();
    expect(visible()).toEqual([false, false, true]);

    // Single mode keeps only the first pressed chip, which moves the set again.
    query<HTMLElement>("[data-controller='stimeo--toggle-group']").setAttribute(
      "data-stimeo--toggle-group-mode-value",
      "single",
    );
    await tick();
    expect(query<HTMLButtonElement>("#chip-b").getAttribute("aria-pressed")).toBe("false");
    expect(visible()).toEqual([true, false, true]);
  });

  // The recommended wiring (both events → apply) is what `mount` writes, so the
  // two tests below measure it exactly as the markup contract documents it.
  const chipsAndClear = (pressedA: "true" | "false") =>
    `<div role="group" aria-label="Tags" data-controller="stimeo--toggle-group">
       <button type="button" id="chip-a" aria-pressed="${pressedA}" tabindex="0" data-value="a"
               data-stimeo--toggle-group-target="item"
               data-stimeo--filter-target="control">A</button>
       <button type="button" id="chip-b" aria-pressed="false" tabindex="-1" data-value="b"
               data-stimeo--toggle-group-target="item"
               data-stimeo--filter-target="control">B</button>
     </div>
     <button type="button" id="clear" data-action="click->stimeo--filter#clear">Clear</button>
     <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="a"></div>
     <div data-stimeo--filter-target="item" data-stimeo--filter-tokens="b"></div>`;

  /** Records the filter's `change` and the group's `reconcile` from the filter root. */
  const recordAtRoot = () => {
    const seen: unknown[] = [];
    const repairs: unknown[] = [];
    const filterRoot = query<HTMLElement>("[data-controller='stimeo--filter']");
    filterRoot.addEventListener("stimeo--filter:change", (event) => {
      seen.push((event as CustomEvent).detail);
    });
    filterRoot.addEventListener("stimeo--toggle-group:reconcile", (event) => {
      repairs.push((event as CustomEvent).detail);
    });
    return { seen, repairs };
  };

  it("reports a chip press once, and clearing pressed chips once, though the group reports the move as well", async () => {
    await mount(chipsAndClear("false"));
    const { seen, repairs } = recordAtRoot();

    // A real press: the group reports it as change and nothing else follows.
    query<HTMLButtonElement>("#chip-a").click();
    await tick();
    expect(seen).toEqual([{ active: ["a"], visibleCount: 1, total: 2 }]);
    expect(repairs).toEqual([]);

    // clear() evaluates, and the chip it turned off reaches the group as a page
    // change, whose reconcile evaluates again to the same outcome.
    query<HTMLButtonElement>("#clear").click();
    await tick();
    await tick();
    expect(repairs).toEqual([{ values: [] }]);
    expect(seen).toEqual([
      { active: ["a"], visibleCount: 1, total: 2 },
      { active: [], visibleCount: 2, total: 2 },
    ]);

    // Nothing is pressed any more, so clearing again moves nothing.
    query<HTMLButtonElement>("#clear").click();
    await tick();
    expect(seen).toHaveLength(2);
  });

  it("reports clearing a chip the page rendered pressed once", async () => {
    await mount(chipsAndClear("true"));
    const { seen, repairs } = recordAtRoot();

    query<HTMLButtonElement>("#clear").click();
    await tick();
    await tick();

    expect(repairs).toEqual([{ values: [] }]);
    expect(seen).toEqual([{ active: [], visibleCount: 2, total: 2 }]);
  });
});
