/**
 * Writes `value` to the attribute `name` on `element` and resolves once the mutation
 * records of that write have been delivered.
 *
 * Stimulus runs a controller's `<name>ValueChanged` from the MutationObserver it holds on
 * the controller's element. The DOM notifies observers in the order they were created,
 * and happy-dom in the order they began observing the element; the observer this helper
 * creates and registers for the write is the last by both, so by the time it is notified
 * Stimulus has run the Value callback, and the caller's next line sees whatever the
 * controller did with the change. The wait reads no clock: it resolves the same way under
 * `vi.useFakeTimers()` and moves none of the mocked timers.
 */
export const writeValueAttribute = (element: Element, name: string, value: string): Promise<void> =>
  new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(element, { attributeFilter: [name] });
    element.setAttribute(name, value);
  });
