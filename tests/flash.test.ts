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
 * auto-dismiss with pause-on-hover, the `max` stacking cap, manual dismiss, dynamic
 * detection via the MutationObserver, and observer / timer teardown.
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
