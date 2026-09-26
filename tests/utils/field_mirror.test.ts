import { afterEach, describe, expect, it } from "vitest";
import { commitField, writeField, writeFields } from "../../src/utils/field_mirror";

/**
 * Behavioral tests for the hidden-field mirror: that a write reports only a
 * real move, that a generated set is rebuilt in order and answers for its
 * `name` and `form` too, and that the commit is the bubbling `change` a native
 * control emits.
 */
describe("field mirror", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const hidden = (value = ""): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.value = value;
    document.body.append(input);
    return input;
  };

  const container = (): HTMLElement => {
    const element = document.createElement("div");
    document.body.append(element);
    return element;
  };

  const submitted = (element: HTMLElement) =>
    [...element.querySelectorAll("input")].map((input) => ({
      name: input.name,
      value: input.value,
      type: input.type,
      form: input.getAttribute("form"),
    }));

  describe("writeField", () => {
    it("writes a new value and reports the move", () => {
      const field = hidden("3");

      expect(writeField(field, "5")).toBe(true);
      expect(field.value).toBe("5");
    });

    it("reports no move when the value is already there", () => {
      const field = hidden("5");

      expect(writeField(field, "5")).toBe(false);
      expect(field.value).toBe("5");
    });

    it("treats clearing as a move", () => {
      const field = hidden("5");

      expect(writeField(field, "")).toBe(true);
      expect(field.value).toBe("");
    });
  });

  describe("writeFields", () => {
    it("generates one hidden input per value, in order", () => {
      const element = container();

      expect(writeFields(element, ["a", "b"], { name: "tags[]" })).toBe(true);
      expect(submitted(element)).toEqual([
        { name: "tags[]", value: "a", type: "hidden", form: null },
        { name: "tags[]", value: "b", type: "hidden", form: null },
      ]);
    });

    it("reports no move when the same set is written again", () => {
      const element = container();
      writeFields(element, ["a", "b"], { name: "tags[]" });

      expect(writeFields(element, ["a", "b"], { name: "tags[]" })).toBe(false);
    });

    it("leaves the existing inputs in place when the set has not moved", () => {
      const element = container();
      writeFields(element, ["a"], { name: "tags[]" });
      const before = element.firstElementChild;

      writeFields(element, ["a"], { name: "tags[]" });

      expect(element.firstElementChild).toBe(before);
    });

    it("rebuilds an authored set whose inputs are not hidden", () => {
      const element = container();
      element.innerHTML = '<input type="text" name="tags[]" value="a" />';

      expect(writeFields(element, ["a"], { name: "tags[]" })).toBe(true);
      expect(submitted(element)[0]?.type).toBe("hidden");
    });

    it("rebuilds a container holding something other than inputs", () => {
      const element = container();
      element.innerHTML = "<span>a</span>";

      expect(writeFields(element, [], { name: "tags[]" })).toBe(true);
      expect(element.children.length).toBe(0);
    });

    it("reports a move when the order changes", () => {
      const element = container();
      writeFields(element, ["a", "b"], { name: "tags[]" });

      expect(writeFields(element, ["b", "a"], { name: "tags[]" })).toBe(true);
      expect(submitted(element).map((input) => input.value)).toEqual(["b", "a"]);
    });

    it("reports a move when the set empties", () => {
      const element = container();
      writeFields(element, ["a"], { name: "tags[]" });

      expect(writeFields(element, [], { name: "tags[]" })).toBe(true);
      expect(submitted(element)).toEqual([]);
    });

    it("reports a move when the name changes under the same values", () => {
      const element = container();
      writeFields(element, ["a"], { name: "tags[]" });

      expect(writeFields(element, ["a"], { name: "labels[]" })).toBe(true);
      expect(submitted(element)[0]?.name).toBe("labels[]");
    });

    it("applies form and reports the move when it changes", () => {
      const element = container();
      writeFields(element, ["a"], { name: "tags[]" });

      expect(writeFields(element, ["a"], { name: "tags[]", form: "filters" })).toBe(true);
      expect(submitted(element)[0]?.form).toBe("filters");
      expect(writeFields(element, ["a"], { name: "tags[]", form: "filters" })).toBe(false);
    });

    it("leaves no form attribute for an empty form id", () => {
      const element = container();

      writeFields(element, ["a"], { name: "tags[]", form: "" });

      expect(submitted(element)[0]?.form).toBe(null);
    });

    it("replaces whatever the container held", () => {
      const element = container();
      element.innerHTML = '<input type="hidden" name="stale[]" value="x" />';

      expect(writeFields(element, ["a"], { name: "tags[]" })).toBe(true);
      expect(submitted(element)).toEqual([
        { name: "tags[]", value: "a", type: "hidden", form: null },
      ]);
    });
  });

  describe("commitField", () => {
    it("dispatches a bubbling, non-cancelable change from the element", () => {
      const field = hidden("5");
      const seen: Event[] = [];
      document.addEventListener("change", (event) => seen.push(event));

      commitField(field);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.type).toBe("change");
      expect(seen[0]?.target).toBe(field);
      expect(seen[0]?.bubbles).toBe(true);
      expect(seen[0]?.cancelable).toBe(false);
    });
  });
});
