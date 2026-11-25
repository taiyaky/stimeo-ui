import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CarouselController } from "../src/controllers/carousel_controller";
import { AttributeLease } from "../src/utils/attribute_lease";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

const markup = `
  <div id="source"><section id="carousel" data-controller="stimeo--carousel">
    <div data-stimeo--carousel-target="viewport">
      <div id="slide-one" data-stimeo--carousel-target="slide"
           data-state="authored-one" hidden inert>One</div>
      <div id="slide-two" data-stimeo--carousel-target="slide"
           data-state="authored-two">Two</div>
    </div>
    <div role="tablist">
      <button id="picker-one" data-stimeo--carousel-target="picker"
              aria-selected="authored-one" tabindex="7"></button>
      <button id="picker-two" data-stimeo--carousel-target="picker"
              aria-selected="authored-two" tabindex="8"></button>
    </div>
  </section></div>`;

describe("Carousel target attribute leases", () => {
  let application: Application;

  const start = async () => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register("stimeo--carousel", CarouselController);
    await tick();
  };

  afterEach(() => {
    if (application) disconnectAndStopApplication(application);
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("returns authored slide and picker attributes when their target marker leaves", async () => {
    await start();
    const slide = document.getElementById("slide-one") as HTMLElement;
    const picker = document.getElementById("picker-one") as HTMLElement;

    slide.removeAttribute("data-stimeo--carousel-target");
    picker.removeAttribute("data-stimeo--carousel-target");
    await tick();

    expect(slide.getAttribute("data-state")).toBe("authored-one");
    expect(slide.hasAttribute("hidden")).toBe(true);
    expect(slide.hasAttribute("inert")).toBe(true);
    expect(picker.getAttribute("aria-selected")).toBe("authored-one");
    expect(picker.getAttribute("tabindex")).toBe("7");
    expect(slide.hasAttribute("data-stimeo--carousel-data-state-lease")).toBe(false);
    expect(picker.hasAttribute("data-stimeo--carousel-tabindex-lease")).toBe(false);
  });

  it("returns target attributes when the controller identifier leaves", async () => {
    await start();
    const root = document.getElementById("carousel") as HTMLElement;
    const slide = document.getElementById("slide-one") as HTMLElement;
    const picker = document.getElementById("picker-one") as HTMLElement;

    root.removeAttribute("data-controller");
    await tick();

    expect(slide.getAttribute("data-state")).toBe("authored-one");
    expect(slide.hasAttribute("hidden")).toBe(true);
    expect(slide.hasAttribute("inert")).toBe(true);
    expect(picker.getAttribute("aria-selected")).toBe("authored-one");
    expect(picker.getAttribute("tabindex")).toBe("7");
  });

  it("returns leases written to a new pair before target callbacks observe it", async () => {
    await start();
    const root = document.getElementById("carousel") as HTMLElement;
    const viewport = root.querySelector<HTMLElement>('[data-stimeo--carousel-target="viewport"]');
    const tablist = root.querySelector<HTMLElement>('[role="tablist"]');
    const carousel = application.getControllerForElementAndIdentifier(root, "stimeo--carousel");
    if (!viewport || !tablist || !(carousel instanceof CarouselController)) {
      throw new Error("Missing carousel fixture");
    }
    const slide = document.createElement("div");
    slide.setAttribute("data-stimeo--carousel-target", "slide");
    slide.setAttribute("data-state", "authored-late");
    const picker = document.createElement("button");
    picker.type = "button";
    picker.setAttribute("data-stimeo--carousel-target", "picker");
    picker.setAttribute("aria-selected", "authored-late");
    picker.tabIndex = 7;
    viewport.append(slide);
    tablist.append(picker);

    carousel.next();

    expect(slide.getAttribute("data-state")).toBe("inactive");
    expect(slide.hidden).toBe(true);
    expect(slide.hasAttribute("inert")).toBe(true);
    expect(picker.getAttribute("aria-selected")).toBe("false");
    expect(picker.tabIndex).toBe(-1);

    root.removeAttribute("data-controller");
    await tick();

    expect(slide.getAttribute("data-state")).toBe("authored-late");
    expect(slide.hidden).toBe(false);
    expect(slide.hasAttribute("inert")).toBe(false);
    expect(picker.getAttribute("aria-selected")).toBe("authored-late");
    expect(picker.tabIndex).toBe(7);
  });

  it("returns a page-written tab stop after a picker joins the carousel", async () => {
    await start();
    const tablist = document.querySelector('[role="tablist"]');
    if (!tablist) throw new Error("Missing carousel tablist");
    const picker = document.createElement("button");
    const target = "data-stimeo--carousel-target";
    picker.setAttribute(target, "picker");
    picker.tabIndex = 7;
    tablist.append(picker);
    queueMicrotask(() => {
      picker.tabIndex = 9;
    });
    await tick();
    expect(picker.tabIndex).toBe(-1);

    picker.removeAttribute(target);
    await tick();
    expect(picker.tabIndex).toBe(9);
  });

  it("keeps leases when a target moves within its controller scope", async () => {
    await start();
    const root = document.getElementById("carousel") as HTMLElement;
    const slide = document.getElementById("slide-one") as HTMLElement;
    const marker = "data-stimeo--carousel-data-state-lease";
    const returnLease = vi.spyOn(AttributeLease.prototype, "return");

    root.append(slide);
    await tick();

    expect(slide.hasAttribute(marker)).toBe(true);
    expect(returnLease.mock.calls.some(([element]) => element === slide)).toBe(false);
  });

  it("keeps leases when its controller moves within the page", async () => {
    await start();
    const root = document.getElementById("carousel") as HTMLElement;
    const slide = document.getElementById("slide-one") as HTMLElement;
    const marker = "data-stimeo--carousel-data-state-lease";
    const returnLease = vi.spyOn(AttributeLease.prototype, "return");
    const destination = document.createElement("aside");
    document.body.append(destination);
    destination.append(root);
    await tick();

    expect(slide.getAttribute("data-state")).toBe("active");
    expect(slide.hasAttribute(marker)).toBe(true);
    expect(root.isConnected).toBe(true);
    expect(returnLease.mock.calls.some(([element]) => element === slide)).toBe(false);
  });

  it("keeps the active picker's Tab stop on a move that keeps its position", async () => {
    await start();
    const picker = document.getElementById("picker-one") as HTMLElement;
    const container = picker.parentElement as HTMLElement;
    const wrapper = document.createElement("span");
    container.prepend(wrapper);
    await tick();
    const writes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => writes.push(...records));
    observer.observe(picker, { attributeFilter: ["tabindex"] });

    wrapper.append(picker);
    await tick();
    writes.push(...observer.takeRecords());
    observer.disconnect();

    expect(picker.tabIndex).toBe(0);
    expect(writes).toEqual([]);
  });
});
