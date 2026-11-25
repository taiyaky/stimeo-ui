import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { TabsController } from "../src/controllers/tabs_controller";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

const identifier = "stimeo--tabs";
const token = `data-${identifier}-target`;
const watched = {
  first: ["aria-selected", "tabindex"],
  second: ["aria-selected", "tabindex"],
  a: ["hidden"],
  b: ["hidden"],
};

/** Tabs whose initial attribute presence is independent of the selected state after interaction. */
const markup = (authored: boolean): string => `
  <div id="host" data-controller="${identifier}">
    <div role="tablist" aria-label="Sections" ${token}="list">
      <button id="first" role="tab" aria-controls="a" ${token}="tab"
        ${authored ? 'aria-selected="true" tabindex="0"' : ""}
        data-action="click->${identifier}#select">First</button>
      <button id="second" role="tab" aria-controls="b" ${token}="tab"
        ${authored ? 'aria-selected="false" tabindex="-1"' : ""}
        data-action="click->${identifier}#select">Second</button>
    </div>
    <div id="a" role="tabpanel" aria-labelledby="first" ${token}="panel">A</div>
    <div id="b" role="tabpanel" aria-labelledby="second" ${token}="panel" ${authored ? "hidden" : ""}>B</div>
  </div>`;

/** Finds a retained node without requiring its host to remain connected. */
const element = (root: ParentNode, id: string): HTMLElement => {
  const found = root.querySelector<HTMLElement>(`#${id}`);
  if (!found) throw new Error(`Missing #${id}`);
  return found;
};

/** Captures raw attributes so absence and an authored empty value remain distinct. */
const snapshot = (root: ParentNode): Record<string, Record<string, string | null>> =>
  Object.fromEntries(
    Object.entries(watched).map(([id, names]) => [
      id,
      Object.fromEntries(names.map((name) => [name, element(root, id).getAttribute(name)])),
    ]),
  );

/** A departed tab or panel returns only the attributes the tabs controller borrowed. */
describe("TabsController departed attributes", () => {
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
    application.register(identifier, TabsController);
    await tick();
    element(document, "second").click();
    await tick();
    if (restored) {
      application = await restoreFromCache(application, (next) =>
        next.register(identifier, TabsController),
      );
    }
    return { host: element(document, "host"), original };
  };

  for (const authored of [true, false]) {
    for (const restored of [false, true]) {
      describe(`${authored ? "authored" : "absent"}, ${restored ? "cache copy" : "live"}`, () => {
        it.each(["tab", "panel"] as const)(
          "returns a %s after its target token leaves",
          async (target) => {
            const { host, original } = await mount(authored, restored);
            const id = target === "tab" ? "first" : "a";
            const departing = element(host, id);
            const events = captureStateEvents(identifier, ["change"], host);
            departing.removeAttribute(token);
            await tick();
            expect(snapshot(host)[id]).toEqual(original[id]);
            expect(departing.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(
              false,
            );
            expect(element(host, "second").getAttribute("aria-selected")).toBe("true");
            expect(element(host, "second").tabIndex).toBe(0);
            expect(events.seen).toEqual([]);
          },
        );

        it("returns all attributes after the controller identifier leaves", async () => {
          const { host, original } = await mount(authored, restored);
          const events = captureStateEvents(identifier, ["change"], host);
          host.removeAttribute("data-controller");
          await tick();
          expect(snapshot(host)).toEqual(original);
          expect(
            host.querySelector(
              "[data-stimeo--tabs-aria-selected-lease], [data-stimeo--tabs-tabindex-lease], [data-stimeo--tabs-hidden-lease]",
            ),
          ).toBeNull();
          expect(events.seen).toEqual([]);
        });

        it.each(["tab", "panel"] as const)(
          "keeps selection when a %s moves within the scope",
          async (target) => {
            const { host } = await mount(authored, restored);
            const moving = element(host, target === "tab" ? "second" : "b");
            const before = snapshot(host);
            const events = captureStateEvents(identifier, ["change"], host);
            moving.parentElement?.insertBefore(moving, moving.nextSibling);
            await tick();
            expect(snapshot(host)).toEqual(before);
            expect(events.seen).toEqual([]);
          },
        );

        it("keeps selection and borrowed originals through whole-root detach and reconnect", async () => {
          const { host, original } = await mount(authored, restored);
          const before = snapshot(host);
          host.remove();
          await tick();
          expect(snapshot(host)).toEqual(before);
          document.body.append(host);
          await tick();
          expect(snapshot(host)).toEqual(before);
          host.removeAttribute("data-controller");
          await tick();
          expect(snapshot(host)).toEqual(original);
        });
      });
    }
  }

  for (const restored of [false, true]) {
    for (const departure of ["token", "identifier"] as const) {
      it.each(["tab", "panel"] as const)(
        `preserves page writes on a %s after ${departure}, cache copy: ${restored}`,
        async (target) => {
          const { host } = await mount(true, restored);
          const departing = element(host, target === "tab" ? "first" : "a");
          const edits: Record<string, string> =
            target === "tab" ? { "aria-selected": "page", tabindex: "7" } : { hidden: "page" };
          for (const [name, value] of Object.entries(edits)) departing.setAttribute(name, value);
          if (departure === "token") departing.removeAttribute(token);
          else host.removeAttribute("data-controller");
          await tick();
          for (const [name, value] of Object.entries(edits))
            expect(departing.getAttribute(name)).toBe(value);
          expect(departing.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(false);
        },
      );
    }
  }
});
