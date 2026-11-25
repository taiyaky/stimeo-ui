import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDropzoneController } from "../src/controllers/file_dropzone_controller";
import { ToastController } from "../src/controllers/toast_controller";
import { recordListeners } from "./helpers/listeners";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** The singular lists share first-target ownership, independent of their contents. */
describe.each(["file-dropzone", "toast"] as const)("%s coexisting lists", (name) => {
  const identifier = `stimeo--${name}`;
  const target = `data-${identifier}-target`;
  let application: Application;

  const requireElement = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLElement)) throw new Error(`${id} not found`);
    return element as T;
  };
  const list = () => requireElement("current");
  const root = () => requireElement("root");
  const newList = (contents = "", attrs = ""): HTMLElement => {
    const row = document.createElement("ul");
    row.id = "successor";
    row.setAttribute(target, "list");
    row.innerHTML = contents;
    if (attrs) row.setAttribute("inert", attrs);
    return row;
  };
  const toastMarkup = (text: string) =>
    `<li ${target}="item" tabindex="0"><span role="status" data-toast-slot="message">${text}</span><button data-toast-dismiss>Dismiss</button></li>`;
  const mount = async (contents = "") => {
    document.body.innerHTML = `<div id="root" data-controller="${identifier}" data-stimeo--toast-duration-value="200" data-stimeo--toast-max-value="0">
      <button id="trigger" ${target}="trigger">Choose</button>
      <input id="input" type="file" multiple ${target}="input">
      <ul id="current" ${target}="list">${contents}</ul>
      <template ${target}="${name === "toast" ? "template" : "itemTemplate"}">
        ${name === "toast" ? toastMarkup("Template") : `<li ${target}="item"><span ${target}="name"></span><button ${target}="remove" aria-label="Remove {name}">Remove</button></li>`}
      </template>
    </div><aside id="destination"></aside>`;
    application = Application.start();
    application.register(identifier, name === "toast" ? ToastController : FileDropzoneController);
    await tick();
  };
  const instance = () => {
    const controller = application.getControllerForElementAndIdentifier(root(), identifier);
    if (!(controller instanceof ToastController || controller instanceof FileDropzoneController))
      throw new Error("Controller not found");
    return controller;
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps an empty successor inert without changing either list or reporting", async () => {
    await mount();
    const events: Event[] = [];
    for (const event of ["change", "reconcile", "show", "dismiss"])
      root().addEventListener(`${identifier}:${event}`, (value) => events.push(value));
    const successor = newList();
    list().after(successor);
    await tick();
    expect(list().hasAttribute("inert")).toBe(false);
    expect(successor.hasAttribute("inert")).toBe(true);
    expect(successor.children).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it("binds delegated removal only to the first list", async () => {
    await mount();
    const ledger = recordListeners();
    try {
      const successor = newList("<li><button>Authored</button></li>");
      list().after(successor);
      await tick();
      expect(ledger.live(successor)).toEqual([]);
      expect(successor.textContent).toBe("Authored");
      expect(successor.hasAttribute("inert")).toBe(true);
    } finally {
      ledger.restore();
    }
  });

  it.each(["target", "node", "outside"] as const)(
    "returns inert when the successor leaves through %s",
    async (departure) => {
      await mount();
      const successor = newList();
      list().after(successor);
      await tick();
      if (departure === "target") successor.removeAttribute(target);
      else if (departure === "node") successor.remove();
      else requireElement("destination").append(successor);
      await tick();
      expect(successor.hasAttribute("inert")).toBe(false);
      expect(successor.hasAttribute(`data-${identifier}-inert-lease`)).toBe(false);
    },
  );

  it("returns a promoted successor's inert and makes the demoted list inert", async () => {
    await mount();
    const previous = list();
    const successor = newList();
    previous.after(successor);
    await tick();
    previous.before(successor);
    await tick();
    expect(successor.hasAttribute("inert")).toBe(false);
    expect(previous.hasAttribute("inert")).toBe(true);
    successor.remove();
    await tick();
    expect(previous.hasAttribute("inert")).toBe(false);
    expect(successor.hasAttribute("inert")).toBe(false);
  });

  it("returns the author's inert value on promotion", async () => {
    await mount();
    const successor = newList("", "authored");
    list().after(successor);
    await tick();
    list().remove();
    await tick();
    expect(successor.getAttribute("inert")).toBe("authored");
  });

  it("keeps a page's replacement inert value when the target leaves", async () => {
    await mount();
    const successor = newList();
    list().after(successor);
    await tick();
    successor.setAttribute("inert", "page");
    successor.removeAttribute(target);
    await tick();
    expect(successor.getAttribute("inert")).toBe("page");
  });

  it("repairs a retained list's inert after a morph without altering authored children", async () => {
    await mount();
    const successor = newList("<li>Authored</li>");
    list().after(successor);
    await tick();
    successor.removeAttribute("inert");
    successor.dispatchEvent(new CustomEvent("turbo:morph-element", { bubbles: true }));
    await tick();
    expect(successor.hasAttribute("inert")).toBe(true);
    expect(successor.textContent).toBe("Authored");
  });

  it("returns every inert lease after the controller identifier leaves", async () => {
    await mount();
    const successor = newList();
    list().after(successor);
    await tick();
    root().removeAttribute("data-controller");
    await tick();
    expect(successor.hasAttribute("inert")).toBe(false);
    expect(successor.hasAttribute(`data-${identifier}-inert-lease`)).toBe(false);
  });

  it("returns the inert leases when the controller leaves its observed application root", async () => {
    await mount();
    const successor = newList();
    list().after(successor);
    await tick();
    disconnectAndStopApplication(application);
    const scope = document.createElement("main");
    root().before(scope);
    scope.append(root());
    application = Application.start(scope);
    application.register(identifier, name === "toast" ? ToastController : FileDropzoneController);
    await tick();
    expect(successor.hasAttribute("inert")).toBe(true);
    requireElement("destination").append(root());
    await tick();
    expect(root().getAttribute("data-controller")).toBe(identifier);
    expect(successor.hasAttribute("inert")).toBe(false);
  });

  it("normalizes the inert lease on a restored copy's new first list", async () => {
    await mount();
    const successor = newList();
    list().after(successor);
    await tick();
    const copy = root().cloneNode(true) as HTMLElement;
    copy.querySelector("#current")?.remove();
    disconnectAndStopApplication(application);
    root().replaceWith(copy);
    application = Application.start();
    application.register(identifier, name === "toast" ? ToastController : FileDropzoneController);
    await tick();
    expect(requireElement("successor").hasAttribute("inert")).toBe(false);
  });

  it("reclaims a fallback root's tabindex from a restored copy", async () => {
    await mount('<li><button id="focused">Focused</button></li>');
    requireElement<HTMLButtonElement>("trigger").disabled = true;
    requireElement<HTMLInputElement>("input").disabled = true;
    requireElement("focused").focus();
    list().before(newList());
    await tick();
    expect(document.activeElement).toBe(root());
    expect(root().getAttribute("tabindex")).toBe("-1");
    const copy = root().cloneNode(true) as HTMLElement;
    disconnectAndStopApplication(application);
    root().replaceWith(copy);
    application = Application.start();
    application.register(identifier, name === "toast" ? ToastController : FileDropzoneController);
    await tick();
    expect(root().hasAttribute("tabindex")).toBe(false);
    expect(root().hasAttribute(`data-${identifier}-tabindex-loan`)).toBe(false);
  });

  it("preserves first-list interaction and the inert successor across an in-page move", async () => {
    await mount();
    const successor = newList();
    list().after(successor);
    await tick();
    const original = instance();
    requireElement("destination").append(root());
    await tick();
    expect(instance()).toBe(original);
    expect(successor.hasAttribute("inert")).toBe(true);
    expect(list().hasAttribute("inert")).toBe(false);
  });

  it("rescues focus before a newly inserted list demotes the focused list", async () => {
    await mount('<li><button id="focused">Focused</button></li>');
    requireElement("focused").focus();
    const successor = newList('<li><button id="replacement-focus">Replacement</button></li>');
    list().before(successor);
    await tick();
    expect(list().hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(
      requireElement(name === "toast" ? "replacement-focus" : "trigger"),
    );
  });

  it("rescues focus to the root when the current list and field offer no destination", async () => {
    await mount('<li><button id="focused">Focused</button></li>');
    requireElement<HTMLButtonElement>("trigger").disabled = true;
    requireElement<HTMLInputElement>("input").disabled = true;
    requireElement("focused").focus();
    list().before(newList());
    await tick();
    expect(document.activeElement).toBe(root());
    expect(root().getAttribute("tabindex")).toBe("-1");
    root().removeAttribute("data-controller");
    await tick();
    expect(root().hasAttribute("tabindex")).toBe(false);
  });

  if (name === "toast") {
    it("retakes existing items when the same list regains its target marker", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Retaken" } }));
      await vi.advanceTimersByTimeAsync(80);
      const item = list().firstElementChild as HTMLElement;
      list().removeAttribute(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      root().setAttribute("data-stimeo--toast-duration-value", "120");
      list().setAttribute(target, "list");
      await vi.advanceTimersByTimeAsync(119);
      expect(item.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(item.isConnected).toBe(false);
    });

    it("keeps a banked deadline when the whole current list moves behind its sibling", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Moved list" } }));
      await vi.advanceTimersByTimeAsync(80);
      const successor = newList();
      list().after(successor);
      await vi.advanceTimersByTimeAsync(0);
      successor.after(list());
      await vi.advanceTimersByTimeAsync(400);
      expect(list().children).toHaveLength(1);
      successor.remove();
      await vi.advanceTimersByTimeAsync(119);
      expect(list().children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list().children).toHaveLength(0);
    });

    it("starts a fresh deadline when a demoted list retires and then regains its marker", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Restored list" } }));
      await vi.advanceTimersByTimeAsync(80);
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      list().removeAttribute(target);
      await vi.advanceTimersByTimeAsync(0);
      list().setAttribute(target, "list");
      await vi.advanceTimersByTimeAsync(0);
      successor.remove();
      await vi.advanceTimersByTimeAsync(199);
      expect(list().children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list().children).toHaveLength(0);
    });

    it("forgets a retired item's suspension before the item returns to the promoted list", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Restored item" } }));
      await vi.advanceTimersByTimeAsync(80);
      const item = list().firstElementChild as HTMLElement;
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      item.removeAttribute(target);
      await vi.advanceTimersByTimeAsync(0);
      item.setAttribute(target, "item");
      await vi.advanceTimersByTimeAsync(0);
      successor.remove();
      await vi.advanceTimersByTimeAsync(200);
      expect(item.isConnected).toBe(false);
    });

    it("forgets a demoted list's suspension across a controller move", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Reconnected" } }));
      await vi.advanceTimersByTimeAsync(80);
      const item = list().firstElementChild as HTMLElement;
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      requireElement("destination").append(root());
      await vi.advanceTimersByTimeAsync(0);
      successor.remove();
      await vi.advanceTimersByTimeAsync(199);
      expect(item.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(item.isConnected).toBe(false);
    });

    it("keeps new intake in DOM order when a known waiting list reconnects first", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.maxValue = 2;
      toast.durationValue = 0;
      const host = root();
      const previous = list();
      const successor = newList(toastMarkup("Waiting"));
      previous.after(successor);
      await vi.advanceTimersByTimeAsync(0);
      const waiting = successor.firstElementChild as HTMLElement;
      expect(waiting.hasAttribute("data-state")).toBe(false);
      host.remove();
      await vi.advanceTimersByTimeAsync(0);
      previous.remove();
      successor.insertAdjacentHTML("afterbegin", toastMarkup("First intake"));
      const first = successor.firstElementChild as HTMLElement;
      requireElement("destination").append(host);
      await vi.advanceTimersByTimeAsync(0);
      expect(instance()).toBe(toast);
      expect(successor.children).toHaveLength(2);
      toast.show(new CustomEvent("show", { detail: { message: "Newest" } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(first.isConnected).toBe(false);
      expect(waiting.isConnected).toBe(true);
    });

    it("releases a demoted toast's obsolete focus hold when its list is promoted", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Focused" } }));
      await vi.advanceTimersByTimeAsync(80);
      const item = list().firstElementChild as HTMLElement;
      const button = item.querySelector<HTMLButtonElement>("button");
      if (!button) throw new Error("Dismiss button missing");
      button.focus();
      expect(item.getAttribute("data-paused")).toBe("true");
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.activeElement).toBe(root());
      successor.remove();
      await vi.advanceTimersByTimeAsync(119);
      expect(item.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(item.isConnected).toBe(false);
    });

    it("releases obsolete hover and clears its pause hook when its list is promoted", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Hovered" } }));
      await vi.advanceTimersByTimeAsync(80);
      const item = list().firstElementChild as HTMLElement;
      toast.pause(item);
      expect(item.getAttribute("data-paused")).toBe("true");
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      successor.remove();
      await vi.advanceTimersByTimeAsync(0);
      expect(item.hasAttribute("data-paused")).toBe(false);
      await vi.advanceTimersByTimeAsync(120);
      expect(item.isConnected).toBe(false);
    });

    it("reads focus acquired while the page exposed a waiting list before promotion", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Page focused" } }));
      await vi.advanceTimersByTimeAsync(0);
      const item = list().firstElementChild as HTMLElement;
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      list().removeAttribute("inert");
      const button = item.querySelector<HTMLButtonElement>("button");
      if (!button) throw new Error("Dismiss button missing");
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(item.hasAttribute("data-paused")).toBe(false);
      successor.remove();
      await vi.advanceTimersByTimeAsync(0);
      expect(item.getAttribute("data-paused")).toBe("true");
      await vi.advanceTimersByTimeAsync(400);
      expect(item.isConnected).toBe(true);
      requireElement("trigger").focus();
      await vi.advanceTimersByTimeAsync(200);
      expect(item.isConnected).toBe(false);
    });

    it("finishes the entering phase when a list is promoted before its frame ran", async () => {
      await mount();
      vi.useFakeTimers();
      vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Entering" } }));
      await vi.advanceTimersByTimeAsync(0);
      const item = list().firstElementChild as HTMLElement;
      expect(item.dataset.state).toBe("entering");
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      successor.remove();
      await vi.advanceTimersByTimeAsync(0);
      expect(item.dataset.state).toBe("visible");
    });

    it("does not repaint a promoted visible toast from an obsolete entering frame", async () => {
      await mount();
      vi.useFakeTimers();
      const frames = new Map<number, FrameRequestCallback>();
      let next = 0;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        const handle = ++next;
        frames.set(handle, callback);
        return handle;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
        frames.delete(handle);
      });
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Promoted" } }));
      await vi.advanceTimersByTimeAsync(0);
      const item = list().firstElementChild as HTMLElement;
      expect(item.dataset.state).toBe("entering");
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      successor.remove();
      await vi.advanceTimersByTimeAsync(0);
      expect(item.dataset.state).toBe("visible");
      const writes: MutationRecord[] = [];
      const observer = new MutationObserver((records) => writes.push(...records));
      observer.observe(item, { attributes: true, attributeFilter: ["data-state"] });
      try {
        item.setAttribute("data-state", "visible");
        await vi.advanceTimersByTimeAsync(0);
        expect(writes).toHaveLength(1);
        writes.length = 0;
        for (const callback of frames.values()) callback(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(writes).toHaveLength(0);
      } finally {
        observer.disconnect();
      }
    });

    it("releases the document hover confirmation when its only toast is demoted", async () => {
      await mount();
      vi.useFakeTimers();
      const ledger = recordListeners();
      try {
        const toast = instance() as ToastController;
        toast.show(new CustomEvent("show", { detail: { message: "Awaiting pointer" } }));
        await vi.advanceTimersByTimeAsync(0);
        const item = list().firstElementChild as HTMLElement;
        toast.pause(item);
        list().append(item);
        await vi.advanceTimersByTimeAsync(0);
        expect(ledger.live(document).some(({ type }) => type === "pointermove")).toBe(true);
        list().before(newList());
        await vi.advanceTimersByTimeAsync(0);
        expect(ledger.live(document).some(({ type }) => type === "pointermove")).toBe(false);
      } finally {
        ledger.restore();
      }
    });

    it.each(["item", "list"] as const)(
      "cancels a leaving transition when its %s marker retires",
      async (marker) => {
        await mount();
        vi.useFakeTimers();
        const toast = instance() as ToastController;
        toast.show(new CustomEvent("show", { detail: { message: "Leaving" } }));
        await vi.advanceTimersByTimeAsync(0);
        const item = list().firstElementChild as HTMLElement;
        item.style.transitionDuration = "0.1s";
        item.style.transitionProperty = "opacity";
        toast.dismiss(item);
        await vi.advanceTimersByTimeAsync(40);
        const owner = marker === "item" ? item : list();
        owner.removeAttribute(target);
        await vi.advanceTimersByTimeAsync(0);
        owner.setAttribute(target, marker);
        await vi.advanceTimersByTimeAsync(200);
        expect(item.isConnected).toBe(true);
      },
    );

    it("takes a retired list's toast into another list without obsolete holds", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Retired" } }));
      await vi.advanceTimersByTimeAsync(0);
      const item = list().firstElementChild as HTMLElement;
      toast.pause(item);
      expect(item.getAttribute("data-paused")).toBe("true");
      list().removeAttribute(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(item.hasAttribute("data-paused")).toBe(false);
      const successor = newList();
      list().after(successor);
      await vi.advanceTimersByTimeAsync(0);
      successor.append(item);
      await vi.advanceTimersByTimeAsync(199);
      expect(item.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(item.isConnected).toBe(false);
    });

    it("records an item returning from a retired list after the list's newer arrivals", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.durationValue = 0;
      toast.maxValue = 2;
      toast.show(new CustomEvent("show", { detail: { message: "Old" } }));
      await vi.advanceTimersByTimeAsync(0);
      const old = list().firstElementChild as HTMLElement;
      list().removeAttribute(target);
      await vi.advanceTimersByTimeAsync(0);
      const successor = newList();
      list().after(successor);
      await vi.advanceTimersByTimeAsync(0);
      toast.show(new CustomEvent("show", { detail: { message: "Newer" } }));
      await vi.advanceTimersByTimeAsync(0);
      const newer = successor.firstElementChild as HTMLElement;
      successor.append(old);
      await vi.advanceTimersByTimeAsync(0);
      toast.show(new CustomEvent("show", { detail: { message: "Newest" } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(old.isConnected).toBe(true);
      expect(newer.isConnected).toBe(false);
    });

    it("cancels an entering frame when the list marker retires", async () => {
      await mount();
      vi.useFakeTimers();
      const frames = new Map<number, FrameRequestCallback>();
      let next = 0;
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        const handle = ++next;
        frames.set(handle, callback);
        return handle;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
        frames.delete(handle);
      });
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Control" } }));
      await vi.advanceTimersByTimeAsync(0);
      const control = list().firstElementChild as HTMLElement;
      for (const [handle, callback] of frames) {
        frames.delete(handle);
        callback(0);
      }
      expect(control.dataset.state).toBe("visible");
      toast.show(new CustomEvent("show", { detail: { message: "Retired" } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.size).toBe(1);
      list().removeAttribute(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(() => {
        for (const callback of frames.values()) callback(0);
      }).not.toThrow();
    });

    it("leaves an unowned waiting toast's authored hooks alone when its target leaves", async () => {
      await mount();
      const successor = newList(toastMarkup("Waiting"));
      const item = successor.firstElementChild as HTMLElement;
      item.setAttribute("data-paused", "authored");
      list().after(successor);
      await tick();
      item.removeAttribute(target);
      await tick();
      expect(item.getAttribute("data-paused")).toBe("authored");
      expect(item.hasAttribute("data-state")).toBe(false);
    });

    it("preserves a current toast's deadline when a successor is appended", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Current" } }));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(80);
      const successor = newList(toastMarkup("Waiting"));
      list().after(successor);
      await vi.advanceTimersByTimeAsync(0);
      expect(successor.firstElementChild?.hasAttribute("data-state")).toBe(false);
      await vi.advanceTimersByTimeAsync(120);
      expect(list().children).toHaveLength(0);
      expect(successor.children).toHaveLength(1);
    });

    it("repairs the current list without repainting a suspended toast in a following list", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Suspended" } }));
      await vi.advanceTimersByTimeAsync(0);
      const oldList = list();
      const suspended = oldList.firstElementChild as HTMLElement;
      const successor = newList();
      oldList.before(successor);
      await vi.advanceTimersByTimeAsync(0);
      toast.show(new CustomEvent("show", { detail: { message: "Current" } }));
      await vi.advanceTimersByTimeAsync(0);
      const current = successor.firstElementChild as HTMLElement;
      const currentPhase = current.dataset.state;
      suspended.dataset.state = "consumer";
      current.removeAttribute("data-state");

      successor.dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(suspended.dataset.state).toBe("consumer");
      expect(current.dataset.state).toBe(currentPhase);
    });

    it("banks a demoted toast's remaining deadline until its list is first again", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Current" } }));
      await vi.advanceTimersByTimeAsync(80);
      const successor = newList(toastMarkup("Ahead"));
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(400);
      expect(list().children).toHaveLength(1);
      successor.remove();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(119);
      expect(list().children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(list().children).toHaveLength(0);
    });

    it("banks a leaving toast's transition until its list becomes first again", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Leaving" } }));
      await vi.advanceTimersByTimeAsync(0);
      const item = list().firstElementChild as HTMLElement;
      item.style.transitionDuration = "0.1s";
      item.style.transitionProperty = "opacity";
      toast.dismiss(item);
      await vi.advanceTimersByTimeAsync(40);
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(200);
      expect(item.isConnected).toBe(true);
      successor.remove();
      await vi.advanceTimersByTimeAsync(59);
      expect(item.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(item.isConnected).toBe(false);
    });

    it("releases a suspended toast when its list stops being a target", async () => {
      await mount();
      vi.useFakeTimers();
      const toast = instance() as ToastController;
      toast.show(new CustomEvent("show", { detail: { message: "Released" } }));
      await vi.advanceTimersByTimeAsync(50);
      const item = list().firstElementChild as HTMLElement;
      const successor = newList();
      list().before(successor);
      await vi.advanceTimersByTimeAsync(0);
      list().removeAttribute(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(item.isConnected).toBe(true);
    });
  } else {
    it("releases the current list's click listener when the controller leaves", async () => {
      const ledger = recordListeners();
      try {
        await mount();
        const current = list();
        expect(ledger.live(current, "click")).toHaveLength(1);

        root().removeAttribute("data-controller");
        await tick();

        expect(current.isConnected).toBe(true);
        expect(ledger.live(current, "click")).toHaveLength(0);
      } finally {
        ledger.restore();
      }
    });

    it("does not repair zone hooks from a list whose marker retired", async () => {
      await mount();
      const zone = document.createElement("div");
      zone.setAttribute(target, "zone");
      root().append(zone);
      await tick();
      const input = requireElement<HTMLInputElement>("input");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["chosen"], "chosen.txt", { type: "text/plain" }));
      input.files = transfer.files;
      (instance() as FileDropzoneController).onChange();
      const preview = list().firstElementChild;
      if (!preview) throw new Error("Preview missing");
      list().removeAttribute(target);
      await tick();
      zone.setAttribute("data-dragover", "page");
      preview.remove();
      await tick();
      expect(zone.getAttribute("data-dragover")).toBe("page");
    });

    it("uses the native input when a demoted list has focus and no trigger remains", async () => {
      await mount('<li><button id="focused">Focused</button></li>');
      requireElement("trigger").remove();
      await tick();
      requireElement("focused").focus();
      list().before(newList());
      await tick();
      expect(document.activeElement).toBe(requireElement("input"));
    });

    it.each([false, true])(
      "honors disabled fieldset inheritance with trigger in first legend=%s",
      async (inLegend) => {
        await mount('<li><button id="focused">Focused</button></li>');
        const fieldset = document.createElement("fieldset");
        fieldset.disabled = true;
        const trigger = requireElement("trigger");
        trigger.before(fieldset);
        if (inLegend) {
          const legend = document.createElement("legend");
          fieldset.append(legend);
          legend.append(trigger);
        } else fieldset.append(trigger);
        requireElement("focused").focus();
        list().before(newList());
        await tick();
        expect(document.activeElement).toBe(requireElement(inLegend ? "trigger" : "input"));
      },
    );

    it("uses the root when focus leaves a demoted list after both controls leave", async () => {
      await mount('<li><button id="focused">Focused</button></li>');
      requireElement("trigger").remove();
      requireElement("input").remove();
      await tick();
      requireElement("focused").focus();
      list().before(newList());
      await tick();
      expect(document.activeElement).toBe(root());
    });

    it("rescues preview focus to the field when the new first list is authored inert", async () => {
      await mount();
      const input = requireElement<HTMLInputElement>("input");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["chosen"], "chosen.txt", { type: "text/plain" }));
      input.files = transfer.files;
      (instance() as FileDropzoneController).onChange();
      const remove = list().querySelector<HTMLButtonElement>("button");
      if (!remove) throw new Error("Remove button missing");
      remove.focus();
      const successor = newList("", "authored");
      list().before(successor);
      await tick();
      expect(successor.contains(remove)).toBe(true);
      expect(document.activeElement).toBe(requireElement("trigger"));
      expect(successor.getAttribute("inert")).toBe("authored");
    });

    it("keeps generated previews, form values and removal events across list promotion", async () => {
      await mount();
      const dropzone = instance() as FileDropzoneController;
      const input = requireElement<HTMLInputElement>("input");
      const selected = new File(["chosen"], "chosen.txt", { type: "text/plain" });
      const transfer = new DataTransfer();
      transfer.items.add(selected);
      input.files = transfer.files;
      dropzone.onChange();
      const item = list().firstElementChild;
      const events = vi.fn();
      root().addEventListener(`${identifier}:change`, events);
      const successor = newList();
      list().after(successor);
      await tick();
      expect(list().firstElementChild).toBe(item);
      expect(events).not.toHaveBeenCalled();
      list().remove();
      await tick();
      expect(successor.firstElementChild).toBe(item);
      expect(Array.from(input.files ?? [])).toEqual([selected]);
      expect(events).not.toHaveBeenCalled();
      const remove = successor.querySelector<HTMLButtonElement>("button");
      if (!remove) throw new Error("Remove button missing");
      remove.click();
      expect(successor.children).toHaveLength(0);
      expect(input.files).toHaveLength(0);
      expect(events).toHaveBeenCalledOnce();
    });

    it("keeps focus on a generated remove button when its preview moves to the new first list", async () => {
      await mount();
      const dropzone = instance() as FileDropzoneController;
      const input = requireElement<HTMLInputElement>("input");
      const transfer = new DataTransfer();
      transfer.items.add(new File(["chosen"], "chosen.txt", { type: "text/plain" }));
      input.files = transfer.files;
      dropzone.onChange();
      const remove = list().querySelector<HTMLButtonElement>("button");
      if (!remove) throw new Error("Remove button missing");
      remove.focus();
      const successor = newList();
      list().before(successor);
      await tick();
      expect(successor.contains(remove)).toBe(true);
      expect(document.activeElement).toBe(remove);
      expect(input.files).toHaveLength(1);
    });
  }
});
