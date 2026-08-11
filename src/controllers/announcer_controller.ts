import { Controller } from "@hotwired/stimulus";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { SafeTimeout } from "../utils/safe_timeout";

/** The two politeness levels this controller keeps a region for. */
const LEVELS = ["polite", "assertive"] as const;

/** One of the politeness levels in {@link LEVELS}. */
type Level = (typeof LEVELS)[number];

/**
 * Headless, shared **live-region announcer** — a polite/assertive screen-reader
 * announcement base (no dedicated APG pattern; follows the WAI-ARIA "Alert" /
 * "Status" live-region guidance and WCAG 2.2 **4.1.3 Status Messages**).
 *
 * Markup contract (identifier: `stimeo--announcer`):
 *   <!-- Place once per page; the consumer visually hides the regions in CSS. -->
 *   <div data-controller="stimeo--announcer">
 *     <div data-stimeo--announcer-target="polite" aria-live="polite" aria-atomic="true"></div>
 *     <div data-stimeo--announcer-target="assertive" aria-live="assertive" aria-atomic="true"></div>
 *   </div>
 *
 *   <!-- Attribute-only trigger: declare the activation event explicitly. -->
 *   <button data-action="click->stimeo--announcer#announce"
 *           data-stimeo--announcer-message-param="Saved"
 *           data-stimeo--announcer-assertive-param="false">Save</button>
 *
 *   <!-- Programmatic trigger (e.g. from another controller / Turbo Stream). -->
 *   window.dispatchEvent(new CustomEvent("stimeo--announcer:announce", {
 *     detail: { message: "12 results", assertive: false },
 *   }))
 *
 * The announcer is the shared substrate other controllers (Auto-Submit, Flash,
 * Bulk Select, …) lean on instead of each carrying their own live region.
 *
 * @remarks
 * Behavior only, with **one deliberate exception**: when a `polite`/`assertive`
 * target is absent the controller *generates* the missing region **on connect**
 * and applies the canonical visually-hidden inline style (see {@link visuallyHide}).
 * A live region must exist and be visually hidden to do its job, and a generated
 * node has no consumer CSS hook to hide it; consumers who want to own styling
 * supply their own targets. Generation happens up front rather than on the first
 * announcement because assistive tech reports changes to a region it already
 * knows about — a region created and written within one task loses that first
 * message. The controller never moves focus — announcements must not steal it
 * (WCAG 2.2 4.1.3). Listeners and clear timers are torn down on `disconnect()`
 * (Turbo included), and any generated regions are removed — from the cached
 * snapshot too, via {@link BeforeCacheReset}, because `connect()` cannot reuse a
 * restored region (it carries no target attribute) and would pair another one
 * with it on every visit.
 *
 * **Messages are queued, one write per task.** Assistive tech announces what it
 * observes changing, so two messages written into one region within a single task
 * are one observed change and the earlier message is never read. Each politeness
 * has its own FIFO — an assertive message never waits behind polite ones — and a
 * message is written only in a task where its region already existed.
 *
 * **The region set is kept whole while connected.** Exactly one region per
 * politeness is present: an authored target retires the stand-in generated for it,
 * losing one materialises a stand-in again, and a generated region removed by a
 * morph (it is absent from the server's HTML, so a morph drops it) is put back
 * without waiting for the next message.
 */
export class AnnouncerController extends Controller<HTMLElement> {
  static override targets = ["polite", "assertive"];
  static override values = {
    clearAfter: { type: Number, default: 1000 },
    dedupeReannounce: { type: Boolean, default: true },
  };
  static actions = ["announce"] as const;

  declare readonly politeTarget: HTMLElement;
  declare readonly assertiveTarget: HTMLElement;
  declare readonly hasPoliteTarget: boolean;
  declare readonly hasAssertiveTarget: boolean;

  declare clearAfterValue: number;
  declare dedupeReannounceValue: boolean;

  /** Clear/re-announce timers; one `clearAll()` in disconnect tears them all down. */
  readonly #timers = new SafeTimeout();

  /** Live regions generated to stand in for absent targets, for teardown. */
  readonly #generated = new Map<Level, HTMLElement>();

  /** Messages waiting to be written, oldest first, one queue per politeness. */
  readonly #queues = new Map<Level, string[]>();

  /** Politeness levels whose next drain is already armed. */
  readonly #draining = new Set<Level>();

  /** Collapses a batch of target callbacks (and morph removals) into one pass. */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileRegions());

  /**
   * Watches the host's own children for a generated region disappearing. A morph
   * drops it — the server's HTML never had it — and no target callback reports
   * that, because a generated region carries no target attribute. `subtree` stays
   * off so writing a message inside a region does not re-enter this pass.
   */
  readonly #hostWatch = new MutationObserver(() => {
    this.#reconcile.schedule();
  });

  /** Rewinds to an announceable initial state for the snapshot; see the remarks. */
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  /**
   * The one timer a region may have outstanding — its dedupe re-set, then its
   * auto-clear. Held weakly so a swapped-out target is not retained; a leftover
   * id is harmless because {@link SafeTimeout.clear} no-ops on an id it does not
   * own.
   */
  readonly #pending = new WeakMap<HTMLElement, number>();

  /**
   * Guards against handling the same CustomEvent twice. An event dispatched on
   * the controller element with `bubbles: true` reaches both the element and the
   * `window` listener; this WeakSet ensures it announces only once.
   */
  readonly #handled = new WeakSet<Event>();

  /** Receives programmatic announcements at the element or bubbled to `window`. */
  readonly #onAnnounceEvent = (event: Event): void => {
    if (this.#handled.has(event)) return;
    this.#handled.add(event);
    const detail = (event as CustomEvent<unknown>).detail;
    const message = this.#messageFromDetail(detail);
    if (!message) return;
    this.#announce(message, this.#assertiveFromDetail(detail));
  };

  override connect(): void {
    this.#reconcile.activate();
    this.#beforeCache.activate();
    // Materialise any missing region now, so it is in the accessibility tree
    // before the first message rather than appearing with it.
    this.#reconcileRegions();
    this.#hostWatch.observe(this.element, { childList: true });
    this.element.addEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    window.addEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
  }

  override disconnect(): void {
    this.#reconcile.cancel();
    this.#hostWatch.disconnect();
    this.#beforeCache.deactivate();
    this.element.removeEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    window.removeEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    this.#timers.clearAll();
    this.#queues.clear();
    this.#draining.clear();
    this.#removeGenerated();
  }

  /** Retires the stand-in once the consumer supplies a polite region. */
  politeTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Materialises a stand-in once the consumer's polite region goes away. */
  politeTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Retires the stand-in once the consumer supplies an assertive region. */
  assertiveTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Materialises a stand-in once the consumer's assertive region goes away. */
  assertiveTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Brings the region set back to exactly one region per politeness and reports
   * whether anything had to be created.
   *
   * A region created here is not written to in the same task: assistive tech
   * reports changes to regions it already knows about, so {@link drain} waits a
   * task whenever this says a region is new.
   */
  #reconcileRegions(): boolean {
    let created = false;
    for (const level of LEVELS) {
      if (this.#hasTargetFor(level)) {
        // The consumer owns this politeness now; a stand-in would be a second
        // region for it, and an empty one nothing ever writes to.
        const generated = this.#generated.get(level);
        if (generated) {
          generated.remove();
          this.#generated.delete(level);
        }
        continue;
      }
      const existing = this.#generated.get(level);
      if (existing?.isConnected) continue;
      this.#generated.set(level, this.#createRegion(level));
      created = true;
    }
    return created;
  }

  /** Whether the consumer supplied a target for `level`. */
  #hasTargetFor(level: Level): boolean {
    return level === "assertive" ? this.hasAssertiveTarget : this.hasPoliteTarget;
  }

  /** Builds a visually hidden live region for `level` and attaches it. */
  #createRegion(level: Level): HTMLElement {
    const region = document.createElement("div");
    region.setAttribute("aria-live", level);
    region.setAttribute("aria-atomic", "true");
    visuallyHide(region);
    this.element.appendChild(region);
    return region;
  }

  /**
   * Removes and forgets every region this controller generated. Authored targets
   * belong to the consumer and are left untouched. Forgetting them is what keeps
   * the live page working after a snapshot rewind: the next announcement finds an
   * empty map and materialises a fresh region.
   */
  #removeGenerated(): void {
    for (const region of this.#generated.values()) {
      region.remove();
    }
    this.#generated.clear();
  }

  /**
   * Announces a message. Reads the text from a Stimulus action param
   * (`message`, plus optional `assertive`) for attribute-only triggers, falling
   * back to a CustomEvent `detail` when the same handler is wired to an event.
   * An empty/non-string message is ignored so untrusted payloads cannot blank
   * the region.
   */
  announce(event: Event): void {
    const params = (event as { params?: Record<string, unknown> }).params;
    const fromParam = params?.message;
    const message =
      typeof fromParam === "string" && fromParam.length > 0
        ? fromParam
        : this.#messageFromDetail((event as CustomEvent<unknown>).detail);
    if (!message) return;

    const assertive =
      params?.assertive === true ||
      this.#assertiveFromDetail((event as CustomEvent<unknown>).detail);
    this.#announce(message, assertive);
  }

  /**
   * Queues `message` for its politeness and arms the drain.
   *
   * Queuing is what makes a burst audible: assistive tech announces the changes it
   * observes, so several messages written into one region within a single task are
   * one change and only the last is read.
   */
  #announce(message: string, assertive: boolean): void {
    const level: Level = assertive ? "assertive" : "polite";
    const queue = this.#queues.get(level);
    if (queue) {
      queue.push(message);
    } else {
      this.#queues.set(level, [message]);
    }
    this.#scheduleDrain(level);
  }

  /** Arms one drain pass for `level`; further messages ride the pass already armed. */
  #scheduleDrain(level: Level): void {
    if (this.#draining.has(level)) return;
    this.#draining.add(level);
    this.#timers.set(() => {
      this.#draining.delete(level);
      this.#drain(level);
    }, 0);
  }

  /**
   * Writes one queued message, then arms the next pass while the queue holds more.
   *
   * Two steps take a whole pass without consuming the message: materialising a
   * region (it has to be in the accessibility tree before the text arrives) and
   * emptying a region that already holds this exact text (an unchanged node is not
   * re-read, so `dedupeReannounce` clears first and writes on the following pass).
   */
  #drain(level: Level): void {
    const queue = this.#queues.get(level);
    const message = queue?.[0];
    if (queue === undefined || message === undefined) return;

    if (this.#reconcileRegions()) {
      this.#scheduleDrain(level);
      return;
    }

    const region = this.#regionFor(level);
    if (this.dedupeReannounceValue && region.textContent === message) {
      this.#cancelPending(region);
      region.textContent = "";
      this.#scheduleDrain(level);
      return;
    }

    queue.shift();
    this.#cancelPending(region);
    region.textContent = message;
    this.#scheduleClear(region, message);
    if (queue.length > 0) this.#scheduleDrain(level);
  }

  /** Clears the region after `clearAfter` ms, unless a newer message replaced it. */
  #scheduleClear(region: HTMLElement, message: string): void {
    if (this.clearAfterValue <= 0) return;
    this.#schedule(
      region,
      () => {
        if (region.textContent === message) region.textContent = "";
      },
      this.clearAfterValue,
    );
  }

  /**
   * Arms `region`'s single pending timer. Callers reach here with the slot
   * already free — `#announce` releases it, and a fired timer clears its own
   * entry below — so this does not cancel again.
   */
  #schedule(region: HTMLElement, callback: () => void, delay: number): void {
    const id = this.#timers.set(() => {
      // Drop the id as it fires: platform timer ids are recycled, and a stale
      // one left here could later cancel the *other* region's live timer.
      this.#pending.delete(region);
      callback();
    }, delay);
    this.#pending.set(region, id);
  }

  /** Releases `region`'s pending timer, if it has one. */
  #cancelPending(region: HTMLElement): void {
    // `SafeTimeout.clear` ignores an id it does not own, so the "no pending
    // timer" case needs no branch of its own.
    this.#timers.clear(this.#pending.get(region) ?? -1);
    this.#pending.delete(region);
  }

  /**
   * Resolves the live region for a politeness level.
   *
   * The remembered stand-in is used only while it is still in the document: a morph
   * can drop it, and writing into the detached node would announce nothing at all.
   */
  #regionFor(level: Level): HTMLElement {
    if (level === "assertive" && this.hasAssertiveTarget) return this.assertiveTarget;
    if (level === "polite" && this.hasPoliteTarget) return this.politeTarget;

    const existing = this.#generated.get(level);
    if (existing?.isConnected) return existing;

    const region = this.#createRegion(level);
    this.#generated.set(level, region);
    return region;
  }

  /**
   * Restores the announceable initial state for the snapshot Turbo is about to
   * take: queued and displayed messages go, generated regions go, and the live
   * page — which keeps running when a visit is aborted — gets its regions back on
   * the next task, after the clone.
   */
  #rewindForCache(): void {
    this.#queues.clear();
    this.#draining.clear();
    this.#timers.clearAll();
    for (const level of LEVELS) {
      if (this.#hasTargetFor(level)) {
        const target = level === "assertive" ? this.assertiveTarget : this.politeTarget;
        target.textContent = "";
      }
    }
    this.#removeGenerated();
    this.#timers.set(() => this.#reconcileRegions(), 0);
  }

  /** Extracts a non-empty string `message` from a CustomEvent detail, else null. */
  #messageFromDetail(detail: unknown): string | null {
    if (detail && typeof detail === "object" && "message" in detail) {
      const value = (detail as Record<string, unknown>).message;
      if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
  }

  /** Reads an `assertive === true` flag from a CustomEvent detail (default polite). */
  #assertiveFromDetail(detail: unknown): boolean {
    return (
      !!detail &&
      typeof detail === "object" &&
      (detail as Record<string, unknown>).assertive === true
    );
  }
}

/**
 * Applies the canonical visually-hidden ("sr-only") inline style to a generated
 * live region so its text is announced without being seen. Inline so the library
 * stays self-contained when the consumer provides no target/CSS of its own.
 *
 * Pure (no `this`); exported for direct unit testing.
 */
export function visuallyHide(node: HTMLElement): void {
  const { style } = node;
  style.position = "absolute";
  style.width = "1px";
  style.height = "1px";
  style.margin = "-1px";
  style.padding = "0";
  style.border = "0";
  style.overflow = "hidden";
  style.clip = "rect(0 0 0 0)";
  style.clipPath = "inset(50%)";
  style.whiteSpace = "nowrap";
}
