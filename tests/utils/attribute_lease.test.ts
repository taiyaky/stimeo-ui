import { describe, expect, it, vi } from "vitest";
import { AttributeLease } from "../../src/utils/attribute_lease";

/** Contract tests for temporary, authored-value-preserving attribute control. */
describe("AttributeLease", () => {
  it("restores an authored value after temporary writes", () => {
    const element = document.createElement("div");
    element.setAttribute("aria-valuemin", "1");
    const lease = new AttributeLease("aria-valuemin");

    lease.write(element, "2");
    lease.write(element, "3");
    lease.return(element);

    expect(element.getAttribute("aria-valuemin")).toBe("1");
  });

  it("restores authored empty attributes rather than treating them as absent", () => {
    const element = document.createElement("div");
    element.setAttribute("data-state", "");
    const lease = new AttributeLease("data-state");

    lease.write(element, "active");
    lease.return(element);

    expect(element.hasAttribute("data-state")).toBe(true);
    expect(element.getAttribute("data-state")).toBe("");
  });

  it("removes a value that had no authored predecessor", () => {
    const element = document.createElement("div");
    const lease = new AttributeLease("aria-valuenow");

    lease.write(element, "5");
    lease.return(element);

    expect(element.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("can own absence and restore the authored value later", () => {
    const element = document.createElement("div");
    element.setAttribute("aria-valuemax", "10");
    const lease = new AttributeLease("aria-valuemax");

    lease.write(element, null);
    expect(element.hasAttribute("aria-valuemax")).toBe(false);
    lease.return(element);

    expect(element.getAttribute("aria-valuemax")).toBe("10");
  });

  it("does not overwrite a value a consumer authored after the lease write", () => {
    const element = document.createElement("div");
    const lease = new AttributeLease("aria-valuenow");

    lease.write(element, "5");
    element.setAttribute("aria-valuenow", "consumer");
    lease.return(element);

    expect(element.getAttribute("aria-valuenow")).toBe("consumer");
  });

  it("returns leases for every tracked element and is idempotent", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    second.setAttribute("role", "group");
    const lease = new AttributeLease<HTMLElement>("role");

    lease.write(first, "region");
    lease.write(second, "region");
    lease.returnAll();
    lease.returnAll();

    expect(first.hasAttribute("role")).toBe(false);
    expect(second.getAttribute("role")).toBe("group");
  });

  it("skips DOM writes when the leased value is already reflected", () => {
    const element = document.createElement("div");
    const setAttribute = vi.spyOn(element, "setAttribute");
    const lease = new AttributeLease("data-state");

    lease.write(element, "active");
    lease.write(element, "active");

    expect(setAttribute).toHaveBeenCalledTimes(1);
    lease.returnAll();
  });

  it("returns every outstanding lease on demand", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    second.setAttribute("role", "group");
    const lease = new AttributeLease<HTMLElement>("role");

    lease.write(first, "region");
    lease.write(second, "region");
    lease.returnAll();

    expect(first.hasAttribute("role")).toBe(false);
    expect(second.getAttribute("role")).toBe("group");
  });

  it("subscribes to no document event, so a dropped lease cannot outlive its consumer", () => {
    // A consumer that keeps its materialized output writes and then simply drops
    // the lease. Nothing may hold it afterwards: a document subscription would
    // root the lease — and through it the detached subtree — until it next fired.
    const add = vi.spyOn(document, "addEventListener");
    const host = document.createElement("div");
    const image = document.createElement("img");
    image.setAttribute("hidden", "");
    host.append(image);
    document.body.append(host);
    const lease = new AttributeLease<HTMLElement>("hidden");

    lease.write(image, null);
    host.remove();
    document.dispatchEvent(new Event("turbo:before-cache"));

    expect(add).not.toHaveBeenCalled();
    expect(image.hasAttribute("hidden")).toBe(false);
  });
});
