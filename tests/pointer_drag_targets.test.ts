import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { PointerDragController } from "../src/controllers/pointer_drag_controller";
import { press } from "./helpers/keyboard";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

let application: Application | undefined;

afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

/** Mounts a current generic handle and records only the drag's public lifecycle. */
async function mount(): Promise<{ root: HTMLElement; handle: HTMLElement; reports: string[] }> {
  document.body.innerHTML =
    '<div id="drag" data-controller="stimeo--pointer-drag" role="group" aria-label="Move card"><div id="handle" role="button" aria-label="Move handle" data-stimeo--pointer-drag-target="handle">Handle</div></div>';
  const root = document.getElementById("drag");
  const handle = document.getElementById("handle");
  if (!root || !handle) throw new Error("Drag target fixture missing");
  const reports: string[] = [];
  for (const name of ["start", "move", "end", "cancel"])
    root.addEventListener(`stimeo--pointer-drag:${name}`, () => reports.push(name));
  application = Application.start();
  application.register("stimeo--pointer-drag", PointerDragController);
  await tick();
  return { root, handle, reports };
}

it("returns the keyboard handle contract to the root when its last declaration is removed", async () => {
  const { root, handle, reports } = await mount();
  handle.removeAttribute("data-stimeo--pointer-drag-target");
  await tick();
  expect(handle.hasAttribute("tabindex")).toBe(false);
  expect(root.getAttribute("tabindex")).toBe("0");
  expect(root.style.touchAction).toBe("none");
  press(root, " ");
  press(root, "ArrowRight");
  press(root, "Enter");
  expect(reports).toEqual(["start", "move", "end"]);
});

it("cancels the removed declaration's live grab once before the root owns a new gesture", async () => {
  const { root, handle, reports } = await mount();
  press(handle, " ");
  press(handle, "ArrowRight");
  handle.removeAttribute("data-stimeo--pointer-drag-target");
  await tick();
  expect(reports).toEqual(["start", "move", "cancel"]);
  expect(root.hasAttribute("data-grabbed")).toBe(false);
  expect(handle.hasAttribute("data-grabbed")).toBe(false);
  expect(root.getAttribute("tabindex")).toBe("0");
  press(root, "Enter");
  press(root, " ");
  expect(reports).toEqual(["start", "move", "cancel", "start", "end"]);
});

it("keeps a retained handle's moving session and leaves teardown with no root loan", async () => {
  const { root, handle, reports } = await mount();
  press(handle, " ");
  root.append(handle);
  await tick();
  press(handle, "ArrowRight");
  expect(reports).toEqual(["start", "move"]);
  expect(root.hasAttribute("tabindex")).toBe(false);
  root.removeAttribute("data-controller");
  handle.removeAttribute("data-stimeo--pointer-drag-target");
  await tick();
  expect(reports).toEqual(["start", "move", "cancel"]);
  expect(root.hasAttribute("tabindex")).toBe(false);
  expect(root.style.touchAction).toBe("");
});

for (const boundary of ["scope exit", "application unload"] as const) {
  it(`returns all handle loans when declaration removal coincides with ${boundary}`, async () => {
    document.body.innerHTML =
      '<main id="scope"><div id="drag" data-controller="stimeo--pointer-drag" role="group" aria-label="Move card"><div id="handle" data-stimeo--pointer-drag-target="handle">Handle</div></div></main><aside id="destination"></aside>';
    const scope = document.getElementById("scope");
    const root = document.getElementById("drag");
    const handle = document.getElementById("handle");
    const destination = document.getElementById("destination");
    if (!scope || !root || !handle || !destination) throw new Error("Scope fixture missing");
    application = Application.start(scope);
    application.register("stimeo--pointer-drag", PointerDragController);
    await tick();
    expect(
      application.getControllerForElementAndIdentifier(root, "stimeo--pointer-drag"),
    ).not.toBeNull();
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.style.touchAction).toBe("none");
    handle.removeAttribute("data-stimeo--pointer-drag-target");
    if (boundary === "scope exit") destination.append(root);
    else application.unload("stimeo--pointer-drag");
    await tick();
    expect(
      application.getControllerForElementAndIdentifier(root, "stimeo--pointer-drag"),
    ).toBeNull();
    expect(root.isConnected).toBe(true);
    expect(root.getAttribute("data-controller")).toBe("stimeo--pointer-drag");
    expect(handle.hasAttribute("tabindex")).toBe(false);
    expect(handle.style.touchAction).toBe("");
    expect(root.hasAttribute("tabindex")).toBe(false);
    expect(root.style.touchAction).toBe("");
  });
}
