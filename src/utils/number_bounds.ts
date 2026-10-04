import { MAX_TIMER_DELAY_MS } from "./timer_bounds";

/** Semantic constraints on an already decoded number, independent of the DOM. */
export interface NumberBounds {
  /** Finite numbers are required, including when this field is omitted. */
  readonly finite?: true;
  /** Inclusive lower endpoint. */
  readonly min?: number;
  /** Inclusive upper endpoint. */
  readonly max?: number;
  /** Exclusive lower endpoint. */
  readonly exclusiveMin?: number;
  /** Require a number without a fractional part. */
  readonly integer?: boolean;
  /** Exact decoded numbers accepted by a discrete contract. */
  readonly allowedValues?: readonly number[];
  /** JSON-safe exceptions to finite-number checking for unbounded endpoints. */
  readonly allowInfinity?: "negative" | "positive" | "both";
}

/** One constraint for each Number Value, including shorthand declarations. */
export type NumberValueConstraints<Values> = {
  readonly [Key in keyof Values as Values[Key] extends
    | NumberConstructor
    | { type: NumberConstructor }
    ? Key
    : never]: NumberBounds;
};

/** Reusable semantic domains; fractional inputs remain fractional unless excluded. */
export const NUMBER_BOUNDS = {
  finite: { finite: true },
  nonNegative: { finite: true, min: 0 },
  positive: { finite: true, exclusiveMin: 0 },
  nonNegativeInteger: { finite: true, min: 0, integer: true },
  positiveInteger: { finite: true, exclusiveMin: 0, integer: true },
  lowerBound: { finite: true, allowInfinity: "negative" },
  upperBound: { finite: true, allowInfinity: "positive" },
  timer: { finite: true, min: 0, max: MAX_TIMER_DELAY_MS },
  positiveTimer: { finite: true, exclusiveMin: 0, max: MAX_TIMER_DELAY_MS },
} as const satisfies Record<string, NumberBounds>;

/**
 * Checks all declared bounds without rounding, clamping, or coercing the input.
 * Infinity exceptions relax only finite checking; every other bound still applies.
 */
export function matchesNumberBounds(value: number, bounds: NumberBounds): boolean {
  if (!Number.isFinite(value)) {
    const direction = value === Infinity ? "positive" : value === -Infinity ? "negative" : null;
    if (direction === null) return false;
    if (bounds.allowInfinity !== "both" && bounds.allowInfinity !== direction) return false;
  }
  if (bounds.min !== undefined && value < bounds.min) return false;
  if (bounds.max !== undefined && value > bounds.max) return false;
  if (bounds.exclusiveMin !== undefined && value <= bounds.exclusiveMin) return false;
  if (bounds.integer && !Number.isInteger(value)) return false;
  if (bounds.allowedValues !== undefined && !bounds.allowedValues.includes(value)) return false;
  return true;
}

/** Decodes a Number Value literal; action params use their own JSON decoder. */
export function decodeNumberValue(raw: string): number {
  return Number(raw.replace(/_/g, ""));
}
