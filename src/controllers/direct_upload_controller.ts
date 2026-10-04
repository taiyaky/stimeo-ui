import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { validSelector } from "../utils/declared_value";
import { KeyedTimers } from "../utils/keyed_timers";
import { cloneTemplateRoot } from "../utils/template_row";

/** Detail shapes for the ActiveStorage `direct-upload:*` events. */
interface UploadDetail {
  id?: string | number;
  file?: { name?: string };
  progress?: number;
  error?: string;
}

/** Delay (ms) before a completed row is removed when `removeOnDone` is set. */
const REMOVE_DELAY = 4000;

/** Suffix of the mark on every row this controller renders; it holds the upload id. */
const GENERATED_ATTRIBUTE = "generated";

/**
 * Headless progress UI for ActiveStorage Direct Uploads: subscribes to the
 * `direct-upload:*` events and renders a per-file progress row (no dedicated APG
 * pattern; the rows follow the `role="progressbar"` practice). The companion to
 * {@link FileDropzoneController}, which leaves transport out of scope.
 *
 * Markup contract (identifier: `stimeo--direct-upload`):
 *   <div data-controller="stimeo--direct-upload"
 *        data-stimeo--direct-upload-announce-done-text-value="{name} uploaded"
 *        data-stimeo--direct-upload-announce-error-text-value="{name} failed">
 *     <div data-stimeo--direct-upload-target="list"></div>
 *     <template data-stimeo--direct-upload-target="row">
 *       <div role="progressbar" aria-valuemin="0" aria-valuemax="100">
 *         <span data-field="name"></span><span data-field="percent"></span>
 *       </div>
 *     </template>
 *   </div>
 *
 * For each upload it clones the `row` template into `list`, then keeps
 * `aria-valuenow` / `aria-valuetext`, the `[data-field="percent"]` text, and the
 * `--stimeo--upload-progress` custom property (0–100, rounded and clamped) in
 * sync as `direct-upload:progress` arrives. The file name carried by the events
 * fills `[data-field="name"]` and becomes the row's `aria-label` unless the
 * template already authors one. The aggregate across live rows is mirrored on
 * the controller element as `data-upload-progress` plus the same custom
 * property, recomputed whenever a row is added, updated, or removed, or a `list`
 * leaves, and withdrawn entirely once no rows remain.
 *
 * A row leaves `uploading` exactly once: `direct-upload:error` settles it as
 * `error`, and `direct-upload:end` — which ActiveStorage fires after success
 * *and* failure — completes only rows not already settled, pinning them at 100%
 * and flipping `data-upload-state` to `done`. Later events never rewrite a
 * settled row, so a failure survives the `end` that follows it.
 *
 * Completion and failure are handed to the page's shared `stimeo--announcer` as
 * one polite message each, worded by the consumer via `announceDoneText` /
 * `announceErrorText` (`{name}` expands to the file name; empty templates stay
 * silent, keeping announcements opt-in and i18n-neutral). Per-tick progress is
 * not announced — the progressbar's `aria-valuenow` conveys it — to avoid
 * flooding. A failure this controller has rendered also cancels the
 * `direct-upload:error` default, which suppresses ActiveStorage's native
 * `alert()`; when no row could be rendered the alert stays as the fallback.
 *
 * Events dispatched on the controller element (all bubble):
 * - `stimeo--direct-upload:progress` dispatches `{ id: string, percent: number }`
 *   on each progress update, after clamping.
 * - `stimeo--direct-upload:done` dispatches `{ id: string }` when an upload
 *   completes successfully.
 * - `stimeo--direct-upload:reconcile` dispatches `{ ids: string[] }` — the uploads
 *   whose rows a page restored from the Turbo cache still showed, none of which can
 *   still finish.
 * - `stimeo--direct-upload:error` dispatches `{ id: string, error: string }`
 *   when an upload fails.
 *
 * @remarks
 * Behavior only — no bars are drawn. The `direct-upload:*` listeners live on
 * `document` (the events bubble there) and are removed on `disconnect()` (Turbo
 * navigation included), along with any pending removal timers, so a callback
 * that arrives after teardown never touches a detached row. `removeOnDone` follows a
 * change made while connected: turning it off cancels every pending removal, turning
 * it on arms one for each completed row still shown, with the full delay from then,
 * and a row never holds more than one pending removal. Rows are transient
 * UI, and each carries `data-<identifier>-generated` with its upload id. A page Turbo
 * restores from its cache is a copy that still shows them, so a connection holding no
 * row of its own removes the marked rows in its list, withdraws the aggregate and
 * reports the discarded ids as `reconcile` (a dead upload cannot resume after
 * restoration). Nothing is removed on `turbo:before-cache`, which Turbo also
 * dispatches on pages that stay — a promoted frame navigation, a state-less
 * `popstate`, a refresh of a cached URL, a `data-turbo-permanent` element carried to
 * the next page — where the uploads are still running. The live DOM stays the
 * source of truth — a row removed or replaced outside this controller is
 * forgotten and rebuilt on the next event for its id, and a clone stranded
 * outside the current `list` (a re-pointed target) is removed outright, so
 * generated rows only ever live there.
 *
 * With multiple upload widgets on one page, set `scope` to a selector for the
 * owning form/root so each widget only handles its own uploads. A `scope` that
 * does not parse as a selector falls back to the default (handle all) instead
 * of throwing from the event handlers, so one broken declaration cannot silence
 * the widget.
 */
export class DirectUploadController extends Controller<HTMLElement> {
  static override targets = ["list", "row"];
  static override values = {
    removeOnDone: { type: Boolean, default: false },
    announceDoneText: { type: String, default: "" },
    announceErrorText: { type: String, default: "" },
    scope: { type: String, default: "" },
  };
  static events = ["progress", "done", "error", "reconcile"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly rowTarget: HTMLTemplateElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasRowTarget: boolean;

  declare removeOnDoneValue: boolean;
  declare announceDoneTextValue: string;
  declare announceErrorTextValue: string;
  declare scopeValue: string;

  /** The pending removal of each completed row, keyed by upload id. */
  readonly #removals = new KeyedTimers<string>();
  readonly #rows = new Map<string, HTMLElement>();
  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;

  /** The validated `scope` selector; a broken declaration falls back to `""`. */
  #scopeSelector = "";

  readonly #onInitialize = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    this.#rowFor(detail.id, this.#name(detail));
  };

  readonly #onProgress = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    this.#updateProgress(this.#key(detail.id), detail.progress ?? 0, this.#name(detail));
  };

  readonly #onError = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    const rendered = this.#fail(this.#key(detail.id), detail.error ?? "", this.#name(detail));
    // ActiveStorage alert()s the raw error unless the event is cancelled. A
    // failure this widget displays is handled, so the blocking duplicate is
    // suppressed; an unrendered failure keeps the alert as its only signal.
    if (rendered) event.preventDefault();
  };

  readonly #onEnd = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    this.#complete(this.#key(detail.id), this.#name(detail));
  };

  override connect(): void {
    this.#connected = true;
    document.addEventListener("direct-upload:initialize", this.#onInitialize);
    document.addEventListener("direct-upload:progress", this.#onProgress);
    document.addEventListener("direct-upload:error", this.#onError);
    document.addEventListener("direct-upload:end", this.#onEnd);
    this.#discardInherited();
    // An in-page move runs disconnect() → connect() on the same instance, and
    // teardown cancelled any pending removals; completed rows re-earn theirs.
    this.#syncRemovals();
  }

  override disconnect(): void {
    this.#connected = false;
    document.removeEventListener("direct-upload:initialize", this.#onInitialize);
    document.removeEventListener("direct-upload:progress", this.#onProgress);
    document.removeEventListener("direct-upload:error", this.#onError);
    document.removeEventListener("direct-upload:end", this.#onEnd);
    this.#removals.clearAll();
    // `#rows` is kept: `disconnect()` also fires on an in-page move, where the
    // rows travel with the element and the next event should keep updating
    // them. Stale entries self-heal via `#prune`.
  }

  /** The row mark above, in the namespace this controller is registered under. */
  get #generatedAttribute(): string {
    return `data-${this.identifier}-${GENERATED_ATTRIBUTE}`;
  }

  /**
   * Removes the marked rows a connection holding no row of its own finds in its list —
   * on a page restored from Turbo's cache, the copies of rows whose uploads died with
   * the page they ran on — withdraws the aggregate, and reports their ids once.
   */
  #discardInherited(): void {
    if (this.#rows.size > 0 || !this.hasListTarget) return;
    const ids: string[] = [];
    for (const row of Array.from(this.listTarget.children)) {
      const id = row.getAttribute(this.#generatedAttribute);
      if (id === null) continue;
      row.remove();
      ids.push(id);
    }
    if (ids.length === 0) return;
    this.#syncAggregate();
    this.dispatch("reconcile", { detail: { ids } });
  }

  /** Validates `scope` once so the per-event path never parses or throws. */
  scopeValueChanged(): void {
    this.#scopeSelector = validSelector(this.element, this.scopeValue, "");
  }

  /**
   * Follows `removeOnDone` changed at runtime: off cancels every pending removal, on
   * arms one for each completed row that has none, with the full delay from now.
   * Stimulus also calls this ahead of `connect()`, which arms the removals itself.
   */
  removeOnDoneValueChanged(): void {
    if (this.#connected) this.#syncRemovals();
  }

  /** Recounts the aggregate once a list leaves, retiring rows outside the list that stays. */
  listTargetDisconnected(): void {
    if (this.#connected) this.#syncAggregate();
  }

  /** Updates a row's progress and the aggregate, emitting `progress`. */
  #updateProgress(id: string, percent: number, name: string): void {
    const row = this.#rowFor(id, name);
    if (row === null || this.#isSettled(row)) return;
    const clamped = this.#applyProgress(row, percent);
    this.#syncAggregate();
    this.dispatch("progress", { detail: { id, percent: clamped } });
  }

  /**
   * Marks a not-yet-settled row done at 100%, announces it, and emits `done`.
   *
   * @stimeoRuntimeOnly `announceDoneText` words the one announcement of this completion and
   *   `removeOnDone` decides whether it arms the row's removal.
   */
  #complete(id: string, name: string): void {
    // Resolve lazily like `#fail`/`#updateProgress` so an `end` that arrives
    // without a prior `initialize`/`progress` (no row yet) still records the
    // completion instead of silently dropping it.
    const row = this.#rowFor(id, name);
    if (row === null || this.#isSettled(row)) return;
    row.setAttribute("data-upload-state", "done");
    this.#applyProgress(row, 100);
    this.#syncAggregate();
    this.#announce(this.announceDoneTextValue, name, row);
    this.dispatch("done", { detail: { id } });
    if (this.removeOnDoneValue) this.#scheduleRemoval(id, row);
  }

  /**
   * Marks a not-yet-settled row failed, announces it, and emits `error`.
   * Returns whether the failure is rendered by this widget (used to decide the
   * `direct-upload:error` default), which also holds when the row already
   * displays an earlier failure.
   *
   * @stimeoRuntimeOnly `announceErrorText` words the one announcement of this failure.
   */
  #fail(id: string, error: string, name: string): boolean {
    const row = this.#rowFor(id, name);
    if (row === null) return false;
    if (this.#isSettled(row)) return row.getAttribute("data-upload-state") === "error";
    row.setAttribute("data-upload-state", "error");
    this.#announce(this.announceErrorTextValue, name, row);
    this.dispatch("error", { detail: { id, error } });
    return true;
  }

  /** Whether the row reached a terminal state; settled rows are never rewritten. */
  #isSettled(row: HTMLElement): boolean {
    const state = row.getAttribute("data-upload-state");
    return state === "done" || state === "error";
  }

  /**
   * Brings the pending removals in line with `removeOnDone`: with it off none is left
   * pending; with it on every completed row still shown has one, and a row that already
   * has one keeps it and its deadline.
   *
   * @stimeoRuntimeOnly `removeOnDone` decides whether the completed rows have a removal
   *   pending.
   */
  #syncRemovals(): void {
    if (!this.removeOnDoneValue) {
      this.#removals.clearAll();
      return;
    }
    this.#prune();
    for (const [id, row] of this.#rows) {
      if (row.getAttribute("data-upload-state") === "done" && !this.#removals.has(id)) {
        this.#scheduleRemoval(id, row);
      }
    }
  }

  /** Arms the removal of a completed row, replacing one its id already had pending. */
  #scheduleRemoval(id: string, row: HTMLElement): void {
    this.#removals.set(id, () => this.#removeRow(row), REMOVE_DELAY);
  }

  /** Returns the live row for `id`, creating (and labeling) one on first sight. */
  #rowFor(id: string | number | undefined, name: string): HTMLElement | null {
    const key = this.#key(id);
    const existing = this.#rows.get(key);
    if (existing !== undefined) {
      if (this.#tracksRow(existing)) {
        this.#applyName(existing, name);
        return existing;
      }
      // Removed, replaced, or no longer inside the current list: retire the
      // clone (removing it is a no-op when something else already did) and
      // rebuild from the live DOM.
      this.#retire(key, existing);
    }
    if (!this.hasRowTarget || !this.hasListTarget) return null;
    const clone = cloneTemplateRoot(this.rowTarget);
    if (!clone) return null;
    this.#applyName(clone, name);
    clone.setAttribute(this.#generatedAttribute, key);
    clone.setAttribute("data-upload-state", "uploading");
    this.#applyProgress(clone, 0);
    this.listTarget.appendChild(clone);
    this.#rows.set(key, clone);
    this.#syncAggregate();
    return clone;
  }

  /**
   * Writes the event's file name into `[data-field="name"]` and, unless the row
   * already carries a non-blank `aria-label` — authored on the template or
   * applied by an earlier event — makes it the accessible name too. The visible
   * name never depends on the label: an authored label keeps its wording while
   * the field still shows which file this row tracks.
   */
  #applyName(row: HTMLElement, name: string): void {
    if (name.length === 0) return;
    this.#setField(row, "name", name);
    // A whitespace-only label computes to no accessible name, so only a
    // non-blank one counts as authored.
    if ((row.getAttribute("aria-label") ?? "").trim().length > 0) return;
    row.setAttribute("aria-label", name);
  }

  /** Writes one progress value to every per-row hook; returns the clamped percent. */
  #applyProgress(row: HTMLElement, percent: number): number {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    row.setAttribute("aria-valuenow", String(clamped));
    row.setAttribute("aria-valuetext", `${clamped}%`);
    row.style.setProperty("--stimeo--upload-progress", `${clamped}%`);
    this.#setField(row, "percent", `${clamped}%`);
    return clamped;
  }

  #removeRow(row: HTMLElement): void {
    row.remove();
    this.#syncAggregate();
  }

  /**
   * Reflects the average progress across live rows on the controller element,
   * withdrawing both hooks once no rows remain.
   */
  #syncAggregate(): void {
    this.#prune();
    if (this.#rows.size === 0) {
      this.element.removeAttribute("data-upload-progress");
      this.element.style.removeProperty("--stimeo--upload-progress");
      return;
    }
    let total = 0;
    for (const row of this.#rows.values()) {
      total += Number(row.getAttribute("aria-valuenow") ?? "0");
    }
    const overall = Math.round(total / this.#rows.size);
    this.element.setAttribute("data-upload-progress", String(overall));
    this.element.style.setProperty("--stimeo--upload-progress", `${overall}%`);
  }

  /**
   * Whether a bookkept row is still this widget's live UI: connected, and — when
   * a `list` target is present — inside the *current* one, so re-pointing the
   * target attribute at a new element retires rows kept alive in the old list.
   */
  #tracksRow(row: HTMLElement): boolean {
    if (!row.isConnected) return false;
    return !this.hasListTarget || this.listTarget.contains(row);
  }

  /**
   * Retires rows that left the live UI (list swap, external removal). A retired
   * clone is removed outright — generated rows only ever live under the current
   * `list`, which is where a restored page's discard looks for them.
   */
  #prune(): void {
    for (const [id, row] of this.#rows) {
      if (this.#tracksRow(row)) continue;
      this.#retire(id, row);
    }
  }

  /**
   * Removes and forgets a retired clone, cancelling the removal its id had pending, so a
   * row rebuilt for the same id never inherits that deadline.
   */
  #retire(id: string, row: HTMLElement): void {
    row.remove();
    this.#rows.delete(id);
    this.#removals.clear(id);
  }

  /**
   * Sends one consumer-worded message to the page's shared announcer. `{name}`
   * resolves to the row's displayed name first — the event that settles an
   * upload may omit the file although an earlier event already named the row —
   * then the event's own name, then the accessible name (which an authored
   * label owns, so it is the last resort, not the primary source).
   */
  #announce(template: string, name: string, row: HTMLElement): void {
    const stored = this.#field(row, "name")?.textContent ?? "";
    const label =
      stored.length > 0 ? stored : name.length > 0 ? name : (row.getAttribute("aria-label") ?? "");
    announce(fillTemplate(template, { name: label }));
  }

  #field(row: HTMLElement, name: string): HTMLElement | null {
    return row.querySelector<HTMLElement>(`[data-field="${name}"]`);
  }

  #setField(row: HTMLElement, name: string, text: string): void {
    const field = this.#field(row, name);
    if (field !== null) field.textContent = text;
  }

  #detail(event: Event): UploadDetail {
    return (event as CustomEvent<UploadDetail>).detail ?? {};
  }

  /** The event's file name, or `""` when it carries none. */
  #name(detail: UploadDetail): string {
    return detail.file?.name ?? "";
  }

  /**
   * Whether an event belongs to this controller. With `scope` set, only events
   * whose target (the file input) sits inside an element matching `scope` are
   * handled, so several upload widgets on one page do not cross-populate.
   * Resolved with `closest()` from the target itself, so the chatty `progress`
   * stream never pays a document-wide query. Empty `scope` handles all.
   */
  #inScope(event: Event): boolean {
    if (this.#scopeSelector.length === 0) return true;
    const target = event.target;
    return target instanceof Element && target.closest(this.#scopeSelector) !== null;
  }

  #key(id: string | number | undefined): string {
    return String(id ?? "");
  }
}
