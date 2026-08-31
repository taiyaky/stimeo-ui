import { Controller } from "@hotwired/stimulus";
import { hasModifierChord, isReservedArrowChord, logicalArrowStep } from "../utils/arrow_step";
import { RovingTabindex, rovingMove } from "../utils/roving_tabindex";
import { readLocalStorage, writeLocalStorage } from "../utils/safe_storage";

/** The three selectable modes; `system` follows the OS `prefers-color-scheme`. */
type ThemeMode = "light" | "dark" | "system";
/** The two effective (resolved) themes applied to the root. */
type ResolvedTheme = "light" | "dark";

const MODES: readonly ThemeMode[] = ["light", "dark", "system"];
const isMode = (value: unknown): value is ThemeMode =>
  typeof value === "string" && (MODES as readonly string[]).includes(value);

/** The mode a declaration falls back to when it cannot be read as one. */
const DEFAULT_MODE: ThemeMode = "system";
/** The state-hook target a declaration falls back to when it cannot be parsed. */
const DEFAULT_TARGET = "html";

/**
 * Headless **theme / color-scheme toggle** — persists a light/dark/system choice to
 * `localStorage`, follows the OS setting while in `system`, and reflects the
 * effective theme onto the root for the consumer's CSS. Ships no colors; only state
 * hooks.
 *
 * Two markup contracts (identifier: `stimeo--theme`):
 *
 * Canonical 3-value radiogroup (use this when `system` is offered):
 *   <div data-controller="stimeo--theme" data-stimeo--theme-mode-value="system"
 *        role="radiogroup" aria-label="Theme">
 *     <button data-stimeo--theme-target="option" role="radio"
 *             data-action="click->stimeo--theme#set"
 *             data-value="light">Light</button>
 *     <button data-stimeo--theme-target="option" role="radio"
 *             data-action="click->stimeo--theme#set"
 *             data-value="dark">Dark</button>
 *     <button data-stimeo--theme-target="option" role="radio"
 *             data-action="click->stimeo--theme#set"
 *             data-value="system">System</button>
 *   </div>
 *
 * Auxiliary 2-value toggle (light↔dark only — `system` is not representable):
 *   <button data-controller="stimeo--theme" data-action="click->stimeo--theme#toggle"
 *           aria-pressed="false">Dark mode</button>
 *
 * `change` dispatches `{ mode, resolved }`, and only when one of the two moved.
 *
 * @remarks
 * Behavior only — the actual palette is the consumer's CSS keyed off `data-theme`
 * on the root. It applies `data-theme` (the *resolved* light/dark) and a matching
 * `color-scheme` to the `target` element (`<html>` by default), keeps the radiogroup
 * `aria-checked` + roving tabindex (APG radio) or the single button's `aria-pressed`
 * in sync, and never moves focus. The `prefers-color-scheme` listener is attached on
 * `connect()` and removed on `disconnect()` (Turbo included). FOUC avoidance for the
 * very first paint is an inline `<head>` snippet, not this controller.
 *
 * Every declaration is validated where it enters, and an unreadable one falls back
 * to that Value's default rather than taking the widget with it: a `mode` outside
 * the three modes reads as `system`, and a `target` that is not a parsable selector
 * reads as `html`. An option whose `data-value` is outside the three can be focused
 * but never becomes the selection, so no more than one option is ever checked —
 * and none at all when the resolved mode matches no option, where the first one
 * keeps the Tab stop.
 *
 * The radiogroup stays one Tab stop through {@link RovingTabindex}, re-derived
 * whenever an option enters or leaves, so a set rendered after connect or swapped
 * by a Turbo morph carries the same single stop as any other.
 */
export class ThemeController extends Controller<HTMLElement> {
  static override targets = ["option"];
  static override values = {
    mode: { type: String, default: DEFAULT_MODE },
    storageKey: { type: String, default: "stimeo-theme" },
    target: { type: String, default: DEFAULT_TARGET },
  };
  static actions = ["set", "toggle"] as const;
  static events = ["change"] as const;

  declare readonly optionTargets: HTMLElement[];
  declare readonly hasOptionTarget: boolean;

  declare modeValue: string;
  declare storageKeyValue: string;
  declare targetValue: string;

  /** The OS dark-mode query, watched so `system` tracks live changes. */
  #media: MediaQueryList | null = null;

  /** Gate for the target callbacks, which Stimulus runs before `connect()`. */
  #connected = false;

  /** The `target` declaration after validation; the default when unparsable. */
  #targetSelector = DEFAULT_TARGET;

  /** Owns the single Tab stop across the option set (APG radiogroup). */
  readonly #roving = new RovingTabindex(() => this.optionTargets);

  /**
   * The pair last reported, so a move can be told from a repeat. Neither side is
   * readable after the fact — assigning the Value updates the mode before any
   * comparison, and the OS query has already flipped by the time it notifies —
   * so what was reported has to be kept rather than recomputed.
   */
  #published: { mode: ThemeMode; resolved: ResolvedTheme } = {
    mode: DEFAULT_MODE,
    resolved: "light",
  };

  /** Re-resolves while in `system` mode when the OS preference flips. */
  readonly #onMediaChange = (): void => {
    // Only `system` follows the OS; an explicit mode already decided the answer.
    if (this.#mode !== "system") return;
    this.#commit();
  };

  /** Arrow/Home/End navigation for the radiogroup (APG radio pattern). */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO act on it — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    // Resolved once per keydown: every `optionTargets` access re-queries the scope.
    const options = this.optionTargets;
    const target = event.target as HTMLElement | null;
    const current = options.indexOf(target as HTMLElement);
    if (current === -1) return;

    let next = current;
    // Logical, not physical. The helper reverses only the horizontal pair, so
    // folding Down/Up into the same branch stays correct.
    const step = logicalArrowStep(event.key, this.element);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowLeft":
        next = rovingMove(current, options.length, step, "wrap");
        break;
      case "Home":
      case "End":
        // Control+Home jumps the document, not the widget.
        if (hasModifierChord(event)) return;
        next = event.key === "Home" ? 0 : options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    option.focus();
    const mode = this.#optionMode(option);
    // An option outside the three modes can hold focus, but the selection does
    // not follow it there.
    if (mode) this.#setMode(mode);
  };

  override connect(): void {
    const stored = this.#readStored();
    if (stored) this.modeValue = stored;

    this.#media = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    this.#media?.addEventListener("change", this.#onMediaChange);
    this.element.addEventListener("keydown", this.#onKeydown);

    this.#connected = true;
    this.#applyTheme();
    this.#syncControls();
    // Connecting is not a change: seed the baseline instead of announcing one.
    this.#published = this.#current;
  }

  override disconnect(): void {
    this.#connected = false;
    this.#media?.removeEventListener("change", this.#onMediaChange);
    this.element.removeEventListener("keydown", this.#onKeydown);
  }

  /** Validates the `target` declaration once, so the render path never parses. */
  targetValueChanged(): void {
    const selector = this.targetValue;
    if (selector.length > 0) {
      try {
        this.element.matches(selector);
        this.#targetSelector = selector;
        return;
      } catch {
        // Unparsable selector: fall through to the default below.
      }
    }
    this.#targetSelector = DEFAULT_TARGET;
  }

  /** Re-derives the single Tab stop and ARIA for an option set that changed. */
  optionTargetConnected(): void {
    if (this.#connected) this.#syncControls();
  }

  /** Re-derives them again when an option leaves, so a Tab stop always remains. */
  optionTargetDisconnected(): void {
    if (this.#connected) this.#syncControls();
  }

  /**
   * Selects the mode the activated option declares.
   *
   * Read through {@link ThemeController.#optionMode}, the same lane that decides
   * which option is checked, so the two can never disagree about what an option
   * declares.
   */
  set(event: Event): void {
    const option = event.currentTarget;
    if (!(option instanceof HTMLElement)) return;
    const mode = this.#optionMode(option);
    if (mode) this.#setMode(mode);
  }

  /** Toggles light↔dark for the 2-value single-button contract. */
  toggle(): void {
    this.#setMode(this.#resolved() === "dark" ? "light" : "dark");
  }

  /** Central mode change: persist, apply to the root, resync controls, announce. */
  #setMode(mode: ThemeMode): void {
    this.modeValue = mode;
    this.#writeStored(mode);
    this.#commit();
  }

  /**
   * Applies the current mode and reports it, but reports only a real move: the
   * event means "the selection or the effective theme moved", so re-choosing the
   * option already chosen is not one.
   */
  #commit(): void {
    this.#applyTheme();
    this.#syncControls();
    const next = this.#current;
    const last = this.#published;
    this.#published = next;
    if (last.mode !== next.mode || last.resolved !== next.resolved) {
      // A copy: the baseline has to survive a listener that writes to what it
      // was handed, or the next unchanged operation reads as a change.
      this.dispatch("change", { detail: { ...next } });
    }
  }

  /** The pair the `change` detail carries, read from current state. */
  get #current(): { mode: ThemeMode; resolved: ResolvedTheme } {
    return { mode: this.#mode, resolved: this.#resolved() };
  }

  /** Writes `data-theme` + `color-scheme` (the resolved theme) onto the target. */
  #applyTheme(): void {
    const root = this.#targetElement();
    if (!root) return;
    const resolved = this.#resolved();
    root.setAttribute("data-theme", resolved);
    root.style.setProperty("color-scheme", resolved);
  }

  /** Keeps the radiogroup (aria-checked + roving tabindex) or toggle (aria-pressed) in sync. */
  #syncControls(): void {
    const options = this.optionTargets;
    if (options.length > 0) {
      const mode = this.#mode;
      let selected = -1;
      options.forEach((option, index) => {
        const isSelected = this.#optionMode(option) === mode;
        option.setAttribute("aria-checked", String(isSelected));
        if (isSelected && selected === -1) selected = index;
      });
      // APG: a radiogroup with no selection keeps its first radio tabbable.
      this.#roving.setActive(selected === -1 ? 0 : selected, { items: options });
      return;
    }
    // `aria-pressed` belongs to the 2-value contract, where the controller sits on
    // the button itself. A radiogroup whose options have not rendered yet is not
    // that, and must not be told it is a toggle.
    if (this.#isToggleButton) {
      this.element.setAttribute("aria-pressed", String(this.#resolved() === "dark"));
    }
  }

  /** Whether the controller element is the button of the 2-value contract. */
  get #isToggleButton(): boolean {
    return this.element.tagName === "BUTTON" || this.element.getAttribute("role") === "button";
  }

  /** The selected mode after validation; an unreadable declaration is the default. */
  get #mode(): ThemeMode {
    return isMode(this.modeValue) ? this.modeValue : DEFAULT_MODE;
  }

  /** The effective theme: the OS preference when `system`, else the mode itself. */
  #resolved(): ResolvedTheme {
    const mode = this.#mode;
    if (mode === "dark") return "dark";
    if (mode === "light") return "light";
    return this.#media?.matches ? "dark" : "light";
  }

  /** An option's mode from its `data-value`, or `null` when that is not one of the three. */
  #optionMode(option: HTMLElement): ThemeMode | null {
    const mode = option.getAttribute("data-value");
    return isMode(mode) ? mode : null;
  }

  /** Resolves the state-hook target (`<html>` by default). */
  #targetElement(): HTMLElement | null {
    const selector = this.#targetSelector;
    if (selector === DEFAULT_TARGET || selector === ":root") return document.documentElement;
    return document.querySelector<HTMLElement>(selector);
  }

  /** Reads a persisted, validated mode from `localStorage` (null when absent/blocked). */
  #readStored(): ThemeMode | null {
    const result = readLocalStorage(this.storageKeyValue);
    return result.ok && isMode(result.value) ? result.value : null;
  }

  /** Persists the mode, swallowing storage errors (private mode / quota). */
  #writeStored(mode: ThemeMode): void {
    writeLocalStorage(this.storageKeyValue, mode);
  }
}
