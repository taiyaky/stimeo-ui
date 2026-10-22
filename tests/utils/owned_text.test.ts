import { describe, expect, it, vi } from "vitest";
import { OwnedText } from "../../src/utils/owned_text";

const ATTRIBUTE = "data-example-label";

describe.each(["text", "value"] as const)("OwnedText %s channel", (channel) => {
  const fixture = () => {
    const element = document.createElement("input");
    const owner = new OwnedText<HTMLInputElement>(ATTRIBUTE, channel);
    const current = () => (channel === "text" ? element.textContent : element.value);
    const author = (text: string) => {
      if (channel === "text") element.textContent = text;
      else element.value = text;
    };
    return { element, owner, current, author };
  };

  it.each(["", "Save", `日本語 "\\\n`])("restores the exact original %j", (original) => {
    const { element, owner, current, author } = fixture();
    author(original);
    const before = current();
    owner.write(element, "Busy");
    owner.write(element, "Waiting");
    expect(owner.read(element)).toEqual({ original: before, written: "Waiting" });
    expect(owner.restore(element)).toBe(true);
    expect(current()).toBe(before);
    expect(owner.hasRecord(element)).toBe(false);
    expect(owner.read(element, { source: "live" })).toBeNull();
  });

  it("adopts a clone's DOM record without inventing live evidence", () => {
    const { element, owner } = fixture();
    owner.write(element, "Busy", "Idle");
    const clone = element.cloneNode(true) as HTMLInputElement;
    const fresh = new OwnedText<HTMLInputElement>(ATTRIBUTE, channel);
    expect(fresh.owns(clone)).toBe(true);
    expect(fresh.owns(clone, { source: "live" })).toBe(false);
    expect(owner.owns(clone, { source: "live" })).toBe(false);
    expect(fresh.restore(clone)).toBe(true);
    expect(channel === "text" ? clone.textContent : clone.value).toBe("Idle");
  });

  it.each(["", "Authored"])("preserves an author's replacement %j on clear and restore", (text) => {
    const { element, owner, current, author } = fixture();
    author("Idle");
    owner.write(element, "Busy");
    author(text);
    expect(owner.clear(element)).toBe(false);
    expect(owner.restore(element)).toBe(false);
    expect(current()).toBe(text);
    expect(owner.hasRecord(element)).toBe(true);
    owner.forget(element);
    expect(current()).toBe(text);
    expect(owner.hasRecord(element)).toBe(false);
  });

  it("distinguishes a valid empty write from a missing or empty record", () => {
    const { element, owner } = fixture();
    expect(owner.owns(element)).toBe(false);
    element.setAttribute(ATTRIBUTE, "");
    expect(owner.hasRecord(element)).toBe(true);
    expect(owner.owns(element)).toBe(false);
    owner.write(element, "");
    expect(owner.owns(element)).toBe(true);
    expect(owner.clear(element)).toBe(true);
    expect(owner.clear(element)).toBe(false);
  });

  it.each([
    "broken",
    "null",
    "{}",
    "42",
    '"text"',
    "[]",
    '["text","Busy"]',
    '["text","Idle","Busy","extra"]',
    '["text",null,"Busy"]',
    '["text","Idle",42]',
    '["other","Idle","Busy"]',
  ])("rejects malformed evidence %s", (raw) => {
    const { element, owner, author, current } = fixture();
    author("Busy");
    element.setAttribute(ATTRIBUTE, raw);
    expect(owner.read(element)).toBeNull();
    expect(owner.owns(element)).toBe(false);
    expect(owner.restore(element)).toBe(false);
    expect(current()).toBe("Busy");
  });

  it("rejects a record for the other channel", () => {
    const { element, owner, author } = fixture();
    author("Busy");
    element.setAttribute(
      ATTRIBUTE,
      JSON.stringify([channel === "text" ? "value" : "text", "Idle", "Busy"]),
    );
    expect(owner.owns(element)).toBe(false);
  });

  it("uses live original evidence only when explicitly requested", () => {
    const { element, owner, author, current } = fixture();
    author("Idle");
    owner.write(element, "Busy");
    element.removeAttribute(ATTRIBUTE);
    expect(owner.owns(element)).toBe(false);
    expect(owner.owns(element, { source: "live" })).toBe(true);
    author("Idle");
    expect(owner.owns(element, { source: "live" })).toBe(false);
    expect(owner.owns(element, { source: "live", allowOriginal: true })).toBe(true);
    expect(owner.clear(element, { source: "live", allowOriginal: true })).toBe(true);
    expect(current()).toBe("");
  });

  it("keeps the original in a DOM record when a new instance writes again", () => {
    const { element, owner, author } = fixture();
    author("Idle");
    owner.write(element, "Busy");
    const fresh = new OwnedText<HTMLInputElement>(ATTRIBUTE, channel);
    fresh.write(element, "Waiting");
    expect(fresh.read(element)).toEqual({ original: "Idle", written: "Waiting" });
    fresh.write(element, "Again", "Authored");
    expect(fresh.read(element)?.original).toBe("Authored");
  });

  it("records a caller's property write without assigning the property again", () => {
    const { element, owner, author, current } = fixture();
    author("Busy");
    const spy = vi.spyOn(element, channel === "text" ? "textContent" : "value", "set");
    owner.remember(element, "Busy", "Idle");
    expect(spy).not.toHaveBeenCalled();
    expect(owner.owns(element)).toBe(true);
    expect(current()).toBe("Busy");
    spy.mockRestore();
  });

  it("avoids identical writes unless the caller requires a fresh occurrence", () => {
    const { element, owner } = fixture();
    owner.write(element, "Busy");
    const property = vi.spyOn(element, channel === "text" ? "textContent" : "value", "set");
    const attribute = vi.spyOn(element, "setAttribute");
    owner.write(element, "Busy");
    expect(property).not.toHaveBeenCalled();
    expect(attribute).not.toHaveBeenCalled();
    owner.write(element, "Busy", undefined, true);
    expect(property).toHaveBeenCalledExactlyOnceWith("Busy");
    expect(attribute).not.toHaveBeenCalled();
    property.mockRestore();
    attribute.mockRestore();
  });

  it("applies the caller's guard to both evidence sources and release operations", () => {
    const { element, author, current } = fixture();
    const owner = new OwnedText<HTMLInputElement>(
      ATTRIBUTE,
      channel,
      (slot) => !slot.hasAttribute("aria-label"),
    );
    author("Idle");
    owner.write(element, "Busy");
    element.setAttribute("aria-label", "");
    expect(owner.owns(element)).toBe(false);
    expect(owner.owns(element, { source: "live" })).toBe(false);
    expect(owner.clear(element)).toBe(false);
    expect(owner.restore(element)).toBe(false);
    expect(current()).toBe("Busy");
    element.removeAttribute("aria-label");
    expect(owner.restore(element)).toBe(true);
    expect(current()).toBe("Idle");
  });
});

describe("OwnedText text structure", () => {
  it.each(["", "Busy"])("protects a child with text %j on both evidence sources", (text) => {
    const slot = document.createElement("span");
    const child = document.createElement("span");
    const owner = new OwnedText(ATTRIBUTE);
    owner.write(slot, text);
    child.textContent = text;
    slot.replaceChildren(child);
    expect(owner.owns(slot)).toBe(false);
    expect(owner.clear(slot, { source: "live", allowOriginal: true })).toBe(false);
    expect(owner.restore(slot)).toBe(false);
    expect(slot.firstElementChild).toBe(child);
    child.replaceWith(document.createTextNode(text));
    expect(owner.clear(slot)).toBe(true);
  });

  it("cannot own or write an input value on a non-input element", () => {
    const slot = document.createElement("span");
    slot.textContent = "Busy";
    const owner = new OwnedText(ATTRIBUTE, "value");
    owner.write(slot, "Changed");
    owner.remember(slot, "Changed");
    expect(owner.hasRecord(slot)).toBe(false);
    slot.setAttribute(ATTRIBUTE, '["value","Idle","Busy"]');
    expect(owner.owns(slot)).toBe(false);
    expect(owner.restore(slot)).toBe(false);
    expect(slot.textContent).toBe("Busy");
  });
});
