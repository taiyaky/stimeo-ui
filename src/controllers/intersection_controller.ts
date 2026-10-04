import { Controller } from "@hotwired/stimulus";
import { validSelector } from "../utils/declared_value";
import { IntersectionWatcher, isBeforeRootStart } from "../utils/intersection_watcher";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";

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
 * state hooks. It is the scroll-triggered building block for
 * scroll-driven behavior — loading more on approach, "animate when visible"
 * (compose it with `stimeo--count-up`), progress and sticky-header work — so a
 * consumer does not write its own observer. No APG widget — a pure
 * state-detection utility. Core (zero dependencies).
 *
 * Markup contract (identifier: `stimeo--intersection`):
 *   <div data-controller="stimeo--intersection"
 *        data-stimeo--intersection-root-margin-value="200px"
 *        data-action="stimeo--intersection:enter->feed#loadNextPage"></div>
 *
 * The controller observes its own element. `enter` fires when the element
 * becomes visible (intersection ratio reaches `threshold`; detail `{ ratio }`),
 * `exit` when it leaves (detail `{ ratio, position }`, where `position` is the
 * edge it left across — `"before"` = upward past the root's start edge,
 * `"after"` = downward, still ahead), `change` on every observed update
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
 * already fired is not observed again). Every Value follows a runtime change —
 * a Turbo morph, a Stream, an author script: the observer is rebuilt once per
 * batch from the current declaration, and only when the root node, `rootMargin`
 * or the lines it observes differ from the live one. `once` follows the same
 * way: turned off after its enter, the element is observed again and the first
 * callback is measured against the recorded hooks, exactly as on a reconnect;
 * turned on once an enter is recorded, observing stops. A `rootSelector` that
 * does not parse observes the viewport rather than leaving the element
 * unobserved. Without `IntersectionObserver` (very old browsers) the controller
 * stays inert — consumers keep whatever no-JS fallback their markup provides.
 * The observer is disconnected on `disconnect()` (Turbo navigation included).
 */
export class IntersectionController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override values = {
    threshold: { type: Number, default: 0 },
    ratioSteps: { type: Number, default: 0 },
    rootMargin: { type: String, default: "0px" },
    rootSelector: { type: String, default: "" },
    once: { type: Boolean, default: false },
  };

  static valueConstraints = {
    threshold: NUMBER_BOUNDS.finite,
    ratioSteps: { finite: true, min: 0, max: 1000 },
  } satisfies NumberValueConstraints<typeof IntersectionController.values>;
  static actions = ["refresh"] as const;
  static events = ["enter", "exit", "change", "passed"] as const;

  declare thresholdValue: number;
  declare ratioStepsValue: number;
  declare rootMarginValue: string;
  declare rootSelectorValue: string;
  declare onceValue: boolean;

  /** Shared IO plumbing (support guard, active guard, re-arm). */
  readonly #watcher = new IntersectionWatcher((entries) => this.#onIntersect(entries));
  /**
   * One rebuild for every Value a batch changes, inside the connected window
   * only: Stimulus delivers Value callbacks ahead of `connect()`, which builds
   * the observer itself, and a pass queued before `disconnect()` is dropped.
   */
  readonly #rebuild = new MicrotaskCoalescer(() => this.#sync());
  /** Validated `rootSelector`; an unparsable declaration reads as the viewport. */
  #rootSelector = "";
  /** The root node the live observer was built on. */
  #builtRoot: Element | null = null;
  /** `rootMargin` and the observed lines the live observer was built from. */
  #builtOptions = "";
  /** Threshold actually installed in the live observer (0 after option fallback). */
  #effectiveThreshold = 0;
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
      // A constructor fallback omits the configured threshold, so the observer
      // can only notify at its effective default line (0). Applying the authored
      // line here would wait for a callback that the fallback observer never
      // schedules after an initially intersecting entry.
      const threshold = this.#effectiveThreshold;
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
    this.#rebuild.activate();
    this.#sync();
  }

  override disconnect(): void {
    this.#rebuild.cancel();
    this.#watcher.stop();
  }

  /**
   * Follows the visibility line: the intersection callback compares every ratio
   * against it, so a line frozen at connect time would decide
   * `data-intersecting` wrongly for the rest of the page's life.
   */
  thresholdValueChanged(): void {
    this.#rebuild.schedule();
  }

  /** Follows the fine-grained `change` steps the observer notifies at. */
  ratioStepsValueChanged(): void {
    this.#rebuild.schedule();
  }

  /** Follows the margin the observer grows or shrinks its root by. */
  rootMarginValueChanged(): void {
    this.#rebuild.schedule();
  }

  /** Validates `rootSelector` once per change, then follows the root it names. */
  rootSelectorValueChanged(): void {
    this.#rootSelector = validSelector(this.element, this.rootSelectorValue, "");
    this.#rebuild.schedule();
  }

  /** Follows whether one recorded enter ends the observation. */
  onceValueChanged(): void {
    this.#rebuild.schedule();
  }

  /**
   * Brings the observer in line with the current declaration: a spent one-shot
   * observes nothing, and anything else observes with the root, margin and
   * lines declared now. A live observer already built from the same root node
   * and options is kept, since a rebuild re-delivers the current state as a
   * fresh callback.
   *
   * A spent one-shot is `once` with an enter recorded in `data-intersecting` —
   * the state a cache restore brings back too — so a declaration change and a
   * reconnect reach the same observer. Re-arming leaves the recorded hooks in
   * place: the first callback reports where the element is, and it is measured
   * against them like the first callback after a reconnect, never as a fresh
   * `enter` for an element that is still visible.
   */
  #sync(): void {
    if (this.onceValue && this.element.getAttribute("data-intersecting") === "true") {
      this.#watcher.stop();
      return;
    }
    const root = this.#rootSelector ? document.querySelector(this.#rootSelector) : null;
    const threshold = this.#clampedThreshold();
    const thresholds = this.#thresholds();
    const options = `${this.rootMarginValue} ${threshold} ${thresholds.join(",")}`;
    if (this.#watcher.active && root === this.#builtRoot && options === this.#builtOptions) return;

    this.#builtRoot = root;
    this.#builtOptions = options;
    this.#effectiveThreshold = threshold;
    this.#watcher.start(this.element, {
      root,
      rootMargin: this.rootMarginValue,
      threshold: thresholds,
    });
    if (this.#watcher.usingPlatformDefaults) this.#effectiveThreshold = 0;
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
   *
   * @stimeoRuntimeOnly `once` decides whether this enter spends the watcher's one shot; the hook it
   *   writes follows the entry.
   */
  #syncIntersecting(intersecting: boolean, ratio: number, entry: IntersectionObserverEntry): void {
    const previous = this.element.getAttribute("data-intersecting");
    this.element.setAttribute("data-intersecting", intersecting ? "true" : "false");

    if (intersecting && previous !== "true") {
      // One-shot mode: the shot is spent at this transition, so stop observing
      // before the event. A handler that re-arms (the `enter` -> append ->
      // `refresh()` reflex) then finds an inactive watcher and leaves the hooks
      // in their final state — `data-intersecting="true"` marks it for reconnects.
      if (this.onceValue) this.#watcher.stop();
      this.dispatch("enter", { detail: { ratio } });
    } else if (!intersecting && previous === "true") {
      this.dispatch("exit", {
        detail: { ratio, position: this.#leftViaStartEdge(entry) ? "before" : "after" },
      });
    }
  }

  /**
   * Which edge the element left across, for the `exit` detail. A non-zero
   * `threshold` withdraws visibility while the element still overlaps the root,
   * so the leaving rect can straddle the start edge — the direction is the
   * element's own top against that edge, not whether it has cleared the root
   * entirely (that is what `passed` reports). An element with no layout box
   * (`display: none`, a collapsed `<details>`) is reported with an empty rect
   * that carries no position at all, so it is deliberately neither direction
   * and takes the "still ahead" reading.
   */
  #leftViaStartEdge(entry: IntersectionObserverEntry): boolean {
    const rect = entry.boundingClientRect;
    if (rect.width === 0 && rect.height === 0) return false;
    // rootBounds is null for a cross-origin/removed root; fall back to the
    // viewport origin.
    return rect.top < (entry.rootBounds?.top ?? 0);
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
    return Math.min(1, Math.max(0, this.#safeThreshold));
  }

  /**
   * Observer thresholds: the `threshold` line itself, plus `ratioSteps` evenly
   * spaced steps when fine-grained `change` ratios are wanted (progress bars).
   *
   * 0 is always observed. An observer notifies only at the lines it was given,
   * so a non-zero `threshold` on its own delivers its last callback while the
   * element is still partly visible: the element leaving for good would never be
   * reported, freezing the ratio and `data-passed` mid-departure.
   */
  #thresholds(): number[] {
    const thresholds = new Set<number>([0, this.#clampedThreshold()]);
    if (this.#safeRatioSteps > 0) {
      // i counts up to ratioSteps, so i/ratioSteps is inherently 0..1.
      for (let i = 0; i <= this.#safeRatioSteps; i += 1) {
        thresholds.add(i / this.#safeRatioSteps);
      }
    }
    return [...thresholds].sort((a, b) => a - b);
  }
  /** Current `threshold` declaration resolved against its numeric contract. */
  get #safeThreshold(): number {
    return this.#numbers.read(
      this,
      "threshold",
      this.thresholdValue,
      IntersectionController.values.threshold.default,
      IntersectionController.valueConstraints.threshold,
    );
  }

  /** Current `ratioSteps` declaration resolved against its numeric contract. */
  get #safeRatioSteps(): number {
    return this.#numbers.read(
      this,
      "ratioSteps",
      this.ratioStepsValue,
      IntersectionController.values.ratioSteps.default,
      IntersectionController.valueConstraints.ratioSteps,
    );
  }
}
