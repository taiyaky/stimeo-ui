import { setAttributeIfChanged } from "./attribute_write";

/** The original string and the last string written through one channel. */
export interface TextWrite {
  readonly original: string;
  readonly written: string;
}

/** Live evidence is tied to this instance and this exact element. */
export type TextEvidence =
  | { readonly source?: "dom" }
  | { readonly source: "live"; readonly allowOriginal?: boolean };

/**
 * Records plain text or an input's value as `[channel, original, written]` in
 * an identifier-derived attribute supplied by the caller. Ownership requires a
 * valid record and the same current string; text containing an element is never
 * owned. The caller decides when to acquire, clear, restore, or forget a slot.
 *
 * DOM evidence survives a clone. Live evidence only describes writes made by
 * this instance to that element, so it can preserve a caller's held semantic
 * state or repair a morph that omitted the record. Neither proves who last
 * wrote an identical string. An optional guard protects other authored state.
 */
export class OwnedText<T extends HTMLElement = HTMLElement> {
  readonly #attribute: string;
  readonly #channel: "text" | "value";
  readonly #guard: (element: T) => boolean;
  readonly #writes = new WeakMap<T, TextWrite>();

  constructor(
    attribute: string,
    channel: "text" | "value" = "text",
    guard: (element: T) => boolean = () => true,
  ) {
    this.#attribute = attribute;
    this.#channel = channel;
    this.#guard = guard;
  }

  /** Whether the slot carries a record, including an invalid one. */
  hasRecord(element: T): boolean {
    return element.hasAttribute(this.#attribute);
  }

  /** Reads validated DOM evidence, or explicitly requested instance evidence. */
  read(element: T, evidence: TextEvidence = {}): TextWrite | null {
    if (evidence.source === "live") return this.#writes.get(element) ?? null;
    const raw = element.getAttribute(this.#attribute);
    if (raw === null) return null;
    try {
      const record: unknown = JSON.parse(raw);
      if (
        !Array.isArray(record) ||
        record.length !== 3 ||
        record[0] !== this.#channel ||
        typeof record[1] !== "string" ||
        typeof record[2] !== "string"
      )
        return null;
      return { original: record[1], written: record[2] };
    } catch {
      return null;
    }
  }

  /** Checks the current string, the text structure, and the caller's guard. */
  owns(element: T, evidence: TextEvidence = {}): boolean {
    return this.#ownedRecord(element, evidence) !== null;
  }

  /** Returns the matching evidence after checking structure and the caller's guard. */
  #ownedRecord(element: T, evidence: TextEvidence): TextWrite | null {
    const record = this.read(element, evidence);
    if (record === null || !this.#guard(element)) return null;
    if (this.#channel === "text" && element.firstElementChild !== null) return null;
    const current = this.#current(element);
    return current === record.written ||
      (evidence.source === "live" && evidence.allowOriginal === true && current === record.original)
      ? record
      : null;
  }

  /** Acquires the slot, preserving the first original unless the caller supplies one. */
  write(element: T, written: string, original?: string, force = false): void {
    const current = this.#current(element);
    if (current === null) return;
    const before =
      original ?? this.#writes.get(element)?.original ?? this.read(element)?.original ?? current;
    if (force || current !== written) this.#put(element, written);
    this.remember(element, written, before);
  }

  /** Records a write whose property assignment, such as caret handling, the caller owns. */
  remember(element: T, written: string, original?: string): void {
    const current = this.#current(element);
    if (current === null) return;
    const before =
      original ?? this.#writes.get(element)?.original ?? this.read(element)?.original ?? current;
    this.#writes.set(element, { original: before, written });
    setAttributeIfChanged(
      element,
      this.#attribute,
      JSON.stringify([this.#channel, before, written]),
    );
  }

  /** Empties an owned slot and releases its evidence. */
  clear(element: T, evidence: TextEvidence = {}): boolean {
    if (!this.owns(element, evidence)) return false;
    if (this.#current(element) !== "") this.#put(element, "");
    this.forget(element);
    return true;
  }

  /** Restores an owned slot's original string and releases its evidence. */
  restore(element: T, evidence: TextEvidence = {}): boolean {
    const record = this.#ownedRecord(element, evidence);
    if (record === null) return false;
    if (this.#current(element) !== record.original) this.#put(element, record.original);
    this.forget(element);
    return true;
  }

  /** Drops evidence without changing the slot, including an invalid DOM record. */
  forget(element: T): void {
    setAttributeIfChanged(element, this.#attribute, null);
    this.#writes.delete(element);
  }

  /** Reads the property belonging to this channel. */
  #current(element: T): string | null {
    if (this.#channel === "text") return element.textContent ?? "";
    return element instanceof HTMLInputElement ? element.value : null;
  }

  /** Writes the property belonging to this channel. */
  #put(element: T, text: string): void {
    if (this.#channel === "text") element.textContent = text;
    else if (element instanceof HTMLInputElement) element.value = text;
  }
}
