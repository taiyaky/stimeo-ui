import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkeletonController } from "../src/controllers/skeleton_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link SkeletonController}: the initial loading state,
 * the `ready` swap, `aria-busy` mirroring, the min-duration floor, the
 * announcement of the ready transition, survival across an in-page move, and
 * teardown on a real detach.
 */

describe("SkeletonController", () => {
  let application: Application;

  const start = async (attrs = "") => {
    document.body.innerHTML = `
      <div data-controller="stimeo--skeleton" aria-busy="true" ${attrs}
           data-action="content:ready->stimeo--skeleton#ready">
        <div aria-hidden="true" data-stimeo--skeleton-target="placeholder">…</div>
        <div hidden data-stimeo--skeleton-target="content">Loaded</div>
      </div>`;
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    disconnectAndStopApplication(application);
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--skeleton']");
  const placeholder = () => query("[data-stimeo--skeleton-target='placeholder']");
  const content = () => query("[data-stimeo--skeleton-target='content']");
  const instance = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--skeleton",
    ) as SkeletonController;

  /** Collects what the shared announcer was asked to read during `body`. */
  const captureAnnouncements = async (body: () => void | Promise<void>): Promise<string[]> => {
    const seen: string[] = [];
    const spy = (event: Event) => {
      seen.push((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener("stimeo--announcer:announce", spy);
    try {
      await body();
    } finally {
      window.removeEventListener("stimeo--announcer:announce", spy);
    }
    return seen;
  };

  it("starts in the loading state", async () => {
    await start();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(root().getAttribute("aria-busy")).toBe("true");
    expect(placeholder().hidden).toBe(false);
    expect(content().hidden).toBe(true);
  });

  it("swaps to the content on ready", async () => {
    await start();
    instance().ready();
    expect(root().getAttribute("data-state")).toBe("ready");
    expect(root().getAttribute("aria-busy")).toBe("false");
    expect(placeholder().hidden).toBe(true);
    expect(content().hidden).toBe(false);
  });

  it("dispatches a ready event carrying an empty detail", async () => {
    await start();
    // Freeze the whole ordered array (not a name-only flag): the events table
    // declares an empty detail, so a leaked payload must fail here.
    const events: { type: string; detail: unknown }[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => {
      events.push({ type: event.type, detail: (event as CustomEvent<unknown>).detail });
    });
    instance().ready();
    expect(events).toEqual([{ type: "stimeo--skeleton:ready", detail: {} }]);
  });

  it("ignores ready once the content is already shown", async () => {
    await start();
    instance().ready();
    const events: string[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    instance().ready();
    // The swap already happened, so there is no second reveal to announce.
    expect(events).toEqual([]);
    expect(placeholder().hidden).toBe(true);
    expect(content().hidden).toBe(false);
  });

  it("keeps the placeholder up for at least minDuration", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    vi.advanceTimersByTime(100);
    instance().ready();
    // Too soon: still loading.
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(200);
    expect(content().hidden).toBe(false);
    expect(root().getAttribute("data-state")).toBe("ready");
  });

  it("reveals immediately when minDuration has elapsed", async () => {
    await start('data-stimeo--skeleton-min-duration-value="100"');
    vi.advanceTimersByTime(200);
    instance().ready();
    expect(content().hidden).toBe(false);
  });

  it("queues a single reveal when ready repeats during the min-duration wait", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    const events: string[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    instance().ready();
    vi.advanceTimersByTime(100);
    instance().ready();
    vi.advanceTimersByTime(200);
    expect(content().hidden).toBe(false);
    vi.advanceTimersByTime(200);
    // Both signals measure the floor from the same loading start, so a reveal
    // stacked behind the first lands in the same tick; the extra time only
    // widens the window. Either way it would swap — and announce — twice.
    expect(events).toEqual(["stimeo--skeleton:ready"]);
  });

  it("keeps the first queued reveal when a repeat would extend the wait", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    vi.advanceTimersByTime(100);
    // The first signal owns the reveal. Without that guard the repeat replaces
    // the held finish, and a floor raised in between pushes it out again — a
    // stream of ready events would postpone the swap indefinitely.
    instance().minDurationValue = 1000;
    instance().ready();
    vi.advanceTimersByTime(250);
    expect(root().getAttribute("data-state")).toBe("ready");
    expect(content().hidden).toBe(false);
  });

  // --- `minDuration` belongs to one held reveal --------------------------------------

  /**
   * Rewrites `minDuration` and delivers its Value callback directly when the
   * controller defines one, since happy-dom does not reliably run it for an attribute
   * write.
   */
  const declareMinDuration = (value: number) => {
    root().setAttribute("data-stimeo--skeleton-min-duration-value", String(value));
    const callback: unknown = Reflect.get(instance(), "minDurationValueChanged");
    if (typeof callback === "function") callback.call(instance());
  };

  it.each([
    { direction: "shrinks", next: 50 },
    { direction: "grows", next: 5000 },
  ])(
    "keeps a held reveal's deadline when minDuration $direction, and floors the next load anew",
    async ({ next }) => {
      await start('data-stimeo--skeleton-min-duration-value="300"');
      vi.advanceTimersByTime(100);
      instance().ready(); // held back until t=300

      declareMinDuration(next);
      vi.advanceTimersByTime(199);
      expect(root().getAttribute("data-state")).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(root().getAttribute("data-state")).toBe("ready");

      instance().reset(); // the next load measures from here
      instance().ready();
      vi.advanceTimersByTime(next - 1);
      expect(content().hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(content().hidden).toBe(false);
    },
  );

  it("measures the floor from when the placeholder appeared when minDuration changes before ready", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    vi.advanceTimersByTime(100);
    declareMinDuration(150);
    instance().ready(); // 50 ms of the new floor are left, counted from the loading start
    vi.advanceTimersByTime(49);
    expect(content().hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(content().hidden).toBe(false);
  });

  it("reveals and reports nothing from a minDuration change alone", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    const events: string[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    declareMinDuration(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(root().getAttribute("aria-busy")).toBe("true");
    expect(content().hidden).toBe(true);
    expect(events).toEqual([]);
  });

  it("cancels a pending reveal on reset", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    instance().reset();
    // An orphaned reveal timer would undo the reset once it fires.
    vi.advanceTimersByTime(400);
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(content().hidden).toBe(true);
  });

  it("returns to loading on reset", async () => {
    await start();
    instance().ready();
    instance().reset();
    expect(root().getAttribute("data-state")).toBe("loading");
    expect(root().getAttribute("aria-busy")).toBe("true");
    expect(placeholder().hidden).toBe(false);
    expect(content().hidden).toBe(true);
  });

  it("keeps a restored ready state on connect", async () => {
    // A Turbo snapshot taken after the swap carries the ready state on the
    // element; re-entering loading would hide content the consumer already has.
    document.body.innerHTML = `
      <div data-controller="stimeo--skeleton" aria-busy="false" data-state="ready">
        <div hidden aria-hidden="true" data-stimeo--skeleton-target="placeholder">…</div>
        <div data-stimeo--skeleton-target="content">Loaded</div>
      </div>`;
    const events: string[] = [];
    root().addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
    await vi.advanceTimersByTimeAsync(0);

    expect(root().getAttribute("data-state")).toBe("ready");
    expect(root().getAttribute("aria-busy")).toBe("false");
    expect(placeholder().hidden).toBe(true);
    expect(content().hidden).toBe(false);
    // Reconnecting is not a new reveal, so nothing is announced again.
    expect(events).toEqual([]);
  });

  it("announces the ready transition once when wording is supplied", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start('data-stimeo--skeleton-announce-ready-text-value="Content loaded"');
      instance().ready();
      // The transition is the news. Re-asserting a state the region is already
      // in has nothing to report, so a repeat must stay silent.
      instance().ready();
    });
    expect(spoken).toEqual(["Content loaded"]);
  });

  it("announces again once a reset has put the region back into loading", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start('data-stimeo--skeleton-announce-ready-text-value="Content loaded"');
      instance().ready();
      instance().reset();
      instance().ready();
    });
    expect(spoken).toEqual(["Content loaded", "Content loaded"]);
  });

  it("stays silent when no announcement wording is set", async () => {
    const spoken = await captureAnnouncements(async () => {
      await start();
      instance().ready();
    });
    expect(spoken).toEqual([]);
  });

  it("keeps a pending reveal alive across an in-page move", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    instance().ready();
    // A consumer re-inserting the element (a sortable, a teleport) disconnects
    // and reconnects the SAME instance, so the held reveal must survive: the
    // ready signal already arrived and nothing will send it again.
    instance().disconnect();
    instance().connect();
    // Let the microtask checkpoint drain: the reconnect has to disarm the probe
    // the disconnect queued, or the deferred teardown drops the reveal anyway.
    await vi.advanceTimersByTimeAsync(400);
    expect(root().getAttribute("data-state")).toBe("ready");
    expect(content().hidden).toBe(false);
  });

  it("keeps the min-duration floor measuring from the same moment across a move", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    vi.advanceTimersByTime(300);
    // The placeholder never left the screen, so the floor has already elapsed
    // and the reveal is due at once. Restarting it on reconnect would hold the
    // content back for a second full minDuration.
    instance().disconnect();
    instance().connect();
    instance().ready();
    expect(content().hidden).toBe(false);
  });

  it("re-arms after a real detach interrupted the min-duration wait", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    const controller = instance();
    const el = root();
    const parent = el.parentElement as HTMLElement;
    controller.ready();
    // Remove the element first, then invoke disconnect() directly: that is the
    // definite-detach path, so teardown runs synchronously and the test does not
    // wait on Stimulus' MutationObserver, whose flush timing varies by
    // environment (especially under coverage).
    el.remove();
    controller.disconnect();
    parent.appendChild(el);
    controller.connect();
    // A held reveal left behind by the teardown would make every later ready()
    // a no-op, stranding the skeleton for the rest of the session.
    controller.ready();
    vi.advanceTimersByTime(400);
    expect(content().hidden).toBe(false);
  });

  it("clears the pending reveal once the element really leaves", async () => {
    await start('data-stimeo--skeleton-min-duration-value="300"');
    const controller = instance();
    const host = root();
    const el = content();
    const events: string[] = [];
    host.addEventListener("stimeo--skeleton:ready", (event) => events.push(event.type));
    controller.ready();
    host.remove();
    controller.disconnect();
    vi.advanceTimersByTime(400);
    // A node on its way out of the document keeps the markup it had, and the
    // dropped timer must not swap it in after the teardown.
    expect(el.hidden).toBe(true);
    expect(host.getAttribute("data-state")).toBe("loading");
    expect(events).toEqual([]);
  });

  describe("placeholder and content that arrive or stay", () => {
    const TARGET = "data-stimeo--skeleton-target";
    const settle = () => vi.advanceTimersByTimeAsync(0);
    /** An element like the current `name` target, showing as `shown`. */
    const like = (name: "placeholder" | "content", shown: boolean) => {
      const fresh = query(`[${TARGET}='${name}']`).cloneNode(true) as HTMLElement;
      fresh.hidden = !shown;
      return fresh;
    };

    it("shows a placeholder that replaces the current one while loading", async () => {
      await start();
      const successor = like("placeholder", false);

      placeholder().replaceWith(successor);
      await settle();

      expect(placeholder()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("shows content that replaces the current one once ready", async () => {
      await start();
      instance().ready();
      const successor = like("content", false);

      content().replaceWith(successor);
      await settle();

      expect(content()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("hides a placeholder that stays after an earlier one leaves once ready", async () => {
      await start();
      const original = placeholder();
      const successor = like("placeholder", true);
      original.after(successor);
      await settle();
      instance().ready();
      original.remove();
      await settle();

      expect(placeholder()).toBe(successor);
      expect(successor.hidden).toBe(true);
    });

    it("shows content that stays after an earlier one leaves once ready", async () => {
      await start();
      const original = content();
      const successor = like("content", false);
      original.after(successor);
      await settle();
      instance().ready();
      original.remove();
      await settle();

      expect(content()).toBe(successor);
      expect(successor.hidden).toBe(false);
    });

    it("hides content that stays after an earlier one leaves once reset", async () => {
      await start();
      instance().ready();
      const original = content();
      const successor = like("content", true);
      original.after(successor);
      await settle();
      instance().reset();
      original.remove();
      await settle();

      expect(content()).toBe(successor);
      expect(successor.hidden).toBe(true);
    });

    it("brings the placeholder and content up to date without an event or an announcement", async () => {
      await start('data-stimeo--skeleton-announce-ready-text-value="Content loaded"');
      instance().ready();
      const events: string[] = [];
      root().addEventListener("stimeo--skeleton:ready", () => events.push("ready"));
      root().addEventListener("change", () => events.push("native change"));
      const shell = like("placeholder", true);
      const body = like("content", false);

      const spoken = await captureAnnouncements(async () => {
        placeholder().replaceWith(shell);
        content().replaceWith(body);
        await settle();
      });

      expect(shell.hidden).toBe(true);
      expect(body.hidden).toBe(false);
      expect(root().getAttribute("data-state")).toBe("ready");
      expect(events).toEqual([]);
      expect(spoken).toEqual([]);
    });

    it.each(["placeholder", "content"] as const)(
      "keeps working when its only %s leaves",
      async (name) => {
        await start();
        const errors: unknown[] = [];
        application.handleError = (error) => {
          errors.push(error);
        };
        query(`[${TARGET}='${name}']`).remove();
        await settle();
        instance().ready();
        instance().reset();
        await settle();

        expect(errors).toEqual([]);
        expect(root().getAttribute("data-state")).toBe("loading");
      },
    );

    it("hides a placeholder that arrives after the only one left once ready", async () => {
      await start();
      instance().ready();
      const template = like("placeholder", true);
      placeholder().remove();
      await settle();

      root().prepend(template);
      await settle();

      expect(template.hidden).toBe(true);
    });

    it("shows content that arrives after the only one left once ready", async () => {
      await start();
      instance().ready();
      const template = like("content", false);
      content().remove();
      await settle();

      root().append(template);
      await settle();

      expect(template.hidden).toBe(false);
    });

    it("gives content that stops being one back the hidden it was authored with", async () => {
      await start();
      instance().ready();
      const departed = content();
      expect(departed.hidden).toBe(false);

      departed.removeAttribute(TARGET);
      await settle();

      expect(departed.hidden).toBe(true);
    });

    it("removes the hidden it wrote on a departed placeholder that was authored without one", async () => {
      await start();
      instance().ready();
      const departed = placeholder();
      expect(departed.hidden).toBe(true);

      departed.removeAttribute(TARGET);
      await settle();

      expect(departed.hasAttribute("hidden")).toBe(false);
    });

    it("keeps a hidden the page wrote on the content after the last write", async () => {
      await start();
      instance().ready();
      const departed = content();
      departed.hidden = true;

      departed.removeAttribute(TARGET);
      await settle();

      expect(departed.hidden).toBe(true);
    });

    it("gives the placeholder and content back their own hidden when the skeleton loses its controller", async () => {
      await start();
      instance().ready();
      const shell = placeholder();
      const body = content();

      root().removeAttribute("data-controller");
      await settle();

      expect(shell.hasAttribute("hidden")).toBe(false);
      expect(body.hidden).toBe(true);
    });

    it("keeps content that moves within the skeleton shown without touching it", async () => {
      await start();
      instance().ready();
      const moving = content();
      const writes: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.attributeName === "hidden") writes.push(String(record.oldValue));
        }
      }).observe(moving, { attributes: true, attributeOldValue: true });

      root().prepend(moving);
      await settle();

      expect(content()).toBe(moving);
      expect(moving.hidden).toBe(false);
      expect(writes).toEqual([]);
    });

    it("keeps what it wrote on the content when the whole skeleton leaves the page", async () => {
      await start();
      instance().ready();
      const kept = content();

      root().remove();
      await settle();

      expect(kept.hidden).toBe(false);
    });

    it("writes nothing onto the placeholder or content while Stimulus tears the controller down", async () => {
      await start();
      instance().ready();
      // A value the page wrote after the last write stays where it was left.
      content().hidden = true;

      application.unload("stimeo--skeleton");
      await settle();

      expect(content().hidden).toBe(true);
    });
  });
});

/** The axe audit runs under real timers, independent of the timing behavior. */
describe("SkeletonController accessibility", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("has no machine-detectable a11y violations in either state", async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--skeleton" aria-busy="true"
             data-action="content:ready->stimeo--skeleton#ready">
          <div aria-hidden="true" data-stimeo--skeleton-target="placeholder">…</div>
          <div hidden data-stimeo--skeleton-target="content"><p>Loaded</p></div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
    await tick();
    await expectNoA11yViolations(document.body);

    const root = query("[data-controller='stimeo--skeleton']");
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--skeleton",
    ) as SkeletonController;
    controller.ready();
    await expectNoA11yViolations(document.body);
  });

  // The decorative placeholder is aria-hidden, so the skeleton is never announced;
  // once ready, the real content is exposed to the reader.
  it("keeps the skeleton silent and announces the content once ready", async () => {
    document.body.innerHTML = `
      <main>
        <div data-controller="stimeo--skeleton" aria-busy="true"
             data-action="content:ready->stimeo--skeleton#ready">
          <div aria-hidden="true" data-stimeo--skeleton-target="placeholder">
            <span>shimmer placeholder</span>
          </div>
          <div hidden data-stimeo--skeleton-target="content">
            <h3>Article title</h3>
          </div>
        </div>
      </main>`;
    application = Application.start();
    application.register("stimeo--skeleton", SkeletonController);
    await tick();

    const root = query("[data-controller='stimeo--skeleton']");
    // Freeze the whole ordered array (not a name-only `not.toContain`): while loading,
    // the aria-hidden placeholder text is silent and only the busy region announces.
    const loadingSpeech = await captureSpeech({ container: root, steps: 2 });
    expect(loadingSpeech).toEqual(["busy", "busy", "busy"]);

    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--skeleton",
    ) as SkeletonController;
    controller.ready();

    // Freeze the whole ordered array (not a name-only `toContain`): once ready, the
    // busy state clears and the revealed content heading announces in order.
    const readySpeech = await captureSpeech({ container: root, steps: 2 });
    expect(readySpeech).toEqual(["not busy", "heading, Article title, level 3", "end, not busy"]);
  });
});
