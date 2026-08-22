import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { firstTabStop, isTabStop } from "../utils/focus_candidate";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { TabindexLoan } from "../utils/tabindex_loan";

/** Selects any nested-form root; the nearest one is an element's owning instance. */
const ROOT_SELECTOR = '[data-controller~="stimeo--nested-form"]';
/** Selects per-row remove buttons (resolved through delegation, never per-row wiring). */
const REMOVE_SELECTOR = '[data-stimeo--nested-form-target="remove"]';
/** Selects the hidden `_destroy` input a persisted row carries. */
const DESTROY_FLAG_SELECTOR = '[data-stimeo--nested-form-target="destroyFlag"]';

/** `_destroy` values Rails treats as truthy; the flag value is the destruction truth source. */
const DESTROYED_VALUES = new Set(["1", "true"]);

/**
 * Headless **nested / dynamic fields** for Rails `fields_for` +
 * `accepts_nested_attributes_for` (no dedicated APG pattern — form editing).
 * Clone a `<template>` row, renumber its index, and remove rows by flagging
 * `_destroy` (persisted) or dropping them from the DOM (unsaved).
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
 * Values: `min` / `max` bound the effective row count (`max` `0` = unlimited;
 * both are followed at runtime), `indexPlaceholder` is the template token
 * replaced per row (default `__INDEX__`), and `announce` + `countMessage` (a
 * `{count}` template) opt into the announcer bridge.
 *
 * `add` dispatches `{ index, element }`; `remove` dispatches `{ element, persisted }`;
 * `reconcile` dispatches `{ count, atMin, atMax }` when a change the controller did
 * not perform itself — rows appended or removed by Turbo Streams / a morph, or a
 * runtime `min` / `max` change — moves the published state.
 *
 * @remarks
 * Behavior only — server-side `accepts_nested_attributes_for`, per-field
 * validation, and reordering are out of scope. Row state lives **only** in the DOM
 * (inserted nodes + each `_destroy` hidden input); there is no module-scope index
 * counter, so the controller stays idempotent across Turbo swaps. A row counts as
 * destroyed when its own `_destroy` flag holds a truthy value — `hidden` is the
 * visual half the controller writes alongside the flag, so a consumer hiding rows
 * for other reasons does not affect the count. Remove buttons and destroy flags
 * are resolved by **delegation scoped to their nearest nested-form root**, so
 * dynamically-added rows work without per-row `data-action` and one instance
 * nested inside another never acts on the inner instance's buttons or flags.
 * External row changes are observed on the list and reconciled once per mutation
 * batch. Adding a row moves focus to its first tab stop; removing returns focus to
 * the nearest surviving row's first tab stop, falling back to the add button and
 * finally to the root via a temporary `tabindex` (WCAG 2.2 2.4.3) — candidates
 * that cannot take focus (natively `disabled`, inside `fieldset[disabled]`, or not
 * rendered) are skipped. Count changes from the controller's own add / remove are
 * announced through the shared `stimeo--announcer` (WCAG 2.2 4.1.3) when
 * `announce` + `countMessage` are set; reconciliation stays silent to assistive
 * tech. The add button's `disabled` is managed only while `max` is set, and the
 * authored value is restored on teardown. A template must produce exactly one
 * root element; markup lacking the required `list` / `template` targets, or a
 * template producing anything else, is named on the console once per connection
 * and every operation stays a safe no-op with nothing left in the list. Clicking
 * remove on a row whose flag is already truthy only completes its hiding —
 * nothing effective changes, so no event and no announcement. The delegated
 * listener, the observer, and every lease are released on `disconnect()`.
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
  static events = ["add", "remove", "reconcile"] as const;

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

  #warnedMissing = false;
  #warnedTemplate = false;

  /** The state last written to the hooks; reconciliation reports only real moves. */
  #published: { count: number; atMin: boolean; atMax: boolean } | null = null;

  /** Watches the list for row changes the controller did not perform itself. */
  #observer: MutationObserver | null = null;

  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileNow());
  /** Restores the authored add-button `disabled` when a lease ends. */
  readonly #addDisabled = new AttributeLease<HTMLButtonElement>("disabled");
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  /** Makes the root a programmatic focus destination when no other candidate survives. */
  readonly #tabindex = new TabindexLoan();

  /**
   * Delegated click handler for the per-row remove buttons (dynamic-safe). Only
   * buttons whose nearest nested-form root is this instance are acted on, so a
   * nested inner form's buttons never remove an outer row.
   */
  readonly #onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest<HTMLElement>(REMOVE_SELECTOR);
    if (!button || this.#ownerOf(button) !== this.element) return;
    const row = this.#rowContaining(button);
    if (row) this.#removeRow(row);
  };

  override connect(): void {
    this.#warnedMissing = false;
    this.#warnedTemplate = false;
    this.element.addEventListener("click", this.#onClick);
    this.#reconcile.activate();
    this.#beforeCache.activate();
    if (!this.hasListTarget || !this.hasTemplateTarget) this.#warnMissing();
    this.#refresh();
  }

  override disconnect(): void {
    this.element.removeEventListener("click", this.#onClick);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#reconcile.cancel();
    this.#beforeCache.deactivate();
    this.#rewindForCache();
    this.#tabindex.returnAll();
    this.#published = null;
  }

  /** Follows an arriving or swapped-in list: rebind to the primary, then reconcile. */
  listTargetConnected(): void {
    this.#rebindObserver();
    this.#reconcile.schedule();
  }

  /** Follows a departing list the same way — the primary may have changed. */
  listTargetDisconnected(): void {
    this.#rebindObserver();
    this.#reconcile.schedule();
  }

  /**
   * Points the observer at the current primary list. Re-deriving on every list
   * arrival and departure makes the binding independent of the order Stimulus
   * reports an overlapping swap in — a staggered swap (successor appended before
   * the old list leaves) ends observed and reconciled either way.
   */
  #rebindObserver(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (!this.hasListTarget) return;
    this.#observer = new MutationObserver(() => this.#reconcile.schedule());
    this.#observer.observe(this.listTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value"],
    });
  }

  /** Returns the lease with a departing add button; a new one re-arms on refresh. */
  addTargetDisconnected(target: HTMLButtonElement): void {
    this.#addDisabled.return(target);
    this.#reconcile.schedule();
  }

  addTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-clamps when application code or a Turbo morph changes `min`. */
  minValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Re-clamps when application code or a Turbo morph changes `max`. */
  maxValueChanged(): void {
    this.#reconcile.schedule();
  }

  /**
   * Clones the template row, replaces the index placeholder with a unique value,
   * appends it, focuses its first tab stop, and announces the new count. No-ops at
   * `max`, when the required targets are missing (named on the console once per
   * connection), or when the template does not produce exactly one root element
   * (also named once; the insertion is rolled back so nothing accumulates).
   */
  add(): void {
    if (!this.hasListTarget || !this.hasTemplateTarget) {
      this.#warnMissing();
      return;
    }
    if (this.#atMax) return;

    const index = this.#nextIndex();
    const markup = this.templateTarget.innerHTML.replaceAll(
      this.indexPlaceholderValue,
      String(index),
    );
    const list = this.listTarget;
    const beforeNodes = list.childNodes.length;
    const beforeElements = list.childElementCount;
    list.insertAdjacentHTML("beforeend", markup);
    const added = (Array.from(list.children) as HTMLElement[]).slice(beforeElements);
    if (added.length !== 1) {
      // A row is exactly one element. Anything else — escaped text, nothing, or
      // several roots (which the max gate above cannot account for) — rolls back
      // so repeated clicks cannot accumulate garbage or overshoot the max.
      while (list.childNodes.length > beforeNodes) list.lastChild?.remove();
      this.#warnBadTemplate(added.length);
      return;
    }
    const row = added[0] as HTMLElement;

    this.#refresh();
    firstTabStop(row)?.focus();
    this.dispatch("add", { detail: { index, element: row } });
    this.#announce();
  }

  /**
   * Removes a row: a persisted row (one carrying its own `destroyFlag`) has the
   * flag set to `1` and is hidden so Rails destroys it on submit; an unsaved row
   * is dropped from the DOM. Returns focus to a surviving row. No-ops at `min`.
   */
  #removeRow(row: HTMLElement): void {
    const rows = this.#effectiveRows;
    if (this.#destroyed(row)) {
      // An already-destroyed row left visible (a server re-render keeps the
      // flag but not the hiding): complete the visual half. The effective
      // state does not move, so no event, no announcement, and no min gate.
      row.hidden = true;
      this.#focusAfterRemove(this.#positionAmong(rows, row));
      return;
    }
    if (rows.length <= this.minValue) return;

    const position = rows.indexOf(row);
    const flag = this.#destroyFlagOf(row);
    const persisted = flag !== null;
    if (flag) {
      flag.value = "1";
      row.hidden = true;
    } else {
      row.remove();
    }

    this.#refresh();
    this.#focusAfterRemove(Math.max(0, position));
    this.dispatch("remove", { detail: { element: row, persisted } });
    this.#announce();
  }

  /**
   * The index of the first effective row following `row` in document order.
   * -1 (no following row) feeds the focus slices as a negative index, which
   * yields the same fully-reversed nearest-first order as `rows.length` would.
   */
  #positionAmong(rows: HTMLElement[], row: HTMLElement): number {
    return rows.findIndex(
      (candidate) =>
        (row.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
  }

  /**
   * Moves focus to the first tab stop of the nearest surviving row — following
   * rows first, then preceding ones — falling back to the add button and finally
   * to the root via a temporary `tabindex`.
   */
  #focusAfterRemove(position: number): void {
    const rows = this.#effectiveRows;
    const ordered = [...rows.slice(position), ...rows.slice(0, position).reverse()];
    for (const row of ordered) {
      const stop = firstTabStop(row);
      if (stop) {
        stop.focus();
        return;
      }
    }
    if (this.hasAddTarget && isTabStop(this.addTarget)) {
      this.addTarget.focus();
      return;
    }
    this.#tabindex.lend(this.element);
    this.element.focus();
  }

  /** Recomputes the count and min/max hooks from the DOM and records them as published. */
  #refresh(): void {
    if (!this.hasListTarget) return;
    const count = this.#effectiveRows.length;
    const atMin = count <= this.minValue;
    const atMax = this.maxValue > 0 && count >= this.maxValue;
    this.element.setAttribute("data-nested-count", String(count));
    this.#reflect("data-nested-at-max", atMax);
    this.#reflect("data-nested-at-min", atMin);
    if (this.hasAddTarget) {
      // The button's disabled is controller state only while a max exists;
      // without one there is nothing to derive and the authored value stands.
      if (this.maxValue > 0) this.#addDisabled.write(this.addTarget, atMax ? "" : null);
      else this.#addDisabled.return(this.addTarget);
    }
    this.#published = { count, atMin, atMax };
  }

  /**
   * Applies row changes the controller did not perform itself (Turbo Streams,
   * morphs, runtime Value changes): refreshes the hooks and reports a moved
   * public state as `reconcile`. The controller's own operations refresh
   * synchronously first, so their observer echo arrives here as a no-move.
   */
  #reconcileNow(): void {
    const previous = this.#published;
    this.#refresh();
    const current = this.#published;
    if (!previous || !current) return;
    const moved =
      previous.count !== current.count ||
      previous.atMin !== current.atMin ||
      previous.atMax !== current.atMax;
    if (moved) this.dispatch("reconcile", { detail: { ...current } });
  }

  /** Bridges the count change to the shared announcer when configured. */
  #announce(): void {
    if (!this.announceValue || this.countMessageValue === "") return;
    announce(fillTemplate(this.countMessageValue, { count: this.#effectiveRows.length }));
  }

  /** Sets `attribute` to `"true"` when `on`, else removes it. */
  #reflect(attribute: string, on: boolean): void {
    if (on) this.element.setAttribute(attribute, "true");
    else this.element.removeAttribute(attribute);
  }

  /** Returns the disabled lease so an authored value never leaks into a snapshot. */
  #rewindForCache(): void {
    if (this.hasAddTarget) this.#addDisabled.return(this.addTarget);
  }

  /** Names the missing required target(s) once per connection. */
  #warnMissing(): void {
    if (this.#warnedMissing) return;
    this.#warnedMissing = true;
    const missing = [
      this.hasListTarget ? null : 'a "list" target',
      this.hasTemplateTarget ? null : 'a "template" target',
    ]
      .filter((part): part is string => part !== null)
      .join(" and ");
    console.warn(
      `Stimeo UI: "${this.identifier}" cannot manage rows because its markup lacks ${missing}.`,
    );
  }

  /** Names a template that does not produce exactly one element, once per connection. */
  #warnBadTemplate(produced: number): void {
    if (this.#warnedTemplate) return;
    this.#warnedTemplate = true;
    const reason = produced === 0 ? "produces no element" : "must produce exactly one root element";
    console.warn(`Stimeo UI: "${this.identifier}" added no row because its template ${reason}.`);
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

  /**
   * Direct child rows of the list whose own destroy flag is not set. Callers
   * reach this only behind a list-presence gate (`add`, `#refresh`, and the
   * click path through `#rowContaining`).
   */
  get #effectiveRows(): HTMLElement[] {
    return (Array.from(this.listTarget.children) as HTMLElement[]).filter(
      (row) => !this.#destroyed(row),
    );
  }

  /** Whether `row` is flagged for destruction; the flag value is the truth source. */
  #destroyed(row: HTMLElement): boolean {
    const flag = this.#destroyFlagOf(row);
    return flag !== null && DESTROYED_VALUES.has(flag.value);
  }

  /** The row's own destroy flag, skipping flags owned by a nested inner form. */
  #destroyFlagOf(row: HTMLElement): HTMLInputElement | null {
    for (const flag of row.querySelectorAll<HTMLInputElement>(DESTROY_FLAG_SELECTOR)) {
      if (this.#ownerOf(flag) === this.element) return flag;
    }
    return null;
  }

  /** The nearest nested-form root that owns `el`. */
  #ownerOf(el: Element): Element | null {
    return el.closest(ROOT_SELECTOR);
  }

  /** The nearest ancestor of `el` that is a direct child of the list, else null. */
  #rowContaining(el: Element): HTMLElement | null {
    if (!this.hasListTarget) return null;
    let node: Element | null = el;
    while (node && node.parentElement !== this.listTarget) {
      node = node.parentElement;
    }
    return node as HTMLElement | null;
  }
}
