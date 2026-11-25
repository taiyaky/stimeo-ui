import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoverCardController } from "../src/controllers/hover_card_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { query } from "./helpers/dom";
import { typeKey } from "./helpers/keyboard";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Real target delivery around a hover card's authored attributes and retained state. */
describe("HoverCardController target lifetime", () => {
  let application: Application | undefined;
  const heard: string[] = [];
  const mount = async (
    attributes = "",
    hidden: string | null = "until-found",
    state: string | null = "authored",
  ) => {
    document.body.innerHTML = `<span id="host" data-controller="stimeo--hover-card" ${attributes}>
      <a id="trigger" href="#jane" aria-controls="card" aria-expanded="false" data-stimeo--hover-card-target="trigger">Jane</a>
      <div id="card" ${hidden === null ? "" : `hidden="${hidden}"`} ${state === null ? "" : `data-state="${state}"`}
        data-stimeo--hover-card-target="card"><a id="follow" href="#follow">Follow</a></div>
    </span><button id="outside" type="button">Outside</button>`;
    for (const delay of ["open", "close"]) {
      const name = `data-stimeo--hover-card-${delay}-delay-value`;
      if (!query("#host").hasAttribute(name)) query("#host").setAttribute(name, "0");
    }
    application = Application.start();
    application.register("stimeo--hover-card", HoverCardController);
    await tick();
    for (const name of ["open", "close"])
      query("#host").addEventListener(`stimeo--hover-card:${name}`, () => heard.push(name));
  };
  const controller = () => {
    const instance = application?.getControllerForElementAndIdentifier(
      query("#host"),
      "stimeo--hover-card",
    );
    if (!(instance instanceof HoverCardController))
      throw new Error("Expected a mounted hover card");
    return instance;
  };
  const pressEscape = () => {
    // A document shortcut keeps the page's current focus untouched.
    return typeKey(document, "Escape").defaultPrevented;
  };
  const fresh = () => {
    const element = query("#card").cloneNode(true) as HTMLElement;
    element.hidden = true;
    element.setAttribute("data-state", "closed");
    for (const name of element.getAttributeNames())
      if (name.endsWith("-lease")) element.removeAttribute(name);
    return element;
  };
  const attributes = (element: HTMLElement) => [
    element.getAttribute("hidden"),
    element.getAttribute("data-state"),
  ];
  const expanded = () => query("#trigger").getAttribute("aria-expanded");

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    vi.useRealTimers();
    heard.length = 0;
    document.body.innerHTML = "";
  });

  it.each(["token", "identifier"])(
    "returns authored card attributes on %s departure",
    async (departure) => {
      await mount();
      controller().open();
      const card = query("#card");
      if (departure === "token") card.removeAttribute("data-stimeo--hover-card-target");
      else query("#host").removeAttribute("data-controller");
      await tick();
      expect(attributes(card)).toEqual(["until-found", "authored"]);
      expect(card.hasAttribute("data-stimeo--hover-card-hidden-lease")).toBe(false);
      expect(card.hasAttribute("data-stimeo--hover-card-data-state-lease")).toBe(false);
    },
  );

  it.each(["token", "identifier"])(
    "returns absent authored card attributes on %s departure",
    async (departure) => {
      await mount("", null, null);
      controller().open();
      const card = query("#card");
      if (departure === "token") card.removeAttribute("data-stimeo--hover-card-target");
      else query("#host").removeAttribute("data-controller");
      await tick();
      expect(attributes(card)).toEqual([null, null]);
    },
  );

  it("returns a closed card's authored attributes when its token leaves", async () => {
    await mount();
    const card = query("#card");
    card.removeAttribute("data-stimeo--hover-card-target");
    await tick();
    expect(attributes(card)).toEqual(["until-found", "authored"]);
  });

  it("retains page-written card attributes on departure", async () => {
    await mount();
    controller().open();
    const card = query("#card");
    card.setAttribute("hidden", "page");
    card.setAttribute("data-state", "page");
    card.removeAttribute("data-stimeo--hover-card-target");
    await tick();
    expect(attributes(card)).toEqual(["page", "page"]);
  });

  it("cancels a pending open before root teardown without late trigger writes", async () => {
    await mount('data-stimeo--hover-card-open-delay-value="200"');
    vi.useFakeTimers();
    controller().open();
    const host = query("#host");
    const trigger = query("#trigger");
    host.remove();
    await vi.advanceTimersByTimeAsync(0);
    const before = host.innerHTML;
    vi.advanceTimersByTime(1000);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(host.innerHTML).toBe(before);
  });

  it("keeps card and trigger attributes through a whole-root detach", async () => {
    await mount();
    controller().open();
    const host = query("#host");
    const before = host.innerHTML;
    host.remove();
    await tick();
    expect(host.innerHTML).toBe(before);
    expect(pressEscape()).toBe(false);
  });

  it("keeps attributes quiet when the same card moves within its scope", async () => {
    await mount();
    controller().open();
    const card = query("#card");
    const before = card.outerHTML;
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(card, { attributes: true });
    const wrapper = document.createElement("span");
    query("#host").append(wrapper);
    wrapper.append(card);
    await tick();
    writes.push(...observer.takeRecords());
    observer.disconnect();
    expect(card.outerHTML).toBe(before);
    expect(writes).toEqual([]);
    expect(expanded()).toBe("true");
    expect(pressEscape()).toBe(true);
    expect(card.hidden).toBe(true);
  });

  it("returns the cached author's attributes after reconnecting a cloned page", async () => {
    await mount();
    controller().open();
    if (!application) throw new Error("Expected a mounted application");
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--hover-card", HoverCardController),
    );
    const card = query("#card");
    query("#host").removeAttribute("data-controller");
    await tick();
    expect(attributes(card)).toEqual(["until-found", "authored"]);
    expect(expanded()).toBe("false");
  });

  it.each(["open", "close", "Escape", "no action"])(
    "resolves replacement card before %s",
    async (action) => {
      await mount();
      controller().open();
      heard.length = 0;
      const old = query("#card");
      const next = fresh();
      old.replaceWith(next);
      if (action === "open") controller().open();
      if (action === "close") controller().close();
      if (action === "Escape") expect(pressEscape()).toBe(true);
      const open = action === "open" || action === "no action";
      if (action !== "no action") expect(next.hidden).toBe(action === "Escape");
      if (action !== "no action") expect(attributes(old)).toEqual(["until-found", "authored"]);
      await tick();
      await tick();
      expect(next.hidden).toBe(!open);
      expect(next.getAttribute("data-state")).toBe(open ? "open" : "closed");
      expect(expanded()).toBe(String(open));
      expect(attributes(old)).toEqual(["until-found", "authored"]);
      expect(heard).toEqual(open ? [] : ["close"]);
      expect(pressEscape()).toBe(open);
    },
  );

  it.each(["open", "close", "Escape", "no action"])(
    "keeps and updates open state while no card resolves (%s)",
    async (action) => {
      await mount();
      controller().open();
      heard.length = 0;
      const old = query("#card");
      const next = fresh();
      old.remove();
      await tick();
      if (action === "open") controller().open();
      if (action === "close") controller().close();
      if (action === "Escape") expect(pressEscape()).toBe(true);
      await tick();
      const open = action === "open" || action === "no action";
      expect(expanded()).toBe(String(open));
      query("#host").append(next);
      await tick();
      expect(next.hidden).toBe(!open);
      expect(heard).toEqual(open ? [] : ["close"]);
      expect(pressEscape()).toBe(open);
      expect(pressEscape()).toBe(false);
    },
  );

  it("accepts an open request while closed without a card", async () => {
    await mount();
    const old = query("#card");
    const next = fresh();
    old.remove();
    await tick();
    controller().open();
    expect(heard).toEqual(["open"]);
    expect(expanded()).toBe("true");
    query("#host").append(next);
    await tick();
    expect(next.hidden).toBe(false);
    expect(heard).toEqual(["open"]);
  });

  it("releases scroll resources while a card is missing and resumes on arrival", async () => {
    await mount('data-stimeo--hover-card-close-on-scroll-value="true"');
    const removeListener = vi.spyOn(window, "removeEventListener");
    try {
      controller().open();
      heard.length = 0;
      const old = query("#card");
      const next = fresh();
      old.remove();
      await tick();
      expect(removeListener).toHaveBeenCalledWith("scroll", expect.any(Function));
      window.dispatchEvent(new Event("scroll"));
      expect(heard).toEqual([]);
      expect(expanded()).toBe("true");
      query("#host").append(next);
      await tick();
      expect(next.hidden).toBe(false);
      window.dispatchEvent(new Event("scroll"));
      expect(next.hidden).toBe(true);
      expect(expanded()).toBe("false");
      expect(heard).toEqual(["close"]);
      expect(pressEscape()).toBe(false);
    } finally {
      removeListener.mockRestore();
    }
  });

  it("dismisses on same-task scroll only when the card is present", async () => {
    await mount('data-stimeo--hover-card-close-on-scroll-value="true"');
    controller().open();
    heard.length = 0;
    const old = query("#card");
    const next = fresh();
    old.remove();
    window.dispatchEvent(new Event("scroll"));
    expect(expanded()).toBe("true");
    expect(heard).toEqual([]);

    query("#host").append(next);
    window.dispatchEvent(new Event("scroll"));
    expect(next.hidden).toBe(true);
    expect(expanded()).toBe("false");
    expect(heard).toEqual(["close"]);
    await tick();
    expect(heard).toEqual(["close"]);
  });

  it("keeps its Escape order beneath a newer layer across a card replacement", async () => {
    await mount();
    controller().open();
    const other = new EscapeLayer();
    let dismissed = false;
    other.activate(document, {
      onDismiss: () => {
        dismissed = true;
        other.deactivate();
      },
    });
    try {
      query("#card").replaceWith(fresh());
      await tick();
      expect(pressEscape()).toBe(true);
      expect(dismissed).toBe(true);
      expect(query("#card").hidden).toBe(false);
      expect(pressEscape()).toBe(true);
      expect(query("#card").hidden).toBe(true);
    } finally {
      other.deactivate();
    }
  });

  it.each(["open", "close"])(
    "keeps the scheduled %s deadline across card absence",
    async (action) => {
      await mount(`data-stimeo--hover-card-${action}-delay-value="200"`);
      vi.useFakeTimers();
      if (action === "close") {
        controller().open();
        controller().close();
      } else controller().open();
      const old = query("#card");
      const next = fresh();
      vi.advanceTimersByTime(50);
      old.remove();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(50);
      query("#host").append(next);
      await vi.advanceTimersByTimeAsync(0);
      expect(next.hidden).toBe(action === "open");
      vi.advanceTimersByTime(99);
      expect(next.hidden).toBe(action === "open");
      vi.advanceTimersByTime(1);
      expect(next.hidden).toBe(action === "close");
      expect(heard).toEqual(action === "open" ? ["open"] : ["open", "close"]);
    },
  );

  it("keeps a replacement open while focus is inside, then closes without moving outside focus", async () => {
    await mount();
    controller().open();
    heard.length = 0;
    const next = fresh();
    query("#card").replaceWith(next);
    controller().open();
    query<HTMLAnchorElement>("#follow").focus();
    controller().close();
    await tick();
    await tick();
    expect(next.hidden).toBe(false);
    expect(expanded()).toBe("true");
    expect(document.activeElement).toBe(query("#follow"));
    expect(heard).toEqual([]);
    query<HTMLButtonElement>("#outside").focus();
    controller().close();
    await tick();
    expect(next.hidden).toBe(true);
    expect(document.activeElement).toBe(query("#outside"));
    expect(heard).toEqual(["close"]);
  });

  it("cancels a pending close when the pointer bridges to the replacement card", async () => {
    await mount('data-stimeo--hover-card-close-delay-value="200"');
    vi.useFakeTimers();
    controller().open(new MouseEvent("mouseenter"));
    heard.length = 0;
    controller().close(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(50);
    query("#card").replaceWith(fresh());
    controller().open(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(500);
    expect(query("#card").hidden).toBe(false);
    expect(expanded()).toBe("true");
    expect(heard).toEqual([]);
  });

  it("settles a card replaced by an open subscriber before the open action returns", async () => {
    await mount();
    const old = query("#card");
    const next = fresh();
    query("#host").addEventListener("stimeo--hover-card:open", () => old.replaceWith(next), {
      once: true,
    });
    controller().open();
    expect(next.hidden).toBe(false);
    expect(attributes(old)).toEqual(["until-found", "authored"]);
    expect(expanded()).toBe("true");
    expect(heard).toEqual(["open"]);
    expect(pressEscape()).toBe(true);
    expect(next.hidden).toBe(true);
  });

  it("closes the previous first card when another card takes over before its departure", async () => {
    await mount();
    controller().open();
    heard.length = 0;
    const old = query("#card");
    const next = fresh();
    old.id = "previous-card";
    query("#follow").id = "previous-follow";
    old.before(next);
    controller().open();
    expect(old.hidden).toBe(true);
    expect(old.getAttribute("data-state")).toBe("closed");
    expect(next.hidden).toBe(false);
    expect(expanded()).toBe("true");
    expect(heard).toEqual([]);
    await tick();
    old.removeAttribute("data-stimeo--hover-card-target");
    await tick();
    expect(attributes(old)).toEqual(["until-found", "authored"]);
    expect(next.hidden).toBe(false);
  });

  it("releases the retained resources and expanded ARIA when a page-hidden card leaves", async () => {
    await mount('data-stimeo--hover-card-close-on-scroll-value="true"');
    controller().open();
    heard.length = 0;
    const old = query("#card");
    const next = fresh();
    old.hidden = true;
    old.remove();
    await tick();
    expect(expanded()).toBe("false");
    expect(pressEscape()).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(heard).toEqual([]);
    query("#host").append(next);
    await tick();
    expect(next.hidden).toBe(true);
    expect(expanded()).toBe("false");
    expect(heard).toEqual([]);
  });

  it("leaves a newer layer above a nested reopen from its open subscriber", async () => {
    await mount();
    const other = new EscapeLayer();
    let reopened = false;
    let dismissed = false;
    query("#host").addEventListener("stimeo--hover-card:open", () => {
      if (reopened) return;
      reopened = true;
      query("#card").hidden = true;
      controller().open();
      other.activate(document, {
        onDismiss: () => {
          dismissed = true;
          other.deactivate();
        },
      });
    });
    try {
      controller().open();
      expect(pressEscape()).toBe(true);
      expect(dismissed).toBe(true);
      expect(query("#card").hidden).toBe(false);
      expect(pressEscape()).toBe(true);
      expect(query("#card").hidden).toBe(true);
    } finally {
      other.deactivate();
    }
  });
});
