import { Application } from "@hotwired/stimulus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagsInputController } from "../src/controllers/tags_input_controller";
import { expectNoA11yViolations } from "./helpers/a11y";
import { captureSpeech } from "./helpers/speech";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { flushMicrotasks, tick } from "./helpers/timing";

/**
 * Behavioral tests for {@link TagsInputController}: commit on Enter/delimiter,
 * empty/duplicate/max rejection, Backspace deletion, chip roving navigation,
 * hidden-field mirroring, focus hand-off, and the `change`/`reject` events.
 */

const tagTemplate = `
    <template data-stimeo--tags-input-target="tagTemplate">
      <li role="listitem" data-stimeo--tags-input-target="tag">
        <span data-stimeo--tags-input-target="label"></span>
        <button type="button" tabindex="-1" aria-label="Remove {label}"
                data-stimeo--tags-input-target="remove">×</button>
      </li>
    </template>`;

const markup = (attrs = "", template = tagTemplate) => `
  <div data-controller="stimeo--tags-input" ${attrs}>
    <ul role="list" aria-label="Tags" data-stimeo--tags-input-target="tags"></ul>
    <input type="text" aria-label="Add tag" aria-describedby="tags-help"
           data-stimeo--tags-input-target="input"
           data-action="keydown->stimeo--tags-input#onKeydown" />
    <span id="tags-help" hidden>Add a tag with Enter or comma</span>
    <div data-stimeo--tags-input-target="fields"></div>
${template}
  </div>`;

describe("TagsInputController", () => {
  let application: Application;
  let announcements: Array<{ message: string; assertive: boolean }>;

  const onAnnouncement = (event: Event) => {
    announcements.push((event as CustomEvent).detail);
  };

  beforeEach(() => {
    announcements = [];
    window.addEventListener("stimeo--announcer:announce", onAnnouncement);
  });

  const mount = async (attrs = "", template = tagTemplate) => {
    document.body.innerHTML = markup(attrs, template);
    application = Application.start();
    application.register("stimeo--tags-input", TagsInputController);
    await tick();
  };

  afterEach(() => {
    window.removeEventListener("stimeo--announcer:announce", onAnnouncement);
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

  it("fills the authored localized remove-button name", async () => {
    await mount("", tagTemplate.replace("Remove {label}", "{label}を削除"));
    type("技術", "Enter");

    expect(buttons()[0]?.getAttribute("aria-label")).toBe("技術を削除");
  });

  // The chip row is where a committed tag lives, so a field without one commits
  // nothing at all — quietly, since there is no chip to report a problem on.
  it("commits nothing when the tag row target is absent", async () => {
    document.body.innerHTML = markup().replace('data-stimeo--tags-input-target="tags"', "");
    application = Application.start();
    application.register("stimeo--tags-input", TagsInputController);
    await tick();
    const handleError = vi.spyOn(application, "handleError").mockImplementation(() => {});
    const changes: string[][] = [];
    root().addEventListener("stimeo--tags-input:change", (event) => {
      changes.push((event as CustomEvent).detail.tags);
    });

    type("React", "Enter");

    expect(tags()).toEqual([]);
    expect(changes).toEqual([]);
    // The entry survives, so the author can still see what was typed.
    expect(input().value).toBe("React");
    expect(handleError).not.toHaveBeenCalled();
  });

  it.each([
    ["tag template", "", '"tagTemplate" target'],
    [
      "tag element",
      `<template data-stimeo--tags-input-target="tagTemplate">
        <span data-stimeo--tags-input-target="label"></span>
        <button type="button" aria-label="Remove {label}"
                data-stimeo--tags-input-target="remove">×</button>
      </template>`,
      '"tag" target',
    ],
    [
      "label slot",
      `<template data-stimeo--tags-input-target="tagTemplate">
        <li data-stimeo--tags-input-target="tag">
          <button type="button" aria-label="Remove {label}"
                  data-stimeo--tags-input-target="remove">×</button>
        </li>
      </template>`,
      '"label" target',
    ],
    [
      "remove button",
      `<template data-stimeo--tags-input-target="tagTemplate">
        <li data-stimeo--tags-input-target="tag">
          <span data-stimeo--tags-input-target="label"></span>
        </li>
      </template>`,
      '"remove" target <button>',
    ],
    [
      "remove-button name",
      `<template data-stimeo--tags-input-target="tagTemplate">
        <li data-stimeo--tags-input-target="tag">
          <span data-stimeo--tags-input-target="label"></span>
          <button type="button" data-stimeo--tags-input-target="remove">×</button>
        </li>
      </template>`,
      'non-empty aria-label on its "remove" target',
    ],
    [
      "non-empty remove-button name",
      `<template data-stimeo--tags-input-target="tagTemplate">
        <li data-stimeo--tags-input-target="tag">
          <span data-stimeo--tags-input-target="label"></span>
          <button type="button" aria-label="  "
                  data-stimeo--tags-input-target="remove">×</button>
        </li>
      </template>`,
      'non-empty aria-label on its "remove" target',
    ],
  ])(
    "preserves the input and warns the author without a valid %s",
    async (_part, template, missing) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await mount(
        'data-stimeo--tags-input-announce-text-value="Added {label}; {count} total"',
        template,
      );
      const changes: string[][] = [];
      root().addEventListener("stimeo--tags-input:change", (event) => {
        changes.push((event as CustomEvent<{ tags: string[] }>).detail.tags);
      });

      type("React", "Enter");
      // A second commit must not turn one authoring mistake into a console flood.
      type("Vue", "Enter");

      expect(tags()).toHaveLength(0);
      expect(input().value).toBe("Vue");
      expect(fields()).toHaveLength(0);
      expect(changes).toEqual([]);
      expect(announcements).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(missing);
      expect(warn.mock.calls[0]?.[0]).toContain("stimeo--tags-input");
      warn.mockRestore();
    },
  );

  it("re-arms the template warning for the next connection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mount("", "");

    type("React", "Enter");
    controller().disconnect();
    controller().connect();
    type("Vue", "Enter");

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
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

  it("re-arms composition observation after reconnect", async () => {
    await mount();
    controller().disconnect();
    controller().connect();
    input().value = "日本語";
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));

    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(tags()).toHaveLength(0);

    input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
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

  it("uses tags[] as the default hidden-field name", async () => {
    await mount();
    type("React", "Enter");

    expect(fields().map((field) => [field.name, field.value])).toEqual([["tags[]", "React"]]);
  });

  it("rebuilds hidden fields when name changes and when fields arrive at runtime", async () => {
    await mount();
    type("React", "Enter");
    const oldFields = root().querySelector<HTMLElement>(
      "[data-stimeo--tags-input-target='fields']",
    ) as HTMLElement;
    oldFields.remove();

    root().setAttribute("data-stimeo--tags-input-name-value", "frameworks[]");
    const replacement = document.createElement("div");
    replacement.setAttribute("data-stimeo--tags-input-target", "fields");
    root().append(replacement);
    await tick();

    expect(fields().map((field) => [field.name, field.value])).toEqual([["frameworks[]", "React"]]);
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
    expect(rejects).toEqual([
      { value: "", reason: "empty" },
      { value: "React", reason: "duplicate" },
      { value: "Svelte", reason: "max" },
    ]);
    expect(root().hasAttribute("data-stimeo--tags-input-full")).toBe(true);
  });

  it("allows duplicates when configured", async () => {
    await mount('data-stimeo--tags-input-allow-duplicates-value="true"');
    type("React", "Enter");
    type("React", "Enter");
    expect(tags()).toHaveLength(2);
  });

  it("removes the last tag on empty-input Backspace and keeps focus in the input", async () => {
    await mount();
    type("React", "Enter");
    type("Vue", "Enter");
    input().value = "";
    input().focus();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["React"]);
    expect(document.activeElement).toBe(input());

    type("Svelte", "Enter");
    expect(tags().map((tag) => tag.dataset.value)).toEqual(["React", "Svelte"]);
  });

  it("removes the full hook when the tag count drops below max", async () => {
    await mount('data-stimeo--tags-input-max-value="2"');
    type("React", "Enter");
    type("Vue", "Enter");
    expect(root().hasAttribute("data-stimeo--tags-input-full")).toBe(true);

    input().focus();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));

    expect(root().hasAttribute("data-stimeo--tags-input-full")).toBe(false);
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

  it("announces localized tag additions and removals through the shared announcer", async () => {
    await mount(
      'data-stimeo--tags-input-announce-text-value="Added {label}; {count} total" ' +
        'data-stimeo--tags-input-announce-removed-text-value="Removed {value}; {count} total"',
    );
    type("React", "Enter");
    buttons()[0]?.click();

    expect(announcements).toEqual([
      { message: "Added React; 1 total", assertive: false },
      { message: "Removed React; 0 total", assertive: false },
    ]);
  });

  it("stays silent when announcement templates are not authored", async () => {
    await mount();
    type("React", "Enter");
    buttons()[0]?.click();

    expect(announcements).toEqual([]);
  });

  it("rebinds chip interaction when the tags target is replaced", async () => {
    await mount();
    type("React", "Enter");
    const previous = root().querySelector<HTMLElement>(
      "[data-stimeo--tags-input-target='tags']",
    ) as HTMLElement;
    const replacement = document.createElement("ul");
    replacement.setAttribute("role", "list");
    replacement.setAttribute("aria-label", "Tags");
    replacement.setAttribute("data-stimeo--tags-input-target", "tags");
    replacement.innerHTML = `
      <li role="listitem" data-value="React" data-stimeo--tags-input-target="tag">
        <span data-stimeo--tags-input-target="label">React</span>
        <button type="button" tabindex="0" aria-label="Remove React"
                data-stimeo--tags-input-target="remove">×</button>
      </li>`;

    previous.replaceWith(replacement);
    await tick();
    replacement.querySelector<HTMLButtonElement>("button")?.click();

    expect(tags()).toEqual([]);
    expect(fields()).toEqual([]);
  });

  it("stops delegating safely when the tags target token is removed", async () => {
    await mount();
    type("React", "Enter");
    const row = root().querySelector<HTMLElement>(
      "[data-stimeo--tags-input-target='tags']",
    ) as HTMLElement;
    const remove = row.querySelector<HTMLButtonElement>("button") as HTMLButtonElement;

    row.removeAttribute("data-stimeo--tags-input-target");
    await tick();

    expect(() => remove.click()).not.toThrow();
    expect(remove.isConnected).toBe(true);
  });

  it("does not rebind a tags target after disconnect", async () => {
    await mount();
    type("React", "Enter");
    const row = root().querySelector<HTMLElement>(
      "[data-stimeo--tags-input-target='tags']",
    ) as HTMLElement;

    controller().disconnect();
    controller().tagsTargetConnected(row);
    buttons()[0]?.click();

    expect(tags().map((tag) => tag.dataset.value)).toEqual(["React"]);
  });

  it("reconciles externally-added and removed tags without emitting change", async () => {
    await mount('data-stimeo--tags-input-max-value="2"');
    type("React", "Enter");
    const changes: string[][] = [];
    const reconciles: string[][] = [];
    root().addEventListener("stimeo--tags-input:change", (event) => {
      changes.push((event as CustomEvent<{ tags: string[] }>).detail.tags);
    });
    root().addEventListener("stimeo--tags-input:reconcile", (event) => {
      reconciles.push((event as CustomEvent<{ tags: string[] }>).detail.tags);
    });
    const row = root().querySelector<HTMLElement>(
      "[data-stimeo--tags-input-target='tags']",
    ) as HTMLElement;
    const external = document.createElement("li");
    external.dataset.value = "Vue";
    external.setAttribute("data-stimeo--tags-input-target", "tag");
    external.innerHTML = `<span>Vue</span><button type="button" tabindex="-1">×</button>`;

    row.append(external);
    controller().tagTargetConnected(external);
    await flushMicrotasks();

    expect(fields().map((field) => [field.name, field.value])).toEqual([
      ["tags[]", "React"],
      ["tags[]", "Vue"],
    ]);
    expect(root().hasAttribute("data-stimeo--tags-input-full")).toBe(true);
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([["React", "Vue"]]);

    external.remove();
    controller().tagTargetDisconnected(external);
    await flushMicrotasks();

    expect(fields().map((field) => field.value)).toEqual(["React"]);
    expect(root().hasAttribute("data-stimeo--tags-input-full")).toBe(false);
    expect(changes).toEqual([]);
    expect(reconciles).toEqual([["React", "Vue"], ["React"]]);
  });

  it("coalesces derived-state repair and stays silent when the tag set is unchanged", async () => {
    await mount();
    type("React", "Enter");
    const reconciles: string[][] = [];
    root().addEventListener("stimeo--tags-input:reconcile", (event) => {
      reconciles.push((event as CustomEvent<{ tags: string[] }>).detail.tags);
    });
    fields()[0]?.remove();

    controller().fieldsTargetConnected();
    controller().nameValueChanged();
    controller().maxValueChanged();
    await flushMicrotasks();

    expect(fields().map((field) => [field.name, field.value])).toEqual([["tags[]", "React"]]);
    expect(reconciles).toEqual([]);
  });

  it("ignores key handling while the input target is absent", async () => {
    await mount();
    const detached = input();
    detached.remove();
    await tick();

    expect(() =>
      controller().onKeydown(new KeyboardEvent("keydown", { key: "Enter" })),
    ).not.toThrow();
    expect(tags()).toEqual([]);
  });

  it("ignores sibling buttons that are not declared tags", async () => {
    await mount();
    const row = root().querySelector<HTMLElement>(
      "[data-stimeo--tags-input-target='tags']",
    ) as HTMLElement;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear all";
    row.append(clear);
    type("React", "Enter");

    clear.click();
    clear.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
    );

    expect(tags().map((tag) => tag.dataset.value)).toEqual(["React"]);
  });

  it("delegates only to the declared remove target when a chip has another button", async () => {
    await mount(
      "",
      `<template data-stimeo--tags-input-target="tagTemplate">
        <li role="listitem" data-stimeo--tags-input-target="tag">
          <span data-stimeo--tags-input-target="label"></span>
          <button type="button" data-info>Info</button>
          <button type="button" aria-label="Remove {label}"
                  data-stimeo--tags-input-target="remove">×</button>
        </li>
      </template>`,
    );
    type("React", "Enter");
    const tag = tags()[0] as HTMLElement;
    const info = tag.querySelector<HTMLButtonElement>("button[data-info]") as HTMLButtonElement;
    const remove = tag.querySelector<HTMLButtonElement>(
      'button[data-stimeo--tags-input-target~="remove"]',
    ) as HTMLButtonElement;

    info.click();
    info.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
    );
    expect(tags().map((item) => item.dataset.value)).toEqual(["React"]);

    remove.click();
    expect(tags()).toEqual([]);
  });

  it("has no machine-detectable a11y violations with tags present", async () => {
    await mount();
    type("React", "Enter");
    await expectNoA11yViolations(root());
  });

  it("announces the labeled input", async () => {
    await mount();
    const phrases = await captureSpeech({ container: root(), steps: 1 });
    expect(phrases).toEqual(["list, Tags", "textbox, Add tag, Add a tag with Enter or comma"]);
  });
});
