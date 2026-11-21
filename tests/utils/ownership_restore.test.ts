import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MeterController } from "../../src/controllers/meter_controller";
import { ProgressController } from "../../src/controllers/progress_controller";
import { AttributeLease, readAttributeLease } from "../../src/utils/attribute_lease";
import { StylePropertyLease } from "../../src/utils/style_property_lease";
import { TabindexLoan } from "../../src/utils/tabindex_loan";
import { separateCopy } from "../helpers/separate_copy";
import { disconnectAndStopApplication } from "../helpers/stimulus";
import { tick } from "../helpers/timing";

let serial = 0;
const owner = () => `stimeo--restored-${serial++}`;

/** Serializes the ownership records into fresh DOM with no live stack. */
function transfer(source: HTMLElement): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = source.outerHTML;
  return template.content.firstElementChild as HTMLElement;
}

afterEach(() => {
  document.body.innerHTML = "";
});

/** Constructed owners share record names across separately loaded copies in one global. */
describe("ownership restoration within one global", () => {
  for (const upperFirst of [false, true]) {
    it(`returns an attribute with the ${upperFirst ? "upper" : "lower"} owner first and a later reader copy`, async () => {
      const { AttributeLease: Source } = await separateCopy(
        () => import("../../src/utils/attribute_lease"),
      );
      const lowerName = owner();
      const upperName = owner();
      const source = document.createElement("div");
      source.setAttribute("aria-label", "Author");
      const lower = new Source("aria-label", lowerName);
      const upper = new Source("aria-label", upperName);
      lower.write(source, "Lower");
      upper.write(source, "Cover");
      const copy = transfer(source);
      readAttributeLease(copy, "aria-label", owner(), {}, "Cover");
      const { AttributeLease: Reader } = await separateCopy(
        () => import("../../src/utils/attribute_lease"),
      );
      const first = new Reader("aria-label", upperFirst ? upperName : lowerName);
      const second = new AttributeLease("aria-label", upperFirst ? lowerName : upperName);

      expect(first.return(copy)).toBe(true);
      expect(copy.getAttribute("aria-label")).toBe(upperFirst ? "Lower" : "Cover");
      expect(second.return(copy)).toBe(true);
      expect(copy.getAttribute("aria-label")).toBe("Author");
      expect(second.return(copy)).toBe(false);
      lower.returnAll();
      upper.returnAll();
    });

    it(`returns style priority with the ${upperFirst ? "upper" : "lower"} owner first and a later reader copy`, async () => {
      const { StylePropertyLease: Source } = await separateCopy(
        () => import("../../src/utils/style_property_lease"),
      );
      const lowerName = owner();
      const upperName = owner();
      const source = document.createElement("div");
      source.style.setProperty("--progress", "0.1", "important");
      const lower = new Source("--progress", lowerName);
      const upper = new Source("--progress", upperName);
      lower.write(source, "0.2");
      upper.write(source, "0.3");
      const copy = transfer(source);
      const first = new StylePropertyLease("--progress", upperFirst ? upperName : lowerName);
      first.return(copy);
      expect(copy.style.getPropertyValue("--progress")).toBe(upperFirst ? "0.2" : "0.3");
      const { StylePropertyLease: Reader } = await separateCopy(
        () => import("../../src/utils/style_property_lease"),
      );
      new Reader("--progress", upperFirst ? lowerName : upperName).return(copy);

      expect(copy.style.getPropertyValue("--progress")).toBe("0.1");
      expect(copy.style.getPropertyPriority("--progress")).toBe("important");
      lower.returnAll();
      upper.returnAll();
    });

    it(`returns tabindex with the ${upperFirst ? "upper" : "lower"} owner first and a later reader copy`, async () => {
      const { TabindexLoan: Source } = await separateCopy(
        () => import("../../src/utils/tabindex_loan"),
      );
      const lowerName = owner();
      const upperName = owner();
      const source = document.createElement("div");
      const lower = new Source("-1", lowerName);
      const upper = new Source("0", upperName);
      lower.lend(source);
      upper.lend(source);
      const copy = transfer(source);
      const first = new TabindexLoan(upperFirst ? "0" : "-1", upperFirst ? upperName : lowerName);
      expect(first.return(copy)).toBe(true);
      expect(copy.getAttribute("tabindex")).toBe(upperFirst ? "-1" : "0");
      const { TabindexLoan: Reader } = await separateCopy(
        () => import("../../src/utils/tabindex_loan"),
      );
      expect(
        new Reader(upperFirst ? "-1" : "0", upperFirst ? lowerName : upperName).return(copy),
      ).toBe(true);

      expect(copy.hasAttribute("tabindex")).toBe(false);
      expect(first.return(copy)).toBe(false);
      lower.returnAll();
      upper.returnAll();
    });
  }

  it("restores several resources of one constructed owner independently", async () => {
    const { AttributeLease: Attribute } = await separateCopy(
      () => import("../../src/utils/attribute_lease"),
    );
    const { StylePropertyLease: Style } = await separateCopy(
      () => import("../../src/utils/style_property_lease"),
    );
    const { TabindexLoan: Loan } = await separateCopy(
      () => import("../../src/utils/tabindex_loan"),
    );
    const name = owner();
    const source = document.createElement("div");
    source.setAttribute("aria-label", "Author label");
    source.setAttribute("aria-valuetext", "Author text");
    source.style.setProperty("--progress", "0.1", "important");
    const label = new Attribute("aria-label", name);
    const text = new Attribute("aria-valuetext", name);
    const style = new Style("--progress", name);
    const loan = new Loan("-1", name);
    label.write(source, "Label");
    text.write(source, "Text");
    style.write(source, "0.5");
    loan.lend(source);
    const copy = transfer(source);
    new AttributeLease("aria-label", name).return(copy);
    expect(copy.getAttribute("aria-label")).toBe("Author label");
    expect(copy.getAttribute("aria-valuetext")).toBe("Text");
    new StylePropertyLease("--progress", name).return(copy);
    expect(copy.style.getPropertyPriority("--progress")).toBe("important");
    new AttributeLease("aria-valuetext", name).return(copy);
    new TabindexLoan("-1", name).return(copy);
    expect(copy.getAttribute("aria-valuetext")).toBe("Author text");
    expect(copy.hasAttribute("tabindex")).toBe(false);
    label.returnAll();
    text.returnAll();
    style.returnAll();
    loan.returnAll();
  });

  it("preserves authored edits over copied records in all three resources", async () => {
    const { AttributeLease: Attribute } = await separateCopy(
      () => import("../../src/utils/attribute_lease"),
    );
    const { StylePropertyLease: Style } = await separateCopy(
      () => import("../../src/utils/style_property_lease"),
    );
    const { TabindexLoan: Loan } = await separateCopy(
      () => import("../../src/utils/tabindex_loan"),
    );
    const name = owner();
    const source = document.createElement("div");
    source.setAttribute("aria-label", "Author");
    source.style.setProperty("--progress", "0.1");
    const attribute = new Attribute("aria-label", name);
    const style = new Style("--progress", name);
    const loan = new Loan("-1", name);
    attribute.write(source, "Cover");
    style.write(source, "0.5");
    loan.lend(source);
    const copy = transfer(source);
    copy.setAttribute("aria-label", "Page");
    copy.style.setProperty("--progress", "0.9", "important");
    copy.setAttribute("tabindex", "0");

    new AttributeLease("aria-label", name).return(copy);
    new StylePropertyLease("--progress", name).return(copy);
    new TabindexLoan("-1", name).return(copy);

    expect(copy.getAttribute("aria-label")).toBe("Page");
    expect([
      copy.style.getPropertyValue("--progress"),
      copy.style.getPropertyPriority("--progress"),
    ]).toEqual(["0.9", "important"]);
    expect(copy.getAttribute("tabindex")).toBe("0");
    attribute.returnAll();
    style.returnAll();
    loan.returnAll();
  });

  it("does not replace a live stack with subsequently inserted snapshot records", async () => {
    const element = document.createElement("div");
    readAttributeLease(element, "aria-label", owner(), {}, null);
    const { AttributeLease: Source } = await separateCopy(
      () => import("../../src/utils/attribute_lease"),
    );
    const name = owner();
    const source = document.createElement("div");
    source.setAttribute("aria-label", "Author");
    const lease = new Source("aria-label", name);
    lease.write(source, "Cover");
    for (const attribute of source.attributes)
      element.setAttribute(attribute.name, attribute.value);

    expect(new AttributeLease("aria-label", name).return(element)).toBe(false);
    expect(element.getAttribute("aria-label")).toBe("Cover");
    lease.returnAll();
  });

  it("skips a constructed owner record that is not a complete tuple", () => {
    const element = document.createElement("div");
    const name = owner();
    const record = `data-${name}-aria-label-lease`;
    const malformed = '["Author"]';
    element.setAttribute("aria-label", "Cover");
    element.setAttribute(record, malformed);
    new AttributeLease("aria-label", name);
    readAttributeLease(element, "aria-label", owner(), {}, "Cover");

    expect(new AttributeLease("aria-label", name).return(element)).toBe(false);
    expect(element.getAttribute("aria-label")).toBe("Cover");
  });

  it("restores a complete record when an unused owner registers an alias for another attribute", () => {
    const name = owner();
    const source = document.createElement("div");
    source.setAttribute("aria-label", "Author");
    const writer = new AttributeLease("aria-label", name);
    writer.write(source, "Cover");
    new AttributeLease("label", `${name}-aria`);
    const copy = transfer(source);

    expect(new AttributeLease("aria-label", name).return(copy)).toBe(true);
    expect(copy.getAttribute("aria-label")).toBe("Author");
    writer.returnAll();
  });

  for (const [name, Controller] of [
    ["progress", ProgressController],
    ["meter", MeterController],
  ] as const) {
    it(`${name} keeps a known owner covered until a later reader copy returns it`, async () => {
      const { AttributeLease: Source } = await separateCopy(
        () => import("../../src/utils/attribute_lease"),
      );
      const coverOwner = owner();
      const source = document.createElement("div");
      const identifier = `stimeo--${name}`;
      source.setAttribute("data-controller", identifier);
      source.setAttribute("role", name === "progress" ? "progressbar" : "meter");
      source.setAttribute("aria-label", "Reading");
      source.setAttribute("aria-valuetext", "Author");
      source.setAttribute(`data-${identifier}-value-value`, "40");
      source.setAttribute(`data-${identifier}-value-text-value`, "{value}%");
      const covering = new Source("aria-valuetext", coverOwner);
      covering.write(source, "Cover");
      const copy = transfer(source);
      document.body.append(copy);
      const application = Application.start();
      application.register(identifier, Controller);
      try {
        await tick();
        expect(copy.getAttribute("aria-valuetext")).toBe("Cover");
        expect(new AttributeLease("aria-valuetext", coverOwner).return(copy)).toBe(true);
        expect(copy.getAttribute("aria-valuetext")).toBe("40%");
        application.getControllerForElementAndIdentifier(copy, identifier)?.disconnect();
        expect(copy.getAttribute("aria-valuetext")).toBe("Author");
      } finally {
        disconnectAndStopApplication(application);
        covering.returnAll();
      }
    });
  }
});

/** Repainting existing holds does not feed a broad attribute observer. */
describe("ownership record reflection", () => {
  it("settles broad attribute observation when several resources repaint together", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const attribute = new AttributeLease("aria-label", owner());
    const style = new StylePropertyLease("--progress", owner());
    const loan = new TabindexLoan("-1", owner());
    attribute.write(element, "Reading");
    style.write(element, "0.5");
    loan.lend(element);
    let callbacks = 0;
    const observer = new MutationObserver(() => {
      callbacks++;
      attribute.write(element, "Next");
      style.write(element, "0.5");
      loan.lend(element);
    });
    observer.observe(element, { attributes: true });
    attribute.write(element, "Next");

    await tick();

    expect(callbacks).toBe(1);
    expect(element.getAttribute("aria-label")).toBe("Next");
    observer.disconnect();
    attribute.returnAll();
    style.returnAll();
    loan.returnAll();
  });
});
