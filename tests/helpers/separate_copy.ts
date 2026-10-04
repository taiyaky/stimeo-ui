import { vi } from "vitest";

/**
 * Evaluates `load` after clearing Vitest's module cache.
 *
 * @example
 * ```ts
 * const { FocusTrap } = await separateCopy(() => import("../../src/utils/focus_trap"));
 * ```
 */
export async function separateCopy<T>(load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return load();
}
