import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible Scrollspy / Navigation catalog synchronizer.
 *
 * Markup contract (identifier: `stimeo--scrollspy`):
 *   <nav data-controller="stimeo--scrollspy"
 *        data-stimeo--scrollspy-offset-value="80"
 *        aria-label="Table of contents">
 *     <a href="#intro" data-stimeo--scrollspy-target="link">Intro</a>
 *     <a href="#usage" data-stimeo--scrollspy-target="link">Usage</a>
 *   </nav>
 *   <section id="intro">…</section>
 *   <section id="usage">…</section>
 *
 * Implements clean active location synchronization driven by `aria-current`:
 * - Leverages native `IntersectionObserver` to track viewport visibility.
 * - Robust evaluation algorithm: among all intersecting sections, the one closest
 *   to the top offset trigger line (`boundingClientRect.top`) is prioritized as active.
 * - Toggles `aria-current="location"` dynamically on active/inactive links.
 * - Gracefully handles teardown `disconnect()` by severing observer references to prevent leaks.
 *
 * @remarks
 * Behavior only. The controller manages state on catalog links via `aria-current`,
 * respects custom offsets, and dispatches `stimeo--scrollspy:change` events.
 */
export class ScrollspyController extends Controller<HTMLElement> {
  static override targets = ["link"];
  static override values = {
    offset: { type: Number, default: 0 },
    rootMargin: { type: String, default: "" },
    rootSelector: { type: String, default: "" },
  };
  static actions = ["scrollTo"] as const;
  static events = ["change"] as const;

  declare readonly linkTargets: HTMLElement[];

  declare offsetValue: number;
  declare rootMarginValue: string;
  declare rootSelectorValue: string;

  #observer: IntersectionObserver | null = null;
  #isConnected = false;

  /** Track active/intersecting status of each section element by ID. */
  #intersectionStates = new Map<string, { isIntersecting: boolean; top: number }>();

  /** Current active section ID, used to avoid duplicate event dispatching. */
  #activeSectionId = "";

  override connect(): void {
    this.#isConnected = true;
    this.#initializeObserver();
  }

  override disconnect(): void {
    this.#isConnected = false;
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    this.#intersectionStates.clear();
    this.#activeSectionId = "";
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
   * Smoothly scrolls to the target element mapped by the link anchor.
   * Prevents full window scroll jumps when tracking nested scrollable containers.
   */
  scrollTo(event: Event): void {
    const link = event.currentTarget as HTMLElement;
    const id = this.#getAnchorId(link);
    if (!id) return;

    event.preventDefault();

    const targetElement = document.getElementById(id);
    if (!targetElement) return;

    const rootElement = this.#getRootElement();
    if (rootElement) {
      const containerRect = rootElement.getBoundingClientRect();
      const targetRect = targetElement.getBoundingClientRect();
      const scrollPosition =
        rootElement.scrollTop + (targetRect.top - containerRect.top) - this.offsetValue;

      rootElement.scrollTo({
        top: scrollPosition,
        behavior: "smooth",
      });
    } else {
      const targetRect = targetElement.getBoundingClientRect();
      const scrollPosition = window.scrollY + targetRect.top - this.offsetValue;

      window.scrollTo({
        top: scrollPosition,
        behavior: "smooth",
      });
    }
  }

  #getRootElement(): HTMLElement | null {
    if (!this.rootSelectorValue) return null;
    return document.querySelector(this.rootSelectorValue);
  }

  #initializeObserver(): void {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    this.#intersectionStates.clear();
    this.#activeSectionId = "";

    if (this.linkTargets.length === 0) return;

    // Build the dynamic rootMargin string based on offset value
    const margin = this.rootMarginValue || `-${this.offsetValue}px 0px -80% 0px`;
    const rootEl = this.#getRootElement();

    this.#observer = new IntersectionObserver(this.#onIntersection, {
      root: rootEl,
      rootMargin: margin,
      threshold: [0, 0.2, 0.4, 0.6, 0.8, 1], // Multiple thresholds handle large sections safely
    });

    // Observe each target section mapped by the href anchors
    for (const link of this.linkTargets) {
      const id = this.#getAnchorId(link);
      if (!id) continue;

      const section = document.getElementById(id);
      if (section) {
        this.#observer.observe(section);
      }
    }
  }

  readonly #onIntersection = (entries: IntersectionObserverEntry[]): void => {
    // Ignore any callback delivered after teardown: the browser may flush a
    // final queued batch right after `disconnect()`, and a detached controller
    // must not mutate `aria-current` on (possibly cached) links.
    if (!this.#isConnected) return;

    for (const entry of entries) {
      const id = entry.target.id;
      if (!id) continue;

      this.#intersectionStates.set(id, {
        isIntersecting: entry.isIntersecting,
        top: entry.boundingClientRect.top,
      });
    }

    this.#evaluateActiveSection();
  };

  #evaluateActiveSection(): void {
    // The trigger line is `offset` px below the top of the scroll root. When a
    // nested `rootSelector` container is used it is not at the viewport top, so
    // the line must be measured from the container's current top — comparing the
    // viewport-based `boundingClientRect.top` against a bare `offset` would
    // otherwise pick the section nearest the viewport top, not the container's.
    const rootEl = this.#getRootElement();
    const triggerLine = (rootEl ? rootEl.getBoundingClientRect().top : 0) + this.offsetValue;

    let bestId = "";
    let closestTop = Number.MAX_VALUE;

    // Evaluate among all intersecting elements
    for (const [id, state] of this.#intersectionStates.entries()) {
      if (state.isIntersecting) {
        // Evaluate the one closest to the offset trigger line
        const distance = Math.abs(state.top - triggerLine);
        if (distance < closestTop) {
          closestTop = distance;
          bestId = id;
        }
      }
    }

    // Fallback: when no section currently intersects (e.g. scrolled past the
    // bottom, or between sections), pick the tracked section whose top is closest
    // to the trigger line so something stays highlighted.
    if (!bestId && this.#intersectionStates.size > 0) {
      let absoluteClosestId = "";
      let absoluteClosestTop = Number.MAX_VALUE;

      for (const [id, state] of this.#intersectionStates.entries()) {
        const distance = Math.abs(state.top - triggerLine);
        if (distance < absoluteClosestTop) {
          absoluteClosestTop = distance;
          absoluteClosestId = id;
        }
      }
      bestId = absoluteClosestId;
    }

    if (bestId && bestId !== this.#activeSectionId) {
      this.#activeSectionId = bestId;
      this.#syncActiveStates();
    }
  }

  #syncActiveStates(): void {
    const activeLink = this.linkTargets.find((l) => this.#getAnchorId(l) === this.#activeSectionId);

    for (const link of this.linkTargets) {
      const isActive = link === activeLink;
      if (isActive) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }

    if (activeLink) {
      this.dispatch("change", { detail: { id: this.#activeSectionId, link: activeLink } });
    }
  }

  #getAnchorId(link: HTMLElement): string | null {
    const href = link.getAttribute("href") || link.getAttribute("data-href");
    if (!href?.startsWith("#")) return null;
    return href.substring(1);
  }
}
