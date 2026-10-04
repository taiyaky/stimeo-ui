import { Application, type ControllerConstructor } from "@hotwired/stimulus";
import { afterEach, describe, expect, it } from "vitest";
import { AccordionController } from "../src/controllers/accordion_controller";
import { CarouselController } from "../src/controllers/carousel_controller";
import { DismissibleController } from "../src/controllers/dismissible_controller";
import { PasswordRevealController } from "../src/controllers/password_reveal_controller";
import { ReadMoreController } from "../src/controllers/read_more_controller";
import { disconnectAndStopApplication, restoreFromCache } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/**
 * An element that stops resolving as a target, while its token goes and the element stays.
 *
 * A component gives such an element back what the author wrote: the label pair of a host it
 * reflected, as `StateRegions.release` hands it back, and the attributes it leased there.
 * Each case drops the token on the page that stays and, where a copy is involved, on a page
 * restored from the cache.
 */
describe("an element that stops resolving as a target", () => {
  let application: Application;

  afterEach(() => {
    disconnectAndStopApplication(application);
    document.body.innerHTML = "";
  });

  const mount = async (identifier: string, controller: ControllerConstructor, markup: string) => {
    document.body.innerHTML = markup;
    application = Application.start();
    application.register(identifier, controller);
    await tick();
  };
  const instance = (identifier: string) =>
    application.getControllerForElementAndIdentifier(
      document.querySelector(`[data-controller~="${identifier}"]`) as HTMLElement,
      identifier,
    ) as unknown as Record<string, (element: Element) => void>;
  /** Drops `target` from the element's target tokens and runs the departure callback. */
  const depart = async (identifier: string, target: string, element: HTMLElement) => {
    element.removeAttribute(`data-${identifier}-target`);
    await tick();
    instance(identifier)[`${target}TargetDisconnected`]?.call(instance(identifier), element);
  };
  const hiddenOf = (root: ParentNode, selector: string) =>
    Array.from(root.querySelectorAll(selector), (element) => element.getAttribute("hidden"));
  const records = (root: Element) =>
    [root, ...root.querySelectorAll("*")].flatMap((element) =>
      element
        .getAttributeNames()
        .filter((name) => /-(lease|hidden-region|tabindex-loan)$/.test(name)),
    );

  it("accordion: gives a header that stops being a trigger its label pair back", async () => {
    await mount(
      "stimeo--accordion",
      AccordionController,
      `<div data-controller="stimeo--accordion">
         <h3><button id="b1" data-stimeo--accordion-target="trigger" aria-expanded="false" aria-controls="p1">
           <span data-stimeo--accordion-target="expandedLabel">Hide</span>
           <span data-stimeo--accordion-target="collapsedLabel">Show</span>
         </button></h3>
         <div id="p1" data-stimeo--accordion-target="panel" role="region" aria-labelledby="b1" hidden>Panel</div>
       </div>`,
    );
    const header = document.getElementById("b1") as HTMLElement;
    expect(hiddenOf(header, "span")).toEqual(["", null]);

    await depart("stimeo--accordion", "trigger", header);

    expect(hiddenOf(header, "span")).toEqual([null, null]);
    expect(records(header)).toEqual([]);
  });

  it("read-more: gives a button that stops being the trigger its label pair back", async () => {
    await mount(
      "stimeo--read-more",
      ReadMoreController,
      `<div data-controller="stimeo--read-more">
         <p id="bio" data-stimeo--read-more-target="content">A long biography.</p>
         <button id="more" data-stimeo--read-more-target="trigger" aria-expanded="false" aria-controls="bio">
           <span data-stimeo--read-more-target="expandedLabel">Show less</span>
           <span data-stimeo--read-more-target="collapsedLabel">Read more</span>
         </button>
       </div>`,
    );
    const trigger = document.getElementById("more") as HTMLElement;
    expect(hiddenOf(trigger, "span")).toEqual(["", null]);

    await depart("stimeo--read-more", "trigger", trigger);

    expect(hiddenOf(trigger, "span")).toEqual([null, null]);
    expect(records(trigger)).toEqual([]);
  });

  /** A non-looping carousel at its first slide: `prev` cannot step, so it is `aria-disabled`. */
  const carousel = `<section data-controller="stimeo--carousel" aria-roledescription="carousel" aria-label="Featured"
       data-stimeo--carousel-autoplay-value="false" data-stimeo--carousel-loop-value="false">
     <button id="toggle" aria-label="Slide autoplay" data-stimeo--carousel-target="playToggle">
       <span data-stimeo--carousel-target="onLabel">Pause</span>
       <span data-stimeo--carousel-target="offLabel">Play</span>
     </button>
     <div data-stimeo--carousel-target="viewport">
       <div data-stimeo--carousel-target="slide">One</div>
       <div data-stimeo--carousel-target="slide">Two</div>
     </div>
     <button id="prev" data-stimeo--carousel-target="prev">Prev</button>
     <button id="next" data-stimeo--carousel-target="next">Next</button>
   </section>`;

  it("carousel: gives a button that stops being the play toggle its label pair back", async () => {
    await mount("stimeo--carousel", CarouselController, carousel);
    const toggle = document.getElementById("toggle") as HTMLElement;
    expect(hiddenOf(toggle, "span")).toEqual(["", null]);

    await depart("stimeo--carousel", "playToggle", toggle);

    expect(hiddenOf(toggle, "span")).toEqual([null, null]);
    expect(records(toggle)).toEqual([]);
  });

  /** A carousel with one slide: nothing to step to or rotate, so every control is `aria-disabled`. */
  const single = carousel.replace('<div data-stimeo--carousel-target="slide">Two</div>', "");

  it.each(["playToggle", "next"])(
    "carousel: gives a button that stops being the %s control its aria-disabled back",
    async (target) => {
      await mount("stimeo--carousel", CarouselController, single);
      const button = document.getElementById(target === "next" ? "next" : "toggle") as HTMLElement;
      expect(button.getAttribute("aria-disabled")).toBe("true");

      await depart("stimeo--carousel", target, button);

      expect(button.hasAttribute("aria-disabled")).toBe(false);
      expect(records(button)).toEqual([]);
    },
  );

  it.each(["the page that stays", "a restored page"])(
    "carousel: gives a button that stops being the play toggle its aria-pressed back, on %s",
    async (where) => {
      await mount("stimeo--carousel", CarouselController, carousel);
      expect(document.getElementById("toggle")?.getAttribute("aria-pressed")).toBe("false");
      if (where === "a restored page") {
        application = await restoreFromCache(application, (restored) =>
          restored.register("stimeo--carousel", CarouselController),
        );
      }
      const toggle = document.getElementById("toggle") as HTMLElement;

      await depart("stimeo--carousel", "playToggle", toggle);

      expect(toggle.hasAttribute("aria-pressed")).toBe(false);
      expect(records(toggle)).toEqual([]);
    },
  );

  it("carousel: keeps what it wrote on a play toggle that moves within the carousel", async () => {
    await mount("stimeo--carousel", CarouselController, single);
    const toggle = document.getElementById("toggle") as HTMLElement;
    (document.getElementById("next") as HTMLElement).after(toggle);
    await tick();

    instance("stimeo--carousel").playToggleTargetDisconnected?.call(
      instance("stimeo--carousel"),
      toggle,
    );

    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(hiddenOf(toggle, "span")).toEqual(["", null]);
  });

  it.each(["the page that stays", "a restored page"])(
    "carousel: gives a button that stops being the prev control its aria-disabled back, on %s",
    async (where) => {
      await mount("stimeo--carousel", CarouselController, carousel);
      expect(document.getElementById("prev")?.getAttribute("aria-disabled")).toBe("true");
      if (where === "a restored page") {
        application = await restoreFromCache(application, (restored) =>
          restored.register("stimeo--carousel", CarouselController),
        );
      }
      const prev = document.getElementById("prev") as HTMLElement;

      await depart("stimeo--carousel", "prev", prev);

      expect(prev.hasAttribute("aria-disabled")).toBe(false);
      expect(records(prev)).toEqual([]);
    },
  );

  it.each(["the page that stays", "a restored page"])(
    "dismissible: gives the controller element its own data-state back once a root arrives, on %s",
    async (where) => {
      await mount(
        "stimeo--dismissible",
        DismissibleController,
        `<div id="host" data-controller="stimeo--dismissible"><p>Saved.</p></div>`,
      );
      expect(document.getElementById("host")?.getAttribute("data-state")).toBe("open");
      if (where === "a restored page") {
        application = await restoreFromCache(application, (restored) =>
          restored.register("stimeo--dismissible", DismissibleController),
        );
      }
      const host = document.getElementById("host") as HTMLElement;
      const root = document.createElement("div");
      root.setAttribute("data-stimeo--dismissible-target", "root");
      host.append(root);
      await tick();
      instance("stimeo--dismissible").rootTargetConnected?.call(
        instance("stimeo--dismissible"),
        root,
      );

      expect(host.hasAttribute("data-state")).toBe(false);
      expect(host.getAttributeNames().filter((name) => name.endsWith("-lease"))).toEqual([]);
      expect(root.getAttribute("data-state")).toBe("open");
    },
  );

  it.each(["the page that stays", "a restored page"])(
    "password-reveal: a revealed field that stops being the first is masked, with no record left, on %s",
    async (where) => {
      await mount(
        "stimeo--password-reveal",
        PasswordRevealController,
        `<div data-controller="stimeo--password-reveal">
           <input id="former" type="password" aria-label="Password" data-stimeo--password-reveal-target="input">
           <button type="button" aria-pressed="false" aria-label="Show password" data-stimeo--password-reveal-target="toggle">Show</button>
         </div>`,
      );
      instance("stimeo--password-reveal").toggle?.call(
        instance("stimeo--password-reveal"),
        document.body,
      );
      expect((document.getElementById("former") as HTMLInputElement).type).toBe("text");
      if (where === "a restored page") {
        application = await restoreFromCache(application, (restored) =>
          restored.register("stimeo--password-reveal", PasswordRevealController),
        );
      }
      const former = document.getElementById("former") as HTMLInputElement;
      // The instance that connects to a copy masks the field it carries revealed, from the record.
      expect(former.type).toBe(where === "a restored page" ? "password" : "text");
      const ahead = document.createElement("input");
      ahead.type = "password";
      ahead.setAttribute("aria-label", "Password");
      ahead.setAttribute("data-stimeo--password-reveal-target", "input");
      former.before(ahead);
      await tick();
      instance("stimeo--password-reveal").inputTargetConnected?.call(
        instance("stimeo--password-reveal"),
        ahead,
      );

      expect(former.type).toBe("password");
      expect(former.getAttributeNames().filter((name) => name.endsWith("-lease"))).toEqual([]);
    },
  );
});
