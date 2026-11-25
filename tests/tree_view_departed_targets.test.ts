import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { TreeViewController } from "../src/controllers/tree_view_controller";
import { press } from "./helpers/keyboard";
import { captureStateEvents } from "./helpers/state_events";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

const identifier = "stimeo--tree-view";
const token = `data-${identifier}-target`;
const watched = {
  parent: ["aria-selected", "tabindex", "aria-expanded"],
  child: ["aria-selected", "tabindex"],
  sibling: ["aria-selected", "tabindex"],
  group: ["hidden"],
};

/** A selectable parent and group whose initial attributes may be absent. */
const markup = (authored: boolean): string => `
  <ul id="host" role="tree" aria-label="Files" data-controller="${identifier}">
    <li id="parent" role="treeitem" data-value="src" ${token}="item"
      ${authored ? 'aria-expanded="false" aria-selected="false" tabindex="-1"' : ""}
      data-action="click->${identifier}#select keydown->${identifier}#onKeydown">src
      <ul id="group" role="group" ${token}="group" ${authored ? "hidden" : ""}>
        <li id="child" role="treeitem" data-value="child" ${token}="item"
          ${authored ? 'aria-selected="false" tabindex="-1"' : ""}>Child</li>
      </ul>
    </li>
    <li id="sibling" role="treeitem" data-value="readme" ${token}="item"
      ${authored ? 'aria-selected="true" tabindex="0"' : ""}
      data-action="click->${identifier}#select">README</li>
    <input id="field" type="hidden" ${token}="field">
  </ul>`;

/** Finds a retained node after either its token or the whole root leaves. */
const element = (root: ParentNode, id: string): HTMLElement => {
  const found = root.querySelector<HTMLElement>(`#${id}`);
  if (!found) throw new Error(`Missing #${id}`);
  return found;
};

/** Captures raw values, including absent and authored empty attributes. */
const snapshot = (root: ParentNode): Record<string, Record<string, string | null>> =>
  Object.fromEntries(
    Object.entries(watched).map(([id, names]) => [
      id,
      Object.fromEntries(names.map((name) => [name, element(root, id).getAttribute(name)])),
    ]),
  );

/** Attribute ownership survives copies and moves without changing tree selection policy. */
describe("TreeViewController departed attributes", () => {
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
    application.register(identifier, TreeViewController);
    await tick();
    const parent = element(document, "parent");
    parent.click();
    press(parent, authored ? "ArrowRight" : "ArrowLeft");
    await tick();
    if (restored) {
      application = await restoreFromCache(application, (next) =>
        next.register(identifier, TreeViewController),
      );
    }
    return { host: element(document, "host"), original };
  };

  it("moves the Tab stop off a child hidden by returning the group's authored state", async () => {
    const { host } = await mount(true, false);
    const parent = element(host, "parent");
    const child = element(host, "child");
    const group = element(host, "group");
    const outside = document.createElement("button");
    outside.type = "button";
    document.body.append(outside);
    parent.focus();
    press(parent, "ArrowRight");
    expect(document.activeElement).toBe(child);
    expect(child.tabIndex).toBe(0);
    outside.focus();
    await tick();

    group.removeAttribute(token);
    await tick();

    expect(group.hidden).toBe(true);
    expect(child.tabIndex).toBe(-1);
    expect(parent.tabIndex).toBe(0);
    expect(document.activeElement).toBe(outside);
  });

  for (const authored of [true, false]) {
    for (const restored of [false, true]) {
      describe(`${authored ? "authored" : "absent"}, ${restored ? "cache copy" : "live"}`, () => {
        it.each(["item", "group"] as const)(
          "returns a %s after its target token leaves",
          async (target) => {
            const { host, original } = await mount(authored, restored);
            const id = target === "item" ? "parent" : "group";
            const departing = element(host, id);
            const events = captureStateEvents(identifier, ["select", "toggle", "reconcile"], host);
            departing.removeAttribute(token);
            await tick();
            expect(snapshot(host)[id]).toEqual(original[id]);
            expect(departing.getAttributeNames().some((name) => name.endsWith("-lease"))).toBe(
              false,
            );
            expect(events.names()).toEqual(target === "item" ? ["reconcile"] : []);
            if (target === "item")
              expect((element(host, "field") as HTMLInputElement).value).toBe("");
            element(host, "sibling").click();
            await tick();
            expect(snapshot(host)[id]).toEqual(original[id]);
          },
        );

        it("returns every target's attributes after the controller identifier leaves", async () => {
          const { host, original } = await mount(authored, restored);
          const events = captureStateEvents(identifier, ["select", "toggle", "reconcile"], host);
          host.removeAttribute("data-controller");
          await tick();
          expect(snapshot(host)).toEqual(original);
          expect(
            host.querySelector(
              "[data-stimeo--tree-view-aria-selected-lease], [data-stimeo--tree-view-tabindex-lease], [data-stimeo--tree-view-aria-expanded-lease], [data-stimeo--tree-view-hidden-lease]",
            ),
          ).toBeNull();
          expect(events.seen).toEqual([]);
        });

        it.each(["item", "group"] as const)(
          "keeps selection, expansion and the stop when a %s moves in-scope",
          async (target) => {
            const { host } = await mount(authored, restored);
            const moving = element(host, target === "item" ? "parent" : "group");
            const before = snapshot(host);
            const events = captureStateEvents(identifier, ["select", "toggle", "reconcile"], host);
            moving.parentElement?.insertBefore(moving, moving.nextSibling);
            await tick();
            expect(snapshot(host)).toEqual(before);
            expect((element(host, "field") as HTMLInputElement).value).toBe("src");
            expect(events.seen).toEqual([]);
          },
        );

        it("keeps state and borrowed originals through whole-root detach and reconnect", async () => {
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
      it.each(["item", "group"] as const)(
        `preserves page writes on a %s after ${departure}, cache copy: ${restored}`,
        async (target) => {
          const { host } = await mount(true, restored);
          const departing = element(host, target === "item" ? "parent" : "group");
          const edits: Record<string, string> =
            target === "item"
              ? { "aria-selected": "page", "aria-expanded": "page", tabindex: "7" }
              : { hidden: "page" };
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

  it("keeps an initially role-only group's authored visibility across a cache copy", async () => {
    document.body.innerHTML = markup(true).replace(`${token}="group"`, "");
    application = Application.start();
    application.register(identifier, TreeViewController);
    await tick();
    press(element(document, "parent"), "ArrowRight");
    expect(element(document, "group").hidden).toBe(true);
    application = await restoreFromCache(application, (next) =>
      next.register(identifier, TreeViewController),
    );
    const host = element(document, "host");
    const group = element(host, "group");
    expect(group.hidden).toBe(true);
    expect(group.hasAttribute("data-stimeo--tree-view-hidden-lease")).toBe(false);
    group.hidden = false;
    press(element(host, "parent"), "ArrowRight");
    expect(document.activeElement).toBe(element(host, "child"));
  });

  it("reads a role-only group for navigation while leaving its hidden attribute to the page", async () => {
    const { host } = await mount(true, false);
    const group = element(host, "group");
    group.removeAttribute(token);
    await tick();
    expect(group.hidden).toBe(true);
    press(element(host, "parent"), "ArrowLeft");
    press(element(host, "parent"), "ArrowRight");
    expect(element(host, "parent").getAttribute("aria-expanded")).toBe("true");
    expect(group.hidden).toBe(true);

    group.setAttribute(token, "group");
    await tick();
    expect(group.hidden).toBe(false);
    group.removeAttribute(token);
    await tick();
    expect(group.hidden).toBe(true);
  });
});
