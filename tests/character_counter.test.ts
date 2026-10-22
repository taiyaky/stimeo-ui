import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncerController } from "../src/controllers/announcer_controller";
import { CharacterCounterController } from "../src/controllers/character_counter_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { composeDraft } from "./helpers/ime";
import { keyEvent } from "./helpers/keyboard";
import { recordListeners } from "./helpers/listeners";
import { captureSpeech } from "./helpers/speech";
import {
  disconnectAndStopApplication,
  reconnectKeepingFocus,
  restoreFromCache,
} from "./helpers/stimulus";
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
  const type = (value: string, target: HTMLInputElement | HTMLTextAreaElement = field()) => {
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

  it.each(["xy", "wxyz"])(
    "keeps a returning composition separate from the confirmed count of %s",
    async (otherText) => {
      await start(
        'data-stimeo--character-counter-max-value="10" ' +
          'data-stimeo--character-counter-announce-text-value="{remaining} left"',
        "",
        "abc",
      );
      const changes = captureChanges();
      const reconciles = captureReconciles();
      const counted = { length: otherText.length, remaining: 10 - otherText.length, over: false };
      const a = field();
      a.focus();
      a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(a, "abcに");
      const b = document.createElement("textarea");
      b.value = otherText;
      b.setAttribute("data-stimeo--character-counter-target", "input");
      root().prepend(b);
      await vi.advanceTimersByTimeAsync(0);
      expect(output().textContent).toBe(String(10 - otherText.length));
      b.remove();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.activeElement).toBe(a);
      expect(a.value).toBe("abcに");
      expect(output().textContent).toBe("7");
      expect(reconciles).toEqual([counted]);
      a.value = "abc似";
      a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      a.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
      );
      expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);
      // The `change` publishes the new state; no `reconcile` comes with it.
      expect(reconciles).toEqual([counted]);
      expect(output().textContent).toBe("6");
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
      expect(announcementMessages).toEqual(["6 left"]);
    },
  );

  it.each([false, true])(
    "keeps a never-counted composition and its confirmation separate from the old field's announcement (reconnect: %s)",
    async (reconnect) => {
      await start(
        'data-stimeo--character-counter-max-value="10" ' +
          'data-stimeo--character-counter-announce-text-value="{remaining} left"',
        "",
        "abc",
      );
      if (!application) throw new Error("Application was not started");
      const errors = vi.spyOn(application, "handleError").mockImplementation(() => {});
      try {
        const previous = field();
        const arriving = document.createElement("textarea");
        arriving.value = "xy";
        arriving.setAttribute("data-stimeo--character-counter-target", "input");
        root().append(arriving);
        await vi.advanceTimersByTimeAsync(0);
        if (reconnect) {
          const instance = controller();
          instance.disconnect();
          instance.connect();
        }
        type("abcd", previous);
        const changes = captureChanges();
        const reconciles = captureReconciles();
        arriving.focus();
        arriving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        composeDraft(arriving, "xyに");
        previous.remove();
        await vi.advanceTimersByTimeAsync(0);
        expect(output().textContent).toBe("6");
        expect(changes).toEqual([]);
        expect(reconciles).toEqual([]);
        expect(errors).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
        expect(announcementMessages).toEqual([]);
        arriving.value = "xy似";
        arriving.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        expect(output().textContent).toBe("7");
        expect(changes).toEqual([{ length: 3, remaining: 7, over: false }]);
        expect(reconciles).toEqual([]);
        await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
        expect(announcementMessages).toEqual(["7 left"]);
      } finally {
        errors.mockRestore();
      }
    },
  );

  it.each([
    {
      ending: "is cancelled",
      committed: "abc",
      shown: "a count within the limit",
      other: "xy",
      counted: { length: 2, remaining: 8, over: false },
    },
    {
      ending: "is cancelled",
      committed: "abc",
      shown: "a count over the limit",
      other: "xxxxxxxxxxxx",
      counted: { length: 12, remaining: -2, over: true },
    },
    {
      ending: "confirms the same length",
      committed: "ab似",
      shown: "a count within the limit",
      other: "xy",
      counted: { length: 2, remaining: 8, over: false },
    },
    {
      ending: "confirms the same length",
      committed: "ab似",
      shown: "a count over the limit",
      other: "xxxxxxxxxxxx",
      counted: { length: 12, remaining: -2, over: true },
    },
  ])(
    "restores a returning field's count silently and reconciles once when its conversion $ending after another field showed $shown",
    async ({ committed, other, counted }) => {
      await start(
        'data-stimeo--character-counter-max-value="10" ' +
          'data-stimeo--character-counter-announce-text-value="{remaining} left"',
        "",
        "abc",
      );
      const changes = captureChanges();
      const reconciles = captureReconciles();
      const a = field();
      a.focus();
      a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(a, "abcに");
      const b = document.createElement("textarea");
      b.value = other;
      b.setAttribute("data-stimeo--character-counter-target", "input");
      root().prepend(b);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconciles).toEqual([counted]);
      expect(root().hasAttribute("data-over-limit")).toBe(counted.over);

      // The composing field comes first again: its own count comes back without an event.
      b.remove();
      await vi.advanceTimersByTimeAsync(0);
      expect(output().textContent).toBe("7");
      expect(root().hasAttribute("data-over-limit")).toBe(false);
      expect(a.hasAttribute("aria-invalid")).toBe(false);
      expect(reconciles).toEqual([counted]);

      // The conversion ends at the accepted length: the state published last is reconciled.
      composeDraft(a, committed);
      a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
      expect(output().textContent).toBe("7");
      expect(changes).toEqual([]);
      expect(reconciles).toEqual([counted, { length: 3, remaining: 7, over: false }]);
      expect(announcementMessages).toEqual([]);
    },
  );

  const OVER = { length: 12, remaining: -2, over: true };
  const ACCEPTED = { length: 3, remaining: 7, over: false };

  /**
   * Starts a conversion in the counted field (`abc`, max 10), then puts a field holding
   * `other` first; with `returns`, that field leaves again and the composing one is
   * first once more.
   */
  const handOffWhileComposing = async (other: string, returns: boolean) => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} left"',
      "",
      "abc",
    );
    const changes = captureChanges();
    const reconciles = captureReconciles();
    const a = field();
    a.focus();
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(a, "abcに");
    const b = document.createElement("textarea");
    b.value = other;
    b.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(b);
    await vi.advanceTimersByTimeAsync(0);
    if (returns) {
      b.remove();
      await vi.advanceTimersByTimeAsync(0);
    }
    return { a, b, changes, reconciles };
  };

  it.each([
    { writer: "a form reset", written: "abc", next: [], spoken: [] },
    {
      writer: "a script",
      written: "abcdef",
      next: [{ length: 6, remaining: 4, over: false }],
      spoken: ["4 left"],
    },
  ])(
    "reconciles a returning field's count once when $writer ends its conversion without compositionend",
    async ({ written, next, spoken }) => {
      const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
      expect(output().textContent).toBe("7");
      expect(reconciles).toEqual([OVER]);

      // The write ends the conversion without compositionend, and the blur shows it.
      a.value = written;
      a.blur();
      expect(output().textContent).toBe("7");
      expect(root().hasAttribute("data-over-limit")).toBe(false);
      expect(changes).toEqual([]);
      expect(reconciles).toEqual([OVER, ACCEPTED]);

      // The next edit counts the text the field holds, and publishes nothing twice.
      type(written, a);
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
      expect(changes).toEqual(next);
      expect(reconciles).toEqual([OVER, ACCEPTED]);
      expect(announcementMessages).toEqual(spoken);
    },
  );

  it("reconciles a returning field's count once the engine's next edit shows its conversion ended, then counts that edit", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);

    // The engine ends the conversion with its text in place: the next key and its edit show it.
    a.dispatchEvent(keyEvent("x", { isComposing: false }));
    a.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "x",
      }),
    );
    expect(reconciles).toEqual([OVER, ACCEPTED]);
    a.value = "abcにx";
    const edit = new InputEvent("input", { bubbles: true, inputType: "insertText", data: "x" });
    Object.defineProperty(edit, "isTrusted", { value: true });
    a.dispatchEvent(edit);

    expect(output().textContent).toBe("5");
    expect(changes).toEqual([{ length: 5, remaining: 5, over: false }]);
    expect(reconciles).toEqual([OVER, ACCEPTED]);
  });

  it("reconciles nothing when a conversion ends without compositionend and no other field was counted", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const changes = captureChanges();
    const reconciles = captureReconciles();
    const a = field();
    a.focus();
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(a, "abcに");

    a.value = "abc";
    a.blur();
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([]);
  });

  it("reconciles nothing when the field counted meanwhile last published the returning field's state", async () => {
    const { a, b, changes, reconciles } = await handOffWhileComposing("xy", false);
    type("xyz", b);
    b.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([ACCEPTED]);

    a.value = "abc";
    a.blur();
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([ACCEPTED]);
    expect(reconciles).toEqual([{ length: 2, remaining: 8, over: false }]);
  });

  it("reconciles nothing for a conversion that ends without compositionend in a field another one displaced", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", false);

    a.value = "abc";
    a.blur();
    expect(output().textContent).toBe("-2");
    expect(root().getAttribute("data-over-limit")).toBe("true");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER]);
  });

  /**
   * Morphs a textarea as Turbo 8 does: the cancelable notice before its value is
   * written, the write unless the notice is cancelled, then a bubbling
   * `turbo:morph-element` for the field and one for the root.
   */
  const morphField = (target: HTMLTextAreaElement, server: string) => {
    const notice = new CustomEvent("turbo:before-morph-attribute", {
      bubbles: true,
      cancelable: true,
      detail: { attributeName: "value", mutationType: "update" },
    });
    if (target.dispatchEvent(notice)) target.value = server;
    target.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
  };

  it.each([
    { server: "hello world!", reconciled: [] },
    { server: "", reconciled: [{ length: 0, remaining: 10, over: false }] },
    { server: "abcdef", reconciled: [{ length: 6, remaining: 4, over: false }] },
    { server: "abc", reconciled: [ACCEPTED] },
  ])(
    'reconciles a returning field at most once, from the morph\'s pass, when a morph first shows its conversion ended (server text "$server")',
    async ({ server, reconciled }) => {
      const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
      expect(reconciles).toEqual([OVER]);

      // A script write ends the conversion, and the morph's notice is the first to show it.
      a.value = "abcdef";
      morphField(a, server);
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);

      expect(a.value).toBe(server);
      expect(output().textContent).toBe(String(10 - server.length));
      expect(root().hasAttribute("data-over-limit")).toBe(server.length > 10);
      expect(changes).toEqual([]);
      expect(reconciles).toEqual([OVER, ...reconciled]);
      expect(announcementMessages).toEqual([]);
    },
  );

  it("reconciles a pass the returning field's conversion held once, at the commit of a new conversion that ended it", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    // The declarations change while the field composes, so the pass waits for its end.
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([OVER]);

    // A new conversion in the same field ends that one with its text in place; the
    // pass waits on for the new one, and nothing is reported meanwhile.
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(output().textContent).toBe("7");
    expect(reconciles).toEqual([OVER]);

    composeDraft(a, "abcに");
    a.value = "abc";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);

    expect(output().textContent).toBe("17");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 3, remaining: 17, over: false }]);
  });

  it("reconciles a returning field's count at once when a new conversion shows the end while a pass is queued", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);

    // A script write ends the conversion; in the same task a morph queues a pass and a
    // new conversion starts in the field, so the pass will not count it.
    a.value = "abcdef";
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(reconciles).toEqual([OVER, ACCEPTED]);
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(root().hasAttribute("data-over-limit")).toBe(false);
    expect(reconciles).toEqual([OVER, ACCEPTED]);

    composeDraft(a, "abcdef似に");
    a.value = "abcdef似";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("3");
    expect(changes).toEqual([{ length: 7, remaining: 3, over: false }]);
    expect(reconciles).toEqual([OVER, ACCEPTED]);
    expect(announcementMessages).toEqual(["3 left"]);
  });

  it("leaves a queued pass to count the returning field when a conversion in another target shows the end", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    const c = document.createElement("textarea");
    c.setAttribute("data-stimeo--character-counter-target", "input");
    root().append(c);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([OVER]);

    // The new conversion is in another target, so the queued pass counts the field.
    a.value = "abcdef";
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    c.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(reconciles).toEqual([OVER]);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("4");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 6, remaining: 4, over: false }]);
    expect(announcementMessages).toEqual([]);
  });

  it.each([
    [
      "a key",
      (a: HTMLTextAreaElement) => a.dispatchEvent(keyEvent("Process", { isComposing: false })),
    ],
    [
      "a blur",
      (a: HTMLTextAreaElement) => {
        a.blur();
        a.focus();
      },
    ],
  ])(
    "reconciles a returning field's count once a new conversion starts in it after %s showed the end to a queued pass",
    async (_name, reveal) => {
      const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);

      // A script write ends the conversion; a morph has queued a pass when the end shows.
      a.value = "abcdef";
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      reveal(a);
      expect(reconciles).toEqual([OVER]);

      // A new conversion starts before the pass, which then will not count the field.
      a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(reconciles).toEqual([OVER, ACCEPTED]);
      await vi.advanceTimersByTimeAsync(0);
      expect(output().textContent).toBe("7");
      expect(root().hasAttribute("data-over-limit")).toBe(false);
      expect(reconciles).toEqual([OVER, ACCEPTED]);

      composeDraft(a, "abcdef似に");
      a.value = "abcdef似";
      a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
      expect(changes).toEqual([{ length: 7, remaining: 3, over: false }]);
      expect(reconciles).toEqual([OVER, ACCEPTED]);
      expect(announcementMessages).toEqual(["3 left"]);
    },
  );

  it("leaves the queued pass to count the field put first before a new conversion starts in the returning one", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    a.value = "abcdef";
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    const c = document.createElement("textarea");
    c.value = "xy";
    c.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(c);

    // The returning field is no longer first, so its start reconciles nothing.
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(reconciles).toEqual([OVER]);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("8");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 2, remaining: 8, over: false }]);
    expect(announcementMessages).toEqual([]);
  });

  it("forgets the reconcile left to a pass once that pass has run", async () => {
    const { a, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    const SIX = { length: 6, remaining: 4, over: false };
    a.value = "abcdef";
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([OVER, SIX]);

    // A later conversion returns silently behind another field, then the declarations
    // change, so its pass is held; a new conversion ending it reconciles nothing early.
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(a, "abcdefに");
    const b = document.createElement("textarea");
    b.value = "xxxxxxxxxxxx";
    b.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(b);
    await vi.advanceTimersByTimeAsync(0);
    b.remove();
    await vi.advanceTimersByTimeAsync(0);
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("4");
    expect(reconciles).toEqual([OVER, SIX, OVER]);
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(reconciles).toEqual([OVER, SIX, OVER]);

    composeDraft(a, "abcdefに");
    a.value = "abcdef";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(reconciles).toEqual([OVER, SIX, OVER, { length: 6, remaining: 14, over: false }]);
  });

  it.each([
    ["a key shows it", true],
    ["the start shows it", false],
  ])(
    "reconciles a returning field's count from the pass that finds it composing again when another field was first for a moment as %s",
    async (_name, keyShows) => {
      const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
      a.value = "abcdef";
      root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
      if (keyShows) a.dispatchEvent(keyEvent("Process", { isComposing: false }));

      // Another field is first while the new conversion starts, and leaves before the pass.
      const c = document.createElement("textarea");
      c.value = "xy";
      c.setAttribute("data-stimeo--character-counter-target", "input");
      root().prepend(c);
      a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      expect(reconciles).toEqual([OVER]);
      c.remove();
      await vi.advanceTimersByTimeAsync(0);
      expect(output().textContent).toBe("7");
      expect(root().hasAttribute("data-over-limit")).toBe(false);
      expect(reconciles).toEqual([OVER, ACCEPTED]);

      composeDraft(a, "abcdef似に");
      a.value = "abcdef似";
      a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
      expect(changes).toEqual([{ length: 7, remaining: 3, over: false }]);
      expect(reconciles).toEqual([OVER, ACCEPTED]);
      expect(announcementMessages).toEqual(["3 left"]);
    },
  );

  it("leaves a field put first in the same task to its pass when a key shows the returning field's end", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    a.value = "abcdef";
    const c = document.createElement("textarea");
    c.value = "xy";
    c.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(c);

    // No pass is queued yet, but the field is no longer first, so nothing is reported now.
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    expect(reconciles).toEqual([OVER]);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("8");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 2, remaining: 8, over: false }]);
  });

  it("reports nothing from reconnecting a controller element moved while the returning field composes again", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    a.value = "abcdef";
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    const c = document.createElement("textarea");
    c.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(c);
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    c.remove();

    // A move that keeps focus: Stimulus disconnects and connects the controller in one batch.
    controller().disconnect();
    controller().connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(reconciles).toEqual([OVER]);

    composeDraft(a, "abcdef似に");
    a.value = "abcdef似";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(changes).toEqual([{ length: 7, remaining: 3, over: false }]);
    expect(reconciles).toEqual([OVER]);
  });

  it("reconciles nothing early for a new conversion while a pass is held and another is queued", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    // The declarations change while the field composes, so the pass waits for its end.
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([OVER]);

    // A morph queues a pass, and a new conversion ends the held one before it runs.
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(reconciles).toEqual([OVER]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([OVER]);

    composeDraft(a, "abcに");
    a.value = "abc";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("17");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 3, remaining: 17, over: false }]);
  });

  /** Puts a fresh input target holding `value` first in the counter. */
  const putFirst = (value: string) => {
    const other = document.createElement("textarea");
    other.value = value;
    other.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(other);
    return other;
  };

  it("forgets the field a reconcile was left for once a pass binds another field composing", async () => {
    const { a, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    const x = document.createElement("textarea");
    x.value = "xy";
    x.setAttribute("data-stimeo--character-counter-target", "input");
    root().append(x);
    await vi.advanceTimersByTimeAsync(0);

    // A conversion in the other field ends the returning one while a pass is queued; the
    // other field is put first, still composing, and the pass binds it.
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    x.focus();
    x.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    root().prepend(x);
    x.focus();
    await vi.advanceTimersByTimeAsync(0);
    x.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    const settled = [...reconciles];

    // The returning field is first again and composing: restored without any event.
    x.remove();
    a.focus();
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(reconciles).toEqual(settled);
  });

  it("reconciles nothing for the returning field when the reconcile was left while another field was counted", async () => {
    const { a, b, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", false);
    a.value = "abcdef";
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    b.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(reconciles).toEqual([OVER]);

    composeDraft(a, "abcdefに");
    a.value = "abcdef";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(changes).toEqual([{ length: 6, remaining: 4, over: false }]);
    expect(reconciles).toEqual([OVER]);
  });

  it("queues a pass for an end shown while a field put first leaves in the same task", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    a.value = "abcdef";
    const other = putFirst("xy");
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    expect(reconciles).toEqual([OVER]);

    // Stimulus never reports the field that came and went, so the end queues the pass.
    other.remove();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("4");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 6, remaining: 4, over: false }]);
    expect(announcementMessages).toEqual([]);
  });

  it("reconciles the accepted count from that pass when a new conversion starts before the field put first leaves", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    a.value = "abcdef";
    const other = putFirst("xy");
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    other.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(reconciles).toEqual([OVER, ACCEPTED]);

    composeDraft(a, "abcdef似に");
    a.value = "abcdef似";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(changes).toEqual([{ length: 7, remaining: 3, over: false }]);
    expect(reconciles).toEqual([OVER, ACCEPTED]);
  });

  it("reads the field for a held pass when its end shows while a field put first leaves in the same task", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([OVER]);

    a.value = "abcdef";
    const other = putFirst("xy");
    a.dispatchEvent(keyEvent("Process", { isComposing: false }));
    other.remove();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("14");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 6, remaining: 14, over: false }]);
  });

  it("keeps a held pass for the commit when a new conversion starts before a field put first leaves", async () => {
    const { a, changes, reconciles } = await handOffWhileComposing("xxxxxxxxxxxx", true);
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    const other = putFirst("xy");
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    other.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(reconciles).toEqual([OVER]);

    composeDraft(a, "abcに");
    a.value = "abc";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("17");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([OVER, { length: 3, remaining: 17, over: false }]);
  });

  // An `input` that arrives with no `beforeinput` — a script's dispatch — leaves the
  // other target's composition held, so only the counted field's own conversion may
  // hold its edit back.
  it("counts the first field's edit while another input target composes", async () => {
    await boot(`
      <div data-controller="stimeo--character-counter"
           data-stimeo--character-counter-max-value="10"
           data-stimeo--character-counter-announce-text-value="{remaining} left">
        <textarea data-stimeo--character-counter-target="input">abc</textarea>
        <textarea id="cc-second" data-stimeo--character-counter-target="input">q</textarea>
        <span id="cc" data-stimeo--character-counter-target="output"></span>
      </div>`);
    const changes = captureChanges();
    const second = query<HTMLTextAreaElement>("#cc-second");
    second.focus();
    second.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(second, "qに");

    type("abcd");
    expect(output().textContent).toBe("6");
    expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);

    // The other target's confirmation counts nothing for the first field.
    second.value = "q似";
    second.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(output().textContent).toBe("6");
    expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);
    expect(announcementMessages).toEqual(["6 left"]);
  });

  // The field that comes first is edited by a script's `input` while the field it
  // displaced still composes; that conversion's end counts nothing.
  it("counts the edit of a field that comes first while the field it displaced composes", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const changes = captureChanges();
    const a = field();
    a.focus();
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(a, "abcに");
    const b = document.createElement("textarea");
    b.value = "xy";
    b.setAttribute("data-stimeo--character-counter-target", "input");
    root().prepend(b);
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("8");

    type("xyz", b);
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([{ length: 3, remaining: 7, over: false }]);

    a.value = "abc似";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([{ length: 3, remaining: 7, over: false }]);
  });

  it("does not revive an announcement after a change subscriber disconnects the counter", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} left"',
      "",
      "abc",
    );
    root().addEventListener("stimeo--character-counter:change", () => controller().disconnect(), {
      once: true,
    });
    type("abcd");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
    expect(announcementMessages).toEqual([]);
  });

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
    composeDraft(input, "にほんご");
    expect(output().textContent).toBe("10");
    expect(changes).toEqual([]);

    input.value = "日本語";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
    );

    expect(output().textContent).toBe("7");
    expect(changes).toEqual([{ length: 3, remaining: 7, over: false }]);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["7 remaining"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(announcer().textContent).toBe("7 remaining");
  });

  // A script that dispatches `input` without writing the field leaves the text the
  // composition left, so the conversion goes on and the `input` carries no
  // `isComposing`: the tracked composition alone keeps the draft uncounted.
  it("ignores an input a script dispatches mid-composition without changing the draft", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const changes = captureChanges();
    const a = field();
    a.focus();
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(a, "abcに");
    a.dispatchEvent(new Event("input", { bubbles: true }));
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([]);

    a.value = "abc似";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(output().textContent).toBe("6");
    expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);
  });

  // The counter connects after the composition began, as a lazily loaded controller
  // can, so it never heard `compositionstart`: the engine's `isComposing` alone keeps
  // the drafts uncounted.
  it("ignores the drafts of a composition that began before it connected, and counts its confirmation", async () => {
    document.body.innerHTML = `
      <div data-controller="stimeo--character-counter"
           data-stimeo--character-counter-max-value="10">
        <textarea data-stimeo--character-counter-target="input">abc</textarea>
        <span id="cc" data-stimeo--character-counter-target="output"></span>
      </div>`;
    const a = field();
    a.focus();
    a.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    application = Application.start();
    application.register("stimeo--character-counter", CharacterCounterController);
    await vi.advanceTimersByTimeAsync(0);
    const changes = captureChanges();
    expect(output().textContent).toBe("7");

    composeDraft(a, "abcに");
    expect(output().textContent).toBe("7");
    expect(changes).toEqual([]);

    a.value = "abc似";
    a.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(output().textContent).toBe("6");
    expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);
  });

  it("reports a keyless edit that lands right after a commit", async () => {
    // Dictation, autofill and a drop arrive with no key before them, so the
    // window that absorbs the engine's echo has to read the kind reported on
    // the event rather than assume the next one is the echo.
    await start('data-stimeo--character-counter-max-value="10"');
    const changes = captureChanges();
    const input = field();

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input, "にほんご");
    input.value = "日本語";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(changes).toEqual([{ length: 3, remaining: 7, over: false }]);

    input.value = "日本語です";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(output().textContent).toBe("5");
    expect(changes).toEqual([
      { length: 3, remaining: 7, over: false },
      { length: 5, remaining: 5, over: false },
    ]);
  });

  it("lets a pending Value change reach the page through the repaint, not the echo", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    const changes = captureChanges();
    const reconciles = captureReconciles();
    const input = field();

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(input, "にほんご");
    input.value = "日本語";
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    changes.length = 0;
    reconciles.length = 0;

    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
    );
    expect(reconciles).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([{ length: 3, remaining: 17, over: false }]);
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
    composeDraft(field(), "にほんご");
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

  it("runs a reconciliation the composition held once a script write ends it", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="1"',
      "",
      "abc",
    );
    const changes = captureChanges();
    const reconciles = captureReconciles();
    field().focus();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "にほんご");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");

    // A script writes the field, and the engine drops the conversion without compositionend.
    field().value = "abcd";
    field().dispatchEvent(keyEvent("ArrowLeft"));
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("16");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([{ length: 4, remaining: 16, over: false }]);
  });

  it("runs a reconciliation the composition held once its field moves within the controller", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="1"',
      "",
      "abc",
    );
    const reconciles = captureReconciles();
    field().focus();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "にほんご");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");

    // Moving the field ends the conversion without compositionend; its text stays.
    const moving = field();
    root().append(moving);
    controller().inputTargetDisconnected(moving);
    controller().inputTargetConnected();
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("16");
    expect(reconciles).toEqual([{ length: 4, remaining: 16, over: false }]);

    // The field it still counts is watched again: a new composition waits for its end.
    moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(moving, "にほんごで");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("16");
    moving.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("15");
  });

  it("leaves an input target it does not count unwatched once that target leaves", async () => {
    await boot(`
      <div data-controller="stimeo--character-counter" data-stimeo--character-counter-max-value="10">
        <textarea data-stimeo--character-counter-target="input" aria-describedby="cc"></textarea>
        <textarea id="spare" data-stimeo--character-counter-target="input"></textarea>
        <span id="cc" data-stimeo--character-counter-target="output"></span>
      </div>`);
    const spare = query<HTMLTextAreaElement>("#spare");
    spare.remove();
    controller().inputTargetDisconnected(spare);
    await vi.advanceTimersByTimeAsync(0);
    document.body.append(spare);
    spare.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("20");
  });

  it("counts the user's typing once the engine stopped composing with the text in place", async () => {
    await start('data-stimeo--character-counter-max-value="140"');
    const changes = captureChanges();
    const reconciles = captureReconciles();
    field().focus();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "にほん");

    // The engine no longer composes: the next key and its edit say so.
    field().dispatchEvent(keyEvent("a", { isComposing: false }));
    field().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "a",
      }),
    );
    field().value = "にほんa";
    const edit = new InputEvent("input", { bubbles: true, inputType: "insertText", data: "a" });
    Object.defineProperty(edit, "isTrusted", { value: true });
    field().dispatchEvent(edit);
    await vi.advanceTimersByTimeAsync(0);

    // Nothing was held, so the text the engine left is counted with the user's key.
    expect(output().textContent).toBe("136");
    expect(reconciles).toEqual([]);
    expect(changes).toEqual([{ length: 4, remaining: 136, over: false }]);
  });

  it("puts back the count a morph wiped mid-composition, without counting the draft", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="8"',
      "",
      "abc",
    );
    const reconciles = captureReconciles();
    expect(output().textContent).toBe("7");
    expect(root().getAttribute("data-near-limit")).toBe("true");
    field().focus();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "abcにほん");

    // A morph renders the server's markup: no count, no state hook.
    output().textContent = "";
    root().removeAttribute("data-near-limit");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("7");
    expect(root().getAttribute("data-near-limit")).toBe("true");
    expect(reconciles).toEqual([]);
  });

  it("puts back the over-limit hook and aria-invalid a morph wiped mid-composition", async () => {
    await start('data-stimeo--character-counter-max-value="3"', "", "abcd");
    expect(output().textContent).toBe("-1");
    expect(root().getAttribute("data-over-limit")).toBe("true");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    field().focus();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "abcdに");

    // A morph renders the server's markup, which carries neither.
    root().removeAttribute("data-over-limit");
    field().removeAttribute("aria-invalid");
    root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("-1");
    expect(root().getAttribute("data-over-limit")).toBe("true");
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });

  it("counts nothing once its composing field stops being its input, when the turn ends", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const leaving = field();
    leaving.focus();
    leaving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(leaving, "abcに");

    // The page drops the target while the field keeps focus and goes on composing.
    leaving.removeAttribute("data-stimeo--character-counter-target");
    controller().inputTargetDisconnected(leaving);
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("");
  });

  it("shows the count it showed while the controller element moves keeping focus mid-composition, and counts the commit", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="8"',
      "",
      "abc",
    );
    const changes = captureChanges();
    const moving = field();
    moving.focus();
    moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(moving, "abcにほん");

    // moveBefore keeps focus and the conversion. Stimulus disconnects the controller
    // before its targets, and connects it after them.
    const instance = controller();
    instance.disconnect();
    instance.inputTargetDisconnected(moving);
    instance.inputTargetConnected();
    instance.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");
    expect(root().getAttribute("data-near-limit")).toBe("true");

    moving.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("4");
    expect(changes).toEqual([{ length: 6, remaining: 4, over: false }]);
  });

  it.each([
    [
      "the field",
      (instance: CharacterCounterController, moving: HTMLTextAreaElement) => {
        instance.inputTargetDisconnected(moving);
        instance.inputTargetConnected();
      },
    ],
    [
      "the controller element",
      (instance: CharacterCounterController, moving: HTMLTextAreaElement) => {
        instance.disconnect();
        instance.inputTargetDisconnected(moving);
        instance.inputTargetConnected();
        instance.connect();
      },
    ],
  ])(
    "reports nothing for a conversion cancelled after %s moved keeping focus",
    async (_name, move) => {
      await start('data-stimeo--character-counter-max-value="10"', "", "abc");
      const changes = captureChanges();
      const reconciles = captureReconciles();
      const moving = field();
      moving.focus();
      moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(moving, "abcに");
      move(controller(), moving);
      await vi.advanceTimersByTimeAsync(0);

      // Cancelling puts back the text the field had before the composition began.
      moving.value = "abc";
      moving.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(output().textContent).toBe("7");
      expect(changes).toEqual([]);
      expect(reconciles).toEqual([]);
    },
  );

  it.each([
    [
      "the field",
      (instance: CharacterCounterController, moving: HTMLTextAreaElement) => {
        instance.inputTargetDisconnected(moving);
        instance.inputTargetConnected();
      },
    ],
    [
      "the controller element",
      (instance: CharacterCounterController, moving: HTMLTextAreaElement) => {
        instance.disconnect();
        instance.inputTargetDisconnected(moving);
        instance.inputTargetConnected();
        instance.connect();
      },
    ],
  ])(
    "holds nothing when %s moved keeping focus, so text left in place is counted with the next key",
    async (_name, move) => {
      await start('data-stimeo--character-counter-max-value="10"', "", "abc");
      const changes = captureChanges();
      const reconciles = captureReconciles();
      const moving = field();
      moving.focus();
      moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(moving, "abcに");
      move(controller(), moving);
      await vi.advanceTimersByTimeAsync(0);

      // The engine stops composing with the text in place; the user's key follows.
      moving.dispatchEvent(keyEvent("x", { isComposing: false }));
      moving.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "insertText",
          isComposing: false,
          data: "x",
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(reconciles).toEqual([]);
      type("abcにx", moving);

      expect(output().textContent).toBe("5");
      expect(changes).toEqual([{ length: 5, remaining: 5, over: false }]);
    },
  );

  it("compares a cancelled conversion with what it showed before the controller element moved keeping focus", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const changes = captureChanges();
    const reconciles = captureReconciles();
    const moving = field();
    moving.focus();
    moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(moving, "abcに");
    const instance = controller();
    instance.disconnect();
    instance.inputTargetDisconnected(moving);
    instance.inputTargetConnected();
    instance.connect();
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    moving.value = "abc";
    moving.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    // The length is the one it showed; only the page's new limit moved the count.
    expect(output().textContent).toBe("17");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([{ length: 3, remaining: 17, over: false }]);
  });

  it.each([
    ["max", "data-stimeo--character-counter-max-value", "2", "-2"],
    ["warnAt", "data-stimeo--character-counter-warn-at-value", "8", "6"],
    ["mode", "data-stimeo--character-counter-mode-value", "used", "4"],
  ])(
    "holds a pass for a %s that changed with a move keeping focus, as it does with no move",
    async (_name, attribute, value, count) => {
      await start('data-stimeo--character-counter-max-value="10"', "", "abc");
      const changes = captureChanges();
      const reconciles = captureReconciles();
      const moving = field();
      moving.focus();
      moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(moving, "abcに");

      // The morph that moves the controller element also changes what it counts against.
      reconnectKeepingFocus(controller(), () => root().setAttribute(attribute, value));
      await vi.advanceTimersByTimeAsync(0);
      expect(output().textContent).toBe("7");

      // A script writes the field and tells listeners, which ends the conversion.
      type("abcd", moving);
      await vi.advanceTimersByTimeAsync(0);

      expect(output().textContent).toBe(count);
      expect(changes).toEqual([]);
      expect(reconciles).toHaveLength(1);
    },
  );

  it.each([
    [
      "a morph that changes nothing",
      () => root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true })),
    ],
    [
      "a max the rendering reads the same",
      () => root().setAttribute("data-stimeo--character-counter-max-value", "10.5"),
    ],
  ])(
    "holds nothing for %s mid-composition, so a script's write reports as an edit",
    async (_name, change) => {
      await start('data-stimeo--character-counter-max-value="10"', "", "abc");
      const changes = captureChanges();
      const reconciles = captureReconciles();
      const field0 = field();
      field0.focus();
      field0.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(field0, "abcに");

      change();
      await vi.advanceTimersByTimeAsync(0);
      expect(output().textContent).toBe("7");
      // A script writes the field and tells listeners, which ends the conversion.
      type("abcd", field0);
      await vi.advanceTimersByTimeAsync(0);

      expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);
      expect(reconciles).toEqual([]);
    },
  );

  it.each([
    [
      "a move of the field keeping focus",
      () => {
        const instance = controller();
        instance.inputTargetDisconnected(field());
        instance.inputTargetConnected();
      },
    ],
    [
      "a morph that changes nothing",
      () => root().dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true })),
    ],
  ])(
    "keeps the announcement the last commit earned through %s mid-composition",
    async (_name, pass) => {
      await start(
        'data-stimeo--character-counter-max-value="10" ' +
          'data-stimeo--character-counter-announce-text-value="{remaining} left"',
      );
      const typing = field();
      typing.focus();
      type("ab", typing);
      typing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(typing, "abに");

      pass();
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 5);

      expect(announcementMessages).toEqual(["8 left"]);
    },
  );

  it.each([
    ["max", "20", "18 shown"],
    ["mode", "used", "2 shown"],
  ])(
    "retargets the announcement the last commit earned at the count a %s held mid-composition shows, when the conversion ends at the same length",
    async (name, value, message) => {
      await start(
        'data-stimeo--character-counter-max-value="10" ' +
          'data-stimeo--character-counter-announce-text-value="{count} shown"',
      );
      const typing = field();
      typing.focus();
      type("ab", typing);
      typing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(typing, "abに");
      root().setAttribute(`data-stimeo--character-counter-${name}-value`, value);
      await vi.advanceTimersByTimeAsync(0);

      // Cancelling the conversion puts back the text it started from.
      typing.value = "ab";
      const cancelled = new Event("compositionend", { bubbles: true });
      Object.defineProperty(cancelled, "data", { value: "" });
      typing.dispatchEvent(cancelled);
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 5);

      expect(output().textContent).toBe(message.split(" ")[0]);
      expect(announcementMessages).toEqual([message]);
    },
  );

  it("earns no announcement when a conversion that held a pass ends at the same length", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{count} shown"',
    );
    const typing = field();
    typing.focus();
    type("ab", typing);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 5);
    typing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(typing, "abに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    typing.value = "ab";
    const cancelled = new Event("compositionend", { bubbles: true });
    Object.defineProperty(cancelled, "data", { value: "" });
    typing.dispatchEvent(cancelled);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 5);

    expect(output().textContent).toBe("18");
    expect(announcementMessages).toEqual(["8 shown"]);
  });

  it("speaks the announcement the last commit earned in the wording changed mid-composition", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} left"',
    );
    const typing = field();
    typing.focus();
    type("ab", typing);
    typing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(typing, "abに");

    root().setAttribute("data-stimeo--character-counter-announce-text-value", "{remaining} remain");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 5);

    expect(announcementMessages).toEqual(["8 remain"]);
  });

  it("retargets the announcement the last commit earned when a script ends a conversion that held a pass", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} left"',
    );
    const typing = field();
    typing.focus();
    type("ab", typing);
    typing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(typing, "abに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    // A script writes the field and reports it: the conversion is over.
    type("abc", typing);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 5);

    expect(output().textContent).toBe("17");
    expect(announcementMessages).toEqual(["17 left"]);
  });

  it("holds nothing for a declaration changed and changed back mid-composition", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const changes = captureChanges();
    const reconciles = captureReconciles();
    const composing = field();
    composing.focus();
    composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(composing, "abcに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    root().setAttribute("data-stimeo--character-counter-max-value", "10");
    await vi.advanceTimersByTimeAsync(0);

    type("abcd", composing);
    await vi.advanceTimersByTimeAsync(0);

    expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);
    expect(reconciles).toEqual([]);
  });

  it("counts the field that comes first, not the composing one, when its end comes before the pass", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const reconciles = captureReconciles();
    const composing = field();
    composing.focus();
    composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(composing, "abcに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    // Another field comes first, and a script ends the conversion before the pass runs.
    composing.insertAdjacentHTML(
      "beforebegin",
      '<textarea id="cc-first" data-stimeo--character-counter-target="input">xy</textarea>',
    );
    type("abcd", composing);
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("18");
    expect(reconciles).toEqual([{ length: 2, remaining: 18, over: false }]);
  });

  it("holds nothing when a move keeping focus changes nothing, with Values left at their defaults", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const changes = captureChanges();
    const reconciles = captureReconciles();
    const moving = field();
    moving.focus();
    moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(moving, "abcに");

    reconnectKeepingFocus(controller());
    await vi.advanceTimersByTimeAsync(0);
    type("abcd", moving);
    await vi.advanceTimersByTimeAsync(0);

    expect(changes).toEqual([{ length: 4, remaining: 6, over: false }]);
    expect(reconciles).toEqual([]);
  });

  it("counts the field that comes first with a move at once, leaving the conversion behind it", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const reconciles = captureReconciles();
    const moving = field();
    moving.focus();
    moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(moving, "abcに");

    reconnectKeepingFocus(controller(), () =>
      moving.insertAdjacentHTML(
        "beforebegin",
        '<textarea id="cc-first" data-stimeo--character-counter-target="input">wxyz</textarea>',
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("6");

    // The conversion goes on in a field the counter no longer watches.
    moving.value = "abcにほん";
    moving.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    type("wxyzz", query<HTMLTextAreaElement>("#cc-first"));
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("5");
    expect(reconciles).toEqual([]);
  });

  it("drops a held reconciliation once a pass runs, so a later dropped composition reads nothing", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const reconciles = captureReconciles();
    const moving = field();
    moving.focus();
    moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(moving, "abcに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    // A move without moveBefore takes focus and the conversion; the held pass runs.
    root().append(moving);
    controller().inputTargetDisconnected(moving);
    controller().inputTargetConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciles).toEqual([{ length: 4, remaining: 16, over: false }]);

    moving.focus();
    moving.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(moving, "abcにほ");
    moving.dispatchEvent(keyEvent("x", { isComposing: false }));
    moving.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "x",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(reconciles).toHaveLength(1);
  });

  it("lets go of a composing field for good once the controller disconnects", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const changes = captureChanges();
    const reconciles = captureReconciles();
    field().focus();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "abcに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);

    // The identifier is dropped while the field keeps focus: nothing connects again.
    controller().disconnect();
    await vi.advanceTimersByTimeAsync(0);
    field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    type("abcにほ");
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("7");
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([]);
  });

  it("writes nothing once disconnected, when the field it counted lost its target and the turn lets its composition go", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const composing = field();
    composing.focus();
    composing.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(composing, "abcに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("7");

    // The field stops being an input target and the controller disconnects, in one turn.
    composing.removeAttribute("data-stimeo--character-counter-target");
    controller().disconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("7");
  });

  it("reads nothing early for a composition after one whose commit took the reconciliation it held", async () => {
    await start('data-stimeo--character-counter-max-value="10"', "", "abc");
    const reconciles = captureReconciles();
    field().focus();
    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "abcに");
    root().setAttribute("data-stimeo--character-counter-max-value", "20");
    await vi.advanceTimersByTimeAsync(0);
    field().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(output().textContent).toBe("16");

    field().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    composeDraft(field(), "abcにほ");
    // The engine stops composing with the text in place; nothing is held this time.
    field().dispatchEvent(keyEvent("x", { isComposing: false }));
    field().dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        inputType: "insertText",
        isComposing: false,
        data: "x",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(output().textContent).toBe("16");
    expect(reconciles).toEqual([]);
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

  it("removes the near-limit hook on disconnect", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="3"',
      "",
      "12345678",
    );
    expect(root().getAttribute("data-near-limit")).toBe("true");

    controller().disconnect();

    expect(root().hasAttribute("data-near-limit")).toBe(false);
  });

  it("keeps an over-limit field invalid and its announcement due through turbo:before-cache", async () => {
    // Turbo also dispatches the event on a page that stays (a promoted frame
    // navigation, a popstate without Turbo state, a refresh of a cached URL).
    await start(
      'data-stimeo--character-counter-max-value="3" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
      'aria-invalid="false"',
    );
    type("hello");

    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(root().getAttribute("data-over-limit")).toBe("true");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS);
    expect(announcementMessages).toEqual(["-2 remaining"]);

    type("hi");
    expect(field().getAttribute("aria-invalid")).toBe("false");
  });

  it("gives back the aria-invalid a restored copy carries once its field is no longer over", async () => {
    await boot(`
      <div data-controller="stimeo--character-counter" data-stimeo--character-counter-max-value="3">
        <input id="secret" type="password" aria-describedby="cc"
               data-stimeo--character-counter-target="input">
        <span id="cc" data-stimeo--character-counter-target="output"></span>
      </div>`);
    const secret = query<HTMLInputElement>("#secret");
    type("hunter2", secret);
    expect(secret.getAttribute("aria-invalid")).toBe("true");

    application = await restoreFromCache(
      application as Application,
      (restored) => {
        // Turbo empties a password field in the copy it caches.
        query<HTMLInputElement>("#secret").value = "";
        restored.register("stimeo--announcer", AnnouncerController);
        restored.register("stimeo--character-counter", CharacterCounterController);
      },
      () => vi.advanceTimersByTimeAsync(0),
    );

    const restored = query<HTMLInputElement>("#secret");
    expect(restored.hasAttribute("aria-invalid")).toBe(false);
    expect(restored.getAttributeNames().filter((name) => name.endsWith("-lease"))).toEqual([]);
    expect(root().hasAttribute("data-over-limit")).toBe(false);
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

  it("releases the input listener of a replaced field", async () => {
    const ledger = recordListeners();
    try {
      await start('data-stimeo--character-counter-max-value="10"');
      const previous = field();
      // Its own listener, and the composition tracker's.
      expect(ledger.live(previous, "input")).toHaveLength(2);

      const replacement = document.createElement("textarea");
      replacement.setAttribute("data-stimeo--character-counter-target", "input");
      previous.replaceWith(replacement);
      await vi.advanceTimersByTimeAsync(0);

      expect(ledger.live(previous, "input")).toEqual([]);
      expect(ledger.live(replacement, "input")).toHaveLength(2);
    } finally {
      ledger.restore();
    }
  });

  it("keeps counting a new field while a composition runs in the field it replaced", async () => {
    await start('data-stimeo--character-counter-max-value="10"');
    const previous = field();
    const replacement = document.createElement("textarea");
    replacement.setAttribute("data-stimeo--character-counter-target", "input");
    previous.removeAttribute("data-stimeo--character-counter-target");
    root().prepend(replacement);
    await vi.advanceTimersByTimeAsync(0);

    previous.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type("hello", replacement);

    expect(output().textContent).toBe("5");
  });

  it("drops an announcement still pending for a field that is replaced", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
    );
    const previous = field();
    type("hello", previous);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS / 2);

    const replacement = document.createElement("textarea");
    replacement.value = "ok";
    replacement.setAttribute("data-stimeo--character-counter-target", "input");
    previous.replaceWith(replacement);
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS * 2);

    expect(output().textContent).toBe("8");
    expect(announcementMessages).toEqual([]);
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

  it("clears the state hooks when the field over the limit is removed", async () => {
    await start('data-stimeo--character-counter-max-value="3"', "", "hello");
    expect(root().getAttribute("data-over-limit")).toBe("true");

    field().remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(root().hasAttribute("data-over-limit")).toBe(false);
  });

  it("paints the next display when the first one is removed", async () => {
    await boot(`
      <div data-controller="stimeo--character-counter"
           data-stimeo--character-counter-max-value="10">
        <textarea data-stimeo--character-counter-target="input">hello</textarea>
        <span id="cc" data-stimeo--character-counter-target="output"></span>
        <span id="cc-next" data-stimeo--character-counter-target="output">stale</span>
      </div>`);
    const next = query<HTMLElement>("#cc-next");
    expect(output().textContent).toBe("5");
    expect(next.textContent).toBe("stale");

    output().remove();
    await vi.advanceTimersByTimeAsync(0);

    expect(next.textContent).toBe("5");
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

  it.each([false, true])(
    "keeps a directly attached field's composition through reconciliation (release input target: %s)",
    async (releaseTarget) => {
      await boot(`
        <input data-controller="stimeo--character-counter"
               ${releaseTarget ? 'data-stimeo--character-counter-target="input"' : ""}
               data-stimeo--character-counter-max-value="3"
               data-stimeo--character-counter-announce-text-value="{remaining} left"
               value="hi">`);
      const direct = root() as HTMLInputElement;
      const changes = captureChanges();
      const reconciles = captureReconciles();
      direct.focus();
      direct.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      composeDraft(direct, "hiに");
      if (releaseTarget) {
        direct.removeAttribute("data-stimeo--character-counter-target");
        controller().inputTargetDisconnected(direct);
        await vi.advanceTimersByTimeAsync(0);
      }
      direct.setAttribute("data-stimeo--character-counter-max-value", "1");
      controller().maxValueChanged();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.activeElement).toBe(direct);
      expect(direct.value).toBe("hiに");
      expect(direct.getAttribute("data-over-limit")).toBeNull();
      expect(direct.getAttribute("aria-invalid")).toBeNull();
      expect(changes).toEqual([]);
      expect(reconciles).toEqual([]);
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
      expect(announcementMessages).toEqual([]);

      direct.value = "hello";
      direct.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      expect(direct.getAttribute("data-over-limit")).toBe("true");
      expect(direct.getAttribute("aria-invalid")).toBe("true");
      expect(changes).toEqual([{ length: 5, remaining: -4, over: true }]);
      direct.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
      );
      expect(direct.getAttribute("data-over-limit")).toBe("true");
      expect(direct.getAttribute("aria-invalid")).toBe("true");
      expect(changes).toEqual([{ length: 5, remaining: -4, over: true }]);
      expect(reconciles).toEqual([]);
      await vi.advanceTimersByTimeAsync(ANNOUNCE_MS + 1);
      expect(announcementMessages).toEqual(["-4 left"]);
    },
  );

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

  it("repaints the warning hook, without a reconcile, when only warnAt changes", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-warn-at-value="1"',
      "",
      "hello",
    );
    const reconciles = captureReconciles();
    expect(root().hasAttribute("data-near-limit")).toBe(false);

    root().setAttribute("data-stimeo--character-counter-warn-at-value", "5");
    await vi.advanceTimersByTimeAsync(0);

    expect(root().getAttribute("data-near-limit")).toBe("true");
    expect(reconciles).toEqual([]);
  });

  it("rewords a pending announcement with a template changed during the debounce", async () => {
    await start(
      'data-stimeo--character-counter-max-value="10" ' +
        'data-stimeo--character-counter-announce-text-value="{remaining} remaining"',
    );
    type("hello");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS / 2);

    root().setAttribute("data-stimeo--character-counter-announce-text-value", "{remaining} left");
    await vi.advanceTimersByTimeAsync(ANNOUNCE_MS * 2);

    expect(announcementMessages).toEqual(["5 left"]);
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
