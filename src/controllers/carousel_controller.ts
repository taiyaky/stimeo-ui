import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowStep } from "../utils/arrow_step";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { prefersReducedMotion } from "../utils/reduced_motion";
import { RovingTabindex, rovingMove } from "../utils/roving_tabindex";
import { SafeInterval } from "../utils/safe_timeout";

/** Advance delay used when `interval` is not a finite positive number. */
const DEFAULT_INTERVAL = 5000;

/**
 * State attributes whose in-place rewrite changes what the carousel shows without
 * any target connecting or disconnecting — the shape a Turbo morph takes when it
 * keeps the elements and swaps only their attributes.
 */
const OBSERVED_ATTRIBUTES = ["aria-selected", "data-state", "hidden"];

/**
 * Headless, accessible **Carousel** (slideshow) behavior.
 *
 * Markup contract (identifier: `stimeo--carousel`):
 *   <section data-controller="stimeo--carousel" aria-roledescription="carousel"
 *            aria-label="Featured"
 *            data-stimeo--carousel-autoplay-value="false"
 *            data-stimeo--carousel-interval-value="5000"
 *            data-stimeo--carousel-loop-value="true">
 *     <button data-stimeo--carousel-target="playToggle">…</button>
 *     <div data-stimeo--carousel-target="viewport">
 *       <div role="tabpanel" data-stimeo--carousel-target="slide">…</div>
 *       <div role="tabpanel" data-stimeo--carousel-target="slide" hidden inert>…</div>
 *     </div>
 *     <button data-stimeo--carousel-target="prev">‹</button>
 *     <button data-stimeo--carousel-target="next">›</button>
 *     <div role="tablist">
 *       <button role="tab" data-stimeo--carousel-target="picker"></button>
 *     </div>
 *   </section>
 *
 * Implements the WAI-ARIA APG **Carousel** pattern. With pickers it is the tabbed
 * variant: each picker is a `tab` carrying `aria-selected` and the single roving
 * `tabindex`, and each slide is its `tabpanel`. Without pickers the slides are
 * `group`s and `prev`/`next` drive them. The current slide is exposed through
 * `data-state` (`active`/`inactive`); the rest carry `hidden` **and** `inert`, so
 * they stay out of the focus order and the accessibility tree even when consumer
 * CSS overrides `display` to lay the slides out as a track.
 *
 * @remarks
 * Behavior only — transitions, layout, and visuals are the consumer's CSS.
 *
 * **The controller owns its own wiring.** Clicks, picker keys, hover, and focus
 * are delegated from the controller element, so no `data-action` is required and
 * a target added at runtime works the moment it appears. Explicit `data-action`
 * bindings to the declared actions still work and coexist with the delegated
 * path: the binding runs first and marks the event, and the delegated listener
 * stands down, so one interaction is never handled twice.
 *
 * **`autoplay` is the single source of truth for the rotation intent.** The
 * toggle writes back to it, so the state survives a Turbo Drive cache restore
 * without a second, competing signal; `aria-pressed` is a pure output the
 * controller owns. Rotation is suspended — not cancelled — while the pointer
 * rests on the carousel, while focus is inside it, and while the tab is hidden;
 * each suspension lifts on its own (WCAG 2.2.2 is met by the toggle, which is
 * the one control that stops rotation for good). A carousel with nothing left to
 * advance to (one slide, or the last slide of a non-looping set) normalizes
 * `autoplay` to `false` and marks the toggle `aria-disabled`. `prefers-reduced-motion`
 * does the same at connect, leaving an explicit press free to start rotation.
 *
 * The interval is cleared on `disconnect()` (Turbo navigation included), and the
 * leased ARIA is returned before Turbo caches the page. Picker arrow keys, `Home`,
 * and `End` move focus only (manual activation); slide changes never steal focus
 * from the control the user operated. A slide change the user drove — including an
 * autoplay tick they started — is reported as `stimeo--carousel:change` with
 * `{ index, total }`; the same detail arrives as `stimeo--carousel:reconcile` when
 * the controller re-derives the position itself, whether a target came or went or
 * a retained element's state attributes were rewritten in place.
 */
export class CarouselController extends Controller<HTMLElement> {
  static override targets = ["slide", "viewport", "prev", "next", "picker", "playToggle"];
  static override values = {
    autoplay: { type: Boolean, default: false },
    interval: { type: Number, default: DEFAULT_INTERVAL },
    loop: { type: Boolean, default: true },
  };
  static actions = [
    "goto",
    "next",
    "onPickerKeydown",
    "pause",
    "prev",
    "resume",
    "togglePlay",
  ] as const;
  static events = ["change", "pause", "play", "reconcile"] as const;

  declare readonly slideTargets: HTMLElement[];
  declare readonly pickerTargets: HTMLElement[];
  declare readonly viewportTarget: HTMLElement;
  declare readonly hasViewportTarget: boolean;
  declare readonly prevTargets: HTMLElement[];
  declare readonly nextTargets: HTMLElement[];
  declare readonly playToggleTargets: HTMLElement[];
  declare autoplayValue: boolean;
  declare intervalValue: number;
  declare loopValue: boolean;

  readonly #roving = new RovingTabindex(() => this.pickerTargets);
  readonly #reconcileTargets = new MicrotaskCoalescer(() => this.#reconcileTargetSet());
  readonly #intervals = new SafeInterval();
  /** Unreachable step controls and the toggle of a carousel that cannot rotate. */
  readonly #ariaDisabled = new AttributeLease<HTMLElement>("aria-disabled");
  /** The slide container's live-region politeness, which tracks the rotation. */
  readonly #ariaLive = new AttributeLease<HTMLElement>("aria-live");
  /** Pairs with {@link CarouselController.#ariaLive}: only the changed slide is read. */
  readonly #ariaAtomic = new AttributeLease<HTMLElement>("aria-atomic");
  readonly #beforeCache = new BeforeCacheReset(() => this.#returnLeases());
  /**
   * Events an authored action binding already took. The delegated listener runs
   * later — it sits on the controller element, above every control — so it can
   * consume the mark and stand down, letting the two wirings coexist without
   * handling one interaction twice.
   */
  readonly #handledEvents = new WeakSet<Event>();

  /**
   * Whether `connect()` has run. Scheduling is already inert outside that window
   * ({@link MicrotaskCoalescer}), so this gates the Value callbacks Stimulus
   * delivers ahead of `connect()`.
   */
  #connected = false;
  /** Index of the visible slide. */
  #index = 0;
  /** The visible slide element, which identifies it across a changing target set. */
  #activeSlide: HTMLElement | null = null;
  /** Slide count at the last resolved state, so a changed total is reportable. */
  #total = 0;
  /** Pointer rests on the carousel: a suspension that lifts on `mouseleave`. */
  #pointerPaused = false;
  /** Focus is inside the carousel: a suspension that lifts when it leaves. */
  #focusPaused = false;
  /** The tab is in the background: a suspension that lifts when it returns. */
  #hiddenPaused = false;
  /** Id of the live autoplay interval, or null when stopped. */
  #timerId: number | null = null;
  /** Delay the live interval was armed with, so an `interval` change re-arms it. */
  #timerInterval = 0;
  /** Follows state-attribute rewrites on retained slides and pickers. */
  #observer: MutationObserver | null = null;

  /** Keeps a hidden tab from advancing behind the user's back. */
  readonly #onVisibilityChange = (): void => {
    this.#hiddenPaused = document.visibilityState === "hidden";
    this.#syncTimer();
  };

  /**
   * Renders the initial slide, wires the delegated listeners, and starts autoplay
   * when requested.
   *
   * Every suspension is re-derived from the environment rather than carried, so an
   * in-page move — which Stimulus delivers to the *same* controller instance as
   * `disconnect()` then `connect()` — cannot strand the carousel in a suspension
   * whose lifting event will never arrive. The attribute observer starts after the
   * first render so the controller's own opening writes are not fed back to it.
   */
  override connect(): void {
    this.#pointerPaused = this.element.matches(":hover");
    this.#focusPaused = this.element.contains(document.activeElement);
    this.#hiddenPaused = document.visibilityState === "hidden";
    if (this.autoplayValue && prefersReducedMotion()) this.autoplayValue = false;
    this.#index = this.#resolveIndex();
    this.#render({ focus: false });
    this.#total = this.slideTargets.length;
    this.#syncTimer();
    this.#connected = true;
    this.#reconcileTargets.activate();
    this.#beforeCache.activate();

    this.element.addEventListener("click", this.#onClick);
    this.element.addEventListener("keydown", this.#onKeydown);
    this.element.addEventListener("focusin", this.#onFocusin);
    this.element.addEventListener("focusout", this.#onFocusout);
    this.element.addEventListener("mouseenter", this.#onMouseenter);
    this.element.addEventListener("mouseleave", this.#onMouseleave);
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
    this.#observer = new MutationObserver(this.#onAttributeMutations);
    this.#observer.observe(this.element, {
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
  }

  /** Releases every listener and observer, returns the leased ARIA, drops the suspensions. */
  override disconnect(): void {
    this.#connected = false;
    this.element.removeEventListener("click", this.#onClick);
    this.element.removeEventListener("keydown", this.#onKeydown);
    this.element.removeEventListener("focusin", this.#onFocusin);
    this.element.removeEventListener("focusout", this.#onFocusout);
    this.element.removeEventListener("mouseenter", this.#onMouseenter);
    this.element.removeEventListener("mouseleave", this.#onMouseleave);
    document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#reconcileTargets.cancel();
    this.#intervals.clearAll();
    this.#timerId = null;
    this.#pointerPaused = false;
    this.#focusPaused = false;
    this.#hiddenPaused = false;
    this.#activeSlide = null;
    this.#returnLeases();
    this.#beforeCache.deactivate();
  }

  /**
   * Re-establishes the single selected picker when one is added after connect.
   *
   * Without this an appended picker that arrives `aria-selected="true"` leaves two
   * marked at once — the authored pre-selection is only read on connect, so
   * nothing else ever resolves the conflict. The current slide is kept: the
   * repaint re-derives every picker from `#index`, so a late arrival never steals
   * the selection.
   */
  pickerTargetConnected(picker: HTMLElement): void {
    picker.tabIndex = -1;
    this.#reconcileTargets.schedule();
  }

  /** Repairs selection and roving after a picker leaves a retained carousel. */
  pickerTargetDisconnected(): void {
    this.#reconcileTargets.schedule();
  }

  /** Reconciles a slide added in the same DOM batch as its picker. */
  slideTargetConnected(): void {
    this.#reconcileTargets.schedule();
  }

  /** Re-clamps the active index after a slide is removed. */
  slideTargetDisconnected(): void {
    this.#reconcileTargets.schedule();
  }

  /** Follows a rotation intent the page changed at runtime. */
  autoplayValueChanged(): void {
    if (this.#connected) this.#syncTimer();
  }

  /** Re-arms the live interval at the new delay without reporting a state change. */
  intervalValueChanged(): void {
    if (this.#connected) this.#syncTimer();
  }

  /** Re-publishes the step controls and re-evaluates the non-looping end. */
  loopValueChanged(): void {
    if (!this.#connected) return;
    this.#render({ focus: false });
    this.#syncTimer();
  }

  /** Advances to the next slide. Delegated; `data-action` wiring is optional. */
  next(event?: Event): void {
    if (event?.defaultPrevented) return;
    this.#markHandled(event);
    this.#select(this.#step(1), { focus: false });
  }

  /** Returns to the previous slide. Delegated; `data-action` wiring is optional. */
  prev(event?: Event): void {
    if (event?.defaultPrevented) return;
    this.#markHandled(event);
    this.#select(this.#step(-1), { focus: false });
  }

  /** Jumps to the slide whose picker was activated (click / Enter / Space). */
  goto(event: Event): void {
    if (event.defaultPrevented) return;
    this.#markHandled(event);
    const index = this.#pickerIndexFor(event.currentTarget);
    if (index !== -1) this.#select(index, { focus: false });
  }

  /**
   * Flips the rotation intent on the user's explicit request.
   *
   * The intent is written back to the `autoplay` Value, which is where every other
   * path reads it from. A carousel with nothing to advance to has no intent to
   * flip: the toggle is marked `aria-disabled` and does nothing.
   */
  togglePlay(event?: Event): void {
    if (event?.defaultPrevented) return;
    this.#markHandled(event);
    this.#togglePlay();
  }

  /**
   * Suspends rotation. A `focus`-family event records that focus is inside the
   * carousel; anything else — hover, or a bare programmatic call — records the
   * pointer suspension. Both lift through the matching {@link resume}, and
   * neither touches the rotation intent.
   */
  pause(event?: Event): void {
    this.#markHandled(event);
    if (isFocusEvent(event)) this.#focusPaused = true;
    else this.#pointerPaused = true;
    this.#syncTimer();
  }

  /**
   * Lifts the matching suspension. A `focusout` whose `relatedTarget` is still
   * inside the carousel is focus moving between its own controls, which leaves the
   * focus suspension in place — releasing it there would stop and restart the
   * interval on every Tab press.
   */
  resume(event?: Event): void {
    this.#markHandled(event);
    if (isFocusEvent(event)) {
      if (this.#focusStaysInside(event)) return;
      this.#focusPaused = false;
    } else {
      this.#pointerPaused = false;
    }
    this.#syncTimer();
  }

  /** Picker roving for authored bindings; the delegated path is `#onKeydown`. */
  onPickerKeydown(event: KeyboardEvent): void {
    const index = this.#pickerIndexFor(event.currentTarget);
    if (index === -1) return;
    this.#markHandled(event);
    this.#handlePickerKeydown(event, index);
  }

  /** Delegated activation for pickers and step controls without authored actions. */
  readonly #onClick = (event: MouseEvent): void =>
    this.#delegate(event, () => {
      const index = this.#pickerIndexFor(event.target);
      if (index !== -1) {
        this.#select(index, { focus: false });
      } else if (hits(this.nextTargets, event.target)) {
        this.#select(this.#step(1), { focus: false });
      } else if (hits(this.prevTargets, event.target)) {
        this.#select(this.#step(-1), { focus: false });
      } else if (hits(this.playToggleTargets, event.target)) {
        this.#togglePlay();
      }
    });

  /** Delegated picker roving for pickers without authored actions. */
  readonly #onKeydown = (event: KeyboardEvent): void =>
    this.#delegate(event, () => {
      const index = this.#pickerIndexFor(event.target);
      if (index !== -1) this.#handlePickerKeydown(event, index);
    });

  /** Focus arriving anywhere inside suspends the rotation. */
  readonly #onFocusin = (event: FocusEvent): void =>
    this.#delegate(event, () => {
      this.#focusPaused = true;
      this.#syncTimer();
    });

  /** Focus genuinely leaving lifts the suspension; moves between own controls do not. */
  readonly #onFocusout = (event: FocusEvent): void =>
    this.#delegate(event, () => {
      if (this.#focusStaysInside(event)) return;
      this.#focusPaused = false;
      this.#syncTimer();
    });

  /** Pointer entry suspends the rotation. */
  readonly #onMouseenter = (event: MouseEvent): void =>
    this.#delegate(event, () => {
      this.#pointerPaused = true;
      this.#syncTimer();
    });

  /** Pointer exit lifts the suspension. */
  readonly #onMouseleave = (event: MouseEvent): void =>
    this.#delegate(event, () => {
      this.#pointerPaused = false;
      this.#syncTimer();
    });

  /**
   * Schedules one reconciliation when a state attribute is rewritten in place —
   * the only shape of change no target callback reports.
   *
   * The filter is the `attributeFilter` alone: those three attributes belong to
   * the slides and pickers, and a coalesced pass over an unrelated one costs a
   * repaint that writes nothing. Narrowing further here would add a branch no
   * test could distinguish.
   */
  readonly #onAttributeMutations = (): void => {
    this.#reconcileTargets.schedule();
  };

  /**
   * Records that an action binding took this event.
   *
   * An authored binding sits on the control, so it runs while the event is still
   * below the controller element and always precedes the delegated listener.
   * Marking is the one signal that keeps the two wirings from both acting.
   */
  #markHandled(event?: Event): void {
    if (event) this.#handledEvents.add(event);
  }

  /** Runs a delegated handler unless an action binding, or a descendant, took the event. */
  #delegate(event: Event, run: () => void): void {
    if (this.#handledEvents.delete(event) || event.defaultPrevented) return;
    run();
  }

  /** Position of the picker that is or contains `node`, or `-1` when none does. */
  #pickerIndexFor(node: EventTarget | null): number {
    return this.pickerTargets.findIndex(
      (picker) => node instanceof Node && (picker === node || picker.contains(node)),
    );
  }

  /** Whether a focus transition lands on another control of this same carousel. */
  #focusStaysInside(event: FocusEvent): boolean {
    const next = event.relatedTarget;
    return next instanceof Node && this.element.contains(next);
  }

  /** Flips the rotation intent, unless there is nothing to rotate to. */
  #togglePlay(): void {
    if (!this.#canAutoplay()) return;
    this.autoplayValue = !this.autoplayValue;
    this.#syncTimer();
  }

  /** Applies the APG picker key map: arrows, Home, and End all move focus only. */
  #handlePickerKeydown(event: KeyboardEvent, current: number): void {
    // A descendant widget that already claimed the key must not ALSO move the
    // picker focus — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;

    const length = this.pickerTargets.length;
    // Logical, not physical. The helper reverses only the horizontal
    // pair, so folding Down/Up into the same branch stays correct.
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowUp": {
        event.preventDefault();
        const step = logicalArrowStep(event.key, this.element);
        this.#roving.setActive(rovingMove(current, length, step, "wrap"), { focus: true });
        return;
      }
      // A chorded Home/End is a document-level shortcut (`Control+Home` scrolls
      // the page) that belongs to the browser, exactly as a chorded arrow does.
      case "Home":
        if (hasModifier(event)) return;
        event.preventDefault();
        this.#roving.setActive(0, { focus: true });
        return;
      case "End":
        if (hasModifier(event)) return;
        event.preventDefault();
        this.#roving.setActive(length - 1, { focus: true });
        return;
      default:
    }
  }

  /**
   * Resolves the index one step away from the current one, honoring `loop`.
   *
   * Bounding is {@link CarouselController.#clampToSlides}'s job alone, so an
   * empty set is allowed to fall out of the arithmetic here rather than being
   * special-cased in two places that could disagree.
   */
  #step(delta: number): number {
    const total = this.slideTargets.length;
    const next = this.#index + delta;
    if (this.loopValue) return (next + total) % total;
    return Math.min(total - 1, Math.max(0, next));
  }

  /**
   * Confines an index to the slide range, so no index can hide every slide.
   *
   * The single place an index is bounded: an empty set collapses to the first
   * position, which is also where a non-numeric step from that empty set lands.
   */
  #clampToSlides(index: number): number {
    const last = this.slideTargets.length - 1;
    if (last < 0) return 0;
    return Math.min(last, Math.max(0, index));
  }

  /**
   * Changes the active slide, updates state hooks, and emits `change` — but only
   * when the index actually changes, so a `next`/`prev` clamped at the end (or an
   * autoplay tick at a non-looping boundary) re-renders without a spurious event
   * (matching the "emit on real change" policy of flash/masonry/bulk-select).
   */
  #select(index: number, { focus }: { focus: boolean }): void {
    const target = this.#clampToSlides(index);
    const changed = target !== this.#index;
    this.#index = target;
    this.#render({ focus });
    // Re-evaluate autoplay after every move so reaching the non-looping end stops
    // the timer (see `#syncTimer`); idempotent for moves that don't cross a boundary.
    this.#syncTimer();
    if (changed) {
      this.dispatch("change", { detail: { index: target, total: this.slideTargets.length } });
    }
  }

  /**
   * Reflects `this.#index` onto the slides, the pickers, and the step controls.
   *
   * Every observed attribute is written only when its value actually changes: the
   * same writes are watched by {@link CarouselController.#onAttributeMutations},
   * and an unconditional rewrite would feed the controller its own output.
   *
   * @stimeoRenderRoot
   */
  #render({ focus }: { focus: boolean }): void {
    this.#activeSlide = this.slideTargets[this.#index] ?? null;
    this.slideTargets.forEach((slide, i) => {
      const active = i === this.#index;
      setAttributeIfChanged(slide, "data-state", active ? "active" : "inactive");
      if (slide.hidden !== !active) slide.hidden = !active;
      // `hidden` alone is a style a slide track's own CSS overrides; `inert` is not.
      slide.toggleAttribute("inert", !active);
    });
    // The picker set can be shorter than the slide set (a picker removed on its
    // own, or a carousel that only pickers part of its slides). Resolving the
    // selection inside the picker range keeps exactly one selected tab and one Tab
    // stop; an out-of-range index would leave every picker at `tabindex="-1"` and
    // strand the tablist outside the Tab sequence.
    const pickerIndex = Math.min(this.#index, this.pickerTargets.length - 1);
    this.pickerTargets.forEach((picker, i) => {
      setAttributeIfChanged(picker, "aria-selected", i === pickerIndex ? "true" : "false");
    });
    this.#roving.setActive(pickerIndex, { focus });
    this.#syncStepControls();
  }

  /** Marks the step control a non-looping carousel has no slide left to reach. */
  #syncStepControls(): void {
    const last = this.slideTargets.length - 1;
    const atStart = !this.loopValue && this.#index <= 0;
    const atEnd = !this.loopValue && this.#index >= last;
    for (const button of this.prevTargets) {
      this.#ariaDisabled.write(button, atStart ? "true" : null);
    }
    for (const button of this.nextTargets) {
      this.#ariaDisabled.write(button, atEnd ? "true" : null);
    }
  }

  /**
   * Resolves which slide is current from the strongest evidence available.
   *
   * A single `data-state="active"` is unambiguous and wins, which is what restores
   * the visible slide after a Turbo cache restore even with no pickers present.
   * Competing claims — a slide inserted already marked active — are settled by the
   * element the last render actually showed, so a newcomer never displaces what the
   * reader is looking at. With no claim at all the authored picker selection
   * decides, first in DOM order; failing that the previous position is kept.
   */
  #resolveIndex(): number {
    const slides = this.slideTargets;
    const claims: number[] = [];
    slides.forEach((slide, index) => {
      if (slide.getAttribute("data-state") === "active") claims.push(index);
    });
    if (claims.length > 1 && this.#activeSlide !== null) {
      const live = slides.indexOf(this.#activeSlide);
      if (claims.includes(live)) return live;
    }
    const claimed = claims[0];
    if (claimed !== undefined) return claimed;

    const selected = this.pickerTargets.findIndex(
      (picker) => picker.getAttribute("aria-selected") === "true",
    );
    return this.#clampToSlides(selected === -1 ? this.#index : selected);
  }

  /** Re-resolves the active slide after the target set changed and reports the move. */
  #reconcileTargetSet(): void {
    const previousIndex = this.#index;
    const previousTotal = this.#total;
    this.#index = this.#resolveIndex();
    this.#render({ focus: false });
    this.#total = this.slideTargets.length;
    this.#syncTimer();
    // `change` stays reserved for user navigation; re-resolving onto a surviving
    // slide, or reporting a set that grew or shrank, is this controller's decision.
    if (this.#index !== previousIndex || this.#total !== previousTotal) {
      this.dispatch("reconcile", { detail: { index: this.#index, total: this.#total } });
    }
  }

  /** Whether autoplay has anywhere left to advance to. */
  #canAutoplay(): boolean {
    const total = this.slideTargets.length;
    if (total <= 1) return false;
    return this.loopValue || this.#index < total - 1;
  }

  /** The advance delay; a non-finite or non-positive declaration falls back. */
  get #interval(): number {
    const declared = this.intervalValue;
    return Number.isFinite(declared) && declared > 0 ? declared : DEFAULT_INTERVAL;
  }

  /**
   * Drives the autoplay interval toward the desired state and publishes it.
   *
   * Rotation runs when the intent is on, nothing suspends it, and a slide is left
   * to advance to. A carousel that has run out normalizes the intent to `false`, so
   * `aria-pressed` never claims a rotation that cannot happen. Crossing the
   * run/stop boundary emits `play`/`pause`; re-arming at a new `interval` is the
   * same state and stays silent.
   */
  #syncTimer(): void {
    const canAutoplay = this.#canAutoplay();
    if (this.autoplayValue && !canAutoplay) this.autoplayValue = false;

    const shouldRun =
      this.autoplayValue &&
      canAutoplay &&
      !this.#pointerPaused &&
      !this.#focusPaused &&
      !this.#hiddenPaused;
    const wasRunning = this.#timerId !== null;
    const interval = this.#interval;

    if (this.#timerId !== null && (!shouldRun || interval !== this.#timerInterval)) {
      this.#intervals.clear(this.#timerId);
      this.#timerId = null;
    }
    if (shouldRun && this.#timerId === null) {
      this.#timerInterval = interval;
      this.#timerId = this.#intervals.set(() => this.next(), interval);
    }
    // The events are edges. A consumer that subscribes after `connect()` — which
    // is every consumer on a Turbo restore, where the controller reconnects before
    // the page's own scripts run again — would miss the transition it arrived in
    // the middle of, so the same state is published as a hook it can read.
    setAttributeIfChanged(this.element, "data-state", shouldRun ? "playing" : "paused");
    if (shouldRun !== wasRunning) {
      if (shouldRun) this.dispatch("play");
      else this.dispatch("pause");
    }

    for (const toggle of this.playToggleTargets) {
      toggle.setAttribute("aria-pressed", this.autoplayValue ? "true" : "false");
      this.#ariaDisabled.write(toggle, canAutoplay ? null : "true");
    }
    if (this.hasViewportTarget) {
      this.#ariaLive.write(this.viewportTarget, shouldRun ? "off" : "polite");
      this.#ariaAtomic.write(this.viewportTarget, "false");
    }
  }

  /** Hands every leased attribute back to the value the consumer authored. */
  #returnLeases(): void {
    this.#ariaDisabled.returnAll();
    this.#ariaLive.returnAll();
    this.#ariaAtomic.returnAll();
  }
}

/** Whether an event names a focus transition rather than a pointer one. */
function isFocusEvent(event?: Event): event is FocusEvent {
  return event?.type.startsWith("focus") === true;
}

/** Whether a key arrived with a modifier that makes it the browser's shortcut. */
function hasModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/** Whether `node` is one of `elements` or sits inside one. */
function hits(elements: readonly HTMLElement[], node: EventTarget | null): boolean {
  return elements.some(
    (element) => node instanceof Node && (element === node || element.contains(node)),
  );
}

/** Writes an attribute only on a real transition, so an observer sees no self-echo. */
function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
