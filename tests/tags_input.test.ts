import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { TagsInputController } from "../src/controllers/tags_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TagsInputController}: commit on Enter/delimiter,
 * empty/duplicate/max rejection, Backspace deletion, chip roving navigation,
 * hidden-field mirroring, focus hand-off, and the `change`/`reject` events.
 */

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
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const root = () =>
    document.querySelector<HTMLElement>("[data-controller='stimeo--tags-input']") as HTMLElement;
  const controller = () =>
    application.getControllerForElementAndIdentifier(
      root(),
      "stimeo--tags-input",
    ) as TagsInputController;
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

  it("reverses the horizontal arrows under RTL, in the input and across the chips", async () => {
    // Logical direction: the chips are an ordered row, and the input
    // sits at its logical end, so the key that reaches back into the chips
    // reverses too. Both handlers read the same element on purpose.
    await mount();
    const root = document.querySelector("[data-controller='stimeo--tags-input']") as HTMLElement;
    root.style.direction = "rtl";
    type("React", "Enter");
    type("Rails", "Enter");
    expect(buttons().length).toBe(2);
    input().value = "";

    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[1]); // reaches back into the chips

    buttons()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[0]); // "previous chip"

    buttons()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(buttons()[0]); // guarded at the first chip
  });

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

  it("does not commit on the Enter that confirms an IME composition", async () => {
    await mount();
    input().value = "ぎじゅつ";
    // The Enter that confirms an IME candidate carries isComposing=true; it must
    // only confirm the IME, never commit the tag.
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(tags()).toHaveLength(0);
    expect(input().value).toBe("ぎじゅつ");
    // A subsequent real Enter (composition finished) commits it.
    type("ぎじゅつ", "Enter");
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["ぎじゅつ"]);
  });

  it("ignores an unflagged Enter until the composition lifecycle ends", async () => {
    await mount();
    input().value = "やまだ";
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tags()).toHaveLength(0);

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    type("やまだ", "Enter");
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["やまだ"]);
  });

  it("clears composition state across disconnect and reconnect", async () => {
    await mount();
    input().value = "日本語";
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    controller().disconnect();
    controller().connect();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(tags().map((tag) => tag.dataset.value)).toEqual(["日本語"]);
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

  it("leaves a modified arrow to the browser (Alt+Left/Right is history navigation)", async () => {
    // A modified arrow belongs to the browser, not the widget: the empty input
    // does not reach back into the chips.
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    input().value = "";
    input().focus();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    input().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(buttons()[1]?.tabIndex).toBe(-1); // the roving stop stayed on the first chip
  });

  it("yields an input key an enclosing widget already consumed", async () => {
    // The claim comes from a capture-phase handler because the binding is on the
    // INPUT, which has no children. The chip strip is guarded separately; this
    // is the input side.
    await mount();
    const root = document.querySelector("[data-controller='stimeo--tags-input']") as HTMLElement;
    root.addEventListener("keydown", (event) => event.preventDefault(), { capture: true });
    input().value = "React";

    const claimed = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const notCanceled = input().dispatchEvent(claimed);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(tags()).toHaveLength(0); // no tag committed
  });

  it("leaves a modified chip arrow to the browser (Alt+Left/Right is history navigation)", async () => {
    // A modified arrow belongs to the browser, not the widget: the chip strip
    // neither consumes it nor moves its single Tab stop.
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    const first = buttons()[0] as HTMLButtonElement;
    first.focus();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    first.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(0); // the roving stop did not move
  });

  it("yields a chip key a descendant widget already consumed", async () => {
    // Chips render from the consumer's template, so an arbitrary widget can live
    // inside one. A key it claimed must not ALSO move the chip focus.
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    const inner = document.createElement("span");
    buttons()[0]?.append(inner);
    inner.addEventListener("keydown", (event) => event.preventDefault());
    buttons()[0]?.focus();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    const notCanceled = inner.dispatchEvent(event);

    expect(notCanceled).toBe(false); // the claim really took (a non-cancelable event would not)
    expect(document.activeElement).toBe(buttons()[0]);
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
