import { sharedRegistry } from "./shared_registry";

/** Reserved transport names identify one produced entry without grouping equal public names. */
const PREFIX = "__stimeo_raw_v1_";

interface Projection {
  readonly field: HTMLInputElement;
  readonly document: Document;
  readonly state: DocumentProjection;
  readonly key: string;
  readonly name: string;
  readonly project: (value: FormDataEntryValue) => FormDataEntryValue;
  readonly restore: () => void;
}

interface DocumentProjection {
  readonly fields: Map<string, Projection>;
  readonly handle: (event: Event) => void;
  readonly byField: WeakMap<HTMLInputElement, Projection>;
}

const documents = sharedRegistry(
  "stimeo-ui.form-data-projection.registry.v1",
  () => new WeakMap<Document, DocumentProjection>(),
);

/** The public name encoded by a reserved transport name, or null for an ordinary name. */
function decodedName(key: string): string | null {
  if (!key.startsWith(PREFIX)) return null;
  const separator = PREFIX.length + 32;
  if (key[separator] !== ":") return null;
  try {
    const name: unknown = JSON.parse(key.slice(separator + 1));
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** Reads a field's logical submission name without exposing its transport identity. */
export function projectedFieldName(name: string): string {
  return decodedName(name) ?? name;
}

/** Installs one capture listener for the document's reserved transport namespace. */
function forDocument(document: Document): DocumentProjection {
  const existing = documents.get(document);
  if (existing) return existing;
  const state: DocumentProjection = {
    fields: new Map(),
    byField: new WeakMap(),
    handle: (event) => {
      const data = (event as FormDataEvent).formData;
      if (!data) return;
      const entries = [...data.entries()];
      let changed = false;
      const projected = entries.map(([key, value]): [string, FormDataEntryValue] => {
        const name = decodedName(key);
        if (name === null) return [key, value];
        changed = true;
        const field = state.fields.get(key);
        const live = field && field.field.name === key && field.field.form === event.target;
        return [name, live ? field.project(value) : ""];
      });
      if (!changed) return;
      for (const key of new Set(data.keys())) data.delete(key);
      for (const [name, value] of projected) data.append(name, value);
    },
  };
  documents.set(document, state);
  // @stimeoListenerLifetime document Decodes cached or released transport entries even when no
  // producer remains.
  document.addEventListener("formdata", state.handle, { capture: true });
  return state;
}

/** Prepares a form's projection event path, including while the form is detached. */
export function prepareFormDataProjection(form: HTMLFormElement): void {
  const state = forDocument(form.ownerDocument);
  // @stimeoListenerLifetime element A form keeps transport decoding when detached from its
  // document.
  form.addEventListener("formdata", state.handle, { capture: true });
}

/**
 * Gives a maintained hidden field a unique transport identity while preserving its
 * value. FormData exposes the public name in the same entry position; the producer
 * decides the submitted value without changing the DOM or releasing ownership.
 */
export class FormDataProjection {
  #held: Projection | null = null;

  /**
   * Claims this field's current name; a normal name written by the page starts a new claim.
   * A Turbo morph that writes the public name back returns the field to this claim at once.
   */
  hold(field: HTMLInputElement, project: Projection["project"]): void {
    const held = this.#held;
    if (held?.field === field && held.key === field.name && held.document === field.ownerDocument) {
      if (field.form) prepareFormDataProjection(field.form);
      return;
    }
    this.release();
    const name = projectedFieldName(field.name);
    if (name === "" || (field.type === "hidden" && name.toLowerCase() === "_charset_")) return;
    const state = forDocument(field.ownerDocument);
    if (field.form) prepareFormDataProjection(field.form);
    const previous = state.byField.get(field);
    if (previous) {
      state.fields.delete(previous.key);
      field.removeEventListener("turbo:morph-element", previous.restore);
    }
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const key = `${PREFIX}${nonce}:${JSON.stringify(name)}`;
    const projection: Projection = {
      field,
      key,
      name,
      project,
      document: field.ownerDocument,
      state,
      restore: () => {
        if (field.name === name) field.name = key;
      },
    };
    state.fields.set(key, projection);
    state.byField.set(field, projection);
    this.#held = projection;
    field.name = key;
    // @stimeoListenerLifetime element The current claim keeps its name through a morph; a
    // release or a new claim removes it.
    field.addEventListener("turbo:morph-element", projection.restore);
  }

  /** Restores only the name this claim still holds; another writer's name stays untouched. */
  release(): void {
    const held = this.#held;
    this.#held = null;
    if (held === null) return;
    held.field.removeEventListener("turbo:morph-element", held.restore);
    const state = held.state;
    if (state.byField.get(held.field) !== held) return;
    state.fields.delete(held.key);
    state.byField.delete(held.field);
    if (held.field.name === held.key) held.field.name = held.name;
  }
}
