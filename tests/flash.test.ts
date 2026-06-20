import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlashController } from "../src/controllers/flash_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { query } from "./helpers/dom";
import { captureSpeech } from "./helpers/speech";

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
    application.stop();
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
    window.getComputedStyle = ((el: Element) =>
      ({
        ...real(el),
        transitionDuration: "0.2s",
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

      vi.advanceTimersByTime(200);
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

  it("has no a11y violations", async () => {
    vi.useRealTimers();
    document.body.innerHTML = region(
      message("notice", "Saved"),
      'data-stimeo--flash-duration-value="0"',
    );
    application = Application.start();
    application.register("stimeo--flash", FlashController);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expectNoA11yViolations(root());
  });

  // Layer ③ — the live region must actually announce the flash, not just carry the
  // right attributes: freeze the role + message in spoken order.
  it("announces a notice flash through its status live region", async () => {
    vi.useRealTimers();
    document.body.innerHTML = region(
      message("notice", "Saved"),
      'data-stimeo--flash-duration-value="0"',
    );
    application = Application.start();
    application.register("stimeo--flash", FlashController);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const live = regionEl().firstElementChild as HTMLElement;
    expect(await captureSpeech({ container: live, steps: 1 })).toEqual(["status", "Saved"]);
  });
});
