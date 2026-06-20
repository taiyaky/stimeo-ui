import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

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
 * target is absent the controller *generates* the missing region and applies the
 * canonical visually-hidden inline style (see {@link visuallyHide}). A live region
 * must exist and be visually hidden to do its job, and a generated node has no
 * consumer CSS hook to hide it; consumers who want to own styling supply their own
 * targets. The controller never moves focus — announcements must not steal it
 * (WCAG 2.2 4.1.3). Listeners and clear timers are torn down on `disconnect()`
 * (Turbo included), and any generated regions are removed.
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
  readonly #generated = new Map<"assertive" | "polite", HTMLElement>();

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
    this.element.addEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    window.addEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
  }

  override disconnect(): void {
    this.element.removeEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    window.removeEventListener("stimeo--announcer:announce", this.#onAnnounceEvent);
    this.#timers.clearAll();
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
   * Writes `message` into the matching live region and schedules its clear.
   *
   * When the region already holds the same text, an aria-atomic region is not
   * re-read by assistive tech (the node did not change). If `dedupeReannounce`
   * is on, the text is cleared and re-set on a later task so the mutation is
   * observed and announced again.
   */
  #announce(message: string, assertive: boolean): void {
    const region = this.#regionFor(assertive ? "assertive" : "polite");

    if (this.dedupeReannounceValue && region.textContent === message) {
      region.textContent = "";
      this.#timers.set(() => {
        region.textContent = message;
        this.#scheduleClear(region, message);
      }, 0);
      return;
    }

    region.textContent = message;
    this.#scheduleClear(region, message);
  }

  /** Clears the region after `clearAfter` ms, unless a newer message replaced it. */
  #scheduleClear(region: HTMLElement, message: string): void {
    if (this.clearAfterValue <= 0) return;
    this.#timers.set(() => {
      if (region.textContent === message) region.textContent = "";
    }, this.clearAfterValue);
  }

  /** Resolves the live region for a politeness level, generating it if absent. */
  #regionFor(level: "assertive" | "polite"): HTMLElement {
    if (level === "assertive" && this.hasAssertiveTarget) return this.assertiveTarget;
    if (level === "polite" && this.hasPoliteTarget) return this.politeTarget;

    const existing = this.#generated.get(level);
    if (existing) return existing;

    const region = document.createElement("div");
    region.setAttribute("aria-live", level);
    region.setAttribute("aria-atomic", "true");
    visuallyHide(region);
    this.element.appendChild(region);
    this.#generated.set(level, region);
    return region;
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
