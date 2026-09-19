/**
 * Resolves which of a controller's elements owns a node.
 *
 * A delegated listener hears events from a whole subtree, so the handler's first
 * job is almost always the same question: which item, handle, or control does
 * this `event.target` belong to? The same question comes up for a
 * `MutationRecord.target`, for `document.activeElement`, and for a
 * `relatedTarget` on the way out of a hover region.
 *
 * The answer is `Node.contains()`, which is **inclusive** — an element contains
 * itself — so testing the candidate for identity as well would be redundant.
 *
 * **The guard is what makes this safe to call with a raw event target.**
 * `event.target` is typed `EventTarget | null`, and `contains()` takes a `Node?`:
 * browsers throw `TypeError` for anything else, and `window` — the everyday
 * `EventTarget` that is not a `Node` — is what an event dispatched at it carries.
 * Narrowing here means a caller never has to cast, and the rule cannot drift
 * between the places that ask the question.
 *
 * Scope stays with the caller. These helpers say *which candidate owns the node*,
 * not *whether the node belongs to this controller at all* — a component with
 * nested instances of itself decides that first (by comparing the closest
 * annotated ancestor) and passes the candidates it owns.
 */

/**
 * Index in `candidates` of the first one that is, or contains, `node`.
 *
 * `-1` when none does, when `node` is absent, and when it is an `EventTarget`
 * that is not a `Node`. Candidates are tested in array order, so a nested pair
 * resolves to whichever the caller listed first.
 */
export function ownerIndex<T extends Element>(
  candidates: readonly T[],
  node: EventTarget | null | undefined,
): number {
  if (!(node instanceof Node)) return -1;
  return candidates.findIndex((candidate) => candidate.contains(node));
}

/**
 * The first candidate that is, or contains, `node`; `null` when none does.
 *
 * A miss indexes the array at `-1`, which reads as `undefined` and lands on the
 * same `null` the absent cases produce.
 */
export function ownerOf<T extends Element>(
  candidates: readonly T[],
  node: EventTarget | null | undefined,
): T | null {
  return candidates[ownerIndex(candidates, node)] ?? null;
}
