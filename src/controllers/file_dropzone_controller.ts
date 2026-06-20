import { Controller } from "@hotwired/stimulus";

/**
 * Headless, accessible file drag-and-drop / upload field.
 *
 * Markup contract (identifier: `stimeo--file-dropzone`):
 *   <div data-controller="stimeo--file-dropzone"
 *        data-stimeo--file-dropzone-max-size-value="5242880">
 *     <div data-stimeo--file-dropzone-target="zone"
 *          data-action="dragover->stimeo--file-dropzone#onDragOver
 *                       dragleave->stimeo--file-dropzone#onDragLeave
 *                       drop->stimeo--file-dropzone#onDrop">
 *       <button type="button" data-stimeo--file-dropzone-target="trigger"
 *               data-action="click->stimeo--file-dropzone#openDialog">Choose…</button>
 *       <input type="file" accept="image/*" multiple class="visually-hidden"
 *              data-stimeo--file-dropzone-target="input"
 *              data-action="change->stimeo--file-dropzone#onChange" />
 *     </div>
 *     <ul data-stimeo--file-dropzone-target="list" aria-label="Selected files"></ul>
 *     <span role="status" aria-live="polite" class="visually-hidden"
 *           data-stimeo--file-dropzone-target="status"></span>
 *     <template data-stimeo--file-dropzone-target="itemTemplate">…</template>
 *   </div>
 *
 * There is no single APG pattern; the native `<input type="file">` stays the
 * primary, keyboard-operable path and the drop zone is an enhancement, mapping to
 * WCAG 2.1.1, 2.4.7, 4.1.2, 4.1.3, and 1.4.1 (drag state is conveyed in words,
 * not color alone).
 *
 * Behavior provided:
 * - Click / keyboard via the `trigger` opens the native file dialog; drag-and-drop
 *   over the `zone` adds files (with a `data-dragover` flag and a spoken hint).
 * - Each file is validated against `accept`, `maxSize`, and the file count
 *   (`maxFiles`, or 1 when the input is not `multiple`); rejects fire
 *   `stimeo--file-dropzone:reject` and set `data-…-invalid`.
 * - Accepted files render from `itemTemplate` with a `Remove {name}` button and an
 *   image thumbnail (`objectURL`); every change dispatches
 *   `stimeo--file-dropzone:change` with the current `File[]`.
 * - Removing a file revokes its `objectURL` and moves focus to the next (else
 *   previous) remove button, falling back to the trigger; `disconnect()` revokes
 *   every outstanding `objectURL`.
 */
export class FileDropzoneController extends Controller<HTMLElement> {
  static override targets = ["zone", "trigger", "input", "list", "item", "itemTemplate", "status"];
  static override values = {
    maxSize: { type: Number, default: 0 },
    maxFiles: { type: Number, default: 0 },
    dragLabel: { type: String, default: "Drop files to add them" },
  };
  static actions = ["onChange", "onDragLeave", "onDragOver", "onDrop", "openDialog"] as const;
  static events = ["change", "reject"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly listTarget: HTMLElement;
  declare readonly triggerTarget: HTMLElement;
  declare readonly itemTemplateTarget: HTMLTemplateElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly hasListTarget: boolean;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasItemTemplateTarget: boolean;
  declare readonly hasStatusTarget: boolean;
  declare readonly hasZoneTarget: boolean;
  declare readonly zoneTarget: HTMLElement;

  declare maxSizeValue: number;
  declare maxFilesValue: number;
  declare dragLabelValue: string;

  /** Selected files paired with their rendered item and any preview objectURL. */
  readonly #entries: Array<{ file: File; item: HTMLElement; url?: string }> = [];

  /** Wires file removal as a delegated listener on the list container. */
  override connect(): void {
    if (this.hasListTarget) this.listTarget.addEventListener("click", this.#onItemClick);
  }

  /** Revokes any outstanding preview URLs so none leaks across navigations. */
  override disconnect(): void {
    if (this.hasListTarget) this.listTarget.removeEventListener("click", this.#onItemClick);
    for (const entry of this.#entries) {
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    this.#entries.length = 0;
  }

  /** Opens the native file dialog. Bound via `data-action` (trigger click). */
  openDialog(): void {
    this.inputTarget.click();
  }

  /** Adds the files chosen through the native dialog. */
  onChange(): void {
    if (this.inputTarget.files) this.#addFiles(this.inputTarget.files);
    // Clear so re-selecting the same file still fires `change`.
    this.inputTarget.value = "";
  }

  /** Marks the zone as a drop target and announces the affordance in words. */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (this.hasZoneTarget) this.zoneTarget.setAttribute("data-dragover", "");
    this.#setStatus(this.dragLabelValue);
  }

  /** Clears the drag-over flag when the pointer leaves the zone. */
  onDragLeave(): void {
    if (this.hasZoneTarget) this.zoneTarget.removeAttribute("data-dragover");
  }

  /** Accepts dropped files, clearing the drag-over state. */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    if (this.hasZoneTarget) this.zoneTarget.removeAttribute("data-dragover");
    if (event.dataTransfer?.files) this.#addFiles(event.dataTransfer.files);
  }

  /**
   * Removes the file whose remove button was clicked. Delegated on the list
   * container rather than bound per item via `data-action`, so it works the instant
   * an item is appended without waiting on Stimulus to wire a freshly created element.
   */
  readonly #onItemClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest("button");
    if (!button || !this.hasListTarget || !this.listTarget.contains(button)) return;
    const index = this.#entries.findIndex((entry) => entry.item.contains(button));
    if (index !== -1) this.#removeAt(index);
  };

  /** Validates each incoming file and renders the accepted ones. */
  #addFiles(files: FileList): void {
    let changed = false;
    if (this.hasZoneTarget) this.zoneTarget.removeAttribute("data-stimeo--file-dropzone-invalid");
    for (const file of Array.from(files)) {
      const reason = this.#validate(file);
      if (reason) {
        if (this.hasZoneTarget) {
          this.zoneTarget.setAttribute("data-stimeo--file-dropzone-invalid", "");
        }
        this.#setStatus(file.name);
        this.dispatch("reject", { detail: { file, reason } });
        continue;
      }
      this.#appendFile(file);
      this.#setStatus(file.name);
      changed = true;
    }
    if (changed) this.dispatch("change", { detail: { files: this.#files } });
  }

  /** Returns the rejection reason for `file`, or `null` when it is acceptable. */
  #validate(file: File): "type" | "size" | "count" | null {
    const limit = this.#effectiveMaxFiles;
    if (limit > 0 && this.#entries.length >= limit) return "count";
    if (!this.#matchesAccept(file)) return "type";
    if (this.maxSizeValue > 0 && file.size > this.maxSizeValue) return "size";
    return null;
  }

  /** Builds one preview item (name, optional thumbnail, remove button). */
  #appendFile(file: File): void {
    if (!this.hasItemTemplateTarget || !this.hasListTarget) return;
    const fragment = this.itemTemplateTarget.content.cloneNode(true) as DocumentFragment;
    const item = fragment.querySelector<HTMLElement>('[data-stimeo--file-dropzone-target="item"]');
    const name = fragment.querySelector<HTMLElement>('[data-file-dropzone-slot="name"]');
    const thumb = fragment.querySelector<HTMLImageElement>('[data-file-dropzone-slot="thumb"]');
    const button = fragment.querySelector<HTMLButtonElement>("button");
    if (!item) return;
    if (name) name.textContent = file.name;
    if (button) button.setAttribute("aria-label", `Remove ${file.name}`);

    let url: string | undefined;
    if (thumb && file.type.startsWith("image/")) {
      url = URL.createObjectURL(file);
      thumb.src = url;
      thumb.alt = file.name;
      thumb.hidden = false;
    } else if (thumb) {
      thumb.hidden = true;
    }

    this.listTarget.appendChild(fragment);
    this.#entries.push({ file, item, url });
  }

  /** Removes entry `index`, revokes its preview, and re-homes focus. */
  #removeAt(index: number): void {
    const entry = this.#entries[index];
    if (!entry) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.item.remove();
    this.#entries.splice(index, 1);
    this.#setStatus(entry.file.name);
    this.dispatch("change", { detail: { files: this.#files } });

    const buttons = this.#removeButtons;
    if (buttons.length === 0) {
      if (this.hasTriggerTarget) this.triggerTarget.focus();
    } else {
      (buttons[index] ?? buttons[buttons.length - 1])?.focus();
    }
  }

  /** Whether `file` satisfies the input's `accept` list (empty accepts all). */
  #matchesAccept(file: File): boolean {
    const accept = this.inputTarget.accept.trim();
    if (accept === "") return true;
    const name = file.name.toLowerCase();
    const type = file.type.toLowerCase();
    return accept.split(",").some((raw) => {
      const token = raw.trim().toLowerCase();
      if (token === "") return false;
      if (token.startsWith(".")) return name.endsWith(token);
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
      return type === token;
    });
  }

  /** Updates the live region so assistive tech announces the change. */
  #setStatus(text: string): void {
    if (this.hasStatusTarget) this.statusTarget.textContent = text;
  }

  /** Effective file cap: `maxFiles`, or 1 when the input is single-select. */
  get #effectiveMaxFiles(): number {
    if (this.maxFilesValue > 0) return this.maxFilesValue;
    return this.inputTarget.multiple ? 0 : 1;
  }

  /** The remove buttons currently in the list, in order. */
  get #removeButtons(): HTMLButtonElement[] {
    return Array.from(this.listTarget.querySelectorAll<HTMLButtonElement>("button"));
  }

  /** The accepted files in selection order. */
  get #files(): File[] {
    return this.#entries.map((entry) => entry.file);
  }
}
