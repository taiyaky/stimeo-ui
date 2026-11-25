import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipController } from "../src/controllers/tooltip_controller";
import { EscapeLayer } from "../src/utils/escape_layer";
import { query } from "./helpers/dom";
import { typeKey } from "./helpers/keyboard";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Real target delivery around a tooltip's authored attributes and transient surface. */
describe("TooltipController target lifetime", () => {
  let application: Application | undefined;
  const heard: string[] = [];
  const mount = async (
    attributes = "",
    hidden: string | null = "until-found",
    state: string | null = "authored",
  ) => {
    document.body.innerHTML = `<span id="host" data-controller="stimeo--tooltip" ${attributes}>
      <button type="button" aria-describedby="tip" data-stimeo--tooltip-target="trigger">Save</button>
      <span id="tip" role="tooltip" ${hidden === null ? "" : `hidden="${hidden}"`} ${state === null ? "" : `data-state="${state}"`}
        data-stimeo--tooltip-target="content">Saves</span>
    </span>`;
    application = Application.start();
    application.register("stimeo--tooltip", TooltipController);
    await tick();
    for (const name of ["open", "close"])
      query("#host").addEventListener(`stimeo--tooltip:${name}`, () => heard.push(name));
  };
  const controller = () => {
    const instance = application?.getControllerForElementAndIdentifier(
      query("#host"),
      "stimeo--tooltip",
    );
    if (!(instance instanceof TooltipController)) throw new Error("Expected a mounted tooltip");
    return instance;
  };
  const pressEscape = () => {
    // A document shortcut must keep the page's current focus untouched.
    return typeKey(document, "Escape").defaultPrevented;
  };
  const fresh = () => {
    const element = query("#tip").cloneNode(true) as HTMLElement;
    element.hidden = true;
    element.setAttribute("data-state", "closed");
    for (const name of element.getAttributeNames())
      if (name.endsWith("-lease")) element.removeAttribute(name);
    return element;
  };
  const values = (element: HTMLElement) => [
    element.getAttribute("hidden"),
    element.getAttribute("data-state"),
  ];

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    vi.useRealTimers();
    heard.length = 0;
    document.body.innerHTML = "";
  });

  it.each(["token", "identifier"])(
    "returns authored attributes on %s departure",
    async (departure) => {
      await mount();
      controller().show();
      const content = query("#tip");
      if (departure === "token") content.removeAttribute("data-stimeo--tooltip-target");
      else query("#host").removeAttribute("data-controller");
      await tick();
      expect(values(content)).toEqual(["until-found", "authored"]);
      expect(content.hasAttribute("data-stimeo--tooltip-hidden-lease")).toBe(false);
      expect(content.hasAttribute("data-stimeo--tooltip-data-state-lease")).toBe(false);
    },
  );

  it.each(["token", "identifier"])(
    "returns absent authored attributes on %s departure",
    async (departure) => {
      await mount("", null, null);
      controller().show();
      const content = query("#tip");
      if (departure === "token") content.removeAttribute("data-stimeo--tooltip-target");
      else query("#host").removeAttribute("data-controller");
      await tick();
      expect(values(content)).toEqual([null, null]);
    },
  );

  it("returns a closed target's authored attributes when its token leaves", async () => {
    await mount();
    const content = query("#tip");
    content.removeAttribute("data-stimeo--tooltip-target");
    await tick();
    expect(values(content)).toEqual(["until-found", "authored"]);
  });

  it("retains page-written attributes on departure", async () => {
    await mount();
    controller().show();
    const content = query("#tip");
    content.setAttribute("hidden", "page");
    content.setAttribute("data-state", "page");
    content.removeAttribute("data-stimeo--tooltip-target");
    await tick();
    expect(values(content)).toEqual(["page", "page"]);
  });

  it("keeps attributes through a whole-root detach", async () => {
    await mount();
    controller().show();
    const host = query("#host");
    const content = query("#tip");
    const before = content.outerHTML;
    host.remove();
    await tick();
    expect(content.outerHTML).toBe(before);
    expect(pressEscape()).toBe(false);
  });

  it("keeps the same target and attributes through a move within the scope", async () => {
    await mount();
    controller().show();
    const content = query("#tip");
    const before = content.outerHTML;
    const wrapper = document.createElement("span");
    query("#host").append(wrapper);
    wrapper.append(content);
    await tick();
    expect(content.outerHTML).toBe(before);
    expect(pressEscape()).toBe(true);
    expect(content.hidden).toBe(true);
  });

  it("returns the cached author's attributes after reconnecting a cloned page", async () => {
    await mount();
    controller().show();
    if (!application) throw new Error("Expected a mounted application");
    application = await restoreFromCache(application, (restored) =>
      restored.register("stimeo--tooltip", TooltipController),
    );
    const content = query("#tip");
    query("#host").removeAttribute("data-controller");
    await tick();
    expect(values(content)).toEqual(["until-found", "authored"]);
  });

  it.each(["show", "hide", "Escape", "no action"])(
    "resolves replacement content before %s",
    async (action) => {
      await mount();
      controller().show();
      heard.length = 0;
      const old = query("#tip");
      const next = fresh();
      old.replaceWith(next);
      if (action === "show") controller().show();
      if (action === "hide") controller().hide();
      if (action === "Escape") expect(pressEscape()).toBe(true);
      const open = action === "show" || action === "no action";
      if (action !== "no action") expect(next.hidden).toBe(!open);
      await tick();
      expect(next.hidden).toBe(!open);
      expect(next.getAttribute("data-state")).toBe(open ? "open" : "closed");
      expect(values(old)).toEqual(["until-found", "authored"]);
      expect(heard).toEqual(open ? [] : ["close"]);
      expect(pressEscape()).toBe(open);
      expect(next.hidden).toBe(true);
    },
  );

  it("reflects a replacement before an active focus reason vetoes pointer hide", async () => {
    await mount();
    controller().show(new FocusEvent("focusin"));
    heard.length = 0;
    const next = fresh();
    query("#tip").replaceWith(next);
    controller().hide(new MouseEvent("mouseleave"));
    expect(next.hidden).toBe(false);
    expect(heard).toEqual([]);
  });

  it.each(["show", "hide", "Escape", "no action"])(
    "keeps and updates shown state with no content (%s)",
    async (action) => {
      await mount();
      controller().show();
      heard.length = 0;
      const old = query("#tip");
      const next = fresh();
      old.remove();
      await tick();
      if (action === "show") controller().show();
      if (action === "hide") controller().hide();
      if (action === "Escape") expect(pressEscape()).toBe(true);
      query("#host").append(next);
      await tick();
      const open = action === "show" || action === "no action";
      expect(next.hidden).toBe(!open);
      expect(heard).toEqual(open ? [] : ["close"]);
      expect(pressEscape()).toBe(open);
      expect(pressEscape()).toBe(false);
    },
  );

  it("accepts a show request while closed without content", async () => {
    await mount();
    const old = query("#tip");
    const next = fresh();
    old.remove();
    await tick();
    controller().show();
    expect(heard).toEqual(["open"]);
    query("#host").append(next);
    await tick();
    expect(next.hidden).toBe(false);
    expect(heard).toEqual(["open"]);
  });

  it("releases scroll resources while a surface is missing and resumes on arrival", async () => {
    await mount('data-stimeo--tooltip-close-on-scroll-value="true"');
    controller().show();
    heard.length = 0;
    const old = query("#tip");
    const next = fresh();
    old.remove();
    await tick();
    window.dispatchEvent(new Event("scroll"));
    expect(heard).toEqual([]);
    query("#host").append(next);
    await tick();
    expect(next.hidden).toBe(false);
    window.dispatchEvent(new Event("scroll"));
    expect(next.hidden).toBe(true);
    expect(heard).toEqual(["close"]);
    expect(pressEscape()).toBe(false);
  });

  it("keeps its Escape order beneath a newer layer across a content replacement", async () => {
    await mount();
    controller().show();
    const other = new EscapeLayer();
    let dismissed = false;
    other.activate(document, {
      onDismiss: () => {
        dismissed = true;
        other.deactivate();
      },
    });
    try {
      query("#tip").replaceWith(fresh());
      await tick();
      expect(pressEscape()).toBe(true);
      expect(dismissed).toBe(true);
      expect(query("#tip").hidden).toBe(false);
      expect(pressEscape()).toBe(true);
      expect(query("#tip").hidden).toBe(true);
    } finally {
      other.deactivate();
    }
  });

  it("leaves a newer layer above the show an open subscriber restarted on replacement content", async () => {
    await mount();
    const other = new EscapeLayer();
    let restarted = false;
    let dismissed = false;
    query("#host").addEventListener("stimeo--tooltip:open", () => {
      if (restarted) return;
      restarted = true;
      controller().hide();
      query("#tip").replaceWith(fresh());
      controller().show();
      other.activate(document, {
        onDismiss: () => {
          dismissed = true;
          other.deactivate();
        },
      });
    });
    try {
      controller().show();
      expect(heard).toEqual(["open", "close", "open"]);
      expect(query("#tip").hidden).toBe(false);
      expect(pressEscape()).toBe(true);
      expect(dismissed).toBe(true);
      expect(query("#tip").hidden).toBe(false);
      expect(pressEscape()).toBe(true);
      expect(query("#tip").hidden).toBe(true);
      expect(pressEscape()).toBe(false);
    } finally {
      other.deactivate();
    }
  });

  it("keeps a newer layer above a replacement resolved by show in the same task", async () => {
    await mount();
    controller().show();
    const other = new EscapeLayer();
    let dismissed = false;
    other.activate(document, {
      onDismiss: () => {
        dismissed = true;
        other.deactivate();
      },
    });
    try {
      query("#tip").replaceWith(fresh());
      controller().show();
      expect(heard).toEqual(["open"]);
      expect(pressEscape()).toBe(true);
      expect(dismissed).toBe(true);
      expect(query("#tip").hidden).toBe(false);
      expect(pressEscape()).toBe(true);
      expect(query("#tip").hidden).toBe(true);
      expect(pressEscape()).toBe(false);
    } finally {
      other.deactivate();
    }
  });

  it.each(["show", "hide"])(
    "keeps the scheduled %s deadline across target absence",
    async (action) => {
      await mount(`data-stimeo--tooltip-${action}-delay-value="200"`);
      vi.useFakeTimers();
      if (action === "hide") {
        controller().show();
        controller().hide();
      } else controller().show();
      const old = query("#tip");
      const next = fresh();
      vi.advanceTimersByTime(50);
      old.remove();
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(50);
      query("#host").append(next);
      await vi.advanceTimersByTimeAsync(0);
      expect(next.hidden).toBe(action === "show");
      vi.advanceTimersByTime(99);
      expect(next.hidden).toBe(action === "show");
      vi.advanceTimersByTime(1);
      expect(next.hidden).toBe(action === "hide");
      expect(heard).toEqual(action === "show" ? ["open"] : ["open", "close"]);
    },
  );

  it("leaves the current surface's attributes untouched on a repeated show", async () => {
    await mount();
    controller().show();
    const content = query("#tip");
    const observer = new MutationObserver(() => {});
    observer.observe(content, { attributes: true, attributeFilter: ["hidden", "data-state"] });
    try {
      controller().show();
      expect(observer.takeRecords()).toEqual([]);
      expect(content.hidden).toBe(false);

      controller().hide();
      expect(observer.takeRecords().map((record) => record.attributeName)).toContain("hidden");
      expect(content.hidden).toBe(true);
    } finally {
      observer.disconnect();
    }
  });

  it("carries a page-hidden surface's closed state into its replacement and releases Escape", async () => {
    await mount();
    controller().show();
    heard.length = 0;
    const previous = query("#tip");
    const next = fresh();
    previous.hidden = true;
    previous.replaceWith(next);
    await tick();

    expect(next.hidden).toBe(true);
    expect(next.getAttribute("data-state")).toBe("closed");
    expect(heard).toEqual([]);
    expect(pressEscape()).toBe(false);

    controller().show();
    expect(next.hidden).toBe(false);
    expect(pressEscape()).toBe(true);
    expect(heard).toEqual(["open", "close"]);
  });

  it("returns departed attributes during a same-task action before target delivery", async () => {
    await mount();
    controller().show();
    heard.length = 0;
    const previous = query("#tip");
    const next = fresh();
    previous.replaceWith(next);
    controller().show();

    expect(values(previous)).toEqual(["until-found", "authored"]);
    expect(next.hidden).toBe(false);
    expect(heard).toEqual([]);
    await tick();
    expect(next.hidden).toBe(false);
    expect(pressEscape()).toBe(true);
  });

  it("hides the former first surface when a new first target takes over", async () => {
    await mount();
    controller().show();
    heard.length = 0;
    const previous = query("#tip");
    const next = fresh();
    next.id = "next-tip";
    previous.before(next);
    controller().show();

    expect(previous.hidden).toBe(true);
    expect(previous.getAttribute("data-state")).toBe("closed");
    expect(next.hidden).toBe(false);
    expect(heard).toEqual([]);
    await tick();
    next.remove();
    await tick();
    expect(previous.hidden).toBe(false);
    expect(heard).toEqual([]);
    expect(pressEscape()).toBe(true);
  });

  it("reflects content replaced by an open subscriber before the show action returns", async () => {
    await mount();
    const previous = query("#tip");
    const next = fresh();
    query("#host").addEventListener("stimeo--tooltip:open", () => previous.replaceWith(next), {
      once: true,
    });
    controller().show();

    expect(next.hidden).toBe(false);
    expect(next.getAttribute("data-state")).toBe("open");
    expect(values(previous)).toEqual(["until-found", "authored"]);
    expect(heard).toEqual(["open"]);
    await tick();
    expect(pressEscape()).toBe(true);
  });

  it("resolves a same-task replacement when the pending show deadline expires", async () => {
    await mount('data-stimeo--tooltip-show-delay-value="200"');
    vi.useFakeTimers();
    controller().show();
    vi.advanceTimersByTime(100);
    const previous = query("#tip");
    const next = fresh();
    const atOpen: [boolean, string | null][] = [];
    query("#host").addEventListener("stimeo--tooltip:open", () => {
      atOpen.push([next.hasAttribute("hidden"), next.getAttribute("data-state")]);
    });
    previous.replaceWith(next);
    vi.advanceTimersByTime(100);

    expect(atOpen).toEqual([[false, "open"]]);
    expect(next.hidden).toBe(false);
    expect(next.getAttribute("data-state")).toBe("open");
    expect(values(previous)).toEqual(["until-found", "authored"]);
    expect(heard).toEqual(["open"]);
    expect(pressEscape()).toBe(true);
  });
});
