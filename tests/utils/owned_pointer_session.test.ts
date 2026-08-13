import { describe, expect, it, vi } from "vitest";
import { OwnedPointerSession } from "../../src/utils/owned_pointer_session";

/** Behavioral tests for pointer identity, capture, and idempotent teardown. */
describe("OwnedPointerSession", () => {
  it("routes movement and termination only to the initiating pointer", () => {
    const firstOwner = document.createElement("div");
    const secondOwner = document.createElement("div");
    document.body.append(firstOwner, secondOwner);
    const firstMoves: number[] = [];
    const secondMoves: number[] = [];
    const firstEnd = vi.fn();
    const secondEnd = vi.fn();
    const first = new OwnedPointerSession(pointer("pointerdown", 1, 10), firstOwner, {
      move: (event) => firstMoves.push(event.clientX),
      end: firstEnd,
    });
    const second = new OwnedPointerSession(pointer("pointerdown", 2, 20), secondOwner, {
      move: (event) => secondMoves.push(event.clientX),
      end: secondEnd,
    });

    document.dispatchEvent(pointer("pointermove", 1, 30));
    expect(firstMoves).toEqual([30]);
    expect(secondMoves).toEqual([]);

    document.dispatchEvent(pointer("pointerup", 2, 30));
    expect(first.active).toBe(true);
    expect(second.active).toBe(false);
    expect(firstEnd).not.toHaveBeenCalled();
    expect(secondEnd).toHaveBeenCalledOnce();

    document.dispatchEvent(pointer("pointermove", 1, 40));
    expect(firstMoves).toEqual([30, 40]);
    first.end();
  });

  it("ignores another pointer's up and cancel events", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 7, 0), owner, {
      move: vi.fn(),
      end: ended,
    });

    document.dispatchEvent(pointer("pointerup", 8, 0));
    document.dispatchEvent(pointer("pointercancel", 8, 0));
    expect(session.active).toBe(true);
    expect(ended).not.toHaveBeenCalled();

    document.dispatchEvent(pointer("pointercancel", 7, 0));
    expect(session.active).toBe(false);
    expect(ended).toHaveBeenCalledOnce();
  });

  it("captures and releases the pointer while ending idempotently", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const capture = vi.fn();
    const release = vi.fn();
    owner.setPointerCapture = capture;
    owner.releasePointerCapture = release;
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 4, 0), owner, {
      move: vi.fn(),
      end: ended,
    });

    expect(capture).toHaveBeenCalledWith(4);
    session.end();
    session.end();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(4);
    expect(ended).toHaveBeenCalledOnce();
  });

  it("keeps document ownership when pointer capture is unavailable at runtime", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    owner.setPointerCapture = vi.fn(() => {
      throw new DOMException("Pointer is no longer active", "NotFoundError");
    });
    const moves = vi.fn();

    const session = new OwnedPointerSession(pointer("pointerdown", 5, 0), owner, {
      move: moves,
    });
    document.dispatchEvent(pointer("pointermove", 5, 12));

    expect(session.active).toBe(true);
    expect(moves).toHaveBeenCalledOnce();
    session.end();
  });

  it("finishes teardown when releasing detached pointer capture throws", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    owner.releasePointerCapture = vi.fn(() => {
      throw new DOMException("Pointer capture was already lost", "NotFoundError");
    });
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 6, 0), owner, {
      move: vi.fn(),
      end: ended,
    });

    expect(() => session.end()).not.toThrow();
    expect(session.active).toBe(false);
    expect(ended).toHaveBeenCalledOnce();
  });

  it("ends when matching pointer capture is lost", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 3, 0), owner, {
      move: vi.fn(),
      end: ended,
    });

    owner.dispatchEvent(pointer("lostpointercapture", 9, 0));
    expect(session.active).toBe(true);
    owner.dispatchEvent(pointer("lostpointercapture", 3, 0));
    expect(session.active).toBe(false);
    expect(ended).toHaveBeenCalledOnce();
  });
});

/** Creates a synthetic pointer carrying an explicit identity and coordinate. */
function pointer(type: string, pointerId: number, clientX: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, pointerId, clientX });
}
