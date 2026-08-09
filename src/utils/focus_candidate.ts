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
 * focus are checked: `hidden` (an ancestor's counts), the native `disabled`
 * property, and `disabled` inherited from an ancestor `fieldset`. CSS-only
 * invisibility is not detectable here and stays the consumer's problem.
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
  if (element.closest("[hidden]")) return false;
  if (!("disabled" in element)) return true;
  if ((element as HTMLElement & { disabled: boolean }).disabled) return false;
  return !inheritsFieldsetDisabled(element);
}
