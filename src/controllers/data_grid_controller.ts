import { Controller } from "@hotwired/stimulus";
import { isReservedArrowChord, logicalArrowKey } from "../utils/arrow_step";
import { commitField, writeFields } from "../utils/field_mirror";
import { INTERACTIVE_HOST_SELECTOR, isInteractiveHost } from "../utils/interactive_host";
import { MicrotaskCoalescer } from "../utils/microtask_coalescer";

/** Cycle order for a sortable column header's `aria-sort`. */
const SORT_CYCLE = ["none", "ascending", "descending"] as const;
type SortDirection = (typeof SORT_CYCLE)[number];

/** Row attributes a page can rewrite in place that move the published selection. */
const OBSERVED_ATTRIBUTES = ["aria-selected", "data-value"];

/** The published selection: each selected row with the value it submits. */
type Selection = ReadonlyMap<HTMLElement, string | undefined>;

/**
 * Sets `name` on `element` only when its value differs. A same-value write still
 * queues a mutation record for every observer on the page, so an unchanged state
 * writes nothing.
 */
function setAttributeIfChanged(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** Whether two selections hold the same rows submitting the same values, in any order. */
function sameSelection(a: Selection, b: Selection): boolean {
  if (a.size !== b.size) return false;
  for (const [row, value] of a) {
    if (!b.has(row) || b.get(row) !== value) return false;
  }
  return true;
}

/**
 * Returns the next `aria-sort` direction in the cycle after `current`. Unknown or
 * ARIA-only values (e.g. `"other"`, or an empty/missing attribute) are treated as
 * `"none"`, so the first activation always advances to `"ascending"` instead of
 * stalling.
 */
function nextSortDirection(current: string): SortDirection {
  const index = SORT_CYCLE.indexOf(current as SortDirection);
  const from = index < 0 ? 0 : index;
  return SORT_CYCLE[(from + 1) % SORT_CYCLE.length] ?? "ascending";
}

/**
 * Headless, accessible **Data Grid** behavior: column sorting, row selection, and
 * roving keyboard navigation over an interactive table.
 *
 * Markup contract (identifier: `stimeo--data-grid`):
 *   <table data-controller="stimeo--data-grid" role="grid" aria-label="Users"
 *          data-stimeo--data-grid-selection-value="single"
 *          data-stimeo--data-grid-name-value="user_id">
 *     <caption><div data-stimeo--data-grid-target="fields"></div></caption>
 *     <thead><tr role="row">
 *       <th role="columnheader" aria-sort="none" tabindex="-1"
 *           data-stimeo--data-grid-target="columnHeader"
 *           data-action="click->stimeo--data-grid#sort
 *                        keydown->stimeo--data-grid#onKeydown">Name</th>
 *     </tr></thead>
 *     <tbody><tr role="row" aria-selected="false" data-value="7"
 *                data-stimeo--data-grid-target="row">
 *       <td role="gridcell" tabindex="0" data-stimeo--data-grid-target="cell"
 *           data-action="keydown->stimeo--data-grid#onKeydown">Jane</td>
 *     </tr></tbody>
 *   </table>
 *
 * Implements the WAI-ARIA APG **Grid** pattern plus `aria-sort`. The whole grid is
 * a single Tab stop (roving `tabindex`: exactly one cell/header is `0`, the rest
 * `-1`); arrow keys move both DOM focus and that tabbable position. Sort state is
 * exposed via `aria-sort` on headers, selection via `aria-selected` on rows.
 *
 * `selectionchange` dispatches `{ rows: HTMLElement[] }` when the user changes the
 * selection; `sort` dispatches
 * `{ column: HTMLElement, direction: "ascending" | "descending" | "none" }`.
 *
 * `reconcile` dispatches `{ rows: HTMLElement[] }` — the selected rows, as
 * `selectionchange` carries them — when the page moves the selection instead: a
 * selected row removed or dropped from the targets, a morph or a script writing
 * a row's `aria-selected` or a selected row's `data-value`, a selected row that
 * arrives ahead of the selection in `single` mode, or a runtime `selection` that
 * collapses it. One batch of such changes reports once, and only when the
 * selected rows or the values they submit differ from the selection last settled
 * — on connect, by the user, or by the previous `reconcile` — so connecting
 * reports nothing.
 *
 * With a `fields` target the selected rows are mirrored into `name`d hidden
 * inputs so the selection can be submitted and read server-side — one per
 * selected row that carries a `data-value`, in DOM order; a row without one
 * submits nothing. `form` points them at a `<form>` by id when the container
 * sits outside it. A selection the user made emits a native bubbling `change`
 * from the container, the way a form control does, so `stimeo--auto-submit` and
 * form-level validation hear it. The mirror is refreshed silently on connect,
 * on a replacement container, on row churn, and whenever `selection`, `name` or
 * `form` changes; a selection the page moved is reported by `reconcile` alone.
 *
 * @remarks
 * Behavior only — the consumer performs the actual data sort/render in response to
 * the `sort` event and owns all styling. While connected a `MutationObserver`
 * watches the rows' `aria-selected` and `data-value`, which a morph can rewrite
 * without adding or removing a target; `disconnect()` releases it and drops a
 * pending pass. `connect()` rebuilds the single tab stop idempotently from the
 * DOM, and the target callbacks rebuild it again after rows or cells are added or
 * removed at runtime.
 *
 * Behavior provided:
 * - `Arrow*` move between cells (clamped at edges); `Home`/`End` to the row's
 *   first/last cell; `Ctrl+Home`/`Ctrl+End` to the grid's first/last cell.
 * - `Enter`/`Space` cycles a header's sort (`none→ascending→descending`) or toggles
 *   the focused row's selection when selection is enabled.
 *
 * Consumer contract — controls nested inside a cell or header:
 * - APG's grid hosts working controls in its cells, so a keystroke or click that
 *   reached one — a nested button, link or form control, an editable host, or any
 *   widget that already called `preventDefault()` — is left to it entirely: no
 *   move, no sort, no selection. The one control that hands the event on is a
 *   sortable header's own `<button>`, whose activation is what the click carries.
 * - A control keeps its own Tab behavior, so give it `tabindex="-1"` to preserve
 *   the grid's single Tab stop. A sortable `columnheader` hosting a `<button>` is
 *   the common case: the roving position stays on the header, and the button's
 *   own activation reaches `sort` through the click that bubbles to it.
 * - Host `role="gridcell"` / `role="columnheader"` on a non-interactive element
 *   (`td`, `th`); an interactive host makes the grid stand down on that cell.
 */
export class DataGridController extends Controller<HTMLElement> {
  static override targets = ["columnHeader", "row", "cell", "fields"];
  static override values = {
    selection: { type: String, default: "none" },
    name: { type: String, default: "rows[]" },
    form: { type: String, default: "" },
  };
  static actions = ["onKeydown", "sort", "toggleSelect"] as const;
  static events = ["selectionchange", "sort", "reconcile"] as const;

  declare readonly columnHeaderTargets: HTMLElement[];
  declare readonly rowTargets: HTMLElement[];
  declare readonly cellTargets: HTMLElement[];
  declare readonly fieldsTarget: HTMLElement;
  declare readonly hasFieldsTarget: boolean;
  declare selectionValue: string;
  declare nameValue: string;
  declare formValue: string;

  /**
   * Collapses the target callbacks, Value changes and observed row writes of one
   * DOM mutation into a single pass, and refuses to run before `connect()` or
   * after `disconnect()`.
   *
   * Stimulus reports every target one at a time, so an ungated pass would re-walk
   * the whole grid once per authored cell on mount and once per streamed cell
   * afterwards — quadratic in the cell count both times.
   */
  readonly #reconcile = new MicrotaskCoalescer(() => this.#reconcileRows());
  /** Watches the row attributes a page can rewrite in place; set while connected. */
  #observer: MutationObserver | null = null;
  /** The selection last settled: on connect, by the user, or by a reported pass. */
  #settled: Selection = new Map();

  /**
   * Establishes a single tab stop across all navigable cells/headers, brings the
   * rows to their baseline, and settles the selection without reporting it.
   *
   * The whole baseline runs here rather than in the Value callbacks: Stimulus
   * delivers those before `connect()`, where the pass is refused, and a
   * re-attached element reuses its cached context, whose value observer does not
   * fire again.
   */
  override connect(): void {
    this.#restoreBaseline();
    this.#settled = this.#selection();
    this.#reconcile.activate();
    this.#observeRows();
  }

  /** Releases the row observer and drops a queued pass, so neither outlives the element. */
  override disconnect(): void {
    this.#reconcile.cancel();
    this.#observer?.disconnect();
    this.#observer = null;
  }

  /**
   * Rebuilds the DOM-owned baselines from the live grid: exactly one navigable
   * cell is in the Tab sequence, `aria-multiselectable` follows `selection`, every
   * selectable row carries an explicit `aria-selected`, and the fields mirror the
   * selected rows.
   *
   * The tab stop keeps whichever cell already holds it, so a rebuild triggered by
   * an unrelated row arriving does not throw the user's position away; only when
   * no cell holds it — the grid is fresh, or the holder was removed — does the
   * first navigable cell take over. Without that fallback a grid whose active row
   * is removed keeps every cell at `-1` and drops out of the Tab sequence
   * entirely.
   */
  #restoreBaseline(): void {
    const cells = this.#navigableCells();
    const active = cells.find((cell) => cell.tabIndex === 0) ?? cells[0];
    if (active) this.#setActiveCell(active, { focus: false }, cells);
    this.#syncSelectable();
    const pageWrote = this.#takePageRecords();
    this.#normalizeSelection();
    this.#dropOwnRecords(pageWrote);
    this.#mirrorFields(false);
  }

  /**
   * The pass the page's changes run: the baselines are rebuilt, then a selection
   * that moved is reported. The report comes last, so rows a subscriber rewrites
   * are the next pass's to settle.
   */
  #reconcileRows(): void {
    this.#restoreBaseline();
    this.#reportMove();
  }

  /**
   * Reports the selection as `reconcile` when it differs from the one last
   * settled. The settled selection is replaced before dispatching, so a move a
   * subscriber makes is measured against what it was told.
   */
  #reportMove(): void {
    const selection = this.#selection();
    if (sameSelection(selection, this.#settled)) return;
    this.#settled = selection;
    this.dispatch("reconcile", { detail: { rows: [...selection.keys()] } });
  }

  /**
   * Re-renders `aria-multiselectable`, the rows and the fields when application
   * code (or a Turbo morph) changes `selection` at runtime; a selection the new
   * mode collapses is reported as `reconcile`.
   */
  selectionValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Rebuilds the submitted fields when the public name changes at runtime. */
  nameValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Repoints the submitted fields when the owning form changes at runtime. */
  formValueChanged(): void {
    this.#reconcile.schedule();
  }

  /** Seeds a fields container inserted after connect from the current selection. */
  fieldsTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the baselines for a row added after connect. */
  rowTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Settles the selection again when a row leaves the grid or drops its target token. */
  rowTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a cell joins the grid after connect. */
  cellTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a cell leaves the grid. */
  cellTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a header joins the grid after connect. */
  columnHeaderTargetConnected(): void {
    this.#reconcile.schedule();
  }

  /** Re-establishes the tab stop when a header leaves the grid. */
  columnHeaderTargetDisconnected(): void {
    this.#reconcile.schedule();
  }

  /**
   * Brings the authored rows to the shape the APG requires, without changing
   * which rows the author chose.
   *
   * Every selectable row gets an explicit value — an absent `aria-selected` means
   * "not selectable" in ARIA, so a forgotten attribute hides a selectable row —
   * and a single-select grid keeps at most one `true`, first in DOM order.
   * A grid that declares `selection="none"` has no selectable rows, so the
   * attribute is removed rather than written: in ARIA its absence is what "not
   * selectable" looks like.
   *
   * @stimeoRenderRoot
   */
  #normalizeSelection(): void {
    const rows = this.rowTargets;
    if (this.selectionValue === "none") {
      // Reclaim, do not merely skip: a grid that *became* unselectable would
      // otherwise keep announcing rows as selected while the logic refuses to
      // change them. In ARIA the absence of the attribute is what "not
      // selectable" looks like, so the rows have to lose it outright.
      for (const row of rows) row.removeAttribute("aria-selected");
      return;
    }
    const single = this.selectionValue === "single";
    const first = rows.find((row) => row.getAttribute("aria-selected") === "true");
    for (const row of rows) {
      if (single) {
        setAttributeIfChanged(row, "aria-selected", row === first ? "true" : "false");
      } else if (row.getAttribute("aria-selected") !== "true") {
        setAttributeIfChanged(row, "aria-selected", "false");
      }
    }
  }

  /**
   * Mirrors `selection="multiple"` onto `aria-multiselectable` (APG Grid) so SRs
   * announce that more than one row can be selected; cleared for single/none so a
   * grid never carries a misleading attribute.
   *
   * @stimeoRenderRoot
   */
  #syncSelectable(): void {
    if (this.selectionValue === "multiple") {
      setAttributeIfChanged(this.element, "aria-multiselectable", "true");
    } else {
      this.element.removeAttribute("aria-multiselectable");
    }
  }

  /** Cycles the activated column header's sort and emits `sort`. */
  sort(event: Event): void {
    const header = event.currentTarget as HTMLElement;
    if (!this.columnHeaderTargets.includes(header)) return;
    if (event.defaultPrevented) return;
    // A sortable header hosts a `<button>`, and that button's activation is
    // exactly what this click carries, so it is the one control that does not
    // take the event away. A link or a field inside the header is its own
    // destination, and sorting on its click would act in parallel.
    const control = this.#claimingControl(event, header);
    if (control && !(control instanceof HTMLButtonElement)) return;

    const direction = nextSortDirection(header.getAttribute("aria-sort") ?? "none");

    // Only one column is sorted at a time: reset the others to `none`.
    for (const other of this.columnHeaderTargets) {
      other.setAttribute("aria-sort", other === header ? direction : "none");
    }

    this.#setActiveCell(header, { focus: false });
    this.dispatch("sort", { detail: { column: header, direction } });
  }

  /** Toggles selection of the row owning the event target. Bound optionally. */
  toggleSelect(event: Event): void {
    // The pointer path guards on `selection="none"` exactly as the keyboard path
    // does, so a grid that declares itself unselectable never grows selected rows.
    if (this.selectionValue === "none") return;
    // A widget that handled the click owns it, exactly as the keyboard path
    // stands down on a keystroke a descendant consumed.
    if (event.defaultPrevented) return;
    const host = event.currentTarget as HTMLElement;
    if (this.#claimedByDescendant(event, host)) return;
    const row = host.closest<HTMLElement>("[role='row']");
    if (row && this.rowTargets.includes(row)) this.#toggleRow(row);
  }

  /** Grid navigation + sort/select activation. Bound to cells and headers. */
  onKeydown(event: KeyboardEvent): void {
    // A descendant widget that already claimed the key (a grabbed drag handle, a
    // nested menu) must not ALSO act on it — composition depends on this yield.
    if (event.defaultPrevented) return;
    if (isReservedArrowChord(event)) return;
    if (event.isComposing) return;
    const cell = event.currentTarget as HTMLElement;
    // A native control inside the cell never calls `preventDefault()` — its
    // activation IS the default action — so the yield above cannot see it. This
    // recognises those by element shape instead.
    if (this.#claimedByDescendant(event, cell)) return;
    const matrix = this.#matrix();
    const position = this.#locate(matrix, cell);
    if (!position) return;
    const [row, col] = position;
    const rowCells = matrix[row] ?? [];

    let target: HTMLElement | undefined;
    // Logical, not physical. The key is normalised rather than the
    // delta negated: these two branches are not mirror images — their guards
    // differ — so swapping the key keeps each guard with its own direction.
    switch (logicalArrowKey(event.key, this.element)) {
      case "ArrowRight":
        target = this.#cellInRow(matrix, row, col + 1);
        break;
      case "ArrowLeft":
        target = this.#cellInRow(matrix, row, Math.max(col - 1, 0));
        break;
      case "ArrowDown":
        target = this.#cellInRow(matrix, Math.min(row + 1, matrix.length - 1), col);
        break;
      case "ArrowUp":
        target = this.#cellInRow(matrix, Math.max(row - 1, 0), col);
        break;
      case "Home":
        target = event.ctrlKey ? this.#cellInRow(matrix, 0, 0) : rowCells[0];
        break;
      case "End":
        target = event.ctrlKey
          ? this.#cellInRow(matrix, matrix.length - 1, Number.POSITIVE_INFINITY)
          : rowCells[rowCells.length - 1];
        break;
      case "Enter":
      case " ":
        this.#activate(cell);
        event.preventDefault();
        return;
      default:
        return;
    }

    if (target) {
      event.preventDefault();
      this.#setActiveCell(target, { focus: true }, matrix.flat());
    }
  }

  /**
   * Whether the event was addressed to a control inside `host` rather than to the
   * grid.
   *
   * Cells and headers hold consumer markup, and APG's grid pattern expects that
   * markup to include working controls — a row action button, an inline editor.
   * Those own their own keystrokes and clicks, so the grid stands down entirely
   * rather than acting in parallel. An editable host (its `contenteditable` state
   * is inherited, so the walk is explicit) counts the same way.
   */
  #claimedByDescendant(event: Event, host: HTMLElement): boolean {
    return this.#claimingControl(event, host) !== null;
  }

  /**
   * The nested control this event belongs to, or `null` when the host owns it.
   *
   * Naming the control, rather than answering yes or no, is what lets the click
   * path treat a sortable header's `<button>` as the activation it is while every
   * other control still takes the event away.
   */
  #claimingControl(event: Event, host: HTMLElement): HTMLElement | null {
    const source = event.target as HTMLElement;
    const control = source.closest<HTMLElement>(INTERACTIVE_HOST_SELECTOR);
    if (control && host.contains(control)) return control;
    return isInteractiveHost(source) ? source : null;
  }

  /**
   * Performs a header's sort or a cell row's selection toggle on activation.
   *
   * @stimeoRuntimeOnly `selection` decides whether this one activation toggles the row; the sort it
   *   cycles does not depend on it.
   */
  #activate(cell: HTMLElement): void {
    if (this.columnHeaderTargets.includes(cell)) {
      this.#cycleSort(cell);
      return;
    }
    if (this.selectionValue === "none") return;
    const row = cell.closest<HTMLElement>("[role='row']");
    if (row && this.rowTargets.includes(row)) this.#toggleRow(row);
  }

  /** Cycles a header's sort on keyboard activation and emits `sort`. */
  #cycleSort(header: HTMLElement): void {
    const direction = nextSortDirection(header.getAttribute("aria-sort") ?? "none");
    for (const other of this.columnHeaderTargets) {
      other.setAttribute("aria-sort", other === header ? direction : "none");
    }
    this.dispatch("sort", { detail: { column: header, direction } });
  }

  /**
   * Toggles a row's `aria-selected`, honoring single vs. multiple selection.
   *
   * @stimeoRuntimeOnly `selection` decides how this one toggle treats the other rows.
   */
  #toggleRow(row: HTMLElement): void {
    const selected = row.getAttribute("aria-selected") === "true";
    const pageWrote = this.#takePageRecords();
    // Enforce single-ness on every toggle, not only when turning a row on:
    // switching one *off* would otherwise leave a second `true` behind until
    // the next baseline pass.
    if (this.selectionValue === "single") {
      for (const other of this.rowTargets) {
        if (other !== row) setAttributeIfChanged(other, "aria-selected", "false");
      }
    }
    row.setAttribute("aria-selected", selected ? "false" : "true");
    this.#dropOwnRecords(pageWrote);

    // Settled before anything is reported, so a listener that moves the rows
    // again is measured against this selection.
    this.#settled = this.#selection();
    this.#mirrorFields(true);
    this.dispatch("selectionchange", { detail: { rows: [...this.#settled.keys()] } });
  }

  /** The selected rows in DOM order, each with the `data-value` it submits, if any. */
  #selection(): Selection {
    return new Map(
      this.rowTargets
        .filter((row) => row.getAttribute("aria-selected") === "true")
        .map((row) => [row, row.dataset.value] as const),
    );
  }

  /**
   * Watches the rows' `aria-selected` and `data-value`. Every write the grid makes
   * to them sits between a take and a drop of the observer's queue, so each record
   * the callback receives is the page's, and only a record on one of the grid's own
   * rows schedules a pass.
   */
  #observeRows(): void {
    const observer = new MutationObserver((records) => {
      if (this.#concernsRows(records)) this.#reconcile.schedule();
    });
    observer.observe(this.element, {
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    });
    this.#observer = observer;
  }

  /**
   * Empties the observer's queue before the grid writes to the rows, and says
   * whether the page had queued anything about them. Those records still owe a
   * pass: a toggle in `multiple` mode rewrites only its own row, so it does not fold
   * in what the page wrote to the others.
   */
  #takePageRecords(): boolean {
    const records = this.#observer?.takeRecords() ?? [];
    return records.length > 0 && this.#concernsRows(records);
  }

  /**
   * Whether any record is about one of this grid's own rows. A widget nested in a
   * cell writes the same attributes on its own elements, and those are no reason
   * to reconcile the grid.
   */
  #concernsRows(records: readonly MutationRecord[]): boolean {
    const rows = new Set<Node>(this.rowTargets);
    return records.some((record) => rows.has(record.target));
  }

  /**
   * Drops the records the grid's own writes just queued, so the observer never
   * takes them for the page's, then schedules the pass the page's records owe.
   */
  #dropOwnRecords(pageWrote: boolean): void {
    this.#observer?.takeRecords();
    if (pageWrote) this.#reconcile.schedule();
  }

  /**
   * Mirrors the selected rows' `data-value` into the optional fields container.
   * A selected row without one submits nothing, so a grid whose rows carry no
   * value submits an empty set rather than a row of blanks.
   *
   * @stimeoRenderRoot
   */
  #mirrorFields(notify: boolean): void {
    if (!this.hasFieldsTarget) return;
    const values = this.rowTargets
      .filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => row.dataset.value)
      .filter((value): value is string => value !== undefined);
    const options = { name: this.nameValue, form: this.formValue };
    if (writeFields(this.fieldsTarget, values, options) && notify) {
      commitField(this.fieldsTarget);
    }
  }

  /**
   * Makes `cell` the single tabbable cell (roving) and optionally focuses it.
   *
   * `cells` lets a caller that already walked the grid hand its collection over,
   * so one keystroke rebuilds the matrix once instead of twice. The write is
   * skipped where the attribute already holds the wanted value — comparing the
   * attribute rather than the IDL property, because a cell with no `tabindex` at
   * all reports `-1` and would then never receive the attribute it needs to be
   * focusable.
   */
  #setActiveCell(
    cell: HTMLElement,
    { focus }: { focus: boolean },
    cells?: readonly HTMLElement[],
  ): void {
    for (const candidate of cells ?? this.#navigableCells()) {
      const wanted = candidate === cell ? "0" : "-1";
      if (candidate.getAttribute("tabindex") !== wanted) {
        candidate.setAttribute("tabindex", wanted);
      }
    }
    if (focus) cell.focus();
  }

  /** All navigable elements (headers + cells) in DOM order. */
  #navigableCells(): HTMLElement[] {
    return this.#matrix().flat();
  }

  /** The grid as rows of navigable cells, derived from each `role="row"`. */
  #matrix(): HTMLElement[][] {
    const navigable = new Set<HTMLElement>([...this.columnHeaderTargets, ...this.cellTargets]);
    const rows = Array.from(this.element.querySelectorAll<HTMLElement>("[role='row']"));
    return rows
      .map((row) =>
        Array.from(row.children).filter((child): child is HTMLElement =>
          navigable.has(child as HTMLElement),
        ),
      )
      .filter((cells) => cells.length > 0);
  }

  /** Finds `[rowIndex, colIndex]` of `cell` within `matrix`, or null. */
  #locate(matrix: HTMLElement[][], cell: HTMLElement): [number, number] | null {
    for (let row = 0; row < matrix.length; row++) {
      const col = (matrix[row] ?? []).indexOf(cell);
      if (col !== -1) return [row, col];
    }
    return null;
  }

  /** The cell at `[row, col]`, clamping `col` to that row's last cell. */
  #cellInRow(matrix: HTMLElement[][], row: number, col: number): HTMLElement | undefined {
    const cells = matrix[row];
    if (!cells || cells.length === 0) return undefined;
    return cells[Math.min(col, cells.length - 1)];
  }
}
