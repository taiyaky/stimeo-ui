import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneTemplateRoot, TemplateRow } from "../../src/utils/template_row";

/**
 * Behavioral tests for {@link cloneTemplateRoot} and {@link TemplateRow}: that a
 * clone carries the first element and nothing around it, that the row's parts
 * resolve in the caller's own namespace with the first missing one named, and
 * that an unusable template is reported once per connection.
 */
describe("template row", () => {
  const authored = (body: string): HTMLTemplateElement => {
    document.body.innerHTML = `<template>
      ${body}
    </template>`;
    return document.querySelector("template") as HTMLTemplateElement;
  };

  const CHIP = `<li data-stimeo--tags-input-target="tag">
        <span data-stimeo--tags-input-target="label"></span>
        <button type="button" aria-label="Remove {label}"
                data-stimeo--tags-input-target="remove">×</button>
      </li>`;

  const rows = () =>
    new TemplateRow({
      identifier: "stimeo--tags-input",
      root: "tag",
      required: ["label"],
      button: "remove",
      outcome: "added no tag",
      noun: "chip template",
    });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("clones the first element without the whitespace written around it", () => {
    const template = authored(CHIP);
    const list = document.createElement("ul");

    for (let i = 0; i < 3; i++) {
      const root = cloneTemplateRoot(template) as HTMLElement;
      expect(root.parentNode).toBeNull();
      list.append(root);
    }

    expect(list.children).toHaveLength(3);
    expect(list.childNodes).toHaveLength(3);
  });

  it("clones the first element only, leaving a second one behind", () => {
    const root = cloneTemplateRoot(authored(`<li id="first"></li><li id="second"></li>`));

    expect(root?.id).toBe("first");
    expect(root?.children).toHaveLength(0);
  });

  it("has no row to clone from content that holds no element", () => {
    expect(cloneTemplateRoot(authored("just text"))).toBeNull();
    expect(cloneTemplateRoot(authored(""))).toBeNull();
  });

  it("builds an independent row each time, leaving the template untouched", () => {
    const template = authored(CHIP);
    const row = rows();

    const first = row.instantiate(template, { label: "Apple" });
    const second = row.instantiate(template, { label: "Pear" });

    expect(first?.root).not.toBe(second?.root);
    expect(first?.slots.label).not.toBe(second?.slots.label);
    expect(
      template.content.firstElementChild?.querySelector("button")?.getAttribute("aria-label"),
    ).toBe("Remove {label}");
  });

  it("refuses a row wrapped in another element", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(rows().instantiate(authored(`<div>${CHIP}</div>`), { label: "Apple" })).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('a "tag" root');
    warn.mockRestore();
  });

  it("refuses a row that a second element precedes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(rows().instantiate(authored(`<style></style>${CHIP}`), { label: "Apple" })).toBeNull();

    expect(warn.mock.calls[0]?.[0]).toContain('a "tag" root');
    warn.mockRestore();
  });

  it("refuses a correct row that a second element stands beside", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(rows().instantiate(authored(`${CHIP}<hr />`), { label: "Apple" })).toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    // The row itself is written correctly, so naming a missing root would send
    // the author to the one element that is not the problem.
    expect(warn.mock.calls[0]?.[0]).toContain("holds 2 elements");
    expect(warn.mock.calls[0]?.[0]).not.toContain("lacks");
    warn.mockRestore();
  });

  it("accepts a row that is its own named button", () => {
    const parts = rows().instantiate(
      authored(`<button type="button" aria-label="Remove {label}"
        data-stimeo--tags-input-target="tag label remove">Apple</button>`),
      { label: "Apple" },
    );

    expect(parts).not.toBeNull();
    expect(parts?.button).toBe(parts?.root);
    expect(parts?.button.getAttribute("aria-label")).toBe("Remove Apple");
  });

  it("names the first missing required part, in the order they are declared", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = new TemplateRow({
      identifier: "stimeo--file-dropzone",
      root: "item",
      required: ["name", "size"],
      button: "remove",
      outcome: "added no file",
      noun: "item template",
    });

    expect(
      row.instantiate(authored(`<li data-stimeo--file-dropzone-target="item"></li>`), {}),
    ).toBeNull();

    expect(warn.mock.calls[0]?.[0]).toContain('a "name" target');
    expect(warn.mock.calls[0]?.[0]).not.toContain('"size"');
    warn.mockRestore();
  });

  it("resolves a part the row itself carries", () => {
    const parts = rows().instantiate(
      authored(`<li data-stimeo--tags-input-target="tag label">
        <button type="button" aria-label="Remove {label}"
                data-stimeo--tags-input-target="remove">×</button>
      </li>`),
      { label: "Apple" },
    );

    // Asserted before the identity: a row that was refused would make both sides
    // undefined, and the comparison would hold for the wrong reason.
    expect(parts).not.toBeNull();
    expect(parts?.slots.label).toBe(parts?.root);
  });

  it("builds the row without an optional part and resolves it to null", () => {
    const row = new TemplateRow({
      identifier: "stimeo--file-dropzone",
      root: "item",
      required: ["name"],
      optional: ["thumb"],
      button: "remove",
      outcome: "added no file",
      noun: "item template",
    });

    const parts = row.instantiate(
      authored(`<li data-stimeo--file-dropzone-target="item">
        <span data-stimeo--file-dropzone-target="name"></span>
        <button type="button" aria-label="Remove {name}"
                data-stimeo--file-dropzone-target="remove">×</button>
      </li>`),
      { name: "photo.png" },
    );

    expect(parts?.root).not.toBeUndefined();
    expect(parts?.slots.thumb).toBeNull();
  });

  it("requires the named part to be a button", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      rows().instantiate(
        authored(
          CHIP.replace(
            /<button[\s\S]*?<\/button>/,
            '<span aria-label="x" data-stimeo--tags-input-target="remove"></span>',
          ),
        ),
        { label: "Apple" },
      ),
    ).toBeNull();

    expect(warn.mock.calls[0]?.[0]).toContain('a "remove" target <button>');
    warn.mockRestore();
  });

  it.each([
    ["no aria-label at all", CHIP.replace('aria-label="Remove {label}"', "")],
    ["an aria-label of whitespace", CHIP.replace("Remove {label}", "  ")],
  ])("refuses a remove button with %s", (_case, body) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(rows().instantiate(authored(body), { label: "Apple" })).toBeNull();

    expect(warn.mock.calls[0]?.[0]).toContain('a non-empty aria-label on its "remove" target');
    warn.mockRestore();
  });

  it("expands the authored name and leaves an unknown placeholder as written", () => {
    const parts = rows().instantiate(
      authored(CHIP.replace("Remove {label}", "Remove {label} ({value}) {unknown}")),
      { label: "Apple", value: "apple" },
    );

    expect(parts?.button.getAttribute("aria-label")).toBe("Remove Apple (apple) {unknown}");
  });

  it("names the identifier, the outcome, the noun and the part, once per connection", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = rows();
    const template = authored(`<div></div>`);

    row.instantiate(template, {});
    row.instantiate(template, {});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      'Stimeo UI: "stimeo--tags-input" added no tag because its chip template lacks a "tag" root.',
    );
    warn.mockRestore();
  });

  it("re-arms the diagnostic for the next connection, and shares it with the caller's own", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = rows();
    const template = authored(`<div></div>`);

    row.instantiate(template, {});
    expect(row.report('a "tagTemplate" target')).toBeNull();
    row.connect();
    row.instantiate(template, {});

    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("resolves parts in the namespace of the identifier it was given", () => {
    const row = new TemplateRow({
      identifier: "chips",
      root: "tag",
      required: ["label"],
      button: "remove",
      outcome: "added no tag",
      noun: "chip template",
    });

    expect(row.selector("tag")).toBe('[data-chips-target~="tag"]');
    const parts = row.instantiate(
      authored(`<li data-chips-target="tag">
        <span data-chips-target="label"></span>
        <button type="button" aria-label="Remove {label}" data-chips-target="remove">×</button>
      </li>`),
      { label: "Apple" },
    );

    expect(parts?.slots.label?.dataset.chipsTarget).toBe("label");
  });

  it("names a part beginning with a vowel with the article that fits it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = new TemplateRow({
      identifier: "stimeo--file-dropzone",
      root: "item",
      required: ["name"],
      button: "remove",
      outcome: "added no file",
      noun: "item template",
    });

    row.instantiate(authored(`<div></div>`), {});

    expect(warn.mock.calls[0]?.[0]).toContain('lacks an "item" root');
    warn.mockRestore();
  });
});
