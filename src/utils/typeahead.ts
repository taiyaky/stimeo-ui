/**
 * Shared type-ahead (first-letter navigation) primitive for composite widgets.
 *
 * The APG asks list-like widgets to move focus by typed characters: one
 * character jumps to the next item starting with it, and several characters
 * typed in quick succession narrow the match to that prefix. Getting that right
 * needs three pieces of bookkeeping — accumulating the query, dropping it after
 * an idle window, and resolving the label each candidate is matched against —
 * and single-sourcing them here keeps every widget on the same rules instead of
 * letting them drift apart.
 *
 * The helpers here own *only* that mechanical part. They are deliberately
 * **policy-free** in the same sense as `RovingTabindex`: which elements are
 * candidates, where the search starts, and what happens on a match (real DOM
 * focus, a roving tab stop, or a virtual `aria-activedescendant`) differ per APG
 * pattern, so each controller keeps those decisions and calls
 * {@link findTypeaheadMatch} with a candidate list it assembled itself.
 *
 * Three decisions are worth stating up front:
 *
 * - **A repeated character collapses the stored query**, rather than deriving a
 *   shorter one at search time. That is what lets a follow-up character resume
 *   narrowing: `s`, `s`, `e` searches `"se"`, not the dead `"sse"` that no label
 *   can match. Growing the query instead leaves the widget frozen on exactly
 *   that sequence, which is why the choice is made here and not per widget.
 * - **`aria-label` wins over text**, so type-ahead matches what a screen reader
 *   announces — but only when it contributes a name. A blank (empty or
 *   whitespace-only) one is skipped, because accname skips it too: honoring it
 *   would leave an element that AT announces by its text unreachable by that
 *   text. This mirrors the accessible-name computation rather than the raw text.
 * - **`Space` and composition input are never type-ahead.** `Space` natively
 *   activates a `<button>`-based item, and characters still being composed are
 *   not a committed query.
 *
 * This file's own doc block is dropped from `dist`, but every member comment is
 * inlined into each consumer entry (`tsup` builds with `splitting: false`), so
 * rationale belongs here and contracts belong on the members.
 */

import { SafeTimeout } from "./safe_timeout";

/** Idle window after which an accumulated query is dropped, in milliseconds. */
export const TYPEAHEAD_RESET_MS = 500;

/** Construction options for {@link Typeahead}. */
export interface TypeaheadOptions {
  /** Idle window before the query resets. Defaults to {@link TYPEAHEAD_RESET_MS}. */
  resetMs?: number;
}

/**
 * Accumulates typed characters into a search query and drops it when idle.
 *
 * @remarks
 * Owns a {@link SafeTimeout} of its own, so a consumer's `#timers.clearAll()` does
 * **not** reach the pending reset — call {@link Typeahead.reset} from `disconnect()`.
 */
export class Typeahead {
  /** Timer registry for the pending idle reset; private so `reset()` is the only exit. */
  readonly #timers = new SafeTimeout();
  /** Idle window before the query resets, in milliseconds. */
  readonly #resetMs: number;
  /** The accumulated lowercase query, empty when idle. */
  #query = "";
  /** Id of the pending reset timer, `0` when none is scheduled. */
  #timerId = 0;

  /** @param options - Overrides for the idle window. */
  constructor({ resetMs = TYPEAHEAD_RESET_MS }: TypeaheadOptions = {}) {
    this.#resetMs = resetMs;
  }

  /** The query a search would currently run with; empty while idle. */
  get query(): string {
    return this.#query;
  }

  /**
   * Folds `key` into the query, restarts the idle window, and returns the query to
   * search with. A repeated character collapses the query to that one character.
   */
  push(key: string): string {
    const char = key.toLowerCase();
    const repeated = this.#query.length > 0 && [...this.#query].every((c) => c === char);
    this.#query = repeated ? char : this.#query + char;
    this.#timers.clear(this.#timerId);
    this.#timerId = this.#timers.set(() => this.reset(), this.#resetMs);
    return this.#query;
  }

  /** Clears the query and cancels the pending idle reset. */
  reset(): void {
    this.#query = "";
    this.#timers.clear(this.#timerId);
    this.#timerId = 0;
  }
}

/** Whether `event` is a bare printable character usable for type-ahead. */
export function isTypeaheadKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    event.key !== " " &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.isComposing
  );
}

/**
 * The name `element` is matched under, normalized for comparison.
 *
 * @param fallbackText - Produces the name when `aria-label` contributes none.
 *   Defaults to the element's `textContent`; pass a narrower source when part of
 *   the subtree is not part of the name (a tree item's nested child group, say).
 *   Called lazily, so an `aria-label` costs no subtree walk.
 */
export function typeaheadLabel(element: HTMLElement, fallbackText?: () => string): string {
  // Blank means absent, matching accname: a whitespace-only `aria-label` is
  // skipped there too, so honoring it here would make an element that a screen
  // reader announces by its text unreachable by that text.
  const label = element.getAttribute("aria-label")?.trim();
  if (label) return label.toLowerCase();
  const text = fallbackText ? fallbackText() : (element.textContent ?? "");
  return text.trim().toLowerCase();
}

/**
 * Index of the first item after `from` whose label starts with `query`, wrapping
 * and evaluating `from` itself last, or `-1` when nothing matches.
 *
 * @param items - Candidates in navigation order, already filtered by the caller.
 * @param from - Index the search moves on from; `-1` starts at the first item. Any
 *   out-of-range value is folded back in, so `indexOf` results pass straight through.
 * @param query - Lowercase query, normally the return of {@link Typeahead.push}.
 * @param label - Resolves a candidate's name. Defaults to {@link typeaheadLabel}.
 */
export function findTypeaheadMatch(
  items: readonly HTMLElement[],
  from: number,
  query: string,
  label: (item: HTMLElement) => string = (item) => typeaheadLabel(item),
): number {
  // An empty query would prefix-match everything; an empty list never enters the
  // loop, so it needs no guard of its own.
  if (query === "") return -1;
  const count = items.length;
  for (let step = 1; step <= count; step += 1) {
    // Folded twice so a negative `from` still lands on a real slot: `%` keeps the
    // sign of its left operand, and a negative index would read `undefined`.
    const index = (((from + step) % count) + count) % count;
    const candidate = items[index];
    if (candidate && label(candidate).startsWith(query)) return index;
  }
  return -1;
}
