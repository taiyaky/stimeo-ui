import { Controller } from "@hotwired/stimulus";

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
 * stacking context (no APG pattern; a DOM utility). Counterpart to Radix `Portal` /
 * Alpine `x-teleport`.
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
 * navigation included).
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

  override connect(): void {
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
    // Moving the controller element (the no-`content` form) makes some runtimes re-emit
    // disconnect/connect. That spurious churn is recognisable: the element is still in the
    // document AND still carries this identifier (Stimulus will reconnect immediately), so
    // ignore it. A genuine teardown — the element left the DOM, or `data-controller` no
    // longer lists us (e.g. a Turbo 8 morph) — must still restore/remove the teleport.
    if (this.element.isConnected && this.#stillControlled()) return;
    const state = portalState.get(this.element);
    if (!state) return;
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

  /** True while `data-controller` still lists this identifier (spurious-churn signal). */
  #stillControlled(): boolean {
    const tokens = (this.element.getAttribute("data-controller") ?? "").split(/\s+/);
    return tokens.includes(this.identifier);
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
