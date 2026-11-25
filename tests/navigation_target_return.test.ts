import { Application } from "@hotwired/stimulus";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollspyController } from "../src/controllers/scrollspy_controller";
import { StepIndicatorController } from "../src/controllers/step_indicator_controller";
import { StepperController } from "../src/controllers/stepper_controller";
import { ThemeController } from "../src/controllers/theme_controller";
import { disconnectAndStopApplication } from "./helpers/stimulus";
import { tick } from "./helpers/timing";

/** Attribute ownership on navigation items that leave a retained controller. */
describe.each(["theme", "stepper", "step-indicator", "scrollspy"] as const)(
  "%s target return",
  (name) => {
    const identifier = `stimeo--${name}`;
    const target = `data-${identifier}-target`;
    let application: Application;
    let deliver: ((entries: IntersectionObserverEntry[]) => void) | null = null;
    const requireElement = (id: string): HTMLElement => {
      const element = document.getElementById(id);
      if (!(element instanceof HTMLElement)) throw new Error(`${id} missing`);
      return element;
    };
    const constructors = {
      theme: ThemeController,
      stepper: StepperController,
      "step-indicator": StepIndicatorController,
      scrollspy: ScrollspyController,
    };
    const markup = (authored: boolean) => {
      if (name === "theme")
        return `<div id="host" data-controller="${identifier}" data-stimeo--theme-mode-value="light" data-stimeo--theme-storage-key-value="return-theme" role="radiogroup" aria-label="Theme">
          <button id="other" role="radio" data-value="light" ${target}="option" data-action="click->${identifier}#set" ${authored ? 'aria-checked="true" tabindex="0"' : ""}>Light</button>
          <button id="departing" role="radio" data-value="dark" ${target}="option" data-action="click->${identifier}#set" ${authored ? 'aria-checked="false" tabindex="-1"' : ""}>Dark</button>
        </div>`;
      if (name === "stepper")
        return `<ol id="host" data-controller="${identifier}" data-stimeo--stepper-index-value="0">
          <li id="departing" ${target}="step" ${authored ? 'data-state="current"' : ""}><button id="first-button" data-action="click->${identifier}#goto" data-stimeo--stepper-index-param="0" ${authored ? 'aria-current="step"' : ""}>First</button></li>
          <li id="other" ${target}="step"><button id="second-button" data-action="click->${identifier}#goto" data-stimeo--stepper-index-param="1">Second</button></li>
        </ol>`;
      if (name === "step-indicator")
        return `<ol id="host" data-controller="${identifier}" data-stimeo--step-indicator-index-value="1">
          <li id="other" ${target}="step">First</li><li id="departing" ${target}="step" ${authored ? 'aria-current="false"' : ""}>Second</li><li ${target}="step">Third</li>
        </ol>`;
      return `<nav id="host" data-controller="${identifier}" data-stimeo--scrollspy-offset-value="80">
        <a id="departing" href="#intro" ${target}="link" ${authored ? 'aria-current="false"' : ""}>Intro</a><a id="other" href="#usage" ${target}="link">Usage</a>
      </nav><section id="intro">Intro</section><section id="usage">Usage</section>`;
    };
    const watched = () => {
      if (name === "theme")
        return [[requireElement("departing"), ["aria-checked", "tabindex"]]] as const;
      if (name === "stepper")
        return [
          [requireElement("departing"), ["data-state"]],
          [requireElement("first-button"), ["aria-current"]],
        ] as const;
      return [
        [
          requireElement("departing"),
          name === "scrollspy" ? ["aria-current"] : ["aria-current", "data-state"],
        ],
      ] as const;
    };
    const prepare = (authored: boolean) => {
      document.body.innerHTML = markup(authored);
      return watched().map(([element, attributes]) => ({
        element,
        attributes: attributes.map((attribute) => ({
          attribute,
          original: element.getAttribute(attribute),
        })),
      }));
    };
    const start = async () => {
      if (name === "scrollspy") {
        vi.stubGlobal(
          "IntersectionObserver",
          class {
            constructor(callback: IntersectionObserverCallback) {
              deliver = (entries) => callback(entries, this as unknown as IntersectionObserver);
            }
            observe(): void {}
            disconnect(): void {}
          },
        );
      }
      application = Application.start();
      application.register(identifier, constructors[name]);
      await tick();
      if (name === "theme") requireElement("departing").click();
      if (name === "stepper") requireElement("second-button").click();
      if (name === "scrollspy") {
        const sections = [requireElement("intro"), requireElement("usage")];
        sections.forEach((section, index) => {
          section.getBoundingClientRect = () => new DOMRect(0, index === 0 ? 90 : 400, 800, 500);
        });
        deliver?.(
          sections.map((section) => ({
            target: section,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: section.getBoundingClientRect(),
            intersectionRect: section.getBoundingClientRect(),
            rootBounds: null,
            time: 0,
          })),
        );
      }
      await tick();
    };

    afterEach(() => {
      disconnectAndStopApplication(application);
      document.body.innerHTML = "";
      localStorage.removeItem("return-theme");
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.style.removeProperty("color-scheme");
      deliver = null;
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    for (const authored of [false, true]) {
      for (const departure of ["token", "identifier"] as const) {
        it(`returns authored=${authored} attributes after ${departure} departure`, async () => {
          const facts = prepare(authored);
          await start();
          expect(
            facts.some(({ element, attributes }) =>
              attributes.some(
                ({ attribute, original }) => element.getAttribute(attribute) !== original,
              ),
            ),
          ).toBe(true);
          const change = vi.fn();
          requireElement("host").addEventListener(`${identifier}:change`, change);
          if (departure === "token") requireElement("departing").removeAttribute(target);
          else requireElement("host").removeAttribute("data-controller");
          await tick();
          for (const { element, attributes } of facts)
            for (const { attribute, original } of attributes)
              expect(element.getAttribute(attribute)).toBe(
                attribute === "data-state" ? null : original,
              );
          expect(change).not.toHaveBeenCalled();
        });
      }
    }

    it("keeps a page's later ARIA and tabindex values when the target leaves", async () => {
      const facts = prepare(false);
      await start();
      for (const { element, attributes } of facts)
        for (const { attribute } of attributes)
          if (attribute !== "data-state")
            element.setAttribute(attribute, attribute === "tabindex" ? "7" : "page");
      requireElement("departing").removeAttribute(target);
      await tick();
      for (const { element, attributes } of facts)
        for (const { attribute } of attributes)
          expect(element.getAttribute(attribute)).toBe(
            attribute === "data-state" ? null : attribute === "tabindex" ? "7" : "page",
          );
    });

    it("returns the author's attributes from a restored copy's lease records", async () => {
      const facts = prepare(true);
      const expected = facts.map(({ element, attributes }) => ({ id: element.id, attributes }));
      await start();
      const copy = requireElement("host").cloneNode(true) as HTMLElement;
      disconnectAndStopApplication(application);
      requireElement("host").replaceWith(copy);
      application = Application.start();
      application.register(identifier, constructors[name]);
      await tick();
      requireElement("departing").removeAttribute(target);
      await tick();
      for (const { id, attributes } of expected)
        for (const { attribute, original } of attributes)
          expect(requireElement(id).getAttribute(attribute)).toBe(
            attribute === "data-state" ? null : original,
          );
    });

    it("keeps the rendered attributes during an in-widget move", async () => {
      prepare(false);
      await start();
      const facts = watched().map(
        ([element, attributes]) =>
          [
            element,
            attributes.map((attribute) => [attribute, element.getAttribute(attribute)] as const),
          ] as const,
      );
      const wrapper = document.createElement("div");
      const departing = requireElement("departing");
      departing.before(wrapper);
      wrapper.append(departing);
      await tick();
      for (const [element, attributes] of facts)
        for (const [attribute, value] of attributes)
          expect(element.getAttribute(attribute)).toBe(value);
    });

    it("keeps the rendered attributes when the whole controller is removed", async () => {
      prepare(false);
      await start();
      const facts = watched().map(
        ([element, attributes]) =>
          [
            element,
            attributes.map((attribute) => [attribute, element.getAttribute(attribute)] as const),
          ] as const,
      );
      requireElement("host").remove();
      await tick();
      for (const [element, attributes] of facts)
        for (const [attribute, value] of attributes)
          expect(element.getAttribute(attribute)).toBe(value);
    });

    if (name === "stepper")
      it("returns the old navigation button before borrowing a replacement's current state", async () => {
        prepare(true);
        await start();
        const previous = requireElement("first-button");
        const replacement = document.createElement("button");
        replacement.setAttribute("aria-current", "page");
        previous.replaceWith(replacement);
        requireElement("departing").dispatchEvent(
          new CustomEvent("turbo:morph-element", { bubbles: true }),
        );
        await tick();
        expect(previous.getAttribute("aria-current")).toBe("step");
        expect(replacement.hasAttribute("aria-current")).toBe(false);
        requireElement("departing").removeAttribute(target);
        await tick();
        expect(replacement.getAttribute("aria-current")).toBe("page");
      });
  },
);
