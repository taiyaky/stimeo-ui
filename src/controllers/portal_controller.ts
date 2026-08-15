import { Controller } from "@hotwired/stimulus";
import { DetachGate } from "../utils/detach_gate";

/**
 * Teleport bookkeeping keyed by the controller element (stable across the
 * connect/disconnect churn some DOM runtimes emit when an observed element is moved).
 * Holds the moved node and its placeholder so any controller instance for that element
 * can finish the teardown.
 */
const portalState = new WeakMap<Element, { node: HTMLElement; placeholder: Comment }>();

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
 * `data-portaled`.
 *
 * @remarks
 * Behavior only — no positioning (pair with `stimeo-ui/positioning`) and no focus
 * trapping (pair with a Focus Scope / the overlay). Moving a Stimulus element within
 * the same document does not re-fire connect/disconnect, so the move is safe. For Turbo
 * compatibility prefer the `content`-target form: the controller then stays on the
 * in-place source, so its `disconnect()` fires when the original container is replaced
 * and the teleported node is restored/removed rather than orphaned under `body`. The
 * move is idempotent (guarded by the placeholder) and reversed on `disconnect()` (Turbo
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

  override connect(): void {
    // A reconnect proves an in-page move of the source element: disarm the
    // probe the mid-move disconnect() deferred (see disconnect).
    this.#gate.cancel();
    if (portalState.has(this.element)) return; // already portaled here (idempotent)
    const node = this.hasContentTarget ? this.contentTarget : this.element;
    const destination = this.#destination();
    if (!destination || destination === node || node.contains(destination)) return;

    const placeholder = document.createComment("stimeo--portal");
    node.parentNode?.insertBefore(placeholder, node);
    portalState.set(this.element, { node, placeholder });

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
      if (current) this.#restore(current);
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

  /** Resolves the destination for `to`, tolerating an invalid selector. */
  #destination(): Element | null {
    const selector = this.toValue.trim();
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }
}
