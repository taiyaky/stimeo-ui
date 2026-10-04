import { Controller } from "@hotwired/stimulus";
import { DetachGate } from "../utils/detach_gate";
import { KeyedTimers } from "../utils/keyed_timers";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { SafeTimeout } from "../utils/safe_timeout";

/** The two politeness levels this controller keeps a region for. */
const LEVELS = ["polite", "assertive"] as const;

/** One of the politeness levels in {@link LEVELS}. */
type Level = (typeof LEVELS)[number];

/** Suffix of the marker on a live region this controller generated; see the class remarks. */
const STAND_IN = "stand-in";

/** Suffix of the marker on a region holding a message this controller wrote. */
const ANNOUNCED = "announced";

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
 * The announcer is the shared live region other controllers hand their messages
 * to (`stimeo--auto-submit`, `stimeo--flash` and `stimeo--bulk-select` among
 * them) instead of each carrying their own.
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
 * (WCAG 2.2 4.1.3). Listeners, the queues and the clear timers are torn down, and any
 * generated regions removed, once the element is really detached. An in-page move,
 * and a `data-turbo-permanent` announcer Turbo carries to the next page, reconnect
 * the same instance with all of them in place, so what was queued is still read and a
 * message on display is still cleared on time.
 *
 * **Generated regions are marked, so a restore never doubles them.** Each
 * stand-in carries `data-<identifier>-stand-in`. The region set is kept whole until
 * the controller is detached, so a stand-in can reach a copy of the page — a page Turbo
 * restores from its cache is one. The teardown removes the stand-ins a connection
 * generated, so a marked child a host arrives with came from an earlier one:
 * `connect()` drops it before generating its own, and it never sits as a second
 * region beside the new stand-in or an authored target.
 *
 * **A restored page does not read out an earlier message.** A region holding a
 * message this controller wrote carries `data-<identifier>-announced` until the message
 * is cleared after `clearAfter`. The teardown drops the clearing timers, so a connection
 * that is not the other half of a move empties every marked authored region it finds;
 * an authored region's own initial text carries no mark and stays. Nothing is dropped or emptied on `turbo:before-cache`, which Turbo
 * also dispatches on pages that stay (a promoted frame navigation, a state-less
 * `popstate`, a refresh of a cached URL): the messages queued there are still read.
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
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["polite", "assertive"];
  static override values = {
    clearAfter: { type: Number, default: 1000 },
    dedupeReannounce: { type: Boolean, default: true },
  };

  static valueConstraints = {
    clearAfter: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof AnnouncerController.values>;
  static actions = ["announce"] as const;

  declare readonly politeTarget: HTMLElement;
  declare readonly assertiveTarget: HTMLElement;
  declare readonly politeTargets: HTMLElement[];
  declare readonly assertiveTargets: HTMLElement[];
  declare readonly hasPoliteTarget: boolean;
  declare readonly hasAssertiveTarget: boolean;

  declare clearAfterValue: number;
  declare dedupeReannounceValue: boolean;

  /** Drain timers, which belong to a politeness level rather than to a region. */
  readonly #timers = new SafeTimeout();

  /** Tells an in-page move or a permanent carry from a real detach. */
  readonly #gate = new DetachGate();

  /** The auto-clear each region may have outstanding; a newer message releases it. */
  readonly #regionTimers = new KeyedTimers<HTMLElement>();

  /** The stand-in last generated per absent target, which may have left the document since. */
  readonly #generated = new Map<Level, HTMLElement>();

  /** The stand-in marker, in the namespace this controller is registered under. */
  get #standIn(): string {
    return `data-${this.identifier}-${STAND_IN}`;
  }

  /** The written-message marker, in the namespace this controller is registered under. */
  get #announced(): string {
    return `data-${this.identifier}-${ANNOUNCED}`;
  }

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

  /**
   * Seats the regions and starts listening. The reconnection that completes an in-page
   * move or a permanent carry finds all of it in place, the queues and timers included.
   */
  override connect(): void {
    const moved = this.#gate.pending;
    this.#gate.cancel();
    if (moved) return;
    this.#reconcile.activate();
    this.#dropInheritedStandIns();
    this.#emptyInheritedMessages();
    // Materialise any missing region now, so it is in the accessibility tree
    // before the first message rather than appearing with it.
    this.#reconcileRegions();
    this.#hostWatch.observe(this.element, { childList: true });
    this.element.addEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    window.addEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
  }

  /** Tears everything down once the element is really detached. */
  override disconnect(): void {
    this.#gate.disconnected(this, () => this.#teardown());
  }

  /** Releases the listeners, the queues, the timers and the stand-ins. */
  #teardown(): void {
    this.#reconcile.cancel();
    this.#hostWatch.disconnect();
    this.element.removeEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    window.removeEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    this.#timers.clearAll();
    this.#regionTimers.clearAll();
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
        this.#generated.get(level)?.remove();
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

  /** Builds a visually hidden, marked live region for `level` and attaches it. */
  #createRegion(level: Level): HTMLElement {
    const region = document.createElement("div");
    region.setAttribute("aria-live", level);
    region.setAttribute("aria-atomic", "true");
    region.setAttribute(this.#standIn, "");
    visuallyHide(region);
    this.element.appendChild(region);
    return region;
  }

  /** Removes the stand-ins the host arrived with; see the class remarks. */
  #dropInheritedStandIns(): void {
    for (const child of Array.from(this.element.children)) {
      if (child.hasAttribute(this.#standIn)) child.remove();
    }
  }

  /**
   * Empties the authored regions that hold a message this controller wrote, which no
   * clearing timer of this connection is left to clear; see the class remarks.
   */
  #emptyInheritedMessages(): void {
    for (const region of [...this.politeTargets, ...this.assertiveTargets]) {
      if (!region.hasAttribute(this.#announced)) continue;
      region.replaceChildren();
      region.removeAttribute(this.#announced);
    }
  }

  /** Removes the stand-ins this connection generated; authored targets stay. */
  #removeGenerated(): void {
    for (const region of this.#generated.values()) region.remove();
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
   *
   * @stimeoRuntimeOnly `dedupeReannounce` decides whether one queued message is spoken again; the
   *   region's text is the message itself.
   */
  #drain(level: Level): void {
    const queue = this.#queues.get(level);
    const message = queue?.[0];
    if (queue === undefined || message === undefined) return;

    const created = this.#reconcileRegions();
    const region = this.#regionFor(level);
    // With nothing created every politeness has a seated region; the second check
    // narrows the type.
    if (created || region === undefined) {
      this.#scheduleDrain(level);
      return;
    }

    if (this.dedupeReannounceValue && region.textContent === message) {
      region.textContent = "";
      this.#scheduleDrain(level);
      return;
    }

    queue.shift();
    // A non-positive `clearAfter` arms nothing below, so the region's pending
    // timer is released here rather than by the arming that replaces it.
    this.#regionTimers.clear(region);
    region.textContent = message;
    region.setAttribute(this.#announced, "");
    this.#scheduleClear(region, message);
    if (queue.length > 0) this.#scheduleDrain(level);
  }

  /**
   * Clears the region after `clearAfter` ms, unless a newer message replaced it.
   *
   * @stimeoRuntimeOnly `clearAfter` is the delay of the one clearing timer this call arms.
   */
  #scheduleClear(region: HTMLElement, message: string): void {
    if (this.#safeClearAfter <= 0) return;
    this.#regionTimers.set(
      region,
      () => {
        if (region.textContent !== message) return;
        region.textContent = "";
        region.removeAttribute(this.#announced);
      },
      this.#safeClearAfter,
    );
  }

  /**
   * The region a politeness writes into: its target, else its last stand-in. A
   * morph can drop the stand-in, and only a reconcile pass that created nothing
   * guarantees it is seated; a detached node announces nothing.
   */
  #regionFor(level: Level): HTMLElement | undefined {
    if (level === "assertive" && this.hasAssertiveTarget) return this.assertiveTarget;
    if (level === "polite" && this.hasPoliteTarget) return this.politeTarget;
    return this.#generated.get(level);
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
  /** Current `clearAfter` declaration resolved against its numeric contract. */
  get #safeClearAfter(): number {
    return this.#numbers.read(
      this,
      "clearAfter",
      this.clearAfterValue,
      AnnouncerController.values.clearAfter.default,
      AnnouncerController.valueConstraints.clearAfter,
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
