import { Controller } from "@hotwired/stimulus";
import { IntersectionWatcher, isBeforeRootStart } from "../utils/intersection_watcher";

/** Name of the CSS custom property exposing the visible ratio (0..1). */
const RATIO_PROPERTY = "--stimeo--intersection-ratio";

/**
 * Tolerance for the visibility test. Real observers can report a ratio a hair
 * below the configured threshold at that threshold's own crossing callback
 * (fractional device pixels / zoom), most visibly at threshold 1 where "fully
 * visible" may arrive as 0.99x — a strict `>=` would then never see it.
 */
const RATIO_EPSILON = 0.01;

/**
 * Headless **intersection primitive**: a thin declarative wrapper over
 * {@link IntersectionObserver} that turns viewport visibility into events and
 * state hooks. It is the scroll-triggered building block that infinite-scroll,
 * reading-progress, count-up ("animate when visible") and smart sticky headers
 * compose from, without each writing its own observer. No APG widget — a pure
 * state-detection utility. Core (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--intersection`):
 *   <div data-controller="stimeo--intersection"
 *        data-stimeo--intersection-root-margin-value="200px"
 *        data-action="stimeo--intersection:enter->feed#loadNextPage"></div>
 *
 * The controller observes its own element. `enter` fires when the element
 * becomes visible (intersection ratio reaches `threshold`), `exit` when it
 * leaves (detail carries `position`: `"before"` = scrolled past the root's
 * start edge, `"after"` = still ahead), `change` on every observed update
 * (detail `{ intersecting, ratio }` — set `ratioSteps` for fine-grained ratio
 * reporting), and `passed` when the element fully crosses the root's start edge
 * in either direction (detail `{ passed }` — the sticky/progress line). The
 * visibility is mirrored as `data-intersecting`/`data-passed` and the ratio as
 * the `--stimeo--intersection-ratio` custom property for consumer CSS.
 *
 * @remarks
 * Behavior only — what visibility *means* (load a page, start an animation,
 * pin a header) belongs to the consumer via `data-action`/CSS. `connect()` is
 * idempotent: the previous state is read back from `data-intersecting`/
 * `data-passed`, so a Turbo cache restore does not re-fire `enter` for an
 * element that was already visible (and with `once`, an element whose enter
 * already fired is not observed again). Without `IntersectionObserver` (very
 * old browsers) the controller stays inert — consumers keep whatever no-JS
 * fallback their markup provides. The observer is disconnected on
 * `disconnect()` (Turbo navigation included).
 */
export class IntersectionController extends Controller<HTMLElement> {
  static override values = {
    threshold: { type: Number, default: 0 },
    ratioSteps: { type: Number, default: 0 },
    rootMargin: { type: String, default: "0px" },
    rootSelector: { type: String, default: "" },
    once: { type: Boolean, default: false },
  };
  static actions = ["refresh"] as const;
  static events = ["enter", "exit", "change", "passed"] as const;

  declare thresholdValue: number;
  declare ratioStepsValue: number;
  declare rootMarginValue: string;
  declare rootSelectorValue: string;
  declare onceValue: boolean;

  /** Shared IO plumbing (support guard, root resolution, active guard, re-arm). */
  readonly #watcher = new IntersectionWatcher((entries) => this.#onIntersect(entries));
  /** Bumped by `refresh()`: an in-flight batch becomes stale and stops. */
  #generation = 0;

  #onIntersect(entries: IntersectionObserverEntry[]): void {
    // A single callback can batch several transitions for the same target
    // (delivery lagging behind a fast scroll), so process every entry in
    // order — collapsing to the last one alone would drop an enter→exit pair
    // and, under `once`, lose the one-shot enter entirely. If a handler calls
    // `refresh()` mid-batch (enter → append content → re-arm), the remaining
    // entries describe a state `refresh` just reset — replaying them would
    // re-fire `enter` for the same visibility episode — so the generation
    // bump abandons them and the re-observation delivers the fresh state
    // (`once` stopping the watcher mid-batch is caught by the active check).
    const generation = this.#generation;
    for (const entry of entries) {
      if (!this.#watcher.active || this.#generation !== generation) return;

      const ratio = entry.intersectionRatio;
      // `isIntersecting` is geometric ("any overlap"), so a non-zero `threshold`
      // ("counts as visible at ≥N%") must be applied to the ratio ourselves —
      // against the same 0..1-clamped value the observer was configured with, or
      // a `threshold` above 1 would make `intersecting` unreachable while the
      // observer still fires at ratio 1. The epsilon absorbs subpixel rounding
      // (see RATIO_EPSILON); keeping the geometric `isIntersecting` conjunct
      // stops it from underflowing a tiny threshold into "always visible".
      const threshold = this.#clampedThreshold();
      const intersecting =
        threshold > 0
          ? entry.isIntersecting && ratio >= threshold - RATIO_EPSILON
          : entry.isIntersecting;

      this.element.style.setProperty(RATIO_PROPERTY, String(ratio));
      this.dispatch("change", { detail: { intersecting, ratio } });
      this.#syncIntersecting(intersecting, ratio, entry);
      this.#syncPassed(!intersecting && isBeforeRootStart(entry));
    }
  }

  override connect(): void {
    // A cache restore may bring back an element whose one-shot enter already
    // fired; honor it instead of re-observing (mirrors `data-lazy-loaded`).
    if (this.onceValue && this.element.getAttribute("data-intersecting") === "true") return;
    this.#watcher.start(this.element, {
      rootSelector: this.rootSelectorValue,
      rootMargin: this.rootMarginValue,
      threshold: this.#thresholds(),
    });
  }

  override disconnect(): void {
    this.#watcher.stop();
  }

  /**
   * Re-delivers the current intersection state as a fresh transition. Bound via
   * `data-action` (e.g. `my-feed:appended@window->stimeo--intersection#refresh`).
   *
   * `IntersectionObserver` only reports state *changes*, so a sentinel that
   * stays visible while content is appended below it never fires `enter` again
   * and a hand-rolled infinite scroll stalls. `observe()` always delivers the
   * current state, and clearing the recorded `data-intersecting`/`data-passed`
   * makes that delivery count as a transition — a still-visible sentinel
   * re-fires `enter`. No-op once the observer is gone (`once` fired, no
   * `IntersectionObserver` support, or after `disconnect()`).
   */
  refresh(): void {
    if (!this.#watcher.active) return;
    this.#generation += 1;
    this.element.removeAttribute("data-intersecting");
    this.element.removeAttribute("data-passed");
    this.#watcher.rearm(this.element);
  }

  /**
   * Reflects the visibility onto `data-intersecting` and fires `enter`/`exit`
   * on transitions. The previous state is the DOM attribute (source of truth),
   * so the observer's initial callback fires `enter` for an element that starts
   * visible but stays silent after a cache restore that already recorded it.
   * An initial not-visible state is established silently (no `exit`).
   */
  #syncIntersecting(intersecting: boolean, ratio: number, entry: IntersectionObserverEntry): void {
    const previous = this.element.getAttribute("data-intersecting");
    this.element.setAttribute("data-intersecting", intersecting ? "true" : "false");

    if (intersecting && previous !== "true") {
      this.dispatch("enter", { detail: { ratio } });
      // One-shot mode: the enter fired; stop observing and leave the hooks in
      // their final state (`data-intersecting="true"` marks it for reconnects).
      if (this.onceValue) this.#watcher.stop();
    } else if (!intersecting && previous === "true") {
      this.dispatch("exit", {
        detail: { ratio, position: isBeforeRootStart(entry) ? "before" : "after" },
      });
    }
  }

  /**
   * Reflects the "scrolled past" state onto `data-passed` and fires `passed` on
   * transitions — the line sticky headers and reading progress key off. Like
   * `enter`, an initial `passed=true` (page restored mid-scroll) fires; the
   * initial `false` is established silently.
   */
  #syncPassed(passed: boolean): void {
    const previous = this.element.getAttribute("data-passed");
    this.element.setAttribute("data-passed", passed ? "true" : "false");
    const changed = previous === null ? passed : (previous === "true") !== passed;
    if (changed) this.dispatch("passed", { detail: { passed } });
  }

  /** The configured `threshold`, clamped to the 0..1 the observer accepts. */
  #clampedThreshold(): number {
    return Math.min(1, Math.max(0, this.thresholdValue));
  }

  /**
   * Observer thresholds: the `threshold` line itself, plus `ratioSteps` evenly
   * spaced steps when fine-grained `change` ratios are wanted (progress bars).
   */
  #thresholds(): number[] {
    const thresholds = new Set<number>([this.#clampedThreshold()]);
    if (this.ratioStepsValue > 0) {
      // i counts up to ratioSteps, so i/ratioSteps is inherently 0..1.
      for (let i = 0; i <= this.ratioStepsValue; i += 1) {
        thresholds.add(i / this.ratioStepsValue);
      }
    }
    return [...thresholds].sort((a, b) => a - b);
  }
}
