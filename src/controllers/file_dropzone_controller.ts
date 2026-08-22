import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { BeforeCacheReset } from "../utils/before_cache_reset";
import { DetachGate } from "../utils/detach_gate";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";

/** Why one file was turned away, in the order the checks run. */
type RejectReason = "type" | "size" | "duplicate" | "count";

/** Present on the zone while a drag hovers it. */
const DRAGOVER_ATTRIBUTE = "data-dragover";

/** Present on the zone from the first rejection of a batch until the next batch. */
const INVALID_ATTRIBUTE = "data-stimeo--file-dropzone-invalid";

/** One selected file paired with its rendered item and any preview objectURL. */
interface Entry {
  readonly file: File;
  readonly item: HTMLElement;
  readonly url?: string;
}

/** One batch's rejections for a single reason, condensed into one announcement. */
interface RejectBatch {
  readonly name: string;
  count: number;
}

/**
 * Headless, accessible file drag-and-drop / upload field.
 *
 * Markup contract (identifier: `stimeo--file-dropzone`):
 *   <div data-controller="stimeo--file-dropzone"
 *        data-stimeo--file-dropzone-max-size-value="5242880"
 *        data-stimeo--file-dropzone-announce-added-text-value="{name} added; {total} selected">
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
 *     <template data-stimeo--file-dropzone-target="itemTemplate">
 *       <li data-stimeo--file-dropzone-target="item">
 *         <img data-stimeo--file-dropzone-target="thumb" alt="" hidden />
 *         <span data-stimeo--file-dropzone-target="name"></span>
 *         <button type="button" aria-label="Remove {name}"
 *                 data-stimeo--file-dropzone-target="remove">×</button>
 *       </li>
 *     </template>
 *   </div>
 *
 * There is no single APG pattern; the native `<input type="file">` stays the
 * primary, keyboard-operable path and the drop zone is an enhancement, mapping to
 * WCAG 2.1.1, 2.4.7, 4.1.2, 4.1.3, and 1.4.1 (drag state is conveyed in words,
 * not color alone).
 *
 * Behavior provided:
 * - Click / keyboard via the `trigger` opens the native file dialog; drag-and-drop
 *   over the `zone` adds files. The zone carries `data-dragover` for as long as the
 *   pointer is anywhere inside it, descendants included — a `dragleave` whose
 *   `relatedTarget` is still in the zone is the pointer crossing an inner element,
 *   not leaving.
 * - Each file is validated in order against `accept`, `maxSize`, duplication, and
 *   the file count (`maxFiles`, or 1 when the input is not `multiple`). The reason
 *   is therefore the most specific one: a file the zone would refuse whatever the
 *   count says reports its own defect rather than `count`. Rejects fire
 *   `stimeo--file-dropzone:reject` and set `data-…-invalid`, which the next batch
 *   clears.
 * - Two files count as the same when name, size, and last-modified time all match;
 *   `allowDuplicates` turns the check off.
 * - Accepted files render from `itemTemplate`; the template's own remove-button
 *   `aria-label` is kept and its `{name}` expanded, so the accessible name stays in
 *   the consumer's language. A template missing a part renders nothing, changes no
 *   state, and reports itself once per connection.
 * - The accepted set is mirrored onto the native input, so a plain form submit
 *   carries the dropped files with no JavaScript from the consumer. Where
 *   `DataTransfer` cannot be constructed the previews and events still work and the
 *   input keeps whatever the native dialog last put there.
 * - Removing a file revokes its `objectURL` and moves focus to the next (else
 *   previous) remove button, falling back to the trigger.
 * - Additions, rejections, removals, and the drag affordance are handed to the
 *   page's shared `stimeo--announcer` as one polite message each, worded by the
 *   consumer (`{name}` is the file this message is about, `{count}` how many files
 *   it covers, `{total}` how many are selected afterwards). Empty templates stay
 *   silent, keeping announcements opt-in and i18n-neutral. One batch produces at
 *   most one message per outcome, so dropping twenty files never reads twenty lines.
 * - A drop into a disabled field is refused: with the input `disabled` or inside a
 *   disabled `fieldset` the zone never becomes a drop target, matching what the
 *   native click and keyboard paths already do.
 * - Replacing the `list` target rebinds delegated removal and moves the
 *   client-only previews into the replacement; a morph that empties the list in
 *   place moves them back on the next interaction.
 * `reject` dispatches `{ file: File, reason: "type" | "size" | "duplicate" | "count" }`.
 * `change` and `reconcile` dispatch `{ files: File[] }`.
 *
 * @remarks
 * Previews are client-only state that no restored snapshot can revive — the `File`
 * objects and their `blob:` URLs die with the page. Just before Turbo caches the
 * page the generated items are removed, every `objectURL` revoked, and both state
 * attributes withdrawn, so a restored snapshot starts pristine instead of showing
 * rows that cannot be removed and do not count towards `maxFiles`. A `disconnect()`
 * that turns out to be an in-page move keeps the selection intact.
 */
export class FileDropzoneController extends Controller<HTMLElement> {
  static override targets = [
    "zone",
    "trigger",
    "input",
    "list",
    "item",
    "itemTemplate",
    "name",
    "thumb",
    "remove",
  ];
  static override values = {
    maxSize: { type: Number, default: 0 },
    maxFiles: { type: Number, default: 0 },
    allowDuplicates: { type: Boolean, default: false },
    announceDragText: { type: String, default: "" },
    announceAddedText: { type: String, default: "" },
    announceRemovedText: { type: String, default: "" },
    announceRejectedTypeText: { type: String, default: "" },
    announceRejectedSizeText: { type: String, default: "" },
    announceRejectedDuplicateText: { type: String, default: "" },
    announceRejectedCountText: { type: String, default: "" },
  };
  static actions = ["onChange", "onDragLeave", "onDragOver", "onDrop", "openDialog"] as const;
  static events = ["change", "reject", "reconcile"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly listTarget: HTMLElement;
  declare readonly listTargets: HTMLElement[];
  declare readonly triggerTarget: HTMLElement;
  declare readonly itemTemplateTarget: HTMLTemplateElement;
  declare readonly hasInputTarget: boolean;
  declare readonly hasListTarget: boolean;
  declare readonly hasTriggerTarget: boolean;
  declare readonly hasItemTemplateTarget: boolean;
  declare readonly hasZoneTarget: boolean;
  declare readonly zoneTarget: HTMLElement;

  declare maxSizeValue: number;
  declare maxFilesValue: number;
  declare allowDuplicatesValue: boolean;
  declare announceDragTextValue: string;
  declare announceAddedTextValue: string;
  declare announceRemovedTextValue: string;
  declare announceRejectedTypeTextValue: string;
  declare announceRejectedSizeTextValue: string;
  declare announceRejectedDuplicateTextValue: string;
  declare announceRejectedCountTextValue: string;

  /** Selected files paired with their rendered item and any preview objectURL. */
  readonly #entries: Entry[] = [];
  /** Whether a drag is currently over the zone; the source for `data-dragover`. */
  #dragging = false;
  /** Whether this connection already reported its unusable item template. */
  #warnedTemplate = false;
  readonly #gate = new DetachGate();
  readonly #beforeCache = new BeforeCacheReset(() => this.#rewindForCache());

  /** Subscribes to the Turbo cache rewind and re-arms the template diagnostic. */
  override connect(): void {
    this.#gate.cancel();
    this.#warnedTemplate = false;
    this.#beforeCache.activate();
  }

  /**
   * Releases the delegated listeners. The selection itself survives an in-page
   * move and is released only once the gate proves a real detach — revoking a
   * preview URL on a move would leave a live item pointing at a dead `blob:`.
   */
  override disconnect(): void {
    for (const list of this.listTargets) list.removeEventListener("click", this.#onItemClick);
    this.#beforeCache.deactivate();
    this.#gate.disconnected(this, () => this.#teardown());
  }

  /**
   * Binds removal and restores client-only previews for every list this controller
   * renders into — the one present at connect and any Turbo puts in its place.
   * This is the only place the listener is attached, so the pair with
   * {@link listTargetDisconnected} keeps it from outliving the element it is on.
   */
  listTargetConnected(list: HTMLElement): void {
    this.#bindList(list);
  }

  /** Releases only the list target that actually disconnected. */
  listTargetDisconnected(list: HTMLElement): void {
    list.removeEventListener("click", this.#onItemClick);
  }

  /** Binds delegated removal once and moves live preview items into the current list. */
  #bindList(list: HTMLElement): void {
    list.addEventListener("click", this.#onItemClick);
    for (const entry of this.#entries) {
      if (!list.contains(entry.item)) list.appendChild(entry.item);
    }
  }

  /** Opens the native file dialog. Bound via `data-action` (trigger click). */
  openDialog(): void {
    if (this.#isDisabled) return;
    this.inputTarget.click();
  }

  /**
   * Adds the files chosen through the native dialog. The input holds only what
   * the dialog just returned, so the accepted set is written back over it once
   * the batch is validated.
   */
  onChange(): void {
    const files = this.inputTarget.files;
    if (files) this.#addFiles(files);
    else this.#syncInput();
  }

  /**
   * Marks the zone as a drop target and announces the affordance once per drag.
   * Bound via `data-action` (dragover). Leaving the default alone is what refuses
   * the drop, so a disabled field and a drag an inner dropzone already claimed
   * both fall through untouched.
   */
  onDragOver(event: DragEvent): void {
    if (event.defaultPrevented || this.#isDisabled) return;
    event.preventDefault();
    if (this.#dragging) return;
    this.#dragging = true;
    if (this.hasZoneTarget) this.zoneTarget.setAttribute(DRAGOVER_ATTRIBUTE, "");
    // No file is involved yet, so only `{total}` resolves; the rest stay as authored.
    announce(fillTemplate(this.announceDragTextValue, { total: this.#entries.length }));
  }

  /**
   * Clears the drag-over flag when the pointer leaves the zone. Bound via
   * `data-action` (dragleave). `dragleave` bubbles from every descendant the
   * pointer crosses, so the flag only drops when the element being entered is
   * outside the zone (or there is none, the pointer having left the window).
   */
  onDragLeave(event: DragEvent): void {
    const next = event.relatedTarget;
    if (this.hasZoneTarget && next instanceof Node && this.zoneTarget.contains(next)) return;
    this.#endDrag();
  }

  /** Accepts dropped files, clearing the drag-over state. Bound via `data-action` (drop). */
  onDrop(event: DragEvent): void {
    if (event.defaultPrevented) return;
    this.#endDrag();
    if (this.#isDisabled) return;
    event.preventDefault();
    if (event.dataTransfer?.files) this.#addFiles(event.dataTransfer.files);
  }

  /**
   * Removes the file whose remove button was clicked. Delegated on the list
   * container rather than bound per item via `data-action`, so it works the instant
   * an item is appended without waiting on Stimulus to wire a freshly created element.
   * Only the item's declared `remove` target counts, so an authored second control
   * inside an item does what it says instead of silently discarding the file. The
   * button has to belong to a tracked item, which is what makes a list this
   * controller no longer renders into inert — its items moved out with it.
   */
  readonly #onItemClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-stimeo--file-dropzone-target~="remove"]',
    );
    const index = this.#entries.findIndex((entry) => entry.item.contains(button));
    if (index !== -1) this.#removeAt(index);
  };

  /** Validates each incoming file, renders the accepted ones, and reports the batch. */
  #addFiles(files: FileList): void {
    this.#rehome();
    if (this.hasZoneTarget) this.zoneTarget.removeAttribute(INVALID_ATTRIBUTE);
    const rejected = new Map<RejectReason, RejectBatch>();
    const turnedAway: Array<{ file: File; reason: RejectReason }> = [];
    let addedName = "";
    let added = 0;
    for (const file of Array.from(files)) {
      const reason = this.#validate(file);
      if (reason !== null) {
        if (this.hasZoneTarget) this.zoneTarget.setAttribute(INVALID_ATTRIBUTE, "");
        const batch = rejected.get(reason);
        if (batch) batch.count += 1;
        else rejected.set(reason, { name: file.name, count: 1 });
        turnedAway.push({ file, reason });
        continue;
      }
      // Nothing is rendered when the template is unusable, so nothing was selected
      // either: the set must not report a change it did not make.
      if (!this.#appendFile(file)) continue;
      if (added === 0) addedName = file.name;
      added += 1;
    }
    this.#syncInput();
    // The batch reports what it took before what it turned away — the same order
    // the announcements use. A consumer that clears its rejection notice when a
    // file lands would otherwise wipe the notice for the very drop that raised it.
    if (added > 0) {
      this.#announce(this.announceAddedTextValue, addedName, added);
      this.dispatch("change", { detail: { files: this.#files } });
    }
    for (const { file, reason } of turnedAway) {
      this.dispatch("reject", { detail: { file, reason } });
    }
    for (const [reason, batch] of rejected) {
      this.#announce(this.#rejectText(reason), batch.name, batch.count);
    }
  }

  /**
   * Returns the rejection reason for `file`, or `null` when it is acceptable.
   * The file's own defects are decided first, so a full list still tells the user
   * which files it would never have taken.
   */
  #validate(file: File): RejectReason | null {
    if (!this.#matchesAccept(file)) return "type";
    if (this.maxSizeValue > 0 && file.size > this.maxSizeValue) return "size";
    if (
      !this.allowDuplicatesValue &&
      this.#entries.some((entry) => this.#isSame(entry.file, file))
    ) {
      return "duplicate";
    }
    const limit = this.#effectiveMaxFiles;
    if (limit > 0 && this.#entries.length >= limit) return "count";
    return null;
  }

  /**
   * Whether two files are the same selection. `File` objects from separate picks
   * are never the same reference, so identity is the triple the platform exposes.
   */
  #isSame(a: File, b: File): boolean {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  }

  /**
   * Builds one preview item (name, optional thumbnail, remove button) and reports
   * whether it was rendered.
   */
  #appendFile(file: File): boolean {
    if (!this.hasListTarget) return this.#warnTemplate('a "list" target to render into');
    if (!this.hasItemTemplateTarget) return this.#warnTemplate('an "itemTemplate" target');
    const fragment = this.itemTemplateTarget.content.cloneNode(true) as DocumentFragment;
    const item = this.#slot(fragment, "item");
    const name = this.#slot(fragment, "name");
    const thumb = this.#slot<HTMLImageElement>(fragment, "thumb");
    const button = fragment.querySelector<HTMLButtonElement>(
      'button[data-stimeo--file-dropzone-target~="remove"]',
    );
    const removeName = button?.getAttribute("aria-label")?.trim() ?? "";
    if (!item) return this.#warnTemplate('an "item" root');
    if (!name) return this.#warnTemplate('a "name" element');
    if (!button) return this.#warnTemplate('a "remove" target <button>');
    if (removeName === "") {
      return this.#warnTemplate('a non-empty aria-label on its "remove" target');
    }
    name.textContent = file.name;
    // The authored label owns the wording and the language; only `{name}` is filled.
    button.setAttribute("aria-label", fillTemplate(removeName, { name: file.name }));

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
    return true;
  }

  /** Resolves one declared part inside a cloned item template. */
  #slot<T extends HTMLElement = HTMLElement>(fragment: DocumentFragment, name: string): T | null {
    return fragment.querySelector<T>(`[data-stimeo--file-dropzone-target~="${name}"]`);
  }

  /**
   * Reports an unusable item template to the author, once per connection.
   *
   * The addition itself stays a no-op — nothing about the selection, the native
   * input, the announcements, or the events changes. Without this line the only
   * symptom is a picker that accepts no file at all, and the causes the Inspector
   * cannot see statically (a server-rendered template, a name that renders empty
   * from a missing translation) would have no diagnostic anywhere.
   */
  #warnTemplate(missing: string): false {
    if (!this.#warnedTemplate) {
      this.#warnedTemplate = true;
      console.warn(
        `Stimeo UI: "${this.identifier}" added no file because its item template lacks ${missing}.`,
      );
    }
    return false;
  }

  /** Removes entry `index`, revokes its preview, and re-homes focus. */
  #removeAt(index: number): void {
    const entry = this.#entries[index];
    if (!entry) return;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.item.remove();
    this.#entries.splice(index, 1);
    this.#syncInput();
    this.#announce(this.announceRemovedTextValue, entry.file.name, 1);
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

  /**
   * Sends one consumer-worded message to the page's shared announcer. `{name}` is
   * the file the message is about, `{count}` how many files it covers, and
   * `{total}` how many are selected once the batch has settled.
   */
  #announce(template: string, name: string, count: number): void {
    announce(fillTemplate(template, { name, count, total: this.#entries.length }));
  }

  /** The consumer's wording for one rejection reason. */
  #rejectText(reason: RejectReason): string {
    switch (reason) {
      case "type":
        return this.announceRejectedTypeTextValue;
      case "size":
        return this.announceRejectedSizeTextValue;
      case "duplicate":
        return this.announceRejectedDuplicateTextValue;
      case "count":
        return this.announceRejectedCountTextValue;
    }
  }

  /**
   * Mirrors the accepted set onto the native input, so a plain form submit carries
   * the dropped files. Skipped where `DataTransfer` cannot be constructed: the
   * widget keeps working and the consumer still receives every `File` on `change`.
   */
  #syncInput(): void {
    // The rewind runs from the shared before-cache pass, where a throw would rob
    // every later subscriber of its own rewind — and a morph can take the input
    // target away before that point.
    if (!this.hasInputTarget) return;
    const transfer = this.#newTransfer();
    if (!transfer) return;
    for (const entry of this.#entries) transfer.items.add(entry.file);
    this.inputTarget.files = transfer.files;
  }

  /** A usable empty `DataTransfer`, or `null` where the platform has none. */
  #newTransfer(): DataTransfer | null {
    try {
      return new DataTransfer();
    } catch {
      // No constructor at all, or one that refuses construction.
      return null;
    }
  }

  /**
   * Moves surviving preview items back under the current list. A morph that
   * empties the list in place leaves the selection with no rendering, and the
   * files it holds cannot be rebuilt from the DOM, so the items are re-homed
   * rather than forgotten.
   */
  #rehome(): void {
    if (!this.hasListTarget) return;
    for (const entry of this.#entries) {
      if (!this.listTarget.contains(entry.item)) this.listTarget.appendChild(entry.item);
    }
  }

  /** Drops the drag-over state, whether the drag ended in a drop or left the zone. */
  #endDrag(): void {
    this.#dragging = false;
    if (this.hasZoneTarget) this.zoneTarget.removeAttribute(DRAGOVER_ATTRIBUTE);
  }

  /**
   * Discards the selection and every state attribute this controller wrote, so
   * neither a cached snapshot nor a stranded subtree keeps items whose files are
   * gone. Silent: `change` means a selection the user changed, and the cache
   * rewind reports itself as `reconcile` instead.
   */
  #rewindForCache(): void {
    const had = this.#entries.length > 0;
    this.#reset();
    // The rewind decides the selection is gone, so consumers that painted from
    // `change` (or from `reject`) can drop what they drew before the snapshot is
    // taken. Nothing to report when there was nothing to discard.
    if (had) this.dispatch("reconcile", { detail: { files: this.#files } });
  }

  #reset(): void {
    for (const entry of this.#entries) {
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.item.remove();
    }
    this.#entries.length = 0;
    this.#syncInput();
    this.#endDrag();
    if (this.hasZoneTarget) this.zoneTarget.removeAttribute(INVALID_ATTRIBUTE);
  }

  /** Releases the selection once the disconnect is known to be a real detach. */
  #teardown(): void {
    this.#gate.cancel();
    this.#reset();
  }

  /** Whether the field refuses input, natively or through an ancestor `fieldset`. */
  get #isDisabled(): boolean {
    return this.inputTarget.disabled || inheritsFieldsetDisabled(this.inputTarget);
  }

  /** Effective file cap: `maxFiles`, or 1 when the input is single-select. */
  get #effectiveMaxFiles(): number {
    if (this.maxFilesValue > 0) return this.maxFilesValue;
    return this.inputTarget.multiple ? 0 : 1;
  }

  /** The declared remove button of each rendered item, in selection order. */
  get #removeButtons(): HTMLButtonElement[] {
    const buttons: HTMLButtonElement[] = [];
    for (const entry of this.#entries) {
      const button = entry.item.querySelector<HTMLButtonElement>(
        'button[data-stimeo--file-dropzone-target~="remove"]',
      );
      if (button) buttons.push(button);
    }
    return buttons;
  }

  /** The accepted files in selection order. */
  get #files(): File[] {
    return this.#entries.map((entry) => entry.file);
  }
}
