import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { DataGridController } from "../src/controllers/data_grid_controller";
import { press } from "./helpers/keyboard";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

const identifier = "stimeo--data-grid";
const token = `data-${identifier}-target`;
const watched = {
  header: ["aria-sort", "tabindex"],
  first: ["aria-selected"],
  a: ["tabindex"],
  second: ["aria-selected"],
  b: ["tabindex"],
  host: ["aria-multiselectable"],
};
const targets = { row: "first", cell: "a", columnHeader: "header" } as const;

/** A single-select grid whose selected row and active cell move away from authored state. */
const markup = (authored: boolean): string => `
  <table id="host" role="grid" aria-label="Users" data-controller="${identifier}"
    data-${identifier}-selection-value="single" ${authored ? 'aria-multiselectable="true"' : ""}>
    <thead><tr role="row"><th id="header" role="columnheader" ${token}="columnHeader"
      ${authored ? 'aria-sort="none" tabindex="-1"' : ""}
      data-action="click->${identifier}#sort keydown->${identifier}#onKeydown">Name</th></tr></thead>
    <tbody><tr id="first" role="row" data-value="1" ${token}="row" ${authored ? 'aria-selected="false"' : ""}>
      <td id="a" role="gridcell" ${token}="cell" ${authored ? 'tabindex="-1"' : ""}
        data-action="click->${identifier}#toggleSelect keydown->${identifier}#onKeydown">Ann</td></tr>
    <tr id="second" role="row" data-value="2" ${token}="row" ${authored ? 'aria-selected="true"' : ""}>
      <td id="b" role="gridcell" ${token}="cell" ${authored ? 'tabindex="0"' : ""}
        data-action="keydown->${identifier}#onKeydown">Jane</td></tr></tbody>
  </table>`;

/** Finds retained cells even while the whole grid is outside the document. */
const element = (root: ParentNode, id: string): HTMLElement => {
  if (root instanceof HTMLElement && root.id === id) return root;
  const found = root.querySelector<HTMLElement>(`#${id}`);
  if (!found) throw new Error(`Missing #${id}`);
  return found;
};

/** Retains absence separately from an authored empty attribute. */
const snapshot = (root: ParentNode): Record<string, Record<string, string | null>> =>
  Object.fromEntries(
    Object.entries(watched).map(([id, names]) => [
      id,
      Object.fromEntries(names.map((name) => [name, element(root, id).getAttribute(name)])),
    ]),
  );

/** Departed rows, cells and headers hand back their borrowed semantic state. */
describe("DataGridController departed attributes", () => {
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
    application.register(identifier, DataGridController);
    await tick();
    element(document, "header").click();
    element(document, "a").click();
    press(element(document, "b"), "ArrowUp");
    await tick();
    if (restored)
      application = await restoreFromCache(application, (next) =>
        next.register(identifier, DataGridController),
      );
    return { host: element(document, "host"), original };
  };

  for (const authored of [true, false]) {
    for (const restored of [false, true]) {
      describe(`${authored ? "authored" : "absent"}, ${restored ? "cache copy" : "live"}`, () => {
        it.each(Object.keys(targets) as Array<keyof typeof targets>)(
          "returns a %s after its target token leaves",
          async (target) => {
            const { host, original } = await mount(authored, restored);
            const id = targets[target];
            const departing = element(host, id);
            const events = captureStateEvents(
              identifier,
              ["selectionchange", "sort", "reconcile"],
              host,
            );
            departing.removeAttribute(token);
            await tick();
            expect(snapshot(host)[id]).toEqual(original[id]);
            expect(departing.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(
              false,
            );
            expect(events.names()).toEqual(target === "row" ? ["reconcile"] : []);
            expect(
              Array.from(
                host.querySelectorAll<HTMLElement>(
                  `[${token}~="cell"], [${token}~="columnHeader"]`,
                ),
              ).filter((cell) => cell.tabIndex === 0),
            ).toHaveLength(1);
          },
        );

        it("returns all attributes after the controller identifier leaves", async () => {
          const { host, original } = await mount(authored, restored);
          const events = captureStateEvents(
            identifier,
            ["selectionchange", "sort", "reconcile"],
            host,
          );
          host.removeAttribute("data-controller");
          await tick();
          expect(snapshot(host)).toEqual(original);
          expect(host.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(false);
          for (const child of host.querySelectorAll<HTMLElement>("*"))
            expect(child.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(false);
          expect(events.seen).toEqual([]);
        });

        it.each(Object.keys(targets) as Array<keyof typeof targets>)(
          "keeps selection, sort and the stop when a %s moves in-scope",
          async (target) => {
            const { host } = await mount(authored, restored);
            const before = snapshot(host);
            const events = captureStateEvents(
              identifier,
              ["selectionchange", "sort", "reconcile"],
              host,
            );
            const moving = element(host, targets[target]);
            moving.parentElement?.insertBefore(moving, moving.nextSibling);
            await tick();
            expect(snapshot(host)).toEqual(before);
            expect(events.seen).toEqual([]);
          },
        );

        it("keeps current state and authored originals through whole-root detach and reconnect", async () => {
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
      it.each(Object.keys(targets) as Array<keyof typeof targets>)(
        `preserves page writes on a %s after ${departure}, cache copy: ${restored}`,
        async (target) => {
          const { host } = await mount(true, restored);
          const departing = element(host, targets[target]);
          const edits: Record<string, string> =
            target === "row"
              ? { "aria-selected": "page" }
              : target === "cell"
                ? { tabindex: "7" }
                : { "aria-sort": "other", tabindex: "7" };
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

  it("keeps a page's multiselectable value when the controller identifier leaves", async () => {
    const { host } = await mount(true, false);
    host.setAttribute("aria-multiselectable", "page");
    host.removeAttribute("data-controller");
    await tick();
    expect(host.getAttribute("aria-multiselectable")).toBe("page");
  });
});
