import { afterEach, describe, expect, it } from "vitest";
import { captureSpeech } from "./speech";

/**
 * Self-tests for the layer ③ speech-order helper: it must capture the ordered
 * announcement sequence (role + accessible name) and reliably stop the reader.
 */
describe("speech helper", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("captures role and name in document order", async () => {
    document.body.innerHTML = `
      <button type="button">Save</button>
      <a href="/help">Help</a>`;
    const log = await captureSpeech({ steps: 2 });

    expect(log).toContain("button, Save");
    expect(log.some((phrase) => phrase.includes("Help"))).toBe(true);
  });

  it("reflects ARIA state in the spoken phrase", async () => {
    document.body.innerHTML = `
      <button type="button" aria-expanded="false" aria-controls="m">Menu</button>`;
    const log = await captureSpeech({ steps: 1 });

    expect(
      log.some((phrase) => phrase.includes("not expanded") || phrase.includes("collapsed")),
    ).toBe(true);
  });

  it("auto-traverses to the end when no step count is given", async () => {
    document.body.innerHTML = `<button type="button">Only</button>`;
    const log = await captureSpeech();

    expect(log.some((phrase) => phrase.includes("Only"))).toBe(true);
  });

  it("captures all elements via explicit steps even when phrases repeat", async () => {
    // Documents the recommended pattern: adjacent identical announcements would
    // truncate auto-traverse, so regression tests pass an explicit `steps` count.
    document.body.innerHTML = `
      <button type="button">Delete</button>
      <button type="button">Delete</button>
      <button type="button">Archive</button>`;
    const log = await captureSpeech({ steps: 3 });

    expect(log.filter((phrase) => phrase === "button, Delete")).toHaveLength(2);
    expect(log).toContain("button, Archive");
  });

  it("scopes the reader to the given container", async () => {
    document.body.innerHTML = `
      <div id="outside"><button type="button">Outside</button></div>
      <div id="scope"><button type="button">Inside</button></div>`;
    const scope = document.getElementById("scope");
    if (!scope) throw new Error("scope not found");

    const log = await captureSpeech({ container: scope, steps: 1 });
    expect(log.some((phrase) => phrase.includes("Inside"))).toBe(true);
    expect(log.some((phrase) => phrase.includes("Outside"))).toBe(false);
  });
});
