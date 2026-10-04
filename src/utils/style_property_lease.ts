import { sharedRegistry } from "./shared_registry";

/** What a lease's record says: the authored declaration, the last write and the leases beneath. */
interface StylePropertyLeaseRecord {
  readonly originalValue: string;
  readonly originalPriority: string;
  readonly writtenValue: string | null;
  readonly writtenPriority: string;
  /** Whether it hands back what the lease right beneath it wrote last. */
  readonly linked: boolean;
  /** The records of the other owners' leases beneath it, nearest first. */
  readonly beneath: readonly string[];
}

/** One lease's hold on one element's property, in the stack every lease of it shares. */
interface StyleHold {
  /** The lease holding it; `null` for a hold read from a copy's record until its lease takes it. */
  lease: object | null;
  readonly record: string;
  writtenValue: string | null;
  writtenPriority: string;
  /** What it hands back with nothing beneath it: the author's declaration. */
  readonly originalValue: string;
  readonly originalPriority: string;
  /** Whether it hands back what the hold beneath it wrote last instead. */
  linked: boolean;
}

/** The holds on each element by property, and every lease's record name by property. */
interface StylePropertyLeaseRegistry {
  readonly stacks: WeakMap<HTMLElement, Map<string, StyleHold[]>>;
  readonly names: Map<string, Set<string>>;
}

/**
 * Temporarily controls one inline CSS property across a changing set of elements.
 *
 * Authored value and priority are restored only while the declaration still matches
 * the last leased write. A later consumer write therefore wins.
 *
 * **Every lease of a property shares one stack of holds per element**, whatever its owner
 * and whichever file of the package constructed it (the stacks are one per page): the holds
 * sit in the order their leases first wrote the element, each with the declaration it wrote
 * last. The element's declaration is the highest hold's that carries it, and the page's when
 * none does. A write reaches the element unless a hold above the writer carries the element's
 * declaration, so the top hold always shows its writes and the page's declaration gives way to
 * the next write of any hold. A return gives a declaration back only from the hold the
 * element's declaration is: the one the hold beneath it wrote last, or the author's once
 * nothing is beneath it; any other return only leaves the stack. Holds that wrote the same
 * declaration are told apart by the stack: the higher one keeps it. A first write over a top
 * hold whose declaration the page has replaced takes the element's declaration as the
 * author's. Two instances of one controller that write the same property on
 * `document.documentElement` stack the same way.
 *
 * **The stack travels with the element.** While a hold carries a declaration other than the
 * author's, lies on another hold or is covered by one, the element carries its owner's record
 * `data-<owner>-style-<property>-lease`: JSON of the author's value and priority, the value
 * and priority the hold wrote last (`null` for a removal), `false` where the hold hands back
 * the author's declaration rather than the latest one of the hold beneath it, and the records
 * of every hold beneath it, nearest first. Returning the last lease of an owner removes its
 * record. A copy of the element — a page Turbo restores from its cache — therefore carries the
 * stack, read back under the record names of the leases constructed so far and ordered by the
 * records each hold lists beneath it, and each lease takes the hold its owner's record
 * describes over in place. Complete records for distinct owners preserve their order across
 * a copy. Records describe owners, not instances: one owner holding the element more than
 * once leaves only its topmost hold's record, which the first of its leases to write or return
 * on the copy takes. Its lower holds and positions are absent; mutually listed owners cannot
 * express their full live order. A hold that showed the author's declaration alone carries
 * no record and is taken by its first write on the copy. Missing or unreadable records also
 * leave their holds unknown, so copying the DOM does not promise identical decisions for
 * every live stack. A new stack with no readable record takes the current declaration as the
 * author's; a morph can remove records while existing holds remain in memory until returned.
 *
 * The lease has no lifecycle of its own, so it never subscribes to document events.
 */
export class StylePropertyLease<T extends HTMLElement = HTMLElement> {
  /** The holds on each element, bottom first, and the record names; one per page. */
  static readonly #registry = sharedRegistry(
    "stimeo-ui.style-property-lease.registry.v1",
    (): StylePropertyLeaseRegistry => ({ stacks: new WeakMap(), names: new Map() }),
  );
  readonly #property: string;
  readonly #record: string;
  readonly #held = new Set<T>();

  /**
   * @param property - The CSS property whose temporary values this lease owns.
   * @param owner - Names the record on the element; the controller's identifier.
   */
  constructor(property: string, owner: string) {
    this.#property = property;
    this.#record = `data-${owner}-style-${property}-lease`;
    const names = StylePropertyLease.#registry.names;
    names.set(property, (names.get(property) ?? new Set<string>()).add(this.#record));
  }

  /** Writes or removes the leased declaration while preserving its authored value. */
  write(element: T, value: string | null, priority = ""): void {
    const stack = this.#stack(element);
    const hold = this.#take(stack) ?? this.#acquire(element, stack);
    this.#held.add(element);
    const shows = !this.#covered(element, stack, hold);
    hold.writtenValue = value;
    hold.writtenPriority = value === null ? "" : priority;
    this.#mark(element, stack);
    if (shows) this.#show(element, value, hold.writtenPriority);
  }

  /**
   * Returns one lease, also on a restored copy, to the declaration the hold beneath it wrote
   * last or the author's, without overwriting a declaration a consumer wrote since.
   */
  return(element: T): void {
    const held = this.#held.delete(element);
    const known = StylePropertyLease.#registry.stacks.get(element)?.has(this.#property);
    const stack = held || known || element.hasAttribute(this.#record) ? this.#stack(element) : [];
    const hold = this.#take(stack);
    if (!hold) return;
    const owns = this.#carries(element, hold) && !this.#covered(element, stack, hold);
    const index = stack.indexOf(hold);
    stack.splice(index, 1);
    const above = stack[index];
    if (above) above.linked &&= hold.linked;
    this.#mark(element, stack);
    if (!owns) return;
    const below = hold.linked ? stack[index - 1] : undefined;
    if (below) this.#show(element, below.writtenValue, below.writtenPriority);
    else this.#show(element, hold.originalValue, hold.originalPriority);
  }

  /** Returns every outstanding declaration lease. */
  returnAll(): void {
    for (const element of Array.from(this.#held)) this.return(element);
  }

  /** The record `name` on `element`, or `null` when it is none a lease could write. */
  #recorded(element: T, name: string): StylePropertyLeaseRecord | null {
    try {
      const parsed: unknown = JSON.parse(element.getAttribute(name) ?? "null");
      if (!Array.isArray(parsed)) return null;
      const [originalValue, originalPriority, writtenValue, writtenPriority, ...rest] =
        parsed as unknown[];
      if (typeof originalValue !== "string" || typeof originalPriority !== "string") return null;
      if (typeof writtenValue !== "string" && writtenValue !== null) return null;
      if (typeof writtenPriority !== "string") return null;
      const linked = rest[0] !== false;
      const beneath = linked ? rest : rest.slice(1);
      if (!beneath.every((under): under is string => typeof under === "string")) return null;
      return { originalValue, originalPriority, writtenValue, writtenPriority, linked, beneath };
    } catch {
      return null;
    }
  }

  /** The element's stack, read from its records the first time. */
  #stack(element: T): StyleHold[] {
    const stacks = StylePropertyLease.#registry.stacks;
    const byProperty = stacks.get(element) ?? new Map<string, StyleHold[]>();
    stacks.set(element, byProperty);
    const stack = byProperty.get(this.#property) ?? this.#seed(element);
    byProperty.set(this.#property, stack);
    return stack;
  }

  /** The holds a copy's records describe, each above every hold its record lists beneath. */
  #seed(element: T): StyleHold[] {
    const found: (StylePropertyLeaseRecord & { readonly record: string })[] = [];
    for (const record of StylePropertyLease.#registry.names.get(this.#property) ?? []) {
      const read = this.#recorded(element, record);
      if (read) found.push({ ...read, record });
    }
    const depth = ({ beneath }: (typeof found)[number]) =>
      beneath.filter((name) => found.some((other) => other.record === name)).length;
    return found
      .sort((one, other) => depth(one) - depth(other))
      .map((entry, index) => ({
        lease: null,
        record: entry.record,
        writtenValue: entry.writtenValue,
        writtenPriority: entry.writtenPriority,
        originalValue: entry.originalValue,
        originalPriority: entry.originalPriority,
        linked: entry.linked && index > 0,
      }));
  }

  /** Its hold in `stack`, taking over one read from its record. */
  #take(stack: StyleHold[]): StyleHold | undefined {
    const hold =
      stack.find((held) => held.lease === this) ??
      stack.find((held) => held.lease === null && held.record === this.#record);
    if (hold) hold.lease = this;
    return hold;
  }

  /** A new hold on top, over the top hold while the element carries its declaration. */
  #acquire(element: T, stack: StyleHold[]): StyleHold {
    const top = stack.at(-1);
    const over = top && this.#carries(element, top) ? top : undefined;
    const style = element.style;
    const hold: StyleHold = {
      lease: this,
      record: this.#record,
      writtenValue: null,
      writtenPriority: "",
      originalValue: over ? over.originalValue : style.getPropertyValue(this.#property),
      originalPriority: over ? over.originalPriority : style.getPropertyPriority(this.#property),
      linked: over !== undefined,
    };
    stack.push(hold);
    return hold;
  }

  /** Whether a hold above `hold` carries the element's declaration, then that hold's. */
  #covered(element: T, stack: readonly StyleHold[], hold: StyleHold): boolean {
    return stack.slice(stack.indexOf(hold) + 1).some((above) => this.#carries(element, above));
  }

  /** Leaves each owner's record of its topmost hold, or none where nothing needs one. */
  #mark(element: T, stack: readonly StyleHold[]): void {
    const records = new Map<string, string | null>([[this.#record, null]]);
    stack.forEach((hold, index) => {
      const names = stack.slice(0, index).map((under) => under.record);
      const beneath = [...new Set(names.reverse())].filter((name) => name !== hold.record);
      const marker = hold.linked || beneath.length === 0 ? [] : [false];
      const { originalValue, originalPriority, writtenValue, writtenPriority } = hold;
      records.set(
        hold.record,
        (writtenValue ?? "") === originalValue &&
          writtenPriority === originalPriority &&
          beneath.length === 0 &&
          index === stack.length - 1
          ? null
          : JSON.stringify([
              originalValue,
              originalPriority,
              writtenValue,
              writtenPriority,
              ...marker,
              ...beneath,
            ]),
      );
    });
    for (const [name, recorded] of records) {
      if (element.getAttribute(name) === recorded) continue;
      if (recorded === null) element.removeAttribute(name);
      else element.setAttribute(name, recorded);
    }
  }

  /** Whether the element carries the declaration `hold` wrote last. */
  #carries(element: T, hold: StyleHold): boolean {
    return this.#holds(element, hold.writtenValue ?? "", hold.writtenPriority);
  }

  /** Whether the inline declaration is `value` with `priority`. */
  #holds(element: T, value: string, priority: string): boolean {
    const style = element.style;
    return (
      style.getPropertyValue(this.#property) === value &&
      style.getPropertyPriority(this.#property) === priority
    );
  }

  /** Writes the declaration, or removes it for `null`, unless the element already carries it. */
  #show(element: T, value: string | null, priority: string): void {
    if (this.#holds(element, value ?? "", priority)) return;
    if (value === null) element.style.removeProperty(this.#property);
    else element.style.setProperty(this.#property, value, priority);
  }
}
