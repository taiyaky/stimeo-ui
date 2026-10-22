/**
 * A native EventTarget that counts delivery to the listeners its consumers add.
 * Stable wrappers preserve tuple deduplication and removal; the platform owns
 * `signal` and `once` behavior through the unchanged registration options.
 */
export class FontEvents extends EventTarget {
  readonly #wrappers = new Map<EventListenerOrEventListenerObject, Map<string, EventListener>>();
  #deliveries = 0;

  /** Counts listener calls, including callbacks whose own DOM guard returns. */
  get deliveries(): number {
    return this.#deliveries;
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (!listener) return;
    const key = this.#key(type, options);
    let wrappers = this.#wrappers.get(listener);
    if (!wrappers) {
      wrappers = new Map();
      this.#wrappers.set(listener, wrappers);
    }
    let wrapper = wrappers.get(key);
    if (!wrapper) {
      wrapper = (event: Event): void => {
        this.#deliveries += 1;
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      };
      wrappers.set(key, wrapper);
    }
    super.addEventListener(type, wrapper, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (!listener) return;
    const wrapper = this.#wrappers.get(listener)?.get(this.#key(type, options));
    super.removeEventListener(type, wrapper ?? listener, options);
  }

  #key(type: string, options?: boolean | EventListenerOptions): string {
    return `${type}:${typeof options === "boolean" ? options : (options?.capture ?? false)}`;
  }
}

/** Installs the given fonts source on one document and restores its descriptor. */
export async function withDocumentFonts(
  owner: Document,
  source: EventTarget | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(owner, "fonts");
  Object.defineProperty(owner, "fonts", { configurable: true, value: source });
  try {
    await run();
  } finally {
    if (descriptor) Object.defineProperty(owner, "fonts", descriptor);
    else Reflect.deleteProperty(owner, "fonts");
  }
}
