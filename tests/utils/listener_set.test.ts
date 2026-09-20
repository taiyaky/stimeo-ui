import { afterEach, describe, expect, it, vi } from "vitest";
import { ListenerSet } from "../../src/utils/listener_set";

/**
 * Behavioral tests for {@link ListenerSet}: that a generation releases together,
 * that `dispose()` opens the next one so a reconnecting controller subscribes
 * again, that the caller's `options` and handler reference reach the DOM
 * untouched, and that a repeated registration inside one generation stays
 * owned by the set.
 */
describe("ListenerSet", () => {
  const sets: ListenerSet[] = [];
  const nodes: Element[] = [];

  afterEach(() => {
    for (const set of sets) set.dispose();
    sets.length = 0;
    for (const node of nodes) node.remove();
    nodes.length = 0;
  });

  /** A set that the teardown releases even when an expectation fails first. */
  const listenerSet = (): ListenerSet => {
    const set = new ListenerSet();
    sets.push(set);
    return set;
  };

  /** An attached element, removed again by the teardown. */
  const element = (tag = "div"): HTMLElement => {
    const node = document.createElement(tag);
    document.body.append(node);
    nodes.push(node);
    return node;
  };

  const fire = (target: EventTarget, type = "ping", bubbles = false): void => {
    target.dispatchEvent(new Event(type, { bubbles }));
  };

  it("delivers events to a listener it added", () => {
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.add(target, "ping", handler);
    fire(target);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("stops delivering after dispose", () => {
    // The whole set rests on the DOM honouring `signal` on `addEventListener`.
    // Nothing else here would fail first if it did not, so this case states it.
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.add(target, "ping", handler);
    set.dispose();
    fire(target);

    expect(handler).not.toHaveBeenCalled();
  });

  it("subscribes again after dispose", () => {
    // A controller that reconnects adds to the set it already has; an
    // implementation that kept one aborted generation would go silent here.
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.dispose();
    set.add(target, "ping", handler);
    fire(target);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("releases the second generation as well", () => {
    // The DOM discards a repeated registration while the first is live, so a
    // second generation is only really released if the first one was closed.
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.add(target, "ping", handler);
    set.dispose();
    set.add(target, "ping", handler);
    set.dispose();
    fire(target);

    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps one registration when the same tuple is added twice", () => {
    // A lifecycle that connects twice without disconnecting lands here: the
    // repeat is discarded by the DOM, and the surviving one is still the set's.
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.add(target, "ping", handler);
    set.add(target, "ping", handler);
    fire(target);
    expect(handler).toHaveBeenCalledOnce();

    set.dispose();
    fire(target);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("disposes safely with nothing added and when repeated", () => {
    const set = listenerSet();

    expect(() => {
      set.dispose();
      set.dispose();
    }).not.toThrow();
  });

  it("registers in the capture phase when the caller asks for it", () => {
    const parent = element();
    const child = document.createElement("span");
    parent.append(child);
    const set = listenerSet();
    const order: string[] = [];

    set.add(parent, "ping", () => order.push("capture"), { capture: true });
    child.addEventListener("ping", () => order.push("bubble"));

    fire(child, "ping", true);
    expect(order).toEqual(["capture", "bubble"]);

    set.dispose();
    fire(child, "ping", true);
    expect(order).toEqual(["capture", "bubble", "bubble"]);
  });

  it("passes once through to the DOM", () => {
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.add(target, "ping", handler, { once: true });
    fire(target);
    fire(target);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("releases every target of the generation together", () => {
    const set = listenerSet();
    const target = element();
    const onElement = vi.fn();
    const onDocument = vi.fn();
    const onWindow = vi.fn();

    set.add(target, "ping", onElement);
    set.add(document, "ping", onDocument);
    set.add(window, "ping", onWindow);
    set.dispose();

    fire(target);
    fire(document);
    fire(window);

    expect(onElement).not.toHaveBeenCalled();
    expect(onDocument).not.toHaveBeenCalled();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("releases one handler shared by several types", () => {
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.add(target, "ping", handler);
    set.add(target, "pong", handler);
    fire(target, "ping");
    fire(target, "pong");
    expect(handler).toHaveBeenCalledTimes(2);

    set.dispose();
    fire(target, "ping");
    fire(target, "pong");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("registers the caller's own handler reference", () => {
    // A wrapper would change what `removeEventListener` elsewhere matches and
    // what the DOM deduplicates on, so the set must not introduce one.
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();
    const spy = vi.spyOn(target, "addEventListener");

    try {
      set.add(target, "ping", handler, { capture: true });
      expect(spy).toHaveBeenCalledOnce();
      const [type, registered, options] = spy.mock.calls[0] ?? [];
      expect(type).toBe("ping");
      expect(registered).toBe(handler);
      expect(options).toMatchObject({ capture: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("releases both phases of one handler it owns", () => {
    // Both registrations join the same generation, so the release runs once per
    // registration and neither phase is left holding the handler.
    const parent = element();
    const child = document.createElement("span");
    parent.append(child);
    const set = listenerSet();
    const phases: string[] = [];
    const handler = (event: Event) =>
      phases.push(event.eventPhase === Event.CAPTURING_PHASE ? "capture" : "bubble");

    set.add(parent, "ping", handler, { capture: true });
    set.add(parent, "ping", handler);
    fire(child, "ping", true);
    expect(phases).toEqual(["capture", "bubble"]);

    set.dispose();
    fire(child, "ping", true);
    expect(phases).toEqual(["capture", "bubble"]);
  });

  it("survives the target leaving and re-entering the document", () => {
    // Consumers dispatch Turbo events at elements that were moved in the page,
    // where the registration outlives the detach.
    const set = listenerSet();
    const target = element();
    const handler = vi.fn();

    set.add(target, "ping", handler);
    target.remove();
    document.body.append(target);
    fire(target);
    expect(handler).toHaveBeenCalledOnce();

    set.dispose();
    fire(target);
    expect(handler).toHaveBeenCalledOnce();
  });
});
