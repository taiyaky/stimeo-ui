/**
 * Whether a disabled `<fieldset>` ancestor actually reaches `control`.
 *
 * HTML exempts the contents of a fieldset's **first direct-child `<legend>`**, and
 * the exemption is per fieldset — a control legal in one legend can still be
 * disabled by a second, outer fieldset, so the walk continues upward.
 *
 * Exported on its own for callers that need the disabled-inheritance rule without
 * the rest of {@link canTakeFocus} — a control's availability check, or a `hidden`
 * walk bounded at a widget root, which is a different rule to compose with.
 */
export function inheritsFieldsetDisabled(control: HTMLElement): boolean {
  let fieldset: Element | null = control.closest("fieldset[disabled]");
  while (fieldset) {
    const legend = Array.from(fieldset.children).find((child) => child.tagName === "LEGEND");
    if (!legend?.contains(control)) return true;
    fieldset = fieldset.parentElement?.closest("fieldset[disabled]") ?? null;
  }
  return false;
}

/**
 * Whether the engine reports `element` assigned to no slot of the open shadow root its parent
 * hosts: such an element is not in the flat tree, so it and what it holds are rendered nowhere
 * and cannot take focus.
 */
function unslotted(element: Element): boolean {
  return element.assignedSlot === null && element.parentElement?.shadowRoot != null;
}

/**
 * The parent of `element` in the flat tree: the slot it is assigned to, its parent element,
 * or the host of the shadow root it is a child of; `null` at the top of the document or of a
 * detached tree, and for an element the engine assigns to no slot of the open shadow root its
 * parent hosts, which is outside the flat tree. A closed shadow root does not report its slots,
 * so an element assigned to one climbs to the host.
 */
export function flatTreeParent(element: Element): Element | null {
  if (unslotted(element)) return null;
  const parent = element.assignedSlot ?? element.parentNode;
  if (parent instanceof ShadowRoot) return parent.host;
  return parent instanceof Element ? parent : null;
}

/** Whether `element` is `ancestor` or one of its descendants in the flat tree. */
export function flatTreeContains(ancestor: Element, element: Element | null): boolean {
  for (let node = element; node; node = flatTreeParent(node)) {
    if (node === ancestor) return true;
  }
  return false;
}

/** The nearest of `element` and its flat-tree ancestors that matches `selector`, or `null`. */
export function closestInFlatTree(element: Element, selector: string): Element | null {
  for (let node: Element | null = element; node; node = flatTreeParent(node)) {
    if (node.matches(selector)) return node;
  }
  return null;
}

/**
 * The children of `element` in the flat tree: its open shadow root's children, a slot's
 * assigned elements (its own children when nothing is assigned to it), or its children.
 */
export function flatTreeChildren(element: Element): Element[] {
  return ownedScope(element) ?? Array.from(element.children);
}

/**
 * Whether an element can actually take focus, checked **before** `focus()` runs.
 *
 * A controller that must move focus off a control it is about to disable or hide
 * picks a destination and calls `focus()` on it. If that destination cannot take
 * focus, the call **fails silently**: `hidden` and natively `disabled` elements
 * swallow it, so the caret stays in the subtree that is disappearing and lands on
 * `<body>` a frame later — the exact outcome the rescue exists to prevent, minus
 * any signal that it happened.
 *
 * Testing after the fact is the obvious alternative and is deliberately not the
 * rule. Reading `document.activeElement` back only works in a real browser, and
 * looping over candidates that way performs a real focus move per failure —
 * observable to assistive technology. Checking first costs nothing and catches
 * the cases that actually occur.
 *
 * **`aria-disabled` is not disqualifying.** It is the attribute an author uses
 * for a control that must stay *discoverable*, and the roving contract keeps
 * such items reachable. Only the conditions that make the platform refuse
 * focus are checked: `hidden` / `inert` on the element or a flat-tree ancestor
 * (the host of an open shadow root it sits in, the slot it is assigned to), the
 * element or an ancestor left out of the flat tree (one the engine assigns to no
 * slot of the open shadow root its parent hosts), `input[type="hidden"]`, the
 * native `disabled` property, and `disabled` inherited from an ancestor
 * `fieldset`. CSS-only invisibility is handled by {@link isRenderedForFocus}
 * when a consumer needs sequential-focus semantics.
 *
 * Reading `:disabled` instead of walking the fieldset chain would be shorter, but
 * that pseudo-class is not evaluated consistently outside real browsers and this
 * has to be right headlessly too. happy-dom in particular focuses a `<button>`
 * inside a disabled fieldset where a real engine refuses, so the inheritance is
 * spelled out rather than delegated.
 *
 * What a consumer does when nothing survives is its own call: some fall back to
 * their landmark, while a widget whose caret already sits somewhere legitimate
 * refuses the move outright rather than relocating it.
 *
 * @example
 * ```ts
 * const target = candidates.find(canTakeFocus);
 * if (target) target.focus();
 * else {
 *   this.#tabindex.lend(this.element); // nothing left: fall back to the landmark
 *   this.element.focus();
 * }
 * ```
 *
 * @param element - the candidate destination
 */
export function canTakeFocus(element: HTMLElement): boolean {
  for (let node: Element | null = element; node; node = flatTreeParent(node)) {
    if (unslotted(node) || node.matches("[hidden], [inert]")) return false;
  }
  if (element instanceof HTMLInputElement && element.type === "hidden") return false;
  if (!("disabled" in element)) return true;
  if ((element as HTMLElement & { disabled: boolean }).disabled) return false;
  return !inheritsFieldsetDisabled(element);
}

/** Elements whose semantics or authored attributes can place them in sequential focus order. */
export const TAB_STOP_CANDIDATE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[tabindex]",
  "[contenteditable]",
].join(",");

/** Optional browser visibility API used to exclude CSS-hidden candidates. */
interface VisibilityCheckable {
  checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
}

/** Whether CSS visibility allows an otherwise eligible element to participate in focus order. */
export function isRenderedForFocus(element: HTMLElement): boolean {
  const check = (element as HTMLElement & VisibilityCheckable).checkVisibility;
  return typeof check === "function" ? check.call(element, { visibilityProperty: true }) : true;
}

/** Parses an authored `tabindex`; invalid syntax has no explicit focus-order meaning. */
function authoredTabindex(element: Element): number | null {
  const value = element.getAttribute("tabindex");
  if (value === null || !/^[+-]?\d+$/.test(value.trim())) return null;
  return Number(value);
}

/** Whether the element's native semantics place it in sequential focus order. */
function hasNativeTabStop(element: HTMLElement): boolean {
  if (element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) {
    return element.hasAttribute("href");
  }
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  ) {
    return true;
  }
  if (element instanceof HTMLInputElement) return element.type !== "hidden";
  if (element instanceof HTMLIFrameElement) return true;
  if (element.tagName === "AUDIO" || element.tagName === "VIDEO") {
    return element.hasAttribute("controls");
  }
  if (element instanceof HTMLElement && element.tagName === "SUMMARY") {
    const details = element.parentElement;
    return (
      details instanceof HTMLDetailsElement &&
      Array.from(details.children).find((child) => child.tagName === "SUMMARY") === element
    );
  }
  return false;
}

/** Whether an explicit `contenteditable` value creates an editable tab stop. */
function hasEditableTabStop(element: HTMLElement): boolean {
  const value = element.getAttribute("contenteditable")?.toLowerCase();
  return value === "" || value === "true" || value === "plaintext-only";
}

/**
 * Whether an element is a usable sequential Tab stop right now.
 *
 * Native semantics, authored `tabindex`, editable hosts, inherited disabled state,
 * HTML `hidden`/`inert`, and CSS visibility are evaluated together. `aria-disabled`
 * remains focusable because it communicates unavailability without removing the
 * control from discovery order.
 */
export function isTabStop(element: HTMLElement): boolean {
  if (!canTakeFocus(element) || !isRenderedForFocus(element)) return false;

  const tabindex = authoredTabindex(element);
  if (tabindex !== null) return tabindex >= 0;
  return hasNativeTabStop(element) || hasEditableTabStop(element);
}

/** Returns every usable sequential Tab stop below `root` in document order. */
export function tabStopsWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TAB_STOP_CANDIDATE_SELECTOR)).filter(
    isTabStop,
  );
}

/** Returns the first usable sequential Tab stop below `root`, if one exists. */
export function firstTabStop(root: ParentNode): HTMLElement | null {
  for (const candidate of root.querySelectorAll<HTMLElement>(TAB_STOP_CANDIDATE_SELECTOR)) {
    if (isTabStop(candidate)) return candidate;
  }
  return null;
}

/** Whether `root` contains at least one usable sequential Tab stop. */
export function hasTabStop(root: ParentNode): boolean {
  return firstTabStop(root) !== null;
}

/** An element sequential focus navigation can stop on. */
export type TabStopElement = HTMLElement | SVGElement;

/** Whether the element is a radio button. */
function isRadio(element: Element | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === "radio";
}

/**
 * Whether two radios form one group: the same non-empty `name`, the same form owner and
 * the same tree. A radio without a name is a group of its own.
 */
function sameRadioGroup(a: HTMLInputElement, b: HTMLInputElement): boolean {
  return (
    a.name !== "" && a.name === b.name && a.form === b.form && a.getRootNode() === b.getRootNode()
  );
}

/**
 * Whether the element is part of editable content: the nearest ancestor that sets a valid
 * `contenteditable` decides. `false` ends the editable region (a non-editable island
 * inside an editor); an invalid value inherits from further up.
 */
function isInEditableContent(element: Element): boolean {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.getAttribute("contenteditable")?.toLowerCase() === "false") return false;
    if (hasEditableTabStop(node)) return true;
  }
  return false;
}

/** The XLink namespace, where an SVG link may carry its `href`. */
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** Whether the element is an SVG link: an SVG `a` with `href` or `xlink:href`. */
function isSvgLink(element: Element): boolean {
  return (
    element instanceof SVGElement &&
    element.localName === "a" &&
    (element.hasAttribute("href") || element.hasAttributeNS(XLINK_NAMESPACE, "href"))
  );
}

/**
 * Whether an image-map area has a rendered image: an `img` in the area's tree whose
 * `usemap` names the area's map (by `name`, or by `id` without one) and that is rendered.
 * The area has no box of its own for {@link isRenderedForFocus} to check.
 */
function hasRenderedImage(area: HTMLAreaElement): boolean {
  const map = area.closest("map");
  const key = map?.name || map?.id;
  if (!map || !key) return false;
  const root = map.getRootNode() as Document | ShadowRoot;
  return Array.from(root.querySelectorAll<HTMLElement>("img[usemap]")).some(
    (image) => image.getAttribute("usemap") === `#${key}` && isRenderedForFocus(image),
  );
}

/** Whether the element can take focus and has no negative `tabindex`. */
function isFocusableInOrder(element: TabStopElement): boolean {
  const tabindex = authoredTabindex(element);
  return (tabindex === null || tabindex >= 0) && canTakeFocus(element as HTMLElement);
}

/**
 * The engine's verdict for the stops {@link isTabStop} does not judge the way sequential
 * navigation does, or `null` for every other element: an image-map area with an `href` or
 * its own `tabindex` stops while an image that uses its map is rendered; an object stops
 * while it holds a nested document, as an iframe does; an SVG link stops while it is
 * rendered. Each also needs to take focus and not be taken out of the order with a
 * negative `tabindex`.
 */
function extraStop(element: TabStopElement): boolean | null {
  if (element instanceof HTMLAreaElement) {
    const focusable = element.hasAttribute("href") || authoredTabindex(element) !== null;
    return focusable && isFocusableInOrder(element) && hasRenderedImage(element);
  }
  if (element instanceof HTMLObjectElement) {
    return (
      isFocusableInOrder(element) && isRenderedForFocus(element) && element.contentWindow !== null
    );
  }
  if (isSvgLink(element))
    return isFocusableInOrder(element) && isRenderedForFocus(element as HTMLElement);
  return null;
}

/**
 * Whether sequential navigation stops on the element: a usable Tab stop
 * ({@link isTabStop}), or one of the stops `extraStop` judges, except a link inside
 * editable content without a `tabindex` of its own, which the engine leaves to editing.
 * Other controls inside an editing host, and the host itself, stay stops.
 */
function isSequentialStop(element: TabStopElement): boolean {
  const stop =
    extraStop(element) ??
    (element.matches(TAB_STOP_CANDIDATE_SELECTOR) && isTabStop(element as HTMLElement));
  if (!stop) return false;
  const link =
    element instanceof HTMLAnchorElement ||
    element instanceof HTMLAreaElement ||
    isSvgLink(element);
  return !(link && authoredTabindex(element) === null && isInEditableContent(element));
}

/**
 * The elements of the focus navigation scope `element` owns: its open shadow root's
 * children, or a slot's assigned elements (its fallback content when nothing is
 * assigned). `null` when it owns no scope. A closed shadow root cannot be read, so its
 * host owns none.
 */
function ownedScope(element: Element): Element[] | null {
  if (element.shadowRoot) return Array.from(element.shadowRoot.children);
  if (element instanceof HTMLSlotElement) {
    const assigned = element.assignedElements();
    return assigned.length > 0 ? assigned : Array.from(element.children);
  }
  return null;
}

/** One member of a focus navigation scope: its tabindex and the stops it contributes. */
interface ScopeEntry {
  readonly tabindex: number;
  readonly stops: TabStopElement[];
}

/** What a walk of the order records besides the order itself. */
interface OrderWalk {
  /** The element a move starts from. */
  readonly from: Element | null;
  /** Every stop, in flat-tree order. */
  readonly tree: TabStopElement[];
  /** How many entries of {@link OrderWalk.tree} come before `from`; `-1` until the walk meets it. */
  fromAt: number;
}

/**
 * Orders one focus navigation scope the way HTML's sequential navigation does: members
 * with a positive `tabindex` first, ascending, ties in tree order, then the rest in tree
 * order. A member that owns a scope (a shadow host, a slot) is followed by that scope's
 * own order; one taken out of the order with a negative `tabindex` takes its scope with it.
 */
function orderScope(elements: Element[], walk: OrderWalk): TabStopElement[] {
  const entries: ScopeEntry[] = [];
  const visit = (element: Element): void => {
    if (element === walk.from) walk.fromAt = walk.tree.length;
    const tabindex = authoredTabindex(element) ?? 0;
    const stop =
      (element instanceof HTMLElement || element instanceof SVGElement) && isSequentialStop(element)
        ? element
        : null;
    if (stop) walk.tree.push(stop);
    const owned = ownedScope(element);
    if (owned) {
      if (tabindex >= 0) {
        entries.push({ tabindex, stops: [...(stop ? [stop] : []), ...orderScope(owned, walk)] });
      }
      return;
    }
    if (stop) entries.push({ tabindex, stops: [stop] });
    for (const child of Array.from(element.children)) visit(child);
  };
  for (const element of elements) visit(element);
  const positive = entries.filter((entry) => entry.tabindex > 0);
  positive.sort((a, b) => a.tabindex - b.tabindex);
  const rest = entries.filter((entry) => entry.tabindex === 0);
  return [...positive, ...rest].flatMap((entry) => entry.stops);
}

/**
 * Whether a candidate passes the radio-group rule the engine applies: a checked radio
 * among the stops always does; an unchecked one only as the first radio of a group with
 * no checked stop, and not while focus is on a radio of that group. `tree` is the walk's
 * stops in flat-tree order, so a group is counted within the walked root only.
 */
function passesRadioRule(
  element: TabStopElement,
  tree: TabStopElement[],
  focusedRadio: HTMLInputElement | null,
): boolean {
  if (!isRadio(element) || element.checked) return true;
  const group = tree.filter(
    (stop): stop is HTMLInputElement =>
      stop === element || (isRadio(stop) && sameRadioGroup(stop, element)),
  );
  if (group.some((radio) => radio.checked)) return false;
  if (group[0] !== element) return false;
  return focusedRadio === null || !sameRadioGroup(focusedRadio, element);
}

/**
 * The index in `order` a move from the walk's `from` visits first. A start the walk did
 * not meet is outside: the move enters at the first stop, or the last going backward. A
 * start that is a stop moves one place along the order. Any other start (the root, an
 * element with a negative `tabindex`) moves to the nearest stop after it in tree order,
 * or before it going backward, and wraps when there is none.
 */
function startIndex(
  order: TabStopElement[],
  walk: OrderWalk,
  backward: boolean,
  isStop: (element: TabStopElement) => boolean,
): number {
  if (walk.fromAt < 0) return backward ? order.length - 1 : 0;
  const at = order.indexOf(walk.from as TabStopElement);
  if (at >= 0) return backward ? at - 1 : at + 1;
  const neighbour = backward
    ? walk.tree.slice(0, walk.fromAt).reverse().find(isStop)
    : walk.tree.slice(walk.fromAt).find(isStop);
  if (neighbour) return order.indexOf(neighbour);
  return backward ? order.length - 1 : 0;
}

/**
 * The stops below `root` in the order a sequential move from `from` visits them: the
 * next stop first (the previous one when `backward`), wrapping at the ends, with `from`
 * itself left out. Without a `from` — or with one outside `root` — the list starts at the
 * first stop, or at the last one when `backward`.
 *
 * The order is HTML's sequential navigation order within `root`: positive `tabindex`
 * first, ascending, then `tabindex="0"` and native stops in tree order. Open shadow roots
 * are walked in flat-tree order, slots expanded, each scope ordered on its own; a closed
 * shadow root is not read. A radio group, counted within `root`, stops once: on its
 * checked radio when that radio can take focus, even with focus elsewhere in the group,
 * and otherwise on its first radio that can, unless focus is already in the group.
 * A link inside editable content without its own `tabindex` is not a stop. Every stop
 * also passes its applicable focusability and rendering checks.
 *
 * @param root - The element whose descendants are ordered; it is not a stop itself.
 * @param from - Where the move starts, usually {@link deepActiveElement}.
 * @param backward - Whether the move goes backward (`Shift+Tab`).
 */
export function sequentialTabStops(
  root: Element,
  from: Element | null = null,
  backward = false,
): TabStopElement[] {
  const walk: OrderWalk = { from, tree: [], fromAt: from === root ? 0 : -1 };
  const order = orderScope(ownedScope(root) ?? Array.from(root.children), walk);
  const focusedRadio = walk.fromAt >= 0 && isRadio(from) ? from : null;
  const isStop = (element: TabStopElement): boolean =>
    passesRadioRule(element, walk.tree, focusedRadio);
  const start = startIndex(order, walk, backward, isStop);
  const visited = backward
    ? [...order.slice(0, start + 1).reverse(), ...order.slice(start + 1).reverse()]
    : [...order.slice(start), ...order.slice(0, start)];
  return visited.filter((element) => element !== from && isStop(element));
}

/**
 * The element that holds focus in `ownerDocument`, looking through open shadow roots:
 * `document.activeElement` stops at a shadow host. A closed shadow root cannot be read,
 * so focus inside one reads as its host.
 */
export function deepActiveElement(ownerDocument: Document): Element | null {
  let active = ownerDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
