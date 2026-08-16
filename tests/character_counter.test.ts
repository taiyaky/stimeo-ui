import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController } from "../src/controllers/announcer_controller";
import { CharacterCounterController } from "../src/controllers/character_counter_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Must match the controller's private announcement debounce. */
const ANNOUNCE_MS = 200;

interface ChangeDetail {
  readonly length: number;
  readonly remaining: number | null;
  readonly over: boolean;
}

describe("CharacterCounterController", () => {
  let application: Application | null = null;
  let announcementMessages: string[] = [];

  const onAnnouncement = (event: Event): void => {
    announcementMessages.push((event as CustomEvent<{ message: string }>).detail.message);
  };

  const boot = async (markup: string) => {
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div id="cc-announcer" data-stimeo--announcer-target="polite"
             aria-live="polite" aria-atomic="true"></div>
        <div data-stimeo--announcer-target="assertive"
             aria-live="assertive" aria-atomic="true"></div>
      </div>
      ${markup}`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    application.register("stimeo--character-counter", CharacterCounterController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const start = async (rootAttrs = "", fieldAttrs = "", initialValue = "", withOutput = true) => {
    await boot(`
      <div data-controller="stimeo--character-counter" ${rootAttrs}>
        <textarea data-stimeo--character-counter-target="input"
                  aria-describedby="cc" ${fieldAttrs}>${initialValue}</textarea>
        ${withOutput ? '<span id="cc" data-stimeo--character-counter-target="output"></span>' : ""}
      </div>`);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    announcementMessages = [];
    window.addEventListener("stimeo--announcer:announce", onAnnouncement);
  });

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnouncement);
    if (application) disconnectAndStopApplication(application);
    application = null;
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query<HTMLElement>("[data-controller='stimeo--character-counter']");
  const field = () => query<HTMLTextAreaElement>("textarea");
  const output = () => query<HTMLElement>("#cc");
  const announcer = () => query<HTMLElement>("#cc-announcer");
  const controller = () =>
    application?.getControllerForElementAndIdentifier(
      root(),
      "stimeo--character-counter",
    ) as CharacterCounterController;

  /** Sets the current field value and fires the native event observed internally. */
  const type = (value: string, target = field()) => {
    target.value = value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /** Captures the component's public change detail in dispatch order. */
  const captureChanges = (): ChangeDetail[] => {
    const changes: ChangeDetail[] = [];
    root().addEventListener("stimeo--character-counter:change", (event) => {
      changes.push((event as CustomEvent<ChangeDetail>).detail);
    });
    return changes;
  };

  /** Captures controller-derived reconciliations separately from user changes. */
  const captureReconciles = (): ChangeDetail[] => {
    const reconciles: ChangeDetail[] = [];
    root().addEventListener("stimeo--character-counter:reconcile", (event) => {
      reconciles.push((event as CustomEvent<ChangeDetail>).detail);
    });
    return reconciles;
  };

  it("renders initial state synchronously without a change event or announcement", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
      "",
      "hello",
    );
    const changes = captureChanges();

    expect(output().textContent).toBe("5");
    expect(changes).toEqual([]);
    expect(announcer().textContent).toBe("");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
  });

  it("updates visible output immediately and debounces the shared announcement", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining; {length} used; over {over}"',
    );
    type("hello");
    expect(output().textContent).toBe("5");
    expect(announcer().textContent).toBe("");

    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS - 1);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(announcementMessages).toEqual(["5 remaining; 5 used; over false"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(announcer().textContent).toBe("5 remaining; 5 used; over false");
  });

  it("coalesces rapid announcements while reporting each distinct length immediately", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="Count {count}"',
    );
    const changes = captureChanges();

    type("a");
    await vi.advanceTimersByTimeAsync(50);
    type("ab");
    await vi.advanceTimersByTimeAsync(50);
    type("abc");

    expect(changes.map(({ length }) => length)).toEqual([1, 2, 3]);
    expect(output().textContent).toBe("7");
    await vi.advanceTimersByTimeAsync(199);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(announcementMessages).toEqual(["Count 7"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(announcer().textContent).toBe("Count 7");
  });

  it("does not dispatch or restart announcement when replacement text has the same length", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
    );
    const changes = captureChanges();

    type("hello");
    await vi.advanceTimersByTimeAsync(100);
    type("world");
    await vi.advanceTimersByTimeAsync(100);
    expect(announcementMessages).toEqual(["5 remaining"]);
    await vi.advanceTimersByTimeAsync(1);

    expect(changes).toEqual([{ length: 5, remaining: 5, over: false }]);
    expect(announcer().textContent).toBe("5 remaining");
  });

  it("ignores IME intermediates and commits compositionend plus final input exactly once", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
    );
    const changes = captureChanges();
    const input = field();

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type("にほんご", input);
    expect(output().textContent).toBe("10");
    expect(changes).toEqual([]);

    input.value = "日本語";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(output().textContent).toBe("7");
    expect(changes).toEqual([{ length: 3, remaining: 7, over: false }]);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["7 remaining"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(announcer().textContent).toBe("7 remaining");
  });

  it("does not report an empty composition lifecycle as a change", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
    );
    const changes = captureChanges();

    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);

    expect(changes).toEqual([]);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
  });

  it("defers Value reconciliation until a same-length composition settles", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="1"',
      "",
      "abc",
    );
    const changes = captureChanges();
    const reconciles = captureReconciles();

    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type("にほんご");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    root().setAttribute("data-stimeo--character-counter-warn-at-value", "18");
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("7");
    expect(root().hasAttribute("data-near-limit")).toBe(false);
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([]);

    field().value = "日本語";
    field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(output().textContent).toBe("17");
    expect(root().getAttribute("data-near-limit")).toBe("true");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([{ length: 3, remaining: 17, over: false }]);
  });

  it("resets composition state and avoids duplicate listeners across reconnect", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    const changes = captureChanges();

    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    controller().disconnect();
    controller().connect();
    type("hello");

    expect(output().textContent).toBe("5");
    expect(changes).toEqual([{ length: 5, remaining: 5, over: false }]);
  });

  it("reflects near and over states and restores authored aria-invalid", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="3"',
      'aria-invalid="false"',
    );

    type("12345678");
    expect(root().getAttribute("data-near-limit")).toBe("true");
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    expect(field().getAttribute("aria-invalid")).toBe("false");

    type("12345678901");
    expect(root().hasAttribute("data-near-limit")).toBe(false);
    expect(root().getAttribute("data-over-limit")).toBe("true");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(output().textContent).toBe("-1");

    type("1234567890");
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    expect(field().getAttribute("aria-invalid")).toBe("false");
  });

  it("preserves a consumer change made to aria-invalid during an over-limit lease", async () => {
    await start('data-stimeo--character-counter-max-value="3"');

    type("hello");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    field().setAttribute("aria-invalid", "false");

    // Remaining over-limit input must not repeatedly seize the shared attribute.
    type("hello!");
    expect(field().getAttribute("aria-invalid")).toBe("false");
    type("ok");
    expect(field().getAttribute("aria-invalid")).toBe("false");
  });

  it("avoids redundant writes while an over-limit state remains unchanged", async () => {
    await start('data-stimeo--character-counter-max-value="3"');
    type("hello");
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(root(), { attributes: true, subtree: true });

    type("hello!");
    type("hello!!");
    await vi.advanceTimersByTimeAsync(0);
    observer.disconnect();

    expect(records.filter(({ attributeName }) => attributeName === "data-over-limit")).toEqual([]);
    expect(records.filter(({ attributeName }) => attributeName === "aria-invalid")).toEqual([]);
  });

  it("returns leased ARIA, clears hooks, timers, and the input listener on disconnect", async () => {
    await start(
      'data-stimeo--character-counter-max-value="3" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
      'aria-invalid="false"',
    );
    const changes = captureChanges();
    type("hello");
    const rendered = output().textContent;

    controller().disconnect();
    expect(field().getAttribute("aria-invalid")).toBe("false");
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    expect(root().hasAttribute("data-near-limit")).toBe(false);

    type("a");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(output().textContent).toBe(rendered);
    expect(changes).toHaveLength(1);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
  });

  it("rewinds transient ownership before Turbo caches the page", async () => {
    await start(
      'data-stimeo--character-counter-max-value="3" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
      'aria-invalid="false"',
    );
    type("hello");

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(field().getAttribute("aria-invalid")).toBe("false");
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    expect(root().hasAttribute("data-near-limit")).toBe(false);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
  });

  it("rebinds a replaced input and reports its changed derived state as reconciliation", async () => {
    await start('data-stimeo--character-counter-max-value="3"');
    const changes = captureChanges();
    const reconciles = captureReconciles();
    const previous = field();
    type("hello", previous);

    const replacement = document.createElement("textarea");
    replacement.value = "ok";
    replacement.setAttribute("data-stimeo--character-counter-target", "input");
    replacement.setAttribute("aria-describedby", "cc");
    previous.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(0);

    expect(previous.hasAttribute("aria-invalid")).toBe(false);
    expect(output().textContent).toBe("1");
    expect(changes).toHaveLength(1);
    expect(reconciles).toEqual([{ length: 2, remaining: 1, over: false }]);

    type("old field", previous);
    expect(output().textContent).toBe("1");
    type("okay", replacement);
    expect(output().textContent).toBe("-1");
    expect(changes.at(-1)).toEqual({ length: 4, remaining: -1, over: true });
  });

  it("ignores stale input and composition events before a target swap reconciles", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "old");
    const changes = captureChanges();
    const previous = field();

    const replacement = document.createElement("textarea");
    replacement.value = "new value";
    replacement.setAttribute("data-stimeo--character-counter-target", "input");
    previous.removeAttribute("data-stimeo--character-counter-target");
    root().prepend(replacement);

    previous.value = "stale value";
    previous.dispatchEvent(new Event("input", { bubbles: true }));
    previous.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    previous.value = "composed stale value";
    previous.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("1");
    expect(changes).toEqual([]);
  });

  it("handles runtime input removal/addition and late output targets", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "hello", false);
    const changes = captureChanges();

    const lateOutput = document.createElement("span");
    lateOutput.id = "cc";
    lateOutput.setAttribute("data-stimeo--character-counter-target", "output");
    root().append(lateOutput);
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("5");

    const removed = field();
    removed.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("");
    expect(root().hasAttribute("data-over-limit")).toBe(false);

    const added = document.createElement("textarea");
    added.value = "abc";
    added.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(added);
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([]);
  });

  it("supports direct attachment to an input without targets", async () => {
    await boot(`
      <input data-controller="stimeo--character-counter"
             data-stimeo--character-counter-max-value="3" value="hi">`);
    const direct = root() as HTMLInputElement;
    const changes = captureChanges();

    direct.value = "hello";
    direct.dispatchEvent(new Event("input", { bubbles: true }));
    expect(direct.getAttribute("data-over-limit")).toBe("true");
    expect(direct.getAttribute("aria-invalid")).toBe("true");
    expect(changes).toEqual([{ length: 5, remaining: -2, over: true }]);
  });

  it("is safe with no field and initializes one added later", async () => {
    await boot(`
      <div data-controller="stimeo--character-counter"
           data-stimeo--character-counter-max-value="10">
        <span id="cc" data-stimeo--character-counter-target="output">stale</span>
      </div>`);

    expect(output().textContent).toBe("");
    const added = document.createElement("textarea");
    added.value = "hello";
    added.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(added);
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("5");
  });

  it("coalesces runtime Value changes into one reconciliation", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="1"',
      "",
      "hello",
    );
    const changes = captureChanges();
    const reconciles = captureReconciles();

    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    root().setAttribute("data-stimeo--character-counter-warn-at-value", "15");
    root().setAttribute("data-stimeo--character-counter-mode-value", "both");
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("5/20");
    expect(root().getAttribute("data-near-limit")).toBe("true");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([{ length: 5, remaining: 15, over: false }]);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
  });

  it("retargets a pending announcement at the settled count instead of dropping it", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
      "",
      "",
    );

    // The user's edit owes an announcement; the debounce window is still open.
    type("hello");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS / 2);
    expect(announcementMessages).toEqual([]);

    // A Value reconciliation lands mid-window. It must not originate an
    // announcement, and it must not swallow the one the user already earned.
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(announcementMessages).toEqual([]);

    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["15 remaining"]);
  });

  it("does not announce a reconciliation that no user edit was waiting on", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
      "",
      "hello",
    );

    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS * 2);

    expect(announcementMessages).toEqual([]);
  });

  it("normalizes non-finite, negative, and fractional count Values", async () => {
    await start(
      'data-stimeo--character-counter-max-value="4.9" ' +
        'data-stimeo--character-counter-warn-at-value="2.9"',
      "",
      "abc",
    );
    expect(output().textContent).toBe("1");
    expect(root().getAttribute("data-near-limit")).toBe("true");

    root().setAttribute("data-stimeo--character-counter-max-value", "-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("3");
    expect(root().hasAttribute("data-near-limit")).toBe(false);

    root().setAttribute("data-stimeo--character-counter-max-value", "Infinity");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("3");
    expect(root().hasAttribute("data-over-limit")).toBe(false);
  });

  it("supports used/both modes and falls back from an unknown mode", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-mode-value="used"',
      "",
      "abc",
    );
    const reconciles = captureReconciles();
    expect(output().textContent).toBe("3");

    root().setAttribute("data-stimeo--character-counter-mode-value", "both");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("3/10");

    root().setAttribute("data-stimeo--character-counter-mode-value", "mystery");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(reconciles).toEqual([]);
  });

  it("reports null remaining with no limit and stays silent without an announcement template", async () => {
    await start();
    const changes = captureChanges();

    type("hello");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(output().textContent).toBe("5");
    expect(changes).toEqual([{ length: 5, remaining: null, over: false }]);
    expect(announcementMessages).toEqual([]);
    expect(announcer().textContent).toBe("");
  });

  it("delivers the settled count through the shared polite live region", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} characters remaining"',
    );
    type("hello");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["5 characters remaining"]);
    await vi.advanceTimersByTimeAsync(1);

    vi.useRealTimers();
    const speech = await captureSpeech({ container: announcer(), steps: 0 });
    expect(speech).toEqual(["5 characters remaining"]);
  });

  it("has no a11y violations without turning the visible output into a live region", async () => {
    vi.useRealTimers();
    document.body.innerHTML = `
      <div data-controller="stimeo--announcer">
        <div data-stimeo--announcer-target="polite"
             aria-live="polite" aria-atomic="true"></div>
      </div>
      <div data-controller="stimeo--character-counter"
           data-stimeo--character-counter-max-value="10"
           data-stimeo--character-counter-announce-text-value="{remaining} characters remaining">
        <label for="msg">Message</label>
        <textarea id="msg" data-stimeo--character-counter-target="input"
                  aria-describedby="cc"></textarea>
        <span id="cc" data-stimeo--character-counter-target="output"></span>
      </div>`;
    application = Application.start();
    application.register("stimeo--announcer", AnnouncerController);
    application.register("stimeo--character-counter", CharacterCounterController);
    await tick();

    expect(output().hasAttribute("aria-live")).toBe(false);
    await expectNoA11yViolations(root());
  });
});
