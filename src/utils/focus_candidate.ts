/**
 * Whether a disabled `<fieldset>` ancestor actually reaches `control`.
 *
 * HTML exempts the contents of a fieldset's **first direct-child `<legend>`**, and
 * the exemption is per fieldset — a control legal in one legend can still be
 * disabled by a second, outer fieldset, so the walk continues upward.
 *
 * Exported for the consumer that needs this rule *without* the rest of
 * {@link canTakeFocus}: `toolbar` bounds its own `hidden` walk at the toolbar
 * root, which is a different rule, so it composes the two itself.
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
 * such items reachable. Only the three conditions that make the platform refuse
 * focus are checked: `hidden` / `inert` (an ancestor's counts),
 * `input[type="hidden"]`, the native `disabled` property, and `disabled`
 * inherited from an ancestor `fieldset`. CSS-only invisibility is handled by
 * {@link isRenderedForFocus} when a consumer needs sequential-focus semantics.
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
  if (element.closest("[hidden], [inert]")) return false;
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
function authoredTabindex(element: HTMLElement): number | null {
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
