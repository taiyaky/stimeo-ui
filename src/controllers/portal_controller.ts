import { Controller } from "@hotwired/stimulus";
import { DetachGate } from "../utils/detach_gate";

/**
 * Teleport bookkeeping keyed by the controller element (stable across the
 * connect/disconnect churn some DOM runtimes emit when an observed element is moved).
 * Holds the moved node, its placeholder, and the owner — the instance that connected
 * last. Only the owner finishes a probe-driven teardown, so an instance the element has
 * already replaced cannot rewind a teleport the live one holds. The no-`content` form
 * needs no owner check: it restores only on a definite detach, where no successor comes.
 */
const portalState = new WeakMap<
  Element,
  { node: HTMLElement; placeholder: Comment; owner: PortalController }
>();

/**
 * Headless **portal / teleport**: moves an element to another place in the DOM (e.g.
 * directly under `body`) on connect and cleans up on disconnect — the shared substrate
 * for overlays that must escape an ancestor's `overflow: hidden`, `transform`, or
 * stacking context (no APG pattern; a DOM utility).
 *
 * Markup contract (identifier: `stimeo--portal`):
 *   <div data-controller="stimeo--portal" data-stimeo--portal-to-value="body">
 *     <div data-stimeo--portal-target="content">Teleported content</div>
 *   </div>
 *
 * Moves `content` (or `this.element` when no `content` target) into the first element
 * matching `to` (default `body`), `append`ed or `prepend`ed per `position`. A comment
 * placeholder records the original spot so `disconnect()` can return the node there
 * (when `restore`) — or remove it — leaving no orphan behind. The moved node carries
 * `data-portaled`. A `to` the engine cannot read — malformed or empty — falls back to
 * the default; a well-formed selector matching nothing moves nothing.
 *
 * `mount` dispatches `{ target }`; `unmount` dispatches `{}`.
 *
 * @remarks
 * Behavior only — no positioning (pair with `stimeo-ui/positioning`) and no focus
 * trapping (pair with `stimeo--focus` or the overlay). Moving a Stimulus element within
 * the same document re-fires connect/disconnect; {@link DetachGate} reads that pair as an
 * in-page move rather than a detach, which is what keeps the move safe. For Turbo
 * compatibility prefer the `content`-target form: the controller then stays on the
 * in-place source, so its `disconnect()` fires when the original container is replaced
 * and the teleported node is restored/removed rather than orphaned under `body`. The
 * move is idempotent (guarded by the element-keyed bookkeeping) and reversed on
 * `disconnect()` (Turbo
 * navigation included). The "in-page move vs real detach" split on `disconnect()` is
 * {@link DetachGate}; in the `content` form the source element may even leave a
 * scoped application's observed root and the content is still restored, while the
 * no-`content` form teleporting itself out of the observed root is fire-and-forget
 * by design (see `disconnect()`).
 */
export class PortalController extends Controller<HTMLElement> {
  static override targets = ["content"];
  static override values = {
    to: { type: String, default: "body" },
    position: { type: String, default: "append" },
    restore: { type: Boolean, default: true },
  };
  static events = ["mount", "unmount"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;

  declare toValue: string;
  declare positionValue: string;
  declare restoreValue: boolean;

  /** Decides whether a `disconnect()` is an in-page move or a real detach. */
  readonly #gate = new DetachGate();

  /** The `to` declaration after validation; the default when it cannot be parsed. */
  #toSelector = "body";

  /**
   * Validates the destination declaration once, keeping only a selector the engine can
   * read.
   *
   * A selector reads back as an ordinary string, so a malformed one survives until it is
   * handed to the DOM — where it would take the whole teleport down and leave the part
   * silently doing nothing. Falling back to the default puts the node somewhere visible
   * instead, which reads as a mistake and can be traced back to the declaration.
   */
  toValueChanged(): void {
    const selector = this.toValue;
    if (selector.length > 0) {
      try {
        this.element.matches(selector);
        this.#toSelector = selector;
        return;
      } catch {
        // Unparsable selector: fall through to the default below.
      }
    }
    this.#toSelector = "body";
  }

  override connect(): void {
    // A reconnect proves an in-page move of the source element: disarm the
    // probe the mid-move disconnect() deferred (see disconnect).
    this.#gate.cancel();
    // Already portaled here (idempotent). A later instance for the same element takes
    // ownership, so the teardown belongs to whichever one is still connected.
    const existing = portalState.get(this.element);
    if (existing) {
      existing.owner = this;
      return;
    }
    const node = this.hasContentTarget ? this.contentTarget : this.element;
    const destination = this.#destination();
    if (!destination || destination === node || node.contains(destination)) return;

    const placeholder = document.createComment("stimeo--portal");
    node.parentNode?.insertBefore(placeholder, node);
    portalState.set(this.element, { node, placeholder, owner: this });

    if (this.positionValue === "prepend") {
      destination.prepend(node);
    } else {
      destination.appendChild(node);
    }
    node.setAttribute("data-portaled", "true");
    this.dispatch("mount", { detail: { target: destination } });
  }

  override disconnect(): void {
    const state = portalState.get(this.element);
    if (!state) return;
    if (state.node === this.element) {
      // No-`content` form: the teleported node IS the controller element, so the
      // teleport itself may exit a scoped application's observed root — the controller
      // doing its job, not a detach. A probe-driven restore would re-enter the root,
      // reconnect, re-teleport and disconnect again, forever. So an ambiguous
      // disconnect (in the document, identifier still listed — also the churn a
      // self-move emits in some runtimes) KEEPS the teleport, and only a definite
      // detach — the element left the DOM, or `data-controller` no longer lists us
      // (a Turbo 8 morph) — restores. The cost, by design: a teleport that left the
      // observed root is fire-and-forget (Stimulus never fires for it again).
      if (!DetachGate.isDetached(this)) return;
      this.#restore(state);
      return;
    }
    // `content` form: the controller element stays put, so its own teleport emits no
    // churn — an ambiguous disconnect means the SOURCE element moved. In-page, the
    // same-batch reconnect cancels the probe and the teleport survives; out of the
    // observed root, no reconnect comes and the probe restores, so the content is
    // never stranded at the destination with a dead owner.
    this.#gate.disconnected(this, () => {
      const current = portalState.get(this.element);
      if (current?.owner === this) this.#restore(current);
    });
  }

  /** Returns the node to its placeholder (or removes it) and clears the bookkeeping. */
  #restore(state: { node: HTMLElement; placeholder: Comment }): void {
    portalState.delete(this.element);
    const { node, placeholder } = state;

    node.removeAttribute("data-portaled");
    if (this.restoreValue && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(node, placeholder);
    } else {
      node.remove();
    }
    placeholder.remove();
    this.dispatch("unmount", { detail: {} });
  }

  /** Resolves the destination from the validated `to` selector. */
  #destination(): Element | null {
    return document.querySelector(this.#toSelector);
  }
}
