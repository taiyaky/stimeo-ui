import { Controller } from "@hotwired/stimulus";

/** The three selectable modes; `system` follows the OS `prefers-color-scheme`. */
type ThemeMode = "light" | "dark" | "system";
/** The two effective (resolved) themes applied to the root. */
type ResolvedTheme = "light" | "dark";

const MODES: readonly ThemeMode[] = ["light", "dark", "system"];
const isMode = (value: unknown): value is ThemeMode =>
  typeof value === "string" && (MODES as readonly string[]).includes(value);

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
 *             data-stimeo--theme-mode-param="light">Light</button>
 *     <button data-stimeo--theme-target="option" role="radio"
 *             data-action="click->stimeo--theme#set"
 *             data-stimeo--theme-mode-param="dark">Dark</button>
 *     <button data-stimeo--theme-target="option" role="radio"
 *             data-action="click->stimeo--theme#set"
 *             data-stimeo--theme-mode-param="system">System</button>
 *   </div>
 *
 * Auxiliary 2-value toggle (light↔dark only — `system` is not representable):
 *   <button data-controller="stimeo--theme" data-action="click->stimeo--theme#toggle"
 *           aria-pressed="false">Dark mode</button>
 *
 * @remarks
 * Behavior only — the actual palette is the consumer's CSS keyed off `data-theme`
 * on the root. It applies `data-theme` (the *resolved* light/dark) and a matching
 * `color-scheme` to the `target` element (`<html>` by default), keeps the radiogroup
 * `aria-checked` + roving tabindex (APG radio) or the single button's `aria-pressed`
 * in sync, and never moves focus. The `prefers-color-scheme` listener is attached on
 * `connect()` and removed on `disconnect()` (Turbo included). FOUC avoidance for the
 * very first paint is an inline `<head>` snippet (documented), not this controller.
 */
export class ThemeController extends Controller<HTMLElement> {
  static override targets = ["option"];
  static override values = {
    mode: { type: String, default: "system" },
    storageKey: { type: String, default: "stimeo-theme" },
    target: { type: String, default: "html" },
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

  /** Re-resolves while in `system` mode when the OS preference flips. */
  readonly #onMediaChange = (): void => {
    if (this.modeValue === "system") {
      this.#applyTheme();
      // Re-sync controls too: a 2-value toggle's `aria-pressed` reflects the
      // *resolved* theme, so it must follow the OS flip — not only `data-theme`.
      this.#syncControls();
      this.#dispatchChange();
    }
  };

  /** Arrow/Home/End navigation for the radiogroup (APG radio pattern). */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    // Resolved once per keydown: every `optionTargets` access re-queries the scope.
    const options = this.optionTargets;
    if (options.length === 0) return;
    const target = event.target as HTMLElement | null;
    const current = options.indexOf(target as HTMLElement);
    if (current === -1) return;

    const last = options.length - 1;
    let next = current;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = current === last ? 0 : current + 1;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = current === 0 ? last : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const option = options[next];
    if (!option) return;
    option.focus();
    this.#setMode(this.#optionMode(option));
  };

  override connect(): void {
    const stored = this.#readStored();
    if (stored) this.modeValue = stored;

    this.#media = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    this.#media?.addEventListener("change", this.#onMediaChange);
    if (this.hasOptionTarget) this.element.addEventListener("keydown", this.#onKeydown);

    this.#applyTheme();
    this.#syncControls();
  }

  override disconnect(): void {
    this.#media?.removeEventListener("change", this.#onMediaChange);
    this.element.removeEventListener("keydown", this.#onKeydown);
  }

  /** Selects an explicit mode from the `mode` action param (radiogroup option). */
  set(event: Event): void {
    const mode = (event as { params?: Record<string, unknown> }).params?.mode;
    if (isMode(mode)) this.#setMode(mode);
  }

  /** Toggles light↔dark for the 2-value single-button contract. */
  toggle(): void {
    this.#setMode(this.#resolved() === "dark" ? "light" : "dark");
  }

  /** Central mode change: persist, apply to the root, resync controls, announce. */
  #setMode(mode: ThemeMode): void {
    this.modeValue = mode;
    this.#writeStored(mode);
    this.#applyTheme();
    this.#syncControls();
    this.#dispatchChange();
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
      let hasTabbable = false;
      for (const option of options) {
        const selected = this.#optionMode(option) === this.modeValue;
        option.setAttribute("aria-checked", String(selected));
        option.tabIndex = selected ? 0 : -1;
        hasTabbable ||= selected;
      }
      // APG: a radiogroup with no selection keeps its first radio tabbable.
      const first = options[0];
      if (!hasTabbable && first) first.tabIndex = 0;
      return;
    }
    this.element.setAttribute("aria-pressed", String(this.#resolved() === "dark"));
  }

  /** Emits `change` with the selected mode and the resolved theme. */
  #dispatchChange(): void {
    this.dispatch("change", { detail: { mode: this.modeValue, resolved: this.#resolved() } });
  }

  /** The effective theme: the OS preference when `system`, else the mode itself. */
  #resolved(): ResolvedTheme {
    if (this.modeValue === "dark") return "dark";
    if (this.modeValue === "light") return "light";
    return this.#media?.matches ? "dark" : "light";
  }

  /** Reads an option's mode from its action param attribute. */
  #optionMode(option: HTMLElement): ThemeMode {
    const mode = option.getAttribute("data-stimeo--theme-mode-param");
    return isMode(mode) ? mode : "system";
  }

  /** Resolves the state-hook target (`<html>` by default). */
  #targetElement(): HTMLElement | null {
    if (this.targetValue === "html" || this.targetValue === ":root")
      return document.documentElement;
    return document.querySelector<HTMLElement>(this.targetValue);
  }

  /** Reads a persisted, validated mode from `localStorage` (null when absent/blocked). */
  #readStored(): ThemeMode | null {
    try {
      const value = window.localStorage.getItem(this.storageKeyValue);
      return isMode(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** Persists the mode, swallowing storage errors (private mode / quota). */
  #writeStored(mode: ThemeMode): void {
    try {
      window.localStorage.setItem(this.storageKeyValue, mode);
    } catch {
      /* storage unavailable — the in-DOM state hooks still apply this session */
    }
  }
}
