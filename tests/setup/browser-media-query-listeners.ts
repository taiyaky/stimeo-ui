/**
 * Makes a `MediaQueryList` keep its listeners as a browser's event target does.
 *
 * A browser's `MediaQueryList` is an ordinary event target: adding a live listener
 * again changes nothing, a listener is released when the signal it was added with
 * aborts, and one added with an already aborted signal is never registered.
 * happy-dom's `MediaQueryList` drops the options argument, and computes `change`
 * from a window `resize` listener it stores on the callback itself: every
 * `addEventListener("change", …)` adds another `resize` listener, and one callback
 * on two lists keeps only the latest one's, so the other outlives its removal.
 *
 * This registers the callback with its options on the list's event target, whose
 * own signal handling removes it through `removeEventListener` when the signal
 * aborts, and keeps one `resize` listener per list and callback, released with the
 * callback. `change` is computed as happy-dom does: the first `resize` after the
 * listener was added reports a list that matches. The capture flag is not told
 * apart, so one `change` callback added with and without capture is a single
 * registration; a list has no ancestors, so the phase itself never matters.
 */
const listProto = Object.getPrototypeOf(window.matchMedia("all")) as MediaQueryList;
const targetProto = Object.getPrototypeOf(listProto) as EventTarget;

if (Object.hasOwn(listProto, "addEventListener")) {
  const resizeHooks = new WeakMap<MediaQueryList, Map<unknown, () => void>>();
  const hooksOf = (list: MediaQueryList): Map<unknown, () => void> => {
    let hooks = resizeHooks.get(list);
    if (!hooks) {
      hooks = new Map();
      resizeHooks.set(list, hooks);
    }
    return hooks;
  };

  listProto.addEventListener = function addEventListener(
    this: MediaQueryList,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const signal = (options as AddEventListenerOptions | undefined)?.signal;
    if (!listener || signal?.aborted) return;
    const hooks = hooksOf(this);
    if (type === "change" && hooks.has(listener)) return;
    targetProto.addEventListener.call(this, type, listener, options);
    if (type !== "change") return;
    let matchesState = false;
    const resize = (): void => {
      const matches = this.matches;
      if (matches === matchesState) return;
      matchesState = matches;
      this.dispatchEvent(new MediaQueryListEvent("change", { matches, media: this.media }));
    };
    hooks.set(listener, resize);
    window.addEventListener("resize", resize);
  };

  listProto.removeEventListener = function removeEventListener(
    this: MediaQueryList,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    targetProto.removeEventListener.call(this, type, listener, options);
    const hooks = hooksOf(this);
    const resize = hooks.get(listener);
    if (type !== "change" || !resize) return;
    hooks.delete(listener);
    window.removeEventListener("resize", resize);
  };
}
