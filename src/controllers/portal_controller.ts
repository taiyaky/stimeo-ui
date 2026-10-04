import { Controller } from "@hotwired/stimulus";
import { validSelector } from "../utils/declared_value";
import { DetachGate } from "../utils/detach_gate";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";
import { sharedRegistry } from "../utils/shared_registry";

/** Where the moved node sits inside its destination. */
type PortalPosition = "append" | "prepend";

/** One live teleport: what moved, where it came from, where it went, and who owns it. */
interface PortalState {
  node: HTMLElement;
  placeholder: Comment;
  owner: PortalController;
  /** The destination element the node was last placed in. */
  destination: Element;
  /** The end of that destination the node was placed at. */
  position: PortalPosition;
  /**
   * The `content` targets the element held when this teleport began, the node included.
   * None of them counts as arriving, so a second authored target never replaces the node.
   */
  held: ReadonlySet<Element>;
}

/**
 * Teleport bookkeeping keyed by the controller element (stable across the
 * connect/disconnect churn some DOM runtimes emit when an observed element is moved).
 * Holds the moved node, its placeholder, where it was placed, and the owner — the
 * instance that connected last. Only the owner finishes a probe-driven teardown, so an
 * instance the element has already replaced cannot rewind a teleport the live one holds.
 * The no-`content` form needs no owner check: it restores only on a definite detach,
 * where no successor comes.
 */
const portalState = sharedRegistry(
  "stimeo-ui.portal-state.registry.v1",
  () => new WeakMap<Element, PortalState>(),
);

/**
 * Controller elements that have held a `content` target, keyed by the element for the
 * same reason as the teleport bookkeeping. Such an element keeps the `content` form: while
 * it holds no content target it teleports nothing, rather than taking itself for the node.
 */
const contentForms = sharedRegistry(
  "stimeo-ui.portal-content-forms.registry.v1",
  () => new WeakSet<Element>(),
);

/**
 * Nodes a replacement retired: their teleport ended so that an arriving target could take
 * their place. One that `restore` sent back into the source reports itself as a target
 * again, yet it neither replaces the node that replaced it nor is teleported again, so a
 * replacement never goes back and forth. A node the page took out of the document is not
 * one, even when a target arrives in the same pass: put back, it is teleported again.
 */
const displaced = sharedRegistry(
  "stimeo-ui.portal-displaced.registry.v1",
  () => new WeakSet<Element>(),
);

/**
 * Whether the page took the moved node out of the document itself: the node is not
 * connected, and it is outside the destination it was placed in. A node whose
 * destination left the document with the node still inside is not one; it follows the
 * declaration to the destination that matches now.
 */
function takenByPage(state: PortalState): boolean {
  return !state.node.isConnected && !state.destination.contains(state.node);
}

/** `ParentNode.moveBefore` (Chromium 133+): relocates a node without removing it first. */
interface MovableParent {
  moveBefore?: (node: Node, child: Node | null) => void;
}

/**
 * Inserts `node` into `parent` before `before`, preferring `moveBefore`. A plain
 * insertion removes the node first, and the browser then drops the focus a descendant
 * held to `<body>`; `moveBefore` keeps it, along with the rest of the node's state.
 */
function relocate(parent: ParentNode, node: Node, before: Node | null): void {
  const move = (parent as ParentNode & MovableParent).moveBefore;
  if (typeof move === "function") {
    try {
      move.call(parent, node, before);
      return;
    } catch {
      // Not movable in place (another root, a detached tree): insert instead.
    }
  }
  parent.insertBefore(node, before);
}

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
 * `data-portaled`, which every placement pass aligns with where the node is: `true` while
 * it sits in its destination. A move the portal is not told about leaves the attribute as
 * it was until the next pass. A `to` the engine cannot read — malformed or empty — falls
 * back to the default; a well-formed selector matching nothing moves nothing.
 *
 * `to` and `position` are followed while connected: a new declaration moves the node
 * into the newly matched destination, or to the other end of the same one, and the
 * placeholder recorded by the first move stays where it is. A declaration that names
 * no destination the node can take — nothing matches, or it is the node itself or one
 * of its descendants — puts the node back before its placeholder, whatever `restore`
 * says. Changes that arrive together are applied as one move, and a Turbo morph of the
 * element re-applies the declaration (restoring `data-portaled` on a node that stays put).
 * A pass also moves a teleported node the page put somewhere outside its destination —
 * back into the source, say — into the destination again, keeping the recorded
 * placeholder, or recording the node's spot when that placeholder is gone. The moves
 * prefer `moveBefore`, so a focused control inside the node keeps focus where the engine
 * supports it.
 *
 * A `content` target that arrives while connected is placed by the same pass. When a
 * node is teleported already, the arriving one replaces it: the replaced node's teleport
 * ends the way `disconnect()` ends one, going back before its placeholder when `restore`
 * is on and the placeholder is still there, or being removed, and `unmount` is reported
 * before the new node's `mount`.
 *
 * A node the page removed from the document is never put back, neither by a placement
 * nor by `disconnect()`: the teleport ends instead, dropping the placeholder and
 * reporting `unmount`, and `content` that arrives with or after that ending is placed in
 * the same pass. An element that has held a `content` target never teleports itself while
 * it holds none, and a no-`content` teleport keeps the element whatever targets appear
 * inside it.
 *
 * `mount` dispatches `{ destination }` each time the node is placed in a destination;
 * `unmount` dispatches `{}` when it goes back to its placeholder or is removed.
 *
 * @remarks
 * Behavior only — no positioning (pair with `stimeo-ui/positioning`) and no focus
 * trapping (pair with `stimeo--focus` or the overlay). Moving a Stimulus element within
 * the same document re-fires connect/disconnect; `DetachGate` reads that pair as an
 * in-page move rather than a detach, which is what keeps the move safe. For Turbo
 * compatibility prefer the `content`-target form: the controller then stays on the
 * in-place source, so its `disconnect()` fires when the original container is replaced
 * and the teleported node is restored/removed rather than orphaned under `body`. The
 * move is idempotent (guarded by the element-keyed bookkeeping) and reversed on
 * `disconnect()` (Turbo
 * navigation included). The "in-page move vs real detach" split on `disconnect()` is
 * `DetachGate`; in the `content` form the source element may even leave a
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
  declare readonly contentTargets: HTMLElement[];
  declare readonly hasContentTarget: boolean;

  declare toValue: string;
  declare positionValue: string;
  declare restoreValue: boolean;

  /** Decides whether a `disconnect()` is an in-page move or a real detach. */
  readonly #gate = new DetachGate();

  /** The `to` declaration after validation; the default when it cannot be parsed. */
  #toSelector = "body";

  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;

  /**
   * Re-places the node once per batch of `to` / `position` changes, arriving `content`
   * targets and element morphs. Its window opens in `connect()` and closes in
   * `disconnect()`, so a callback Stimulus delivers ahead of `connect()` or during teardown
   * moves nothing.
   */
  readonly #replace = new MorphRenderWatcher(() => this.#place());

  /**
   * Validates the destination declaration once, keeping only a selector the engine can
   * read, and re-places the node.
   *
   * A selector reads back as an ordinary string, so a malformed one survives until it is
   * handed to the DOM — where it would take the whole teleport down and leave the part
   * silently doing nothing. Falling back to the default puts the node somewhere visible
   * instead, which reads as a mistake and can be traced back to the declaration.
   */
  toValueChanged(): void {
    this.#toSelector = validSelector(this.element, this.toValue, "body");
    this.#replace.schedule();
  }

  /** Re-places the node at the end of its destination that `position` now names. */
  positionValueChanged(): void {
    this.#replace.schedule();
  }

  /**
   * Places a `content` target that arrives while connected, in the pass the other changes
   * of its batch share; it replaces a node teleported already. Stimulus reports the targets
   * it finds ahead of `connect()`, which places them itself, and a node the teleport sends
   * home reports itself too; the pass finds such a node where the declaration puts it, or
   * retired by the node that replaced it, and moves nothing.
   */
  contentTargetConnected(): void {
    this.#replace.schedule();
  }

  override connect(): void {
    // A reconnect proves an in-page move of the source element: disarm the
    // probe the mid-move disconnect() deferred (see disconnect).
    this.#gate.cancel();
    // A later instance for the same element takes ownership, so the teardown belongs
    // to whichever one is still connected.
    const existing = portalState.get(this.element);
    if (existing) existing.owner = this;
    this.#connected = true;
    // Places the node on a first connect; on a reconnect it only moves the node when
    // the declaration changed while the controller was disconnected.
    this.#place();
    this.#replace.observe(this.element);
    // An `unmount` listener may have torn the controller down during the placement; the
    // window it closed then stays closed.
    if (!this.#connected) this.#replace.disconnect();
  }

  override disconnect(): void {
    this.#connected = false;
    this.#replace.disconnect();
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

  /**
   * Puts the node where `to` and `position` declare now.
   *
   * Without a teleport yet, a destination the node can take gets it (with a fresh
   * placeholder). With one, the node moves when the resolved destination element or the
   * position differs from where it was placed, or when the node sits outside its
   * destination — a re-delivered declaration only puts `data-portaled` back — and goes
   * back before its placeholder when the declaration names no destination the node can
   * take.
   *
   * A teleport ends first when the page took its node out of the document, or when another
   * `content` target arrived to replace it; the arriving target, or whatever `content` the
   * element holds by then, is placed in the same pass. An `unmount` listener that tears
   * the controller down leaves the rest of the pass undone, and one that takes the arriving
   * target out of the element leaves it where the listener put it.
   *
   * @stimeoRenderRoot
   */
  #place(): void {
    let state = portalState.get(this.element);
    let node = state?.node ?? null;
    if (state) {
      const arrival = this.#arrival(state);
      const taken = takenByPage(state);
      if (arrival || taken) {
        if (arrival && !taken) displaced.add(state.node);
        this.#restore(state);
        if (!this.#connected) return;
        state = undefined;
        // A listener may have taken the arriving target away again.
        node = arrival !== null && this.element.contains(arrival) ? arrival : null;
      }
    }
    node ??= this.#source();
    if (!node) return;
    const destination = this.#destination();
    if (!destination || destination === node || node.contains(destination)) {
      if (state) this.#unmount(state, true);
      return;
    }
    const position: PortalPosition = this.positionValue === "prepend" ? "prepend" : "append";
    const placed = this.#placedIn(node, destination);
    if (state?.destination === destination && state.position === position && placed) {
      node.setAttribute("data-portaled", "true");
      return;
    }

    if (state) {
      // A node the page moved out of its destination, whose recorded spot is gone, takes the
      // spot it occupies now as home.
      if (!state.placeholder.isConnected && !this.#placedIn(node, state.destination)) {
        state.placeholder = this.#markHome(node);
      }
      state.destination = destination;
      state.position = position;
    } else {
      const placeholder = this.#markHome(node);
      const held = new Set<Element>(this.contentTargets);
      portalState.set(this.element, {
        node,
        placeholder,
        owner: this,
        destination,
        position,
        held,
      });
    }
    relocate(destination, node, position === "prepend" ? destination.firstChild : null);
    node.setAttribute("data-portaled", "true");
    this.dispatch("mount", { detail: { destination } });
  }

  /**
   * Whether `node` sits in `destination`: inside it, at any depth, and — in the `content`
   * form — not back inside the source, which a destination such as `body` may contain. A
   * destination inside the source holds the node inside the source too.
   */
  #placedIn(node: HTMLElement, destination: Element): boolean {
    if (!destination.contains(node)) return false;
    return (
      node === this.element || !this.element.contains(node) || this.element.contains(destination)
    );
  }

  /** Leaves a placeholder at the spot `node` occupies now, and returns it. */
  #markHome(node: HTMLElement): Comment {
    const placeholder = document.createComment("stimeo--portal");
    node.parentNode?.insertBefore(placeholder, node);
    return placeholder;
  }

  /**
   * A `content` target in the element that arrived to replace the node teleported now: one
   * outside that node (which may carry targets of its own), not held when this teleport
   * began, and not displaced before. A no-`content` teleport has none: the element itself is the
   * node, and every target of the element lies inside it.
   */
  #arrival(state: PortalState): HTMLElement | null {
    const { node, held } = state;
    return (
      this.contentTargets.find(
        (target) => !node.contains(target) && !held.has(target) && !displaced.has(target),
      ) ?? null
    );
  }

  /**
   * The node a new teleport takes: the first `content` target a replacement has not retired,
   * or the element itself when it has never held one. An element that has held a content
   * target and holds none now takes nothing, and neither does one whose targets were all
   * retired: a node that another target replaced is not teleported again, which leaves
   * the page to render new content.
   */
  #source(): HTMLElement | null {
    if (this.hasContentTarget) {
      contentForms.add(this.element);
      return this.contentTargets.find((target) => !displaced.has(target)) ?? null;
    }
    return contentForms.has(this.element) ? null : this.element;
  }

  /**
   * Ends the teleport on disconnect, or when another node replaces it: the node goes back
   * when `restore` is on, unless the page took it out of the document, where it stays.
   *
   * @stimeoRuntimeOnly `restore` decides whether this one unmount puts the node back or drops it.
   */
  #restore(state: PortalState): void {
    this.#unmount(state, this.restoreValue && !takenByPage(state));
  }

  /**
   * Clears the bookkeeping first, then puts the node back before its placeholder when
   * `home` and the placeholder is still in a tree — or removes it — and reports `unmount`.
   */
  #unmount(state: PortalState, home: boolean): void {
    portalState.delete(this.element);
    const { node, placeholder } = state;

    node.removeAttribute("data-portaled");
    const origin = placeholder.parentNode;
    if (home && origin) {
      relocate(origin, node, placeholder);
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
