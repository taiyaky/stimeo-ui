import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { MeterController } from "../src/controllers/meter_controller";
import { ProgressController } from "../src/controllers/progress_controller";
import { AttributeLease } from "../src/utils/attribute_lease";
import { query } from "./helpers/dom";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Template-derived value text yields to the author's edits across renders and connections. */
describe.each([
  ["progress", ProgressController],
  ["meter", MeterController],
] as const)("%s value-text ownership", (name, Controller) => {
  let application: Application;
  const identifier = `stimeo--${name}`;
  const templateAttribute = `data-${identifier}-value-text-value`;
  const root = () => query("#reading");
  const instance = () =>
    application.getControllerForElementAndIdentifier(root(), identifier) as
      | ProgressController
      | MeterController;
  const set = (value: number) => instance().setValue({ detail: { value } } as unknown as Event);

  const start = async (original: string | null = "Author text") => {
    document.body.innerHTML = `<div id="reading" data-controller="${identifier}"
      role="${name === "progress" ? "progressbar" : "meter"}" aria-label="Reading"
      data-${identifier}-value-value="40" ${templateAttribute}="{value}%"></div>`;
    if (original !== null) root().setAttribute("aria-valuetext", original);
    application = Application.start();
    application.register(identifier, Controller);
    await tick();
    expect(root().getAttribute("aria-valuetext")).toBe("40%");
  };

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it.each([null, "", "Author text"])(
    "returns the original %j when the template ends",
    async (original) => {
      await start(original);
      root().removeAttribute(templateAttribute);
      set(60);
      expect(root().getAttribute("aria-valuetext")).toBe(original);
    },
  );

  it("returns the author's original value at disconnect", async () => {
    await start();
    instance().disconnect();
    expect(root().getAttribute("aria-valuetext")).toBe("Author text");
    instance().connect();
    expect(root().getAttribute("aria-valuetext")).toBe("40%");
  });

  it.each(["Page text", null])(
    "keeps an author's later %j across render, release and reconnect",
    async (authored) => {
      await start();
      if (authored === null) root().removeAttribute("aria-valuetext");
      else root().setAttribute("aria-valuetext", authored);
      set(60);
      expect(root().getAttribute("aria-valuetext")).toBe(authored);
      instance().disconnect();
      instance().connect();
      set(80);
      expect(root().getAttribute("aria-valuetext")).toBe(authored);
      root().removeAttribute(templateAttribute);
      set(90);
      expect(root().getAttribute("aria-valuetext")).toBe(authored);
    },
  );

  it("reacquires on an explicit template change and returns the newly authored value", async () => {
    await start();
    root().setAttribute("aria-valuetext", "Page text");
    set(50);
    root().setAttribute(templateAttribute, "Value {value}");
    set(60);
    expect(root().getAttribute("aria-valuetext")).toBe("Value 60");
    root().removeAttribute(templateAttribute);
    set(70);
    expect(root().getAttribute("aria-valuetext")).toBe("Page text");
  });

  it("reacquires when a removed template is set again", async () => {
    await start();
    root().setAttribute("aria-valuetext", "Page text");
    set(50);
    root().removeAttribute(templateAttribute);
    set(60);
    root().setAttribute(templateAttribute, "{value}%");
    set(70);
    expect(root().getAttribute("aria-valuetext")).toBe("70%");
    instance().disconnect();
    expect(root().getAttribute("aria-valuetext")).toBe("Page text");
  });

  it("keeps a yielded value in a copied cache element", async () => {
    await start();
    root().setAttribute("aria-valuetext", "Page text");
    set(50);
    const copy = root().cloneNode(true);
    instance().disconnect();
    root().replaceWith(copy);
    await tick();
    set(60);
    expect(root().getAttribute("aria-valuetext")).toBe("Page text");
  });

  it("returns the original from an active copied cache element", async () => {
    await start();
    const copy = root().cloneNode(true);
    instance().disconnect();
    root().replaceWith(copy);
    await tick();
    root().removeAttribute(templateAttribute);
    set(60);
    expect(root().getAttribute("aria-valuetext")).toBe("Author text");
  });

  it("keeps the latest base reading beneath another owner's temporary text", async () => {
    await start();
    const overlay = new AttributeLease("aria-valuetext", "temporary-reading");
    overlay.write(root(), "Temporary text");
    set(60);
    expect(root().getAttribute("aria-valuetext")).toBe("Temporary text");
    overlay.returnAll();
    expect(root().getAttribute("aria-valuetext")).toBe("60%");
    instance().disconnect();
    expect(root().getAttribute("aria-valuetext")).toBe("Author text");
  });

  it("keeps a live author's edit when a morph drops the ownership records", async () => {
    await start();
    for (const attr of root().getAttributeNames()) {
      if (attr.includes("-lease") || attr.includes("-template")) root().removeAttribute(attr);
    }
    root().setAttribute("aria-valuetext", "Morphed text");
    set(60);
    expect(root().getAttribute("aria-valuetext")).toBe("Morphed text");
  });

  /** A morph to unchanged markup drops the derived text and both records, and nothing else. */
  const resendMarkup = (original: string | null) => {
    for (const attr of root().getAttributeNames()) {
      if (attr.includes("-lease") || attr.includes("-template")) root().removeAttribute(attr);
    }
    if (original === null) root().removeAttribute("aria-valuetext");
    else root().setAttribute("aria-valuetext", original);
  };

  it.each([null, "Author text"])(
    "renders again after a morph re-sends the authored markup %j",
    async (original) => {
      await start(original);
      resendMarkup(original);
      root().dispatchEvent(new Event("turbo:morph-element", { bubbles: true }));
      await tick();
      expect(root().getAttribute("aria-valuetext")).toBe("40%");
      set(70);
      expect(root().getAttribute("aria-valuetext")).toBe("70%");
    },
  );

  it("renders again on reconnect when release sees a morph's drop first", async () => {
    await start(null);
    resendMarkup(null);
    instance().disconnect();
    instance().connect();
    expect(root().getAttribute("aria-valuetext")).toBe("40%");
  });

  it("keeps an author's removal made just before a reconnect", async () => {
    await start(null);
    root().removeAttribute("aria-valuetext");
    instance().disconnect();
    instance().connect();
    set(70);
    expect(root().getAttribute("aria-valuetext")).toBeNull();
  });

  it("keeps a yielded value the author's when it repeats the last generated text", async () => {
    await start();
    root().setAttribute("aria-valuetext", "Page text");
    set(60);
    expect(root().getAttribute("aria-valuetext")).toBe("Page text");
    root().setAttribute("aria-valuetext", "40%");
    set(70);
    expect(root().getAttribute("aria-valuetext")).toBe("40%");
  });
});

/** Indeterminate progress returns value-derived text without erasing authored status wording. */
describe("indeterminate value-text ownership", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  it("returns the original status before dropping the numeric reading", async () => {
    document.body.innerHTML = `<div id="reading" data-controller="stimeo--progress"
      role="progressbar" aria-label="Upload" aria-valuetext="Uploading photos"
      data-stimeo--progress-value-value="40"
      data-stimeo--progress-value-text-value="{percent}%"></div>`;
    application = Application.start();
    application.register("stimeo--progress", ProgressController);
    await tick();
    const root = query("#reading");
    const controller = application.getControllerForElementAndIdentifier(
      root,
      "stimeo--progress",
    ) as ProgressController;
    controller.indeterminateValue = true;
    controller.indeterminateValueChanged();
    await tick();
    expect(root.getAttribute("aria-valuetext")).toBe("Uploading photos");
    expect(root.hasAttribute("aria-valuenow")).toBe(false);
    controller.setValue({ detail: { value: 60 } } as unknown as Event);
    expect(root.getAttribute("aria-valuetext")).toBe("60%");
  });
});
