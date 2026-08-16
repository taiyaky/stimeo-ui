import { describe, expect, it, vi } from "vitest";
import { StylePropertyLease } from "../../src/utils/style_property_lease";

/** Contract tests for temporary, authored-value-preserving inline style control. */
describe("StylePropertyLease", () => {
  it("restores an authored value and priority", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5");
    lease.write(element, "1", "important");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("0.25");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("removes a declaration with no authored predecessor", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("");
  });

  it("tracks ownership when a later write removes the declaration", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5");
    lease.write(element, null, "important");
    expect(element.style.getPropertyValue("--progress")).toBe("");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("0.25");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("tracks an initial leased removal independently of its ignored priority", () => {
    const element = document.createElement("div");
    element.style.setProperty("--progress", "0.25", "important");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, null, "important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("0.25");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("writes and returns a newly leased priority", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5", "important");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("");
  });

  it("ignores a return for an element with no lease", () => {
    const lease = new StylePropertyLease("--progress");

    expect(() => lease.return(document.createElement("div"))).not.toThrow();
  });

  it("does not overwrite a later consumer declaration", () => {
    const element = document.createElement("div");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5");
    element.style.setProperty("--progress", "consumer", "important");
    lease.return(element);

    expect(element.style.getPropertyValue("--progress")).toBe("consumer");
    expect(element.style.getPropertyPriority("--progress")).toBe("important");
  });

  it("skips identical writes", () => {
    const element = document.createElement("div");
    const setProperty = vi.spyOn(element.style, "setProperty");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5");
    lease.write(element, "0.5");

    expect(setProperty).toHaveBeenCalledTimes(1);
    lease.returnAll();
  });

  it("skips identical priority writes", () => {
    const element = document.createElement("div");
    const setProperty = vi.spyOn(element.style, "setProperty");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5", "important");
    lease.write(element, "0.5", "important");

    expect(setProperty).toHaveBeenCalledTimes(1);
    lease.returnAll();
  });

  it("skips an already reflected removal even when a priority is supplied", () => {
    const element = document.createElement("div");
    const removeProperty = vi.spyOn(element.style, "removeProperty");
    const lease = new StylePropertyLease("--progress");

    lease.write(element, null, "important");

    expect(removeProperty).not.toHaveBeenCalled();
    lease.returnAll();
  });

  it("returns every outstanding declaration on demand", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    second.style.setProperty("--progress", "0.25");
    const lease = new StylePropertyLease("--progress");

    lease.write(first, "0.5");
    lease.write(second, "1");
    lease.returnAll();

    expect(first.style.getPropertyValue("--progress")).toBe("");
    expect(second.style.getPropertyValue("--progress")).toBe("0.25");
  });

  it("subscribes to no document event, so a dropped lease cannot outlive its consumer", () => {
    // Same contract as AttributeLease: the lease has no lifecycle, so rooting it
    // in a document listener would keep a detached subtree alive until that
    // listener next fired.
    const add = vi.spyOn(document, "addEventListener");
    const host = document.createElement("div");
    const element = document.createElement("div");
    host.append(element);
    document.body.append(host);
    const lease = new StylePropertyLease("--progress");

    lease.write(element, "0.5");
    host.remove();
    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(add).not.toHaveBeenCalled();
    expect(element.style.getPropertyValue("--progress")).toBe("0.5");
  });
});
