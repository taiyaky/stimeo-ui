import { readNumber } from "./coerce";
import { matchesNumberBounds, type NumberBounds } from "./number_bounds";

/** The instance identity carried by a Number Value read. */
export interface NumberValueOwner {
  readonly identifier: string;
  readonly element: Element;
}

/** Reads current declarations at the point of use without rewriting their attributes. */
export class NumberValueReader {
  /** The last rejected literal per Value; no history grows for an unchanged instance. */
  readonly #lastRejected = new Map<string, string>();

  /** Resolves the declared number using its own fallback and shared class contract. */
  read(
    owner: NumberValueOwner,
    name: string,
    raw: number,
    fallback: number,
    bounds: NumberBounds,
  ): number {
    const resolved = readNumber(raw, fallback, bounds);
    if (matchesNumberBounds(raw, bounds)) {
      this.#lastRejected.delete(name);
      return resolved;
    }
    const attribute = `data-${owner.identifier}-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-value`;
    const literal = owner.element.getAttribute(attribute);
    if (literal === null) {
      this.#lastRejected.delete(name);
      return resolved;
    }
    if (this.#lastRejected.get(name) !== literal) {
      this.#lastRejected.set(name, literal);
      console.warn(
        `Stimeo UI: "${owner.identifier}" has an invalid number Value "${name}" declaration ${JSON.stringify(literal)}; using ${fallback}.`,
      );
    }
    return resolved;
  }
}
