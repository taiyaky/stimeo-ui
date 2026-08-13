import { Controller } from "@hotwired/stimulus";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** A date/time style keyword accepted by `Intl` `dateStyle` / `timeStyle`. */
type DateTimeStyle = "full" | "long" | "medium" | "short";

/** The valid `Intl` style keywords, used to validate the string-typed values. */
const STYLES = new Set<DateTimeStyle>(["full", "long", "medium", "short"]);

/** Narrows an arbitrary string to a valid {@link DateTimeStyle}, or `undefined`. */
function toStyle(value: string): DateTimeStyle | undefined {
  return (STYLES as Set<string>).has(value) ? (value as DateTimeStyle) : undefined;
}

/**
 * Headless local-time behavior: renders the UTC instant in a `<time datetime>`
 * as an absolute, viewer-localized string via `Intl.DateTimeFormat`. No
 * dedicated APG pattern; it follows the HTML `<time>` semantics.
 *
 * Markup contract (identifier: `stimeo--local-time`):
 *   <time datetime="2026-06-08T12:30:00Z"
 *         data-controller="stimeo--local-time"
 *         data-stimeo--local-time-date-style-value="medium"
 *         data-stimeo--local-time-time-style-value="short">2026-06-08 12:30 UTC</time>
 *
 * The server emits UTC (cache-friendly — it never needs to know the viewer's
 * timezone), and the controller reformats the visible text into the viewer's
 * locale/zone on connect. This is the *absolute* localization axis, distinct from
 * {@link RelativeTimeController}'s "3 minutes ago".
 *
 * @remarks
 * Behavior only. The machine-readable `datetime` (UTC) is left untouched so
 * assistive tech and crawlers keep the canonical value while only the display
 * text — and an optional `title` — change. Formatting is a pure function of
 * `datetime` with no module-scope state or timers, so a Turbo Drive cache restore
 * re-runs `connect()` and stays consistent. A parse or `Intl` error leaves the
 * authored absolute text in place rather than throwing.
 *
 * Render inputs are followed at runtime: a morph that swaps a Value or the
 * `datetime` attribute on the live element — which keeps the element, so
 * `connect()` never runs again — repaints through one coalesced pass
 * ({@link MicrotaskCoalescer}) rather than leaving a stale reading on screen.
 */
export class LocalTimeController extends Controller<HTMLElement> {
  static override values = {
    locale: { type: String, default: "" },
    timeZone: { type: String, default: "" },
    dateStyle: { type: String, default: "medium" },
    timeStyle: { type: String, default: "short" },
    titleFormat: { type: String, default: "" },
  };
  static events = ["format"] as const;

  declare localeValue: string;
  declare timeZoneValue: string;
  declare dateStyleValue: string;
  declare timeStyleValue: string;
  declare titleFormatValue: string;

  /** Collapses a morph that swaps several render inputs at once into one repaint. */
  readonly #resync = new MicrotaskCoalescer(() => this.#render());
  /**
   * Watches the one render input that is not a Value. Only `datetime` is filtered
   * in, so the text and `title` this controller writes cannot re-enter the pass.
   */
  readonly #datetimeWatch = new MutationObserver(() => {
    this.#resync.schedule();
  });

  override connect(): void {
    this.#resync.activate();
    this.#datetimeWatch.observe(this.element, { attributeFilter: ["datetime"] });
    this.#render();
  }

  override disconnect(): void {
    this.#resync.cancel();
    this.#datetimeWatch.disconnect();
  }

  /** Repaints when application code (or a Turbo morph) changes `locale` at runtime. */
  localeValueChanged(): void {
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `timeZone` at runtime. */
  timeZoneValueChanged(): void {
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `dateStyle` at runtime. */
  dateStyleValueChanged(): void {
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `timeStyle` at runtime. */
  timeStyleValueChanged(): void {
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `titleFormat` at runtime. */
  titleFormatValueChanged(): void {
    this.#resync.schedule();
  }

  /**
   * Formats the instant in `datetime` against the current Values and writes it out.
   *
   * The `format` event rides with every pass, including a repaint a morph triggers:
   * its condition is that formatting was applied, and a repaint applies it with a
   * new result. A pass that cannot format writes nothing and emits nothing, so the
   * authored absolute text stays as the fallback.
   *
   * @stimeoRenderRoot
   */
  #render(): void {
    const date = this.#parse();
    if (date === null) return;

    const formatted = this.#applyFormat(date, this.dateStyleValue, this.timeStyleValue);
    if (formatted === null) return;

    // Only the visible text (and optional title) change; `datetime` is the
    // immutable machine-readable source and is never rewritten.
    this.element.textContent = formatted;

    const title = this.#title(date);
    if (title !== null) this.element.setAttribute("title", title);

    this.dispatch("format", { detail: { formatted } });
  }

  /**
   * Parses the UTC `datetime` attribute into a {@link Date}, or `null`. Whitespace
   * around the attribute value is tolerated.
   */
  #parse(): Date | null {
    const raw = this.element.getAttribute("datetime");
    if (!raw) return null;
    const ms = Date.parse(this.#asUtc(raw.trim()));
    return Number.isNaN(ms) ? null : new Date(ms);
  }

  /**
   * Reads a timezone-less date-time as UTC — the input contract of this
   * controller — since `Date.parse` would otherwise read `"2026-06-08T12:30:00"` in
   * the *runtime's* local zone, contradicting "the server emits UTC". Values that
   * already carry `Z` or a `±hh:mm` offset (and bare `YYYY-MM-DD` dates, already
   * parsed as UTC) are returned unchanged.
   *
   * HTML accepts a space where ISO 8601 wants `T`, and `Date.parse` of that form is
   * left to each engine, so a whole value shaped that way is normalized to the `T`
   * separator first. The pattern is anchored: a value trailing anything else — a
   * zone word such as `"2026-06-08 12:30:00 UTC"` — is handed to `Date.parse` as
   * authored instead of being turned into a string nothing can parse.
   */
  #asUtc(value: string): string {
    const isoLike = value.replace(
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)$/,
      "$1T$2",
    );
    const hasTime = /T\d{2}:\d{2}/.test(isoLike);
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(isoLike);
    return hasTime && !hasZone ? `${isoLike}Z` : isoLike;
  }

  /**
   * Builds the optional detailed `title`. `titleFormat` is an `Intl` style
   * keyword applied to *both* date and time; empty (the default) adds no title.
   */
  #title(date: Date): string | null {
    if (this.titleFormatValue.length === 0) return null;
    return this.#applyFormat(date, this.titleFormatValue, this.titleFormatValue);
  }

  /**
   * Formats `date` with `Intl.DateTimeFormat`, including each style only when it
   * is a valid keyword (so a consumer can show date-only or time-only by clearing
   * the other). Returns `null` when neither style is usable or `Intl` throws, so
   * the caller can leave the authored text untouched.
   */
  #applyFormat(date: Date, dateStyle: string, timeStyle: string): string | null {
    // `toStyle` yields `undefined` for an empty/invalid keyword; assigning it is
    // equivalent to omitting the option, so a consumer can show date- or time-only.
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: toStyle(dateStyle),
      timeStyle: toStyle(timeStyle),
    };
    if (options.dateStyle === undefined && options.timeStyle === undefined) return null;
    if (this.timeZoneValue.length > 0) options.timeZone = this.timeZoneValue;

    try {
      return new Intl.DateTimeFormat(this.#locale, options).format(date);
    } catch {
      // An invalid locale / timeZone (or unsupported style) must not break the
      // page; the authored absolute text remains as the graceful fallback.
      return null;
    }
  }

  /** Locale precedence: the value, then the nearest `lang` up the ancestor chain. */
  get #locale(): string | undefined {
    return this.localeValue || this.element.closest("[lang]")?.getAttribute("lang") || undefined;
  }
}
