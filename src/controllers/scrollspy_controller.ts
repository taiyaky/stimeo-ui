import { Controller } from "@hotwired/stimulus";
import { IntersectionWatcher } from "../utils/intersection_watcher";
import { prefersReducedMotion } from "../utils/reduced_motion";

/**
 * The attributes a link may anchor its section with, and therefore the only
 * ones whose rewrite has to re-sync the observation set. `aria-current` — the
 * attribute this controller writes itself — is deliberately absent, so
 * publishing the current location cannot feed back into a rebuild.
 */
const ANCHOR_ATTRIBUTES = ["href", "data-href"];

/**
 * Headless, accessible **Scrollspy**: keeps a table of contents in sync with the
 * section the reader is currently in, published as `aria-current="location"`.
 * There is no dedicated APG widget; it follows the `aria-current`
 * current-location practice inside a `<nav>` landmark.
 *
 * Markup contract (identifier: `stimeo--scrollspy`):
 *   <nav data-controller="stimeo--scrollspy"
 *        data-stimeo--scrollspy-offset-value="80"
 *        data-stimeo--scrollspy-root-selector-value=".content"
 *        aria-label="Table of contents">
 *     <a href="#intro" data-stimeo--scrollspy-target="link"
 *        data-action="click->stimeo--scrollspy#scrollTo">Intro</a>
 *     <a href="#usage" data-stimeo--scrollspy-target="link"
 *        data-action="click->stimeo--scrollspy#scrollTo">Usage</a>
 *   </nav>
 *   <div class="content">
 *     <section id="intro">…</section>
 *     <section id="usage">…</section>
 *   </div>
 *
 * The active section is the one whose top edge sits closest to the **trigger
 * line**: `offset` px below the top of the *scroll root* — the `rootSelector`
 * container, or the viewport when that value is empty. It is not the viewport
 * top whenever a nested container is spied on. Intersecting sections win; when
 * none intersects (between two sections, scrolled past the last one) the
 * closest tracked section keeps the highlight, so a table of contents never
 * goes blank.
 *
 * `data-action` on the links is optional and opts into {@link scrollTo}, which
 * scrolls the nested container instead of bouncing the whole window.
 *
 * `change` dispatches `{ id: string, link: HTMLElement }`.
 *
 * @remarks
 * Behavior only — how a current link looks is the consumer's CSS
 * (`[aria-current="location"] { … }`). `connect()` reads the current location
 * back from the DOM so a Turbo cache restore re-establishes it without a
 * redundant `change`, and `disconnect()` severs every resource acquired here:
 * the observers, the scroll listener, and any pending frame or queued rebuild.
 *
 * **What is followed automatically**, and what is not (the boundary a consumer
 * has to know, because everything outside it needs a re-`connect()`):
 *
 * - `link` targets added or removed — Stimulus's target callbacks.
 * - a `link` target's `href` / `data-href` rewritten in place — a Turbo 8 morph
 *   keeps the element *and* its target marker, so no target callback fires;
 *   {@link ANCHOR_ATTRIBUTES} is watched for exactly this case.
 * - the reader's scroll position, including inside a stretch where no section
 *   crosses an observation threshold.
 *
 * Not followed: a *split* lifecycle in which the nav survives while the scroll
 * root or the sections are replaced underneath it. `rootSelector` is resolved
 * against the whole document and re-resolved once the cached container leaves
 * it, but section elements are looked up only while the observation set is
 * (re)built — swap those alone and nothing tells this controller to look again.
 */
export class ScrollspyController extends Controller<HTMLElement> {
  static override targets = ["link"];
  static override values = {
    offset: { type: Number, default: 0 },
    rootMargin: { type: String, default: "" },
    rootSelector: { type: String, default: "" },
    focusSection: { type: Boolean, default: false },
  };
  static actions = ["scrollTo"] as const;
  static events = ["change"] as const;

  declare readonly linkTargets: HTMLElement[];

  declare offsetValue: number;
  declare rootMarginValue: string;
  declare rootSelectorValue: string;
  declare focusSectionValue: boolean;

  /**
   * The one offset shared by observation, active-section selection, and
   * scrolling. Stimulus parses a malformed Number Value as `NaN`; degrading it
   * to the declared default keeps every path aligned instead of only repairing
   * the observer margin while selection and scrolling still receive `NaN`.
   */
  get #offset(): number {
    return Number.isFinite(this.offsetValue) ? this.offsetValue : 0;
  }

  /** Shared IO plumbing (support guard, active guard, teardown). */
  readonly #watcher = new IntersectionWatcher((entries) => this.#onIntersection(entries));
  #isConnected = false;

  /**
   * Sections currently tracked, by id. Only the *latest reported* intersection
   * flag is stored — never a coordinate. Positions are re-measured when the
   * active section is evaluated, so a section observed several batches ago is
   * never compared against a trigger line computed now.
   */
  #intersectionStates = new Map<string, { element: Element; isIntersecting: boolean }>();

  /** Current active section ID; comparing it suppresses duplicate `change` events. */
  #activeSectionId = "";

  /**
   * Scroll root resolved when the observer was (re)built; `null` = viewport.
   * Cached so a click and every intersection batch reuse the element the
   * observer is actually watching instead of re-querying the document.
   */
  #rootElement: HTMLElement | null = null;

  /**
   * The source the `scroll` listener is currently attached to — the resolved
   * root, or the window while the viewport is spied. `null` means "nothing
   * attached", so teardown always detaches from the source it attached to
   * rather than from whatever the selector resolves to now.
   */
  #scrollSource: HTMLElement | Window | null = null;

  /** Pending re-evaluation frame; coalesces a scroll burst into one measurement. */
  #frame: number | null = null;

  /** Watches the link targets' anchor attributes for an in-place morph rewrite. */
  #anchorObserver: MutationObserver | null = null;

  /** True while a coalesced observation rebuild is queued; see {@link #scheduleResync}. */
  #resyncQueued = false;

  override connect(): void {
    this.#isConnected = true;
    this.#observeAnchorAttributes();
    this.#initializeObserver();
  }

  override disconnect(): void {
    this.#isConnected = false;
    // Dropping the flag is what discards a rebuild queued moments ago: the
    // drain reads it, so the queued microtask becomes a no-op.
    this.#resyncQueued = false;
    this.#watcher.stop();
    this.#anchorObserver?.disconnect();
    this.#anchorObserver = null;
    this.#detachScrollListener();
    if (this.#frame !== null) {
      cancelAnimationFrame(this.#frame);
      this.#frame = null;
    }
    this.#intersectionStates.clear();
    this.#activeSectionId = "";
    this.#rootElement = null;
  }

  /**
   * Re-initializes the observer if the offset or rootMargin values change dynamically.
   */
  offsetValueChanged(): void {
    if (!this.#isConnected) return;
    this.#initializeObserver();
  }

  rootMarginValueChanged(): void {
    if (!this.#isConnected) return;
    this.#initializeObserver();
  }

  rootSelectorValueChanged(): void {
    if (!this.#isConnected) return;
    this.#initializeObserver();
  }

  /**
   * Re-syncs the observation set when a Turbo Stream/morph swaps the table of
   * contents. Stimulus fires these before `connect()` for the links already in
   * the markup, hence the guard: the initial observer is built exactly once, by
   * `connect()`.
   */
  linkTargetConnected(): void {
    if (this.#isConnected) this.#scheduleResync();
  }

  linkTargetDisconnected(): void {
    if (this.#isConnected) this.#scheduleResync();
  }

  /**
   * Queues **one** observation rebuild for the current mutation batch.
   *
   * A single Turbo morph can append one link, drop another, and rewrite a
   * third's `href`, and those arrive through two independent channels —
   * Stimulus's target callbacks and {@link #anchorObserver}. Each channel just
   * raises the flag and queues a drain; the first drain to run does the work and
   * clears it, so every later drain in the same batch finds nothing to do and
   * the set is rebuilt once instead of three times. `disconnect()` clears the
   * same flag, which is how a queued rebuild is dropped rather than run against
   * a detached controller.
   */
  #scheduleResync(): void {
    this.#resyncQueued = true;
    queueMicrotask(this.#drainResync);
  }

  readonly #drainResync = (): void => {
    if (!this.#resyncQueued) return;
    this.#resyncQueued = false;
    this.#initializeObserver();
  };

  /**
   * Watches the link targets' anchor attributes so an in-place rewrite re-syncs.
   *
   * A Turbo 8 morph keeps the element **and** its `data-*-target` marker and
   * only rewrites attributes, so Stimulus fires no target callback: without
   * this, a link re-pointed from `#intro` to `#faq` would keep the controller
   * observing `#intro` for the rest of the page's life. The filter is exactly
   * {@link ANCHOR_ATTRIBUTES}; guarding on `MutationObserver` keeps the
   * controller usable where the API is absent, matching `IntersectionWatcher`'s
   * own support guard.
   */
  #observeAnchorAttributes(): void {
    if (typeof MutationObserver !== "undefined") {
      this.#anchorObserver = new MutationObserver(this.#onAnchorMutation);
      this.#anchorObserver.observe(this.element, {
        subtree: true,
        attributes: true,
        attributeFilter: ANCHOR_ATTRIBUTES,
      });
    }
  }

  /**
   * Rebuilds only for a rewrite on a *current* link target. The observer is
   * scoped to this controller's element, but that subtree also holds links the
   * author never marked as targets (a "back to top" anchor, a nested nav), and
   * those anchor nothing here.
   */
  readonly #onAnchorMutation = (records: MutationRecord[]): void => {
    const links = this.linkTargets;
    for (const record of records) {
      if (!links.includes(record.target as HTMLElement)) continue;
      this.#scheduleResync();
      return;
    }
  };

  /**
   * Scrolls to the section the clicked link anchors, honoring `offset` and any
   * nested scroll container (a plain fragment jump would scroll the window).
   *
   * Honors `prefers-reduced-motion` (WCAG 2.2 **2.3.3**) by forcing an instant
   * jump independently of the consumer's CSS `scroll-behavior`. With
   * `focusSection` enabled it also moves the sequential focus starting point
   * into the destination; the URL fragment is deliberately not touched.
   */
  scrollTo(event: Event): void {
    const link = event.currentTarget as HTMLElement;
    const id = this.#getAnchorId(link);
    if (!id) return;

    event.preventDefault();

    const targetElement = document.getElementById(id);
    if (!targetElement) return;

    const behavior: ScrollBehavior = prefersReducedMotion() ? "instant" : "smooth";
    const rootElement = this.#scrollRoot();
    const targetRect = targetElement.getBoundingClientRect();
    const offset = this.#offset;

    if (rootElement) {
      const containerRect = rootElement.getBoundingClientRect();
      const scrollPosition = rootElement.scrollTop + (targetRect.top - containerRect.top) - offset;

      rootElement.scrollTo({ top: scrollPosition, behavior });
    } else {
      const scrollPosition = window.scrollY + targetRect.top - offset;

      window.scrollTo({ top: scrollPosition, behavior });
    }

    if (this.focusSectionValue) this.#focusSection(targetElement);
  }

  /**
   * Moves the sequential focus starting point into the section `scrollTo` just
   * jumped to, so the next Tab continues *inside* the destination instead of
   * resuming in the table of contents (`preventDefault()` alone would leave the
   * starting point on the link). Opt-in through `focusSection`, because moving
   * focus is a decision only the consuming page can make.
   *
   * `tabindex="-1"` is established only when the section is not already
   * focusable and is never removed, so an author-owned tabindex is left alone.
   * `preventScroll` keeps the focus call from cancelling the smooth scroll
   * started just above.
   */
  #focusSection(section: HTMLElement): void {
    if (!section.hasAttribute("tabindex")) section.setAttribute("tabindex", "-1");
    section.focus({ preventScroll: true });
  }

  /**
   * The cached scroll root, re-resolved when the cached element has left the
   * document (a Turbo morph replaced the container) so `scrollTo` never
   * scrolls a detached node.
   */
  #scrollRoot(): HTMLElement | null {
    if (this.#rootElement && !this.#rootElement.isConnected) {
      this.#rootElement = this.#queryRootElement();
    }
    return this.#rootElement;
  }

  /**
   * Resolves `rootSelector` to a scrollable element.
   *
   * @returns The container, or `null` meaning "spy the viewport" when the value
   * is empty, matches nothing, matches a non-HTML element (an SVG node is not a
   * scroll container), or is not a valid selector — a typo in a data attribute
   * must degrade to viewport spying, not leave the controller inert.
   */
  #queryRootElement(): HTMLElement | null {
    if (!this.rootSelectorValue) return null;
    try {
      const root = document.querySelector(this.rootSelectorValue);
      return root instanceof HTMLElement ? root : null;
    } catch {
      return null;
    }
  }

  /**
   * Re-evaluates once per frame while the reader scrolls.
   *
   * `IntersectionObserver` reports **threshold crossings**, not positions, so a
   * reader moving inside one long section — or across a gap wider than the
   * observation band — produces no batch at all and the highlight would stay
   * frozen at whatever the last crossing decided. That would make the current
   * location depend on the *route* to a position instead of the position: a
   * stepwise scroll crosses thresholds an instant jump to the same offset never
   * does. Listening to the scroll source closes the gap, and because both paths
   * end in {@link #evaluateActiveSection} — which measures section rects and the
   * root's top edge at that instant — they converge on the same answer.
   */
  readonly #onScroll = (): void => {
    if (this.#frame !== null) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      this.#evaluateActiveSection();
    });
  };

  /**
   * Points the `scroll` listener at whatever the reader actually scrolls: the
   * resolved root, or the window when the viewport is spied.
   *
   * The detach is unconditional, so rebuilding the observation set (a Value
   * change, a morph) **moves** the listener rather than stacking a second one on
   * a container the reader has stopped scrolling.
   */
  #syncScrollListener(): void {
    this.#detachScrollListener();
    this.#scrollSource = this.#rootElement ?? window;
    this.#scrollSource.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  #detachScrollListener(): void {
    this.#scrollSource?.removeEventListener("scroll", this.#onScroll);
    this.#scrollSource = null;
  }

  #initializeObserver(): void {
    this.#watcher.stop();
    this.#intersectionStates.clear();
    // The DOM is the source of truth for the current location **only when this
    // controller has none of its own** — a fresh `connect()`, which is also the
    // Turbo cache-restore case, where the links still carry `aria-current` from
    // the snapshot. Adopting it there makes the observer's first batch a silent
    // confirmation instead of a duplicate `change`.
    //
    // On a *live* rebuild the memory wins, because the DOM has stopped meaning
    // what this controller wrote: an anchor rewritten underneath us leaves
    // `aria-current` on a link that now points somewhere else, so reading it
    // back would hand the current location to a section the reader never
    // scrolled to — and then announce the correction as a `change`, as if they
    // had travelled there and back.
    this.#activeSectionId = this.#activeSectionId || this.#activeIdFromDom();
    this.#rootElement = this.#queryRootElement();
    this.#syncScrollListener();

    if (this.linkTargets.length === 0) return;

    // Negate the numeric value so a valid negative offset becomes a positive margin.
    const margin = this.rootMarginValue || `${-this.#offset}px 0px -80% 0px`;

    // Observe each target section mapped by the href anchors.
    const sections: Element[] = [];
    for (const link of this.linkTargets) {
      const id = this.#getAnchorId(link);
      if (!id) continue;
      const section = document.getElementById(id);
      if (section && !sections.includes(section)) sections.push(section);
    }

    this.#watcher.start(sections, {
      root: this.#rootElement,
      rootMargin: margin,
      threshold: [0, 0.2, 0.4, 0.6, 0.8, 1], // Multiple thresholds handle large sections safely
    });

    // Republish the adopted location over the *current* link set. Evaluation
    // writes attributes only when the winning section changes, so a link added
    // — or re-anchored — while the reader stays put would otherwise never be
    // marked: a mobile table of contents rendered after the sidebar one would
    // stay blank until the reader happened to cross into another section.
    //
    // Unconditional, including when the adopted location is empty: a link whose
    // anchor was rewritten to something that resolves nowhere cannot be the
    // reader's location, and this controller is the one that published the
    // attribute saying it was, so it is the one that has to take it back.
    this.#syncActiveStates(false);
  }

  readonly #onIntersection = (entries: IntersectionObserverEntry[]): void => {
    // Defense in depth. `IntersectionWatcher` already drops a batch the browser
    // flushes after `stop()` (its active/identity guard), so this flag is the
    // second line that keeps a detached controller from mutating `aria-current`
    // on (possibly cached) links.
    const isDetached = !this.#isConnected;
    if (isDetached) return;

    for (const entry of entries) {
      const sectionId = entry.target.id;
      if (!sectionId) continue;

      this.#intersectionStates.set(sectionId, {
        element: entry.target,
        isIntersecting: entry.isIntersecting,
      });
    }

    this.#evaluateActiveSection();
  };

  /**
   * Picks the section closest to the trigger line and publishes it.
   *
   * Every coordinate is read **now**: the section rects *and* the root's top
   * edge share one measurement instant. Comparing an entry's recorded
   * `boundingClientRect.top` (captured whenever that section last crossed a
   * threshold) against a freshly computed trigger line mixes two moments in
   * time, which would make the result depend on how the reader arrived at a
   * position — a smooth scroll and an instant jump to the same offset disagree.
   */
  #evaluateActiveSection(): void {
    // The trigger line is `offset` px below the top of the scroll root. When a
    // nested `rootSelector` container is used it is not at the viewport top, so
    // the line must be measured from the container's current top — comparing the
    // viewport-based rect top against a bare `offset` would otherwise pick the
    // section nearest the viewport top, not the container's.
    const rootEl = this.#scrollRoot();
    const triggerLine = (rootEl ? rootEl.getBoundingClientRect().top : 0) + this.#offset;

    let intersectingId = "";
    let intersectingDistance = Number.POSITIVE_INFINITY;
    let trackedId = "";
    let trackedDistance = Number.POSITIVE_INFINITY;

    for (const [id, state] of this.#intersectionStates) {
      const rect = state.element.getBoundingClientRect();
      // A section with no layout box (`display: none`, a collapsed `<details>`,
      // an undisplayed Turbo Frame) is reported with an empty rect whose `top`
      // of 0 carries no position at all. Letting it compete would hand it the
      // fallback below; it re-enters the race once it is actually laid out.
      if (rect.width === 0 && rect.height === 0) continue;

      const distance = Math.abs(rect.top - triggerLine);
      if (distance < trackedDistance) {
        trackedDistance = distance;
        trackedId = id;
      }
      if (state.isIntersecting && distance < intersectingDistance) {
        intersectingDistance = distance;
        intersectingId = id;
      }
    }

    // Fallback: when no section currently intersects (e.g. scrolled past the
    // bottom, or between sections), keep the tracked section whose top is
    // closest to the trigger line so something stays highlighted.
    const bestId = intersectingId || trackedId;

    if (bestId && bestId !== this.#activeSectionId) {
      this.#activeSectionId = bestId;
      this.#syncActiveStates(true);
    }
  }

  /**
   * Writes `aria-current` across the current link set, optionally announcing.
   *
   * The two halves are separate because they answer different questions.
   * *Attributes* must be idempotently re-established whenever the link set
   * changes, even though the reader has not moved — otherwise a link that
   * appears (or is re-anchored) while its section is already current never gets
   * marked. *The `change` event* announces that the reader moved, so it fires
   * only from the evaluation path; re-publishing over a new link set is not
   * news, and dispatching there would make a rebuild look like navigation.
   *
   * @param announce Whether this sync represents a change of current section.
   */
  #syncActiveStates(announce: boolean): void {
    // Every link anchoring the active section is marked, not just the first:
    // a page may render the same table of contents twice (a sidebar and a
    // collapsed mobile menu) and both must show the current location.
    const activeLinks = this.linkTargets.filter(
      (link) => this.#getAnchorId(link) === this.#activeSectionId,
    );

    for (const link of this.linkTargets) {
      if (activeLinks.includes(link)) {
        link.setAttribute("aria-current", "location");
      } else if (link.getAttribute("aria-current") === "location") {
        // Reclaim only the value this controller publishes, so an author-owned
        // `aria-current="page"` on a table-of-contents link survives.
        link.removeAttribute("aria-current");
      }
    }

    if (!announce) return;

    const primaryLink = activeLinks[0];
    if (primaryLink) {
      this.dispatch("change", { detail: { id: this.#activeSectionId, link: primaryLink } });
    }
  }

  /**
   * The current location already encoded in the DOM, i.e. the section anchored
   * by the first link carrying this controller's `aria-current="location"`.
   * Empty when no link claims it (a genuinely fresh render).
   */
  #activeIdFromDom(): string {
    for (const link of this.linkTargets) {
      if (link.getAttribute("aria-current") !== "location") continue;
      const id = this.#getAnchorId(link);
      if (id) return id;
    }
    return "";
  }

  /**
   * The section id a link anchors, resolved in a fixed order:
   *
   * 1. `href`, when it is a non-empty same-document fragment — the contract.
   * 2. otherwise `data-href`'s fragment — the fallback for a link whose `href`
   *    must stay a real URL (a server-rendered permalink) or that is not an
   *    `<a>` at all.
   * 3. otherwise `null`: the link anchors nothing here and is not observed.
   *
   * Step 2 is reached whenever `href` yields nothing usable — absent, `"#"`, or
   * a real URL — which is the whole point of the fallback: `href="/guide/usage"`
   * with `data-href="#usage"` is a permalink that also spies, and picking the
   * first *present* attribute instead of the first *usable* one would silently
   * exclude exactly that markup. When both are valid fragments `href` wins.
   */
  #getAnchorId(link: HTMLElement): string | null {
    return (
      this.#fragmentId(link.getAttribute("href")) ??
      this.#fragmentId(link.getAttribute("data-href"))
    );
  }

  /** The id in a `#fragment` value; `null` for absent, empty, or non-fragment. */
  #fragmentId(value: string | null): string | null {
    if (!value?.startsWith("#")) return null;
    return value.substring(1) || null;
  }
}
