import { Controller } from "@hotwired/stimulus";
import { prefersReducedMotion } from "../utils/reduced_motion";

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
 * The container is "pinned" while its distance from the bottom is within `threshold`. A
 * `MutationObserver` on `content` (or the element) reacts to appended children: while
 * pinned it scrolls to the bottom; while unpinned it sets `data-has-new` and emits `new`.
 * Scrolling recomputes pinned and reflects `data-pinned`, emitting `pin` on change; the
 * `scrollToBottom` action jumps back down (a "new messages" button).
 *
 * A container renders at `scrollTop` 0 — unpinned — so out of the box it flags the first
 * append rather than following it. `pinOnConnect` opts into the other starting point:
 * `connect()` jumps to the bottom and reads the state back from where it landed. It runs
 * on every connect, so a container inserted or re-rendered later (a Turbo Stream, a panel
 * built on open) starts at the bottom too — which a once-per-document page event cannot
 * do. It is off by default, so a restored reading position (a Turbo cache restore, a user
 * who had scrolled up) is never yanked to the bottom unless the consumer asks for it.
 *
 * `pin` dispatches `{ pinned }`; `new` dispatches `{ count }`.
 *
 * @remarks
 * The `MutationObserver` watches `childList` only (not `subtree`), so it follows
 * direct appends to `content` (or the element). Appends made deeper inside a nested
 * wrapper are not detected — keep messages as direct children, or call the public
 * `scrollToBottom` action after such inserts.
 *
 * Behavior only — it does not add content (Turbo Stream / the consumer does) and is the
 * minimal follow primitive, not a full chat UI (no virtualization / message input). State
 * is derived from the scroll position each pass (no module-scope state), so `connect()`
 * re-syncs after a Turbo Stream insert; reduced motion forces an instant jump
 * independently of consumer CSS; auto-scroll never moves focus; the observer and the
 * passive scroll listener are released on `disconnect()` (Turbo navigation included).
 */
export class StickToBottomController extends Controller<HTMLElement> {
  static override targets = ["content"];
  static override values = {
    threshold: { type: Number, default: 80 },
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
  /** Watches for the box a deferred `pinOnConnect` jump is still waiting on. */
  #layout: ResizeObserver | null = null;
  #pinned = false;

  readonly #onScroll = (): void => this.#updatePinned();

  override connect(): void {
    // Instant whatever `behavior` says, overriding a consumer's `scroll-behavior: smooth`:
    // an animated jump emits scroll events on the way down, each recomputing pinned from a
    // position still far from the bottom, so the container would unpin (and re-pin)
    // mid-flight before it ever settles.
    if (this.pinOnConnectValue && this.#measurable()) this.#scrollToBottom("instant");
    // Read the state back from where the container actually is, asked for a jump or not: a
    // request the engine does not honor must leave it unpinned, so the next append is
    // flagged rather than swallowed. This also drops a stale data-pinned / data-has-new a
    // Turbo cache restore brought back.
    this.#pinned = this.#isPinned();
    this.#reflectPinned();

    this.element.addEventListener("scroll", this.#onScroll, { passive: true });
    if (typeof MutationObserver !== "undefined") {
      this.#observer = new MutationObserver((mutations) => this.#onMutations(mutations));
      this.#observer.observe(this.#watched(), { childList: true });
    }
    if (this.pinOnConnectValue && !this.#measurable()) this.#pinWhenLaidOut();
  }

  override disconnect(): void {
    this.element.removeEventListener("scroll", this.#onScroll);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#stopWaitingForLayout();
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

  /** Recomputes pinned from the scroll position and reflects it on a transition. */
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

  #isPinned(): boolean {
    const el = this.element;
    return el.scrollHeight - el.clientHeight - el.scrollTop <= this.thresholdValue;
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
   * Holds the `pinOnConnect` jump until the container is laid out, then runs it and
   * re-reads the state — otherwise the panel opens at the top still claiming the bottom.
   */
  #pinWhenLaidOut(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.#layout = new ResizeObserver(() => {
      if (!this.#measurable()) return;
      this.#stopWaitingForLayout();
      this.#scrollToBottom("instant");
      this.#updatePinned();
    });
    this.#layout.observe(this.element);
  }

  /** Releases the layout watch, whether or not the deferred jump ever ran. */
  #stopWaitingForLayout(): void {
    this.#layout?.disconnect();
    this.#layout = null;
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

  /** The append-watched element: the `content` target, or the container itself. */
  #watched(): HTMLElement {
    return this.hasContentTarget ? this.contentTarget : this.element;
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
