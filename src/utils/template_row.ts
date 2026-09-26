import { fillTemplate } from "./announce";
import { matchingPart } from "./element_part";
import { targetSelector } from "./target_selector";

/**
 * Clones the first element of a `<template>`, and nothing else.
 *
 * A template is authored across lines, so its content holds whitespace text nodes
 * around that element — and a second element, where one is written. Cloning the
 * element on its own makes it the whole unit the caller appends, so the same node
 * a later `remove()` takes back is everything that went in, and the parent's child
 * list stays equal to its element list.
 *
 * `null` when the content has no element at all.
 */
export function cloneTemplateRoot(template: HTMLTemplateElement): HTMLElement | null {
  const root = template.content.firstElementChild;
  return root instanceof HTMLElement ? (root.cloneNode(true) as HTMLElement) : null;
}

/** What a consumer declares once about the rows it builds from a `<template>`. */
export interface TemplateRowOptions<R extends string, O extends string> {
  /** The controller identifier the row's parts are declared against. */
  readonly identifier: string;
  /** Target name the row itself carries. */
  readonly root: string;
  /** Target names the row must contain; the first one missing is the one reported. */
  readonly required: readonly R[];
  /** Target names the row may contain; a missing one resolves to `null`. */
  readonly optional?: readonly O[];
  /** Target name of the `<button>` whose authored `aria-label` names the row. */
  readonly button: string;
  /** What the widget did not do, e.g. `"added no tag"`. */
  readonly outcome: string;
  /** What the author wrote it in, e.g. `"chip template"`. */
  readonly noun: string;
}

/** One row: the element to append, the parts inside it, and its named button. */
export interface TemplateRowParts<R extends string, O extends string> {
  readonly root: HTMLElement;
  readonly slots: Readonly<Record<R, HTMLElement> & Record<O, HTMLElement | null>>;
  readonly button: HTMLButtonElement;
}

/**
 * Builds one row from an authored `<template>`, naming an unusable one once per connection.
 *
 * **The row is the template's only element, and it carries {@link
 * TemplateRowOptions.root} itself.** Cloning it alone ({@link cloneTemplateRoot})
 * makes what the caller appends exactly what a later `remove()` takes back; a row
 * wrapped in another element, or standing beside a second one, would leave that
 * other element behind on every removal — or never be rendered at all — so such a
 * template is refused rather than half-built.
 *
 * Parts resolve through the caller's own namespace, derived from the identifier
 * the controller is registered under, so a registration under any name reaches
 * the attributes that registration renders.
 *
 * A template that cannot produce a row yields `null` and changes nothing: what a
 * refused row means for the selection, the field, or the announcement stays with
 * the caller. The diagnostic names what is wrong — the element count, or the first
 * missing part — because the only other symptom is a widget that silently adds
 * nothing, and the causes a static check cannot see — a server-rendered template,
 * a name that renders empty from a missing translation — would have no diagnostic
 * anywhere. It is written once per connection, so one authoring mistake cannot
 * flood the console.
 *
 * @example
 * ```ts
 * readonly #rows = new TemplateRow({
 *   identifier: this.identifier,
 *   root: "tag",
 *   required: ["label"],
 *   button: "remove",
 *   outcome: "added no tag",
 *   noun: "chip template",
 * });
 *
 * connect(): void {
 *   this.#rows.connect();
 * }
 * ```
 */
export class TemplateRow<R extends string, O extends string = never> {
  readonly #options: TemplateRowOptions<R, O>;
  #warned = false;

  constructor(options: TemplateRowOptions<R, O>) {
    this.#options = options;
  }

  /** The attribute selector for one declared part, in this controller's namespace. */
  selector(name: string): string {
    return targetSelector(this.#options.identifier, name);
  }

  /** Re-arms the once-per-connection diagnostic. */
  connect(): void {
    this.#warned = false;
  }

  /**
   * Names one missing part on the console, at most once per connection, and
   * returns `null` so a caller can hand it straight back.
   */
  report(missing: string): null {
    return this.#say(`lacks ${missing}`);
  }

  /** Writes one diagnostic per connection, saying what the template got wrong. */
  #say(problem: string): null {
    if (this.#warned) return null;
    this.#warned = true;
    const { identifier, outcome, noun } = this.#options;
    console.warn(`Stimeo UI: "${identifier}" ${outcome} because its ${noun} ${problem}.`);
    return null;
  }

  /**
   * Clones the row and resolves its parts, or names what the template got wrong
   * and returns `null`. `values` fills the button's authored `aria-label`.
   */
  instantiate(
    template: HTMLTemplateElement,
    values: Record<string, string | number>,
  ): TemplateRowParts<R, O> | null {
    const { root: rootName, required, optional, button: buttonName } = this.#options;
    const root = cloneTemplateRoot(template);
    if (!root?.matches(this.selector(rootName))) {
      return this.report(`${this.#article(rootName)} "${rootName}" root`);
    }
    // One element, and it is the row: anything beside it would be left behind by
    // a removal that takes the row back, which is the accumulation this contract
    // exists to stop. The row here is the one that was asked for, so the count is
    // what the diagnostic names — a missing part would point at the wrong element.
    const count = template.content.children.length;
    if (count !== 1) {
      return this.#say(`holds ${count} elements, and the row has to be its only one`);
    }
    // Required parts are resolved before they are written, so the declared shape
    // holds for every row returned at all — a missing one leaves through `report`
    // instead. The accumulator is keyed loosely because that ordering is what
    // makes the narrower return type true, and no index signature can say so.
    const slots: Record<string, HTMLElement | null> = {};
    for (const name of required) {
      const part = this.#resolve(root, name);
      if (!part) return this.report(`${this.#article(name)} "${name}" target`);
      slots[name] = part;
    }
    for (const name of optional ?? []) slots[name] = this.#resolve(root, name);
    const named = this.#resolve(root, buttonName);
    if (!(named instanceof HTMLButtonElement)) {
      return this.report(`${this.#article(buttonName)} "${buttonName}" target <button>`);
    }
    const button = named;
    const name = button.getAttribute("aria-label")?.trim() ?? "";
    if (name === "") return this.report(`a non-empty aria-label on its "${buttonName}" target`);
    button.setAttribute("aria-label", fillTemplate(name, values));
    return { root, slots, button } as TemplateRowParts<R, O>;
  }

  /** The row may be its own part; otherwise the first descendant carrying the target. */
  #resolve(root: HTMLElement, name: string): HTMLElement | null {
    return matchingPart(root, this.selector(name));
  }

  #article(name: string): string {
    return /^[aeiou]/i.test(name) ? "an" : "a";
  }
}
