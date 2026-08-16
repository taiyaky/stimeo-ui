/** One temporarily controlled style property and the authored declaration it displaced. */
interface StylePropertyLeaseRecord {
  readonly originalValue: string;
  readonly originalPriority: string;
  writtenValue: string | null;
  writtenPriority: string;
}

/**
 * Temporarily controls one inline CSS property across a changing set of elements.
 *
 * Authored value and priority are restored only while the declaration still matches
 * the last leased write. A later consumer write therefore wins.
 *
 * The lease has no lifecycle of its own, so it never subscribes to document events:
 * a consumer returns its leases from its own `turbo:before-cache` rewind.
 */
export class StylePropertyLease<T extends HTMLElement = HTMLElement> {
  readonly #property: string;
  readonly #records = new Map<T, StylePropertyLeaseRecord>();

  /** @param property - The CSS property whose temporary values this lease owns. */
  constructor(property: string) {
    this.#property = property;
  }

  /** Writes or removes the leased declaration while preserving its authored value. */
  write(element: T, value: string | null, priority = ""): void {
    const existing = this.#records.get(element);
    if (existing) {
      existing.writtenValue = value;
      existing.writtenPriority = value === null ? "" : priority;
    } else {
      this.#records.set(element, {
        originalValue: element.style.getPropertyValue(this.#property),
        originalPriority: element.style.getPropertyPriority(this.#property),
        writtenValue: value,
        writtenPriority: value === null ? "" : priority,
      });
    }

    this.#reflect(element, value, priority);
  }

  /** Returns one lease without overwriting a later consumer declaration. */
  return(element: T): void {
    const record = this.#records.get(element);
    if (!record) return;
    this.#records.delete(element);

    const style = element.style;
    const stillOwned =
      style.getPropertyValue(this.#property) === (record.writtenValue ?? "") &&
      style.getPropertyPriority(this.#property) === record.writtenPriority;
    if (stillOwned) {
      this.#reflect(element, record.originalValue, record.originalPriority);
    }
  }

  /** Returns every outstanding declaration lease. */
  returnAll(): void {
    for (const element of Array.from(this.#records.keys())) this.return(element);
  }

  /** Reflects only a real declaration transition. */
  #reflect(element: T, value: string | null, priority: string): void {
    const style = element.style;
    const nextValue = value ?? "";
    const nextPriority = value === null ? "" : priority;
    if (
      style.getPropertyValue(this.#property) === nextValue &&
      style.getPropertyPriority(this.#property) === nextPriority
    ) {
      return;
    }
    if (value === null) style.removeProperty(this.#property);
    else style.setProperty(this.#property, value, priority);
  }
}
