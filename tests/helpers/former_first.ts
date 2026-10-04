import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disconnectAndStopApplication, restoreFromCache } from "./stimulus";
import { tick } from "./timing";

/**
 * A singular target that stopped being the first, on the live page and on a page Turbo
 * restores from its cache.
 *
 * A component writes its state onto the first of its singular targets and leaves a former
 * first as it is until that element stops being a target, when it gives the element back what
 * the author wrote. A page Turbo restores is a copy of the live page, so the former first
 * arrives carrying the value the component wrote and the record of the author's value, and
 * the connection that adopts the copy never wrote that element. Each case authors the target
 * with a value the component replaces on connect, puts a fresh copy of it ahead, and then drops
 * the former first's target token, on the live page and on a restored copy of it.
 */
export interface FormerFirstCase {
  readonly identifier: string;
  readonly controller: ControllerConstructor;
  /** The markup; the element that stops being the first carries `id="former"`. */
  readonly markup: string;
  readonly target: string;
  /** The attributes the component writes on the target. */
  readonly attributes: readonly string[];
  /** The label regions inside the target whose `hidden` the component writes. */
  readonly regions?: string;
  /** `false` keeps the authored target first: it carries the values the component wrote last. */
  readonly ahead?: boolean;
  /** Prepares what the component needs before it connects. */
  readonly setup?: () => void;
  /** Brings the component into the state whose values the case follows. */
  readonly arrange?: (controller: Record<string, unknown>) => void | Promise<void>;
}

/** A host element of the controller `stimeo--<id>`, holding `inner`; `attrs` adds its Values. */
export const host = (id: string, inner: string, attrs = "") =>
  `<div data-controller="stimeo--${id}" ${attrs}>${inner}</div>`;

/** Option `n` of the listbox of the controller `stimeo--<id>`. */
export const option = (id: string, n: number) =>
  `<li id="${id}-opt-${n}" role="option" data-value="v${n}" data-stimeo--${id}-target="option">Option ${n}</li>`;

/**
 * Runs every case twice, once on the page that stays and once on a page restored from the
 * cache, and expects the former first to carry what its author wrote, and no record.
 */
export function describeFormerFirst(cases: readonly (readonly [string, FormerFirstCase])[]): void {
  describe("a singular target that stopped being the first", () => {
    let application: Application;
    const records = (element: Element, identifier: string): string[] =>
      element
        .getAttributeNames()
        .filter(
          (name) =>
            name.startsWith(`data-${identifier}-`) &&
            /-(lease|hidden-region|tabindex-loan)$/.test(name),
        );
    const facts = (element: Element, item: FormerFirstCase) => ({
      ...Object.fromEntries(item.attributes.map((name) => [name, element.getAttribute(name)])),
      regions: item.regions
        ? Array.from(element.querySelectorAll(item.regions), (region) =>
            region.getAttribute("hidden"),
          )
        : [],
    });
    /** The records on `element` and, for a case with label regions, on those regions. */
    const recordsOf = (element: Element, item: FormerFirstCase): string[] => [
      ...records(element, item.identifier),
      ...(item.regions
        ? Array.from(element.querySelectorAll(item.regions), (region) =>
            records(region, item.identifier),
          ).flat()
        : []),
    ];

    afterEach(() => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = "";
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    /**
     * Connects `item`, takes its target to the state it writes, puts a fresh copy ahead of the
     * element authored first, optionally restores a copy of the page, and drops the former
     * first's target token. Returns the former first, its authored facts and its facts now.
     */
    async function succeed(item: FormerFirstCase, restore: boolean) {
      const { identifier, controller: Controller, target } = item;
      document.body.innerHTML = item.markup;
      const authoredFormer = document.getElementById("former") as HTMLElement;
      const authored = facts(authoredFormer, item);
      const fresh = authoredFormer.cloneNode(true) as HTMLElement;
      fresh.id = "ahead";
      for (const node of fresh.querySelectorAll("[id]")) node.id = `${node.id}-ahead`;
      item.setup?.();
      application = Application.start();
      application.register(identifier, Controller);
      await tick();
      const instance = () => {
        const element = document.querySelector(`[data-controller~="${identifier}"]`) as HTMLElement;
        return application.getControllerForElementAndIdentifier(
          element,
          identifier,
        ) as unknown as Record<string, unknown>;
      };
      const callback = (name: string, element: Element) => {
        const controller = instance();
        const method = controller[name];
        if (typeof method === "function") method.call(controller, element);
      };
      await item.arrange?.(instance());
      await tick();
      const written = document.getElementById("former") as HTMLElement;
      expect(recordsOf(written, item)).not.toEqual([]);

      if (item.ahead !== false) {
        written.before(fresh);
        await tick();
        callback(`${target}TargetConnected`, fresh);
      }
      if (restore) {
        application = await restoreFromCache(application, (restored) =>
          restored.register(identifier, Controller),
        );
      }
      const former = document.getElementById("former") as HTMLElement;
      const attribute = `data-${identifier}-target`;
      const tokens = (former.getAttribute(attribute) ?? "")
        .split(/\s+/)
        .filter((token) => token !== "" && token !== target);
      if (tokens.length > 0) former.setAttribute(attribute, tokens.join(" "));
      else former.removeAttribute(attribute);
      await tick();
      callback(`${target}TargetDisconnected`, former);
      return { former, authored, now: facts(former, item) };
    }

    describe.each(cases)("%s", (_name, item) => {
      it("gets what its author wrote back once it stops being a target, on the page that stays", async () => {
        const { former, authored, now } = await succeed(item, false);

        expect(now).toEqual(authored);
        expect(recordsOf(former, item)).toEqual([]);
      });

      it("gets what its author wrote back once it stops being a target, on a page restored from the cache", async () => {
        const { former, authored, now } = await succeed(item, true);

        expect(now).toEqual(authored);
        expect(recordsOf(former, item)).toEqual([]);
      });
    });
  });
}
