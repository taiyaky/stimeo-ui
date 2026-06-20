/**
 * Pure helpers for recognizing `stimeo--*` attributes within parsed markup.
 *
 * These functions know nothing about files or the manifest — they only decode
 * Stimulus's attribute conventions, scoped strictly to the `stimeo--`
 * namespace so a consumer's own controllers are never inspected.
 */

const NAMESPACE_PREFIX = "stimeo--";

/**
 * Converts a Stimulus value name to its attribute token, mirroring Stimulus's
 * own dasherize (e.g. `rootMargin` → `root-margin`).
 */
export function dasherize(value: string): string {
  return value.replace(/([A-Z])/g, (_match, char: string) => `-${char.toLowerCase()}`);
}

/** Extracts the `stimeo--*` identifiers listed in a `data-controller` value.
 * Duplicates are collapsed (Stimulus connects a repeated identifier once), which
 * keeps downstream scope-based diagnostics from being reported multiple times. */
export function controllerIdentifiers(dataControllerValue: string): string[] {
  const seen = new Set<string>();
  for (const token of dataControllerValue.split(/\s+/)) {
    if (token.startsWith(NAMESPACE_PREFIX)) seen.add(token);
  }
  return [...seen];
}

/**
 * If `attrName` is an Stimeo target attribute (`data-{identifier}-target`),
 * returns the controller identifier; otherwise `null`.
 */
export function parseTargetAttr(attrName: string): string | null {
  const match = /^data-(stimeo--[a-z0-9][a-z0-9-]*)-target$/.exec(attrName);
  return match?.[1] ?? null;
}

/** Result of decoding a `data-{identifier}-{value}-value` attribute. */
export interface ParsedValueAttr {
  /** Resolved identifier, or `null` when it matches no known controller. */
  readonly identifier: string | null;
  /** The dasherized value token (e.g. `root-margin`), best-effort when unresolved. */
  readonly valueToken: string;
}

/**
 * Decodes an Stimeo value attribute (`data-{identifier}-{value}-value`).
 *
 * Identifiers may themselves contain hyphens (e.g. `stimeo--command-palette`),
 * so the boundary between identifier and value name is ambiguous from the
 * attribute name alone. We disambiguate against the set of known identifiers,
 * preferring the longest match.
 *
 * @param attrName - The lowercased attribute name.
 * @param knownIdentifiers - All identifiers present in the manifest.
 * @returns The decoded attribute, or `null` if it is not an Stimeo value attr.
 */
export function parseValueAttr(
  attrName: string,
  knownIdentifiers: readonly string[],
): ParsedValueAttr | null {
  const match = /^data-(stimeo--[a-z0-9-]+)-value$/.exec(attrName);
  if (!match) return null;
  const inner = match[1] ?? ""; // identifier + "-" + valueToken

  let best: { identifier: string; valueToken: string } | null = null;
  for (const id of knownIdentifiers) {
    if (inner.startsWith(`${id}-`)) {
      const valueToken = inner.slice(id.length + 1);
      if (valueToken.length > 0 && (!best || id.length > best.identifier.length)) {
        best = { identifier: id, valueToken };
      }
    }
  }
  if (best) return best;

  // Unknown identifier: best-effort split at the first segment after the prefix.
  const rest = inner.slice(NAMESPACE_PREFIX.length);
  const dash = rest.indexOf("-");
  const identifierGuess = dash === -1 ? inner : `${NAMESPACE_PREFIX}${rest.slice(0, dash)}`;
  const valueGuess = dash === -1 ? "" : rest.slice(dash + 1);
  return { identifier: null, valueToken: valueGuess || identifierGuess };
}

/** An Stimeo `data-action` descriptor decoded into its controller and method. */
export interface ActionDescriptor {
  /** The `stimeo--*` controller identifier (e.g. `stimeo--menu`). */
  readonly identifier: string;
  /** The action method name after `#` (e.g. `toggle`), or `""` if absent. */
  readonly method: string;
}

/**
 * Decodes the Stimeo `data-action` descriptors in an attribute value, e.g.
 * `click->stimeo--menu#toggle keydown->stimeo--menu#onItemKeydown` yields one
 * entry per descriptor. Non-`stimeo--` controllers are skipped (their action
 * surface is out of scope). The method name is read up to the first action
 * option (`:prevent`, `:stop`, …), mirroring Stimulus's descriptor grammar.
 */
export function actionDescriptors(dataActionValue: string): ActionDescriptor[] {
  const descriptors: ActionDescriptor[] = [];
  for (const descriptor of dataActionValue.split(/\s+/)) {
    const hash = descriptor.indexOf("#");
    if (hash === -1) continue;
    let lhs = descriptor.slice(0, hash);
    const arrow = lhs.indexOf("->");
    if (arrow !== -1) lhs = lhs.slice(arrow + 2);
    if (!lhs.startsWith(NAMESPACE_PREFIX)) continue;
    const method = /^[a-zA-Z_$][\w$]*/.exec(descriptor.slice(hash + 1))?.[0] ?? "";
    descriptors.push({ identifier: lhs, method });
  }
  return descriptors;
}

/**
 * Extracts the `stimeo--*` controller identifiers referenced in a
 * `data-action` value, e.g. `click->stimeo--menu#toggle` yields
 * `["stimeo--menu"]`. Convenience wrapper over {@link actionDescriptors}.
 */
export function actionIdentifiers(dataActionValue: string): string[] {
  return actionDescriptors(dataActionValue).map((d) => d.identifier);
}

/** Whether an attribute name belongs to the Stimeo namespace. */
export function isStimeoDataAttr(attrName: string): boolean {
  return attrName.startsWith(`data-${NAMESPACE_PREFIX}`);
}
