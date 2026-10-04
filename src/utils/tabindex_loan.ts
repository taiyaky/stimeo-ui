import { queryOpenDescendants } from "./query_open_descendants";
import { sharedRegistry } from "./shared_registry";

/** One loan's hold on one element's `tabindex`, in the stack every loan of it shares. */
interface LoanHold {
  /** The loan holding it; `null` for a loan read from a copy's record until a loan takes it. */
  loan: object | null;
  readonly record: string;
  readonly value: string;
  /** Whether it hands back the value of the hold beneath it; otherwise no `tabindex`. */
  linked: boolean;
}

/** The loans on each element, bottom first, and every loan's record name. */
interface TabindexLoanRegistry {
  readonly stacks: WeakMap<HTMLElement, LoanHold[]>;
  readonly names: Set<string>;
}

/**
 * Shared bookkeeping for a `tabindex` a controller lends an element temporarily.
 *
 * A controller that must move focus somewhere the author never made focusable
 * (a landmark root, a scroll destination) reaches for the same trick: add a
 * `tabindex` just-in-time and hand it back once it is no longer needed. The
 * borrow is the easy half; the return is what the two conditions below are for.
 *
 * **Returning needs two conditions, not one.** Owning the borrow is not enough:
 * the attribute must also still hold the value this instance wrote. A consumer
 * that changed it afterwards — `tabindex="0"` to make the root its own Tab stop
 * — owns it now, and removing it there silently discards authored markup. The
 * bookkeeping is dropped either way, since the loan is over regardless of who
 * ends up owning the value.
 *
 * **Never borrow over a value no loan holds.** An element whose `tabindex` no loan
 * holds — the author's, or one the page wrote over the loans — is the author's to
 * control, so there is nothing to lend and nothing to return.
 *
 * **Every loan of an element shares one stack of loans**, whatever its owner and
 * whichever file of the package constructed it (the stacks are one per page). A loan
 * lends over the loans that hold the element while its `tabindex` is theirs — sharing
 * their value, or covering it with its own — and lends again where the page removed
 * the `tabindex`. The `tabindex` is the highest loan's that lends its value: returning
 * that loan gives the element the value of the loan beneath it, or no `tabindex`, and
 * any other return only leaves the stack. So two loans of one value — every focus trap
 * lends its container under one owner — keep it until the last of them returns, and a
 * loan lent after the page removed an earlier one's `tabindex` keeps it when the
 * earlier one returns.
 *
 * **A loan is recorded on the element.** Lending writes
 * `data-<owner>-tabindex-loan` holding the value the owner's topmost loan lends next
 * to the `tabindex`, and the owner's last loan to end removes it. A copy of the
 * element — a page Turbo restores from its cache is one — so tells its owners' loans
 * from an authored `tabindex`: `lend()` takes over a loan its owner recorded, and
 * `reclaim()` gives back one no loan has taken over; the `tabindex` goes with the last
 * of them. A copy keeps no order of its loans beyond putting those of the value it
 * carries on top. Without a record a `tabindex` is the author's. Nothing returns a
 * live loan before Turbo caches the page: `turbo:before-cache` also fires on pages
 * that stay, and the loan is still in use there.
 *
 * The registry is keyed by element, so a controller borrowing on a single
 * element (`this.element`) and one borrowing across a changing set of targets
 * use the same API — the single-element case is a set of one. It holds no
 * opinion about *when* to borrow or where focus goes next; that stays in the
 * controller.
 *
 * **The API is deliberately small.** Each consumer entry includes its own copy
 * of the class, so unused methods still increase its runtime output.
 *
 * @example
 * ```ts
 * readonly #tabindex = new TabindexLoan("-1", this.identifier);
 *
 * connect() {
 *   this.#tabindex.reclaim(this.element);
 * }
 *
 * #rescueFocus() {
 *   this.#tabindex.lend(this.element);
 *   this.element.focus();
 * }
 *
 * disconnect() {
 *   this.#tabindex.returnAll();
 * }
 * ```
 */
export class TabindexLoan<T extends HTMLElement = HTMLElement> {
  /** The loans on each element and the record names, one per page. */
  static readonly #registry = sharedRegistry(
    "stimeo-ui.tabindex-loan.registry.v1",
    (): TabindexLoanRegistry => ({ stacks: new WeakMap(), names: new Set() }),
  );
  readonly #value: string;
  readonly #record: string;
  readonly #lent = new Set<T>();

  /**
   * @param value - the `tabindex` to lend. `"-1"` is programmatically focusable but
   *   not a Tab stop; `"0"` is a real Tab stop, which a scroll region with no
   *   focusable content of its own needs.
   * @param owner - Names the record on the element; the controller's identifier.
   */
  constructor(value: string, owner: string) {
    this.#value = value;
    this.#record = `data-${owner}-tabindex-loan`;
    TabindexLoan.#registry.names.add(this.#record);
  }

  /**
   * Lends `element` the value over the loans holding its `tabindex`, or where the page removed
   * it; a `tabindex` no loan holds is left alone, and a loan recorded on a copy taken over.
   */
  lend(element: T): void {
    const stack = this.#stack(element);
    const current = element.getAttribute("tabindex");
    const held =
      stack.find((hold) => hold.loan === this) ??
      stack.find(
        (hold) => hold.loan === null && hold.record === this.#record && hold.value === this.#value,
      );
    const linked = stack.at(-1)?.value === current;
    if (!held && current !== null && !linked) return;
    this.#lent.add(element);
    if (held) held.loan = this;
    else stack.push({ loan: this, record: this.#record, value: this.#value, linked });
    this.#mark(element, stack);
    if (current === null || (!held && current !== this.#value)) {
      element.setAttribute("tabindex", this.#value);
    }
  }

  /** Takes back every loan; one whose value the element shows hands it to the loan beneath. */
  returnAll(): void {
    for (const element of this.#lent) {
      const stack = this.#stack(element);
      const hold = stack.find((held) => held.loan === this);
      if (hold) this.#release(element, stack, hold);
    }
    this.#lent.clear();
  }

  /**
   * Gives back a loan its owner recorded on a restored copy that no loan has taken over, unless
   * the record holds another value or the element holds focus.
   */
  reclaim(element: HTMLElement): void {
    if (element.getAttribute(this.#record) !== this.#value) return;
    const stack = this.#stack(element);
    const hold = stack.find((held) => held.loan === null && held.record === this.#record);
    if (hold && !element.matches(":focus")) this.#release(element, stack, hold);
  }

  /** Gives back, as {@link reclaim} does, every loan of its owner recorded inside `root`. */
  reclaimWithin(root: ParentNode): void {
    for (const element of queryOpenDescendants<HTMLElement>(root, `[${this.#record}]`)) {
      this.reclaim(element);
    }
  }

  /** The element's loans, read from its records the first time. */
  #stack(element: HTMLElement): LoanHold[] {
    const stacks = TabindexLoan.#registry.stacks;
    const stack = stacks.get(element) ?? this.#seed(element);
    stacks.set(element, stack);
    return stack;
  }

  /** The loans a copy's records describe, those of the value it carries on top. */
  #seed(element: HTMLElement): LoanHold[] {
    const current = element.getAttribute("tabindex");
    const holds: LoanHold[] = [];
    for (const record of TabindexLoan.#registry.names) {
      const value = element.getAttribute(record);
      if (value !== null) holds.push({ loan: null, record, value, linked: true });
    }
    holds.sort((one, other) => Number(one.value === current) - Number(other.value === current));
    for (const [index, hold] of holds.entries()) hold.linked = index > 0;
    return holds;
  }

  /** Takes `hold` off, handing the value it shows to the loan beneath. */
  #release(element: HTMLElement, stack: LoanHold[], hold: LoanHold): void {
    const current = element.getAttribute("tabindex");
    const index = stack.indexOf(hold);
    const owns =
      current === hold.value && !stack.slice(index + 1).some((above) => above.value === current);
    stack.splice(index, 1);
    const above = stack[index];
    if (above) above.linked &&= hold.linked;
    this.#mark(element, stack);
    if (!owns) return;
    const below = hold.linked ? stack[index - 1] : undefined;
    if (!below) element.removeAttribute("tabindex");
    else if (below.value !== current) element.setAttribute("tabindex", below.value);
  }

  /** Leaves each owner's record of the value its topmost loan lends. */
  #mark(element: HTMLElement, stack: readonly LoanHold[]): void {
    const records = new Map<string, string | null>([[this.#record, null]]);
    for (const hold of stack) records.set(hold.record, hold.value);
    for (const [name, recorded] of records) {
      if (element.getAttribute(name) === recorded) continue;
      if (recorded === null) element.removeAttribute(name);
      else element.setAttribute(name, recorded);
    }
  }
}
