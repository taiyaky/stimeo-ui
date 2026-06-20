import { Controller } from "@hotwired/stimulus";
import { RovingTabindex, rovingMove } from "../utils/roving_tabindex";
import { SafeInterval } from "../utils/safe_timeout";

/**
 * Headless, accessible **Carousel** (slideshow) behavior.
 *
 * Markup contract (identifier: `stimeo--carousel`):
 *   <section data-controller="stimeo--carousel" aria-roledescription="carousel"
 *            aria-label="Featured"
 *            data-stimeo--carousel-autoplay-value="false"
 *            data-stimeo--carousel-interval-value="5000"
 *            data-stimeo--carousel-loop-value="true"
 *            data-action="mouseenter->stimeo--carousel#pause
 *                         mouseleave->stimeo--carousel#resume
 *                         focusin->stimeo--carousel#pause
 *                         focusout->stimeo--carousel#resume">
 *     <button data-stimeo--carousel-target="playToggle"
 *             data-action="stimeo--carousel#togglePlay">…</button>
 *     <div data-stimeo--carousel-target="viewport">
 *       <div role="tabpanel" data-stimeo--carousel-target="slide">…</div>
 *       <div role="tabpanel" data-stimeo--carousel-target="slide" hidden>…</div>
 *     </div>
 *     <button data-stimeo--carousel-target="prev" data-action="stimeo--carousel#prev">‹</button>
 *     <button data-stimeo--carousel-target="next" data-action="stimeo--carousel#next">›</button>
 *     <div role="tablist">
 *       <button role="tab" data-stimeo--carousel-target="picker"
 *               data-action="stimeo--carousel#goto
 *                            keydown->stimeo--carousel#onPickerKeydown"></button>
 *     </div>
 *   </section>
 *
 * Implements the WAI-ARIA APG **Carousel** (tabbed) pattern. The current slide is
 * exposed through `data-state` (`active`/`inactive`) and the `hidden` attribute on
 * inactive slides (removing them from focus order); the matching picker carries
 * `aria-selected` and the single roving `tabindex`. The play/pause toggle's
 * `aria-pressed` mirrors the autoplay state.
 *
 * @remarks
 * Behavior only — transitions, layout, and visuals are the consumer's CSS.
 * Autoplay honors WCAG 2.2.2: it suspends while the pointer is over the carousel
 * and **hard-stops** when keyboard focus enters (it does not silently resume on
 * focus out — the user must press play), so motion never surprises a keyboard
 * user. The interval is cleared on `disconnect()` (Turbo navigation included).
 * Picker arrow keys move focus only (manual activation); slide changes never steal
 * focus from the control the user operated.
 */
export class CarouselController extends Controller<HTMLElement> {
  static override targets = ["slide", "viewport", "prev", "next", "picker", "playToggle"];
  static override values = {
    autoplay: { type: Boolean, default: false },
    interval: { type: Number, default: 5000 },
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
  static events = ["change", "pause", "play"] as const;

  declare readonly slideTargets: HTMLElement[];
  declare readonly pickerTargets: HTMLElement[];
  declare readonly playToggleTarget: HTMLElement;
  declare readonly hasPlayToggleTarget: boolean;
  declare autoplayValue: boolean;
  declare intervalValue: number;
  declare loopValue: boolean;

  readonly #roving = new RovingTabindex(() => this.pickerTargets);
  readonly #intervals = new SafeInterval();
  /** Index of the visible slide. */
  #index = 0;
  /** User intent to autoplay (toggled by the play button / focus hard-stop). */
  #playing = false;
  /** Pointer is hovering the carousel: a temporary, auto-resuming suspension. */
  #pointerPaused = false;
  /** Id of the live autoplay interval, or null when stopped. */
  #timerId: number | null = null;

  /** Renders the initial slide and starts autoplay when requested. */
  override connect(): void {
    const preselected = this.pickerTargets.findIndex(
      (picker) => picker.getAttribute("aria-selected") === "true",
    );
    this.#index = preselected === -1 ? 0 : preselected;
    this.#playing = this.#initialPlaying();
    this.#render({ focus: false });
    this.#syncTimer();
  }

  /**
   * Resolves the starting autoplay intent. The play toggle's `aria-pressed` is the
   * source of truth **when present**, so a Turbo Drive cache restore / morph that
   * re-runs `connect()` against existing DOM does not silently resume autoplay the
   * user had stopped (e.g. by focusing into the carousel). Only when no toggle
   * carries `aria-pressed` does it fall back to the declarative `autoplay` value.
   */
  #initialPlaying(): boolean {
    if (this.hasPlayToggleTarget && this.playToggleTarget.hasAttribute("aria-pressed")) {
      return this.playToggleTarget.getAttribute("aria-pressed") === "true";
    }
    return this.autoplayValue;
  }

  /** Clears the autoplay interval so it never fires after teardown. */
  override disconnect(): void {
    this.#intervals.clearAll();
    this.#timerId = null;
  }

  /** Advances to the next slide. Bound via `data-action`. */
  next(): void {
    this.#select(this.#step(1), { focus: false });
  }

  /** Returns to the previous slide. Bound via `data-action`. */
  prev(): void {
    this.#select(this.#step(-1), { focus: false });
  }

  /** Jumps to the slide whose picker was activated (click / Enter / Space). */
  goto(event: Event): void {
    const target = event.currentTarget as HTMLElement;
    const index = this.pickerTargets.indexOf(target);
    if (index !== -1) this.#select(index, { focus: false });
  }

  /** Toggles autoplay on the user's explicit request and syncs the timer. */
  togglePlay(): void {
    this.#playing = !this.#playing;
    this.#syncTimer();
  }

  /**
   * Suspends autoplay. Hover (`mouseenter`) is a temporary suspension that resumes
   * on leave; keyboard focus (`focusin`) is a hard stop that turns autoplay off so
   * it cannot resume without an explicit play (WCAG 2.2.2).
   */
  pause(event?: Event): void {
    if (event?.type.startsWith("focus")) {
      this.#playing = false;
    } else {
      this.#pointerPaused = true;
    }
    this.#syncTimer();
  }

  /**
   * Lifts a hover suspension (`mouseleave`) and resumes autoplay if it is still
   * on. A `focusout` does nothing here: the focus pause was a hard stop, so the
   * user must press play to restart.
   */
  resume(event?: Event): void {
    if (event?.type.startsWith("focus")) return;
    this.#pointerPaused = false;
    this.#syncTimer();
  }

  /** Picker roving: arrows move focus only; Home/End activate first/last slide. */
  onPickerKeydown(event: KeyboardEvent): void {
    const current = this.pickerTargets.indexOf(event.currentTarget as HTMLElement);
    if (current === -1) return;

    const length = this.pickerTargets.length;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        this.#roving.setActive(rovingMove(current, length, 1, "wrap"), { focus: true });
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        this.#roving.setActive(rovingMove(current, length, -1, "wrap"), { focus: true });
        return;
      case "Home":
        event.preventDefault();
        this.#select(0, { focus: true });
        return;
      case "End":
        event.preventDefault();
        this.#select(length - 1, { focus: true });
        return;
      default:
    }
  }

  /** Resolves the index one step away from the current one, honoring `loop`. */
  #step(delta: number): number {
    const total = this.slideTargets.length;
    if (total === 0) return 0;
    const next = this.#index + delta;
    if (this.loopValue) return (next + total) % total;
    return Math.min(total - 1, Math.max(0, next));
  }

  /**
   * Changes the active slide, updates state hooks, and emits `change` — but only
   * when the index actually changes, so a `next`/`prev` clamped at the end (or an
   * autoplay tick at a non-looping boundary) re-renders without a spurious event
   * (matching the "emit on real change" policy of flash/masonry/bulk-select).
   */
  #select(index: number, { focus }: { focus: boolean }): void {
    const changed = index !== this.#index;
    this.#index = index;
    this.#render({ focus });
    // Re-evaluate autoplay after every move so reaching the non-looping end stops
    // the timer (see `#syncTimer`); idempotent for moves that don't cross a boundary.
    this.#syncTimer();
    if (changed) this.dispatch("change", { detail: { index, total: this.slideTargets.length } });
  }

  /** Reflects `this.#index` onto slides and pickers (state hooks + roving). */
  #render({ focus }: { focus: boolean }): void {
    this.slideTargets.forEach((slide, i) => {
      const active = i === this.#index;
      slide.setAttribute("data-state", active ? "active" : "inactive");
      slide.hidden = !active;
    });
    this.pickerTargets.forEach((picker, i) => {
      picker.setAttribute("aria-selected", i === this.#index ? "true" : "false");
    });
    this.#roving.setActive(this.#index, { focus });
  }

  /**
   * Drives the autoplay interval toward the desired state. Autoplay should run
   * only when the user wants it (`playing`), the pointer is not hovering, and more
   * than one slide exists. Transitions emit `play`/`pause` and keep the toggle's
   * `aria-pressed` in sync.
   */
  #syncTimer(): void {
    // A non-looping carousel sitting on its last slide has nothing left to advance
    // to, so autoplay turns itself off (a hard stop, like the focus pause): the
    // timer is cleared, `aria-pressed` flips to false, and a manual step back will
    // not silently restart it without an explicit play.
    if (!this.loopValue && this.#index >= this.slideTargets.length - 1) {
      this.#playing = false;
    }
    const shouldRun = this.#playing && !this.#pointerPaused && this.slideTargets.length > 1;

    if (shouldRun && this.#timerId === null) {
      this.#timerId = this.#intervals.set(() => this.next(), this.intervalValue);
      this.dispatch("play");
    } else if (!shouldRun && this.#timerId !== null) {
      this.#intervals.clear(this.#timerId);
      this.#timerId = null;
      this.dispatch("pause");
    }

    if (this.hasPlayToggleTarget) {
      this.playToggleTarget.setAttribute("aria-pressed", this.#playing ? "true" : "false");
    }
  }
}
