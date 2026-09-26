/**
 * The attribute selector for one declared target, in a controller's own namespace.
 *
 * Stimulus reads `data-<identifier>-target` as a **space-separated token list**, so a
 * single element can carry several target names at once. Matching the attribute value
 * whole would reach only the elements that declare exactly one name, which is why the
 * name is paired with `~=`.
 *
 * `identifier` is the name the controller is registered under, so the selector reaches
 * the markup that registration renders rather than one fixed spelling.
 */
export function targetSelector(identifier: string, name: string): string {
  return `[data-${identifier}-target~="${name}"]`;
}
