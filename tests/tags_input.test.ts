import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { TagsInputController } from "../src/controllers/tags_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";

/**
 * Behavioral tests for {@link TagsInputController}: commit on Enter/delimiter,
 * empty/duplicate/max rejection, Backspace deletion, chip roving navigation,
 * hidden-field mirroring, focus hand-off, and the `change`/`reject` events.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const markup = (attrs = "") => `
  <div data-controller="stimeo--tags-input" ${attrs}>
    <ul role="list" aria-label="Tags" data-stimeo--tags-input-target="tags"></ul>
    <input type="text" aria-label="Add tag" aria-describedby="tags-help"
           data-stimeo--tags-input-target="input"
           data-action="keydown->stimeo--tags-input#onKeydown" />
    <span id="tags-help" hidden>Add a tag with Enter or comma</span>
    <span role="status" aria-live="polite" class="visually-hidden"
          data-stimeo--tags-input-target="status"></span>
    <div data-stimeo--tags-input-target="fields"></div>
    <template data-stimeo--tags-input-target="tagTemplate">
      <li role="listitem" data-stimeo--tags-input-target="tag">
        <span data-tags-input-slot="label"></span>
        <button type="button" tabindex="-1">×</button>
      </li>
    </template>
  </div>`;

describe("TagsInputController", () => {
  let application: Application;

  const mount = async (attrs = "") => {
    document.body.innerHTML = markup(attrs);
    application = Application.start();
    application.register("stimeo--tags-input", TagsInputController);
    await tick();
  };

  afterEach(() => {
    application.stop();
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--tags-input']") as HTMLElement;
  const input = () =>
    document.querySelector<HTMLInputElement>(
      "[data-stimeo--tags-input-target='input']",
    ) as HTMLInputElement;
  const tags = () =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-stimeo--tags-input-target='tag']"));
  const fields = () =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        "[data-stimeo--tags-input-target='fields'] input",
      ),
    );
  const buttons = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "[data-stimeo--tags-input-target='tags'] button",
      ),
    );
  const type = (value: string, key: string) => {
    input().value = value;
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  };

  it("commits a tag on Enter and clears the input", async () => {
    await mount();
    type("React", "Enter");
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["React"]);
    expect(input().value).toBe("");
    expect(buttons()[0]?.getAttribute("aria-label")).toBe("Remove React");
  });

  it("commits a tag on the configured delimiter", async () => {
    await mount();
    type("Vue", ",");
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["Vue"]);
  });

  it("mirrors tags into hidden fields with the configured name", async () => {
    await mount('data-stimeo--tags-input-name-value="frameworks[]"');
    type("React", "Enter");
    type("Svelte", "Enter");
    expect(fields().map((field) => field.value)).toEqual(["React", "Svelte"]);
    expect(fields().every((field) => field.name === "frameworks[]")).toBe(true);
  });

  it("rejects empty, duplicate, and over-limit additions", async () => {
    await mount('data-stimeo--tags-input-max-value="2"');
    const rejects: Array<{ value: string; reason: string }> = [];
    root().addEventListener("stimeo--tags-input:reject", (event) => {
      rejects.push((event as CustomEvent).detail);
    });
    type("   ", "Enter"); // empty
    type("React", "Enter");
    type("React", "Enter"); // duplicate
    type("Vue", "Enter");
    type("Svelte", "Enter"); // exceeds max 2
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["React", "Vue"]);
    expect(rejects.map((reject) => reject.reason)).toEqual(["empty", "duplicate", "max"]);
    expect(root().hasAttribute("data-stimeo--tags-input-full")).toBe(true);
  });

  it("allows duplicates when configured", async () => {
    await mount('data-stimeo--tags-input-allow-duplicates-value="true"');
    type("React", "Enter");
    type("React", "Enter");
    expect(tags()).toHaveLength(2);
  });

  it("removes the last tag on Backspace when the input is empty", async () => {
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    input().value = "";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["React"]);
  });

  it("removes a tag by its button and moves focus to the neighbor", async () => {
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    type("Svelte", "Enter");
    buttons()[0]?.click(); // remove React -> focus the new first button (Vue)
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["Vue", "Svelte"]);
    expect(document.activeElement).toBe(buttons()[0]);
  });

  it("navigates chips with arrows and returns to the input past the end", async () => {
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    input().value = "";
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[1]); // last chip (Vue)
    buttons()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[0]);
    buttons()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[1]);
    buttons()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(input()); // past the end -> input
  });

  it("deletes the focused chip with Delete", async () => {
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    buttons()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["Vue"]);
  });

  it("dispatches change with the current tag set", async () => {
    await mount();
    const detents: string[][] = [];
    root().addEventListener("stimeo--tags-input:change", (event) => {
      detents.push((event as CustomEvent).detail.tags);
    });
    type("React", "Enter");
    type("Vue", "Enter");
    expect(detents).toEqual([["React"], ["React", "Vue"]]);
  });

  it("announces tag changes in the live region", async () => {
    await mount();
    type("React", "Enter");
    const status = document.querySelector<HTMLElement>("[data-stimeo--tags-input-target='status']");
    expect(status?.textContent).toBe("React");
  });

  it("has no machine-detectable a11y violations with tags present", async () => {
    await mount();
    type("React", "Enter");
    await expectNoA11yViolations(root());
  });

  it("announces the labeled input", async () => {
    await mount();
    const phrases = await captureSpeech({ container: root(), steps: 2 });
    expect(phrases).toEqual([
      "list, Tags",
      "textbox, Add tag, Add a tag with Enter or comma",
      "status",
    ]);
  });
});
