import { Controller } from "@hotwired/stimulus";
import { LayoutObserver } from "../utils/layout_observer";
import { prefersReducedMotion } from "../utils/reduced_motion";

/** Distance from the bottom, in px, that still counts as pinned. */
const DEFAULT_THRESHOLD = 80;

/** Counts the element nodes in an added-node list (text nodes are ignored). */
const countElements = (nodes: NodeList): number => {
  let n = 0;
  for (const node of nodes) if (node.nodeType === Node.ELEMENT_NODE) n += 1;
  return n;
};

/**
 * Headless **stick-to-bottom**: auto-follows new content to the bottom of a scroll
 * container (a chat log, a live console) — but only while the user is already near the
 * bottom; if they have scrolled up to read, it holds position and flags that new content
 * arrived instead (no APG pattern; honors WCAG 2.3.3 via `prefers-reduced-motion` and
 * never steals focus).
 *
 * Markup contract (identifier: `stimeo--stick-to-bottom`):
 *   <div data-controller="stimeo--stick-to-bottom"
 *        data-stimeo--stick-to-bottom-threshold-value="80"
 *        data-stimeo--stick-to-bottom-pin-on-connect-value="true" style="overflow:auto">
 *     <ul data-stimeo--stick-to-bottom-target="content"><!-- Turbo Stream appends --></ul>
 *   </div>
 *
 * The container is "pinned" while it has a box to measure and its distance from the
 * bottom is within `threshold`. A `MutationObserver` on `content` (or the element) reacts
 * to appended children: while pinned it scrolls to the bottom; while unpinned it sets
 * `data-has-new` and emits `new`. Scrolling recomputes pinned and reflects `data-pinned`,
 * emitting `pin` on change; the `scrollToBottom` action jumps back down (a "new messages"
 * button). A `threshold` changed at runtime re-derives the state at once.
 *
 * A container that already overflows renders at `scrollTop` 0 — further than
 * `threshold` from the bottom, so unpinned — and flags the first append rather
 * than following it. `pinOnConnect` opts into the other starting point:
 * `connect()` jumps to the bottom and reads the state back from where it landed. It runs
 * on every connect, so a container inserted or re-rendered later (a Turbo Stream, a panel
 * built on open) starts at the bottom too — which a once-per-document page event cannot
 * do. It is off by default, so a restored reading position (a Turbo cache restore, a user
 * who had scrolled up) is never yanked to the bottom unless the consumer asks for it.
 *
 * A container connected without a box — inside a closed panel — reports every metric as
 * 0, so it is held unpinned until layout arrives: appends meanwhile are flagged rather
 * than followed into a box that cannot move, and the decision is then made against the
 * layout the user actually sees.
 *
 * `pin` dispatches `{ pinned }`; `new` dispatches `{ count }`.
 *
 * @remarks
 * The `MutationObserver` watches `childList` only (not `subtree`), so it follows
 * direct appends to `content` (or the element). Appends made deeper inside a nested
 * wrapper are not detected — keep messages as direct children, or call the public
 * `scrollToBottom` action after such inserts. A `content` target that is swapped at
 * runtime moves the watch with it.
 *
 * Behavior only — it does not add content (Turbo Stream / the consumer does) and is the
 * minimal follow primitive, not a full chat UI (no virtualization / message input). State
 * is derived from the scroll position each pass (no module-scope state), so `connect()`
 * re-syncs after a Turbo Stream insert; reduced motion forces an instant jump
 * independently of consumer CSS; auto-scroll never moves focus; the observers and the
 * passive scroll listener are released on `disconnect()` (Turbo navigation included).
 */
export class StickToBottomController extends Controller<HTMLElement> {
  static override targets = ["content"];
  static override values = {
    threshold: { type: Number, default: DEFAULT_THRESHOLD },
    behavior: { type: String, default: "auto" },
    pinOnConnect: { type: Boolean, default: false },
  };
  static actions = ["scrollToBottom"] as const;
  static events = ["pin", "new"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;

  declare thresholdValue: number;
  declare behaviorValue: string;
  declare pinOnConnectValue: boolean;

  #observer: MutationObserver | null = null;
  /** The element the append observer currently holds, so a swap can be detected. */
  #watched: HTMLElement | null = null;
  /** Watches for the box a container connected without one is still waiting on. */
  readonly #layout = new LayoutObserver(() => this.#onLaidOut());
  #awaitingLayout = false;
  #connected = false;
  #pinned = false;

  readonly #onScroll = (): void => this.#updatePinned();

  override connect(): void {
    this.#connected = true;
    // Instant whatever `behavior` says, overriding a consumer's `scroll-behavior: smooth`:
    // an animated jump emits scroll events on the way down, each recomputing pinned from a
    // position still far from the bottom, so the container would unpin (and re-pin)
    // mid-flight before it ever settles.
    if (this.pinOnConnectValue && this.#measurable()) this.#scrollToBottom("instant");
    // Read the state back from where the container actually is, asked for a jump or not: a
    // request the engine does not honor must leave it unpinned, so the next append is
    // flagged rather than swallowed. Both hooks are re-derived here, so a stale data-pinned
    // or data-has-new a Turbo cache restore brought back is dropped: has-new records an
    // arrival this connection has not seen, and nothing in the DOM can attest to one.
    this.element.removeAttribute("data-has-new");
    this.#pinned = this.#isPinned();
    this.#reflectPinned();

    this.element.addEventListener("scroll", this.#onScroll, { passive: true });
    this.#syncWatched();
    // A container with no box yet reports every metric as 0; it stays unpinned until the
    // layout it will actually be read against arrives.
    if (!this.#measurable()) this.#waitForLayout();
  }

  override disconnect(): void {
    this.#connected = false;
    this.element.removeEventListener("scroll", this.#onScroll);
    this.#stopWatching();
    this.#stopWaitingForLayout();
  }

  /** Moves the append watch onto a `content` target that arrived at runtime. */
  contentTargetConnected(): void {
    this.#syncWatched();
  }

  /** Moves the append watch off a `content` target that left, back onto the container. */
  contentTargetDisconnected(): void {
    this.#syncWatched();
  }

  /**
   * Re-derives pinned when the distance that counts as the bottom is changed at runtime
   * (a morph that swaps the attribute on a retained element).
   */
  thresholdValueChanged(): void {
    if (!this.#connected) return;
    this.#updatePinned();
  }

  /**
   * Jumps to the bottom and re-pins (wired to a "new messages" button).
   *
   * The has-new flag clears on request — the user has acknowledged the arrival — while
   * pinned is read back from where the scroll landed: a jump that arrives by the time
   * this returns pins immediately, an animated one settles from its own scroll events,
   * and a jump the engine cannot honor leaves the container unpinned, so the next append
   * flags it again instead of being swallowed by a pinned state that does not hold.
   *
   * Which of those happens is not this method's to decide — see {@link behaviorValue}.
   */
  scrollToBottom(): void {
    this.#scrollToBottom();
    this.element.removeAttribute("data-has-new");
    this.#updatePinned();
  }

  /** Follows appended children while pinned; otherwise flags new content. */
  #onMutations(mutations: MutationRecord[]): void {
    let added = 0;
    for (const mutation of mutations) added += countElements(mutation.addedNodes);
    if (added === 0) return;

    if (this.#pinned) {
      this.#scrollToBottom();
    } else {
      this.element.setAttribute("data-has-new", "true");
      this.dispatch("new", { detail: { count: added } });
    }
  }

  /**
   * Recomputes pinned from the scroll position and reflects it on a transition.
   *
   * @stimeoRenderRoot
   */
  #updatePinned(): void {
    const pinned = this.#isPinned();
    if (pinned === this.#pinned) return;
    this.#pinned = pinned;
    this.#reflectPinned();
    this.dispatch("pin", { detail: { pinned } });
  }

  /** Mirrors the current `#pinned` onto the state hooks (clearing has-new once pinned). */
  #reflectPinned(): void {
    if (this.#pinned) {
      this.element.setAttribute("data-pinned", "true");
      this.element.removeAttribute("data-has-new"); // caught up with the bottom
    } else {
      this.element.removeAttribute("data-pinned");
    }
  }

  /** Whether the container currently sits within `threshold` of its bottom. */
  #isPinned(): boolean {
    if (!this.#measurable()) return false;
    const el = this.element;
    return el.scrollHeight - el.clientHeight - el.scrollTop <= this.#threshold;
  }

  /**
   * The distance from the bottom that counts as pinned: a finite, non-negative number of
   * pixels. Anything else names no distance the container can be at, and settles the
   * comparison the same way at every scroll position, so it falls back to the default.
   * `Number` reads `"abc"` as `NaN` and every comparison against it is false; a negative
   * distance sits below the closest the container ever gets; `Infinity` is never
   * exceeded. The first two stop following and flag every append as new, and the last
   * never stops following — it takes the reading position the flag exists to protect.
   * Zero is a real declaration: it pins at the exact bottom only.
   */
  get #threshold(): number {
    const declared = this.thresholdValue;
    return Number.isFinite(declared) && declared >= 0 ? declared : DEFAULT_THRESHOLD;
  }

  /**
   * Whether the container has a box to scroll and to measure. One that is not rendered
   * (inside a closed panel) reports every metric as 0, which reads as "already at the
   * bottom" — a position describing no layout the user will ever see.
   */
  #measurable(): boolean {
    return this.element.clientHeight > 0;
  }

  /**
   * Holds the pinned decision until the container is laid out — otherwise the panel opens
   * at the top while the state claims the bottom, and the appends that arrived meanwhile
   * were followed into a box that could not move rather than flagged.
   */
  #waitForLayout(): void {
    this.#awaitingLayout = true;
    this.#layout.observe(this.element);
  }

  /** Runs the held decision once the container has the box it was waiting for. */
  #onLaidOut(): void {
    if (!this.#awaitingLayout || !this.#measurable()) return;
    this.#stopWaitingForLayout();
    if (this.pinOnConnectValue) this.#scrollToBottom("instant");
    this.#updatePinned();
  }

  /** Releases the layout watch, whether or not the held decision ever ran. */
  #stopWaitingForLayout(): void {
    this.#awaitingLayout = false;
    this.#layout.disconnect();
  }

  /**
   * Scrolls to the bottom, clamped by the engine to the maximum scroll offset — which is
   * 0 for a container tall enough to hold its whole content, so the jump moves nothing
   * there. `behavior` defaults to the configured follow behavior; pass `"instant"` for a
   * jump that must not animate.
   */
  #scrollToBottom(behavior: ScrollBehavior = this.#behavior()): void {
    const top = this.element.scrollHeight;
    if (typeof this.element.scrollTo === "function") {
      this.element.scrollTo({ top, behavior });
    } else {
      this.element.scrollTop = top;
    }
  }

  /**
   * Points the append watch at the current `content` target, or at the container when
   * there is none. Re-resolved whenever that target changes, so a swap does not leave the
   * observer holding a detached node whose appends nobody sees.
   *
   * Stimulus runs the target callbacks outside the connected window too — before
   * `connect()` for a target already in the DOM, and after `disconnect()` while the
   * element is torn down — where this would arm an observer nothing releases. Re-syncing
   * to the target already held is left alone, so an arrival still in flight is not
   * dropped with the observer that was about to deliver it.
   */
  #syncWatched(): void {
    if (!this.#connected) return;
    const next = this.hasContentTarget ? this.contentTarget : this.element;
    if (next === this.#watched) return;

    this.#stopWatching();
    this.#watched = next;
    if (typeof MutationObserver === "undefined") return;
    this.#observer = new MutationObserver((mutations) => this.#onMutations(mutations));
    this.#observer.observe(next, { childList: true });
  }

  /** Releases the append watch and the element it held. */
  #stopWatching(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#watched = null;
  }

  /**
   * The behavior a follow-scroll runs with. `"auto"` is **not** a request to arrive at
   * once: it hands the decision to the element's computed `scroll-behavior`, so a
   * consumer stylesheet saying `smooth` animates these scrolls too. Only `"instant"`
   * overrides that CSS, which is why reduced motion and the `pinOnConnect` jump name it.
   */
  #behavior(): ScrollBehavior {
    if (prefersReducedMotion()) return "instant";
    return this.behaviorValue === "smooth" ? "smooth" : "auto";
  }
}
