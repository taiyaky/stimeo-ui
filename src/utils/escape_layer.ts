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
 * always wins over every registered layer — the deepest handler resolves the
 * press. A keydown that is part of an IME composition (`event.isComposing`)
 * cancels the composition, never a layer, and is ignored here for every layer
 * at once.
 *
 * A WeakMap keeps documents collectible; the listener is installed only while
 * a document's stack is non-empty, and controller lifecycle hooks guarantee
 * that disconnected layers never remain registered. The map is one per page
 * (`sharedRegistry`), so the layers of controllers imported from different
 * files share one stack and one listener.
 */

import { sharedRegistry } from "./shared_registry";

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

/** An active layer on its document's stack: what the resolver reads, from any copy. */
interface LayerEntry {
  readonly onDismiss: () => void;
  readonly claims: (() => boolean) | null;
}

/** A document's stack plus the one shared listener bound to it. */
interface EscapeLayerRegistry {
  readonly stack: LayerEntry[];
  readonly onKeydown: (event: KeyboardEvent) => void;
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
  static readonly #registries = sharedRegistry(
    "stimeo-ui.escape-layer.registry.v1",
    () => new WeakMap<Document, EscapeLayerRegistry>(),
  );

  /** The document and the entry of this layer while it is active. */
  #active: { readonly document: Document; readonly entry: LayerEntry } | null = null;

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
    const entry = { onDismiss: options.onDismiss, claims: options.claims ?? null };
    registry.stack.push(entry);
    this.#active = { document: ownerDocument, entry };
  }

  /**
   * Removes this layer from its document's Escape stack, uninstalling the
   * shared listener when the stack empties. Safe to call when inactive.
   */
  deactivate(): void {
    const active = this.#active;
    if (!active) return;

    const registry = EscapeLayer.#registries.get(active.document);
    if (registry) {
      const index = registry.stack.lastIndexOf(active.entry);
      if (index >= 0) registry.stack.splice(index, 1);
      if (registry.stack.length === 0) {
        active.document.removeEventListener("keydown", registry.onKeydown);
        EscapeLayer.#registries.delete(active.document);
      }
    }
    this.#active = null;
  }

  /**
   * Whether this active layer would own a press right now: it is the topmost
   * layer whose {@link EscapeLayerOptions.claims} passes. Exposed for tests
   * and diagnostics — production dismissal goes through the shared listener.
   */
  get ownsEscape(): boolean {
    const active = this.#active;
    if (!active) return false;
    const registry = EscapeLayer.#registries.get(active.document);
    if (!registry) return false;
    return EscapeLayer.#resolveOwner(registry.stack) === active.entry;
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
        owner.onDismiss();
      },
    };
    return registry;
  }

  /** The topmost stack layer whose claims predicate passes, or `null`. */
  static #resolveOwner(stack: readonly LayerEntry[]): LayerEntry | null {
    for (let index = stack.length - 1; index >= 0; index--) {
      const layer = stack[index];
      if (!layer) continue;
      if (layer.claims && !layer.claims()) continue;
      return layer;
    }
    return null;
  }
}
