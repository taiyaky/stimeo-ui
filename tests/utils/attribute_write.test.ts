import { describe, expect, it, vi } from "vitest";
import { setAttributeIfChanged } from "../../src/utils/attribute_write";

describe("setAttributeIfChanged", () => {
  for (const kind of ["html", "svg"] as const) {
    describe(kind, () => {
      const create = (): Element =>
        kind === "html"
          ? document.createElement("div")
          : document.createElementNS("http://www.w3.org/2000/svg", "rect");

      it.each([null, "", "true", "false", "null"])(
        "leaves an equal value %s untouched and does not register a write",
        (value) => {
          const element = create();
          if (value !== null) element.setAttribute("data-state", value);
          const read = vi.spyOn(element, "getAttribute");
          const set = vi.spyOn(element, "setAttribute");
          const remove = vi.spyOn(element, "removeAttribute");
          const beforeWrite = vi.fn();

          expect(setAttributeIfChanged(element, "data-state", value, beforeWrite)).toBe(false);
          expect(read).toHaveBeenCalledExactlyOnceWith("data-state");
          expect(set).not.toHaveBeenCalled();
          expect(remove).not.toHaveBeenCalled();
          expect(beforeWrite).not.toHaveBeenCalled();
        },
      );

      it.each(["", "true", "false", "null"])(
        "creates a missing attribute with the literal value %s",
        (value) => {
          const element = create();
          const beforeWrite = vi.fn(() => {
            expect(element.hasAttribute("data-state")).toBe(false);
          });
          expect(setAttributeIfChanged(element, "data-state", value, beforeWrite)).toBe(true);
          expect(beforeWrite).toHaveBeenCalledTimes(1);
          expect(element.getAttribute("data-state")).toBe(value);
        },
      );

      it("changes an existing value after registering the write", () => {
        const element = create();
        element.setAttribute("data-state", "old");
        const read = vi.spyOn(element, "getAttribute");
        const beforeWrite = vi.fn(() => {
          expect(element.getAttribute("data-state")).toBe("old");
        });
        expect(setAttributeIfChanged(element, "data-state", "new", beforeWrite)).toBe(true);
        expect(beforeWrite).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(2);
        expect(element.getAttribute("data-state")).toBe("new");
      });

      it.each(["", "true", "null"])("removes the present value %s", (value) => {
        const element = create();
        element.setAttribute("data-state", value);
        const beforeWrite = vi.fn(() => {
          expect(element.getAttribute("data-state")).toBe(value);
        });
        expect(setAttributeIfChanged(element, "data-state", null, beforeWrite)).toBe(true);
        expect(beforeWrite).toHaveBeenCalledTimes(1);
        expect(element.hasAttribute("data-state")).toBe(false);
      });
    });
  }

  it("reads the current value once when changing it without a callback", () => {
    const element = document.createElement("div");
    element.setAttribute("data-state", "old");
    const read = vi.spyOn(element, "getAttribute");
    const set = vi.spyOn(element, "setAttribute");
    expect(setAttributeIfChanged(element, "data-state", "new")).toBe(true);
    expect(read).toHaveBeenCalledExactlyOnceWith("data-state");
    expect(set).toHaveBeenCalledExactlyOnceWith("data-state", "new");
  });

  it("preserves a registration error without writing the attribute", () => {
    const element = document.createElement("div");
    element.setAttribute("data-state", "old");
    const error = new Error("Registration failed");
    expect(() =>
      setAttributeIfChanged(element, "data-state", "new", () => {
        throw error;
      }),
    ).toThrow(error);
    expect(element.getAttribute("data-state")).toBe("old");
  });

  it("preserves a DOM write error", () => {
    const element = document.createElement("div");
    const error = new Error("Write failed");
    vi.spyOn(element, "setAttribute").mockImplementation(() => {
      throw error;
    });
    expect(() => setAttributeIfChanged(element, "data-state", "new")).toThrow(error);
  });
});
