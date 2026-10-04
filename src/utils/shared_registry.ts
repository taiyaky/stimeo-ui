/**
 * One registry per page for every copy of the library.
 *
 * Each `stimeo-ui/controllers/*` file, and each opt-in entry, is built on its own and carries
 * its own copy of every utility it uses, so a page that imports controllers one by one, or one
 * of them next to the barrel, evaluates a utility several times. A registry that coordinates
 * instances of different controllers — the stacks of leased values, the loans of a
 * `tabindex`, the Escape layers, the focus traps — must not be split by that: a dialog inside
 * a drawer, or a character counter and a form field on one input, coordinate whichever files
 * they came from. So such a registry lives once on `globalThis`, under a `Symbol.for` key the
 * copies agree on, and the first copy to ask for it creates it.
 *
 * The key names the registry and the version of its shape
 * (`stimeo-ui.<utility>.registry.v<n>`). Copies whose registries have the same shape share
 * one; a release that changes the shape changes the version, so a copy of another release
 * keeps a registry of its own instead of reading entries it does not understand — the two
 * then coordinate within each release only. An entry another copy put in a registry is read
 * through its fields alone, never through `#private` members, which belong to the class of
 * the copy that created it.
 */

/**
 * The registry stored under `key`, created by `create` on first use.
 *
 * @param key - `stimeo-ui.<utility>.registry.v<n>`: the version is that of the shape `create`
 *   returns.
 * @param create - Builds the empty registry.
 */
export function sharedRegistry<T extends object>(key: string, create: () => T): T {
  const symbol = Symbol.for(key);
  const scope = globalThis as unknown as Record<symbol, T | undefined>;
  const existing = scope[symbol];
  if (existing !== undefined) return existing;
  const registry = create();
  Object.defineProperty(globalThis, symbol, { value: registry });
  return registry;
}
