import { beforeEach, describe, expect, it } from "vitest";
import {
  isReservedArrowChord,
  logicalArrowKey,
  logicalArrowStep,
} from "../../src/utils/arrow_step";

/**
 * Tests for the logical-direction helpers.
 *
 * Two properties carry the weight and neither is observable from a controller
 * suite, because every consumer filters the key with a static `case` label before
 * calling in:
 *
 * - **non-arrow keys are passed through untouched.** Without that guard,
 *   `logicalArrowStep` answers `-1` for `Home`, `End`, `" "`, or a printable
 *   character — a wrong answer no consumer can currently reach, and exactly the
 *   kind of latent edge the next consumer would trip over.
 * - **the vertical pair never reverses.** That is what lets a controller fold
 *   Right/Down into one branch, which several of them do.
 */
describe("logicalArrowStep", () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="c"><button id="child">x</button></div>';
    container = document.getElementById("c") as HTMLElement;
  });

  const rtl = () => {
    container.style.direction = "rtl";
    return container;
  };

  it("reads the horizontal pair as next / previous under LTR", () => {
    expect(logicalArrowStep("ArrowRight", container)).toBe(1);
    expect(logicalArrowStep("ArrowLeft", container)).toBe(-1);
  });

  it("reverses the horizontal pair under RTL", () => {
    expect(logicalArrowStep("ArrowLeft", rtl())).toBe(1);
    expect(logicalArrowStep("ArrowRight", rtl())).toBe(-1);
  });

  it("leaves the vertical pair alone in both directions", () => {
    expect(logicalArrowStep("ArrowDown", container)).toBe(1);
    expect(logicalArrowStep("ArrowUp", container)).toBe(-1);
    expect(logicalArrowStep("ArrowDown", rtl())).toBe(1);
    expect(logicalArrowStep("ArrowUp", rtl())).toBe(-1);
  });

  it("answers 0 for a key that names no direction", () => {
    // The guard consumers cannot reach: they filter by `case` first, so a wrong
    // answer here stays invisible until someone calls in without that filter.
    for (const key of ["Home", "End", " ", "a", "Enter", "Tab"]) {
      expect(logicalArrowStep(key, container)).toBe(0);
      expect(logicalArrowStep(key, rtl())).toBe(0);
    }
  });
});

/**
 * The key-rewriting variant, for handlers whose two horizontal branches are not
 * mirror images. Same reason for its own suite: consumers filter by `case` first,
 * so a wrong answer for a non-arrow key never reaches them.
 */
describe("logicalArrowKey", () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="k"></div>';
    container = document.getElementById("k") as HTMLElement;
  });

  const rtl = () => {
    container.style.direction = "rtl";
    return container;
  };

  it("passes every key through under LTR", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End", "a"]) {
      expect(logicalArrowKey(key, container)).toBe(key);
    }
  });

  it("swaps only the horizontal pair under RTL", () => {
    expect(logicalArrowKey("ArrowRight", rtl())).toBe("ArrowLeft");
    expect(logicalArrowKey("ArrowLeft", rtl())).toBe("ArrowRight");
    // Everything else survives untouched — including the vertical pair, which a
    // segmented field uses for its *value* rather than for order.
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End", " ", "a", "Enter"]) {
      expect(logicalArrowKey(key, rtl())).toBe(key);
    }
  });
});

describe("isReservedArrowChord", () => {
  const chord = (key: string, modifiers: Partial<KeyboardEventInit> = {}) =>
    new KeyboardEvent("keydown", { key, ...modifiers });

  it("answers false for a bare arrow", () => {
    expect(isReservedArrowChord(chord("ArrowRight"))).toBe(false);
    expect(isReservedArrowChord(chord("ArrowDown"))).toBe(false);
  });

  it("reserves an arrow carrying any modifier", () => {
    expect(isReservedArrowChord(chord("ArrowRight", { altKey: true }))).toBe(true);
    expect(isReservedArrowChord(chord("ArrowRight", { ctrlKey: true }))).toBe(true);
    expect(isReservedArrowChord(chord("ArrowRight", { metaKey: true }))).toBe(true);
    expect(isReservedArrowChord(chord("ArrowRight", { shiftKey: true }))).toBe(true);
  });

  it("answers false for a non-arrow key however it is chorded", () => {
    // Chorded letters and Control+Home/End are other rules' business.
    expect(isReservedArrowChord(chord("Home", { ctrlKey: true }))).toBe(false);
    expect(isReservedArrowChord(chord("a", { metaKey: true }))).toBe(false);
    expect(isReservedArrowChord(chord("Enter", { shiftKey: true }))).toBe(false);
  });

  it("releases only the modifiers named in allow", () => {
    expect(isReservedArrowChord(chord("ArrowDown", { altKey: true }), ["alt"])).toBe(false);
    // Anything not named stays reserved, including on the same press.
    expect(isReservedArrowChord(chord("ArrowDown", { ctrlKey: true }), ["alt"])).toBe(true);
    expect(isReservedArrowChord(chord("ArrowDown", { altKey: true, ctrlKey: true }), ["alt"])).toBe(
      true,
    );
  });

  it("reserves nothing on an arrow once every modifier is allowed", () => {
    const all = ["alt", "ctrl", "meta", "shift"] as const;
    expect(isReservedArrowChord(chord("ArrowUp", { altKey: true, shiftKey: true }), all)).toBe(
      false,
    );
  });
});
