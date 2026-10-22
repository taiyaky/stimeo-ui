import { Controller } from "@hotwired/stimulus";
import { readDatetime } from "../utils/datetime";
import { intlFormatter } from "../utils/intl_format";
import { resolveLocale } from "../utils/locale";
import { MorphRenderWatcher } from "../utils/morph_render_watcher";

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
 * locale/zone on connect. A `datetime` without a zone is read as UTC; an explicit
 * `Z` or numeric offset keeps its meaning. This is the *absolute* localization axis,
 * distinct from `stimeo--relative-time`'s "3 minutes ago".
 *
 * `format` dispatches `{ formatted }`.
 *
 * @remarks
 * Behavior only. The machine-readable `datetime` is left untouched, exactly as written,
 * so assistive tech and crawlers keep the canonical value while only the display
 * text — and an optional `title` — change. Formatting is a pure function of
 * `datetime` with no module-scope state or timers, so a Turbo Drive cache restore
 * re-runs `connect()` and stays consistent. A `datetime` that does not parse, and
 * a locale or time zone `Intl` rejects, leave the text already shown in place — the
 * authored text until the first format; any other failure surfaces rather than being
 * absorbed.
 *
 * Render inputs are followed at runtime: a morph that swaps a Value or the
 * `datetime` attribute on the live element — which keeps the element, so
 * `connect()` never runs again — repaints through one coalesced pass
 * (`MorphRenderWatcher`) rather than leaving a stale reading on screen.
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
  readonly #resync = new MorphRenderWatcher(() => {
    const datetimeChanged = this.#datetimeWatch.takeRecords().length > 0;
    const notify = this.#formatPending || datetimeChanged;
    this.#formatPending = false;
    this.#render(notify);
  });
  #formatPending = false;
  /**
   * Watches the one render input that is not a Value. Only `datetime` is filtered
   * in, so the text and `title` this controller writes cannot re-enter the pass.
   */
  readonly #datetimeWatch = new MutationObserver(() => {
    this.#formatPending = true;
    this.#resync.schedule();
  });

  override connect(): void {
    this.#resync.observe(this.element);
    this.#datetimeWatch.observe(this.element, { attributeFilter: ["datetime"] });
    this.#formatPending = false;
    this.#render();
  }

  override disconnect(): void {
    this.#resync.disconnect();
    this.#datetimeWatch.disconnect();
  }

  /** Repaints when application code (or a Turbo morph) changes `locale` at runtime. */
  localeValueChanged(): void {
    this.#formatPending = true;
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `timeZone` at runtime. */
  timeZoneValueChanged(): void {
    this.#formatPending = true;
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `dateStyle` at runtime. */
  dateStyleValueChanged(): void {
    this.#formatPending = true;
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `timeStyle` at runtime. */
  timeStyleValueChanged(): void {
    this.#formatPending = true;
    this.#resync.schedule();
  }

  /** Repaints when application code (or a Turbo morph) changes `titleFormat` at runtime. */
  titleFormatValueChanged(): void {
    this.#formatPending = true;
    this.#resync.schedule();
  }

  /**
   * Formats the instant in `datetime` against the current Values and writes it out.
   *
   * Formatting from a changed input reports `format`; restoring output alone is
   * silent. A pass that cannot format leaves the text already shown.
   *
   * @stimeoRenderRoot
   */
  #render(notify = true): void {
    const date = this.#parse();
    if (date === null) return;

    const formatted = this.#applyFormat(date, this.dateStyleValue, this.timeStyleValue);
    if (formatted === null) return;

    // Only the visible text (and optional title) change; `datetime` is the
    // immutable machine-readable source and is never rewritten.
    this.element.textContent = formatted;

    const title = this.#title(date);
    if (title !== null) this.element.setAttribute("title", title);

    if (notify) this.dispatch("format", { detail: { formatted } });
  }

  /**
   * Reads the `datetime` instant with the strict reader `stimeo--relative-time` also uses;
   * the attribute is never rewritten.
   */
  #parse(): Date | null {
    const instant = readDatetime(this.element);
    return instant === null ? null : new Date(instant);
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
   * the other). Returns `null` when neither style is usable or the declaration
   * names a locale or time zone `Intl` rejects, so the caller can leave the text
   * already shown untouched.
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

    // An invalid locale or timeZone must not break the page: the text already shown
    // stays as the graceful fallback. `date` is already known to be a real instant
    // (`#parse` rejects the rest), so formatting it cannot fail.
    const formatter = intlFormatter(
      Intl.DateTimeFormat,
      resolveLocale(this.element, this.localeValue),
      options,
    );
    return formatter === null ? null : formatter.format(date);
  }
}
