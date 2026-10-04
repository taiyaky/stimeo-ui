import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { ListenerSet } from "../utils/listener_set";
import type { NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeTimeout } from "../utils/safe_timeout";
import { sharedRegistry } from "../utils/shared_registry";
import { StateRegions } from "../utils/state_regions";

/** The longest delay `setTimeout` can hold; past it a delay folds to zero. */
const MAX_DELAY = 2 ** 31 - 1;

/**
 * Gives a field of a copy of a page an earlier instance revealed the `type` its author
 * wrote, from the record that instance left, and empties a field that comes back as a
 * password field, as Turbo empties one in the copy it caches.
 */
function maskCopyOf(type: AttributeLease<HTMLInputElement>, input: HTMLInputElement): void {
  const revealed = input.type === "text";
  type.return(input);
  if (revealed && input.type === "password") input.value = "";
}

/**
 * Headless password show/hide (unmask) toggle behavior.
 *
 * Markup contract (identifier: `stimeo--password-reveal`):
 *   <div data-controller="stimeo--password-reveal">
 *     <input type="password" aria-label="Password"
 *            data-stimeo--password-reveal-target="input">
 *     <button type="button" aria-pressed="false" aria-label="Show password"
 *             data-stimeo--password-reveal-target="toggle"
 *             data-action="click->stimeo--password-reveal#toggle">
 *       <span data-stimeo--password-reveal-target="offLabel">Show</span>
 *       <span data-stimeo--password-reveal-target="onLabel" hidden>Hide</span>
 *     </button>
 *   </div>
 *
 * No dedicated APG pattern; this follows the toggle **Button** practice. The
 * accessible name stays state-independent ("Show password") while the pressed
 * state is conveyed by `aria-pressed`.
 *
 * The button may carry an optional label pair — `onLabel` while the field is
 * revealed, `offLabel` while it is masked. The name comes from `aria-label`, so the
 * pair is a visual affordance: which half shows follows the state, and where only
 * one of the two is declared inside the button the author's own visibility stands.
 *
 * `toggle` dispatches `{ visible: boolean }`.
 *
 * @remarks
 * Behavior only — icon rendering is the consumer's, keyed off `aria-pressed` /
 * `data-state` (`hidden` / `visible`). Flipping `input.type` can drop focus and
 * the caret, so when (and only when) the input was the focused element its focus
 * and selection are restored afterward; when the toggle button holds focus
 * (keyboard use) focus is left on the button.
 *
 * The hooks are derived from the input's `type`, so they are re-derived whenever
 * a target enters or leaves — a field or button swapped in by a Turbo Stream
 * describes the state it actually has rather than the one the server rendered.
 *
 * An optional `autoHide` re-masks after a delay. The delay is armed on connect as
 * well, so a controller that reconnects onto an already revealed field still owes
 * the re-mask it promised; a value that is not a delay `setTimeout` can hold falls
 * back rather than inverting into an immediate one.
 *
 * **A revealed credential never comes back from the Turbo cache.** Turbo empties a
 * password field in the copy it caches, and a revealed field is a text field it leaves
 * alone. So the field is masked on `turbo:before-cache`, silently, with what the user
 * typed kept. Turbo also dispatches that event on pages that stay (a promoted frame
 * navigation, a `popstate` without Turbo state, a refresh of a cached URL, a permanent
 * element carried on), where the cost is a re-mask; the alternative is a credential left
 * in plain text in the cache, so this rewind of the live page is kept on purpose.
 * A promoted frame navigation copies the page before the event, so a copy can still
 * carry a revealed field: a new instance that finds one the author wrote as a password
 * field masks it and empties it, as Turbo would have, without dispatching `toggle`. The
 * page Turbo is about to render (`turbo:before-render`) gets the same mask first, so no
 * component connecting to a restored page reads the password before the instance that
 * adopts the field. That mask belongs to the document rather than to an instance: the
 * first connection in a document installs it and it stays for the document's life, since
 * Turbo renders every visit into the same document and a copy can come back while the
 * page being left holds no reveal toggle. It touches only the incoming page, never the
 * live one. A reconnect of the same instance (an in-page move) keeps the reveal.
 */
export class PasswordRevealController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["input", "toggle", "onLabel", "offLabel"];
  static override values = {
    autoHide: { type: Number, default: 0 },
  };

  static valueConstraints = {
    autoHide: { finite: true, allowInfinity: "positive" },
  } satisfies NumberValueConstraints<typeof PasswordRevealController.values>;
  static actions = ["toggle"] as const;
  static events = ["toggle"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly inputTargets: HTMLInputElement[];
  declare readonly toggleTarget: HTMLElement;
  declare readonly toggleTargets: HTMLElement[];
  declare readonly onLabelTargets: HTMLElement[];
  declare readonly offLabelTargets: HTMLElement[];
  declare readonly hasInputTarget: boolean;
  declare readonly hasToggleTarget: boolean;

  declare autoHideValue: number;

  /** The identifiers whose copies each document masks before Turbo renders them. */
  static readonly #maskedRenders = sharedRegistry(
    "stimeo-ui.password-reveal-render-mask.registry.v1",
    () => new WeakMap<Document, Set<string>>(),
  );

  /** Auto re-mask timer; torn down on disconnect. */
  #timers = new SafeTimeout();

  /**
   * Whether this controller is between `connect()` and `disconnect()`.
   *
   * Target callbacks outlive the controller: Stimulus stops the target observer
   * after `disconnect()`, so a field leaving after teardown still reaches
   * {@link PasswordRevealController.inputTargetDisconnected}. Arming from there
   * would put a timer back that nothing will clear. The element staying in the
   * document does not answer this — unloading the controller leaves it there.
   */
  #connected = false;

  /** Owns `hidden` on the label pair the toggle button carries. */
  readonly #labels = new StateRegions(
    {
      whenTrue: () => this.onLabelTargets,
      whenFalse: () => this.offLabelTargets,
    },
    this.identifier,
  );

  /** Borrows `aria-pressed` on the toggle button, to give back when it stops being one. */
  readonly #pressed = new AttributeLease<HTMLElement>("aria-pressed", this.identifier);

  /** Borrows `type` on the field, to give back when an element stops being the input. */
  readonly #type = new AttributeLease<HTMLInputElement>("type", this.identifier);

  /** Holds the `turbo:before-cache` listener that masks the field from connect to disconnect. */
  readonly #listeners = new ListenerSet();

  /**
   * Whether this instance has connected before. A reconnect is an in-page move or a
   * `data-turbo-permanent` element carried to the next page; a page Turbo restores from its
   * cache connects new instances.
   */
  #lived = false;

  override connect(): void {
    this.#connected = true;
    if (!this.#lived) this.#maskCopy();
    this.#lived = true;
    const visible = this.#isVisible;
    this.#reflect(visible);
    this.#listeners.add(document, "turbo:before-cache", this.#rewindToMasked);
    PasswordRevealController.#maskRendersInto(this.element.ownerDocument, this.identifier);
    // Reconnecting onto an already revealed field inherits the promise the
    // declaration made: without re-arming, the re-mask would never arrive.
    this.#arm(visible);
  }

  override disconnect(): void {
    this.#connected = false;
    this.#timers.clearAll();
    this.#listeners.dispose();
  }

  /**
   * Re-derives the hooks and the re-mask for a field swapped in after connect, and masks
   * every field after the first: the password shows only in the field the toggle drives,
   * also on a page restored with a field revealed that is no longer the first.
   */
  inputTargetConnected(): void {
    for (const input of this.inputTargets.slice(1)) this.#type.return(input);
    const visible = this.#connected && this.#isVisible;
    this.#reflect(visible);
    this.#arm(visible);
  }

  /**
   * Re-derives from whatever field is left rather than assuming none is. A swap
   * delivers this callback next to the arrival in either order, so a revealed
   * replacement that answered "masked" here would be described as hidden while
   * showing the password, and would carry no re-mask.
   *
   * A field that no longer resolves as the input gets back the `type` this wrote, so
   * one left on the page revealed is masked again — after `disconnect()` too, since
   * dropping the identifier leaves the element there. Nothing else is written after
   * `disconnect()`: Stimulus delivers this callback once the controller has stopped,
   * while the field is still revealed, so deriving from there would describe it as
   * masked and arm a re-mask that outlives the controller.
   */
  inputTargetDisconnected(input: HTMLInputElement): void {
    if (!this.inputTargets.includes(input)) this.#type.return(input);
    if (!this.#connected) return;
    const visible = this.#isVisible;
    this.#reflect(visible);
    this.#arm(visible);
  }

  /** Re-derives the pressed state for a button swapped in after connect. */
  toggleTargetConnected(): void {
    this.#reflect(this.#isVisible);
  }

  /**
   * Gives a button that no longer resolves as the toggle back its `aria-pressed` and
   * label pair — after `disconnect()` too, since dropping the identifier leaves the
   * element on the page — and, while connected, describes the state to the button that stays.
   */
  toggleTargetDisconnected(toggle: HTMLElement): void {
    if (!this.toggleTargets.includes(toggle)) {
      this.#pressed.return(toggle);
      this.#labels.release(toggle);
    }
    if (this.#connected) this.#reflect(this.#isVisible);
  }

  /** Describes the state to a revealed-side label that arrives after connect. */
  onLabelTargetConnected(): void {
    this.#reflect(this.#isVisible);
  }

  /** Describes the state to a masked-side label that arrives after connect. */
  offLabelTargetConnected(): void {
    this.#reflect(this.#isVisible);
  }

  /** Toggles the input between masked and revealed. Bound via `data-action`. */
  toggle(): void {
    this.#setVisible(!this.#isVisible);
  }

  /** Whether the input is currently revealed (`type="text"`). */
  get #isVisible(): boolean {
    return this.hasInputTarget && this.inputTarget.type === "text";
  }

  /** Masks the field of a copy of a page an earlier instance revealed; see {@link maskCopyOf}. */
  #maskCopy(): void {
    if (this.hasInputTarget) maskCopyOf(this.#type, this.inputTarget);
  }

  /**
   * Has `document` mask, before Turbo renders a page into it, every field the incoming copy
   * carries revealed under `identifier`'s record, so that no component connecting to that
   * page reads the password before the instance that adopts the field does. Installed once
   * per document and identifier, and kept for the document's life: Turbo renders every
   * visit into the same document, and a copy can come back while no instance is connected
   * on the page being left. The listener holds no page state; it reads only the incoming
   * page and leaves the live one alone.
   */
  static #maskRendersInto(document: Document, identifier: string): void {
    const masked = PasswordRevealController.#maskedRenders.get(document) ?? new Set<string>();
    if (masked.has(identifier)) return;
    masked.add(identifier);
    PasswordRevealController.#maskedRenders.set(document, masked);
    const type = new AttributeLease<HTMLInputElement>("type", identifier);
    document.addEventListener("turbo:before-render", (event: Event): void => {
      const body = (event as CustomEvent<{ newBody?: unknown }>).detail?.newBody;
      if (!(body instanceof Element)) return;
      for (const input of body.querySelectorAll<HTMLInputElement>(
        `input[data-${identifier}-type-lease]`,
      )) {
        if (input.type === "text") maskCopyOf(type, input);
      }
    });
  }

  /** Switches the masked/revealed state, preserving focus and caret. */
  #setVisible(visible: boolean): void {
    if (!this.hasInputTarget) return;
    const input = this.inputTarget;

    // Only the input's *own* focus is restored across the type change; if the
    // toggle button (keyboard) holds focus, it is left untouched.
    const restoreInputFocus = document.activeElement === input;
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;

    this.#type.write(input, visible ? "text" : "password");

    if (restoreInputFocus) {
      input.focus();
      // `selectionStart` / `selectionEnd` are `number | null` (null for input
      // types that don't expose a selection); only restore when both are present.
      if (selectionStart !== null && selectionEnd !== null) {
        try {
          input.setSelectionRange(selectionStart, selectionEnd);
        } catch {
          // Some input types reject selection access; focus alone is enough.
        }
      }
    }

    this.#reflect(visible);
    this.dispatch("toggle", { detail: { visible } });
    this.#arm(visible);
  }

  /** Schedules the auto re-mask for a revealed field, replacing any pending one. */
  #arm(visible: boolean): void {
    this.#timers.clearAll();
    const delay = this.#autoHideDelay;
    if (visible && delay > 0) {
      this.#timers.set(() => this.#setVisible(false), delay);
    }
  }

  /**
   * The auto re-mask delay, held to what `setTimeout` can carry. Past that limit
   * a delay folds to zero, turning "keep it showing" into "hide it at once" —
   * the opposite of what the declaration asked for. A value that is no delay at
   * all stays out of the positive range {@link PasswordRevealController.#arm}
   * requires, so it schedules nothing.
   *
   * @stimeoRuntimeOnly `autoHide` is the delay of the one re-masking timer it arms.
   */
  get #autoHideDelay(): number {
    return Math.min(this.#safeAutoHide, MAX_DELAY);
  }

  /**
   * Returns the field to masked on `turbo:before-cache`, so the copy Turbo caches holds no
   * revealed credential. Turbo also dispatches the event on pages that stay; there the
   * reveal ends with what the user typed kept, silently and without moving focus.
   */
  readonly #rewindToMasked = (): void => {
    this.#timers.clearAll();
    if (!this.hasInputTarget) return;
    this.#type.write(this.inputTarget, "password");
    this.#reflect(false);
  };

  /** Reflects the visible state onto `aria-pressed`, `data-state` and the labels. */
  #reflect(visible: boolean): void {
    if (this.hasToggleTarget) {
      const toggle = this.toggleTarget;
      this.#pressed.write(toggle, visible ? "true" : "false");
      this.#labels.reflect(toggle, visible);
    }
    this.element.setAttribute("data-state", visible ? "visible" : "hidden");
  }
  /** Current `autoHide` declaration resolved against its numeric contract. */
  get #safeAutoHide(): number {
    return this.#numbers.read(
      this,
      "autoHide",
      this.autoHideValue,
      PasswordRevealController.values.autoHide.default,
      PasswordRevealController.valueConstraints.autoHide,
    );
  }
}
