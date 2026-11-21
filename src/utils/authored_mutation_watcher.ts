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

/** Observation and claims owned by one connected lifetime. */
interface MutationLifetime {
  observer: MutationObserver | null;
  active: boolean;
  readonly claims: MutationClaims;
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
  #lifetime: MutationLifetime | null = null;

  /** @param onAuthored - Receives a nonempty batch after controller records are excluded. */
  constructor(onAuthored: (records: MutationRecord[]) => void) {
    this.#onAuthored = onAuthored;
  }

  /**
   * Starts a new connected lifetime, including the root's current ancestor chain.
   * Options and their attribute iterators are read once before registration. A
   * synchronous later observe or disconnect retires this attempt; a failure
   * releases its partial observation and preserves the later lifetime and error.
   */
  observe(root: Element, options: AuthoredMutationOptions): void {
    const previous = this.#lifetime;
    const lifetime: MutationLifetime = {
      observer: null,
      active: false,
      claims: { attributes: new Map(), children: new Map() },
    };
    this.#lifetime = lifetime;
    let observer: MutationObserver | null = null;
    try {
      if (previous) this.#release(previous);
      if (this.#lifetime !== lifetime) return;
      const attributes = [...options.attributes];
      const subtree = options.subtree ?? false;
      const childList = options.childList ?? false;
      const inherited = options.ancestorAttributes;
      const ancestorAttributes = inherited ? [...inherited] : null;
      if (this.#lifetime !== lifetime) return;
      observer = new MutationObserver((records) => {
        const authored = this.#filter(records, lifetime.claims);
        if (this.#lifetime === lifetime && lifetime.active && authored.length > 0) {
          this.#onAuthored(authored);
        }
      });
      if (this.#lifetime !== lifetime) return;
      lifetime.observer = observer;
      observer.observe(root, { attributes: true, attributeFilter: attributes, subtree, childList });
      if (this.#lifetime !== lifetime) {
        this.#release(lifetime, observer);
        return;
      }
      if (ancestorAttributes) {
        let ancestor = root.parentElement;
        while (ancestor) {
          observer.observe(ancestor, { attributes: true, attributeFilter: ancestorAttributes });
          if (this.#lifetime !== lifetime) {
            this.#release(lifetime, observer);
            return;
          }
          ancestor = ancestor.parentElement;
        }
      }
      lifetime.active = true;
    } catch (error) {
      this.#release(lifetime, observer);
      throw error;
    }
  }

  /** Claims one actual attribute write; calls outside observation own no records. */
  claim(target: Element, name: string, value: string | null): void {
    const lifetime = this.#lifetime;
    if (!lifetime?.active) return;
    const claims = lifetime.claims.attributes;
    let attributes = claims.get(target);
    if (!attributes) {
      attributes = new Map();
      claims.set(target, attributes);
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
    const lifetime = this.#lifetime;
    if (!lifetime?.active) return;
    const claims = lifetime.claims.children;
    const pending = claims.get(target) ?? { added: new Map(), removed: new Map() };
    for (const node of added) pending.added.set(node, (pending.added.get(node) ?? 0) + 1);
    for (const node of removed) pending.removed.set(node, (pending.removed.get(node) ?? 0) + 1);
    claims.set(target, pending);
  }

  /** Returns queued authored records synchronously and expires every pending claim. */
  take(): MutationRecord[] {
    const lifetime = this.#lifetime;
    const observer = lifetime?.observer;
    if (!lifetime?.active || !observer) return [];
    const records = observer.takeRecords();
    const authored = this.#filter(records, lifetime.claims);
    return this.#lifetime === lifetime && lifetime.active ? authored : [];
  }

  /** Releases observation and claimed node references; safe to repeat and reuse later. */
  disconnect(): void {
    const lifetime = this.#lifetime;
    if (lifetime) this.#release(lifetime);
  }

  /** Retires this owner before releasing its observer and retained claim targets. */
  #release(
    lifetime: MutationLifetime,
    observer: MutationObserver | null = lifetime.observer,
  ): void {
    if (this.#lifetime === lifetime) this.#lifetime = null;
    lifetime.claims.attributes.clear();
    lifetime.claims.children.clear();
    observer?.disconnect();
  }

  /** Applies one batch's claims before handing control back to the consumer. */
  #filter(records: MutationRecord[], claims: MutationClaims): MutationRecord[] {
    const authored = records.filter((record) => !this.#consume(record, claims));
    claims.attributes.clear();
    claims.children.clear();
    return authored;
  }

  /**
   * Matches the native attribute or nonempty child-list records this watcher registers.
   * @see https://dom.spec.whatwg.org/#queue-a-tree-mutation-record
   */
  #consume(record: MutationRecord, claims: MutationClaims): boolean {
    if (record.type === "attributes") {
      const target = record.target as Element;
      const pending = claims.attributes.get(target)?.get(record.attributeName as string);
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
    const pending = claims.children.get(record.target);
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
