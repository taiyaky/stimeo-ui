import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { SafeTimeout } from "../utils/safe_timeout";

/** Detail shapes for the ActiveStorage `direct-upload:*` events. */
interface UploadDetail {
  id?: string | number;
  file?: { name?: string };
  progress?: number;
  error?: string;
}

/** Delay (ms) before a completed row is removed when `removeOnDone` is set. */
const REMOVE_DELAY = 4000;

/**
 * Headless progress UI for ActiveStorage Direct Uploads: subscribes to the
 * `direct-upload:*` events and renders a per-file progress row (no dedicated APG
 * pattern; the rows follow the `role="progressbar"` practice). The companion to
 * {@link "file-dropzone"}, which leaves transport out of scope.
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
 * property, recomputed whenever a row is added, updated, or removed, and
 * withdrawn entirely once no rows remain.
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
 * - `stimeo--direct-upload:error` dispatches `{ id: string, error: string }`
 *   when an upload fails.
 *
 * @remarks
 * Behavior only — no bars are drawn. The `direct-upload:*` listeners live on
 * `document` (the events bubble there) and are removed on `disconnect()` (Turbo
 * navigation included), along with any pending removal timers, so a callback
 * that arrives after teardown never touches a detached row. Rows are transient
 * UI: just before Turbo caches the page they are removed and the aggregate is
 * withdrawn, so a restored snapshot starts pristine instead of replaying stale
 * rows (a dead upload cannot resume after restoration). The live DOM stays the
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
  static events = ["progress", "done", "error"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly rowTarget: HTMLTemplateElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasRowTarget: boolean;

  declare removeOnDoneValue: boolean;
  declare announceDoneTextValue: string;
  declare announceErrorTextValue: string;
  declare scopeValue: string;

  readonly #timeouts = new SafeTimeout();
  readonly #rows = new Map<string, HTMLElement>();
  readonly #beforeCache = new BeforeCacheReset(() => this.#reset());

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
    document.addEventListener("direct-upload:initialize", this.#onInitialize);
    document.addEventListener("direct-upload:progress", this.#onProgress);
    document.addEventListener("direct-upload:error", this.#onError);
    document.addEventListener("direct-upload:end", this.#onEnd);
    this.#beforeCache.activate();
    // An in-page move runs disconnect() → connect() on the same instance, and
    // teardown cancelled any pending removals; completed rows re-earn theirs.
    this.#rescheduleRemovals();
  }

  override disconnect(): void {
    document.removeEventListener("direct-upload:initialize", this.#onInitialize);
    document.removeEventListener("direct-upload:progress", this.#onProgress);
    document.removeEventListener("direct-upload:error", this.#onError);
    document.removeEventListener("direct-upload:end", this.#onEnd);
    this.#beforeCache.deactivate();
    this.#timeouts.clearAll();
    // `#rows` is kept: `disconnect()` also fires on an in-page move, where the
    // rows travel with the element and the next event should keep updating
    // them. Stale entries self-heal via `#prune`, and the Turbo-cache path
    // clears everything in `#reset()`.
  }

  /** Validates `scope` once so the per-event path never parses or throws. */
  scopeValueChanged(): void {
    const selector = this.scopeValue;
    if (selector.length > 0) {
      try {
        this.element.matches(selector);
        this.#scopeSelector = selector;
        return;
      } catch {
        // Unparsable selector: fall through to the default below.
      }
    }
    this.#scopeSelector = "";
  }

  /** Updates a row's progress and the aggregate, emitting `progress`. */
  #updateProgress(id: string, percent: number, name: string): void {
    const row = this.#rowFor(id, name);
    if (row === null || this.#isSettled(row)) return;
    const clamped = this.#applyProgress(row, percent);
    this.#syncAggregate();
    this.dispatch("progress", { detail: { id, percent: clamped } });
  }

  /** Marks a not-yet-settled row done at 100%, announces it, and emits `done`. */
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
    if (this.removeOnDoneValue) {
      this.#timeouts.set(() => this.#removeRow(id), REMOVE_DELAY);
    }
  }

  /**
   * Marks a not-yet-settled row failed, announces it, and emits `error`.
   * Returns whether the failure is rendered by this widget (used to decide the
   * `direct-upload:error` default), which also holds when the row already
   * displays an earlier failure.
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

  /** Re-arms `removeOnDone` for completed rows after a reconnect. */
  #rescheduleRemovals(): void {
    if (!this.removeOnDoneValue) return;
    this.#prune();
    for (const [id, row] of this.#rows) {
      if (row.getAttribute("data-upload-state") === "done") {
        this.#timeouts.set(() => this.#removeRow(id), REMOVE_DELAY);
      }
    }
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
      existing.remove();
      this.#rows.delete(key);
    }
    if (!this.hasRowTarget || !this.hasListTarget) return null;
    const clone = this.rowTarget.content.firstElementChild?.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return null;
    this.#applyName(clone, name);
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

  #removeRow(id: string): void {
    const row = this.#rows.get(id);
    if (row === undefined) return;
    row.remove();
    this.#rows.delete(id);
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
   * `list`, so the before-cache rewind never has an untracked leftover to miss.
   */
  #prune(): void {
    for (const [id, row] of this.#rows) {
      if (this.#tracksRow(row)) continue;
      row.remove();
      this.#rows.delete(id);
    }
  }

  /**
   * Returns the widget to its pre-upload state just before Turbo caches the
   * page, so the snapshot never replays rows for uploads that cannot resume.
   */
  #reset(): void {
    for (const row of this.#rows.values()) row.remove();
    this.#rows.clear();
    this.#timeouts.clearAll();
    this.#syncAggregate();
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

  /** The file name every ActiveStorage `direct-upload:*` event carries. */
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
