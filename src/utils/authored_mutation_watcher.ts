/** The retained attributes, descendants, and inherited state one connection watches. */
export interface AuthoredMutationOptions {
  readonly attributes: readonly string[];
  readonly subtree?: boolean;
  readonly childList?: boolean;
  readonly ancestorAttributes?: readonly string[];
}

/** A final attribute value and the number of records its writes produce. */
interface AttributeClaim {
  value: string | null;
  count: number;
}

/** Added and removed nodes still represented by controller-owned child-list records. */
interface ChildClaim {
  readonly added: Map<Node, number>;
  readonly removed: Map<Node, number>;
}

/** Pending claims belong only to the active observed lifetime. */
interface MutationClaims {
  readonly attributes: Map<Element, Map<string, AttributeClaim>>;
  readonly children: Map<Node, ChildClaim>;
}

/**
 * Watches authored mutations without suspending observation during DOM repair.
 *
 * The consumer claims only actual writes, before an attribute write or immediately
 * after a synchronous helper writes. Matching uses the final value and one claim
 * per record, so an extra same-value page write remains authored. Child-list claims
 * identify the nodes a replacement adds and removes, independently of how the DOM
 * implementation splits those nodes into records. Every delivery or synchronous
 * take expires all claims before the consumer can move focus or notify subscribers.
 * Ownership, reconciliation, and DOM writes remain the consumer's responsibility.
 */
export class AuthoredMutationWatcher {
  readonly #onAuthored: (records: MutationRecord[]) => void;
  #claims: MutationClaims | null = null;
  #observer: MutationObserver | null = null;

  /** @param onAuthored - Receives a nonempty batch after controller records are excluded. */
  constructor(onAuthored: (records: MutationRecord[]) => void) {
    this.#onAuthored = onAuthored;
  }

  /** Starts a new connected lifetime, including the root's current ancestor chain. */
  observe(root: Element, options: AuthoredMutationOptions): void {
    this.disconnect();
    const observer = new MutationObserver((records) => {
      if (this.#observer !== observer) return;
      const authored = this.#filter(records);
      if (authored.length > 0) this.#onAuthored(authored);
    });
    this.#observer = observer;
    this.#claims = { attributes: new Map(), children: new Map() };
    observer.observe(root, {
      attributes: true,
      attributeFilter: [...options.attributes],
      subtree: options.subtree ?? false,
      childList: options.childList ?? false,
    });
    if (options.ancestorAttributes) {
      let ancestor = root.parentElement;
      while (ancestor) {
        observer.observe(ancestor, {
          attributes: true,
          attributeFilter: [...options.ancestorAttributes],
        });
        ancestor = ancestor.parentElement;
      }
    }
  }

  /** Claims one actual attribute write; calls outside observation own no records. */
  claim(target: Element, name: string, value: string | null): void {
    const claims = this.#claims?.attributes;
    let attributes = claims?.get(target);
    if (!attributes) {
      attributes = new Map();
      claims?.set(target, attributes);
    }
    const pending = attributes.get(name);
    attributes.set(name, { value, count: (pending?.count ?? 0) + 1 });
  }

  /** Claims a synchronous helper's actual attribute write before any external callback runs. */
  claimCurrent(target: Element, name: string): void {
    this.claim(target, name, target.getAttribute(name));
  }

  /** Claims the actual nodes added and removed by one synchronous child replacement. */
  claimChildList(target: Node, added: readonly Node[], removed: readonly Node[]): void {
    const claims = this.#claims?.children;
    const pending = claims?.get(target) ?? { added: new Map(), removed: new Map() };
    for (const node of added) pending.added.set(node, (pending.added.get(node) ?? 0) + 1);
    for (const node of removed) pending.removed.set(node, (pending.removed.get(node) ?? 0) + 1);
    claims?.set(target, pending);
  }

  /** Returns queued authored records synchronously and expires every pending claim. */
  take(): MutationRecord[] {
    return this.#filter(this.#observer?.takeRecords() ?? []);
  }

  /** Releases observation and claims; safe to repeat and reuse on a later connection. */
  disconnect(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#claims = null;
  }

  /** Applies one batch's claims before handing control back to the consumer. */
  #filter(records: MutationRecord[]): MutationRecord[] {
    const authored = records.filter((record) => !this.#consume(record));
    this.#claims?.attributes.clear();
    this.#claims?.children.clear();
    return authored;
  }

  /**
   * Matches the native attribute or nonempty child-list records this watcher registers.
   * @see https://dom.spec.whatwg.org/#queue-a-tree-mutation-record
   */
  #consume(record: MutationRecord): boolean {
    if (record.type === "attributes") {
      const target = record.target as Element;
      const pending = this.#claims?.attributes.get(target)?.get(record.attributeName as string);
      if (
        !pending ||
        pending.count === 0 ||
        target.getAttribute(record.attributeName as string) !== pending.value
      ) {
        return false;
      }
      pending.count -= 1;
      return true;
    }
    const pending = this.#claims?.children.get(record.target);
    if (!pending) return false;
    const added = [...record.addedNodes];
    const removed = [...record.removedNodes];
    if (
      added.some((node) => !pending.added.get(node)) ||
      removed.some((node) => !pending.removed.get(node))
    ) {
      return false;
    }
    for (const node of added) pending.added.set(node, (pending.added.get(node) ?? 0) - 1);
    for (const node of removed) pending.removed.set(node, (pending.removed.get(node) ?? 0) - 1);
    return true;
  }
}
