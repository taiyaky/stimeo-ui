import { Controller } from "@hotwired/stimulus";
import { announce, fillTemplate } from "../utils/announce";
import { AttributeLease } from "../utils/attribute_lease";
import { DetachGate } from "../utils/detach_gate";
import { matchingPart, writeLabel } from "../utils/element_part";
import { ownerOf } from "../utils/event_owner";
import { inheritsFieldsetDisabled } from "../utils/focus_candidate";
import { NUMBER_BOUNDS, type NumberValueConstraints } from "../utils/number_bounds";
import { NumberValueReader } from "../utils/number_value";
import { TemplateRow } from "../utils/template_row";

/** Why one file was turned away, in the order the checks run. */
type RejectReason = "type" | "size" | "duplicate" | "count";

/** Present on the zone while a drag hovers it. */
const DRAGOVER_ATTRIBUTE = "data-dragover";

/**
 * Suffix of the hook present on the zone from the first rejection of a batch until
 * the next batch.
 */
const INVALID_ATTRIBUTE = "invalid";

/** Suffix of the mark on every item this controller renders; see the class remarks. */
const GENERATED_ATTRIBUTE = "generated";

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
 *   input keeps whatever the native dialog last put there. An input that takes
 *   over — in one task, or after an earlier one leaves in a later task — gets the
 *   accepted set too, silently; the files on one that departs are its own form value
 *   and stay.
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
 *   client-only previews into the replacement; a list inserted behind the current
 *   one receives them only once the current one leaves. A morph that empties the
 *   list in place — a Turbo morph does, as the server never rendered them — moves
 *   them back at once, and the drag and rejection hooks the morph took off with them.
 *   A preview taken out any other way comes back the same way: the remove button is
 *   what drops a file.
 * `reject` dispatches `{ file: File, reason: "type" | "size" | "duplicate" | "count" }`.
 * `change` and `reconcile` dispatch `{ files: File[] }`.
 *
 * @remarks
 * Previews are client-only state that no restored snapshot can revive — the `File`
 * objects and their `blob:` URLs die with the page. Every item this controller renders
 * carries `data-<identifier>-generated`, so a page Turbo restores from its cache, which
 * still shows the items of the page it copied, is recognised when it connects: a
 * connection that holds no selection of its own removes the marked items it finds in
 * its lists, empties the native input, withdraws both state attributes, and reports the
 * empty selection as `reconcile`. Rows that cannot be removed and do not count towards
 * `maxFiles` therefore never stay on a restored page. Nothing is undone on
 * `turbo:before-cache`, which Turbo also dispatches on pages that stay — a promoted
 * frame navigation, a state-less `popstate`, a refresh of a cached URL, a
 * `data-turbo-permanent` element carried to the next page — where the selection is the
 * one the form is about to submit. A `disconnect()` that turns out to be an in-page move
 * keeps the selection intact, and so does a permanent element's reconnection.
 */
export class FileDropzoneController extends Controller<HTMLElement> {
  /** Numeric read boundaries share one reader for this controller instance. */
  readonly #numbers = new NumberValueReader();

  /** The hook above, in the namespace this controller is registered under. */
  get #invalidAttribute(): string {
    return `data-${this.identifier}-${INVALID_ATTRIBUTE}`;
  }

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

  static valueConstraints = {
    maxSize: NUMBER_BOUNDS.nonNegative,
    maxFiles: NUMBER_BOUNDS.nonNegative,
  } satisfies NumberValueConstraints<typeof FileDropzoneController.values>;
  static actions = ["onChange", "onDragLeave", "onDragOver", "onDrop", "openDialog"] as const;
  static events = ["change", "reject", "reconcile"] as const;

  declare readonly inputTarget: HTMLInputElement;
  declare readonly inputTargets: HTMLInputElement[];
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
  declare readonly zoneTargets: HTMLElement[];

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
  /** Whether the last batch turned a file away; the source for the invalid hook. */
  #invalid = false;
  /** Borrows `data-dragover` on the zone, to give back when an element stops being the zone. */
  readonly #dragoverHook = new AttributeLease<HTMLElement>(DRAGOVER_ATTRIBUTE, this.identifier);
  /** Borrows the invalid hook on the zone, for the same return. */
  readonly #invalidHook = new AttributeLease<HTMLElement>(this.#invalidAttribute, this.identifier);
  /** Builds one preview item from the authored template and owns its diagnostic. */
  readonly #rows = new TemplateRow({
    identifier: this.identifier,
    root: "item",
    required: ["name"],
    optional: ["thumb"],
    button: "remove",
    outcome: "added no file",
    noun: "item template",
  });
  readonly #gate = new DetachGate();
  /**
   * Watches every list this controller renders into, so previews a morph empties out
   * of the list in place come back at once, with the zone hooks the same morph took off.
   */
  readonly #listWatch = new MutationObserver((records) => {
    const lost = records.some((record) =>
      Array.from(record.removedNodes).some((node) =>
        this.#entries.some((entry) => entry.item === node),
      ),
    );
    if (!lost) return;
    this.#rehome();
    this.#paintZone();
  });
  /** Whether the controller is between `connect()` and `disconnect()`. */
  #connected = false;

  /** The item mark above, in the namespace this controller is registered under. */
  get #generatedAttribute(): string {
    return `data-${this.identifier}-${GENERATED_ATTRIBUTE}`;
  }

  /** Re-arms the template diagnostic and discards the items a restored page carries. */
  override connect(): void {
    const moved = this.#gate.pending;
    this.#gate.cancel();
    this.#connected = true;
    this.#rows.connect();
    if (!moved) this.#discardInherited();
  }

  /**
   * Releases the delegated listeners. The selection itself survives an in-page
   * move and is released only once the gate proves a real detach — revoking a
   * preview URL on a move would leave a live item pointing at a dead `blob:`.
   */
  override disconnect(): void {
    this.#connected = false;
    for (const list of this.listTargets) list.removeEventListener("click", this.#onItemClick);
    this.#listWatch.disconnect();
    this.#gate.disconnected(this, () => this.#teardown());
  }

  /**
   * Removes the marked items a connection that is not the other half of a move finds in
   * its lists: the copy of an earlier selection on a page restored from Turbo's cache,
   * whose files did not survive, and gives the zone hooks such a copy carries back to the
   * author. A discarded selection empties the native input and the zone and is reported
   * once as `reconcile`; hooks alone are given back silently. The reconnection that
   * completes an in-page move or a permanent carry keeps its selection and its hooks.
   */
  #discardInherited(): void {
    let discarded = false;
    for (const list of this.listTargets) {
      for (const item of Array.from(list.children)) {
        if (!item.hasAttribute(this.#generatedAttribute)) continue;
        item.remove();
        discarded = true;
      }
    }
    for (const zone of this.zoneTargets) {
      this.#dragoverHook.return(zone);
      this.#invalidHook.return(zone);
    }
    if (!discarded) return;
    this.#dragging = false;
    this.#invalid = false;
    this.#syncInput();
    this.dispatch("reconcile", { detail: { files: this.#files } });
  }

  /**
   * Binds removal on every list this controller renders into — the one present at
   * connect and any Turbo puts in its place — watches it for previews taken out of it,
   * and restores client-only previews into the list that is first, so a list waiting
   * behind the current one stays empty. This is the only place the listener is
   * attached, so the pair with {@link listTargetDisconnected} keeps it from outliving
   * the element it is on; the watch ends with the connection.
   */
  listTargetConnected(list: HTMLElement): void {
    list.addEventListener("click", this.#onItemClick);
    this.#listWatch.observe(list, { childList: true });
    this.#rehome();
  }

  /** Releases the list that disconnected and moves the previews into the list that stays. */
  listTargetDisconnected(list: HTMLElement): void {
    list.removeEventListener("click", this.#onItemClick);
    if (this.#connected) this.#rehome();
  }

  /** Mirrors the accepted set onto an input that arrives after connect. */
  inputTargetConnected(): void {
    if (this.#connected) this.#syncInput();
  }

  /** Mirrors the accepted set onto the input left once an earlier one departs. */
  inputTargetDisconnected(): void {
    if (this.#connected) this.#syncInput();
  }

  /** Writes the drag and rejection hooks onto a zone that arrives after connect. */
  zoneTargetConnected(): void {
    if (this.#connected) this.#paintZone();
  }

  /**
   * Gives a zone that no longer resolves as the target its own hooks back — after
   * `disconnect()` too, since dropping the identifier leaves the element on the page —
   * and, while connected, writes them onto the zone left.
   */
  zoneTargetDisconnected(zone: HTMLElement): void {
    if (this.zoneTargets.includes(zone)) return;
    this.#dragoverHook.return(zone);
    this.#invalidHook.return(zone);
    if (this.#connected) this.#paintZone();
  }

  /** Opens the native file dialog. Bound via `data-action` (trigger click). */
  openDialog(): void {
    if (this.#isDisabled) return;
    this.inputTarget.click();
  }

  /**
   * Adds the files chosen through the native dialog, read from the input the `change`
   * came from — an input waiting behind the one in use included — or from the input in
   * use for an event no input dispatched and for a call with no event. The dialog
   * leaves only its own answer on that input, so the accepted set is written back over
   * the input in use once the batch is validated.
   */
  onChange(event?: Event): void {
    const files = (ownerOf(this.inputTargets, event?.target) ?? this.inputTarget).files;
    if (files) this.#addFiles(files);
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
    this.#paintZone();
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
      `button${this.#rows.selector("remove")}`,
    );
    const index = this.#entries.findIndex((entry) => entry.item.contains(button));
    if (index !== -1) this.#removeAt(index);
  };

  /**
   * Validates each incoming file, renders the accepted ones, and reports the batch.
   *
   * @stimeoRuntimeOnly The limits decide which files of this one drop are taken, and the texts word
   *   the announcements it makes.
   */
  #addFiles(files: FileList): void {
    this.#rehome();
    this.#invalid = false;
    const rejected = new Map<RejectReason, RejectBatch>();
    const turnedAway: Array<{ file: File; reason: RejectReason }> = [];
    let addedName = "";
    let added = 0;
    for (const file of Array.from(files)) {
      const reason = this.#validate(file);
      if (reason !== null) {
        this.#invalid = true;
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
    this.#paintZone();
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
    if (this.#safeMaxSize > 0 && file.size > this.#safeMaxSize) return "size";
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
   *
   * A refused row leaves the addition a no-op — nothing about the selection, the
   * native input, the announcements, or the events changes — and the row reports
   * why on the console once per connection.
   */
  #appendFile(file: File): boolean {
    if (!this.hasListTarget) {
      this.#rows.report('a "list" target to render into');
      return false;
    }
    if (!this.hasItemTemplateTarget) {
      this.#rows.report('an "itemTemplate" target');
      return false;
    }
    const row = this.#rows.instantiate(this.itemTemplateTarget, { name: file.name });
    if (!row) return false;
    const item = row.root;
    item.setAttribute(this.#generatedAttribute, "");
    writeLabel(row.slots.name, file.name);
    // A declared thumbnail is the authored `<img>`; nothing else can take a `src`.
    const thumb = row.slots.thumb as HTMLImageElement | null;

    let url: string | undefined;
    if (thumb && file.type.startsWith("image/")) {
      url = URL.createObjectURL(file);
      thumb.src = url;
      thumb.alt = file.name;
      thumb.hidden = false;
    } else if (thumb) {
      thumb.hidden = true;
    }

    this.listTarget.appendChild(item);
    this.#entries.push({ file, item, url });
    return true;
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
    // A morph can take the input target away before a teardown or a restored
    // page's discard reaches here, and the departure of the only input reaches
    // here with no input left as well.
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
    this.#paintZone();
  }

  /** Writes the drag and rejection hooks onto the zone from the controller's state. */
  #paintZone(): void {
    if (!this.hasZoneTarget) return;
    this.#dragoverHook.write(this.zoneTarget, this.#dragging ? "" : null);
    this.#invalidHook.write(this.zoneTarget, this.#invalid ? "" : null);
  }

  /**
   * Discards the selection and every state attribute this controller wrote, so a
   * stranded subtree keeps no items whose files are gone. Silent: `change` means a
   * selection the user changed, and nobody reads a subtree left behind.
   */
  #reset(): void {
    this.#invalid = false;
    for (const entry of this.#entries) {
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.item.remove();
    }
    this.#entries.length = 0;
    this.#syncInput();
    this.#endDrag();
  }

  /** Releases the selection once the disconnect is known to be a real detach. */
  #teardown(): void {
    this.#reset();
  }

  /** Whether the field refuses input, natively or through an ancestor `fieldset`. */
  get #isDisabled(): boolean {
    return this.inputTarget.disabled || inheritsFieldsetDisabled(this.inputTarget);
  }

  /** Effective file cap: `maxFiles`, or 1 when the input is single-select. */
  get #effectiveMaxFiles(): number {
    if (this.#safeMaxFiles > 0) return this.#safeMaxFiles;
    return this.inputTarget.multiple ? 0 : 1;
  }

  /** The declared remove button of each rendered item, in selection order. */
  get #removeButtons(): HTMLButtonElement[] {
    const buttons: HTMLButtonElement[] = [];
    for (const entry of this.#entries) {
      const button = matchingPart<HTMLButtonElement>(
        entry.item,
        `button${this.#rows.selector("remove")}`,
      );
      if (button) buttons.push(button);
    }
    return buttons;
  }

  /** The accepted files in selection order. */
  get #files(): File[] {
    return this.#entries.map((entry) => entry.file);
  }
  /** Current `maxSize` declaration resolved against its numeric contract. */
  get #safeMaxSize(): number {
    return this.#numbers.read(
      this,
      "maxSize",
      this.maxSizeValue,
      FileDropzoneController.values.maxSize.default,
      FileDropzoneController.valueConstraints.maxSize,
    );
  }

  /** Current `maxFiles` declaration resolved against its numeric contract. */
  get #safeMaxFiles(): number {
    return this.#numbers.read(
      this,
      "maxFiles",
      this.maxFilesValue,
      FileDropzoneController.values.maxFiles.default,
      FileDropzoneController.valueConstraints.maxFiles,
    );
  }
}
