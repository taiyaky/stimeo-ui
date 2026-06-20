import { Controller } from "@hotwired/stimulus";

/**
 * Headless **nested / dynamic fields** for Rails `fields_for` +
 * `accepts_nested_attributes_for` (no dedicated APG pattern — form editing). The
 * Headless successor to the cocoon / nested_form gems: clone a `<template>` row,
 * renumber its index, and remove rows by flagging `_destroy` (persisted) or
 * dropping them from the DOM (unsaved).
 *
 * Markup contract (identifier: `stimeo--nested-form`):
 *   <div data-controller="stimeo--nested-form" data-stimeo--nested-form-min-value="1">
 *     <div data-stimeo--nested-form-target="list">
 *       <!-- existing rows; a persisted row carries a _destroy flag + remove button -->
 *     </div>
 *     <template data-stimeo--nested-form-target="template">
 *       <fieldset>
 *         <input name="order[items_attributes][__INDEX__][name]">
 *         <button type="button" data-stimeo--nested-form-target="remove">Remove</button>
 *       </fieldset>
 *     </template>
 *     <button type="button" data-stimeo--nested-form-target="add"
 *             data-action="click->stimeo--nested-form#add">Add</button>
 *   </div>
 *
 * @remarks
 * Behavior only — server-side `accepts_nested_attributes_for`, per-field
 * validation, and reordering are out of scope. Row state lives **only** in the DOM
 * (inserted nodes + each `_destroy` hidden input); there is no module-scope index
 * counter, so the controller stays idempotent across Turbo swaps. Remove buttons
 * are handled by **delegation** on the container, so dynamically-added rows work
 * without per-row `data-action` (see `stimulus-lifecycle-turbo`). Adding a row moves
 * focus to its first control and removing returns focus to a neighbor (WCAG 2.2
 * 2.4.3); count changes are announced through the shared `stimeo--announcer`
 * (WCAG 2.2 4.1.3) when `announce` + `countMessage` are set. The delegated listener
 * is removed on `disconnect()`.
 */
export class NestedFormController extends Controller<HTMLElement> {
  static override targets = ["list", "template", "add", "remove", "destroyFlag"];
  static override values = {
    min: { type: Number, default: 0 },
    max: { type: Number, default: 0 },
    indexPlaceholder: { type: String, default: "__INDEX__" },
    announce: { type: Boolean, default: true },
    countMessage: { type: String, default: "" },
  };
  static actions = ["add"] as const;
  static events = ["add", "remove"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly templateTarget: HTMLTemplateElement;
  declare readonly addTarget: HTMLButtonElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasTemplateTarget: boolean;
  declare readonly hasAddTarget: boolean;

  declare minValue: number;
  declare maxValue: number;
  declare indexPlaceholderValue: string;
  declare announceValue: boolean;
  declare countMessageValue: string;

  /** Monotonic source for unique row indices; never a row-state counter. */
  #lastIndex = 0;

  /** Delegated click handler for the per-row remove buttons (dynamic-safe). */
  readonly #onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('[data-stimeo--nested-form-target="remove"]');
    if (!button || !this.element.contains(button)) return;
    const row = this.#rowContaining(button);
    if (row) this.#removeRow(row);
  };

  override connect(): void {
    this.element.addEventListener("click", this.#onClick);
    this.#refresh();
  }

  override disconnect(): void {
    this.element.removeEventListener("click", this.#onClick);
  }

  /**
   * Clones the template row, replaces the index placeholder with a unique value,
   * appends it, focuses its first control, and announces the new count. No-ops at
   * `max`.
   */
  add(): void {
    if (!this.hasTemplateTarget || !this.hasListTarget || this.#atMax) return;

    const index = this.#nextIndex();
    const markup = this.templateTarget.innerHTML.replaceAll(
      this.indexPlaceholderValue,
      String(index),
    );
    this.listTarget.insertAdjacentHTML("beforeend", markup);
    const row = this.listTarget.lastElementChild as HTMLElement | null;
    if (!row) return;

    this.#refresh();
    this.#firstControl(row)?.focus();
    this.dispatch("add", { detail: { index, element: row } });
    this.#announce();
  }

  /**
   * Removes a row: a persisted row (one carrying a `destroyFlag`) has its flag set
   * to `1` and is hidden so Rails destroys it on submit; an unsaved row is dropped
   * from the DOM. Returns focus to a neighboring row. No-ops at `min`.
   */
  #removeRow(row: HTMLElement): void {
    if (this.#effectiveRows.length <= this.minValue) return;

    const neighbors = this.#effectiveRows;
    const position = neighbors.indexOf(row);
    const neighbor = neighbors[position + 1] ?? neighbors[position - 1] ?? null;

    const flag = row.querySelector<HTMLInputElement>(
      '[data-stimeo--nested-form-target="destroyFlag"]',
    );
    const persisted = flag !== null;
    if (persisted) {
      flag.value = "1";
      row.hidden = true;
    } else {
      row.remove();
    }

    this.#refresh();
    const focusTarget = neighbor
      ? this.#firstControl(neighbor)
      : this.hasAddTarget
        ? this.addTarget
        : null;
    focusTarget?.focus();
    this.dispatch("remove", { detail: { element: row, persisted } });
    this.#announce();
  }

  /** Recomputes the live count and the min/max state hooks from the DOM. */
  #refresh(): void {
    const count = this.#effectiveRows.length;
    this.element.setAttribute("data-nested-count", String(count));
    this.#reflect("data-nested-at-max", this.maxValue > 0 && count >= this.maxValue);
    this.#reflect("data-nested-at-min", count <= this.minValue);
    if (this.hasAddTarget) this.addTarget.disabled = this.#atMax;
  }

  /** Bridges the count change to the shared announcer when configured. */
  #announce(): void {
    if (!this.announceValue || !this.countMessageValue) return;
    const message = this.countMessageValue.replaceAll(
      "{count}",
      String(this.#effectiveRows.length),
    );
    window.dispatchEvent(new CustomEvent("stimeo--announcer:announce", { detail: { message } }));
  }

  /** Sets `attribute` to `"true"` when `on`, else removes it. */
  #reflect(attribute: string, on: boolean): void {
    if (on) this.element.setAttribute(attribute, "true");
    else this.element.removeAttribute(attribute);
  }

  /** A strictly-increasing unique index (collision-free even on rapid adds). */
  #nextIndex(): number {
    const index = Math.max(Date.now(), this.#lastIndex + 1);
    this.#lastIndex = index;
    return index;
  }

  get #atMax(): boolean {
    return this.maxValue > 0 && this.#effectiveRows.length >= this.maxValue;
  }

  /** Direct child rows of the list that are not flagged for destruction. */
  get #effectiveRows(): HTMLElement[] {
    return (Array.from(this.listTarget.children) as HTMLElement[]).filter((row) => !row.hidden);
  }

  /** The nearest ancestor of `el` that is a direct child of the list, else null. */
  #rowContaining(el: Element): HTMLElement | null {
    let node: Element | null = el;
    while (node && node.parentElement !== this.listTarget) {
      node = node.parentElement;
    }
    return node as HTMLElement | null;
  }

  /** First visible focusable control inside `row` (skips hidden inputs). */
  #firstControl(row: HTMLElement): HTMLElement | null {
    return row.querySelector<HTMLElement>(
      'input:not([type="hidden"]), select, textarea, button, [tabindex]',
    );
  }
}
