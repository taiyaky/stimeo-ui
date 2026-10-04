import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CarouselController } from "../src/controllers/carousel_controller";
import { ClipboardController } from "../src/controllers/clipboard_controller";
import { CountdownController } from "../src/controllers/countdown_controller";
import { DrawerController } from "../src/controllers/drawer_controller";
import { OverflowMenuController } from "../src/controllers/overflow_menu_controller";
import { PreviewGuardController } from "../src/controllers/preview_guard_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";

/** Morph output repair preserves live deadlines, pauses, ownership and modal state. */
describe("morph lifecycle phases", () => {
  let application: Application;
  const now = new Date("2026-06-06T00:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  });
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.body.style.overflow = "";
    document.documentElement.removeAttribute("data-turbo-preview");
    vi.unstubAllGlobals();
  });
  const mount = async (
    id: string,
    controller: ControllerConstructor,
    attrs: string,
    html: string,
  ) => {
    document.body.innerHTML = `<div id="root" data-controller="stimeo--${id}" ${attrs}>${html}</div>`;
    application = Application.start();
    application.register(`stimeo--${id}`, controller);
    await vi.advanceTimersByTimeAsync(0);
    const root = document.querySelector<HTMLElement>("#root");
    if (!root) throw new Error("Missing root");
    const instance = application.getControllerForElementAndIdentifier(root, `stimeo--${id}`);
    if (!instance) throw new Error("Missing controller");
    return { root, instance };
  };
  const output = (root: HTMLElement) => {
    const target = root.querySelector<HTMLElement>("#out");
    if (!target) throw new Error("Missing output");
    return target;
  };
  const morph = async (root: HTMLElement) => {
    root.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
  };
  const countdown = async (deadline = "2026-06-06T00:00:10Z") =>
    mount(
      "countdown",
      CountdownController,
      `data-stimeo--countdown-deadline-value="${deadline}" data-stimeo--countdown-complete-label-value="Done"`,
      '<span id="out" data-stimeo--countdown-target="seconds"></span><span id="status" data-stimeo--countdown-target="status"></span>',
    );

  it("repairs a running countdown without restarting its interval phase", async () => {
    const { root, instance } = await countdown();
    await vi.advanceTimersByTimeAsync(400);
    root.removeAttribute("data-state");
    output(root).textContent = "00";
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(root.dataset.state).toBe("running");
    expect(output(root).textContent).toBe("10");
    expect(dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(output(root).textContent).toBe("09");
    expect(dispatch.mock.calls.filter(([name]) => name === "tick")).toHaveLength(1);
  });

  it("repairs a paused countdown from the reading that was held", async () => {
    const { root, instance } = await countdown();
    if (!(instance instanceof CountdownController)) throw new Error("Wrong controller");
    await vi.advanceTimersByTimeAsync(1000);
    instance.pause();
    await vi.advanceTimersByTimeAsync(3000);
    root.removeAttribute("data-state");
    output(root).textContent = "00";
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(root.dataset.state).toBe("paused");
    expect(output(root).textContent).toBe("09");
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatch).not.toHaveBeenCalled();
    instance.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(output(root).textContent).toBe("08");
  });

  it("repairs completion and its ownership marker without replaying the milestone", async () => {
    const { root, instance } = await countdown("2026-06-06T00:00:01Z");
    await vi.advanceTimersByTimeAsync(1000);
    const status = root.querySelector<HTMLElement>("#status");
    if (!status) throw new Error("Missing status");
    root.removeAttribute("data-state");
    status.textContent = "";
    status.removeAttribute("data-stimeo--countdown-owns-status");
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(root.dataset.state).toBe("complete");
    expect(status.textContent).toBe("Done");
    expect(status.getAttribute("data-stimeo--countdown-owns-status")).toBe("Done");
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispatch).not.toHaveBeenCalled();
    status.textContent = "Server status";
    status.removeAttribute("data-stimeo--countdown-owns-status");
    await morph(root);
    expect(status.textContent).toBe("Server status");
  });

  it("leaves newly authored completion wording alone after releasing its status", async () => {
    const { root, instance } = await countdown("2026-06-06T00:00:01Z");
    if (!(instance instanceof CountdownController)) throw new Error("Wrong controller");
    await vi.advanceTimersByTimeAsync(1000);
    const status = root.querySelector<HTMLElement>("#status");
    if (!status) throw new Error("Missing status");
    expect(status.textContent).toBe("Done");
    instance.reset();
    expect(status.textContent).toBe("");
    expect(status.hasAttribute("data-stimeo--countdown-owns-status")).toBe(false);
    status.textContent = "Done";
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(status.textContent).toBe("Done");
    expect(status.hasAttribute("data-stimeo--countdown-owns-status")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("repairs completion in the same batch as a changed already-settled deadline", async () => {
    const { root, instance } = await countdown("2026-06-06T00:00:01Z");
    await vi.advanceTimersByTimeAsync(1000);
    const status = root.querySelector<HTMLElement>("#status");
    if (!status) throw new Error("Missing status");
    expect(status.textContent).toBe("Done");
    status.textContent = "";
    status.removeAttribute("data-stimeo--countdown-owns-status");
    root.setAttribute("data-stimeo--countdown-deadline-value", "2026-06-06T00:00:00Z");
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(root.dataset.state).toBe("complete");
    expect(status.textContent).toBe("Done");
    expect(status.getAttribute("data-stimeo--countdown-owns-status")).toBe("Done");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("repairs clipboard feedback without extending the original deadline", async () => {
    const { root, instance } = await mount(
      "clipboard",
      ClipboardController,
      'data-stimeo--clipboard-feedback-duration-value="1000"',
      '<span id="out" data-stimeo--clipboard-target="feedback">Ready</span>',
    );
    if (!(instance instanceof ClipboardController)) throw new Error("Wrong controller");
    output(root).textContent = "Working";
    await instance.copy();
    await vi.advanceTimersByTimeAsync(400);
    const dispatch = vi.spyOn(instance, "dispatch");
    root.removeAttribute("data-state");
    output(root).textContent = "Ready";
    await morph(root);
    expect(root.dataset.state).toBe("copied");
    expect(output(root).textContent).toBe("Copied");
    expect(dispatch).not.toHaveBeenCalled();
    root.setAttribute("data-stimeo--clipboard-copied-label-value", "Saved");
    await vi.advanceTimersByTimeAsync(0);
    expect(output(root).textContent).toBe("Saved");
    root.removeAttribute("data-state");
    root.setAttribute("data-stimeo--clipboard-copied-label-value", "Saved again");
    await morph(root);
    expect(output(root).textContent).toBe("Saved again");
    expect(dispatch).not.toHaveBeenCalled();
    output(root).textContent = "Server feedback";
    await morph(root);
    expect(output(root).textContent).toBe("Server feedback");
    await vi.advanceTimersByTimeAsync(599);
    expect(root.dataset.state).toBe("copied");
    await vi.advanceTimersByTimeAsync(1);
    expect(root.dataset.state).toBe("idle");
  });

  it("repairs idle clipboard state while leaving authored feedback untouched", async () => {
    const { root, instance } = await mount(
      "clipboard",
      ClipboardController,
      "",
      '<span id="out" data-stimeo--clipboard-target="feedback">Ready</span>',
    );
    expect(root.dataset.state).toBe("idle");
    root.removeAttribute("data-state");
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(root.dataset.state).toBe("idle");
    expect(output(root).textContent).toBe("Ready");
    expect(dispatch).not.toHaveBeenCalled();
    instance.disconnect();
    root.removeAttribute("data-state");
    await morph(root);
    expect(root.hasAttribute("data-state")).toBe(false);
  });

  it("adopts a replacement clipboard slot only on its next copy", async () => {
    const { root, instance } = await mount(
      "clipboard",
      ClipboardController,
      'data-stimeo--clipboard-feedback-duration-value="0"',
      '<span id="out" data-stimeo--clipboard-target="feedback">Original</span>',
    );
    if (!(instance instanceof ClipboardController)) throw new Error("Wrong controller");
    await instance.copy();
    expect(output(root).textContent).toBe("Copied");
    output(root).outerHTML =
      '<span id="out" data-stimeo--clipboard-target="feedback">Replacement</span>';
    await morph(root);
    expect(output(root).textContent).toBe("Replacement");
    await instance.copy();
    expect(output(root).textContent).toBe("Copied");
    output(root).textContent = "Replacement";
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(output(root).textContent).toBe("Copied");
    expect(dispatch).not.toHaveBeenCalled();
    output(root).textContent = "New authored wording";
    await morph(root);
    expect(output(root).textContent).toBe("New authored wording");
  });

  for (const paused of [false, true]) {
    it(`repairs carousel output while retaining its ${paused ? "pause" : "interval phase"}`, async () => {
      const { root, instance } = await mount(
        "carousel",
        CarouselController,
        'data-stimeo--carousel-autoplay-value="true" data-stimeo--carousel-interval-value="1000"',
        '<div id="out" data-stimeo--carousel-target="viewport"><div data-stimeo--carousel-target="slide">A</div><div data-stimeo--carousel-target="slide">B</div></div><button data-stimeo--carousel-target="playToggle"></button>',
      );
      if (!(instance instanceof CarouselController)) throw new Error("Wrong controller");
      if (paused) instance.pause();
      await vi.advanceTimersByTimeAsync(400);
      const dispatch = vi.spyOn(instance, "dispatch");
      root.removeAttribute("data-state");
      output(root).removeAttribute("aria-live");
      await morph(root);
      expect(root.dataset.state).toBe(paused ? "paused" : "playing");
      expect(output(root).getAttribute("aria-live")).toBe(paused ? "polite" : "off");
      expect(dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      const slides = root.querySelectorAll('[data-stimeo--carousel-target="slide"]');
      expect(slides[paused ? 0 : 1]?.getAttribute("data-state")).toBe("active");
      expect(
        dispatch.mock.calls.filter(([name]) => name === "play" || name === "pause"),
      ).toHaveLength(0);
    });
  }

  it("repairs an open drawer without replacing its active modal lifetime", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<button data-stimeo--drawer-target="trigger">Open</button><div data-stimeo--drawer-target="overlay"><div id="out" data-stimeo--drawer-target="panel"><button>Inside</button></div></div>',
    );
    if (!(instance instanceof DrawerController)) throw new Error("Wrong controller");
    instance.open();
    const dispatch = vi.spyOn(instance, "dispatch");
    const focused = document.activeElement;
    output(root).removeAttribute("data-state");
    output(root).removeAttribute("data-placement");
    output(root).hidden = true;
    const overlay = root.querySelector<HTMLElement>('[data-stimeo--drawer-target="overlay"]');
    if (!overlay) throw new Error("Missing overlay");
    overlay.hidden = true;
    await morph(root);
    expect(overlay.hidden).toBe(false);
    expect(output(root).dataset.state).toBe("open");
    expect(output(root).dataset.placement).toBe("right");
    expect(output(root).hidden).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(dispatch).not.toHaveBeenCalled();
    instance.close();
    expect(output(root).dataset.state).toBe("closed");
  });

  it("repairs closed drawer panel and overlay hooks without opening the modal", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<div data-stimeo--drawer-target="overlay"><div id="out" data-stimeo--drawer-target="panel"></div></div>',
    );
    const overlay = root.querySelector<HTMLElement>('[data-stimeo--drawer-target="overlay"]');
    if (!overlay) throw new Error("Missing overlay");
    expect(output(root).dataset.state).toBe("closed");
    expect(output(root).hidden).toBe(true);
    expect(overlay.hidden).toBe(true);
    output(root).removeAttribute("data-state");
    output(root).hidden = false;
    overlay.removeAttribute("data-state");
    overlay.hidden = false;
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(output(root).dataset.state).toBe("closed");
    expect(overlay.dataset.state).toBe("closed");
    expect(output(root).hidden).toBe(true);
    expect(overlay.hidden).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("repairs a drawer after its panel target leaves without reactivating a trap", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<div id="out" data-stimeo--drawer-target="panel"></div>',
    );
    output(root).remove();
    await vi.advanceTimersByTimeAsync(0);
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(root.querySelector('[data-stimeo--drawer-target="panel"]')).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reflects drawer placement delivered while its controller is disconnected", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<div id="out" data-stimeo--drawer-target="panel"></div>',
    );
    if (!(instance instanceof DrawerController)) throw new Error("Wrong controller");
    expect(output(root).dataset.placement).toBe("right");
    instance.disconnect();
    instance.placementValue = "left";
    instance.placementValueChanged();
    expect(output(root).dataset.placement).toBe("left");
  });

  it("repairs a preview placeholder hook without re-announcing the guard", async () => {
    document.documentElement.setAttribute("data-turbo-preview", "");
    const { root, instance } = await mount(
      "preview-guard",
      PreviewGuardController,
      'data-stimeo--preview-guard-placeholder-value="Waiting"',
      '<span id="out">Live content</span>',
    );
    expect(root.textContent).toBe("Waiting");
    expect(root.dataset.previewHidden).toBe("true");
    root.removeAttribute("data-preview-hidden");
    root.textContent = "Server fallback";
    const dispatch = vi.spyOn(instance, "dispatch");
    await morph(root);
    expect(root.dataset.previewHidden).toBe("true");
    expect(root.textContent).toBe("Waiting");
    expect(dispatch).not.toHaveBeenCalled();
    document.documentElement.removeAttribute("data-turbo-preview");
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toBe("Live content");
  });

  it("settles preview changes from morph when document observation is unavailable", async () => {
    const { root, instance } = await mount(
      "preview-guard",
      PreviewGuardController,
      "",
      '<span id="out">Live content</span>',
    );
    expect(root.hasAttribute("data-preview-hidden")).toBe(false);
    instance.disconnect();
    vi.stubGlobal("MutationObserver", undefined);
    instance.connect();
    const dispatch = vi.spyOn(instance, "dispatch");
    document.documentElement.setAttribute("data-turbo-preview", "");
    await morph(root);
    expect(root.dataset.previewHidden).toBe("true");
    expect(root.style.visibility).toBe("hidden");
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual(["hide"]);
    dispatch.mockClear();
    document.documentElement.removeAttribute("data-turbo-preview");
    await morph(root);
    expect(root.hasAttribute("data-preview-hidden")).toBe(false);
    expect(root.style.visibility).toBe("");
    expect(dispatch.mock.calls.map(([name]) => name)).toEqual(["show"]);
    vi.unstubAllGlobals();
  });

  it("keeps a closed drawer's retained panel until a staged replacement takes its place", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<div id="out" data-stimeo--drawer-target="panel"></div>',
    );
    if (!(instance instanceof DrawerController)) throw new Error("Wrong controller");
    const previous = output(root);
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--drawer-target", "panel");
    replacement.setAttribute("data-state", "open");
    previous.before(replacement);
    const dispatch = vi.spyOn(instance, "dispatch");
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.openValue).toBe(false);
    expect(previous.dataset.state).toBe("closed");
    expect(replacement.dataset.state).toBe("open");
    expect(dispatch).not.toHaveBeenCalled();
    previous.remove();
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.openValue).toBe(true);
    expect(replacement.hidden).toBe(false);
  });

  it("does not apply a late panel callback to a disconnected drawer's API move", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<div id="out" data-stimeo--drawer-target="panel"><button>Inside</button></div>',
    );
    if (!(instance instanceof DrawerController)) throw new Error("Wrong controller");
    instance.open();
    expect(output(root).dataset.state).toBe("open");
    instance.disconnect();
    instance.panelTargetDisconnected(output(root));
    expect(output(root).dataset.state).toBe("open");
    expect(output(root).hidden).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("returns focus to the configured fallback when there was no HTMLElement opener", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<button id="trigger" data-stimeo--drawer-target="trigger">Open</button><div id="out" data-stimeo--drawer-target="panel"></div>',
    );
    if (!(instance instanceof DrawerController)) throw new Error("Wrong controller");
    const focus = vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
    instance.open();
    focus.mockRestore();
    expect(document.activeElement).toBe(output(root));
    instance.close();
    expect(document.activeElement).toBe(root.querySelector("#trigger"));
  });

  it("connects a drawer without a panel and adopts the target when it arrives", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { root } = await mount("drawer", DrawerController, "", "");
    expect(error).not.toHaveBeenCalled();
    root.innerHTML = '<div id="out" data-stimeo--drawer-target="panel"></div>';
    await vi.advanceTimersByTimeAsync(0);
    expect(output(root).dataset.state).toBe("closed");
    expect(output(root).dataset.placement).toBe("right");
    expect(output(root).hidden).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("does not let a departing non-owner panel release the current drawer", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<div id="out" data-stimeo--drawer-target="panel"><button>Inside</button><button id="held">Held focus</button></div><div id="spare" data-stimeo--drawer-target="panel"></div>',
    );
    if (!(instance instanceof DrawerController)) throw new Error("Wrong controller");
    instance.open();
    const held = root.querySelector<HTMLElement>("#held");
    if (!held) throw new Error("Missing focus target");
    held.focus();
    expect(document.activeElement).toBe(held);
    const spare = root.querySelector("#spare");
    if (!spare) throw new Error("Missing spare panel");
    spare.remove();
    instance.panelTargetDisconnected(spare as HTMLElement);
    expect(instance.openValue).toBe(true);
    expect(document.activeElement).toBe(held);
    await vi.advanceTimersByTimeAsync(0);
    expect(output(root).dataset.state).toBe("open");
    expect(output(root).hidden).toBe(false);
    expect(instance.openValue).toBe(true);
    instance.close();
  });

  it("can return from a drawer with neither an HTMLElement opener nor a trigger", async () => {
    const { root, instance } = await mount(
      "drawer",
      DrawerController,
      "",
      '<div id="out" data-stimeo--drawer-target="panel"></div>',
    );
    if (!(instance instanceof DrawerController)) throw new Error("Wrong controller");
    const focus = vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
    instance.open();
    focus.mockRestore();
    expect(document.activeElement).toBe(output(root));
    expect(() => instance.close()).not.toThrow();
    expect(output(root).dataset.state).toBe("closed");
  });

  it("reports a morph that changes overflow as reconcile and a repair as silent", async () => {
    const { root, instance } = await mount(
      "overflow-menu",
      OverflowMenuController,
      "",
      '<div data-stimeo--overflow-menu-target="items"><button id="out">A</button><button id="second">B</button></div><div data-stimeo--overflow-menu-target="more"><button data-stimeo--menu-target="trigger">More</button><div data-stimeo--menu-target="menu"></div></div>',
    );
    if (!(instance instanceof OverflowMenuController)) throw new Error("Wrong controller");
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 300 });
    for (const button of root.querySelectorAll("button"))
      Object.defineProperty(button, "offsetWidth", { configurable: true, value: 100 });
    instance.update();
    const dispatch = vi.spyOn(instance, "dispatch");
    Object.defineProperty(root, "clientWidth", { configurable: true, value: 150 });
    await morph(root);
    expect(root.getAttribute("data-overflow-count")).toBe("2");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("reconcile", {
      detail: { overflowCount: 2, total: 2 },
    });
    dispatch.mockClear();
    root.removeAttribute("data-overflow-count");
    await morph(root);
    expect(root.getAttribute("data-overflow-count")).toBe("2");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
