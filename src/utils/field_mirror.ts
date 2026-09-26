/**
 * The hidden form fields a widget keeps in step with the state it owns.
 *
 * A widget whose value lives in ARIA attributes submits nothing on its own, so
 * it mirrors that value into `<input type="hidden">` — one field for a single
 * value, a container of generated fields for a set. The mirror is one-way: the
 * widget's own state stays the source of truth and the field is what the form
 * reads.
 *
 * The write and the report are separate calls because they answer to different
 * rules. A mirror is refreshed on connect, after a morph, and whenever the
 * widget repairs itself — none of which a form should treat as an edit. Only
 * the user's own commit reports one, which is why {@link commitField} is never
 * folded into the writes.
 */

/** How a widget's generated fields identify themselves to the form. */
export interface GeneratedFieldOptions {
  /** The `name` every generated input submits under. */
  readonly name: string;
  /** The `form` id, for a widget that sits outside the form it submits to. */
  readonly form?: string;
}

/**
 * Mirrors one value into a hidden field.
 *
 * @returns Whether the field's value moved.
 *
 * @example
 * ```ts
 * if (writeField(this.fieldTarget, String(value)) && userDriven) {
 *   commitField(this.fieldTarget);
 * }
 * ```
 */
export function writeField(field: HTMLInputElement, value: string): boolean {
  if (field.value === value) return false;
  field.value = value;
  return true;
}

/**
 * Mirrors a set of values into `container` as generated hidden fields, in the
 * order given.
 *
 * A container that already submits exactly this set is left untouched, children
 * and all — the mirror is refreshed far more often than it moves (every connect,
 * morph and repair), and a rebuild that changes nothing is still a DOM mutation
 * a consumer's observer and a `:empty` rule can see.
 *
 * @returns Whether the submitted set moved — its values, their order, the
 *   `name`, or the `form`.
 */
export function writeFields(
  container: HTMLElement,
  values: readonly string[],
  { name, form = "" }: GeneratedFieldOptions,
): boolean {
  const current = [...container.children];
  const submits =
    current.length === values.length &&
    current.every(
      (child, index) =>
        child instanceof HTMLInputElement &&
        child.type === "hidden" &&
        child.value === values[index] &&
        child.name === name &&
        (child.getAttribute("form") ?? "") === form,
    );
  if (submits) return false;

  container.replaceChildren(
    ...values.map((value) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      if (form !== "") input.setAttribute("form", form);
      return input;
    }),
  );
  return true;
}

/**
 * Reports a committed value from `target` the way a native form control does:
 * one bubbling, non-cancelable `change`.
 *
 * Call it only for a move the user made. Form-level behaviors listen for this —
 * validation re-checks, auto-submit — and a mirror refreshed by a morph or a
 * repair is not something the user submitted.
 *
 * `target` is the element that carries the value: the hidden field for a single
 * mirrored value, the container for a generated set (whose own inputs are
 * replaced on every write), or a widget's own native control where that is what
 * the form reads.
 */
export function commitField(target: HTMLElement): void {
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Reports an edit a widget made on the user's behalf, the way the browser
 * reports its own: one bubbling `input`, then one bubbling `change`.
 *
 * This is for a widget that owns the stepping or picking its *own* native
 * control would otherwise do — writing `control.value` from script fires
 * nothing, so a form listening for either event never hears the edit. Use
 * {@link commitField} instead where the element is a mirror of state held
 * elsewhere: a hidden field has no native edit to imitate, so it reports the
 * commit alone.
 *
 * Call it only for a move the user made, and only where the widget really did
 * the writing — an edit the browser already reported would be doubled.
 */
export function commitEdit(control: HTMLElement): void {
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}
