import { runInNewContext } from "node:vm";
import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it, vi } from "vitest";
import { TimePickerController } from "../src/controllers/time_picker_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Uses native weak references while the shared setup pins observer callbacks. */
const NativeWeakRef = runInNewContext("WeakRef", Object.create(null)) as typeof WeakRef;
let application: Application | undefined;

afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Disconnects after an authored delivery, before its queued reconciliation can run. */
async function disconnectWithPendingAuthorship() {
  const BaseObserver = globalThis.MutationObserver;
  const authored = new WeakSet<MutationObserver>();
  let armed = false;
  let disconnected = false;
  vi.stubGlobal(
    "MutationObserver",
    class extends BaseObserver {
      constructor(callback: MutationCallback) {
        super((records, observer) => {
          callback(records, observer);
          if (!armed || !authored.has(observer)) return;
          armed = false;
          if (!application) throw new Error("The controller must be connected.");
          disconnectAndStopApplication(application);
          document.querySelector("#hour")?.remove();
          document.querySelector("#minute")?.remove();
          disconnected = true;
        });
      }

      override observe(target: Node, options?: MutationObserverInit): void {
        if (options?.attributeFilter?.join(",") === "aria-valuenow,data-segment") {
          authored.add(this);
        }
        super.observe(target, options);
      }
    },
  );
  document.body.innerHTML = `
    <div data-controller="stimeo--time-picker">
      <span id="hour" data-segment="hour" aria-valuenow="9"
            data-stimeo--time-picker-target="segment"></span>
      <span id="minute" data-segment="minute" aria-valuenow="30"
            data-stimeo--time-picker-target="segment"></span>
      <input type="hidden" data-stimeo--time-picker-target="field">
    </div>`;
  application = Application.start();
  application.register("stimeo--time-picker", TimePickerController);
  await tick();
  const controller = application.controllers[0];
  const hour = document.querySelector("#hour");
  const minute = document.querySelector("#minute");
  if (!controller || !hour || !minute) throw new Error("Missing connected fixture.");
  const target = new NativeWeakRef(hour);
  const control = new NativeWeakRef(minute);
  armed = true;
  hour.setAttribute("aria-valuenow", "10");
  await tick();
  expect(disconnected).toBe(true);
  return { controller, target, control };
}

it("releases pending authored segments while a disconnected controller remains retained", async () => {
  const probe = await disconnectWithPendingAuthorship();
  const free = (() => new NativeWeakRef({}))();
  const held = {};
  const heldReference = new NativeWeakRef(held);
  const runtime = globalThis as unknown as {
    Bun?: { gc?: (full: boolean) => void };
    gc?: () => void;
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    await tick();
    if (runtime.Bun?.gc) runtime.Bun.gc(true);
    else if (runtime.gc) runtime.gc();
    else throw new Error("This test requires explicit garbage-collection support.");
  }
  expect(free.deref()).toBeUndefined();
  expect(probe.control.deref()).toBeUndefined();
  expect(probe.target.deref()).toBeUndefined();
  expect(heldReference.deref()).toBe(held);
  expect(probe.controller.identifier).toBe("stimeo--time-picker");
});
