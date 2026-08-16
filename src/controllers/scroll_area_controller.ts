import { Controller } from "@hotwired/stimulus";
import { AttributeLease } from "../utils/attribute_lease";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { hasTabStop } from "../utils/focus_candidate";
import { LayoutObserver } from "../utils/layout_observer";
import { logicalScrollMetrics } from "../utils/logical_scroll";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { StylePropertyLease } from "../utils/style_property_lease";
import { TabindexLoan } from "../utils/tabindex_loan";

/** Distance from an edge (px) treated as fully reached; absorbs sub-pixel scroll. */
const EDGE_EPSILON = 1;

type Edge = "start" | "end";

/** The event surface used by `document.fonts` without requiring it in older engines. */
interface FontEventSource {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/**
 * Headless **Scroll Area** behavior: keyboard reachability and scroll-state hooks
 * for a natively scrolling region. No custom scrollbar is introduced.
 *
 * Markup contract (identifier: `stimeo--scroll-area`):
 *   <div data-controller="stimeo--scroll-area"
 *        data-stimeo--scroll-area-orientation-value="vertical">
 *     <div data-stimeo--scroll-area-target="viewport" aria-label="Log output">
 *       <!-- long content -->
 *     </div>
 *   </div>
 *
 * When content overflows and the viewport has no sequential Tab stop of its own,
 * the viewport receives a borrowed `tabindex="0"`. A named viewport also receives
 * a borrowed `role="region"`. Position is exposed through `data-scroll`, overflow
 * through `data-overflow`, and normalized progress through
 * `--stimeo--scroll-progress` so consumer CSS can render state without prescribing
 * appearance.
 *
 * The `reach` event is emitted once when an overflowing edge state is established,
 * including initial connection and a fit-to-overflow transition. Moving away from
 * that edge rearms the next arrival.
 *
 * `reach` dispatches `{ edge: "start" | "end" }`.
 *
 * @remarks
 * Behavior only. Scroll work is coalesced to one animation frame and never scans
 * descendants. Resize, content, accessible-name source, descendant-load, and font
 * completion changes run the full measurement pass. Every listener, observer,
 * animation frame, borrowed attribute, and state hook is released on disconnect
 * and before Turbo caches the page. Runtime viewport replacement rebinds the whole
 * resource set as one lifecycle unit.
 */
export class ScrollAreaController extends Controller<HTMLElement> {
  static override targets = ["viewport"];
  static override values = {
    orientation: { type: String, default: "vertical" },
  };
  static events = ["reach"] as const;

  declare readonly viewportTarget: HTMLElement;
  declare readonly hasViewportTarget: boolean;

  declare orientationValue: string;

  readonly #layout = new LayoutObserver(() => this.#refresh());
  readonly #rebind = new MicrotaskCoalescer(() => this.#syncViewport());
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());
  readonly #tabindex = new TabindexLoan("0");
  readonly #role = new AttributeLease<HTMLElement>("role");
  readonly #overflowState = new AttributeLease<HTMLElement>("data-overflow");
  readonly #scrollState = new AttributeLease<HTMLElement>("data-scroll");
  readonly #progress = new StylePropertyLease<HTMLElement>("--stimeo--scroll-progress");

  #viewport: HTMLElement | null = null;
  #content: MutationObserver | null = null;
  #nameSources: MutationObserver | null = null;
  #nameGraph: MutationObserver | null = null;
  #observedNameIds = new Set<string>();
  #observedNameSources: Element[] = [];
  #fonts: FontEventSource | null = null;
  #scrollFrame: number | null = null;
  #overflowing = false;
  #lastEdge: Edge | null = null;
  readonly #ownedHostMutations = new Map<string, string | null>();

  readonly #onScroll = (): void => {
    if (this.#scrollFrame !== null) return;
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = null;
      const viewport = this.#viewport;
      if (viewport) this.#syncPosition(viewport, this.#overflowing);
    });
  };

  readonly #onLoad = (): void => {
    this.#refresh();
  };

  readonly #onFontsSettled: EventListener = () => {
    this.#refresh();
  };

  override connect(): void {
    this.#beforeCache.activate();
    this.#rebind.activate();
    this.#layout.observeViewport();
    this.#bindFonts();
    this.#syncViewport();
  }

  override disconnect(): void {
    this.#beforeCache.deactivate();
    this.#rebind.cancel();
    this.#cancelScrollFrame();
    if (this.#viewport) this.#unbindViewport(this.#viewport);
    this.#layout.disconnect();
    this.#unbindFonts();
    this.#clearHostState();
  }

  /** Re-measures when a retained viewport's orientation Value is morphed. */
  orientationValueChanged(): void {
    this.#refresh();
  }

  /** Schedules a complete resource rebind for a runtime viewport target. */
  viewportTargetConnected(): void {
    this.#rebind.schedule();
  }

  /** Schedules cleanup or replacement binding after a viewport leaves. */
  viewportTargetDisconnected(): void {
    this.#rebind.schedule();
  }

  /** Rebinds every viewport-owned resource against the final target in the mutation batch. */
  #syncViewport(): void {
    const next = this.hasViewportTarget ? this.viewportTarget : null;
    if (next === this.#viewport) {
      if (next) this.#refresh();
      else this.#clearHostState();
      return;
    }

    if (this.#viewport) this.#unbindViewport(this.#viewport);
    this.#viewport = next;
    if (!next) {
      this.#clearHostState();
      return;
    }

    next.addEventListener("scroll", this.#onScroll, { passive: true });
    next.addEventListener("load", this.#onLoad, true);
    this.#layout.observe(next);
    this.#bindContentObserver(next);
    this.#refresh();
  }

  /** Observes structural and attribute changes that can alter overflow or Tab stops. */
  #bindContentObserver(viewport: HTMLElement): void {
    this.#content = new MutationObserver((records) => {
      if (this.#viewport !== viewport || !this.#hasRelevantContentMutation(records)) return;
      this.#refresh();
    });
    this.#content.observe(viewport, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  /** Ignores only state-hook mutations whose exact value this controller just wrote. */
  #hasRelevantContentMutation(records: MutationRecord[]): boolean {
    let relevant = false;
    const consumed = new Set<string>();
    for (const record of records) {
      const attribute = record.attributeName;
      if (
        record.type === "attributes" &&
        record.target === this.element &&
        attribute !== null &&
        this.#ownedHostMutations.has(attribute) &&
        this.element.getAttribute(attribute) === this.#ownedHostMutations.get(attribute)
      ) {
        consumed.add(attribute);
      } else {
        relevant = true;
      }
    }
    for (const attribute of consumed) this.#ownedHostMutations.delete(attribute);
    return relevant;
  }

  /** Releases every resource and borrowed attribute owned by one former viewport. */
  #unbindViewport(viewport: HTMLElement): void {
    this.#cancelScrollFrame();
    viewport.removeEventListener("scroll", this.#onScroll);
    viewport.removeEventListener("load", this.#onLoad, true);
    this.#layout.unobserve(viewport);
    this.#content?.disconnect();
    this.#content = null;
    this.#disconnectNameSources();
    this.#clearViewportAttributes(viewport);
    this.#ownedHostMutations.clear();
    this.#viewport = null;
    this.#overflowing = false;
    this.#lastEdge = null;
  }

  /** Runs the full structural and positional measurement pass. */
  #refresh(): void {
    const viewport = this.#viewport;
    if (!viewport) return;
    this.#cancelScrollFrame();
    this.#syncNameSources(viewport);
    this.#overflowing = this.#syncOverflow(viewport);
    this.#syncKeyboardReach(viewport, this.#overflowing);
    this.#syncPosition(viewport, this.#overflowing);
  }

  /** Measures overflow and reflects the state hook without identical DOM writes. */
  #syncOverflow(viewport: HTMLElement): boolean {
    const overflowing = this.#measureOverflow(viewport);
    this.#writeHostAttribute(this.#overflowState, "data-overflow", overflowing ? "true" : "false");
    return overflowing;
  }

  /** Measures the primary-axis position and dispatches a newly established edge. */
  #syncPosition(viewport: HTMLElement, overflowing: boolean): void {
    const { position, progress } = this.#measurePosition(viewport);
    this.#writeHostAttribute(this.#scrollState, "data-scroll", position);
    this.#writeHostProgress(String(progress));

    const edge: Edge | null =
      overflowing && (position === "start" || position === "end") ? position : null;
    if (edge === this.#lastEdge) return;
    this.#lastEdge = edge;
    if (edge) this.dispatch("reach", { detail: { edge } });
  }

  /** Writes one leased host attribute and records self-generated observer input. */
  #writeHostAttribute(lease: AttributeLease<HTMLElement>, attribute: string, value: string): void {
    const before = this.element.getAttribute(attribute);
    lease.write(this.element, value);
    this.#recordOwnedHostMutation(attribute, before);
  }

  /** Writes the leased progress property and records its serialized style mutation. */
  #writeHostProgress(value: string): void {
    const before = this.element.getAttribute("style");
    this.#progress.write(this.element, value);
    this.#recordOwnedHostMutation("style", before);
  }

  /** Records an exact host mutation only when the host is also the observed viewport. */
  #recordOwnedHostMutation(attribute: string, before: string | null): void {
    if (this.#viewport !== this.element) return;
    const after = this.element.getAttribute(attribute);
    if (after !== before) this.#ownedHostMutations.set(attribute, after);
  }

  /** Returns host hooks to authored values and clears edge bookkeeping. */
  #clearHostState(): void {
    this.#overflowState.returnAll();
    this.#scrollState.returnAll();
    this.#progress.returnAll();
    this.#ownedHostMutations.clear();
    this.#overflowing = false;
    this.#lastEdge = null;
  }

  /** Whether the configured axis currently has a scroll range. */
  #measureOverflow(viewport: HTMLElement): boolean {
    const orientation = this.orientationValue;
    const vertical =
      orientation !== "horizontal" && viewport.scrollHeight > viewport.clientHeight + EDGE_EPSILON;
    const horizontal =
      orientation !== "vertical" && viewport.scrollWidth > viewport.clientWidth + EDGE_EPSILON;
    return vertical || horizontal;
  }

  /** Reports the primary-axis position bucket and normalized 0–1 progress. */
  #measurePosition(viewport: HTMLElement): {
    position: "start" | "middle" | "end";
    progress: number;
  } {
    const horizontalPrimary =
      this.orientationValue === "horizontal" ||
      (this.orientationValue === "both" &&
        viewport.scrollHeight <= viewport.clientHeight + EDGE_EPSILON);
    const { position: scrollPosition, max: maxScroll } = logicalScrollMetrics(
      viewport,
      horizontalPrimary,
    );

    if (maxScroll <= EDGE_EPSILON) return { position: "start", progress: 0 };
    const progress = Math.min(1, Math.max(0, scrollPosition / maxScroll));
    if (scrollPosition <= EDGE_EPSILON) return { position: "start", progress };
    if (scrollPosition >= maxScroll - EDGE_EPSILON) return { position: "end", progress };
    return { position: "middle", progress };
  }

  /** Borrows keyboard reach only when no usable descendant already owns a Tab stop. */
  #syncKeyboardReach(viewport: HTMLElement, overflowing: boolean): void {
    const wantsTabindex = overflowing && !hasTabStop(viewport);
    if (!wantsTabindex) {
      this.#clearViewportAttributes(viewport);
      return;
    }

    this.#tabindex.lend(viewport);
    if (this.#hasAccessibleName(viewport)) {
      if (!viewport.hasAttribute("role")) this.#role.write(viewport, "region");
    } else {
      this.#role.return(viewport);
    }
  }

  /** Returns only the viewport attributes borrowed by this controller. */
  #clearViewportAttributes(viewport: HTMLElement): void {
    this.#tabindex.returnAll();
    this.#role.return(viewport);
  }

  /** Whether the viewport already has a non-empty accessible name. */
  #hasAccessibleName(viewport: HTMLElement): boolean {
    const sources = this.#resolveNameSources(viewport);
    if (sources.length > 0) {
      return sources.some((source) => {
        const label = source.getAttribute("aria-label")?.trim();
        return Boolean(label || source.textContent?.trim());
      });
    }
    return Boolean(viewport.getAttribute("aria-label")?.trim());
  }

  /** Resolves unique, live `aria-labelledby` references in authored order. */
  #resolveNameSources(viewport: HTMLElement): Element[] {
    const ids = this.#nameReferenceIds(viewport);
    const sources: Element[] = [];
    const seen = new Set<Element>();
    for (const id of ids) {
      const source = viewport.ownerDocument.getElementById(id);
      if (source && !seen.has(source)) {
        seen.add(source);
        sources.push(source);
      }
    }
    return sources;
  }

  /** Observes external name sources so a retained region never becomes unnamed. */
  #syncNameSources(viewport: HTMLElement): void {
    const ids = this.#nameReferenceIds(viewport);
    const sources = this.#resolveNameSources(viewport).filter(
      (source) => !viewport.contains(source),
    );
    if (
      ids.length === this.#observedNameIds.size &&
      ids.every((id) => this.#observedNameIds.has(id)) &&
      sources.length === this.#observedNameSources.length &&
      sources.every((source, index) => source === this.#observedNameSources[index])
    ) {
      return;
    }

    this.#disconnectNameSources();
    this.#observedNameIds = new Set(ids);
    this.#observedNameSources = sources;
    if (ids.length > 0) {
      this.#nameGraph = new MutationObserver((records) => {
        if (this.#viewport === viewport && this.#hasRelevantNameGraphMutation(records)) {
          this.#refresh();
        }
      });
      const documentElement = viewport.ownerDocument.documentElement;
      if (documentElement) {
        this.#nameGraph.observe(documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["id"],
          attributeOldValue: true,
        });
      }
    }

    if (sources.length === 0) return;
    this.#nameSources = new MutationObserver(() => {
      this.#refresh();
    });
    for (const source of sources) {
      this.#nameSources.observe(source, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }
  }

  /** Returns normalized unique label-reference ids in authored order. */
  #nameReferenceIds(viewport: HTMLElement): string[] {
    const tokens = viewport.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean);
    return Array.from(new Set(tokens));
  }

  /** Whether document-graph changes can resolve or invalidate a referenced id. */
  #hasRelevantNameGraphMutation(records: MutationRecord[]): boolean {
    for (const record of records) {
      if (record.type === "attributes") {
        const current = (record.target as Element).id;
        if (
          this.#observedNameIds.has(current) ||
          this.#observedNameIds.has(record.oldValue ?? "")
        ) {
          return true;
        }
        continue;
      }

      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (this.#nodeContainsObservedNameId(node)) return true;
      }
    }
    return false;
  }

  /** Whether a changed subtree contains one of the current label-reference ids. */
  #nodeContainsObservedNameId(node: Node): boolean {
    if (!(node instanceof Element)) return false;
    if (this.#observedNameIds.has(node.id)) return true;
    return Array.from(node.querySelectorAll<HTMLElement>("[id]")).some((element) =>
      this.#observedNameIds.has(element.id),
    );
  }

  /** Stops observing accessible-name sources. */
  #disconnectNameSources(): void {
    this.#nameSources?.disconnect();
    this.#nameSources = null;
    this.#nameGraph?.disconnect();
    this.#nameGraph = null;
    this.#observedNameIds.clear();
    this.#observedNameSources = [];
  }

  /** Subscribes to font completion when the current engine exposes `document.fonts`. */
  #bindFonts(): void {
    const fonts = (this.element.ownerDocument as Document & { fonts?: FontEventSource }).fonts;
    if (!fonts || this.#fonts === fonts) return;
    this.#unbindFonts();
    this.#fonts = fonts;
    fonts.addEventListener("loadingdone", this.#onFontsSettled);
    fonts.addEventListener("loadingerror", this.#onFontsSettled);
  }

  /** Removes the font completion subscriptions. */
  #unbindFonts(): void {
    this.#fonts?.removeEventListener("loadingdone", this.#onFontsSettled);
    this.#fonts?.removeEventListener("loadingerror", this.#onFontsSettled);
    this.#fonts = null;
  }

  /** Cancels a pending scroll frame. */
  #cancelScrollFrame(): void {
    if (this.#scrollFrame === null) return;
    cancelAnimationFrame(this.#scrollFrame);
    this.#scrollFrame = null;
  }

  /** Suspends live resources and returns all derived state before snapshotting. */
  #rewindForCache(): void {
    this.#rebind.cancel();
    this.#cancelScrollFrame();
    if (this.#viewport) this.#unbindViewport(this.#viewport);
    this.#layout.disconnect();
    this.#unbindFonts();
    this.#clearHostState();
  }
}
