/**
 * Native interactive elements whose built-in activation must not be replaced
 * wholesale by a controller. Deliberately excludes `[tabindex]`: a generic
 * element made focusable is the supported host for several headless patterns.
 * Contenteditable is handled by {@link isInteractiveHost} because its state is
 * inherited and its keywords are ASCII-case-insensitive.
 */
export const INTERACTIVE_HOST_SELECTOR =
  "button, input, select, textarea, label, a[href], area[href], summary, details, audio[controls], video[controls], iframe, object, embed";

/**
 * Whether an element owns native activation or an inherited editing surface.
 *
 * The `contenteditable` missing and invalid states inherit. Walking explicitly
 * also keeps `contenteditable="false"` as a real boundary inside an editable
 * ancestor instead of treating any ancestor attribute as decisive.
 */
export function isInteractiveHost(element: HTMLElement): boolean {
  if (element.matches(INTERACTIVE_HOST_SELECTOR)) return true;

  let current: HTMLElement | null = element;
  while (current) {
    const raw = current.getAttribute("contenteditable");
    if (raw !== null) {
      const value = raw.trim().toLowerCase();
      if (value === "false") return false;
      if (value === "" || value === "true" || value === "plaintext-only") return true;
    }
    current = current.parentElement;
  }
  return false;
}
