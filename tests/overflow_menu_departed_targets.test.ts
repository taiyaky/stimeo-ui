import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { OverflowMenuController } from "../src/controllers/overflow_menu_controller";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

const identifier = "stimeo--overflow-menu";
const token = `data-${identifier}-target`;

/** The wrapper may start visible; banking is driven only by measured widths. */
const markup = (authored: boolean): string => `
  <nav id="host" data-controller="${identifier}" aria-label="Actions">
    <div id="items" ${token}="items">
      <button id="save" type="button">Save</button><button id="share" type="button">Share</button>
    </div>
    <div id="more" ${token}="more" ${authored ? "hidden" : ""}>
      <button id="trigger" type="button" aria-haspopup="menu" aria-expanded="false"
        data-stimeo--menu-target="trigger">More</button>
      <div id="menu" role="menu" aria-labelledby="trigger" data-stimeo--menu-target="menu" hidden></div>
    </div>
  </nav>`;

/** Finds retained nodes while their host is outside the document. */
const element = (root: ParentNode, id: string): HTMLElement => {
  if (root instanceof HTMLElement && root.id === id) return root;
  const found = root.querySelector<HTMLElement>(`#${id}`);
  if (!found) throw new Error(`Missing #${id}`);
  return found;
};

/** Supplies actual positive width budgets without relying on happy-dom's absent layout. */
const geometry = (overflowing: boolean): void => {
  Object.defineProperty(element(document, "host"), "clientWidth", {
    configurable: true,
    value: overflowing ? 180 : 500,
  });
  for (const id of ["save", "share"])
    Object.defineProperty(element(document, id), "offsetWidth", { configurable: true, value: 100 });
  Object.defineProperty(element(document, "trigger"), "offsetWidth", {
    configurable: true,
    value: 50,
  });
};

/** Captures placement and menu semantics as well as the wrapper's raw hidden value. */
const snapshot = (host: HTMLElement) => {
  const more = element(host, "more");
  const share = element(host, "share");
  return {
    hidden: more.getAttribute("hidden"),
    parent: share.parentElement?.id,
    role: share.getAttribute("role"),
    tabindex: share.getAttribute("tabindex"),
    menuTarget: share.getAttribute("data-stimeo--menu-target"),
    banked: share.getAttribute(`data-${identifier}-banked`),
    overflowing: host.getAttribute("data-overflowing"),
    count: host.getAttribute("data-overflow-count"),
  };
};

/** Wrapper ownership is returned on departure and banked contents survive a whole-root detach. */
describe("OverflowMenuController departed attributes", () => {
  let application: Application | undefined;
  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });
  const mount = async (authored: boolean, overflowing: boolean, restored: boolean) => {
    document.body.innerHTML = markup(authored);
    const original = element(document, "more").getAttribute("hidden");
    geometry(overflowing);
    application = Application.start();
    application.register(identifier, OverflowMenuController);
    await tick();
    if (restored)
      application = await restoreFromCache(application, (next) => {
        geometry(overflowing);
        next.register(identifier, OverflowMenuController);
      });
    return { host: element(document, "host"), original };
  };

  for (const authored of [true, false]) {
    for (const overflowing of [false, true]) {
      for (const restored of [false, true]) {
        describe(`${authored ? "hidden" : "visible"} author, ${overflowing ? "overflowing" : "fitting"}, ${restored ? "cache copy" : "live"}`, () => {
          it.each(["token", "identifier"] as const)(
            "returns authored visibility after %s departure",
            async (departure) => {
              const { host, original } = await mount(authored, overflowing, restored);
              const more = element(host, "more");
              const events = captureStateEvents(identifier, ["change", "reconcile"], host);
              if (departure === "token") more.removeAttribute(token);
              else host.removeAttribute("data-controller");
              await tick();
              expect(more.getAttribute("hidden")).toBe(original);
              expect(more.hasAttribute(`data-${identifier}-hidden-lease`)).toBe(false);
              expect(element(host, "share").parentElement).toBe(element(host, "items"));
              expect(element(host, "share").getAttribute("role")).toBeNull();
              expect(element(host, "share").getAttribute("tabindex")).toBeNull();
              expect(events.seen).toEqual([]);
            },
          );

          it("keeps wrapper visibility and banked contents through an in-scope move", async () => {
            const { host } = await mount(authored, overflowing, restored);
            const before = snapshot(host);
            const moving = element(host, "more");
            const events = captureStateEvents(identifier, ["change", "reconcile"], host);
            moving.parentElement?.insertBefore(moving, moving.nextSibling);
            await tick();
            expect(snapshot(host)).toEqual(before);
            expect(events.seen).toEqual([]);
          });

          it("keeps banked state through whole-root detach and retains originals on reconnect", async () => {
            const { host, original } = await mount(authored, overflowing, restored);
            const before = snapshot(host);
            host.remove();
            await tick();
            expect(snapshot(host)).toEqual(before);
            document.body.append(host);
            await tick();
            expect(snapshot(host)).toEqual(before);
            host.removeAttribute("data-controller");
            await tick();
            expect(element(host, "more").getAttribute("hidden")).toBe(original);
            expect(element(host, "share").parentElement).toBe(element(host, "items"));
          });
        });
      }
    }
  }

  it("returns a visible authored wrapper when this controller stops in place", async () => {
    const { host } = await mount(false, false, false);
    const controller = application?.getControllerForElementAndIdentifier(host, identifier);
    if (!(controller instanceof OverflowMenuController)) throw new Error("Missing controller");
    expect(element(host, "more").hidden).toBe(true);
    controller.disconnect();
    expect(element(host, "more").hasAttribute("hidden")).toBe(false);
  });

  it("returns an old wrapper after an immediate update already balanced its successor", async () => {
    const { host } = await mount(false, false, false);
    const former = element(host, "more");
    const successor = former.cloneNode(true) as HTMLElement;
    successor.id = "successor";
    for (const child of successor.querySelectorAll<HTMLElement>("[id]")) {
      child.id = `successor-${child.id}`;
    }
    successor.querySelector('[role="menu"]')?.setAttribute("aria-labelledby", "successor-trigger");
    former.after(successor);
    former.removeAttribute(token);
    const controller = application?.getControllerForElementAndIdentifier(host, identifier);
    if (!(controller instanceof OverflowMenuController)) throw new Error("Missing controller");
    controller.update();
    await tick();
    expect(former.hasAttribute("hidden")).toBe(false);
    expect(former.hasAttribute(`data-${identifier}-hidden-lease`)).toBe(false);
    expect(successor.hidden).toBe(true);
  });

  it("keeps an open More menu while its wrapper moves within the same scope", async () => {
    const { host } = await mount(true, true, false);
    const moving = element(host, "more");
    element(host, "menu").hidden = false;
    element(host, "trigger").setAttribute("aria-expanded", "true");
    moving.parentElement?.insertBefore(moving, moving.nextSibling);
    await tick();
    expect(element(host, "menu").hidden).toBe(false);
    expect(element(host, "trigger").getAttribute("aria-expanded")).toBe("true");
    expect(element(host, "share").parentElement).toBe(element(host, "menu"));
  });

  for (const overflowing of [false, true]) {
    for (const restored of [false, true]) {
      it.each(["token", "identifier"] as const)(
        `preserves a page's hidden value after %s, overflow: ${overflowing}, cache: ${restored}`,
        async (departure) => {
          const { host } = await mount(true, overflowing, restored);
          const more = element(host, "more");
          more.setAttribute("hidden", "page");
          if (departure === "token") more.removeAttribute(token);
          else host.removeAttribute("data-controller");
          await tick();
          expect(more.getAttribute("hidden")).toBe("page");
          expect(more.hasAttribute(`data-${identifier}-hidden-lease`)).toBe(false);
        },
      );
    }
  }
});
