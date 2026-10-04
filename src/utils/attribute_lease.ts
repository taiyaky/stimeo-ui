import { sharedRegistry } from "./shared_registry";

/** What a lease's record says: the author's value, its last write, the leases beneath. */
interface AttributeLeaseRecord {
  readonly original: string | null;
  readonly written: string | null;
  /** Whether it hands back what the lease right beneath it wrote last. */
  readonly linked: boolean;
  /** The records of the other owners' leases beneath it, nearest first. */
  readonly beneath: readonly string[];
}

/** One lease's hold on one element's attribute, in the stack every lease of it shares. */
interface AttributeHold {
  /** The lease holding it; `null` for a hold read from a copy's record until its lease takes it. */
  lease: object | null;
  readonly record: string;
  written: string | null;
  /** What it hands back with nothing beneath it: the author's value. */
  readonly original: string | null;
  /** Whether it hands back what the hold beneath it wrote last instead. */
  linked: boolean;
}

/** The holds on each element by attribute, and every lease's record name by attribute. */
interface AttributeLeaseRegistry {
  readonly stacks: WeakMap<Element, Map<string, AttributeHold[]>>;
  readonly names: Map<string, Set<string>>;
}

/** Whether a parsed record entry is an attribute value: a string, or `null` for absence. */
function isAttributeValue(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Reads the record a lease left on `element`: the author's value, the value the lease wrote
 * last, whether it hands back the value beneath it (`false` before the names when it does not)
 * and the records beneath it. `undefined` when the record is missing or holds anything else.
 */
function readLeaseRecord(element: Element, record: string): AttributeLeaseRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(element.getAttribute(record) ?? "null");
    if (!Array.isArray(parsed)) return undefined;
    const [original, written, ...rest] = parsed as unknown[];
    const linked = rest[0] !== false;
    const beneath = linked ? rest : rest.slice(1);
    if (!beneath.every((under): under is string => typeof under === "string")) return undefined;
    return isAttributeValue(original) && isAttributeValue(written)
      ? { original, written, linked, beneath }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The value `element`'s author wrote for `attribute`, as the record a lease of any owner leaves
 * on the element carries it; `undefined` while no lease leaves one, as when nothing has moved
 * the attribute off the author's value. A field a reveal turned from `password` into `text`
 * still reads `"password"` here.
 */
export function leasedAuthorValue(element: Element, attribute: string): string | null | undefined {
  const suffix = `-${attribute}-lease`;
  for (const name of element.getAttributeNames()) {
    if (!name.startsWith("data-") || !name.endsWith(suffix)) continue;
    const record = readLeaseRecord(element, name);
    if (record) return record.original;
  }
  return undefined;
}

/**
 * Temporarily controls one attribute across a changing set of elements.
 *
 * The first write remembers the authored value, including the distinction between
 * an absent attribute and an authored empty string. Returning a lease restores that
 * value only while the attribute still matches the controller's last write. If a
 * consumer changed it in the meantime, the consumer owns the new value and teardown
 * leaves it alone.
 *
 * A `null` write deliberately removes the attribute while retaining the lease. This
 * is useful for derived ARIA whose valid absence is itself controller state, such as
 * an unbounded `aria-valuemin` or a blank spinbutton's `aria-valuenow`.
 *
 * **Every lease of an attribute shares one stack of holds per element**, whatever its owner
 * and whichever file of the package constructed it (the stacks are one per page): the holds
 * sit in the order their leases first wrote the element, each with the value it wrote last.
 * The element's value is the highest hold's that carries it, and the page's when none does.
 * A write reaches the element unless a hold above the writer carries the element's value: the
 * top hold always shows its writes, a hold beneath it shows nothing while a hold above keeps
 * its value on the element, and once the page has put a value there that no hold carries, the
 * next write of any hold replaces it. A return gives a value back only from the hold the
 * element's value is: the value the hold beneath it wrote last, or the author's once nothing
 * is beneath it; any other return only leaves the stack, and the page's value stays. Holds
 * that wrote the same value are told apart by the stack, never by the value: the higher one
 * keeps it. A first write over a top hold whose value the page has replaced takes the
 * element's value as the author's. Two instances of one controller on one element — an
 * element outside their scope — stack the same way.
 *
 * A **base lease** (`{ base: true }`) holds the element's own state rather than a value over
 * it — a form field's ARIA on its control is one — so its first write goes to the bottom of
 * the stack, beneath the leases of other owners already there: a temporary value another
 * owner leased stays shown and returns to the base lease's latest value.
 *
 * **The stack travels with the element.** While a hold shows a value other than the author's,
 * lies on another hold or is covered by one, the element carries its owner's record
 * `data-<owner>-<attribute>-lease`: JSON of the author's value and the value the hold wrote
 * last (each a string, or `null` for an absent attribute), `false` where the hold hands back
 * the author's value rather than the latest value of the hold beneath it, and the records of
 * every hold beneath it, nearest first. Returning the last lease of an owner removes its
 * record. A copy of the element — a page Turbo restores from its cache is one — therefore
 * carries the stack, and the first lease to touch the copy reads it back under the record
 * names of the leases constructed so far, which include every lease that wrote a record the
 * cache holds, and orders the holds by the records each one lists beneath it. Each lease takes
 * the hold its owner's record describes over in place. Complete records for distinct owners
 * preserve their order across a copy. The records describe holds by owner, not by instance:
 * one owner holding the element more than once leaves only its topmost hold's record, which
 * the first of its leases to write or return on the copy takes. Lower holds of that owner and
 * their positions are absent; mutually listed owners cannot express their full live order.
 * A hold that showed the author's value alone carries no record and is taken by its first
 * write on the copy. Missing or unreadable records also leave their holds unknown, so copying
 * the DOM does not promise identical decisions for every live stack. Without a record it can
 * read, a new stack takes the current value as the author's. A Turbo morph removes records
 * absent from the server HTML; existing holds remain in memory until their leases return.
 *
 * The lease has no lifecycle of its own, so it never subscribes to document events,
 * and nothing rewinds a live page before Turbo caches it: `turbo:before-cache` also
 * fires on pages that stay.
 */
export class AttributeLease<T extends Element = Element> {
  /** The holds on each element, bottom first, and the record names; one per page. */
  static readonly #registry = sharedRegistry(
    "stimeo-ui.attribute-lease.registry.v1",
    (): AttributeLeaseRegistry => ({ stacks: new WeakMap(), names: new Map() }),
  );
  readonly #attribute: string;
  readonly #record: string;
  readonly #base: boolean;
  readonly #held = new Set<T>();

  /**
   * @param attribute - The attribute whose temporary values this lease owns.
   * @param owner - Names the record on the element; the controller's identifier.
   * @param options - `base`: written beneath the other owners' leases.
   */
  constructor(attribute: string, owner: string, options: { readonly base?: boolean } = {}) {
    this.#attribute = attribute;
    this.#record = `data-${owner}-${attribute}-lease`;
    this.#base = options.base === true;
    const names = AttributeLease.#registry.names;
    names.set(attribute, (names.get(attribute) ?? new Set<string>()).add(this.#record));
  }

  /** Writes or removes the leased attribute while preserving its authored value. */
  write(element: T, value: string | null): void {
    const stack = this.#stack(element);
    const hold = this.#take(stack) ?? this.#acquire(element, stack);
    this.#held.add(element);
    const shows = !this.#covered(element, stack, hold);
    hold.written = value;
    this.#mark(element, stack);
    if (shows) this.#reflect(element, value);
  }

  /**
   * Returns one lease, also on a restored copy, to the value the hold beneath it wrote last or
   * the author's, without overwriting a value a consumer wrote since. Says whether there was a
   * lease to return: a hold this lease has, or the hold a copy's record describes while no live
   * lease of the owner has taken it — a copy of a page an earlier connection wrote carries one.
   */
  return(element: T): boolean {
    const held = this.#held.delete(element);
    const known = AttributeLease.#registry.stacks.get(element)?.has(this.#attribute);
    const stack = held || known || element.hasAttribute(this.#record) ? this.#stack(element) : [];
    const hold = this.#take(stack);
    if (!hold) return false;
    const carries = element.getAttribute(this.#attribute) === hold.written;
    const owns = carries && !this.#covered(element, stack, hold);
    const index = stack.indexOf(hold);
    stack.splice(index, 1);
    const above = stack[index];
    if (above) above.linked &&= hold.linked;
    this.#mark(element, stack);
    if (!owns) return true;
    const below = hold.linked ? stack[index - 1] : undefined;
    this.#reflect(element, below ? below.written : hold.original);
    return true;
  }

  /** Returns every lease it holds, with the same ownership check as {@link return}. */
  returnAll(): void {
    for (const element of Array.from(this.#held)) this.return(element);
  }

  /** The element's stack, read from its records the first time. */
  #stack(element: T): AttributeHold[] {
    const stacks = AttributeLease.#registry.stacks;
    const byAttribute = stacks.get(element) ?? new Map<string, AttributeHold[]>();
    stacks.set(element, byAttribute);
    const stack = byAttribute.get(this.#attribute) ?? this.#seed(element);
    byAttribute.set(this.#attribute, stack);
    return stack;
  }

  /** The holds a copy's records describe, each above every hold its record lists beneath. */
  #seed(element: T): AttributeHold[] {
    const found: (AttributeLeaseRecord & { readonly record: string })[] = [];
    for (const record of AttributeLease.#registry.names.get(this.#attribute) ?? []) {
      const read = readLeaseRecord(element, record);
      if (read) found.push({ ...read, record });
    }
    const depth = ({ beneath }: (typeof found)[number]) =>
      beneath.filter((name) => found.some((other) => other.record === name)).length;
    return found
      .sort((one, other) => depth(one) - depth(other))
      .map(({ record, written, original, linked }, index) => ({
        lease: null,
        record,
        written,
        original,
        linked: linked && index > 0,
      }));
  }

  /** Its hold in `stack`, taking over one read from its record. */
  #take(stack: AttributeHold[]): AttributeHold | undefined {
    const hold =
      stack.find((held) => held.lease === this) ??
      stack.find((held) => held.lease === null && held.record === this.#record);
    if (hold) hold.lease = this;
    return hold;
  }

  /** A new hold: on top, over the top hold while the element shows it; a base one at the bottom. */
  #acquire(element: T, stack: AttributeHold[]): AttributeHold {
    const current = element.getAttribute(this.#attribute);
    const top = stack.at(-1);
    const bottom = stack[0];
    const over = top?.written === current ? top : undefined;
    const from = this.#base ? bottom : over;
    const hold: AttributeHold = {
      lease: this,
      record: this.#record,
      written: current,
      original: from ? from.original : current,
      linked: !this.#base && over !== undefined,
    };
    if (this.#base && bottom) {
      bottom.linked = true;
      stack.unshift(hold);
    } else stack.push(hold);
    return hold;
  }

  /** Whether a hold above `hold` carries the element's value, which is then that hold's. */
  #covered(element: T, stack: readonly AttributeHold[], hold: AttributeHold): boolean {
    const current = element.getAttribute(this.#attribute);
    return stack.slice(stack.indexOf(hold) + 1).some((above) => above.written === current);
  }

  /** Leaves each owner's record of its topmost hold, or none where nothing needs one. */
  #mark(element: T, stack: readonly AttributeHold[]): void {
    const records = new Map<string, string | null>([[this.#record, null]]);
    stack.forEach((hold, index) => {
      const names = stack.slice(0, index).map((under) => under.record);
      const beneath = [...new Set(names.reverse())].filter((name) => name !== hold.record);
      const marker = hold.linked || beneath.length === 0 ? [] : [false];
      records.set(
        hold.record,
        hold.written === hold.original && beneath.length === 0 && index === stack.length - 1
          ? null
          : JSON.stringify([hold.original, hold.written, ...marker, ...beneath]),
      );
    });
    for (const [name, recorded] of records) {
      if (element.getAttribute(name) === recorded) continue;
      if (recorded === null) element.removeAttribute(name);
      else element.setAttribute(name, recorded);
    }
  }

  /** Reflects only a real value transition, avoiding self-triggered mutation work. */
  #reflect(element: T, value: string | null): void {
    if (element.getAttribute(this.#attribute) === value) return;
    if (value === null) element.removeAttribute(this.#attribute);
    else element.setAttribute(this.#attribute, value);
  }
}
