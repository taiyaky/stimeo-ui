import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttributeLease } from "../../src/utils/attribute_lease";
import { TemplateAttributeLease } from "../../src/utils/template_attribute_lease";

/** Template intent survives release, cache copies and temporary covering leases. */
describe("TemplateAttributeLease", () => {
  let element: HTMLElement;
  let lease: TemplateAttributeLease;
  const record = "data-stimeo--reading-aria-valuetext-template";

  beforeEach(() => {
    element = document.createElement("div");
    document.body.append(element);
    element.setAttribute("aria-valuetext", "Author");
    lease = new TemplateAttributeLease("aria-valuetext", "stimeo--reading");
  });

  afterEach(() => {
    lease.release(element);
    document.body.innerHTML = "";
  });

  it("suspends a template without forgetting its source", () => {
    lease.render(element, "{value}", "40");
    lease.render(element, "{value}", null);
    expect(element.getAttribute("aria-valuetext")).toBe("Author");
    lease.render(element, "{value}", "60");
    expect(element.getAttribute("aria-valuetext")).toBe("60");
  });

  it("resumes a released template on a copy of its authored baseline", () => {
    lease.render(element, "{value}", "40");
    lease.release(element);
    const copy = element.cloneNode(true) as HTMLElement;
    const restored = new TemplateAttributeLease("aria-valuetext", "stimeo--reading");
    restored.render(copy, "{value}", "60");
    expect(copy.getAttribute("aria-valuetext")).toBe("60");
    restored.release(copy);
    expect(copy.getAttribute("aria-valuetext")).toBe("Author");
  });

  it("returns a restored ownership record when no template intent remains", () => {
    const writer = new AttributeLease("aria-valuetext", "stimeo--reading", { base: true });
    writer.write(element, "40");
    const copy = element.cloneNode(true) as HTMLElement;
    lease.render(copy, "", null);
    expect(copy.getAttribute("aria-valuetext")).toBe("Author");
    expect(copy.hasAttribute("data-stimeo--reading-aria-valuetext-lease")).toBe(false);
    writer.returnAll();
  });

  it("yields to a change made while released", () => {
    lease.render(element, "{value}", "40");
    lease.release(element);
    element.setAttribute("aria-valuetext", "Page");
    lease.render(element, "{value}", "60");
    expect(element.getAttribute("aria-valuetext")).toBe("Page");
    lease.render(element, "Value {value}", "Value 60");
    expect(element.getAttribute("aria-valuetext")).toBe("Value 60");
    lease.release(element);
    expect(element.getAttribute("aria-valuetext")).toBe("Page");
  });

  it("detects an author's edit at release even without a render", () => {
    lease.render(element, "{value}", "40");
    element.removeAttribute("aria-valuetext");
    lease.release(element);
    const copy = element.cloneNode(true) as HTMLElement;
    const restored = new TemplateAttributeLease("aria-valuetext", "stimeo--reading");
    restored.render(copy, "{value}", "60");
    expect(copy.hasAttribute("aria-valuetext")).toBe(false);
  });

  it("keeps its authored baseline when released beneath a temporary cover", () => {
    lease.render(element, "{value}", "40");
    const cover = new AttributeLease("aria-valuetext", "stimeo--cover");
    cover.write(element, "Cover");
    lease.release(element);
    expect(element.getAttribute("aria-valuetext")).toBe("Cover");
    cover.returnAll();
    expect(element.getAttribute("aria-valuetext")).toBe("Author");
    lease.render(element, "{value}", "60");
    expect(element.getAttribute("aria-valuetext")).toBe("60");
  });

  it("can resume beneath a cover that was acquired while released", () => {
    lease.render(element, "{value}", "40");
    lease.release(element);
    const cover = new AttributeLease("aria-valuetext", "stimeo--cover");
    cover.write(element, "Cover");
    lease.render(element, "{value}", "60");
    expect(element.getAttribute("aria-valuetext")).toBe("Cover");
    cover.returnAll();
    expect(element.getAttribute("aria-valuetext")).toBe("60");
  });

  it("does not mistake an author's change over a cover for a continued lease", () => {
    lease.render(element, "{value}", "40");
    const cover = new AttributeLease("aria-valuetext", "stimeo--cover");
    cover.write(element, "Cover");
    element.setAttribute("aria-valuetext", "Page");
    lease.render(element, "{value}", "60");
    cover.returnAll();
    expect(element.getAttribute("aria-valuetext")).toBe("Page");
  });

  it("ends yielded ownership before another base writer takes the authored value", () => {
    lease.render(element, "{value}", "40");
    element.setAttribute("aria-valuetext", "Page");
    lease.render(element, "{value}", "60");
    const next = new AttributeLease("aria-valuetext", "stimeo--next", { base: true });
    next.write(element, "Next");
    expect(element.getAttribute("aria-valuetext")).toBe("Next");
    next.returnAll();
    expect(element.getAttribute("aria-valuetext")).toBe("Page");
  });

  it("reacquires the author's new baseline over a stale covering hold", () => {
    lease.render(element, "{value}", "40");
    const cover = new AttributeLease("aria-valuetext", "stimeo--cover");
    cover.write(element, "Cover");
    element.setAttribute("aria-valuetext", "Page");
    lease.render(element, "Value {value}", "Value 60");
    expect(element.getAttribute("aria-valuetext")).toBe("Value 60");
    lease.release(element);
    expect(element.getAttribute("aria-valuetext")).toBe("Page");
    cover.returnAll();
    expect(element.getAttribute("aria-valuetext")).toBe("Page");
  });

  it.each([
    "",
    "true",
    "[]",
    '[1,"40",false]',
    '["{value}",40,false]',
    '["{value}",null,1]',
    '["{value}",null,false,0]',
  ])("ignores an unreadable intent record %j", (malformed) => {
    element.setAttribute(record, malformed);
    lease.render(element, "{value}", "40");
    expect(element.getAttribute("aria-valuetext")).toBe("40");
    lease.release(element);
    expect(element.getAttribute("aria-valuetext")).toBe("Author");
  });

  it("records an identical authored value without claiming to distinguish identical author writes", () => {
    lease.render(element, "{value}", "Author");
    const copy = element.cloneNode(true) as HTMLElement;
    const restored = new TemplateAttributeLease("aria-valuetext", "stimeo--reading");
    restored.render(copy, "{value}", "60");
    restored.release(copy);
    expect(copy.getAttribute("aria-valuetext")).toBe("Author");
  });
});
