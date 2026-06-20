import { Controller } from "@hotwired/stimulus";
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
 *   <div data-controller="stimeo--direct-upload">
 *     <div data-stimeo--direct-upload-target="list"></div>
 *     <template data-stimeo--direct-upload-target="row">
 *       <div role="progressbar" aria-valuemin="0" aria-valuemax="100">
 *         <span data-field="name"></span><span data-field="percent"></span>
 *       </div>
 *     </template>
 *     <span data-stimeo--direct-upload-target="status" aria-live="polite"></span>
 *   </div>
 *
 * For each upload it clones the `row` template into `list`, then updates
 * `aria-valuenow`, the `[data-field="percent"]` text, and the
 * `--stimeo-upload-progress` custom property as `direct-upload:progress` arrives,
 * and flips `data-upload-state` to `done` / `error`. Completion and failure are
 * announced into the optional `status` live region using the consumer-provided
 * `doneLabel` / `errorLabel` (so copy stays localizable); per-tick progress is not
 * announced (the progressbar's `aria-valuenow` conveys it) to avoid flooding.
 *
 * @remarks
 * Behavior only — no bars are drawn. The `direct-upload:*` listeners live on
 * `document` (the events bubble there) and are removed on `disconnect()` (Turbo
 * navigation included), along with any pending removal timers, so a callback that
 * arrives after teardown never touches a detached row. With multiple upload widgets
 * on one page, set `scope` to a selector for the owning form/root so each widget
 * only handles its own uploads.
 */
export class DirectUploadController extends Controller<HTMLElement> {
  static override targets = ["list", "row", "status"];
  static override values = {
    announce: { type: Boolean, default: true },
    removeOnDone: { type: Boolean, default: false },
    doneLabel: { type: String, default: "" },
    errorLabel: { type: String, default: "" },
    scope: { type: String, default: "" },
  };
  static events = ["progress", "done", "error"] as const;

  declare readonly listTarget: HTMLElement;
  declare readonly rowTarget: HTMLTemplateElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasRowTarget: boolean;
  declare readonly hasStatusTarget: boolean;

  declare announceValue: boolean;
  declare removeOnDoneValue: boolean;
  declare doneLabelValue: string;
  declare errorLabelValue: string;
  declare scopeValue: string;

  readonly #timeouts = new SafeTimeout();
  readonly #rows = new Map<string, HTMLElement>();

  readonly #onInitialize = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    this.#rowFor(detail.id, detail.file?.name ?? "");
  };

  readonly #onProgress = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    this.#updateProgress(this.#key(detail.id), Math.round(detail.progress ?? 0));
  };

  readonly #onError = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    this.#fail(this.#key(detail.id), detail.error ?? "");
  };

  readonly #onEnd = (event: Event): void => {
    if (!this.#inScope(event)) return;
    const detail = this.#detail(event);
    this.#complete(this.#key(detail.id), detail.file?.name ?? "");
  };

  override connect(): void {
    document.addEventListener("direct-upload:initialize", this.#onInitialize);
    document.addEventListener("direct-upload:progress", this.#onProgress);
    document.addEventListener("direct-upload:error", this.#onError);
    document.addEventListener("direct-upload:end", this.#onEnd);
  }

  override disconnect(): void {
    document.removeEventListener("direct-upload:initialize", this.#onInitialize);
    document.removeEventListener("direct-upload:progress", this.#onProgress);
    document.removeEventListener("direct-upload:error", this.#onError);
    document.removeEventListener("direct-upload:end", this.#onEnd);
    this.#timeouts.clearAll();
    this.#rows.clear();
  }

  /** Updates a row's progress and the aggregate, emitting `progress`. */
  #updateProgress(id: string, percent: number): void {
    const row = this.#rowFor(id);
    if (row === null) return;
    const clamped = Math.max(0, Math.min(100, percent));
    row.setAttribute("aria-valuenow", String(clamped));
    row.setAttribute("aria-valuetext", `${clamped}%`);
    row.style.setProperty("--stimeo-upload-progress", `${clamped}%`);
    this.#setField(row, "percent", `${clamped}%`);
    this.#syncAggregate();
    this.dispatch("progress", { detail: { id, percent: clamped } });
  }

  /** Marks a row done, announces it, and emits `done`. */
  #complete(id: string, name = ""): void {
    // Lazily resolve like `#fail`/`#updateProgress` so an `end` that arrives
    // without a prior `initialize`/`progress` (no row yet) still records the
    // completion instead of silently dropping it; the file name (when the event
    // carries one) gives the freshly-created row an accessible label.
    const row = this.#rowFor(id, name);
    if (row === null) return;
    row.setAttribute("data-upload-state", "done");
    this.#announce(this.doneLabelValue, row);
    this.dispatch("done", { detail: { id } });
    if (this.removeOnDoneValue) {
      this.#timeouts.set(() => this.#removeRow(id), REMOVE_DELAY);
    }
  }

  /** Marks a row failed, announces it, and emits `error`. */
  #fail(id: string, error: string): void {
    const row = this.#rowFor(id);
    if (row === null) return;
    row.setAttribute("data-upload-state", "error");
    this.#announce(this.errorLabelValue, row);
    this.dispatch("error", { detail: { id, error } });
  }

  /** Returns an existing row or clones one from the template. */
  #rowFor(id: string | number | undefined, name?: string): HTMLElement | null {
    const key = this.#key(id);
    const existing = this.#rows.get(key);
    if (existing !== undefined) return existing;
    if (!this.hasRowTarget || !this.hasListTarget) return null;
    const clone = this.rowTarget.content.firstElementChild?.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return null;
    if (name !== undefined && name.length > 0) {
      this.#setField(clone, "name", name);
      // Give the progressbar an accessible name (per-file).
      clone.setAttribute("aria-label", name);
    }
    clone.setAttribute("aria-valuenow", "0");
    clone.setAttribute("data-upload-state", "uploading");
    clone.style.setProperty("--stimeo-upload-progress", "0%");
    this.listTarget.appendChild(clone);
    this.#rows.set(key, clone);
    return clone;
  }

  #removeRow(id: string): void {
    const row = this.#rows.get(id);
    if (row === undefined) return;
    row.remove();
    this.#rows.delete(id);
    this.#syncAggregate();
  }

  /** Reflects the average progress across rows on the controller element. */
  #syncAggregate(): void {
    if (this.#rows.size === 0) {
      this.element.removeAttribute("data-upload-progress");
      return;
    }
    let total = 0;
    for (const row of this.#rows.values()) {
      total += Number(row.getAttribute("aria-valuenow") ?? "0");
    }
    const overall = Math.round(total / this.#rows.size);
    this.element.setAttribute("data-upload-progress", String(overall));
    this.element.style.setProperty("--stimeo-upload-progress", `${overall}%`);
  }

  /** Writes a consumer label (with `%{name}` substituted) to the status region. */
  #announce(label: string, row: HTMLElement): void {
    if (!this.announceValue || !this.hasStatusTarget || label.length === 0) return;
    const name = this.#field(row, "name")?.textContent ?? "";
    this.statusTarget.textContent = label.replace("%{name}", name);
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

  /**
   * Whether an event belongs to this controller. With `scope` set, only events
   * whose target (the file input) sits inside an element matching `scope` are
   * handled, so several upload widgets on one page do not cross-populate. Resolved
   * with `closest()` from the target itself, so the chatty `progress` stream never
   * pays a document-wide query. Empty `scope` handles all.
   */
  #inScope(event: Event): boolean {
    if (this.scopeValue.length === 0) return true;
    const target = event.target;
    return target instanceof Element && target.closest(this.scopeValue) !== null;
  }

  #key(id: string | number | undefined): string {
    return String(id ?? "");
  }
}
