import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MenubarController } from "../src/controllers/menubar_controller";
import { press } from "./helpers/keyboard";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

const identifier = "stimeo--menubar";
const targetAttribute = `data-${identifier}-target`;
const watched = {
  file: ["tabindex", "aria-expanded"],
  "m-file": ["hidden"],
  edit: ["tabindex", "aria-expanded"],
  "m-edit": ["hidden"],
} as const;

/** A popup pair whose initial attributes can all be absent or explicitly authored. */
const markup = (authored: boolean): string => `
  <div id="host" data-controller="${identifier}" role="menubar" aria-label="Main">
    <button id="file" role="menuitem" aria-haspopup="menu" aria-controls="m-file"
      ${authored ? 'tabindex="-1" aria-expanded="false"' : ""}
      ${targetAttribute}="top" data-action="click->${identifier}#toggle">File</button>
    <ul id="m-file" role="menu" aria-label="File" ${authored ? "hidden" : ""}
      ${targetAttribute}="menu">
      <li role="none"><button id="new" role="menuitem" tabindex="-1"
        ${targetAttribute}="item">New</button></li>
    </ul>
    <button id="edit" role="menuitem" aria-haspopup="menu" aria-controls="m-edit"
      ${authored ? 'tabindex="0" aria-expanded="false"' : ""}
      ${targetAttribute}="top" data-action="click->${identifier}#toggle">Edit</button>
    <ul id="m-edit" role="menu" aria-label="Edit" ${authored ? "hidden" : ""}
      ${targetAttribute}="menu">
      <li role="none"><button role="menuitem" tabindex="-1"
        ${targetAttribute}="item">Undo</button></li>
    </ul>
  </div>`;

/** Returns a retained target, including after its host leaves the document. */
const requireElement = (root: ParentNode, id: string): HTMLElement => {
  const element = root.querySelector<HTMLElement>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

/** Captures both absence and authored empty strings for the owned attributes. */
const snapshot = (root: ParentNode): Record<string, Record<string, string | null>> =>
  Object.fromEntries(
    Object.entries(watched).map(([id, attributes]) => [
      id,
      Object.fromEntries(
        attributes.map((name) => [name, requireElement(root, id).getAttribute(name)]),
      ),
    ]),
  );

/** Ownership follows targets through token changes, scope moves, detaches and cache copies. */
describe("MenubarController departed attributes", () => {
  let application: Application | undefined;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
  });

  const mount = async (authored: boolean, restored: boolean) => {
    document.body.innerHTML = markup(authored);
    const original = snapshot(document);
    application = Application.start();
    application.register(identifier, MenubarController);
    await tick();
    requireElement(document, "file").click();
    await tick();
    if (restored) {
      application = await restoreFromCache(application, (next) =>
        next.register(identifier, MenubarController),
      );
      requireElement(document, "file").click();
      await tick();
    }
    return { host: requireElement(document, "host"), original };
  };

  for (const authored of [true, false]) {
    for (const restored of [false, true]) {
      describe(`${authored ? "authored" : "absent"} attributes, ${restored ? "cache copy" : "live"}`, () => {
        it.each(["top", "menu"] as const)(
          "returns a departed %s's attributes after its token leaves",
          async (target) => {
            const { host, original } = await mount(authored, restored);
            const id = target === "top" ? "file" : "m-file";
            const departed = requireElement(host, id);
            const events = captureStateEvents(identifier, ["open", "close"], host);
            departed.removeAttribute(targetAttribute);
            await tick();

            expect(snapshot(host)[id]).toEqual(original[id]);
            expect(departed.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(
              false,
            );
            expect(events.seen).toEqual([]);
            expect(requireElement(host, "file").getAttribute("aria-expanded")).toBe(
              target === "top" ? original.file?.["aria-expanded"] : "false",
            );
            if (target === "top") expect(requireElement(host, "m-file").hidden).toBe(true);
            const destination = requireElement(host, target === "top" ? "edit" : "file");
            expect(destination.tabIndex).toBe(0);
            expect(document.activeElement).toBe(destination);
            expect(press(destination, "Escape").defaultPrevented).toBe(false);
          },
        );

        it("returns every target's attributes after the controller identifier leaves", async () => {
          const { host, original } = await mount(authored, restored);
          const events = captureStateEvents(identifier, ["open", "close"], host);
          host.removeAttribute("data-controller");
          await tick();

          expect(snapshot(host)).toEqual(original);
          expect(
            host.querySelector(
              "[data-stimeo--menubar-tabindex-lease], [data-stimeo--menubar-aria-expanded-lease], [data-stimeo--menubar-hidden-lease]",
            ),
          ).toBeNull();
          expect(events.seen).toEqual([]);
          expect(press(requireElement(host, "file"), "Escape").defaultPrevented).toBe(false);
        });

        it.each(["top", "menu"] as const)(
          "keeps an open %s and its tab stop through an in-scope move",
          async (target) => {
            const { host } = await mount(authored, restored);
            const before = snapshot(host);
            const events = captureStateEvents(identifier, ["open", "close"], host);
            const moving = requireElement(host, target === "top" ? "file" : "m-file");
            moving.parentElement?.insertBefore(moving, moving.nextSibling);
            await tick();

            expect(snapshot(host)).toEqual(before);
            expect(requireElement(host, "m-file").hidden).toBe(false);
            if (target === "top") {
              expect(document.activeElement).toBe(requireElement(host, "new"));
            }
            expect(events.seen).toEqual([]);
            expect(press(requireElement(host, "new"), "Escape").defaultPrevented).toBe(true);
            expect(requireElement(host, "m-file").hidden).toBe(true);
            expect(document.activeElement).toBe(requireElement(host, "file"));
          },
        );

        it("keeps target attributes while the whole root is detached", async () => {
          const { host, original } = await mount(authored, restored);
          const before = snapshot(host);
          host.remove();
          await tick();

          expect(snapshot(host)).toEqual(before);
          document.body.append(host);
          await tick();
          expect(requireElement(host, "file").tabIndex).toBe(0);
          expect(requireElement(host, "m-file").hidden).toBe(true);
          host.removeAttribute("data-controller");
          await tick();
          expect(snapshot(host)).toEqual(original);
        });
      });
    }
  }

  it("keeps a noninitial active top's stop across an in-scope move", async () => {
    const { host } = await mount(false, false);
    const moving = requireElement(host, "edit");
    moving.click();
    await tick();
    const before = snapshot(host);
    expect(moving.tabIndex).toBe(0);
    expect(requireElement(host, "file").tabIndex).toBe(-1);

    moving.parentElement?.insertBefore(moving, moving.nextSibling);
    await tick();

    expect(snapshot(host)).toEqual(before);
    expect(requireElement(host, "m-edit").hidden).toBe(false);
  });

  it("initializes a returning top without stealing the surviving tab stop", async () => {
    const { host } = await mount(false, false);
    const returning = requireElement(host, "file");
    returning.removeAttribute(targetAttribute);
    await tick();
    expect(requireElement(host, "edit").tabIndex).toBe(0);
    expect(returning.getAttribute("tabindex")).toBeNull();

    returning.setAttribute(targetAttribute, "top");
    await tick();

    expect(returning.tabIndex).toBe(-1);
    expect(requireElement(host, "edit").tabIndex).toBe(0);
    expect(requireElement(host, "m-file").hidden).toBe(true);
  });

  for (const restored of [false, true]) {
    for (const departure of ["token", "identifier"] as const) {
      it.each(["top", "menu"] as const)(
        `preserves page writes on a %s after ${departure} departure, cache copy: ${restored}`,
        async (target) => {
          const { host } = await mount(true, restored);
          const element = requireElement(host, target === "top" ? "file" : "m-file");
          const edits: Record<string, string> =
            target === "top" ? { tabindex: "7", "aria-expanded": "page" } : { hidden: "page" };
          for (const [name, value] of Object.entries(edits)) element.setAttribute(name, value);
          if (departure === "token") element.removeAttribute(targetAttribute);
          else host.removeAttribute("data-controller");
          await tick();

          for (const [name, value] of Object.entries(edits)) {
            expect(element.getAttribute(name)).toBe(value);
          }
          expect(element.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(false);
        },
      );
    }
  }
});
