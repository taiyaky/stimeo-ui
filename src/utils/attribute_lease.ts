/** One temporarily controlled attribute value and the authored value it displaced. */
interface AttributeLeaseRecord {
  readonly original: string | null;
  written: string | null;
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
 */
export class AttributeLease<T extends Element = Element> {
  readonly #attribute: string;
  readonly #records = new Map<T, AttributeLeaseRecord>();

  /** @param attribute - The attribute whose temporary values this lease owns. */
  constructor(attribute: string) {
    this.#attribute = attribute;
  }

  /** Writes or removes the leased attribute while preserving its authored value. */
  write(element: T, value: string | null): void {
    const existing = this.#records.get(element);
    if (existing) {
      existing.written = value;
    } else {
      this.#records.set(element, {
        original: element.getAttribute(this.#attribute),
        written: value,
      });
    }

    if (value === null) element.removeAttribute(this.#attribute);
    else element.setAttribute(this.#attribute, value);
  }

  /** Returns one lease without overwriting a value subsequently authored by a consumer. */
  return(element: T): void {
    const record = this.#records.get(element);
    if (!record) return;
    this.#records.delete(element);
    if (element.getAttribute(this.#attribute) !== record.written) return;

    if (record.original === null) element.removeAttribute(this.#attribute);
    else element.setAttribute(this.#attribute, record.original);
  }

  /** Returns every outstanding lease using the same ownership check as {@link return}. */
  returnAll(): void {
    for (const element of Array.from(this.#records.keys())) this.return(element);
  }
}
