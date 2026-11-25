import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarController } from "../src/controllers/calendar_controller";
import { AttributeLease } from "../src/utils/attribute_lease";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

const cells = () =>
  Array.from({ length: 42 }, (_, index) => {
    const authored =
      index === 0
        ? 'aria-selected="authored-selection" tabindex="7" data-date="authored-date" data-outside="authored-outside" data-today="authored-today"'
        : 'tabindex="6"';
    return `<td id="day-${index}" role="gridcell" data-stimeo--calendar-target="day" ${authored}></td>`;
  }).join("");

const markup = () => `
  <div id="source"><section id="calendar" data-controller="stimeo--calendar"
       data-stimeo--calendar-month-value="2026-05"
       data-stimeo--calendar-selected-value="2026-05-15">
    <span data-stimeo--calendar-target="label"></span>
    <table role="grid"><tbody data-stimeo--calendar-target="grid">${cells()}</tbody></table>
  </section></div>`;

describe("Calendar day attribute leases", () => {
  let application: Application | undefined;

  const start = async () => {
    document.body.innerHTML = markup();
    application = Application.start();
    application.register("stimeo--calendar", CalendarController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    application = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("returns authored day attributes when its target marker leaves", async () => {
    await start();
    const day = document.getElementById("day-0") as HTMLElement;

    day.removeAttribute("data-stimeo--calendar-target");
    await tick();

    expect(day.getAttribute("aria-selected")).toBe("authored-selection");
    expect(day.getAttribute("tabindex")).toBe("7");
    expect(day.getAttribute("data-date")).toBe("authored-date");
    expect(day.getAttribute("data-outside")).toBe("authored-outside");
    expect(day.getAttribute("data-today")).toBe("authored-today");
    expect(day.hasAttribute("data-stimeo--calendar-data-date-lease")).toBe(false);
  });

  it("returns all day attributes when the controller identifier leaves", async () => {
    await start();
    const root = document.getElementById("calendar") as HTMLElement;
    const day = document.getElementById("day-0") as HTMLElement;
    const days = Array.from(document.querySelectorAll<HTMLElement>("[id^='day-']"));

    root.removeAttribute("data-controller");
    await tick();

    expect(day.getAttribute("aria-selected")).toBe("authored-selection");
    expect(day.getAttribute("tabindex")).toBe("7");
    expect(day.getAttribute("data-date")).toBe("authored-date");
    expect(day.getAttribute("data-outside")).toBe("authored-outside");
    expect(day.getAttribute("data-today")).toBe("authored-today");
    for (const lease of ["aria-selected", "tabindex", "data-date", "data-outside", "data-today"]) {
      expect(days.every((cell) => !cell.hasAttribute(`data-stimeo--calendar-${lease}-lease`))).toBe(
        true,
      );
    }
  });

  it("returns day leases written before the target is observed when the identifier leaves", async () => {
    await start();
    const root = document.getElementById("calendar") as HTMLElement;
    const previous = document.getElementById("day-0") as HTMLElement;
    const template = document.createElement("template");
    template.innerHTML = markup();
    const day = template.content.querySelector<HTMLElement>("#day-0");
    const selected = root.querySelector<HTMLElement>('[data-date="2026-05-16"]');
    const calendar = application?.getControllerForElementAndIdentifier(root, "stimeo--calendar");
    if (!(calendar instanceof CalendarController) || !day || !selected) {
      throw new Error("Calendar fixture missing");
    }
    const attributes = ["aria-selected", "tabindex", "data-date", "data-outside", "data-today"];
    const authored = attributes.map(
      (attribute) => [attribute, day.getAttribute(attribute)] as const,
    );

    previous.replaceWith(day);
    calendar.select(selected);
    expect(root.querySelectorAll('[data-stimeo--calendar-target="day"]')).toHaveLength(42);
    for (const [attribute, value] of authored) {
      expect(day.getAttribute(attribute)).not.toBe(value);
      expect(day.hasAttribute(`data-stimeo--calendar-${attribute}-lease`)).toBe(true);
    }
    root.removeAttribute("data-controller");
    await tick();

    expect(day.isConnected).toBe(true);
    for (const [attribute, value] of authored) {
      expect(day.getAttribute(attribute)).toBe(value);
      expect(day.hasAttribute(`data-stimeo--calendar-${attribute}-lease`)).toBe(false);
    }
  });

  it("keeps day leases when a target moves within its controller scope", async () => {
    await start();
    const root = document.getElementById("calendar") as HTMLElement;
    const day = document.getElementById("day-0") as HTMLElement;
    const marker = "data-stimeo--calendar-data-date-lease";
    const returnLease = vi.spyOn(AttributeLease.prototype, "return");

    root.append(day);
    await tick();

    expect(day.hasAttribute(marker)).toBe(true);
    expect(returnLease.mock.calls.some(([element]) => element === day)).toBe(false);
  });

  it("keeps day leases when its controller moves within the page", async () => {
    await start();
    const root = document.getElementById("calendar") as HTMLElement;
    const day = document.getElementById("day-0") as HTMLElement;
    const marker = "data-stimeo--calendar-data-date-lease";
    const returnLease = vi.spyOn(AttributeLease.prototype, "return");
    const destination = document.createElement("aside");
    document.body.append(destination);
    destination.append(root);
    await tick();

    expect(day.hasAttribute(marker)).toBe(true);
    expect(root.isConnected).toBe(true);
    expect(returnLease.mock.calls.some(([element]) => element === day)).toBe(false);
  });
});
