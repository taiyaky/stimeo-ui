import { describe, expect, it, vi } from "vitest";
import { sharedRegistry } from "../../src/utils/shared_registry";
import { separateCopy } from "../helpers/separate_copy";

/** The one-per-page registry every copy of the package finds under the same versioned key. */
describe("sharedRegistry", () => {
  it("hands every copy of the module the registry the first one created", async () => {
    const other = await separateCopy(() => import("../../src/utils/shared_registry"));
    const create = vi.fn(() => ({ entries: [] as string[] }));

    const first = sharedRegistry("stimeo-ui.probe-shared.registry.v1", create);
    const second = other.sharedRegistry("stimeo-ui.probe-shared.registry.v1", create);

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps a registry of another shape version apart", () => {
    const one = sharedRegistry("stimeo-ui.probe-version.registry.v1", () => ({ version: 1 }));
    const two = sharedRegistry("stimeo-ui.probe-version.registry.v2", () => ({ version: 2 }));

    expect([one.version, two.version]).toEqual([1, 2]);
  });

  it("keeps the registry under a global symbol that is not enumerable and not replaced", () => {
    const registry = sharedRegistry("stimeo-ui.probe-hidden.registry.v1", () => ({}));
    const symbol = Symbol.for("stimeo-ui.probe-hidden.registry.v1");

    expect(Object.getOwnPropertyDescriptor(globalThis, symbol)).toEqual({
      value: registry,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  });
});
