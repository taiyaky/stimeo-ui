import { sharedRegistry } from "./shared_registry";

/** What a consumer declares once about the regions one boolean state reveals. */
export interface StateRegionsOptions {
  /** Returns the declared regions shown while the state holds. */
  readonly whenTrue: () => readonly HTMLElement[];
  /**
   * Returns the declared regions shown while the state does not hold. Omitted by a
   * state whose other side has nothing of its own to show.
   */
  readonly whenFalse?: () => readonly HTMLElement[];
}

/** One instance's hold on one region's `hidden`, in the stack every instance shares. */
interface RegionHold {
  /** The instance holding it; `null` for a hold read from a copy's record until it is taken. */
  instance: object | null;
  readonly record: string;
  /** What the author wrote: the `hidden` it hands back with nothing beneath it. */
  readonly authored: string | null;
  /** Whether the visibility it wrote last hides the region. */
  written: boolean;
  /** Whether it hands back what the hold beneath it wrote last instead. */
  linked: boolean;
}

/** What an instance's record on a region says. */
interface RegionRecord {
  readonly authored: string | null;
  readonly written: boolean;
  readonly linked: boolean;
  /** The records of the other owners' holds beneath it, nearest first. */
  readonly beneath: readonly string[];
}

/** The holds on each region and every instance's record name. */
interface StateRegionsRegistry {
  readonly stacks: WeakMap<HTMLElement, RegionHold[]>;
  readonly names: Set<string>;
}

/**
 * Owns `hidden` on the regions a boolean state reveals.
 *
 * A region is a **declared** target, so the consumer decides whether one exists at
 * all; where it does, which side is shown is a pure function of the state and the
 * controller writes it unconditionally. An authored `hidden` is therefore not read
 * back — the first reflection after a connection settles it, and a restored DOM
 * cannot leave a region contradicting the state it belongs to.
 *
 * The regions arrive as the caller's own target arrays, which Stimulus has already
 * scoped to this instance: a nested controller registered under the same identifier
 * keeps its own regions. `host` narrows that set further, to the regions inside one
 * trigger or item, so a widget with several of them reflects each independently.
 *
 * **Two sides are a pair.** Where the state has a `whenFalse` side and only one half
 * sits inside `host`, the half that is there is left in view: hiding it would take
 * the only label with it, and the static check names the missing one instead. What
 * the author wrote on a lone half is theirs and stays — only a half this instance
 * took out of view is given back, which is what a pair losing one side at runtime
 * leaves behind.
 *
 * `hidden` moves only where it changes, and the record below only where what it says changes:
 * a transition costs a consumer watching its own subtree for attribute mutations two of them on
 * each region it moves — `hidden` and the record — and a reflection that moves nothing costs
 * none. A write that moves no `hidden` — the page moved the region first, or another
 * instance's hold lies above this one — changes only the record.
 *
 * **Every instance shares one stack of holds per region**, whatever its owner and whichever
 * file of the package constructed it (the stacks are one per page): the holds sit in the order
 * their instances first wrote the region, each with the visibility it wrote last. The region's
 * visibility is the highest hold's that carries it, and the page's when none does. A write
 * moves `hidden` unless a hold above the writer carries the region's visibility, so the top
 * hold always shows its writes and the page's visibility gives way to the next write of any
 * hold. A release gives a visibility back only from the hold the region's visibility is: the
 * one the hold beneath it wrote last, or the author's `hidden` once nothing is beneath it; any
 * other release only leaves the stack. Holds that wrote the same visibility are told apart by
 * the stack: the higher one keeps it. A first write over a top hold whose visibility the page
 * has replaced takes the region's `hidden` as the author's. Two instances of one owner on one
 * region stack the same way.
 *
 * **The stack travels with the region.** While the region carries anything but what the author
 * wrote under its top hold, or a hold lies on another hold or is covered by one, the region
 * carries that hold's owner's record `data-<owner>-hidden-region`: JSON of what the author
 * wrote (a string, or `null` for an absent attribute), whether the visibility written last
 * hides the region, `false` where the hold hands back the author's `hidden` rather than the
 * latest visibility of the hold beneath it, and the records of every hold beneath it, nearest
 * first; the last release of an owner removes it. A copy of the region — a page Turbo restores
 * from its cache — therefore carries the stack, read back under the record names of the
 * instances constructed so far and ordered by the records each hold lists beneath it, and an
 * instance that reflects, gives back or releases the copy takes the hold its owner's record
 * describes over in place. Complete records for distinct owners preserve their order across
 * a copy, including release without a new reflection. Records describe owners, not instances:
 * one owner holding the region more than once leaves only its topmost hold's record, which
 * the first of its instances to write or release on the copy takes. Its lower holds and
 * positions are absent; mutually listed owners cannot express their full live order. A hold
 * that showed the author's `hidden` alone carries no record and is taken by its first write
 * on the copy. Missing or unreadable records also leave their holds unknown, so copying the
 * DOM does not promise identical decisions for every live stack. A new stack with no readable
 * record takes the current value as the author's; a morph can remove records while existing
 * holds remain in memory until released.
 *
 * @example
 * ```ts
 * readonly #labels = new StateRegions(
 *   {
 *     whenTrue: () => this.expandedLabelTargets,
 *     whenFalse: () => this.collapsedLabelTargets,
 *   },
 *   this.identifier,
 * );
 *
 * #reflect(): void {
 *   this.#labels.reflect(this.triggerTarget, this.#expanded);
 * }
 * ```
 */
export class StateRegions {
  /** The holds on each region, bottom first, and the record names; one per page. */
  static readonly #registry = sharedRegistry(
    "stimeo-ui.state-regions.registry.v1",
    (): StateRegionsRegistry => ({ stacks: new WeakMap(), names: new Set() }),
  );
  readonly #whenTrue: () => readonly HTMLElement[];
  readonly #whenFalse: (() => readonly HTMLElement[]) | null;
  readonly #record: string;

  /**
   * @param options - The declared regions of each side.
   * @param owner - Names the record on a region; the controller's identifier.
   */
  constructor(options: StateRegionsOptions, owner: string) {
    this.#whenTrue = options.whenTrue;
    this.#whenFalse = options.whenFalse ?? null;
    this.#record = `data-${owner}-hidden-region`;
    StateRegions.#registry.names.add(this.#record);
  }

  /** Shows the regions inside `host` that belong to `isTrue` and hides the others. */
  reflect(host: Element, isTrue: boolean): void {
    const shown = this.#inside(host, this.#whenTrue());
    if (!this.#whenFalse) {
      for (const region of shown) this.#write(region, !isTrue);
      return;
    }
    const hiddenSide = this.#inside(host, this.#whenFalse());
    if (shown.length === 0 || hiddenSide.length === 0) {
      for (const region of shown) this.#give(region);
      for (const region of hiddenSide) this.#give(region);
      return;
    }
    for (const region of shown) this.#write(region, !isTrue);
    for (const region of hiddenSide) this.#write(region, isTrue);
  }

  /**
   * Restores the regions this instance wrote inside `host` to what the hold beneath it wrote last
   * or the authored `hidden`, unless changed since; found by scan, as the declared lists stop
   * resolving with targets.
   */
  release(host: Element): void {
    for (const region of [host, ...host.querySelectorAll("*")]) {
      if (!(region instanceof HTMLElement)) continue;
      const stack = this.#held(region);
      const hold = stack && this.#take(stack);
      if (!stack || !hold) continue;
      const owns = region.hidden === hold.written && !this.#covered(region, stack, hold);
      const index = stack.indexOf(hold);
      stack.splice(index, 1);
      const above = stack[index];
      if (above) above.linked &&= hold.linked;
      if (owns) {
        const below = hold.linked ? stack[index - 1] : undefined;
        if (below) {
          if (region.hidden !== below.written) region.hidden = below.written;
        } else if (region.getAttribute("hidden") !== hold.authored) {
          if (hold.authored === null) region.removeAttribute("hidden");
          else region.setAttribute("hidden", hold.authored);
        }
      }
      this.#mark(region, stack);
    }
  }

  /** Writes `hidden` where it moves, unless a hold above this one carries the region's. */
  #write(region: HTMLElement, hidden: boolean): void {
    const stack = this.#stack(region);
    const hold = this.#take(stack) ?? this.#acquire(region, stack);
    const shows = !this.#covered(region, stack, hold);
    hold.written = hidden;
    if (shows && region.hidden !== hidden) region.hidden = hidden;
    this.#mark(region, stack);
  }

  /** Returns a region this instance hid; one it never hid keeps what it carries. */
  #give(region: HTMLElement): void {
    const stack = this.#held(region);
    if (stack && this.#take(stack)?.written) this.#write(region, false);
  }

  /** The region's stack, while it has one or carries this owner's record. */
  #held(region: HTMLElement): RegionHold[] | undefined {
    return StateRegions.#registry.stacks.has(region) || region.hasAttribute(this.#record)
      ? this.#stack(region)
      : undefined;
  }

  /** The region's stack, read from its records the first time. */
  #stack(region: HTMLElement): RegionHold[] {
    const stacks = StateRegions.#registry.stacks;
    const stack = stacks.get(region) ?? this.#seed(region);
    stacks.set(region, stack);
    return stack;
  }

  /** The holds a copy's records describe, each above every hold its record lists beneath. */
  #seed(region: HTMLElement): RegionHold[] {
    const found: (RegionRecord & { readonly record: string })[] = [];
    for (const record of StateRegions.#registry.names) {
      const read = this.#recorded(region, record);
      if (read) found.push({ ...read, record });
    }
    const depth = ({ beneath }: (typeof found)[number]) =>
      beneath.filter((name) => found.some((other) => other.record === name)).length;
    return found
      .sort((one, other) => depth(one) - depth(other))
      .map(({ record, authored, written, linked }, index) => ({
        instance: null,
        record,
        authored,
        written,
        linked: linked && index > 0,
      }));
  }

  /** Its hold in `stack`, taking over one read from its record. */
  #take(stack: RegionHold[]): RegionHold | undefined {
    const hold =
      stack.find((held) => held.instance === this) ??
      stack.find((held) => held.instance === null && held.record === this.#record);
    if (hold) hold.instance = this;
    return hold;
  }

  /** Whether a hold above `hold` carries the region's visibility, then that hold's. */
  #covered(region: HTMLElement, stack: readonly RegionHold[], hold: RegionHold): boolean {
    return stack.slice(stack.indexOf(hold) + 1).some((above) => above.written === region.hidden);
  }

  /** A new hold on top, over the top hold while the region shows what it wrote. */
  #acquire(region: HTMLElement, stack: RegionHold[]): RegionHold {
    const top = stack.at(-1);
    const over = top && region.hidden === top.written ? top : undefined;
    const hold: RegionHold = {
      instance: this,
      record: this.#record,
      authored: over ? over.authored : region.getAttribute("hidden"),
      written: false,
      linked: over !== undefined,
    };
    stack.push(hold);
    return hold;
  }

  /** Leaves each owner's record of its topmost hold, or none where nothing needs one. */
  #mark(region: HTMLElement, stack: readonly RegionHold[]): void {
    const records = new Map<string, string | null>([[this.#record, null]]);
    stack.forEach((hold, index) => {
      const names = stack.slice(0, index).map((under) => under.record);
      const beneath = [...new Set(names.reverse())].filter((name) => name !== hold.record);
      const marker = hold.linked || beneath.length === 0 ? [] : [false];
      records.set(
        hold.record,
        region.getAttribute("hidden") === hold.authored &&
          beneath.length === 0 &&
          index === stack.length - 1
          ? null
          : JSON.stringify([hold.authored, hold.written, ...marker, ...beneath]),
      );
    });
    for (const [name, recorded] of records) {
      if (region.getAttribute(name) === recorded) continue;
      if (recorded === null) region.removeAttribute(name);
      else region.setAttribute(name, recorded);
    }
  }

  /**
   * The author's `hidden`, the visibility written last, whether it hands back the visibility
   * beneath it (`false` before the names when it does not) and the records beneath that the
   * record `name` on `region` holds.
   */
  #recorded(region: HTMLElement, name: string): RegionRecord | null {
    try {
      const parsed: unknown = JSON.parse(region.getAttribute(name) ?? "null");
      if (!Array.isArray(parsed)) return null;
      const [authored, written, ...rest] = parsed as unknown[];
      if (authored !== null && typeof authored !== "string") return null;
      const linked = rest[0] !== false;
      const beneath = linked ? rest : rest.slice(1);
      if (!beneath.every((under): under is string => typeof under === "string")) return null;
      return typeof written === "boolean" ? { authored, written, linked, beneath } : null;
    } catch {
      return null;
    }
  }

  /** The declared regions that sit within `host`, which may be the host itself. */
  #inside(host: Element, regions: readonly HTMLElement[]): HTMLElement[] {
    return regions.filter((region) => host.contains(region));
  }
}
