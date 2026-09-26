import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlashController } from "../src/controllers/flash_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link FlashController}, driven by a mocked clock: type → role
 * mapping, the Announcer bridge for initial flashes (but not dynamic inserts),
 * auto-dismiss with pause-on-hover, the `max` stacking cap and the messages hover or
 * focus keeps out of its reach, manual dismiss, dynamic detection via the
 * MutationObserver, and observer / timer teardown.
 */

describe("FlashController", () => {
  let application: Application;
  let announces: Array<{ message?: string; assertive?: boolean }>;

  const onAnnounce = (e: Event) => announces.push((e as CustomEvent).detail);

  const mount = async (html: string) => {
    document.body.innerHTML = html;
    application = Application.start();
    application.register("stimeo--flash", FlashController);
    await vi.advanceTimersByTimeAsync(0);
  };

  const region = (inner: string, attrs = "") =>
    `<div data-controller="stimeo--flash" ${attrs}>
       <div data-stimeo--flash-target="region">${inner}</div>
     </div>`;

  const message = (type: string, text = "msg", extra = "") =>
    `<div data-stimeo--flash-target="message" data-flash-type="${type}" ${extra}>${text}</div>`;

  beforeEach(() => {
    vi.useFakeTimers();
    announces = [];
    window.addEventListener("stimeo--announcer:announce", onAnnounce);
  });

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnounce);
    disconnectAndStopApplication(application);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const root = () => query("[data-controller='stimeo--flash']");
  const regionEl = () => query("[data-stimeo--flash-target='region']");
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("maps a notice to role=status and bridges it to the Announcer (polite)", async () => {
    await mount(region(message("notice", "Saved")));
    const el = regionEl().firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("data-flash-state")).toBe("visible");
    expect(announces).toEqual([{ message: "Saved", assertive: false }]);
  });

  it("leaves the region without aria-live so a dynamic flash is announced once", async () => {
    await mount(region(message("notice", "Saved")));
    // Announcing is the message's own `role` (plus the Announcer bridge for initial
    // flashes); a live region here would read every dynamic insert a second time.
    expect(regionEl().hasAttribute("aria-live")).toBe(false);
    regionEl().insertAdjacentHTML("beforeend", message("alert", "Failed"));
    await flush();
    expect(regionEl().hasAttribute("aria-live")).toBe(false);
  });

  it("maps an alert to role=alert and bridges it assertively", async () => {
    await mount(region(message("alert", "Failed")));
    const el = regionEl().firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("alert");
    expect(announces).toEqual([{ message: "Failed", assertive: true }]);
  });

  it("dispatches show with the type and text", async () => {
    const shows: Array<{ type: string; message: string }> = [];
    const onShow = (e: Event) => shows.push((e as CustomEvent).detail);
    // show bubbles, so a document listener catches the connect-time dispatch.
    document.addEventListener("stimeo--flash:show", onShow);
    try {
      await mount(region(message("notice", "Saved")));
      expect(shows).toEqual([{ type: "notice", message: "Saved" }]);
    } finally {
      document.removeEventListener("stimeo--flash:show", onShow);
    }
  });

  it("does not clobber an authored role", async () => {
    await mount(region(message("alert", "Hi", 'role="status"')));
    expect((regionEl().firstElementChild as HTMLElement).getAttribute("role")).toBe("status");
  });

  it("auto-dismisses after the duration, animating via the leaving state", async () => {
    const real = window.getComputedStyle;
    // Two leave properties: the longer one also carries a delay, so removal must
    // wait max(50, 150 + 50) = 200ms — not the first duration value alone.
    window.getComputedStyle = ((el: Element) =>
      ({
        ...real(el),
        transitionProperty: "opacity, transform",
        transitionDuration: "0.05s, 0.15s",
        transitionDelay: "0s, 0.05s",
      }) as CSSStyleDeclaration) as typeof getComputedStyle;
    try {
      const dismissed: string[] = [];
      await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
      root().addEventListener("stimeo--flash:dismiss", (e) =>
        dismissed.push((e as CustomEvent).detail.reason),
      );
      const el = regionEl().firstElementChild as HTMLElement;

      vi.advanceTimersByTime(1000);
      expect(el.getAttribute("data-flash-state")).toBe("leaving");
      expect(el.isConnected).toBe(true);

      vi.advanceTimersByTime(199);
      expect(el.isConnected).toBe(true);

      vi.advanceTimersByTime(1);
      expect(el.isConnected).toBe(false);
      expect(dismissed).toEqual(["timeout"]);
    } finally {
      window.getComputedStyle = real;
    }
  });

  it("never auto-dismisses when duration is 0", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="0"'));
    vi.advanceTimersByTime(60_000);
    expect(regionEl().firstElementChild).not.toBeNull();
  });

  it("pauses the auto-dismiss timer while hovered", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;

    vi.advanceTimersByTime(600);
    el.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(5000); // paused: must not dismiss
    expect(el.isConnected).toBe(true);

    el.dispatchEvent(new Event("mouseleave")); // resume with 400ms left
    vi.advanceTimersByTime(399);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("caps simultaneous flashes at max, dropping the oldest", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B") + message("notice", "C"),
        'data-stimeo--flash-max-value="2"',
      ),
    );
    const texts = Array.from(regionEl().children).map((c) => c.textContent?.trim());
    expect(texts).toEqual(["B", "C"]);
  });

  it("dismisses an evicted flash with reason 'limit'", async () => {
    await mount(
      region(message("notice", "A") + message("notice", "B"), 'data-stimeo--flash-max-value="2"'),
    );
    const reasons: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      reasons.push((e as CustomEvent).detail.reason),
    );
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C")); // pushes past max
    await flush();
    expect(reasons).toEqual(["limit"]); // oldest (A) evicted by the cap
  });

  it("processes a dynamically inserted flash via its own role, without re-bridging", async () => {
    await mount(region(""));
    announces = [];
    regionEl().insertAdjacentHTML("beforeend", message("alert", "Late"));
    await flush();
    const el = regionEl().firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("alert");
    expect(el.getAttribute("data-flash-state")).toBe("visible");
    // Dynamic inserts are announced by their own role, so no Announcer bridge.
    expect(announces).toEqual([]);
  });

  it("processes flashes nested inside an inserted wrapper (Turbo Stream)", async () => {
    await mount(region(""));
    // Turbo Stream often appends a wrapper element that contains the flash.
    regionEl().insertAdjacentHTML("beforeend", `<div>${message("notice", "Wrapped")}</div>`);
    await flush();
    const el = regionEl().querySelector("[data-stimeo--flash-target='message']") as HTMLElement;
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("data-flash-state")).toBe("visible");
  });

  it("dismisses a flash when its close control fires the dismiss action", async () => {
    await mount(
      region(
        `<div data-stimeo--flash-target="message" data-flash-type="notice">Saved
           <button data-action="stimeo--flash#dismiss">x</button>
         </div>`,
        'data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );
    (query("button") as HTMLButtonElement).click();
    expect(regionEl().firstElementChild).toBeNull();
    expect(dismissed).toEqual(["user"]);
  });

  it.each([
    [
      "surrounded by whitespace",
      `<div data-controller="stimeo--flash" data-stimeo--flash-duration-value="0">
         <div data-stimeo--flash-target="region">
           <div data-stimeo--flash-target=" message " data-flash-type="notice">Saved
             <button data-action="stimeo--flash#dismiss">x</button>
           </div>
         </div>
       </div>`,
    ],
    [
      "sharing the attribute with the region name",
      `<div data-controller="stimeo--flash" data-stimeo--flash-duration-value="0">
         <div data-stimeo--flash-target="message region" data-flash-type="notice">Saved
           <button data-action="stimeo--flash#dismiss">x</button>
         </div>
       </div>`,
    ],
  ])("dismisses through a close control with the target name %s", async (_label, html) => {
    await mount(html);
    const el = query("[data-flash-type='notice']");
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );

    // `data-<identifier>-target` is a space-separated token list, so a name padded by
    // whitespace or standing next to another target name still names that target —
    // the same reading Stimulus itself applies when it resolves the target set.
    (query("button") as HTMLButtonElement).click();

    expect(el.isConnected).toBe(false);
    expect(dismissed).toEqual(["user"]);
  });

  it("stops observing and clears timers after disconnect", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const detachedRegion = regionEl();
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );
    root().remove();
    await flush();

    // The pending auto-dismiss timer was cleared on disconnect.
    vi.advanceTimersByTime(5000);
    expect(dismissed).toEqual([]);

    // The observer is severed: inserting a flash into the detached region is ignored.
    detachedRegion.insertAdjacentHTML("beforeend", message("alert", "Late"));
    await flush();
    expect(detachedRegion.lastElementChild?.hasAttribute("data-flash-state")).toBe(false);
  });

  it("takes the managed flashes out of the page before Turbo caches it", async () => {
    await mount(
      region(
        message("notice", "Saved") + message("alert", "Failed"),
        'data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );

    // A flash the visitor has already read must not ride the snapshot back: the fresh
    // connect() on restore would take it for a new one and announce it again. Never
    // auto-dismissing does not make it any less of a one-shot notification.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(regionEl().children).toHaveLength(0);
    expect(dismissed).toEqual([]); // caching a page is not a dismissal
  });

  it("reports the messages the cache rewind took out", async () => {
    await mount(region(message("notice", "Saved")));
    const reports: unknown[] = [];
    root().addEventListener("stimeo--flash:reconcile", (e) =>
      reports.push((e as CustomEvent).detail),
    );

    document.dispatchEvent(new Event("turbo:before-cache"));
    // Nobody dismissed them, so `dismiss` would misreport; the rewind says how
    // many it removed so a consumer counting messages can follow.
    expect(reports).toEqual([{ removed: 1 }]);

    // The region is empty now, so a second snapshot has nothing to report.
    document.dispatchEvent(new Event("turbo:before-cache"));
    expect(reports).toEqual([{ removed: 1 }]);
  });

  it("takes a message mid-dismissal out of the page before Turbo caches it", async () => {
    const real = window.getComputedStyle;
    window.getComputedStyle = (() =>
      ({
        transitionProperty: "opacity",
        transitionDuration: "0.2s",
        transitionDelay: "0s",
      }) as unknown as CSSStyleDeclaration) as typeof getComputedStyle;
    try {
      await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
      const el = regionEl().firstElementChild as HTMLElement;
      vi.advanceTimersByTime(1000);
      expect(el.getAttribute("data-flash-state")).toBe("leaving");

      document.dispatchEvent(new Event("turbo:before-cache"));
      expect(el.isConnected).toBe(false);
    } finally {
      window.getComputedStyle = real;
    }
  });

  it("cancels a pending finalize when the controller disconnects mid-transition", async () => {
    const real = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) =>
      ({
        ...real(el),
        transitionProperty: "opacity",
        transitionDuration: "0.2s",
        transitionDelay: "0s",
      }) as CSSStyleDeclaration) as typeof getComputedStyle;
    try {
      await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
      const el = regionEl().firstElementChild as HTMLElement;
      const dismissed: string[] = [];
      root().addEventListener("stimeo--flash:dismiss", (e) =>
        dismissed.push((e as CustomEvent).detail.reason),
      );

      vi.advanceTimersByTime(1000); // leaving: the finalize timer is pending
      root().remove(); // disconnect inside the transition window
      await flush();
      vi.advanceTimersByTime(5000);

      expect(dismissed).toEqual([]);
      expect(el.parentElement).not.toBeNull(); // the detached tree is left alone
    } finally {
      window.getComputedStyle = real;
    }
  });

  it("re-arms the auto-dismiss after an in-page move", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(root()); // Stimulus tears the element down and reconnects it
    await flush();
    vi.advanceTimersByTime(1000);
    expect(el.isConnected).toBe(false);
  });

  it("processes a flash inserted into an existing container inside the region", async () => {
    await mount(region(`<div class="stack"></div>`));
    const stack = query(".stack");
    stack.insertAdjacentHTML("beforeend", message("notice", "Deep"));
    await flush();
    expect((stack.firstElementChild as HTMLElement).getAttribute("data-flash-state")).toBe(
      "visible",
    );
  });

  // --- pause / resume -------------------------------------------------------

  it("keeps the auto-dismiss paused while the pointer is still over the message", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;

    vi.advanceTimersByTime(600);
    el.dispatchEvent(new Event("mouseenter")); // hovered: 400ms banked
    el.dispatchEvent(new Event("focusin"));
    el.dispatchEvent(new Event("focusout")); // focus left, the pointer has not
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);

    el.dispatchEvent(new Event("mouseleave")); // last reason released
    vi.advanceTimersByTime(399);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("keeps the auto-dismiss paused while focus is still inside the message", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;

    vi.advanceTimersByTime(600);
    el.dispatchEvent(new Event("focusin")); // focused: 400ms banked
    el.dispatchEvent(new Event("mouseenter"));
    el.dispatchEvent(new Event("mouseleave")); // the pointer left, focus has not
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);

    el.dispatchEvent(new Event("focusout"));
    vi.advanceTimersByTime(400);
    expect(el.isConnected).toBe(false);
  });

  it("keeps the deadline when focus moves between controls inside the message", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;

    // focusout/focusin bubble from the message's own children, so a control-to-
    // control move must not hand the message a fresh window.
    vi.advanceTimersByTime(600);
    el.dispatchEvent(new Event("focusout")); // control A loses focus …
    el.dispatchEvent(new Event("focusin")); // … control B takes it, same message
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true); // focus is still inside: paused

    el.dispatchEvent(new Event("focusout")); // focus finally leaves
    vi.advanceTimersByTime(399);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false); // exactly the 400ms banked at the move
  });

  it("pauses the auto-dismiss timer while focused", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;

    vi.advanceTimersByTime(600);
    el.dispatchEvent(new Event("focusin"));
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);
    el.dispatchEvent(new Event("focusout"));
    vi.advanceTimersByTime(400);
    expect(el.isConnected).toBe(false);
  });

  it("pauses when focus enters a control inside the message", async () => {
    await mount(
      region(
        `<div data-stimeo--flash-target="message" data-flash-type="notice">Saved
           <button id="undo">Undo</button>
         </div>`,
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const el = regionEl().firstElementChild as HTMLElement;

    // focusin/focusout bubble, so the message hears them with `target` set to the
    // child control. The bookkeeping is keyed by the message, not the event's origin.
    vi.advanceTimersByTime(600);
    query("#undo").dispatchEvent(new Event("focusin", { bubbles: true })); // 400ms banked
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);

    query("#undo").dispatchEvent(new Event("focusout", { bubbles: true }));
    vi.advanceTimersByTime(399);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("banks the time left again on a second pause", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;

    vi.advanceTimersByTime(600);
    el.dispatchEvent(new Event("mouseenter")); // 400ms banked
    el.dispatchEvent(new Event("mouseleave")); // resumed with the banked 400ms
    vi.advanceTimersByTime(200);
    el.dispatchEvent(new Event("mouseenter")); // 200ms banked, not the full duration
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true);

    el.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(199);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("does not pause on hover when pauseOnHover is false", async () => {
    await mount(
      region(
        message("notice", "Saved"),
        'data-stimeo--flash-duration-value="1000" data-stimeo--flash-pause-on-hover-value="false"',
      ),
    );
    const el = regionEl().firstElementChild as HTMLElement;
    el.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(1000);
    expect(el.isConnected).toBe(false);
  });

  it("ignores hover on a message that never auto-dismisses", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="0"'));
    const el = regionEl().firstElementChild as HTMLElement;
    el.dispatchEvent(new Event("mouseenter"));
    el.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(60_000);
    expect(el.isConnected).toBe(true);
  });

  it("dismisses a message whose banked time already elapsed once the pause ends", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );

    // The deadline passed while the timer sat queued (a throttled tab, a long task).
    vi.setSystemTime(Date.now() + 1500);
    el.dispatchEvent(new Event("mouseenter"));
    vi.advanceTimersByTime(5000);
    expect(el.isConnected).toBe(true); // pausing is never what takes a message away

    el.dispatchEvent(new Event("mouseleave"));
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
    expect(dismissed).toEqual(["timeout"]);
  });

  it("keeps focus inside a message whose deadline lapsed before focus entered it", async () => {
    await mount(
      region(
        `<div data-stimeo--flash-target="message" data-flash-type="notice">Saved
           <button data-action="stimeo--flash#dismiss">x</button>
         </div>`,
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const el = regionEl().firstElementChild as HTMLElement;
    const button = query("button") as HTMLButtonElement;

    // Same lapsed-deadline window as above, entered by focus instead of the pointer.
    // Removing the message here would take the focused control with it (WCAG 2.2 4.1.3).
    vi.setSystemTime(Date.now() + 1500);
    button.focus();
    button.dispatchEvent(new Event("focusin", { bubbles: true }));

    expect(document.activeElement).toBe(button);
    expect(el.isConnected).toBe(true);
  });

  // --- dismissal ------------------------------------------------------------

  it("emits dismiss once when the close control fires during the leaving transition", async () => {
    const real = window.getComputedStyle;
    window.getComputedStyle = ((el: Element) =>
      ({
        ...real(el),
        transitionProperty: "opacity",
        transitionDuration: "0.2s",
        transitionDelay: "0s",
      }) as CSSStyleDeclaration) as typeof getComputedStyle;
    try {
      await mount(
        region(
          `<div data-stimeo--flash-target="message" data-flash-type="notice">Saved
             <button data-action="stimeo--flash#dismiss">x</button>
           </div>`,
          'data-stimeo--flash-duration-value="1000"',
        ),
      );
      const reasons: string[] = [];
      root().addEventListener("stimeo--flash:dismiss", (e) =>
        reasons.push((e as CustomEvent).detail.reason),
      );

      vi.advanceTimersByTime(1000); // the auto-dismiss starts the leaving transition
      (query("button") as HTMLButtonElement).click(); // the user clicks x mid-fade
      vi.advanceTimersByTime(1000);
      expect(reasons).toEqual(["timeout"]);
    } finally {
      window.getComputedStyle = real;
    }
  });

  it("dispatches dismiss with the removed element", async () => {
    await mount(
      region(
        `<div data-stimeo--flash-target="message" data-flash-type="notice">Saved
           <button data-action="stimeo--flash#dismiss">x</button>
         </div>`,
        'data-stimeo--flash-duration-value="0"',
      ),
    );
    const el = regionEl().firstElementChild as HTMLElement;
    const details: Array<{ element: HTMLElement; reason: string }> = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      details.push((e as CustomEvent).detail),
    );
    (query("button") as HTMLButtonElement).click();
    expect(details).toHaveLength(1);
    expect(details[0]?.element).toBe(el);
    expect(details[0]?.reason).toBe("user");
  });

  it("ignores a dismiss action fired outside any message", async () => {
    await mount(
      `<div data-controller="stimeo--flash">
         <button data-action="stimeo--flash#dismiss">outside</button>
         <div data-stimeo--flash-target="region">${message("notice", "Saved")}</div>
       </div>`,
    );
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );
    (query("button") as HTMLButtonElement).click();
    expect(regionEl().firstElementChild).not.toBeNull();
    expect(dismissed).toEqual([]);
  });

  it("ignores a dismiss action on a message it does not own", async () => {
    await mount(
      `<div data-controller="stimeo--flash">
         <div data-stimeo--flash-target="region"></div>
         <div data-stimeo--flash-target="message" data-flash-type="notice">Outside
           <button data-action="stimeo--flash#dismiss">x</button>
         </div>
       </div>`,
    );
    const el = query("[data-stimeo--flash-target='message']");
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );

    // The close control resolves to a message this controller never took on, so its
    // removal is the consumer's business — the bookkeeping is what grants the right
    // to remove, and there is no entry for this node.
    (query("button") as HTMLButtonElement).click();
    expect(el.isConnected).toBe(true);
    expect(el.hasAttribute("data-flash-state")).toBe(false);
    expect(dismissed).toEqual([]);
  });

  it("removes a message immediately when the engine reports no transition", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const el = regionEl().firstElementChild as HTMLElement;
    const real = window.getComputedStyle;
    (window as { getComputedStyle?: unknown }).getComputedStyle = undefined;
    try {
      vi.advanceTimersByTime(1000);
      expect(el.isConnected).toBe(false);
    } finally {
      window.getComputedStyle = real;
    }
  });

  // --- target lifecycle -----------------------------------------------------

  it("re-points the observation when the region element is replaced at runtime", async () => {
    await mount(region(""));
    const fresh = document.createElement("div");
    fresh.setAttribute("data-stimeo--flash-target", "region");
    fresh.innerHTML = message("alert", "Rendered with the new region");
    regionEl().replaceWith(fresh);
    await flush();

    // The messages the replacement brought with it are picked up …
    const carried = fresh.firstElementChild as HTMLElement;
    expect(carried.getAttribute("role")).toBe("alert");
    expect(carried.getAttribute("data-flash-state")).toBe("visible");

    // … and the new element is the one being observed.
    fresh.insertAdjacentHTML("beforeend", message("notice", "Late"));
    await flush();
    expect((fresh.lastElementChild as HTMLElement).getAttribute("data-flash-state")).toBe(
      "visible",
    );
  });

  it("arms when the region target arrives after connect", async () => {
    await mount(`<div data-controller="stimeo--flash"></div>`);
    const fresh = document.createElement("div");
    fresh.setAttribute("data-stimeo--flash-target", "region");
    root().appendChild(fresh);
    await flush();
    fresh.insertAdjacentHTML("beforeend", message("notice", "Late"));
    await flush();
    expect((fresh.firstElementChild as HTMLElement).getAttribute("role")).toBe("status");
  });

  it("does nothing when the region target is missing", async () => {
    await mount(`<div data-controller="stimeo--flash">${message("notice", "Orphan")}</div>`);
    const el = query("[data-stimeo--flash-target='message']");
    expect(el.hasAttribute("role")).toBe(false);
    expect(el.hasAttribute("data-flash-state")).toBe(false);
    expect(announces).toEqual([]);
  });

  it("leaves a message outside the region to the consumer", async () => {
    await mount(
      `<div data-controller="stimeo--flash">
         <div data-stimeo--flash-target="region"></div>
         ${message("notice", "Outside")}
       </div>`,
    );
    // The stack is the region's subtree; a message target parked elsewhere in the
    // controller's scope is the consumer's markup, not a flash to manage.
    const el = query("[data-stimeo--flash-target='message']");
    expect(el.hasAttribute("data-flash-state")).toBe(false);
    expect(announces).toEqual([]);

    // Losing the region leaves nothing to stack into, exactly as if the controller had
    // connected that way — so the re-scan must not adopt what is left over either.
    regionEl().remove();
    await flush();
    expect(el.hasAttribute("data-flash-state")).toBe(false);
    expect(announces).toEqual([]);
  });

  it("ignores non-element nodes inserted into the region", async () => {
    await mount(region(""));
    const el = document.createElement("div");
    el.setAttribute("data-stimeo--flash-target", "message");
    el.setAttribute("data-flash-type", "notice");
    el.textContent = "After the stray text node";
    regionEl().append(document.createTextNode("stray"), el);
    await flush();
    expect(el.getAttribute("data-flash-state")).toBe("visible");
  });

  it("releases the stacking slot of a message removed from the region", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B") + message("notice", "C"),
        'data-stimeo--flash-max-value="3" data-stimeo--flash-duration-value="0"',
      ),
    );
    (regionEl().children[1] as HTMLElement).remove(); // e.g. <turbo-stream action="remove">
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "D"));
    await flush();
    const texts = Array.from(regionEl().children).map((c) => c.textContent?.trim());
    expect(texts).toEqual(["A", "C", "D"]);
  });

  it("cancels the auto-dismiss of a message removed from the region", async () => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );
    (regionEl().firstElementChild as HTMLElement).remove();
    await flush();
    vi.advanceTimersByTime(5000);
    expect(dismissed).toEqual([]);
  });

  it.each([
    ["removed", (el: HTMLElement) => el.removeAttribute("data-stimeo--flash-target")],
    ["renamed", (el: HTMLElement) => el.setAttribute("data-stimeo--flash-target", "archived")],
  ])("releases a message whose target attribute is %s in place", async (_label, rewrite) => {
    await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
    const dismissed: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) =>
      dismissed.push((e as CustomEvent).detail.reason),
    );
    const el = regionEl().firstElementChild as HTMLElement;

    // A morph can rewrite the attribute without moving the node. The element stays in
    // the region, so `contains()` alone reads this as a reorder and keeps the
    // auto-dismiss running against a node that belongs to the consumer.
    rewrite(el);
    await flush();

    vi.advanceTimersByTime(5000);
    expect(dismissed).toEqual([]);
    expect(el.isConnected).toBe(true);
  });

  it.each([
    ["removed", (el: HTMLElement) => el.removeAttribute("data-stimeo--flash-target")],
    ["renamed", (el: HTMLElement) => el.setAttribute("data-stimeo--flash-target", "archived")],
  ])(
    "cancels the pending finalize when the target attribute is %s mid-dismissal",
    async (_label, rewrite) => {
      const real = window.getComputedStyle;
      window.getComputedStyle = (() =>
        ({
          transitionProperty: "opacity",
          transitionDuration: "0.2s",
          transitionDelay: "0s",
        }) as unknown as CSSStyleDeclaration) as typeof getComputedStyle;
      try {
        await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
        const dismissed: string[] = [];
        root().addEventListener("stimeo--flash:dismiss", (e) =>
          dismissed.push((e as CustomEvent).detail.reason),
        );
        const el = regionEl().firstElementChild as HTMLElement;

        // The removal is already scheduled when the morph lands, so ownership has to be
        // re-checked at the far end of the transition too — not only when it starts.
        vi.advanceTimersByTime(1000);
        expect(el.getAttribute("data-flash-state")).toBe("leaving");
        rewrite(el);
        await flush();

        vi.advanceTimersByTime(5000);
        expect(el.isConnected).toBe(true);
        expect(dismissed).toEqual([]);
      } finally {
        window.getComputedStyle = real;
      }
    },
  );

  it("does not show a leaving message again when the region is re-scanned", async () => {
    const real = window.getComputedStyle;
    window.getComputedStyle = (() =>
      ({
        transitionProperty: "opacity",
        transitionDuration: "0.2s",
        transitionDelay: "0s",
      }) as unknown as CSSStyleDeclaration) as typeof getComputedStyle;
    const shows: string[] = [];
    const onShow = (e: Event) => shows.push((e as CustomEvent).detail.message);
    document.addEventListener("stimeo--flash:show", onShow);
    try {
      await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
      const el = regionEl().firstElementChild as HTMLElement;
      vi.advanceTimersByTime(1000); // auto-dismiss started: leaving, finalize pending
      expect(el.getAttribute("data-flash-state")).toBe("leaving");

      // A second `region` arriving before the old one leaves (Turbo Stream `after`)
      // re-scans the messages. The leaving one is in neither collection by then.
      const fresh = document.createElement("div");
      fresh.setAttribute("data-stimeo--flash-target", "region");
      regionEl().after(fresh);
      await flush();

      expect(shows).toEqual(["Saved"]);
      expect(el.getAttribute("data-flash-state")).toBe("leaving");
    } finally {
      document.removeEventListener("stimeo--flash:show", onShow);
      window.getComputedStyle = real;
    }
  });

  it("shows a dismissed message again when the same node is put back", async () => {
    const shows: string[] = [];
    const onShow = (e: Event) => shows.push((e as CustomEvent).detail.message);
    document.addEventListener("stimeo--flash:show", onShow);
    try {
      await mount(region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"'));
      const el = regionEl().firstElementChild as HTMLElement;
      vi.advanceTimersByTime(1000);
      expect(el.isConnected).toBe(false);

      // The dismissal is over, so the node carries no claim from this controller: a
      // consumer re-appending it starts a fresh flash rather than an inert one.
      regionEl().appendChild(el);
      await flush();
      expect(shows).toEqual(["Saved", "Saved"]);
      expect(el.getAttribute("data-flash-state")).toBe("visible");
    } finally {
      document.removeEventListener("stimeo--flash:show", onShow);
    }
  });

  it("revives a message left mid-dismissal by an in-page move", async () => {
    const real = window.getComputedStyle;
    window.getComputedStyle = (() =>
      ({
        transitionProperty: "opacity",
        transitionDuration: "0.2s",
        transitionDelay: "0s",
      }) as unknown as CSSStyleDeclaration) as typeof getComputedStyle;
    try {
      document.body.innerHTML = `<div id="from">${region(message("notice", "Saved"), 'data-stimeo--flash-duration-value="1000"')}</div><div id="to"></div>`;
      application = Application.start();
      application.register("stimeo--flash", FlashController);
      await flush();
      const el = regionEl().firstElementChild as HTMLElement;
      vi.advanceTimersByTime(1000);
      expect(el.getAttribute("data-flash-state")).toBe("leaving");

      // The move tears the controller down mid-transition, so the finalize that would
      // have removed the message dies with it. Reconnecting must not leave the message
      // stranded as `leaving` with nothing left to dismiss it.
      query("#to").appendChild(root());
      await flush();
      expect(el.getAttribute("data-flash-state")).toBe("visible");
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(200);
      expect(el.isConnected).toBe(false);
    } finally {
      window.getComputedStyle = real;
    }
  });

  it("keeps the deadline when a message is moved within the region", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const first = regionEl().firstElementChild as HTMLElement;
    vi.advanceTimersByTime(600);
    regionEl().appendChild(first); // reorder: same node, same region
    await flush();
    vi.advanceTimersByTime(399);
    expect(first.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first.isConnected).toBe(false);
  });

  it("restores a leaving message brought back by a snapshot", async () => {
    await mount(
      region(
        `<div data-stimeo--flash-target="message" data-flash-type="notice" data-flash-state="leaving">Restored</div>`,
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const el = regionEl().firstElementChild as HTMLElement;
    expect(el.getAttribute("data-flash-state")).toBe("visible");
    vi.advanceTimersByTime(1000);
    expect(el.isConnected).toBe(false);
  });

  // --- max changed at runtime -----------------------------------------------

  type DismissDetail = { element: HTMLElement; reason: string };

  /** The first word of a message's text, which names it in these tests. */
  const nameOf = (element: Element): string | undefined =>
    element.textContent?.trim().split(/\s+/)[0];

  /** Formats a `dismiss` event as `"<reason> <name>"`. */
  const describeDismissal = (event: Event): string => {
    const { element, reason } = (event as CustomEvent<DismissDetail>).detail;
    return `${reason} ${nameOf(element)}`;
  };

  /** Collects every later `dismiss` of the mounted controller, in the order reported. */
  const recordDismissals = (): string[] => {
    const log: string[] = [];
    root().addEventListener("stimeo--flash:dismiss", (e) => log.push(describeDismissal(e)));
    return log;
  };

  const shownTexts = () => Array.from(regionEl().children).map(nameOf);

  const threeMessages = () =>
    message("notice", "A") + message("notice", "B") + message("notice", "C");

  it("dismisses the oldest excess with reason 'limit' when max is lowered", async () => {
    await mount(region(threeMessages(), 'data-stimeo--flash-duration-value="0"'));
    const dismissed = recordDismissals();

    // A morph or a script that rewrites the attribute holds the stack to the new cap
    // the way an arrival past it does: the oldest messages leave first.
    root().setAttribute("data-stimeo--flash-max-value", "1");
    await flush();

    expect(dismissed).toEqual(["limit A", "limit B"]);
    expect(shownTexts()).toEqual(["C"]);
  });

  it.each([
    ["raised", "5"],
    ["set to 0 (unlimited)", "0"],
  ])("dismisses nothing when max is %s", async (_label, next) => {
    await mount(
      region(
        threeMessages(),
        'data-stimeo--flash-max-value="3" data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed = recordDismissals();

    root().setAttribute("data-stimeo--flash-max-value", next);
    await flush();
    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    // The same harness sees a change that does bring the cap below the count.
    root().setAttribute("data-stimeo--flash-max-value", "2");
    await flush();
    expect(dismissed).toEqual(["limit A"]);
    expect(shownTexts()).toEqual(["B", "C"]);
  });

  it("treats a max that is not a number as no cap", async () => {
    await mount(
      region(
        threeMessages(),
        'data-stimeo--flash-max-value="abc" data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed = recordDismissals();

    regionEl().insertAdjacentHTML("beforeend", message("notice", "D"));
    await flush();

    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C", "D"]);
  });

  it("holds a fresh stack to the max once connect() has taken every message on", async () => {
    const log: string[] = [];
    class Probe extends FlashController {
      override maxValueChanged(): void {
        log.push(`max ${this.maxValue}`);
        super.maxValueChanged();
      }

      override connect(): void {
        log.push("connect");
        super.connect();
      }
    }
    const onShow = (e: Event) => log.push(`show ${(e as CustomEvent).detail.message}`);
    const onDismiss = (e: Event) => log.push(describeDismissal(e));
    document.addEventListener("stimeo--flash:show", onShow);
    document.addEventListener("stimeo--flash:dismiss", onDismiss);
    try {
      document.body.innerHTML = region(
        threeMessages(),
        'data-stimeo--flash-max-value="1" data-stimeo--flash-duration-value="0"',
      );
      application = Application.start();
      application.register("stimeo--flash", Probe);
      await flush();

      // The Value arrives ahead of connect(), while no message is on the stack, and trims
      // nothing. connect() shows every message it takes on, then holds the fresh stack to
      // the cap once, oldest first.
      expect(log).toEqual(["max 1", "connect", "show A", "show B", "show C", "limit A", "limit B"]);
    } finally {
      document.removeEventListener("stimeo--flash:show", onShow);
      document.removeEventListener("stimeo--flash:dismiss", onDismiss);
    }
  });

  it.each([
    [
      "a message arrives past the cap",
      () => regionEl().insertAdjacentHTML("beforeend", message("notice", "C")),
    ],
    [
      "max is lowered below the count",
      () => root().setAttribute("data-stimeo--flash-max-value", "1"),
    ],
  ])("passes over the oldest message while focus holds it when %s", async (_label, overflow) => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    const oldest = regionEl().firstElementChild as HTMLElement;
    oldest.dispatchEvent(new Event("focusin"));

    // Taking the held message away would take the focused control with it, so the
    // cap falls on the oldest message nothing holds, on either path.
    overflow();
    await flush();

    expect(dismissed).toEqual(["limit B"]);
    expect(oldest.isConnected).toBe(true);
  });

  // --- the cap and a held message --------------------------------------------

  /** A message with two controls, so focus can move inside it. */
  const messageWithControls = (text: string) =>
    `<div data-stimeo--flash-target="message" data-flash-type="notice">${text}
       <button type="button" data-control="undo">Undo ${text}</button>
       <button type="button" data-control="close">Close ${text}</button>
     </div>`;

  /** A message whose close button is wired to the `dismiss` action. */
  const closableMessage = (text: string) =>
    `<div data-stimeo--flash-target="message" data-flash-type="notice">${text}
       <button type="button" data-action="stimeo--flash#dismiss">Close ${text}</button>
     </div>`;

  const closeButtonOf = (element: HTMLElement): HTMLButtonElement =>
    query("button", element) as HTMLButtonElement;

  /** The message element named `text`. */
  const messageNamed = (text: string): HTMLElement => {
    const found = Array.from(regionEl().children).find((c) => nameOf(c) === text);
    if (!(found instanceof HTMLElement)) throw new Error(`No message ${text}`);
    return found;
  };

  /** One of the two controls of the message named `text`. */
  const controlOf = (text: string, name: "undo" | "close"): HTMLElement =>
    query(`[data-control="${name}"]`, messageNamed(text));

  /** Moves focus out of `from`, reporting `to` as where it went, the way a browser does. */
  const focusOut = (from: HTMLElement, to: Element | null) =>
    from.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));

  const focusIn = (into: HTMLElement, from: Element | null = null) =>
    into.dispatchEvent(new FocusEvent("focusin", { bubbles: true, relatedTarget: from }));

  it("passes over a message the pointer is over", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("mouseenter"));

    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    expect(dismissed).toEqual(["limit B"]);
    expect(shownTexts()).toEqual(["A", "C"]);
  });

  it("holds a message that never auto-dismisses against the cap", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("focusin"));

    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    expect(dismissed).toEqual(["limit B"]);
    expect(shownTexts()).toEqual(["A", "C"]);
  });

  it("holds a message against the cap when pauseOnHover is off, while its timer runs on", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000" ' +
          'data-stimeo--flash-pause-on-hover-value="false"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("focusin"));

    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();
    expect(dismissed).toEqual(["limit B"]);

    // `pauseOnHover` decides whether the timer waits, not whether the cap sees the hold.
    await vi.advanceTimersByTimeAsync(1000);
    expect(dismissed).toEqual(["limit B", "timeout A", "timeout C"]);
  });

  it("keeps the arrival past the cap while every other message is held", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("focusin"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));

    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C"]);
  });

  it("applies the cap again with reason 'limit' once the last hold on a message is released", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    const a = messageNamed("A");
    a.dispatchEvent(new Event("focusin"));
    a.dispatchEvent(new Event("mouseenter"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    // Focus still holds A after the pointer leaves it, so the stack stays over the cap.
    a.dispatchEvent(new Event("mouseleave"));
    await flush();
    expect(dismissed).toEqual([]);

    focusOut(a, null);
    await flush();
    expect(dismissed).toEqual(["limit A"]);
    expect(shownTexts()).toEqual(["B", "C"]);
  });

  it("applies nothing again for a release on a message nothing held", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("focusin"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    // A pointer that never entered the arrival cannot release it, so the arrival
    // keeps the place it was shown in.
    messageNamed("C").dispatchEvent(new Event("mouseleave"));
    await flush();

    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C"]);
  });

  it("keeps a held message while focus moves between its own controls", async () => {
    await mount(
      region(
        messageWithControls("A") + messageWithControls("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    focusIn(controlOf("A", "undo"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    regionEl().insertAdjacentHTML("beforeend", messageWithControls("C"));
    await flush();

    // Tab from one control of A to the next: focus never leaves A.
    focusOut(controlOf("A", "undo"), controlOf("A", "close"));
    focusIn(controlOf("A", "close"), controlOf("A", "undo"));
    await flush();
    expect(dismissed).toEqual([]);

    focusOut(controlOf("A", "close"), document.body);
    await flush();
    expect(dismissed).toEqual(["limit A"]);
  });

  it("spares the message focus moves into when the cap is applied again", async () => {
    await mount(
      region(
        messageWithControls("A") + messageWithControls("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    focusIn(controlOf("A", "close"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    root().setAttribute("data-stimeo--flash-max-value", "1");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", messageWithControls("C"));
    await flush();
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    // Focus goes from A straight to C's control. The release of A arrives before C's
    // own focusin, so C is passed over by name rather than by a hold it has yet to get.
    focusOut(controlOf("A", "close"), controlOf("C", "close"));
    await flush();

    expect(dismissed).toEqual(["limit A"]);
    expect(shownTexts()).toEqual(["B", "C"]);
  });

  it.each([
    ["moves", (m: HTMLElement) => regionEl().appendChild(m), ["limit A"], "leaving"],
    ["removes", (m: HTMLElement) => m.remove(), [], "visible"],
  ] as const)(
    "applies the cap only after the release, so a caller that %s the focused message finishes first",
    async (_label, operate, afterwards, state) => {
      await mount(
        region(
          messageWithControls("A") + messageWithControls("B"),
          'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
        ),
      );
      const dismissed = recordDismissals();
      const a = messageNamed("A");
      focusIn(controlOf("A", "close"));
      messageNamed("B").dispatchEvent(new Event("mouseenter"));
      root().setAttribute("data-stimeo--flash-max-value", "1");
      await flush();

      // An engine takes a focused node out with a `focusout` while the node is still in
      // place, and carries on with the caller's operation only after that event returns.
      focusOut(controlOf("A", "close"), null);
      expect(a.parentNode).toBe(regionEl());
      operate(a);
      expect(dismissed).toEqual([]);

      await flush();
      expect(dismissed).toEqual([...afterwards]);
      expect(a.parentNode).toBeNull();
      // A node the stack let go of is not taken on again from the records of its move.
      expect(a.getAttribute("data-flash-state")).toBe(state);
      expect(shownTexts()).toEqual(["B"]);
    },
  );

  it("does not take on a message that left the region before the stack heard of it", async () => {
    await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="0"'));
    regionEl().insertAdjacentHTML("beforeend", message("notice", "Gone"));
    const gone = regionEl().lastElementChild as HTMLElement;
    gone.remove();
    await flush();

    expect(gone.hasAttribute("data-flash-state")).toBe(false);
    expect(gone.hasAttribute("role")).toBe(false);
  });

  it("spares a message only in the pass that follows the move into it", async () => {
    await mount(
      region(
        messageWithControls("A") + messageWithControls("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    focusIn(controlOf("A", "close"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    root().setAttribute("data-stimeo--flash-max-value", "1");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", messageWithControls("C"));
    await flush();
    focusOut(controlOf("A", "close"), controlOf("C", "close"));
    await flush();
    expect(dismissed).toEqual(["limit A"]);

    // The pointer then comes and goes over C: the pass that release starts spares nothing.
    messageNamed("C").dispatchEvent(new Event("mouseenter"));
    messageNamed("C").dispatchEvent(new Event("mouseleave"));
    await flush();

    expect(dismissed).toEqual(["limit A", "limit C"]);
  });

  it("drops the pending pass of the cap when the controller disconnects", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    const a = messageNamed("A");
    a.dispatchEvent(new Event("focusin"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    focusOut(a, null);
    flashController().disconnect();
    await flush();

    expect(dismissed).toEqual([]);
  });

  it("runs no pass of the cap pending from before a reconnect on the next connection", async () => {
    // A is focused whenever it is shown, so B, arriving while A holds, stays past the cap,
    // and a reconnect of the same instance applies no cap of its own.
    const onShow = (e: Event) => {
      const shown = e.target as HTMLElement;
      if (nameOf(shown) === "A") shown.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    };
    document.addEventListener("stimeo--flash:show", onShow);
    try {
      await mount(
        region(
          message("notice", "A"),
          'data-stimeo--flash-max-value="1" data-stimeo--flash-duration-value="1000"',
        ),
      );
      regionEl().insertAdjacentHTML("beforeend", message("notice", "B"));
      await flush();
      const dismissed = recordDismissals();
      focusOut(messageNamed("A"), null);
      const controller = flashController();
      controller.disconnect();
      controller.connect();
      await flush();

      expect(dismissed).toEqual([]);
      expect(shownTexts()).toEqual(["A", "B"]);
    } finally {
      document.removeEventListener("stimeo--flash:show", onShow);
    }
  });

  it("counts only the messages still in the region when the cap is applied again", async () => {
    await mount(
      region(
        messageWithControls("A") + messageWithControls("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    const a = messageNamed("A");
    focusIn(controlOf("A", "close"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    regionEl().insertAdjacentHTML("beforeend", messageWithControls("C"));
    await flush();
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    // The engine ends focus with a `focusout` while the node is still in place, then the
    // caller's removal takes it out; the stack hears of the removal only afterwards.
    focusOut(controlOf("A", "close"), null);
    a.remove();
    await flush();

    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["B", "C"]);
  });

  it("applies the cap again when a message something holds is closed", async () => {
    await mount(
      region(
        closableMessage("A") + closableMessage("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="60000"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("mouseenter"));
    const b = messageNamed("B");
    closeButtonOf(b).focus();
    root().setAttribute("data-stimeo--flash-max-value", "1");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    // B's holds leave with it, so the stack is held over the cap by A alone.
    closeButtonOf(b).click();
    await flush();

    expect(dismissed).toEqual(["user B", "limit C"]);
    expect(shownTexts()).toEqual(["A"]);
  });

  it("applies the cap again when a message something holds runs out while pauseOnHover is off", async () => {
    await mount(
      region(
        message("notice", "A"),
        'data-stimeo--flash-max-value="1" data-stimeo--flash-duration-value="1000" ' +
          'data-stimeo--flash-pause-on-hover-value="false"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("mouseenter"));
    root().setAttribute("data-stimeo--flash-duration-value", "0");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "B"));
    await flush();
    messageNamed("B").dispatchEvent(new Event("focusin"));
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    await vi.advanceTimersByTimeAsync(1000);

    expect(dismissed).toEqual(["timeout A", "limit C"]);
    expect(shownTexts()).toEqual(["B"]);
  });

  it("applies the cap again when a script takes out a message something holds", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed = recordDismissals();
    messageNamed("A").dispatchEvent(new Event("mouseenter"));
    const b = messageNamed("B");
    b.dispatchEvent(new Event("mouseenter"));
    root().setAttribute("data-stimeo--flash-max-value", "1");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    b.remove();
    flashController().messageTargetDisconnected(b);
    await flush();

    expect(dismissed).toEqual(["limit C"]);
    expect(shownTexts()).toEqual(["A"]);
  });

  it.each([
    [
      "prepended",
      async (_a: HTMLElement): Promise<HTMLElement> => {
        regionEl().insertAdjacentHTML("afterbegin", message("notice", "C"));
        await flush();
        return messageNamed("C");
      },
    ],
    [
      "moved to the front",
      async (a: HTMLElement): Promise<HTMLElement> => {
        regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
        await flush();
        const c = messageNamed("C");
        regionEl().insertBefore(c, a);
        flashController().messageTargetDisconnected(c);
        await flush();
        return c;
      },
    ],
  ] as const)(
    "evicts nothing when the same instance connects again with the spared message %s",
    async (_label, spare) => {
      await mount(
        region(
          closableMessage("A") + closableMessage("B"),
          'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="60000"',
        ),
      );
      const dismissed = recordDismissals();
      const a = messageNamed("A");
      stubHover(a, () => true);
      a.dispatchEvent(new Event("mouseenter"));
      const close = closeButtonOf(messageNamed("B"));
      close.focus();
      const c = await spare(a);
      expect(shownTexts()).toEqual(["C", "A", "B"]);

      // `connect()` takes the messages on in DOM order, the spared one first. A reconnect of
      // the same instance applies no cap, so nothing the stack showed goes.
      flashController().disconnect();
      flashController().connect();
      await flush();

      expect(dismissed).toEqual([]);
      expect(c.isConnected).toBe(true);
      expect(document.activeElement).toBe(close);
    },
  );

  it("evicts nothing when Stimulus connects the same instance again with max left to its default", async () => {
    await mount(region(threeMessages(), 'data-stimeo--flash-duration-value="0"'));
    const dismissed = recordDismissals();
    const instance = flashController();
    const host = root();

    // Stimulus reports the default of every Value the markup leaves out before connect().
    host.removeAttribute("data-controller");
    await flush();
    host.setAttribute("data-controller", "stimeo--flash");
    await flush();

    expect(flashController()).toBe(instance);
    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C"]);
  });

  it("keeps the stack as it was on a same-instance reconnect after max changed while connected", async () => {
    await mount(
      region(
        closableMessage("A") + closableMessage("B"),
        'data-stimeo--flash-max-value="3" data-stimeo--flash-duration-value="60000"',
      ),
    );
    const dismissed = recordDismissals();
    const b = messageNamed("B");
    stubHover(b, () => true);
    b.dispatchEvent(new Event("mouseenter"));
    closeButtonOf(messageNamed("A")).focus();
    root().setAttribute("data-stimeo--flash-max-value", "1");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    // The stack was held to this max while connected, so connecting again holds it to
    // nothing new.
    flashController().disconnect();
    flashController().connect();
    await flush();

    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C"]);
  });

  it("holds the stack to nothing new when max is written again as the same number while the same instance is away", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed = recordDismissals();
    const instance = flashController();
    const host = root();

    // Away, a message comes in and `max` is written again in another spelling of the
    // same number; the reconnect finds the stack held to that max already.
    host.removeAttribute("data-controller");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    host.setAttribute("data-stimeo--flash-max-value", "02");
    await flush();
    host.setAttribute("data-controller", "stimeo--flash");
    await flush();

    expect(flashController()).toBe(instance);
    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C"]);
  });

  it("holds the stack to a max that changed while the controller was away, on its next connect", async () => {
    await mount(
      region(
        threeMessages(),
        'data-stimeo--flash-max-value="3" data-stimeo--flash-duration-value="0"',
      ),
    );
    const dismissed = recordDismissals();

    flashController().disconnect();
    root().setAttribute("data-stimeo--flash-max-value", "1");
    flashController().maxValueChanged();
    flashController().connect();

    // The connect itself holds the stack to the new max, before Stimulus hears the
    // attribute again on the connected controller.
    expect(dismissed).toEqual(["limit A", "limit B"]);
    await flush();
    expect(dismissed).toEqual(["limit A", "limit B"]);
    expect(shownTexts()).toEqual(["C"]);
  });

  it("keeps every held message when the controller connects again over the cap", async () => {
    await mount(
      region(
        closableMessage("A") + closableMessage("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="60000"',
      ),
    );
    const dismissed = recordDismissals();
    const b = messageNamed("B");
    stubHover(b, () => true);
    b.dispatchEvent(new Event("mouseenter"));
    const close = closeButtonOf(messageNamed("A"));
    close.focus();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();
    expect(shownTexts()).toEqual(["A", "B", "C"]);

    // Each message is taken on with the holds it has before the cap meets the next one,
    // so the one focus is inside and the one under the pointer both stay.
    flashController().disconnect();
    flashController().connect();
    await flush();

    expect(dismissed).toEqual([]);
    expect(shownTexts()).toEqual(["A", "B", "C"]);
    expect(document.activeElement).toBe(close);
  });

  it("holds a message that focus is inside when the controller takes it on again", async () => {
    await mount(
      region(
        closableMessage("A") + closableMessage("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="60000"',
      ),
    );
    const dismissed = recordDismissals();
    const close = closeButtonOf(messageNamed("A"));
    close.focus();

    // A reconnect drops every hold; taking the messages on again reads focus back.
    flashController().disconnect();
    flashController().connect();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    expect(dismissed).toEqual(["limit B"]);
    expect(document.activeElement).toBe(close);
  });

  it("keeps the timer of a message that focus is inside when the controller takes it on again", async () => {
    await mount(region(closableMessage("A"), 'data-stimeo--flash-duration-value="1000"'));
    const a = messageNamed("A");
    const close = closeButtonOf(a);
    close.focus();

    flashController().disconnect();
    flashController().connect();
    await vi.advanceTimersByTimeAsync(5000);

    expect(a.isConnected).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it("holds a message that focus is inside when the controller first connects", async () => {
    document.body.innerHTML = region(
      closableMessage("A") + closableMessage("B"),
      'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="60000"',
    );
    const close = query("button") as HTMLButtonElement;
    close.focus();
    application = Application.start();
    application.register("stimeo--flash", FlashController);
    await flush();
    const dismissed = recordDismissals();

    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    expect(dismissed).toEqual(["limit B"]);
    expect(document.activeElement).toBe(close);
  });

  it("holds a message that reads as hovered as it is taken on, until the pointer moves off it", async () => {
    await mount(region("", 'data-stimeo--flash-duration-value="1000"'));
    const incoming = document.createElement("div");
    incoming.setAttribute("data-stimeo--flash-target", "message");
    incoming.setAttribute("data-flash-type", "notice");
    incoming.textContent = "A";
    let hovered = true;
    stubHover(incoming, () => hovered);

    regionEl().append(incoming);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(incoming.isConnected).toBe(true);

    // The reading may date from before the message came here, so the pointer confirms it.
    hovered = false;
    movePointer();
    await vi.advanceTimersByTimeAsync(1000);
    expect(incoming.isConnected).toBe(false);
  });

  it("holds the timer of a message focused while it is being shown", async () => {
    const onShow = (e: Event) =>
      (e.target as HTMLElement).dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    document.addEventListener("stimeo--flash:show", onShow);
    try {
      await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="1000"'));
      const a = messageNamed("A");

      // The hold lands before the timer is armed, and the timer waits for it.
      await vi.advanceTimersByTimeAsync(5000);
      expect(a.isConnected).toBe(true);

      focusOut(a, null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(a.isConnected).toBe(false);
    } finally {
      document.removeEventListener("stimeo--flash:show", onShow);
    }
  });

  it("lets no timer from before a reconnect dismiss a message taken on again", async () => {
    await mount(
      region(
        message("notice", "A"),
        'data-stimeo--flash-duration-value="1000" data-stimeo--flash-pause-on-hover-value="false"',
      ),
    );
    const controller = application.getControllerForElementAndIdentifier(root(), "stimeo--flash");
    if (!(controller instanceof FlashController)) throw new Error("Flash controller not connected");
    const a = messageNamed("A");

    await vi.advanceTimersByTimeAsync(500);
    controller.disconnect();
    root().setAttribute("data-stimeo--flash-pause-on-hover-value", "true");
    controller.connect();

    // The message is taken on again at 500ms and gets the full duration from there.
    await vi.advanceTimersByTimeAsync(999);
    expect(a.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.isConnected).toBe(false);
  });

  it("gives a message put back after its dismissal the deadline of its new life", async () => {
    await mount(
      region(
        `<div data-stimeo--flash-target="message" data-flash-type="notice">A
           <button data-action="stimeo--flash#dismiss">x</button>
         </div>`,
        'data-stimeo--flash-duration-value="1000" data-stimeo--flash-pause-on-hover-value="false"',
      ),
    );
    const a = messageNamed("A");

    await vi.advanceTimersByTimeAsync(100);
    (query("button", a) as HTMLButtonElement).click();
    expect(a.isConnected).toBe(false);
    root().setAttribute("data-stimeo--flash-pause-on-hover-value", "true");
    await flush();

    await vi.advanceTimersByTimeAsync(100);
    regionEl().appendChild(a);
    await flush();

    // Taken on again at 200ms: the deadline is 1200ms, whatever its first life armed.
    await vi.advanceTimersByTimeAsync(999);
    expect(a.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.isConnected).toBe(false);
  });

  // --- a message that moves within the region -------------------------------

  /** The connected controller, for the target callbacks a DOM-only environment may not deliver. */
  const flashController = (): FlashController => {
    const instance = application.getControllerForElementAndIdentifier(root(), "stimeo--flash");
    if (!(instance instanceof FlashController)) throw new Error("Flash controller not connected");
    return instance;
  };

  /**
   * Holds every requested animation frame until a test paints, the way an engine runs
   * them once per frame; cancelling one drops it.
   */
  const stubFrames = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
    return {
      paint: () => {
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback(0);
      },
    };
  };

  /**
   * Answers `:hover` for `element` from `hovered`. This DOM-only environment has no
   * pointer, so the engine's answer is modelled. After a move an engine can go on
   * answering from before the move until the pointer moves again.
   */
  const stubHover = (element: HTMLElement, hovered: () => boolean) => {
    const matches = element.matches.bind(element);
    vi.spyOn(element, "matches").mockImplementation((selector: string) =>
      selector === ":hover" ? hovered() : matches(selector),
    );
  };

  /** Moves the pointer somewhere on the page, the way a person does. */
  const movePointer = () =>
    document.body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));

  /**
   * Reports whether the controller is listening for the pointer to move: every
   * `pointermove` registration it makes on the document from here on, and whether one of
   * them is still live.
   */
  const watchPointerListener = () => {
    const signals: AbortSignal[] = [];
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "pointermove" && typeof options === "object" && options.signal) {
        signals.push(options.signal);
      }
      add(type, listener, options);
    });
    return { listening: () => signals.some((signal) => !signal.aborted) };
  };

  it("keeps a hover hold a move leaves until the pointer moves, however many frames run", async () => {
    const frames = stubFrames();
    await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="1000"'));
    const a = messageNamed("A");
    a.dispatchEvent(new Event("mouseenter"));
    stubHover(a, () => false);

    // A move fires no `mouseleave`, and `:hover` may still answer from before it: the
    // reading says nothing about where the pointer is now.
    regionEl().appendChild(a);
    flashController().messageTargetDisconnected(a);
    frames.paint();
    frames.paint();
    frames.paint();
    await vi.advanceTimersByTimeAsync(5000);

    expect(a.isConnected).toBe(true);
  });

  it("lets a hover hold go once the pointer moves and the moved message is not under it", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    const a = messageNamed("A");
    a.dispatchEvent(new Event("mouseenter"));
    messageNamed("B").dispatchEvent(new Event("mouseenter"));
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();
    let hovered = true;
    stubHover(a, () => hovered);

    flashController().messageTargetDisconnected(a);
    hovered = false;
    movePointer();
    await flush();

    // The release applies the cap again, and A is the oldest message nothing holds.
    expect(dismissed).toEqual(["limit A"]);
  });

  it("keeps the hover hold once the pointer moves over the moved message", async () => {
    await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="1000"'));
    const a = messageNamed("A");
    a.dispatchEvent(new Event("mouseenter"));
    stubHover(a, () => true);

    flashController().messageTargetDisconnected(a);
    movePointer();
    await vi.advanceTimersByTimeAsync(5000);

    expect(a.isConnected).toBe(true);
  });

  it("reads hover on the first pointer movement for every message moved before it", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const [a, b] = [messageNamed("A"), messageNamed("B")];
    a.dispatchEvent(new Event("mouseenter"));
    b.dispatchEvent(new Event("mouseenter"));
    stubHover(a, () => false);
    stubHover(b, () => false);

    flashController().messageTargetDisconnected(a);
    flashController().messageTargetDisconnected(b);
    movePointer();
    await vi.advanceTimersByTimeAsync(1000);

    expect([a.isConnected, b.isConnected]).toEqual([false, false]);
  });

  it("reads a moved message's hover on the first pointer movement only", async () => {
    await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="1000"'));
    const watch = watchPointerListener();
    const a = messageNamed("A");
    a.dispatchEvent(new Event("mouseenter"));
    let hovered = true;
    stubHover(a, () => hovered);

    flashController().messageTargetDisconnected(a);
    expect(watch.listening()).toBe(true);
    movePointer();
    expect(watch.listening()).toBe(false);

    // Past the first movement the message's own `mouseleave` says when the pointer leaves.
    hovered = false;
    movePointer();
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.isConnected).toBe(true);
  });

  it("reads a moved message's hover on the first pointer movement after its move only", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const [a, b] = [messageNamed("A"), messageNamed("B")];
    a.dispatchEvent(new Event("mouseenter"));
    b.dispatchEvent(new Event("mouseenter"));
    let aHovered = true;
    stubHover(a, () => aHovered);
    stubHover(b, () => true);
    flashController().messageTargetDisconnected(a);
    movePointer();

    // B moves later. The movement after that reads B; A is left to its own `mouseleave`.
    aHovered = false;
    flashController().messageTargetDisconnected(b);
    movePointer();
    await vi.advanceTimersByTimeAsync(5000);

    expect(a.isConnected).toBe(true);
  });

  it("stops listening for the pointer when the controller disconnects", async () => {
    await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="1000"'));
    const watch = watchPointerListener();
    const a = messageNamed("A");
    a.dispatchEvent(new Event("mouseenter"));

    flashController().messageTargetDisconnected(a);
    expect(watch.listening()).toBe(true);
    flashController().disconnect();

    expect(watch.listening()).toBe(false);
  });

  it("stops listening for the pointer once no moved message is left to read", async () => {
    await mount(
      region(
        closableMessage("A") + closableMessage("B"),
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const watch = watchPointerListener();
    const [a, b] = [messageNamed("A"), messageNamed("B")];
    a.dispatchEvent(new Event("mouseenter"));
    b.dispatchEvent(new Event("mouseenter"));
    flashController().messageTargetDisconnected(a);
    flashController().messageTargetDisconnected(b);

    closeButtonOf(a).click();
    expect(watch.listening()).toBe(true);
    b.remove();
    flashController().messageTargetDisconnected(b);

    expect(watch.listening()).toBe(false);
  });

  it("forgets moves from before a reconnect", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-duration-value="1000"',
      ),
    );
    const [a, b] = [messageNamed("A"), messageNamed("B")];
    const controller = flashController();
    a.dispatchEvent(new Event("mouseenter"));
    controller.messageTargetDisconnected(a);
    controller.disconnect();
    controller.connect();
    a.dispatchEvent(new Event("mouseenter"));
    stubHover(a, () => false);

    // Only B moves on this connection, so the pointer movement reads A's hover no more.
    b.dispatchEvent(new Event("mouseenter"));
    controller.messageTargetDisconnected(b);
    movePointer();
    await vi.advanceTimersByTimeAsync(5000);

    expect(a.isConnected).toBe(true);
  });

  it("keeps the hold of a focused message that moves within the region", async () => {
    await mount(
      region(
        messageWithControls("A") + messageWithControls("B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    const close = controlOf("A", "close");
    close.focus();

    // The node keeps its place and focus, as a morph that moves it with `moveBefore` leaves it.
    flashController().messageTargetDisconnected(messageNamed("A"));
    regionEl().insertAdjacentHTML("beforeend", messageWithControls("C"));
    await flush();

    expect(dismissed).toEqual(["limit B"]);
    expect(document.activeElement).toBe(close);
  });

  it("lets go of a focus hold once focus is no longer in a moved message", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B"),
        'data-stimeo--flash-max-value="2" data-stimeo--flash-duration-value="1000"',
      ),
    );
    const dismissed = recordDismissals();
    // Held by a focusin while focus itself rests elsewhere: an engine that ends focus
    // on removal without a focusout leaves exactly this behind.
    const a = messageNamed("A");
    a.dispatchEvent(new Event("focusin"));

    flashController().messageTargetDisconnected(a);
    regionEl().insertAdjacentHTML("beforeend", message("notice", "C"));
    await flush();

    expect(dismissed).toEqual(["limit A"]);
  });

  it("applies a duration changed at runtime to the messages taken on after it", async () => {
    await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="1000"'));
    root().setAttribute("data-stimeo--flash-duration-value", "3000");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "B"));
    await flush();
    const [first, second] = Array.from(regionEl().children);

    // The message on screen keeps the deadline it was taken on with.
    await vi.advanceTimersByTimeAsync(1000);
    expect([first?.isConnected, second?.isConnected]).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(second?.isConnected).toBe(false);
  });

  it("applies a pauseOnHover changed at runtime to the messages taken on after it", async () => {
    await mount(region(message("notice", "A"), 'data-stimeo--flash-duration-value="1000"'));
    root().setAttribute("data-stimeo--flash-pause-on-hover-value", "false");
    await flush();
    regionEl().insertAdjacentHTML("beforeend", message("notice", "B"));
    await flush();
    const [first, second] = Array.from(regionEl().children);

    // The message on screen still pauses under the pointer; the one taken on after the
    // change does not.
    first?.dispatchEvent(new Event("mouseenter"));
    second?.dispatchEvent(new Event("mouseenter"));
    await vi.advanceTimersByTimeAsync(1000);
    expect([first?.isConnected, second?.isConnected]).toEqual([true, false]);
  });

  // --- values and type mapping ----------------------------------------------

  it("auto-dismisses after the default duration", async () => {
    await mount(region(message("notice", "Saved")));
    const el = regionEl().firstElementChild as HTMLElement;
    vi.advanceTimersByTime(4999);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("stacks without a limit by default", async () => {
    await mount(
      region(
        message("notice", "A") + message("notice", "B") + message("notice", "C"),
        'data-stimeo--flash-duration-value="0"',
      ),
    );
    const texts = Array.from(regionEl().children).map((c) => c.textContent?.trim());
    expect(texts).toEqual(["A", "B", "C"]);
  });

  it("maps an error flash to role=alert and bridges it assertively", async () => {
    await mount(region(message("error", "Boom")));
    expect((regionEl().firstElementChild as HTMLElement).getAttribute("role")).toBe("alert");
    expect(announces).toEqual([{ message: "Boom", assertive: true }]);
  });

  it("treats a message without a flash type as a polite status", async () => {
    await mount(region(`<div data-stimeo--flash-target="message">Plain</div>`));
    expect((regionEl().firstElementChild as HTMLElement).getAttribute("role")).toBe("status");
    expect(announces).toEqual([{ message: "Plain", assertive: false }]);
  });

  it("does not bridge a message with no text", async () => {
    await mount(region(message("notice", "   ")));
    expect((regionEl().firstElementChild as HTMLElement).getAttribute("role")).toBe("status");
    expect(announces).toEqual([]);
  });

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML = region(
      message("notice", "Saved"),
      'data-stimeo--flash-duration-value="0"',
    );
    application = Application.start();
    application.register("stimeo--flash", FlashController);
    await tick();
    await expectNoA11yViolations(root());
  });

  // The live region must actually announce the flash, not just carry the right
  // attributes: freeze the role + message in spoken order.
  it("announces a notice flash through its status live region", async () => {
    vi.useRealTimers();
    document.body.innerHTML = region(
      message("notice", "Saved"),
      'data-stimeo--flash-duration-value="0"',
    );
    application = Application.start();
    application.register("stimeo--flash", FlashController);
    await tick();
    const live = regionEl().firstElementChild as HTMLElement;
    expect(await captureSpeech({ container: live, steps: 1 })).toEqual(["status", "Saved"]);
  });
});
