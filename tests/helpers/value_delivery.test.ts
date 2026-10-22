import { Application, Controller } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query } from "./dom";
import { disconnectAndStopApplication } from "./stimulus";
import { tick } from "./timing";
import { writeValueAttribute } from "./value_delivery";

/** Records every `delay` Stimulus delivers to it. */
class DeliveryProbeController extends Controller {
  static override values = { delay: Number };

  declare delayValue: number;
  readonly delivered: number[] = [];

  delayValueChanged(): void {
    this.delivered.push(this.delayValue);
  }
}

/** Applies every `delay` Stimulus delivers to it in a microtask its callback queues. */
class DeferredProbeController extends Controller {
  static override values = { delay: Number };

  declare delayValue: number;
  readonly applied: number[] = [];

  delayValueChanged(): void {
    const delay = this.delayValue;
    queueMicrotask(() => this.applied.push(delay));
  }
}

/**
 * Pins what the suites that rewrite a declaration lean on: the Value callback has not run
 * when the attribute is written, it and a microtask it queues have run when the helper
 * resolves, and the wait moves no mocked timer.
 */
describe("writeValueAttribute", () => {
  const ATTRIBUTE = "data-delivery-probe-delay-value";
  let application: Application;

  const host = () => query("[data-controller='delivery-probe']");
  const probe = () =>
    application.getControllerForElementAndIdentifier(
      host(),
      "delivery-probe",
    ) as DeliveryProbeController;

  beforeEach(async () => {
    document.body.innerHTML = `<div data-controller="delivery-probe" ${ATTRIBUTE}="100"></div>`;
    application = Application.start();
    application.register("delivery-probe", DeliveryProbeController);
    await tick();
  });

  afterEach(() => {
    vi.useRealTimers();
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("resolves after Stimulus has run the Value callback for the write", async () => {
    expect(probe().delivered).toEqual([100]);

    const written = writeValueAttribute(host(), ATTRIBUTE, "250");
    expect(host().getAttribute(ATTRIBUTE)).toBe("250");
    expect(probe().delivered).toEqual([100]);

    await written;
    expect(probe().delivered).toEqual([100, 250]);
  });

  it("resolves after a microtask the Value callback queues has run", async () => {
    const DEFERRED = "data-deferred-probe-delay-value";
    application.register("deferred-probe", DeferredProbeController);
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div data-controller="deferred-probe" ${DEFERRED}="100"></div>`,
    );
    await tick();
    const element = query("[data-controller='deferred-probe']");
    const deferred = application.getControllerForElementAndIdentifier(
      element,
      "deferred-probe",
    ) as DeferredProbeController;
    expect(deferred.applied).toEqual([100]);

    await writeValueAttribute(element, DEFERRED, "250");
    expect(deferred.applied).toEqual([100, 250]);
  });

  it("resolves under the mocked clock without moving it", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const now = Date.now();
    setTimeout(() => fired.push("due now"), 0);

    await writeValueAttribute(host(), ATTRIBUTE, "250");

    expect(probe().delivered).toEqual([100, 250]);
    expect(fired).toEqual([]);
    expect(Date.now()).toBe(now);
  });

  it("resolves for a write that leaves the attribute as it was", async () => {
    await writeValueAttribute(host(), ATTRIBUTE, "100");
    expect(probe().delivered).toEqual([100]);
  });
});
