import { beforeEach, describe, expect, it } from "vitest";
import { syncActiveOption } from "../../src/utils/active_option";

/**
 * Tests for {@link syncActiveOption}.
 *
 * The write count is the reason this helper exists, so it gets asserted two ways:
 * through the returned count, and through a `MutationObserver` that sees what the
 * DOM actually observed. A helper that produced the right final state with O(n)
 * mutations would pass the first check and fail the second.
 */
describe("syncActiveOption", () => {
  let options: HTMLElement[];

  const build = (count: number, selected: number | null = null): HTMLElement[] => {
    document.body.innerHTML = Array.from(
      { length: count },
      (_, i) => `<div role="option" id="o${i}" aria-selected="${i === selected}"></div>`,
    ).join("");
    return Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
  };

  /** Counts the attribute mutations the DOM actually observed during `run`. */
  const countMutations = async (run: () => void): Promise<number> => {
    let seen = 0;
    const observer = new MutationObserver((records) => {
      seen += records.length;
    });
    for (const option of options) {
      observer.observe(option, { attributes: true, attributeFilter: ["aria-selected"] });
    }
    run();
    await Promise.resolve();
    seen += observer.takeRecords().length;
    observer.disconnect();
    return seen;
  };

  const states = () => options.map((o) => o.getAttribute("aria-selected"));

  beforeEach(() => {
    options = build(5);
  });

  describe("the resulting state", () => {
    it("marks exactly one option active", () => {
      syncActiveOption(options, options[2] as HTMLElement);
      expect(states()).toEqual(["false", "false", "true", "false", "false"]);
    });

    it("clears the whole set when passed null", () => {
      syncActiveOption(options, options[2] as HTMLElement);
      syncActiveOption(options, null);
      expect(states()).toEqual(["false", "false", "false", "false", "false"]);
    });

    it("clears an option that is no longer active", () => {
      // The move that matters: the previous active has to go back to "false" or
      // two options read as selected at once.
      syncActiveOption(options, options[1] as HTMLElement);
      syncActiveOption(options, options[3] as HTMLElement);
      expect(states()).toEqual(
        ["false", "true", "false", "true", "false"].map((_, i) => (i === 3 ? "true" : "false")),
      );
    });

    it("marks an option that is not in the set as nothing", () => {
      // A stale reference (an option removed by a re-render) must not leave the
      // set with two actives — it simply matches nothing.
      const detached = document.createElement("div");
      syncActiveOption(options, detached);
      expect(states()).toEqual(["false", "false", "false", "false", "false"]);
    });
  });

  describe("the write count", () => {
    it("writes only the two options that changed on a move", async () => {
      syncActiveOption(options, options[1] as HTMLElement);

      const mutations = await countMutations(() => {
        expect(syncActiveOption(options, options[3] as HTMLElement)).toBe(2);
      });

      expect(mutations).toBe(2);
    });

    it("writes nothing when the active option does not move", async () => {
      syncActiveOption(options, options[2] as HTMLElement);

      const mutations = await countMutations(() => {
        expect(syncActiveOption(options, options[2] as HTMLElement)).toBe(0);
      });

      expect(mutations).toBe(0);
    });

    it("does not grow with the option count", async () => {
      // The whole point: option counts are authored and unbounded, and this runs
      // on every keystroke and arrow repeat.
      options = build(200);
      syncActiveOption(options, options[0] as HTMLElement);

      const mutations = await countMutations(() => {
        expect(syncActiveOption(options, options[199] as HTMLElement)).toBe(2);
      });

      expect(mutations).toBe(2);
    });

    it("writes every option that was wrong on the first pass", () => {
      // Nothing is skipped for its own sake: an unset set costs a full pass once.
      document.body.innerHTML = '<div role="option"></div><div role="option"></div>';
      options = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
      expect(syncActiveOption(options, options[0] as HTMLElement)).toBe(2);
    });
  });

  it("accepts any iterable, not just an array", () => {
    // Consumers pass Stimulus target arrays today, but a NodeList or a generator
    // is the same question — nothing here needs indexing or a length.
    const live = document.querySelectorAll<HTMLElement>("[role='option']");
    expect(syncActiveOption(live, live[4] as HTMLElement)).toBe(1);
    expect(states()).toEqual(["false", "false", "false", "false", "true"]);
  });
});
