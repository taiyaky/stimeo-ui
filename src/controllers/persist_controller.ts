import { Controller } from "@hotwired/stimulus";
import { leasedAuthorValue } from "../utils/attribute_lease";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { readLocalStorage, removeLocalStorage, writeLocalStorage } from "../utils/safe_storage";
import { SafeTimeout } from "../utils/safe_timeout";
import { parseStringList } from "../utils/string_list";
import { TransientHooks } from "../utils/transient_hooks";

/** The hook a connection may find written by an earlier, now-gone one. */
const TRANSIENT = new TransientHooks({ attributes: ["data-persist-restored"] });

/** Field controls this controller can persist. */
type PersistField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Values that can be restored without coercing an untrusted storage payload. */
type PersistValue = string | boolean | string[];

/** One stable field entry in the versioned storage payload. */
interface PersistPayloadField {
  readonly key: string;
  readonly value: PersistValue;
}

/** Versioned draft payload stored under one controller namespace. */
interface PersistPayload {
  readonly version: 1;
  readonly fields: PersistPayloadField[];
}

type PersistOperation = "read" | "write" | "remove";
type PersistErrorReason = "unavailable" | "invalid-payload";

/** One scheduled write, including the namespace it was created for. */
interface PendingSave {
  readonly id: number;
  readonly logicalKey: string;
}

/** Input types that carry no meaningful, restorable value. */
const NON_VALUE_TYPES = new Set(["file", "submit", "reset", "button", "image"]);
/** Passwords are never persisted, even when a custom exclusion list is supplied. */
const SENSITIVE_TYPES = new Set(["password"]);
/** Field types and names skipped by the default configuration. */
const DEFAULT_EXCLUDE = ["authenticity_token", "_method", "utf8"];
/** localStorage key prefix so drafts never clobber unrelated app storage. */
const STORAGE_PREFIX = "stimeo--persist:";
/** Separator for disambiguating repeated same-name fields. */
const OCCURRENCE_SEP = "\u0000";
/** The one observed attribute that can move fields between nested Persist hosts. */
const OWNERSHIP_ATTRIBUTE = "data-controller";
const DEFAULT_DEBOUNCE = 400;

/** Whether a parsed JSON value is a plain object-like record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a parsed JSON value belongs to the persisted field-value union. */
const isPersistValue = (value: unknown): value is PersistValue =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

/** Parses and validates the complete versioned payload without type assertions. */
const parsePayload = (raw: string): PersistPayload | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.fields)) return null;

  const fields: PersistPayloadField[] = [];
  const keys = new Set<string>();
  for (const candidate of parsed.fields) {
    if (!isRecord(candidate)) return null;
    const { key, value } = candidate;
    if (typeof key !== "string" || key.length === 0 || keys.has(key)) return null;
    if (!isPersistValue(value)) return null;
    keys.add(key);
    fields.push({ key, value });
  }
  return { version: 1, fields };
};

/** Whether a node is one of the native controls supported by Persist. */
const isPersistField = (node: unknown): node is PersistField =>
  node instanceof HTMLInputElement ||
  node instanceof HTMLTextAreaElement ||
  node instanceof HTMLSelectElement;

/**
 * Headless draft-autosave behavior: persists form controls to `localStorage`
 * and restores them across Turbo navigation and reloads.
 *
 * Markup contract (identifier: `stimeo--persist`):
 *   <form data-controller="stimeo--persist"
 *         data-stimeo--persist-key-value="contact-draft">
 *     <input name="name">
 *     <textarea name="message"></textarea>
 *   </form>
 *
 * The optional `field` targets restrict persistence to explicitly targeted
 * controls. The public `clear` action removes the active draft. `key`,
 * `exclude`, and `clearOn` Values can change while connected; `clearOn` is an
 * event name whose occurrence invokes `clear`. `debounce` is read as each edit
 * schedules its save: a pending save keeps the deadline its edit gave it, and
 * the next edit takes the new value.
 *
 * `restore`, `save`, and `clear` dispatch `{ key: string }`. `error` dispatches
 * `{ key: string, operation: "read" | "write" | "remove", reason:
 * "unavailable" | "invalid-payload" }`. Restore writes are intentionally
 * silent native-control mutations; consumers synchronize from the bubbling
 * `restore` event without treating a restored draft as user input.
 *
 * @remarks
 * Behavior only — restoration never moves focus. Passwords are never stored;
 * the default exclusion also omits Rails request metadata while preserving
 * application-owned hidden fields. Distinct logical keys isolate instances;
 * instances using the same key intentionally share one last-writer-wins draft.
 * Every listener, timer, observer, and queued reconciliation is released on
 * `disconnect()`, after any pending edit is flushed through the normal save
 * path. A reconnect removes stale restored state before reading storage.
 */
export class PersistController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  static override targets = ["field"];
  static override values = {
    key: { type: String, default: "" },
    debounce: { type: Number, default: DEFAULT_DEBOUNCE },
    // A malformed JSON list must fall back without aborting Stimulus connection.
    exclude: { type: String, default: "" },
    clearOn: { type: String, default: "" },
  };

  static valueConstraints = {
    debounce: NUMBER_BOUNDS.timer,
  } satisfies NumberValueConstraints<typeof PersistController.values>;
  static actions = ["clear"] as const;
  static events = ["restore", "save", "clear", "error"] as const;

  declare readonly fieldTargets: Element[];
  declare readonly hasFieldTarget: boolean;

  declare keyValue: string;
  declare debounceValue: number;
  declare excludeValue: string;
  declare clearOnValue: string;

  readonly #timeouts = new SafeTimeout();
  readonly #restoreDynamic = new MicrotaskCoalescer(() => this.#restoreDynamicFields());
  readonly #observer = new MutationObserver((records) => this.#onMutations(records));
  #pendingSave: PendingSave | null = null;
  #connected = false;
  #logicalKey: string | null = null;
  #payload: PersistPayload | null = null;
  #registeredClearOn: string | null = null;
  #excluded: readonly string[] = DEFAULT_EXCLUDE;
  #knownFields = new WeakSet<PersistField>();
  #forcedRestore = new Set<PersistField>();

  readonly #onInput = (event: Event): void => {
    const field = event.target;
    if (!isPersistField(field) || !this.#ownsField(field)) return;
    if (this.hasFieldTarget && !this.fieldTargets.includes(field)) return;
    if (this.#keyOf(field) === null || !this.#persistable(field, this.#excluded)) return;
    this.#scheduleSave();
  };

  readonly #onClearEvent = (): void => {
    this.clear();
  };

  override connect(): void {
    if (this.#connected) return;
    this.#connected = true;
    this.#logicalKey = this.#resolveLogicalKey();
    this.#excluded = parseStringList(this.excludeValue, DEFAULT_EXCLUDE);

    this.element.addEventListener("input", this.#onInput);
    this.element.addEventListener("change", this.#onInput);
    this.#syncClearOn();
    this.#restoreDynamic.activate();
    this.#observer.observe(this.element, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        "checked",
        "data-controller",
        `data-${this.identifier}-target`,
        "id",
        "multiple",
        "name",
        "selected",
        "type",
        "value",
      ],
      childList: true,
      subtree: true,
    });
    this.#loadActiveDraft();
  }

  override disconnect(): void {
    this.#flushPendingSave();
    this.#connected = false;
    this.element.removeEventListener("input", this.#onInput);
    this.element.removeEventListener("change", this.#onInput);
    this.#unbindClearOn();
    this.#observer.disconnect();
    this.#restoreDynamic.cancel();
    TRANSIENT.reset(this.element);
    this.#payload = null;
  }

  /** Drops the active draft after storage confirms the removal. */
  clear(): void {
    const logicalKey = this.#logicalKey ?? this.#resolveLogicalKey();
    if (logicalKey === null) return;
    this.#cancelPendingSave();
    const result = removeLocalStorage(this.#storageKey(logicalKey));
    if (!result.ok) {
      this.#dispatchError(logicalKey, "remove", "unavailable");
      return;
    }
    this.#payload = null;
    this.element.removeAttribute("data-persist-restored");
    this.dispatch("clear", { detail: { key: logicalKey } });
  }

  /** Rebinds the external clear event when its Value changes. */
  clearOnValueChanged(): void {
    if (this.#connected) this.#syncClearOn();
  }

  /** Switches storage namespaces without writing old edits under the new key. */
  keyValueChanged(): void {
    if (this.#connected) this.#switchLogicalKey();
  }

  /** Restores every field the new exclusion list makes eligible. */
  excludeValueChanged(): void {
    const previous = this.#excluded;
    this.#excluded = parseStringList(this.excludeValue, DEFAULT_EXCLUDE);
    if (!this.#connected) return;
    // A field restored once stays in #knownFields, so releasing it from the exclusion
    // list has to name it explicitly to reach the next batch. Fields the list never
    // covered keep their live value, which is what the next batch already guarantees.
    for (const field of this.#candidateFields()) {
      if (this.#persistable(field, this.#excluded) && !this.#persistable(field, previous)) {
        this.#forcedRestore.add(field);
      }
    }
    this.#restoreDynamic.schedule();
  }

  /**
   * Schedules a debounced save on the current `debounce`, replacing a pending one.
   * The save keeps this deadline when `debounce` changes later.
   */
  #scheduleSave(): void {
    const logicalKey = this.#logicalKey;
    if (logicalKey === null) return;
    this.#cancelPendingSave();
    const id = this.#timeouts.set(() => {
      this.#pendingSave = null;
      this.#save(logicalKey);
    }, this.#debounceDelay);
    this.#pendingSave = { id, logicalKey };
  }

  /** Cancels the currently pending save, if any. */
  #cancelPendingSave(): void {
    const pending = this.#pendingSave;
    if (pending === null) return;
    this.#timeouts.clear(pending.id);
    this.#pendingSave = null;
  }

  /**
   * Flushes a pending edit through the same success/error event path as a timer. The
   * flush is the last write of the namespace the edit was scheduled for, so a save that
   * a `save` or `error` listener schedules while it runs is dropped with it: that save
   * would write whatever the fields hold once the namespace has switched or the
   * controller has disconnected.
   */
  #flushPendingSave(): void {
    const pending = this.#pendingSave;
    if (pending === null) return;
    this.#cancelPendingSave();
    this.#save(pending.logicalKey);
    this.#cancelPendingSave();
  }

  /** Writes the active payload and emits `save` only after storage succeeds. */
  #save(logicalKey: string): boolean {
    const payload = this.#serialize();
    const result = writeLocalStorage(this.#storageKey(logicalKey), JSON.stringify(payload));
    if (!result.ok) {
      this.#dispatchError(logicalKey, "write", "unavailable");
      return false;
    }
    this.#payload = payload;
    this.dispatch("save", { detail: { key: logicalKey } });
    return true;
  }

  /** Serializes every persistable field into a versioned, typed payload. */
  #serialize(): PersistPayload {
    const fields: PersistPayloadField[] = [];
    for (const { field, key } of this.#fieldEntries()) {
      if (field instanceof HTMLInputElement && field.type === "checkbox") {
        fields.push({ key, value: field.checked });
      } else if (field instanceof HTMLInputElement && field.type === "radio") {
        if (field.checked) fields.push({ key, value: field.value });
      } else if (field instanceof HTMLSelectElement && field.multiple) {
        fields.push({
          key,
          value: Array.from(field.selectedOptions).map((option) => option.value),
        });
      } else {
        fields.push({ key, value: field.value });
      }
    }
    return { version: 1, fields };
  }

  /** Reads, validates, and restores the active namespace. */
  #loadActiveDraft(): void {
    TRANSIENT.reset(this.element);
    this.#payload = null;
    this.#knownFields = new WeakSet<PersistField>();
    this.#forcedRestore.clear();
    const logicalKey = this.#logicalKey;
    if (logicalKey === null) return;

    const result = readLocalStorage(this.#storageKey(logicalKey));
    if (!result.ok) {
      this.#dispatchError(logicalKey, "read", "unavailable");
      this.#markCurrentFieldsKnown();
      return;
    }
    if (result.value === null) {
      this.#markCurrentFieldsKnown();
      return;
    }

    const payload = parsePayload(result.value);
    if (payload === null) {
      const removal = removeLocalStorage(this.#storageKey(logicalKey));
      // Cleanup precedes notification so an error consumer can safely replace
      // the invalid value without that repair being deleted on callback return.
      this.#dispatchError(logicalKey, "read", "invalid-payload");
      if (!removal.ok) this.#dispatchError(logicalKey, "remove", "unavailable");
      this.#markCurrentFieldsKnown();
      return;
    }
    this.#payload = payload;
    this.#restoreEntries(null);
  }

  /** Restores fields inserted or made eligible after the initial connection. */
  #restoreDynamicFields(): void {
    const selected = new Set<PersistField>(this.#forcedRestore);
    this.#forcedRestore.clear();
    for (const { field } of this.#fieldEntries()) {
      if (!this.#knownFields.has(field)) selected.add(field);
    }
    this.#restoreEntries(selected);
  }

  /** Applies the active payload to all fields, or only the supplied candidates. */
  #restoreEntries(selected: ReadonlySet<PersistField> | null): void {
    const entries = this.#fieldEntries();
    for (const { field } of entries) this.#knownFields.add(field);
    const payload = this.#payload;
    if (payload === null) return;
    const savedFields = new Map(payload.fields.map((field) => [field.key, field]));
    const restoredKeys = new Set<string>();
    const processedRadios = new Set<string>();

    for (const entry of entries) {
      if (selected !== null && !selected.has(entry.field)) continue;
      const saved = savedFields.get(entry.key);
      if (saved === undefined) continue;
      const { value } = saved;

      if (entry.field instanceof HTMLInputElement && entry.field.type === "radio") {
        if (processedRadios.has(entry.key)) continue;
        processedRadios.add(entry.key);
        const radios = entries
          .filter(
            ({ key, field }) =>
              key === entry.key && field instanceof HTMLInputElement && field.type === "radio",
          )
          .map(({ field }) => field as HTMLInputElement);
        if (typeof value !== "string" || !radios.some((radio) => radio.value === value)) continue;
        for (const radio of radios) radio.checked = radio.value === value;
        restoredKeys.add(entry.key);
        continue;
      }

      if (this.#applyValue(entry.field, value)) restoredKeys.add(entry.key);
    }

    if (restoredKeys.size > 0) {
      // Property writes can reflect to observed attributes in DOM implementations.
      // Drop only records produced by this restore before notifying consumers, so
      // authored mutations made from a restore listener remain observable.
      this.#observer.takeRecords();
      this.element.setAttribute("data-persist-restored", "true");
      this.dispatch("restore", { detail: { key: this.#logicalKey } });
    }
  }

  /** Applies a type-compatible stored value without coercion. */
  #applyValue(field: PersistField, value: PersistValue): boolean {
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      if (typeof value !== "boolean") return false;
      field.checked = value;
      return true;
    }
    if (field instanceof HTMLSelectElement && field.multiple) {
      if (!Array.isArray(value)) return false;
      const available = new Set(Array.from(field.options).map((option) => option.value));
      const selected = value.filter((candidate) => available.has(candidate));
      if (value.length > 0 && selected.length === 0) return false;
      const selectedValues = new Set(selected);
      for (const option of Array.from(field.options)) {
        option.selected = selectedValues.has(option.value);
      }
      return true;
    }
    if (typeof value !== "string") return false;
    if (field instanceof HTMLSelectElement) {
      const exists = Array.from(field.options).some((option) => option.value === value);
      if (!exists) return false;
    }
    field.value = value;
    return true;
  }

  /** Every control this instance owns, before the exclusion list narrows them. */
  #candidateFields(): PersistField[] {
    return this.hasFieldTarget
      ? this.fieldTargets.filter(isPersistField)
      : Array.from(this.element.querySelectorAll<PersistField>("input, textarea, select")).filter(
          (field) => this.#ownsField(field),
        );
  }

  /**
   * Pairs persistable fields with DOM-order occurrence keys. Every HTML radio
   * group (same name and form owner) occupies one shared occurrence slot.
   */
  #fieldEntries(): Array<{ field: PersistField; key: string }> {
    const entries: Array<{ field: PersistField; key: string }> = [];
    const eligible: Array<{ field: PersistField; name: string }> = [];
    for (const field of this.#candidateFields()) {
      const name = this.#keyOf(field);
      if (name === null || !this.#persistable(field, this.#excluded)) continue;
      eligible.push({ field, name });
    }

    const nextOccurrence = new Map<string, number>();
    const radioSlots = new Map<string, Map<HTMLFormElement | null, string>>();
    const allocate = (name: string): string => {
      const occurrence = nextOccurrence.get(name) ?? 0;
      nextOccurrence.set(name, occurrence + 1);
      return occurrence === 0 ? name : `${name}${OCCURRENCE_SEP}${occurrence}`;
    };
    for (const { field, name } of eligible) {
      if (field instanceof HTMLInputElement && field.type === "radio") {
        const groups = radioSlots.get(name) ?? new Map<HTMLFormElement | null, string>();
        radioSlots.set(name, groups);
        let key = groups.get(field.form);
        if (key === undefined) {
          key = allocate(name);
          groups.set(field.form, key);
        }
        entries.push({ field, key });
        continue;
      }
      entries.push({ field, key: allocate(name) });
    }
    return entries;
  }

  /**
   * Whether a field carries a restorable, non-excluded value. A password field is never one,
   * also while a reveal has turned it into a text field: the lease that took its `type` over
   * still records the author's `password`.
   */
  #persistable(field: PersistField, excluded: readonly string[]): boolean {
    if (NON_VALUE_TYPES.has(field.type) || SENSITIVE_TYPES.has(field.type)) return false;
    if (SENSITIVE_TYPES.has(leasedAuthorValue(field, "type") ?? "")) return false;
    if (excluded.includes(field.type)) return false;
    if (field.name.length > 0 && excluded.includes(field.name)) return false;
    return true;
  }

  /** A stable storage sub-key for a field (its name, else id). */
  #keyOf(field: PersistField): string | null {
    return field.name || field.id || null;
  }

  /** Whether this instance, rather than a nested Persist host, owns a field. */
  #ownsField(field: PersistField): boolean {
    return field.closest(`[data-controller~="${this.identifier}"]`) === this.element;
  }

  /** Marks all currently eligible fields without applying a payload. */
  #markCurrentFieldsKnown(): void {
    for (const { field } of this.#fieldEntries()) this.#knownFields.add(field);
  }

  /** Switches namespace after flushing the old namespace's pending edit. */
  #switchLogicalKey(): void {
    const next = this.#resolveLogicalKey();
    if (next === this.#logicalKey) return;
    this.#flushPendingSave();
    this.#logicalKey = next;
    this.#loadActiveDraft();
  }

  /** Synchronizes the exact event name owned by the `clearOn` Value. */
  #syncClearOn(): void {
    const next = this.#validEventName(this.clearOnValue);
    if (next === this.#registeredClearOn) return;
    this.#unbindClearOn();
    if (next === null) return;
    this.element.addEventListener(next, this.#onClearEvent);
    this.#registeredClearOn = next;
  }

  /** Removes the event listener using the name that was actually registered. */
  #unbindClearOn(): void {
    if (this.#registeredClearOn === null) return;
    this.element.removeEventListener(this.#registeredClearOn, this.#onClearEvent);
    this.#registeredClearOn = null;
  }

  /** Returns a non-whitespace event type, or null when the hook is disabled. */
  #validEventName(value: string): string | null {
    const name = value.trim();
    return name.length > 0 && !/\s/.test(name) ? name : null;
  }

  /**
   * Collects dynamic controls and select-option changes into one restore pass.
   *
   * @stimeoRuntimeOnly `key` decides whether an id change moves the storage namespace; it decides
   *   nothing shown.
   */
  #onMutations(records: MutationRecord[]): void {
    let rootIdChanged = false;
    // The first record for an element carries its `data-controller` from before the batch.
    const ownershipBefore = new Map<Element, string | null>();
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target === this.element && record.attributeName === "id") {
          rootIdChanged = true;
        }
        if (record.attributeName === OWNERSHIP_ATTRIBUTE) {
          // An attribute record's target is always an element.
          const element = record.target as Element;
          if (!ownershipBefore.has(element)) ownershipBefore.set(element, record.oldValue);
          continue;
        }
        this.#collectControlCandidate(record.target);
        continue;
      }
      for (const node of record.addedNodes) this.#collectRestoreCandidate(node);
    }
    for (const [element, before] of ownershipBefore) {
      this.#collectOwnershipCandidate(element, before);
    }
    if (rootIdChanged && this.keyValue.length === 0) this.#switchLogicalKey();
    this.#restoreDynamic.schedule();
  }

  /**
   * Adds the controls under an element whose `data-controller` gained or lost this
   * identifier across the batch. That is the only attribute change that moves fields
   * between Persist hosts, so it is the single case worth a subtree sweep; any other
   * `data-controller` change leaves ownership where it was, and sweeping for it would
   * re-apply the stored draft over edits still being debounced.
   */
  #collectOwnershipCandidate(element: Element, before: string | null): void {
    const after = element.getAttribute(OWNERSHIP_ATTRIBUTE);
    if (this.#namesThisIdentifier(before) === this.#namesThisIdentifier(after)) return;
    this.#collectRestoreCandidate(element);
  }

  /** Whether a `data-controller` value lists this controller's identifier. */
  #namesThisIdentifier(tokens: string | null): boolean {
    return (tokens ?? "").split(/\s+/).includes(this.identifier);
  }

  /** Adds a native control, or the select that owns a mutated option. */
  #collectControlCandidate(node: Node): void {
    if (isPersistField(node)) {
      this.#forcedRestore.add(node);
      return;
    }
    if (node instanceof HTMLOptionElement) {
      const select = node.closest("select");
      if (select) this.#forcedRestore.add(select);
    }
  }

  /** Adds every control inside an inserted or newly owned subtree. */
  #collectRestoreCandidate(node: Node): void {
    this.#collectControlCandidate(node);
    if (!(node instanceof Element)) return;
    for (const field of node.querySelectorAll<PersistField>("input, textarea, select")) {
      this.#forcedRestore.add(field);
    }
  }

  /**
   * Resolves the logical key from the Value, falling back to the host id.
   *
   * @stimeoRuntimeOnly `key` names the storage namespace; the restored fields come from what is
   *   stored there.
   */
  #resolveLogicalKey(): string | null {
    const key = this.keyValue || this.element.id;
    return key.length > 0 ? key : null;
  }

  /** Namespaces one logical key within localStorage. */
  #storageKey(logicalKey: string): string {
    return `${STORAGE_PREFIX}${logicalKey}`;
  }

  /** Normalizes an invalid `debounce` Value to the `debounce` default. */
  get #debounceDelay(): number {
    return this.#safeDebounce;
  }

  /** Dispatches one observable storage failure without exposing browser errors. */
  #dispatchError(key: string, operation: PersistOperation, reason: PersistErrorReason): void {
    this.dispatch("error", { detail: { key, operation, reason } });
  }
  /** Current `debounce` declaration resolved against its numeric contract. */
  get #safeDebounce(): number {
    return this.#numbers.read(
      this,
      "debounce",
      this.debounceValue,
      PersistController.values.debounce.default,
      PersistController.valueConstraints.debounce,
    );
  }
}
