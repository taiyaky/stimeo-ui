import { Application } from "@hotwired/stimulus";
import { afterEach, expect, it } from "vitest";
import { disconnectAndStopApplication } from "./stimulus";
import { tick } from "./timing";

/**
 * Records the listeners registered on the page and whether the DOM still holds
 * each one, whatever released it: a matching `removeEventListener`, or the abort
 * of the signal it was added with.
 *
 * A teardown test that spies on `removeEventListener` only sees one of those two
 * ways out, so it fails for a controller that releases through a signal and
 * passes for one that removes with the wrong capture flag. The ledger instead
 * applies the DOM's own rules to every call and answers what is still live:
 *
 * - a registration is identified by its target, type, callback and capture flag,
 *   and repeating one that is live adds nothing — the repeat's signal is not
 *   recorded either, because the DOM ignores it too;
 * - `removeEventListener` releases the live registration with the same four;
 * - aborting the signal a registration was added with releases it, and a
 *   registration made with an already aborted signal is never live.
 *
 * Registrations whose target is an `AbortSignal` are the DOM's own bookkeeping
 * for the `signal` option and are not recorded. A `once` registration stays live
 * in the ledger until it is removed or its signal aborts; nothing that records
 * here relies on `once`.
 *
 * The ledger keeps the DOM's rules where happy-dom departs from them: happy-dom
 * still delivers to a listener added with an already aborted signal, which a
 * browser never registers, and its `removeEventListener` releases a listener
 * whatever capture flag the call names, where a browser keeps one whose flag
 * differs. A removal with the wrong flag therefore passes a delivery check in
 * this environment and still shows here as live.
 *
 * Call {@link recordListeners} where the recording should start, and
 * {@link ListenerLedger.restore} in the teardown. A ledger a test left recording
 * is restored after that test as well, so a failed expectation cannot leave the
 * patched methods in place for the tests after it.
 */

/** One registration and whether the DOM still holds it. */
export interface ListenerRecord {
  readonly target: EventTarget;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly capture: boolean;
  live: boolean;
}

/** What {@link recordListeners} returns. */
export interface ListenerLedger {
  /** The registrations still live, narrowed to one target and type when given. */
  live(target?: EventTarget, type?: string): ListenerRecord[];
  /** Puts the original methods back; the records stay readable. */
  restore(): void;
}

type AddListener = EventTarget["addEventListener"];
type RemoveListener = EventTarget["removeEventListener"];

/** The object that owns `addEventListener` for `start`: a prototype, or `start` itself. */
const ownerOf = (start: object): EventTarget => {
  let owner = start;
  while (!Object.hasOwn(owner, "addEventListener")) owner = Object.getPrototypeOf(owner) as object;
  return owner as EventTarget;
};

const captureOf = (options: unknown): boolean =>
  typeof options === "boolean"
    ? options
    : Boolean((options as EventListenerOptions | undefined)?.capture);

const signalOf = (options: unknown): AbortSignal | undefined =>
  typeof options === "object" && options !== null
    ? (options as AddEventListenerOptions).signal
    : undefined;

/** The ledgers still recording, oldest first; each one restores itself once. */
const recording = new Set<ListenerLedger>();

afterEach(() => {
  // The newest ledger patched over the older ones, so it is put back first.
  for (const ledger of [...recording].reverse()) ledger.restore();
});

/**
 * Starts recording every registration made on an element, a document, `window`
 * or any other target that shares their `addEventListener`.
 */
export function recordListeners(): ListenerLedger {
  const records: ListenerRecord[] = [];
  // Under the test environment `window` can carry its own bound methods, so its
  // owner is patched alongside the prototype elements and documents share.
  const owners = new Set([ownerOf(document.body ?? document), ownerOf(document), ownerOf(window)]);
  const prototypeAdd = ownerOf(document).addEventListener;
  const originals = new Map<EventTarget, { add: AddListener; remove: RemoveListener }>();

  const find = (
    target: EventTarget,
    type: string,
    listener: unknown,
    capture: boolean,
  ): ListenerRecord | undefined =>
    records.find(
      (record) =>
        record.live &&
        record.target === target &&
        record.type === type &&
        record.listener === listener &&
        record.capture === capture,
    );

  for (const owner of owners) {
    const add = owner.addEventListener;
    const remove = owner.removeEventListener;
    originals.set(owner, { add, remove });
    owner.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      const capture = captureOf(options);
      const signal = signalOf(options);
      if (
        listener &&
        !(this instanceof AbortSignal) &&
        !signal?.aborted &&
        !find(this, type, listener, capture)
      ) {
        const record: ListenerRecord = { target: this, type, listener, capture, live: true };
        records.push(record);
        if (signal) {
          prototypeAdd.call(signal, "abort", () => {
            record.live = false;
          });
        }
      }
      add.call(this, type, listener, options);
    };
    owner.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      const record = find(this, type, listener, captureOf(options));
      if (record) record.live = false;
      remove.call(this, type, listener, options);
    };
  }

  const ledger: ListenerLedger = {
    live: (target, type) =>
      records.filter(
        (record) =>
          record.live &&
          (target === undefined || record.target === target) &&
          (type === undefined || record.type === type),
      ),
    restore: () => {
      // A second call would put back what a newer ledger has since patched over.
      if (!recording.delete(ledger)) return;
      for (const [owner, { add, remove }] of originals) {
        owner.addEventListener = add;
        owner.removeEventListener = remove;
      }
    },
  };
  recording.add(ledger);
  return ledger;
}

/** Markup and declared exceptions for {@link describeListenerRelease}. */
export interface ListenerReleaseOptions {
  /** Markup for an identifier whose controller needs a particular host element. */
  readonly markup?: Readonly<Record<string, (identifier: string) => string>>;
  /**
   * Registrations a controller keeps for the document's life by design, keyed by
   * identifier: each entry names the target and type, and needs its reason at the
   * call site.
   */
  readonly documentLifetime?: Readonly<
    Record<string, readonly { readonly target: () => EventTarget; readonly type: string }[]>
  >;
}

/** A host carrying the target names most controllers look for, so each connects its listeners. */
const defaultMarkup = (identifier: string): string =>
  `<div id="host" data-controller="${identifier}" tabindex="0">` +
  `<input data-${identifier}-target="input field">` +
  `<button type="button" data-${identifier}-target="increment"></button>` +
  `<button type="button" data-${identifier}-target="decrement"></button>` +
  "</div>";

/** The two runs each controller gets, with the title each test carries. */
const RELEASE_RUNS = [
  [1, "releases every listener on disconnect"],
  [2, "releases every listener after connecting twice"],
] as const;

/**
 * Connects `controller` on its markup — once, or twice with no disconnect between —
 * disconnects it, and fails when a registration it made is still live, when it did
 * not connect, or when connecting reported an error.
 */
export async function assertListenersReleased(
  identifier: string,
  controller: unknown,
  connections: 1 | 2,
  options: ListenerReleaseOptions = {},
): Promise<void> {
  const markup = options.markup?.[identifier] ?? defaultMarkup;
  document.body.innerHTML = markup(identifier);
  const ledger = recordListeners();
  const errors: unknown[] = [];
  const application = Application.start(document.documentElement);
  application.handleError = (error) => {
    errors.push(error);
  };
  try {
    application.register(identifier, controller as never);
    await tick();
    const host = document.getElementById("host");
    const instance = host && application.getControllerForElementAndIdentifier(host, identifier);
    expect(instance, `${identifier} connected`).toBeTruthy();
    if (connections === 2) (instance as { connect(): void }).connect();
    expect(errors).toEqual([]);
  } finally {
    disconnectAndStopApplication(application);
    await tick();
    document.body.innerHTML = "";
  }

  const kept = options.documentLifetime?.[identifier] ?? [];
  const live = ledger
    .live()
    .filter((record) => !kept.some((k) => k.target() === record.target && k.type === record.type));
  expect(live.map((record) => `${record.type} (capture ${record.capture})`)).toEqual([]);
}

/**
 * Registers, for every controller in `controllers`, that nothing its connection
 * registered survives the disconnect — once after a single `connect()`, and once
 * after a second `connect()` with no disconnect between. The second is a
 * controller's own lifecycle called twice, which a set rebuilt on each connect
 * or a registration made again without releasing the first would survive.
 *
 * The host is generic, so this covers each controller's connect and disconnect
 * paths, not the ones its targets and Values open; the controller's own suite
 * covers those. The ledger each test starts is restored after it.
 */
export function describeListenerRelease(
  controllers: Readonly<Record<string, unknown>>,
  options: ListenerReleaseOptions = {},
): void {
  for (const [identifier, controller] of Object.entries(controllers)) {
    for (const [connections, title] of RELEASE_RUNS) {
      it(`${identifier} ${title}`, () =>
        assertListenersReleased(identifier, controller, connections, options));
    }
  }
}
