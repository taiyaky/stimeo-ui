import { afterEach, describe, expect, it } from "vitest";
import { TransientHooks } from "../../src/utils/transient_hooks";

/**
 * Behavioral tests for {@link TransientHooks}: that every declared hook goes,
 * that nothing else does, that the pass is idempotent over repeated connections,
 * and that the element is the parameter a container needs it to be.
 */
describe("TransientHooks", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  /** Renders `html` into the body and returns the element marked `id="target"`. */
  const target = (html: string): Element => {
    document.body.innerHTML = html;
    const found = document.getElementById("target");
    if (!found) throw new Error("Fixture has no #target");
    return found;
  };

  it("drops every declared hook the element arrived with", () => {
    const element = target('<div id="target" data-dragging="true" data-grabbed="true"></div>');
    const hooks = new TransientHooks({ attributes: ["data-dragging", "data-grabbed"] });

    hooks.reset(element);

    expect(element.hasAttribute("data-dragging")).toBe(false);
    expect(element.hasAttribute("data-grabbed")).toBe(false);
  });

  it("leaves an undeclared attribute alone", () => {
    const element = target('<div id="target" data-dragging="true" data-controller="drag"></div>');
    const hooks = new TransientHooks({ attributes: ["data-dragging"] });

    hooks.reset(element);

    expect(element.getAttribute("data-controller")).toBe("drag");
  });

  it("drops the hooks that are present and ignores the ones that are not", () => {
    const element = target('<div id="target" data-typing="true"></div>');
    const hooks = new TransientHooks({
      attributes: ["data-typing", "data-typing-indicator-rejected"],
    });

    hooks.reset(element);

    expect(element.hasAttribute("data-typing")).toBe(false);
    expect(element.hasAttribute("data-typing-indicator-rejected")).toBe(false);
  });

  it("is a no-op on an element that carries none of them", () => {
    const element = target('<div id="target" class="card"></div>');
    const hooks = new TransientHooks({ attributes: ["data-dirty"] });

    hooks.reset(element);

    expect(element.attributes).toHaveLength(2);
    expect(element.getAttribute("class")).toBe("card");
  });

  it("stays idempotent across the repeated connections a move produces", () => {
    const element = target('<div id="target" data-dirty="true"></div>');
    const hooks = new TransientHooks({ attributes: ["data-dirty"] });

    hooks.reset(element);
    hooks.reset(element);

    expect(element.hasAttribute("data-dirty")).toBe(false);
  });

  it("drops the hooks again once a new cycle has written them", () => {
    const element = target('<div id="target" data-dirty="true"></div>');
    const hooks = new TransientHooks({ attributes: ["data-dirty"] });

    hooks.reset(element);
    element.setAttribute("data-dirty", "true");
    hooks.reset(element);

    expect(element.hasAttribute("data-dirty")).toBe(false);
  });

  it("resets whichever element it is given, so a container can clear its items", () => {
    const element = target(
      '<div id="target" data-highlight="true"><span data-highlight="true"></span></div>',
    );
    const child = element.firstElementChild as Element;
    const hooks = new TransientHooks({ attributes: ["data-highlight"] });

    hooks.reset(element);
    hooks.reset(child);

    expect(element.hasAttribute("data-highlight")).toBe(false);
    expect(child.hasAttribute("data-highlight")).toBe(false);
  });

  it("leaves an item alone while the container is the one being reset", () => {
    const element = target(
      '<div id="target" data-highlight="true"><span data-highlight="true"></span></div>',
    );
    const child = element.firstElementChild as Element;
    const hooks = new TransientHooks({ attributes: ["data-highlight"] });

    hooks.reset(element);

    expect(element.hasAttribute("data-highlight")).toBe(false);
    expect(child.hasAttribute("data-highlight")).toBe(true);
  });

  it("touches nothing when the declaration is empty", () => {
    const element = target('<div id="target" data-dirty="true"></div>');
    const hooks = new TransientHooks({ attributes: [] });

    hooks.reset(element);

    expect(element.getAttribute("data-dirty")).toBe("true");
  });
});
