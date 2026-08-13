import { afterEach, describe, expect, it, vi } from "vitest";
import { DetachGate, type DetachGateHost } from "../../src/utils/detach_gate";
import { flushMicrotasks } from "../helpers/timing";

/**
 * Unit tests for {@link DetachGate}: the synchronous fast path (element left
 * the document / identifier token removed), the microtask probe for the
 * ambiguous remainder, reconnect cancellation, and the orphaned-probe disarm
 * that keeps teardown single-shot.
 */

const IDENTIFIER = "stimeo--x";

/** A minimal host over a real element — no Stimulus application needed. */
const host = (element: Element, identifier = IDENTIFIER): DetachGateHost => ({
  element,
  identifier,
});

/** A connected element whose `data-controller` lists `IDENTIFIER`. */
const connectedHost = (): DetachGateHost => {
  const el = document.createElement("div");
  el.setAttribute("data-controller", IDENTIFIER);
  document.body.appendChild(el);
  return host(el);
};

describe("DetachGate", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("isDetached", () => {
    it("is true for an element that left the document", () => {
      const el = document.createElement("div");
      el.setAttribute("data-controller", IDENTIFIER);
      expect(DetachGate.isDetached(host(el))).toBe(true);
    });

    it("is false while data-controller still lists the identifier", () => {
      expect(DetachGate.isDetached(connectedHost())).toBe(false);
    });

    it("tolerates other identifiers around the token", () => {
      const h = connectedHost();
      h.element.setAttribute("data-controller", `stimeo--a ${IDENTIFIER}  stimeo--b`);
      expect(DetachGate.isDetached(h)).toBe(false);
    });

    it("is true once the identifier token is removed (detach-in-place)", () => {
      const h = connectedHost();
      h.element.setAttribute("data-controller", "stimeo--other");
      expect(DetachGate.isDetached(h)).toBe(true);
    });

    it("is true when the attribute is emptied or removed", () => {
      const h = connectedHost();
      h.element.setAttribute("data-controller", "");
      expect(DetachGate.isDetached(h)).toBe(true);
      h.element.removeAttribute("data-controller");
      expect(DetachGate.isDetached(h)).toBe(true);
    });
  });

  describe("disconnected", () => {
    it("runs the teardown synchronously when the element left the document", () => {
      const h = connectedHost();
      h.element.remove();
      const teardown = vi.fn();
      new DetachGate().disconnected(h, teardown);
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("runs the teardown synchronously when the token is gone (fast path)", () => {
      const h = connectedHost();
      h.element.setAttribute("data-controller", "");
      const teardown = vi.fn();
      new DetachGate().disconnected(h, teardown);
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("defers the ambiguous case one microtask, then tears down", async () => {
      const teardown = vi.fn();
      new DetachGate().disconnected(connectedHost(), teardown);
      expect(teardown).not.toHaveBeenCalled(); // an in-page move may still land
      await flushMicrotasks();
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("never tears down when cancel() lands within the probe window", async () => {
      const gate = new DetachGate();
      const teardown = vi.fn();
      gate.disconnected(connectedHost(), teardown);
      gate.cancel(); // the reconnect: in-page move, state survives
      await flushMicrotasks();
      expect(teardown).not.toHaveBeenCalled();
    });

    it("re-arms after a cancelled probe", async () => {
      const gate = new DetachGate();
      const h = connectedHost();
      const teardown = vi.fn();
      gate.disconnected(h, teardown);
      gate.cancel();
      await flushMicrotasks();
      gate.disconnected(h, teardown); // a later disconnect with no reconnect
      await flushMicrotasks();
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("disarms an orphaned probe when a definite detach follows (single-shot)", async () => {
      // disconnect() defers (still connected), the element leaves the DOM, and
      // disconnect() runs again: the synchronous teardown must disarm the
      // queued probe — exactly one teardown.
      const gate = new DetachGate();
      const h = connectedHost();
      const teardown = vi.fn();
      gate.disconnected(h, teardown);
      h.element.remove();
      gate.disconnected(h, teardown);
      expect(teardown).toHaveBeenCalledTimes(1);
      await flushMicrotasks(); // the orphaned probe must not fire a second run
      expect(teardown).toHaveBeenCalledTimes(1);
    });

    it("runs a doubly-armed probe exactly once", async () => {
      // Stimulus alternates connect/disconnect, but the gate itself must stay
      // single-shot even if armed twice without an intervening cancel.
      const gate = new DetachGate();
      const h = connectedHost();
      const teardown = vi.fn();
      gate.disconnected(h, teardown);
      gate.disconnected(h, teardown);
      await flushMicrotasks();
      expect(teardown).toHaveBeenCalledTimes(1);
    });
  });

  describe("pending", () => {
    it("is false before any disconnect", () => {
      expect(new DetachGate().pending).toBe(false);
    });

    it("is true only while the ambiguous probe is queued", async () => {
      const gate = new DetachGate();
      gate.disconnected(connectedHost(), vi.fn());
      // The window a consumer reads from `connect()`: a reconnect landing here
      // is the in-page move, and whatever the connect would restart must not be.
      expect(gate.pending).toBe(true);
      await flushMicrotasks();
      expect(gate.pending).toBe(false);
    });

    it("stays false on the synchronous fast path", () => {
      const gate = new DetachGate();
      const h = connectedHost();
      h.element.remove();
      gate.disconnected(h, vi.fn());
      // A definite detach never queues a probe, so a later connect is a fresh
      // attachment rather than the other half of a move.
      expect(gate.pending).toBe(false);
    });

    it("is false once the reconnect cancels the probe", () => {
      const gate = new DetachGate();
      gate.disconnected(connectedHost(), vi.fn());
      gate.cancel();
      expect(gate.pending).toBe(false);
    });
  });
});
