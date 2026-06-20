import { Controller } from "@hotwired/stimulus";

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
 *        data-stimeo--stick-to-bottom-threshold-value="80" style="overflow:auto">
 *     <ul data-stimeo--stick-to-bottom-target="content"><!-- Turbo Stream appends --></ul>
 *   </div>
 *
 * The container is "pinned" while its distance from the bottom is within `threshold`. A
 * `MutationObserver` on `content` (or the element) reacts to appended children: while
 * pinned it scrolls to the bottom; while unpinned it sets `data-has-new` and emits `new`.
 * Scrolling recomputes pinned and reflects `data-pinned`, emitting `pin` on change; the
 * `scrollToBottom` action jumps back down (a "new messages" button).
 *
 * @remarks
 * The `MutationObserver` watches `childList` only (not `subtree`), so it follows
 * direct appends to `content` (or the element). Appends made deeper inside a nested
 * wrapper are not detected — keep messages as direct children, or call the public
 * `scrollToBottom` action after such inserts.
 *
 * Behavior only — it does not add content (Turbo Stream / the consumer does) and is the
 * minimal follow primitive, not a full chat UI (no virtualization / message input). It is
 * the lightweight member of the scroll family. State is derived from the scroll position
 * each pass (no module-scope state), so `connect()` re-syncs after a Turbo Stream insert;
 * `behavior` falls back to `auto` under reduced motion; auto-scroll never moves focus; the
 * observer and the passive scroll listener are released on `disconnect()` (Turbo
 * navigation included).
 */
export class StickToBottomController extends Controller<HTMLElement> {
  static override targets = ["content"];
  static override values = {
    threshold: { type: Number, default: 80 },
    behavior: { type: String, default: "auto" },
  };
  static actions = ["scrollToBottom"] as const;
  static events = ["pin", "new"] as const;

  declare readonly contentTarget: HTMLElement;
  declare readonly hasContentTarget: boolean;

  declare thresholdValue: number;
  declare behaviorValue: string;

  #observer: MutationObserver | null = null;
  #pinned = false;

  readonly #onScroll = (): void => this.#updatePinned();

  override connect(): void {
    this.#pinned = this.#isPinned();
    // Re-sync the hooks from the current geometry — a Turbo cache restore may bring back a
    // stale data-pinned / data-has-new that no longer matches the scroll position.
    this.#reflectPinned();

    this.element.addEventListener("scroll", this.#onScroll, { passive: true });
    if (typeof MutationObserver !== "undefined") {
      this.#observer = new MutationObserver((mutations) => this.#onMutations(mutations));
      this.#observer.observe(this.#watched(), { childList: true });
    }
  }

  override disconnect(): void {
    this.element.removeEventListener("scroll", this.#onScroll);
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /** Jumps to the bottom and re-pins (wired to a "new messages" button). */
  scrollToBottom(): void {
    this.#scrollToBottom();
    this.element.removeAttribute("data-has-new");
    if (!this.#pinned) {
      this.#pinned = true;
      this.element.setAttribute("data-pinned", "true");
      this.dispatch("pin", { detail: { pinned: true } });
    }
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

  #scrollToBottom(): void {
    const top = this.element.scrollHeight;
    if (typeof this.element.scrollTo === "function") {
      this.element.scrollTo({ top, behavior: this.#behavior() });
    } else {
      this.element.scrollTop = top;
    }
  }

  /** The append-watched element: the `content` target, or the container itself. */
  #watched(): HTMLElement {
    return this.hasContentTarget ? this.contentTarget : this.element;
  }

  #behavior(): ScrollBehavior {
    if (this.#prefersReducedMotion()) return "auto";
    return this.behaviorValue === "smooth" ? "smooth" : "auto";
  }

  #prefersReducedMotion(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }
}
