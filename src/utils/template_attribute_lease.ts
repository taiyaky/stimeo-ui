import { AttributeLease, readAttributeLease } from "./attribute_lease";
import { setAttributeIfChanged } from "./attribute_write";

/** A template's intent, its expected attribute value and whether the author took over. */
type TemplateState = { source: string; expected: string | null; yielded: boolean };

/**
 * A template-derived base attribute that yields to later author edits.
 *
 * The attribute lease owns save-and-restore and the shared stack. This boundary owns
 * template intent: a different source starts a new lease, while an unchanged source
 * keeps a yielded value until explicitly removed and set again. The intent record
 * travels with a copied element; live intent also survives a morph dropping records.
 * A morph that drops the intent record and puts the original value back has lost
 * derived output rather than taken it over, so rendering continues; one that writes
 * a different value yields like an author edit. Releasing returns the original value
 * without forgetting a yield. Attribute values are compared as strings, so an author's
 * identical write cannot be distinguished.
 */
export class TemplateAttributeLease<T extends Element = Element> {
  readonly #lease: AttributeLease<T>;
  readonly #record: string;
  readonly #attribute: string;
  readonly #owner: string;
  readonly #states = new WeakMap<T, TemplateState>();

  /** Names the derived attribute and the controller owning its template. */
  constructor(attribute: string, owner: string) {
    this.#attribute = attribute;
    this.#owner = owner;
    this.#lease = new AttributeLease(attribute, owner, { base: true, preserveAuthor: true });
    this.#record = `data-${owner}-${attribute}-template`;
  }

  /** Renders a source's derived value; `null` suspends it and an empty source ends it. */
  render(element: T, source: string, value: string | null): void {
    let state = this.#read(element);
    if (!state && source.length === 0) {
      this.#lease.return(element);
      return;
    }
    if (!state || state.source !== source) {
      this.#lease.return(element);
      state = { source, expected: this.#view(element, null).original, yielded: false };
    }
    if (source.length === 0 || value === null) {
      this.#states.set(element, state);
      this.release(element);
      return;
    }
    if (!state.yielded && this.#continues(element, state)) {
      this.#lease.write(element, value);
      state.expected = value;
    } else {
      state.yielded = true;
      this.#lease.return(element);
    }
    this.#mark(element, state);
  }

  /** Returns the temporary attribute while retaining intent for a later connection. */
  release(element: T): void {
    const state = this.#read(element);
    if (state && !state.yielded) {
      state.yielded = !this.#continues(element, state);
      if (!state.yielded) state.expected = this.#view(element, null).original;
    }
    this.#lease.return(element);
    if (state) this.#mark(element, state);
  }

  /**
   * Whether the attribute is still this writer's: it shows the last write, or a morph
   * dropped the intent record and restored the original the hold keeps.
   */
  #continues(element: T, state: TemplateState): boolean {
    const view = this.#view(element, state.expected);
    return (
      view.allowed ||
      (!element.hasAttribute(this.#record) &&
        element.getAttribute(this.#attribute) === view.original)
    );
  }

  /** Reads the shared stack without making this writer the owner. */
  #view(element: T, expected: string | null) {
    return readAttributeLease(element, this.#attribute, this.#owner, this.#lease, expected);
  }

  /** Reads live intent first, or a strictly shaped intent record on a restored copy. */
  #read(element: T): TemplateState | undefined {
    const live = this.#states.get(element);
    if (live) return live;
    try {
      const parsed: unknown = JSON.parse(element.getAttribute(this.#record) ?? "null");
      if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
      const [source, expected, yielded] = parsed as unknown[];
      if (
        typeof source !== "string" ||
        (expected !== null && typeof expected !== "string") ||
        typeof yielded !== "boolean"
      )
        return undefined;
      return { source, expected, yielded };
    } catch {
      return undefined;
    }
  }

  /** Leaves the template intent beside the attribute lease's ownership record. */
  #mark(element: T, state: TemplateState): void {
    this.#states.set(element, state);
    setAttributeIfChanged(
      element,
      this.#record,
      JSON.stringify([state.source, state.expected, state.yielded]),
    );
  }
}
