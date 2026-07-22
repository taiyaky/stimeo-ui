/**
 * Single resolver for layered Escape dismissal.
 *
 * Every Escape-dismissable overlay layer (modal focus traps, disclosure
 * overlays like dropdown/popover/menu, and hover-triggered transient layers)
 * registers here while it is open. One document-level listener per document
 * resolves each press to exactly one owner and invokes that layer's
 * {@link EscapeLayerOptions.onDismiss} — controllers never listen for a
 * dismissing Escape themselves.
 *
 * @remarks
 * Each document owns an activation-ordered stack. The owner of a press is the
 * **topmost layer whose {@link EscapeLayerOptions.claims} passes**; a layer
 * that declines is transparent, so a background overlay opened behind a modal
 * never blocks it. Because a layer opened from within another is necessarily
 * activated later, LIFO order is also inner-first for nested layers — no DOM
 * inspection is needed.
 *
 * The shared listener runs in the document bubble phase and honors
 * `event.defaultPrevented`, so an element-level widget handler that consumes
 * Escape first (an editor cancelling its edit, a combobox closing its list)
 * always wins over every registered layer — the deepest-first half of the
 * shared layered-Escape contract. A keydown that is part of an IME composition
 * (`event.isComposing`) cancels the composition, never a layer, and is ignored
 * here for every layer at once.
 *
 * A WeakMap keeps documents collectible; the listener is installed only while
 * a document's stack is non-empty, and controller lifecycle hooks guarantee
 * that disconnected layers never remain registered.
 */

/** Behavior a layer registers when it activates. */
export interface EscapeLayerOptions {
  /**
   * Dismisses the layer. Called by the shared resolver when this layer owns a
   * press; the resolver has already consumed the event (`preventDefault()`),
   * so the callback only needs to close and place focus per the widget's
   * contract.
   */
  onDismiss: () => void;
  /**
   * Whether the layer claims the current press. Evaluated per press, so it can
   * depend on live state (e.g. "focus is inside me or fell to the body"). A
   * declining layer is skipped and the next layer down is consulted; omitting
   * it means the layer always claims while active.
   */
  claims?: () => boolean;
}

/** A document's stack plus the one shared listener bound to it. */
interface EscapeLayerRegistry {
  stack: EscapeLayer[];
  onKeydown: (event: KeyboardEvent) => void;
}

/**
 * Claims predicate shared by the click-opened disclosure overlays (dropdown /
 * popover / navigation-menu / menu / context-menu / menubar): the layer claims
 * a press while focus is inside `element`, or after focus fell to the body —
 * a click on non-focusable overlay content blurs to `<body>`, and Escape must
 * still close the overlay (the "body-focus rescue"). A press made after focus
 * moved to another interactive element is declined, so closing never yanks
 * focus away from where the user deliberately went.
 */
export function claimsWhileFocusWithin(element: Element): () => boolean {
  return () => {
    const active = element.ownerDocument.activeElement;
    return active === null || active === element.ownerDocument.body || element.contains(active);
  };
}

export class EscapeLayer {
  static readonly #registries = new WeakMap<Document, EscapeLayerRegistry>();

  #ownerDocument: Document | null = null;
  /** Dismissal callback while active; `null` when inactive. */
  #onDismiss: (() => void) | null = null;
  /** Live predicate deciding whether the layer claims a press; `null` = always. */
  #claims: (() => boolean) | null = null;

  /**
   * Activates this layer at the top of its document's Escape stack, installing
   * the document's shared resolver listener if this is its first layer.
   * Re-activating an already-active layer moves it to the top.
   */
  activate(ownerDocument: Document = document, options: EscapeLayerOptions): void {
    this.deactivate();
    let registry = EscapeLayer.#registries.get(ownerDocument);
    if (!registry) {
      registry = EscapeLayer.#createRegistry();
      EscapeLayer.#registries.set(ownerDocument, registry);
      ownerDocument.addEventListener("keydown", registry.onKeydown);
    }
    registry.stack.push(this);
    this.#ownerDocument = ownerDocument;
    this.#onDismiss = options.onDismiss;
    this.#claims = options.claims ?? null;
  }

  /**
   * Removes this layer from its document's Escape stack, uninstalling the
   * shared listener when the stack empties. Safe to call when inactive.
   */
  deactivate(): void {
    const ownerDocument = this.#ownerDocument;
    if (!ownerDocument) return;

    const registry = EscapeLayer.#registries.get(ownerDocument);
    if (registry) {
      const index = registry.stack.lastIndexOf(this);
      if (index >= 0) registry.stack.splice(index, 1);
      if (registry.stack.length === 0) {
        ownerDocument.removeEventListener("keydown", registry.onKeydown);
        EscapeLayer.#registries.delete(ownerDocument);
      }
    }
    this.#ownerDocument = null;
    this.#onDismiss = null;
    this.#claims = null;
  }

  /**
   * Whether this active layer would own a press right now: it is the topmost
   * layer whose {@link EscapeLayerOptions.claims} passes. Exposed for tests
   * and diagnostics — production dismissal goes through the shared listener.
   */
  get ownsEscape(): boolean {
    const ownerDocument = this.#ownerDocument;
    if (!ownerDocument) return false;
    const registry = EscapeLayer.#registries.get(ownerDocument);
    if (!registry) return false;
    return EscapeLayer.#resolveOwner(registry.stack) === this;
  }

  /** Builds a document's registry with its shared resolver listener. */
  static #createRegistry(): EscapeLayerRegistry {
    const registry: EscapeLayerRegistry = {
      stack: [],
      onKeydown: (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
        const owner = EscapeLayer.#resolveOwner(registry.stack);
        if (!owner) return;
        event.preventDefault();
        owner.#onDismiss?.();
      },
    };
    return registry;
  }

  /** The topmost stack layer whose claims predicate passes, or `null`. */
  static #resolveOwner(stack: EscapeLayer[]): EscapeLayer | null {
    for (let index = stack.length - 1; index >= 0; index--) {
      const layer = stack[index];
      if (!layer) continue;
      if (layer.#claims && !layer.#claims()) continue;
      return layer;
    }
    return null;
  }
}
