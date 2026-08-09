import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { ToolbarController } from "../src/controllers/toolbar_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link ToolbarController}: the APG Toolbar — single Tab
 * stop (roving tabindex), arrow/Home/End navigation honoring orientation and
 * wrap, focus restoration to the most recently active control, and the runtime
 * boundaries where the lone Tab stop must be re-established (controls added,
 * removed, disabled, or hidden after connect).
 */

const LABELS = ["Bold", "Italic", "Underline"] as const;

/** One toolbar's markup knobs; every case is built from this single shape. */
interface ToolbarOptions {
  /** Extra attributes on the controller element (Values, aria-orientation, …). */
  attrs?: string;
  /** Per-control `tabindex`; `null`/absent omits the attribute entirely. */
  tabindexes?: readonly (string | null)[];
  /** Per-control extra attributes (`disabled`, `aria-disabled="true"`, `hidden`). */
  extras?: readonly string[];
  /** Control labels — also fixes how many controls the toolbar has. */
  labels?: readonly string[];
  /** Wire the legacy per-control `data-action` (delegation is always on). */
  action?: boolean;
  /** Accessible name; distinct names keep two toolbars readable in one document. */
  label?: string;
}

const markup = ({
  attrs = "",
  tabindexes = ["0", "-1", "-1"],
  extras = [],
  labels = LABELS,
  action = true,
  label = "Text formatting",
}: ToolbarOptions = {}) => {
  const controls = labels
    .map((text, index) => {
      const tabindex = tabindexes[index] ?? null;
      return `
      <button type="button" ${tabindex === null ? "" : `tabindex="${tabindex}"`} ${extras[index] ?? ""}
              data-stimeo--toolbar-target="control"
              ${action ? 'data-action="keydown->stimeo--toolbar#onKeydown"' : ""}>${text}</button>`;
    })
    .join("");
  return `
  <div data-controller="stimeo--toolbar" role="toolbar" aria-label="${label}" ${attrs}>${controls}
  </div>`;
};

describe("ToolbarController", () => {
  let application: Application;

  /** Mounts arbitrary toolbar markup and starts Stimulus over it. */
  const startMarkup = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--toolbar", ToolbarController);
    await tick();
  };

  /** Renders one toolbar per options object and starts Stimulus over them. */
  const startAll = async (...toolbars: ToolbarOptions[]) =>
    startMarkup(toolbars.map(markup).join(""));
  const start = async (options: ToolbarOptions = {}) => startAll(options);

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const roots = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-controller='stimeo--toolbar']"));
  const root = (index = 0) => roots()[index] as HTMLElement;
  const controls = (index = 0) =>
    Array.from(
      root(index).querySelectorAll<HTMLElement>("[data-stimeo--toolbar-target='control']"),
    );
  const tabindexes = (index = 0) => controls(index).map((control) => control.tabIndex);
  /** Dispatches a cancelable keydown and returns it so `defaultPrevented` is assertable. */
  const key = (index: number, k: string, toolbar = 0): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    controls(toolbar)[index]?.dispatchEvent(event);
    return event;
  };

  it("reverses the horizontal arrows under RTL", async () => {
    // Logical direction: APG describes these as "next / previous", so the pair
    // reverses with the writing direction. `dir="rtl"` is the authoring contract,
    // but happy-dom does not resolve it into the computed style, so the direction
    // is set as an inline style instead.
    await start();
    root().style.direction = "rtl";

    key(0, "ArrowLeft"); // "next" under RTL
    expect(document.activeElement).toBe(controls()[1]);

    key(1, "ArrowRight"); // "previous"
    expect(document.activeElement).toBe(controls()[0]);
  });

  it("leaves a vertical toolbar's arrows alone under RTL", async () => {
    // Only the horizontal pair carries a direction. Down/Up name an axis that
    // the writing direction does not mirror.
    await start({ attrs: 'data-stimeo--toolbar-orientation-value="vertical"' });
    root().style.direction = "rtl";

    key(0, "ArrowDown");
    expect(document.activeElement).toBe(controls()[1]);
  });

  it("makes only the first control a tab stop", async () => {
    await start();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("establishes the tab stop itself when no control declares tabindex", async () => {
    // Natively focusable elements are effectively tabindex=0 when the attribute
    // is absent, so an author who annotates only the intended entry point (here
    // the last control) silently gets the first one instead — the markup
    // contract is "all controls or none".
    await start({ tabindexes: [null, null, "0"] });
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("keeps a pre-existing tab stop as the entry point", async () => {
    await start({ tabindexes: ["-1", "0", "-1"] });
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("moves focus and the tab stop with horizontal arrows, wrapping", async () => {
    await start();
    expect(key(0, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls()[1]);
    expect(tabindexes()).toEqual([-1, 0, -1]);

    key(1, "ArrowRight"); // -> last
    key(2, "ArrowRight"); // wrap -> first
    expect(document.activeElement).toBe(controls()[0]);

    key(0, "ArrowLeft"); // wrap back -> last
    expect(document.activeElement).toBe(controls()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("jumps to first/last with Home/End", async () => {
    await start();
    expect(key(0, "End").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
    expect(key(2, "Home").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls()[0]);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("uses vertical arrows when orientation is vertical", async () => {
    await start({ attrs: 'data-stimeo--toolbar-orientation-value="vertical"' });
    key(0, "ArrowDown");
    expect(document.activeElement).toBe(controls()[1]);
    // Horizontal arrows are left to the control itself in vertical orientation.
    const event = key(1, "ArrowRight");
    expect(document.activeElement).toBe(controls()[1]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("clamps at the ends when wrap is false", async () => {
    await start({ attrs: 'data-stimeo--toolbar-wrap-value="false"' });
    controls()[0]?.focus();
    key(0, "ArrowLeft"); // already first -> focus and tab stop stay put
    expect(document.activeElement).toBe(controls()[0]);
    expect(tabindexes()).toEqual([0, -1, -1]);
    key(0, "End");
    controls()[2]?.focus();
    key(2, "ArrowRight"); // already last -> stays
    expect(document.activeElement).toBe(controls()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("navigates without any per-control data-action", async () => {
    // Keydown is delegated on the container, so markup that omits the legacy
    // data-action is fully navigable.
    await start({ action: false });
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[1]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("yields to a key a descendant widget already consumed", async () => {
    await start();
    root().addEventListener("keydown", (event) => event.preventDefault(), { capture: true });
    key(0, "ArrowRight");
    expect(document.activeElement).not.toBe(controls()[1]);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("leaves a modified arrow to the browser (Alt+Left/Right is history navigation)", async () => {
    await start();
    controls()[0]?.focus();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    controls()[0]?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(controls()[0]);
    expect(tabindexes()).toEqual([0, -1, -1]); // the lone tab stop stayed put
  });

  it("ignores arrow keys while an IME composition is in flight", async () => {
    await start();
    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    controls()[0]?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("skips a disabled control when navigating", async () => {
    await start({ extras: ["", "disabled", ""] });
    // ArrowRight from Bold must hop over the disabled Italic to Underline.
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("skips a hidden control when navigating", async () => {
    await start({ extras: ["", "hidden", ""] });
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("skips a control hidden by an ancestor, and never parks the tab stop there", async () => {
    // A `hidden` wrapper is ordinary authoring — a responsive group, a feature
    // flag, a collapsed section. Reading only the control's own attribute lets an
    // invisible control hold the toolbar's single Tab stop, which takes the whole
    // toolbar out of the Tab sequence. `tree-view` looks at ancestors for the same
    // reason (`#visibleItems`).
    await startMarkup(`
      <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting">
        <div hidden>
          <button type="button" tabindex="0" data-stimeo--toolbar-target="control"
                  data-action="keydown->stimeo--toolbar#onKeydown">Bold</button>
        </div>
        <button type="button" tabindex="-1" data-stimeo--toolbar-target="control"
                data-action="keydown->stimeo--toolbar#onKeydown">Italic</button>
        <button type="button" tabindex="-1" data-stimeo--toolbar-target="control"
                data-action="keydown->stimeo--toolbar#onKeydown">Underline</button>
      </div>`);

    // The authored entry point is invisible, so the tab stop moves to the first
    // control a user can actually reach.
    expect(tabindexes()).toEqual([-1, 0, -1]);

    key(1, "ArrowLeft"); // wrapping backwards must not land in the hidden wrapper
    expect(document.activeElement).toBe(controls()[2]);
  });

  it("keeps its tab stop when the whole toolbar sits in a hidden region", async () => {
    // The boundary that the ancestor walk deliberately stops at. Looking past the
    // controller element would find the wrapper and rule out *every* control, so
    // the toolbar would lose its lone Tab stop — and nothing brings it back: the
    // MutationObserver watches this element's own subtree, so un-hiding the region
    // never re-runs the check. A toolbar inside a `hidden` region is already out of
    // the page's Tab order, so there is nothing to fix by moving its tab stop.
    //
    // This is what makes the shared `canTakeFocus` (unbounded `closest("[hidden]")`)
    // the wrong rule here even though the rest of `#isNavigable` matches it: the
    // bounded walk is the toolbar's own rule, not an oversight.
    await startMarkup(`
      <div hidden>
        <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting">
          <button type="button" tabindex="0" data-stimeo--toolbar-target="control"
                  data-action="keydown->stimeo--toolbar#onKeydown">Bold</button>
          <button type="button" tabindex="-1" data-stimeo--toolbar-target="control"
                  data-action="keydown->stimeo--toolbar#onKeydown">Italic</button>
        </div>
      </div>`);

    expect(tabindexes()).toEqual([0, -1]);
  });

  it("re-establishes the tab stop when an ancestor is hidden at runtime", async () => {
    await startMarkup(`
      <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting">
        <div id="tb-group">
          <button type="button" tabindex="0" data-stimeo--toolbar-target="control"
                  data-action="keydown->stimeo--toolbar#onKeydown">Bold</button>
        </div>
        <button type="button" tabindex="-1" data-stimeo--toolbar-target="control"
                data-action="keydown->stimeo--toolbar#onKeydown">Italic</button>
      </div>`);
    expect(tabindexes()).toEqual([0, -1]);

    (document.getElementById("tb-group") as HTMLElement).hidden = true;
    await tick();

    expect(tabindexes()).toEqual([-1, 0]);
  });

  it("skips a control disabled by an ancestor fieldset", async () => {
    await start();
    const fieldset = document.createElement("fieldset");
    fieldset.disabled = true;
    const italic = controls()[1] as HTMLButtonElement;
    italic.replaceWith(fieldset);
    fieldset.appendChild(italic);
    await tick();
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[2]);
  });

  it("keeps non-form controls navigable inside a disabled fieldset", async () => {
    await startMarkup(`
      <fieldset disabled>
        <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Mixed actions">
          <button type="button" tabindex="0" data-stimeo--toolbar-target="control">Save</button>
          <a href="#help" tabindex="-1" data-stimeo--toolbar-target="control">Help</a>
          <div role="button" tabindex="-1" data-stimeo--toolbar-target="control">More</div>
        </div>
      </fieldset>`);

    expect(tabindexes()).toEqual([-1, 0, -1]);
    key(1, "ArrowRight");
    expect(document.activeElement).toBe(controls()[2]);
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("restores the tab stop when an enclosing fieldset is re-enabled", async () => {
    // The disabling attribute lives outside the observed subtree, so nothing
    // inside the toolbar changes when the form unlocks. Without watching the
    // ancestor the group keeps every control at -1 and stays unreachable by Tab.
    await startMarkup(`
      <fieldset disabled id="tb-fieldset">
        <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Text formatting">
          <button type="button" tabindex="0" data-stimeo--toolbar-target="control">Bold</button>
          <button type="button" tabindex="-1" data-stimeo--toolbar-target="control">Italic</button>
        </div>
      </fieldset>`);
    expect(tabindexes()).toEqual([-1, -1]);

    (document.getElementById("tb-fieldset") as HTMLFieldSetElement).disabled = false;
    await tick();

    expect(tabindexes()).toEqual([0, -1]);
  });

  it("checks every disabled fieldset ancestor after a first-legend exception", async () => {
    await startMarkup(`
      <fieldset disabled>
        <legend>Outer group</legend>
        <fieldset disabled>
          <legend>
            <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Nested actions">
              <button type="button" tabindex="0"
                      data-stimeo--toolbar-target="control">Nested save</button>
              <a href="#help" tabindex="-1"
                 data-stimeo--toolbar-target="control">Help</a>
            </div>
          </legend>
        </fieldset>
      </fieldset>`);

    expect(tabindexes()).toEqual([-1, 0]);
    expect(key(1, "ArrowLeft").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls()[1]);
  });

  it("uses only the first direct-child legend as the fieldset exception", async () => {
    await startMarkup(`
      <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Legend actions">
        <fieldset disabled>
          <legend>
            <button type="button" tabindex="0"
                    data-stimeo--toolbar-target="control">First legend</button>
          </legend>
          <legend>
            <button type="button" tabindex="-1"
                    data-stimeo--toolbar-target="control">Second legend</button>
          </legend>
        </fieldset>
      </div>`);

    expect(tabindexes()).toEqual([0, -1]);
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[0]);
  });

  it("does not treat a descendant legend as the fieldset exception", async () => {
    await startMarkup(`
      <fieldset disabled>
        <div data-controller="stimeo--toolbar" role="toolbar" aria-label="Nested actions">
          <fieldset>
            <legend>
              <button type="button" tabindex="0"
                      data-stimeo--toolbar-target="control">Nested legend</button>
            </legend>
          </fieldset>
          <button type="button" tabindex="-1"
                  data-stimeo--toolbar-target="control">Peer</button>
        </div>
      </fieldset>`);

    expect(tabindexes()).toEqual([-1, -1]);
  });

  it("moves the lone tab stop off a disabled first control", async () => {
    await start({ extras: ["disabled", "", ""] });
    // The disabled first control cannot be the tab stop; it moves to the next.
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("moves the tab stop when the control holding it is disabled after connect", async () => {
    await start();
    expect(tabindexes()).toEqual([0, -1, -1]);
    // A sibling controller owning the buttons' enabled state does exactly this.
    (controls()[0] as HTMLButtonElement).disabled = true;
    await tick();
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("moves the tab stop when the control holding it is removed", async () => {
    await start();
    controls()[0]?.remove();
    await tick();
    expect(tabindexes()).toEqual([0, -1]);
  });

  it("keeps a focused aria-disabled control in the roving order", async () => {
    await start();
    controls()[0]?.focus();
    controls()[0]?.setAttribute("aria-disabled", "true");
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1]);
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[1]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("moves onto an aria-disabled control with an arrow key", async () => {
    await start({ extras: ["", 'aria-disabled="true"', ""] });
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[1]);
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("reaches the ends from an aria-disabled control with Home/End", async () => {
    await start({ extras: ['aria-disabled="true"', "", ""] });
    key(0, "End");
    expect(document.activeElement).toBe(controls()[2]);
    key(2, "Home");
    // ARIA-disabled controls stay in the roving order; activation is separate.
    expect(document.activeElement).toBe(controls()[0]);
  });

  it("syncs the tab stop to a control focused by click or script", async () => {
    await start();
    controls()[2]?.focus();
    expect(tabindexes()).toEqual([-1, -1, 0]);
  });

  it("keeps a single tab stop when a control is appended at runtime", async () => {
    await start();
    const appended = controls()[0]?.cloneNode(true) as HTMLButtonElement;
    appended.removeAttribute("tabindex"); // a fresh <button> is tabbable by default
    root().appendChild(appended);
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1, -1]);
    key(3, "ArrowRight");
    expect(document.activeElement).toBe(controls()[0]);
  });

  it("recovers a tab stop when a control is re-enabled after all were disabled", async () => {
    await start({ extras: ["disabled", "disabled", "disabled"] });
    expect(tabindexes()).toEqual([-1, -1, -1]);
    (controls()[1] as HTMLButtonElement).disabled = false;
    await tick();
    expect(tabindexes()).toEqual([-1, 0, -1]);
  });

  it("connects to a toolbar that has no controls at all", async () => {
    // Reaching connect() with an empty target list must not throw: `setActive(-1)`
    // and the tab-stop re-establishment both run before any control exists.
    await start({ labels: [], tabindexes: [] });
    expect(controls()).toEqual([]);
  });

  it("keeps the lone control tabbable when it is the only one", async () => {
    await start({ labels: ["Bold"], tabindexes: ["0"] });
    expect(tabindexes()).toEqual([0]);
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[0]);
    expect(tabindexes()).toEqual([0]);
  });

  it("keeps two toolbars in one document independent", async () => {
    await startAll({}, { label: "Paragraph", attrs: 'data-stimeo--toolbar-wrap-value="false"' });
    key(0, "ArrowRight", 0);
    expect(tabindexes(0)).toEqual([-1, 0, -1]);
    expect(tabindexes(1)).toEqual([0, -1, -1]);

    key(0, "End", 1);
    expect(tabindexes(1)).toEqual([-1, -1, 0]);
    expect(tabindexes(0)).toEqual([-1, 0, -1]);
    expect(document.activeElement).toBe(controls(1)[2]);
  });

  it("stops navigating once the controller is unloaded", async () => {
    await start();
    controls()[0]?.focus();
    application.unload("stimeo--toolbar");
    await tick();
    key(0, "ArrowRight");
    expect(document.activeElement).toBe(controls()[0]);
    expect(tabindexes()).toEqual([0, -1, -1]);
    // A state change after teardown must not re-establish anything either.
    (controls()[0] as HTMLButtonElement).disabled = true;
    await tick();
    expect(tabindexes()).toEqual([0, -1, -1]);
  });

  it("announces role, name, and orientation in order", async () => {
    await start();
    const phrases = await captureSpeech({ container: root(), steps: 4 });
    expect(phrases).toEqual([
      "toolbar, Text formatting, orientated horizontally",
      "button, Bold",
      "button, Italic",
      "button, Underline",
      "end of toolbar, Text formatting, orientated horizontally",
    ]);
  });

  it("announces an authored vertical toolbar as vertical", async () => {
    // aria-orientation is the *author's* contract (like role); this pins that a
    // vertical toolbar written per the contract is announced as such.
    await start({
      attrs: 'aria-orientation="vertical" data-stimeo--toolbar-orientation-value="vertical"',
    });
    const phrases = await captureSpeech({ container: root(), steps: 4 });
    expect(phrases).toEqual([
      "toolbar, Text formatting, orientated vertically",
      "button, Bold",
      "button, Italic",
      "button, Underline",
      "end of toolbar, Text formatting, orientated vertically",
    ]);
  });

  it("has no machine-detectable a11y violations", async () => {
    await start();
    await expectNoA11yViolations(root());
  });
});
