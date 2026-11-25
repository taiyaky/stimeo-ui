import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import {
  canTakeFocus,
  isRenderedForFocus,
  isTabStop,
  isUncheckedRadioInCheckedGroup,
  tabStopsWithin,
} from "../utils/focus_candidate";
import { ListenerSet } from "../utils/listener_set";

/**
 * Headless "dismissible" behavior for banners, notices, and inline alerts.
 *
 * Markup contract (identifier: `stimeo--dismissible`):
 *   <div data-controller="stimeo--dismissible"
 *        data-stimeo--dismissible-mode-value="remove">
 *     <div data-stimeo--dismissible-target="root" role="status">
 *       <p>Saved.</p>
 *       <button type="button" aria-label="Close"
 *               data-action="click->stimeo--dismissible#dismiss">×</button>
 *     </div>
 *   </div>
 *
 * A general utility with no dedicated APG pattern. Its accessibility job is to
 * keep focus from being orphaned: if focus is inside the element being removed,
 * it is moved to a safe place first so the close button vanishing never strands
 * the user (WCAG 2.4.3).
 *
 * `dismiss` dispatches `{ mode: "remove" | "hide" }`.
 *
 * @remarks
 * Behavior only — the consumer owns any exit transition (use `hide` mode, which
 * adds `hidden`, and animate off `data-state`) and any semantics like
 * `role="alert"`. Focus retreats to, in order: the `fallback` target → the next
 * focusable element after the root → the previous one → `document.body` as a
 * last resort (weak focus; prefer providing a `fallback`). Automatic destinations
 * use a native radio group's checked Tab stop, or its first eligible member going
 * forward and its last going backward when none is checked.
 *
 * A dismissal acts once, on the root present then. A root that arrives later — in
 * one task, or after an earlier one leaves in a later task — is open: it gets
 * `data-state="open"` when it carries no `data-state`, silently. A root that stops
 * resolving as the target while it stays on the page gets its authored `data-state`
 * and `hidden` back, including after a dismissal and on a restored copy. Later page
 * writes stay. Moving a root within its scope or detaching its whole host keeps the
 * current state for the next connection.
 */
export class DismissibleController extends Controller<HTMLElement> {
  static override targets = ["root", "fallback"];
  static override values = {
    mode: { type: String, default: "remove" },
    closeOnEscape: { type: Boolean, default: false },
  };
  static actions = ["dismiss"] as const;
  static events = ["dismiss"] as const;

  declare readonly rootTarget: HTMLElement;
  declare readonly rootTargets: HTMLElement[];
  declare readonly fallbackTarget: HTMLElement;
  declare readonly hasRootTarget: boolean;
  declare readonly hasFallbackTarget: boolean;

  declare modeValue: string;
  declare closeOnEscapeValue: boolean;

  /** Owns each root's state writes, returning its authored value when it leaves the scope. */
  readonly #state = new AttributeLease<HTMLElement>("data-state", this.identifier);
  /** Owns the hidden attribute a hide dismissal lends to its root. */
  readonly #hidden = new AttributeLease<HTMLElement>("hidden", this.identifier);
  /** Whether `connect()` has run for this connection; target callbacks arrive outside it too. */
  #connected = false;
  /** The Escape listener, held while connected with `closeOnEscape` on. */
  readonly #escapeListeners = new ListenerSet();

  override connect(): void {
    this.#establishOpen(this.#root);
    this.#syncEscapeListener();
    this.#connected = true;
  }

  override disconnect(): void {
    this.#connected = false;
    this.#escapeListeners.dispose();
    if (this.element.isConnected && !this.scope.containsElement(this.element)) {
      this.#returnRoot(this.element);
    }
  }

  /**
   * Writes the `open` default onto a root that arrives after connect, and gives the
   * controller element, the root while there was none, its own `data-state` back.
   */
  rootTargetConnected(root: HTMLElement): void {
    if (!this.#connected) return;
    if (!this.rootTargets.includes(this.element)) this.#returnRoot(this.element);
    this.#establishOpen(root);
  }

  /**
   * Gives a root that stays on the page outside the target set its own attributes back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page — and,
   * while connected, writes the `open` default onto the root left.
   */
  rootTargetDisconnected(root: HTMLElement): void {
    if ((root.isConnected || this.element.isConnected) && !this.rootTargets.includes(root)) {
      this.#returnRoot(root);
    }
    if (this.#connected && this.hasRootTarget) this.#establishOpen(this.rootTarget);
  }

  /** Keeps the Escape listener aligned with a live `closeOnEscape` Value. */
  closeOnEscapeValueChanged(): void {
    this.#syncEscapeListener();
  }

  /** Dismisses the element. Bound via `data-action` (click on the close button). */
  dismiss(): void {
    this.#performDismiss();
  }

  /** Dismisses on Escape when `closeOnEscape` is set and focus is inside. */
  readonly #onKeydown = (event: KeyboardEvent): void => {
    // A press during IME composition cancels the conversion (e.g. in a text
    // field inside this element), never the element itself.
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    if (!this.closeOnEscapeValue) return;
    const active = document.activeElement;
    if (!active || !this.element.contains(active)) return;
    event.preventDefault();
    this.#performDismiss();
  };

  /** Releases the Escape listener, and holds it again while `closeOnEscape` is on. */
  #syncEscapeListener(): void {
    this.#escapeListeners.dispose();
    if (this.closeOnEscapeValue) {
      this.#escapeListeners.add(this.element, "keydown", this.#onKeydown);
    }
  }

  /** Writes `data-state="open"` onto `root` when it carries no `data-state`. */
  #establishOpen(root: HTMLElement): void {
    if (!root.hasAttribute("data-state")) this.#state.write(root, "open");
  }

  /** Returns this root's leased state and visibility while preserving later page writes. */
  #returnRoot(root: HTMLElement): void {
    this.#state.return(root);
    this.#hidden.return(root);
  }

  /** The element to dismiss: the explicit `root` target, or the host element. */
  get #root(): HTMLElement {
    return this.hasRootTarget ? this.rootTarget : this.element;
  }

  /** @stimeoRuntimeOnly `mode` decides how this one dismissal takes the element away. */
  #performDismiss(): void {
    const root = this.#root;
    const mode = this.modeValue === "hide" ? "hide" : "remove";

    this.#retreatFocus(root);
    this.#state.write(root, "closing");
    // Dispatch before removal so a listener on the (about-to-leave) element still
    // runs; `dispatch` fires synchronously on `this.element`.
    this.dispatch("dismiss", { detail: { mode } });

    if (mode === "hide") {
      this.#hidden.write(root, "");
    } else {
      root.remove();
    }
  }

  /**
   * Moves focus out of `root` *before* it is removed, but only when focus is
   * actually inside it — otherwise the user's place elsewhere is left undisturbed.
   */
  #retreatFocus(root: HTMLElement): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return;

    for (const candidate of this.#focusFallbacks(root)) {
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
    document.body.focus();
    const remaining = document.activeElement;
    if (remaining instanceof HTMLElement && root.contains(remaining)) remaining.blur();
  }

  /** Yields available focus fallbacks in precedence order, stopping after focus succeeds. */
  *#focusFallbacks(root: HTMLElement): Generator<HTMLElement> {
    const explicitFallback = this.hasFallbackTarget ? this.fallbackTarget : null;
    if (
      explicitFallback &&
      !root.contains(explicitFallback) &&
      this.#isExplicitFocusAvailable(explicitFallback)
    ) {
      yield explicitFallback;
    }

    const candidates = tabStopsWithin(document).filter(
      (element) => !isUncheckedRadioInCheckedGroup(element),
    );
    for (const element of candidates) {
      if (
        element === explicitFallback ||
        root.contains(element) ||
        !(root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
      ) {
        continue;
      }
      yield element;
    }

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const element = candidates[index];
      if (!element) continue;
      if (
        element === explicitFallback ||
        root.contains(element) ||
        !(root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING)
      ) {
        continue;
      }
      yield element;
    }
  }

  /** Whether an explicit fallback can receive programmatic focus right now. */
  #isExplicitFocusAvailable(element: HTMLElement): boolean {
    const programmaticallyFocusable = element.hasAttribute("tabindex") || isTabStop(element);
    return programmaticallyFocusable && canTakeFocus(element) && isRenderedForFocus(element);
  }
}
