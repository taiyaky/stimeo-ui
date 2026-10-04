import { expect, onTestFinished } from "vitest";
import { FocusTrap } from "../../src/utils/focus_trap";
import { typeKey } from "./keyboard";
import { tick } from "./timing";

/**
 * Helpers for a modal opened over another modal it is not nested in, while the target the
 * modal below traps is replaced.
 */

/**
 * A modal opened over the one a test drives without being nested in it: a sibling at the
 * end of `<body>` with its own {@link FocusTrap}, where a page's confirm bridge sits when a
 * dialog asks it. While it is open its content is operable and takes focus, `Tab` and
 * `Escape`, and the modal below it is background.
 */
export interface UpperModal {
  /** The modal's container. */
  readonly element: HTMLElement;
  /** The button activation focuses. */
  readonly first: HTMLButtonElement;
  /** The button after it. */
  readonly second: HTMLButtonElement;
  /** How many `Escape` presses this modal took. */
  escapes(): number;
  /** Whether nothing makes the modal `inert`. */
  operable(): boolean;
}

/**
 * Appends an {@link UpperModal} to `<body>` and opens it from wherever focus is. `Escape`
 * hides and releases it, which returns focus to where it was opened from. A modal still open
 * when the test finishes is released without moving focus.
 */
export function openUpperModal(): UpperModal {
  const element = document.createElement("div");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-modal", "true");
  element.setAttribute("aria-label", "Upper modal");
  element.innerHTML = '<button type="button">Yes</button><button type="button">No</button>';
  document.body.append(element);
  const [first, second] = Array.from(element.querySelectorAll("button"));
  if (!first || !second) throw new Error("the upper modal lost its buttons");
  let escapes = 0;
  const trap = new FocusTrap(() => element, {
    onEscape: () => {
      escapes += 1;
      element.hidden = true;
      trap.deactivate();
    },
  });
  trap.activate();
  onTestFinished(() => trap.deactivate({ restoreFocus: false }));
  return {
    element,
    first,
    second,
    escapes: () => escapes,
    operable: () => element.closest("[inert]") === null,
  };
}

/** Replaces `original` with `successor` and waits until Stimulus has delivered the callbacks. */
type Swap = (original: HTMLElement, successor: HTMLElement) => Promise<void>;

/**
 * The two ways a page replaces a singular target: in one task, and by inserting the
 * successor after it and removing the earlier one in a later task. For `it.each`.
 */
export const TARGET_SWAPS: ReadonlyArray<readonly [string, Swap]> = [
  [
    "in one task",
    async (original, successor) => {
      original.replaceWith(successor);
      await tick();
    },
  ],
  [
    "when the earlier one leaves in a later task",
    async (original, successor) => {
      original.after(successor);
      await tick();
      original.remove();
      await tick();
    },
  ],
];

/**
 * Asserts that `upper` is still the modal on top after the modal below it moved onto
 * `lower`: the upper modal is operable and keeps focus and `Tab` while `lower` is
 * background, and `Escape` closes the upper modal, after which `lower` is operable again
 * and takes focus, since the element the upper modal was opened from left with the old
 * container.
 */
export function expectUpperModalOnTop(upper: UpperModal, lower: HTMLElement): void {
  expect(upper.operable()).toBe(true);
  expect(document.activeElement).toBe(upper.first);
  expect(lower.closest("[inert]")).not.toBeNull();
  typeKey(upper.first, "Tab");
  expect(document.activeElement).toBe(upper.second);
  typeKey(upper.second, "Escape");
  expect(upper.escapes()).toBe(1);
  expect(lower.closest("[inert]")).toBeNull();
  expect(lower.contains(document.activeElement)).toBe(true);
}
