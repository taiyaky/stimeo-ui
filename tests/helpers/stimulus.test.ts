import { Application, Controller } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { disconnectAndStopApplication, reconnectKeepingFocus } from "./stimulus";
import { tick } from "./timing";

class TrackingController extends Controller {
  static override targets = ["item"];
  static override values = { state: String };

  declare stateValue: string;
  disconnectCount = 0;
  itemConnectedCount = 0;
  stateChangeCount = 0;

  override disconnect(): void {
    this.disconnectCount += 1;
  }

  stateValueChanged(): void {
    this.stateChangeCount += 1;
  }

  itemTargetConnected(): void {
    this.itemConnectedCount += 1;
  }
}

class SecondaryTrackingController extends TrackingController {}

describe("disconnectAndStopApplication", () => {
  let application: Application | undefined;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("disconnects every controller context before stopping the application", async () => {
    document.body.innerHTML = `
      <div id="tracking-first" data-controller="tracking"
           data-tracking-state-value="first"></div>
      <div id="tracking-second" data-controller="tracking"
           data-tracking-state-value="second"></div>
      <div id="secondary" data-controller="secondary"></div>`;
    const startedApplication = Application.start();
    application = startedApplication;
    startedApplication.register("tracking", TrackingController);
    startedApplication.register("secondary", SecondaryTrackingController);
    await tick();

    const contexts = [
      ["#tracking-first", "tracking"],
      ["#tracking-second", "tracking"],
      ["#secondary", "secondary"],
    ] as const;
    const instances = contexts.map(([selector, identifier]) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`tracking fixture missing: ${selector}`);
      return startedApplication.getControllerForElementAndIdentifier(
        element,
        identifier,
      ) as TrackingController | null;
    });
    expect(instances.every((instance) => instance instanceof TrackingController)).toBe(true);

    disconnectAndStopApplication(startedApplication);

    expect(instances.map((instance) => instance?.disconnectCount)).toEqual([1, 1, 1]);
    expect(startedApplication.controllers).toEqual([]);
  });

  it("stops Stimulus value and target observation with the controller context", async () => {
    document.body.innerHTML = `
      <div data-controller="tracking" data-tracking-state-value="initial"></div>`;
    application = Application.start();
    application.register("tracking", TrackingController);
    await tick();

    const element = document.querySelector<HTMLElement>("[data-controller='tracking']");
    if (!element) throw new Error("tracking fixture missing");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "tracking",
    ) as TrackingController | null;
    if (!instance) throw new Error("tracking controller missing");
    const changesBeforeTeardown = instance.stateChangeCount;
    const targetsBeforeTeardown = instance.itemConnectedCount;

    disconnectAndStopApplication(application);
    element.setAttribute("data-tracking-state-value", "after-teardown");
    element.insertAdjacentHTML("beforeend", `<span data-tracking-target="item"></span>`);
    await tick();

    expect(instance.disconnectCount).toBe(1);
    expect(instance.stateChangeCount).toBe(changesBeforeTeardown);
    expect(instance.itemConnectedCount).toBe(targetsBeforeTeardown);
  });

  it("is idempotent when teardown is requested twice", async () => {
    document.body.innerHTML = `<div data-controller="tracking"></div>`;
    application = Application.start();
    application.register("tracking", TrackingController);
    await tick();

    const element = document.querySelector<HTMLElement>("[data-controller='tracking']");
    if (!element) throw new Error("tracking fixture missing");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "tracking",
    ) as TrackingController | null;
    if (!instance) throw new Error("tracking controller missing");

    disconnectAndStopApplication(application);
    disconnectAndStopApplication(application);

    expect(instance.disconnectCount).toBe(1);
    expect(application.controllers).toEqual([]);
  });
});

class ReconnectLogController extends Controller {
  static override targets = ["item"];
  static override values = { state: String, mode: { type: String, default: "plain" } };

  declare stateValue: string;
  declare modeValue: string;
  readonly log: string[] = [];

  override connect(): void {
    this.log.push("connect");
  }

  override disconnect(): void {
    this.log.push("disconnect");
  }

  stateValueChanged(value: string): void {
    this.log.push(`state:${value}`);
  }

  modeValueChanged(value: string): void {
    this.log.push(`mode:${value}`);
  }

  itemTargetConnected(element: Element): void {
    this.log.push(`+${element.id}`);
  }

  itemTargetDisconnected(element: Element): void {
    this.log.push(`-${element.id}`);
  }
}

describe("reconnectKeepingFocus", () => {
  let application: Application | undefined;

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("reconnects the same instance in one turn, with the batch's Values ahead of connect", async () => {
    document.body.innerHTML = `
      <div data-controller="log" data-log-state-value="before">
        <input id="kept" data-log-target="item">
      </div>`;
    application = Application.start();
    application.register("log", ReconnectLogController);
    await tick();
    const element = document.querySelector<HTMLElement>("[data-controller='log']");
    const kept = document.getElementById("kept");
    if (!element || !kept) throw new Error("log fixture missing");
    const instance = application.getControllerForElementAndIdentifier(
      element,
      "log",
    ) as ReconnectLogController;
    kept.focus();
    instance.log.length = 0;

    reconnectKeepingFocus(instance, () => {
      element.setAttribute("data-log-state-value", "after");
      element.insertAdjacentHTML("afterbegin", `<input id="added" data-log-target="item">`);
    });

    expect(instance.log).toEqual([
      "disconnect",
      "-kept",
      "state:after",
      "mode:plain",
      "+added",
      "+kept",
      "connect",
    ]);
    expect(document.activeElement).toBe(kept);
    await tick();
    expect(instance.log).toHaveLength(7);
    expect(application.getControllerForElementAndIdentifier(element, "log")).toBe(instance);
  });
});
