import { Controller } from "@hotwired/stimulus";
import { SafeTimeout } from "../utils/safe_timeout";

/** Field controls this controller can persist. */
type PersistField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Input types that carry no meaningful, restorable value. */
const NON_VALUE_TYPES = new Set(["file", "submit", "reset", "button", "image"]);
/** localStorage key prefix so drafts never clobber unrelated app storage. */
const STORAGE_PREFIX = "stimeo--persist:";
/** Separator for disambiguating repeated same-name fields (cannot occur in a real field name). */
const OCCURRENCE_SEP = "\u0000";

/**
 * Headless draft-autosave behavior: persists a form's field values to
 * `localStorage` and restores them across Turbo navigations and reloads (no APG
 * pattern; a state-holding utility). The Alpine `persist` equivalent.
 *
 * Markup contract (identifier: `stimeo--persist`):
 *   <form data-controller="stimeo--persist"
 *         data-stimeo--persist-key-value="contact-draft">
 *     <input name="name">
 *     <textarea name="message"></textarea>
 *   </form>
 *
 * On connect it restores any saved values under `key` (falling back to the
 * element's `id`), then debounce-saves on every input/change. Password fields (and
 * anything in `exclude`) are never written. A `clear()` action — or the `clearOn`
 * event (e.g. `submit`) — drops the draft. Restoring never moves focus.
 *
 * @remarks
 * Behavior only. State lives entirely in `localStorage` (no module-scope state), so
 * instances never interfere. The input listener and debounce timer are removed on
 * `disconnect()` (Turbo navigation included), where a pending save is flushed first
 * so an in-flight edit is not lost.
 */
export class PersistController extends Controller<HTMLElement> {
  static override targets = ["field"];
  static override values = {
    key: { type: String, default: "" },
    debounce: { type: Number, default: 400 },
    exclude: { type: Array, default: ["password"] },
    clearOn: { type: String, default: "" },
  };
  static actions = ["clear"] as const;
  static events = ["restore", "save", "clear"] as const;

  declare readonly fieldTargets: PersistField[];
  declare readonly hasFieldTarget: boolean;

  declare keyValue: string;
  declare debounceValue: number;
  declare excludeValue: string[];
  declare clearOnValue: string;

  readonly #timeouts = new SafeTimeout();
  #saveId: number | null = null;

  readonly #onInput = (): void => {
    this.#scheduleSave();
  };

  readonly #onClearEvent = (): void => {
    this.clear();
  };

  override connect(): void {
    if (this.#storageKey === null) return;
    this.#restore();
    this.element.addEventListener("input", this.#onInput);
    this.element.addEventListener("change", this.#onInput);
    if (this.clearOnValue.length > 0) {
      this.element.addEventListener(this.clearOnValue, this.#onClearEvent);
    }
  }

  override disconnect(): void {
    this.element.removeEventListener("input", this.#onInput);
    this.element.removeEventListener("change", this.#onInput);
    if (this.clearOnValue.length > 0) {
      this.element.removeEventListener(this.clearOnValue, this.#onClearEvent);
    }
    // Flush a pending save so an in-flight edit survives a Turbo navigation.
    if (this.#saveId !== null) {
      this.#timeouts.clear(this.#saveId);
      this.#saveId = null;
      this.#write();
    }
    this.#timeouts.clearAll();
  }

  /** Drops the saved draft and clears the restored marker. */
  clear(): void {
    const key = this.#storageKey;
    if (key === null) return;
    if (this.#saveId !== null) {
      this.#timeouts.clear(this.#saveId);
      this.#saveId = null;
    }
    this.#removeItem(key);
    this.element.removeAttribute("data-persist-restored");
    this.dispatch("clear", { detail: { key: this.#logicalKey } });
  }

  /** Schedules a debounced save. */
  #scheduleSave(): void {
    if (this.#saveId !== null) this.#timeouts.clear(this.#saveId);
    this.#saveId = this.#timeouts.set(() => {
      this.#saveId = null;
      this.#save();
    }, this.debounceValue);
  }

  /** Writes the current values and emits `save`. */
  #save(): void {
    this.#write();
    this.dispatch("save", { detail: { key: this.#logicalKey } });
  }

  /** Serializes persistable fields and stores them under the storage key. */
  #write(): void {
    const key = this.#storageKey;
    if (key === null) return;
    const data: Record<string, unknown> = {};
    for (const { field, key: fieldKey } of this.#fieldEntries()) {
      if (field instanceof HTMLInputElement && field.type === "checkbox") {
        data[fieldKey] = field.checked;
      } else if (field instanceof HTMLInputElement && field.type === "radio") {
        if (field.checked) data[fieldKey] = field.value;
      } else if (field instanceof HTMLSelectElement && field.multiple) {
        data[fieldKey] = Array.from(field.selectedOptions).map((o) => o.value);
      } else {
        data[fieldKey] = field.value;
      }
    }
    this.#setItem(key, JSON.stringify(data));
  }

  /** Applies any saved values to the fields, without moving focus. */
  #restore(): void {
    const key = this.#storageKey;
    if (key === null) return;
    const raw = this.#getItem(key);
    if (raw === null) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    let restoredAny = false;
    for (const { field, key: fieldKey } of this.#fieldEntries()) {
      if (!Object.hasOwn(data, fieldKey)) continue;
      this.#applyValue(field, data[fieldKey]);
      restoredAny = true;
    }
    if (restoredAny) {
      this.element.setAttribute("data-persist-restored", "true");
      this.dispatch("restore", { detail: { key: this.#logicalKey } });
    }
  }

  /** Sets a single field's value from a stored entry. */
  #applyValue(field: PersistField, value: unknown): void {
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      field.checked = Boolean(value);
    } else if (field instanceof HTMLInputElement && field.type === "radio") {
      field.checked = field.value === value;
    } else if (field instanceof HTMLSelectElement && field.multiple) {
      const selected = new Set(Array.isArray(value) ? value.map(String) : []);
      for (const option of Array.from(field.options)) {
        option.selected = selected.has(option.value);
      }
    } else {
      field.value = String(value);
    }
  }

  /**
   * Persistable fields paired with a stable storage key. Uniquely-named fields key
   * by their name (unchanged, backward-compatible). Repeated same-name fields
   * (e.g. a `tags[]` checkbox group or array text inputs) are disambiguated by
   * DOM-order occurrence — the first keeps its plain `name` (backward-
   * compatible), later ones get a NUL-separated index suffix — so each is stored and
   * restored individually instead of the last one clobbering the rest. Radios are
   * the exception: a group intentionally shares one key (one value per name).
   */
  #fieldEntries(): Array<{ field: PersistField; key: string }> {
    const entries: Array<{ field: PersistField; key: string }> = [];
    const occurrence = new Map<string, number>();
    for (const field of this.#fields()) {
      const name = this.#keyOf(field);
      if (name === null) continue;
      if (field instanceof HTMLInputElement && field.type === "radio") {
        entries.push({ field, key: name });
        continue;
      }
      const seen = occurrence.get(name) ?? 0;
      occurrence.set(name, seen + 1);
      entries.push({ field, key: seen === 0 ? name : `${name}${OCCURRENCE_SEP}${seen}` });
    }
    return entries;
  }

  /** The fields to persist: `field` targets, or the element's named controls. */
  #fields(): PersistField[] {
    const candidates = this.hasFieldTarget
      ? this.fieldTargets
      : Array.from(this.element.querySelectorAll<PersistField>("input, textarea, select"));
    return candidates.filter((field) => this.#persistable(field));
  }

  /** Whether a field carries a restorable, non-excluded value. */
  #persistable(field: PersistField): boolean {
    if (this.#keyOf(field) === null) return false;
    const type = field instanceof HTMLInputElement ? field.type : "";
    if (NON_VALUE_TYPES.has(type)) return false;
    if (this.excludeValue.includes(type)) return false;
    if (field.name.length > 0 && this.excludeValue.includes(field.name)) return false;
    return true;
  }

  /** A stable storage sub-key for a field (its name, else id). */
  #keyOf(field: PersistField): string | null {
    return field.name || field.id || null;
  }

  /** The logical key (key Value or element id), or null when neither is set. */
  get #logicalKey(): string | null {
    const key = this.keyValue || this.element.id;
    return key.length > 0 ? key : null;
  }

  /** The prefixed localStorage key, or null when persistence is disabled. */
  get #storageKey(): string | null {
    const logical = this.#logicalKey;
    return logical === null ? null : `${STORAGE_PREFIX}${logical}`;
  }

  #getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  #setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage full or unavailable (private mode): persistence is best-effort.
    }
  }

  #removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore: nothing to clear if storage is unavailable.
    }
  }
}
