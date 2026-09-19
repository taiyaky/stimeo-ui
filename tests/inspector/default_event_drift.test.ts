import { Application, Controller } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { actionDescriptors } from "../../src/inspector/extract";
import { disconnectAndStopApplication } from "../helpers/stimulus";

/**
 * Pins the Inspector's default-event table against Stimulus itself.
 *
 * The table is a copy, so comparing it to hard-coded strings only restates the
 * copy. These cases bind a real `Application` to each host, fire every event the
 * table can name, and assert that the one Stimulus actually reacted to is the
 * one the reader predicts. A release that changes the upstream table therefore
 * fails here rather than silently teaching the reader something untrue.
 */

/** Every event the table can resolve to, so a wrong prediction cannot hide. */
const CANDIDATE_EVENTS = ["click", "submit", "toggle", "input", "change"] as const;

const heard: string[] = [];

class ProbeController extends Controller {
  hit(event: Event): void {
    heard.push(event.type);
  }
}

let application: Application | undefined;

/** The event Stimulus binds `data-action="probe#hit"` to on `markup`. */
async function boundEventFor(markup: string): Promise<string | undefined> {
  heard.length = 0;
  document.body.innerHTML = markup;
  application = Application.start();
  application.register("probe", ProbeController);
  await Promise.resolve();

  const host = document.body.firstElementChild as HTMLElement;
  for (const type of CANDIDATE_EVENTS) {
    host.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }
  return heard[0];
}

/** The event the reader predicts for the same host, read off the table. */
function predictedEventFor(tag: string, markup: string): string | undefined {
  // The reader skips controllers outside its namespace, so the prediction is
  // taken with a namespaced identifier on an otherwise identical host.
  return actionDescriptors("stimeo--otp#onInput", {
    tag: tag.replace(/\[.*$/, ""),
    inputType: /type="([^"]*)"/.exec(markup)?.[1],
  })[0]?.eventType;
}

afterEach(() => {
  if (application) disconnectAndStopApplication(application);
  application = undefined;
  document.body.innerHTML = "";
});

describe("default-event table, checked against Stimulus", () => {
  it.each([
    ["a", `<a href="#" data-controller="probe" data-action="probe#hit">x</a>`],
    ["button", `<button data-controller="probe" data-action="probe#hit">x</button>`],
    ["form", `<form data-controller="probe" data-action="probe#hit"></form>`],
    ["details", `<details data-controller="probe" data-action="probe#hit"></details>`],
    ["select", `<select data-controller="probe" data-action="probe#hit"></select>`],
    ["textarea", `<textarea data-controller="probe" data-action="probe#hit"></textarea>`],
    ["input", `<input data-controller="probe" data-action="probe#hit">`],
    ["input[type=submit]", `<input type="submit" data-controller="probe" data-action="probe#hit">`],
  ])("resolves %s to the event Stimulus binds", async (tag, markup) => {
    const bound = await boundEventFor(markup);
    expect(bound).toBeDefined();
    expect(predictedEventFor(tag, markup)).toBe(bound);
  });

  it("agrees with Stimulus that a type other than submit is an ordinary input", async () => {
    // Stimulus compares the attribute verbatim, so a capitalized `Submit` is
    // not the submit case; a reader that lowercased it would say `click`.
    expect(
      await boundEventFor(`<input type="Submit" data-controller="probe" data-action="probe#hit">`),
    ).toBe("input");
    expect(
      actionDescriptors("stimeo--otp#onInput", { tag: "input", inputType: "Submit" })[0]?.eventType,
    ).toBe("input");
  });

  it("agrees with Stimulus that a host outside the table binds nothing", async () => {
    expect(
      await boundEventFor(`<li data-controller="probe" data-action="probe#hit">x</li>`),
    ).toBeUndefined();
    expect(actionDescriptors("stimeo--menu#activate", { tag: "li" })[0]?.eventType).toBe("");
  });
});
