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
    new OwnedPointerSession(pointer("pointerdown", 2, 20), secondOwner, {
      move: (event) => secondMoves.push(event.clientX),
      end: secondEnd,
    });

    document.dispatchEvent(pointer("pointermove", 1, 30));
    expect(firstMoves).toEqual([30]);
    expect(secondMoves).toEqual([]);

    document.dispatchEvent(pointer("pointerup", 2, 30));
    expect(firstEnd).not.toHaveBeenCalled();
    expect(secondEnd).toHaveBeenCalledOnce();

    // The ended session is deaf; the live one keeps receiving its own pointer.
    document.dispatchEvent(pointer("pointermove", 2, 50));
    document.dispatchEvent(pointer("pointermove", 1, 40));
    expect(secondMoves).toEqual([]);
    expect(firstMoves).toEqual([30, 40]);
    first.end();
  });

  it("ignores another pointer's up and cancel events", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const moves = vi.fn();
    const ended = vi.fn();
    new OwnedPointerSession(pointer("pointerdown", 7, 0), owner, { move: moves, end: ended });

    document.dispatchEvent(pointer("pointerup", 8, 0));
    document.dispatchEvent(pointer("pointercancel", 8, 0));
    document.dispatchEvent(pointer("pointermove", 7, 5));
    expect(ended).not.toHaveBeenCalled();
    expect(moves).toHaveBeenCalledOnce();

    document.dispatchEvent(pointer("pointercancel", 7, 0));
    document.dispatchEvent(pointer("pointermove", 7, 9));
    expect(ended).toHaveBeenCalledOnce();
    expect(moves).toHaveBeenCalledOnce();
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

    expect(moves).toHaveBeenCalledOnce();
    session.end();
  });

  it("finishes teardown when releasing detached pointer capture throws", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    owner.releasePointerCapture = vi.fn(() => {
      throw new DOMException("Pointer capture was already lost", "NotFoundError");
    });
    const moves = vi.fn();
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 6, 0), owner, {
      move: moves,
      end: ended,
    });

    expect(() => session.end()).not.toThrow();
    document.dispatchEvent(pointer("pointermove", 6, 3));
    expect(moves).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledOnce();
  });

  it("keeps delivering movement when the owner loses pointer capture", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const moves = vi.fn();
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 3, 0), owner, {
      move: moves,
      end: ended,
    });

    owner.dispatchEvent(pointer("lostpointercapture", 3, 0));
    document.dispatchEvent(pointer("pointermove", 3, 18));
    expect(moves).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
    session.end();
  });

  it("ignores a lost capture belonging to another pointer", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const moves = vi.fn();
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 3, 0), owner, {
      move: moves,
      end: ended,
    });

    owner.dispatchEvent(pointer("lostpointercapture", 9, 0));
    document.dispatchEvent(pointer("pointermove", 3, 21));
    expect(moves).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
    session.end();
  });

  it("names a released pointer as the end of the session", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const ended = vi.fn();
    new OwnedPointerSession(pointer("pointerdown", 11, 0), owner, { move: vi.fn(), end: ended });

    document.dispatchEvent(pointer("pointerup", 11, 0));
    expect(ended).toHaveBeenCalledExactlyOnceWith("up");
  });

  it("names a cancelled pointer as the end of the session", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const ended = vi.fn();
    new OwnedPointerSession(pointer("pointerdown", 12, 0), owner, { move: vi.fn(), end: ended });

    document.dispatchEvent(pointer("pointercancel", 12, 0));
    expect(ended).toHaveBeenCalledExactlyOnceWith("cancel");
  });

  it("names a caller-driven close as a teardown", () => {
    const owner = document.createElement("div");
    document.body.append(owner);
    const ended = vi.fn();
    const session = new OwnedPointerSession(pointer("pointerdown", 13, 0), owner, {
      move: vi.fn(),
      end: ended,
    });

    session.end();
    expect(ended).toHaveBeenCalledExactlyOnceWith("teardown");
  });
});

/** Creates a synthetic pointer carrying an explicit identity and coordinate. */
function pointer(type: string, pointerId: number, clientX: number): PointerEvent {
  return new PointerEvent(type, { bubbles: true, pointerId, clientX });
}
