/** Configuration for a value constrained to a stepped numeric range. */
export interface SteppedRange {
  /** Inclusive lower endpoint. May be infinite for an unbounded control. */
  readonly min: number;
  /** Inclusive upper endpoint. May be infinite for an unbounded control. */
  readonly max: number;
  /** Requested step. Non-finite and non-positive values fall back to `1`. */
  readonly step: number;
  /** Step-grid origin. Defaults to a finite `min`, otherwise `0`. */
  readonly base?: number;
}

/** The positive finite step used at runtime and by keyboard stepping. */
export function effectiveStep(step: number): number {
  return Number.isFinite(step) && step > 0 ? step : 1;
}

/**
 * Clamps a raw value and selects its nearest allowed value.
 *
 * The allowed set is the step grid plus each finite range endpoint. Keeping the
 * endpoints in that set makes an authored `aria-valuemin`/`aria-valuemax`
 * truthful even when the upper endpoint is not aligned to the grid. A value
 * exactly between two allowed values resolves upward.
 */
export function snapSteppedValue(raw: number, range: SteppedRange): number {
  if (!(range.min <= range.max)) return finiteFallback(range.min, range.max);

  const input = Number.isNaN(raw) ? finiteFallback(range.min, range.max) : raw;
  const clamped = Math.min(range.max, Math.max(range.min, input));
  const step = effectiveStep(range.step);
  const base = stepBase(range);
  const candidates: number[] = [];

  if (Number.isFinite(range.min)) candidates.push(range.min);
  if (Number.isFinite(range.max)) candidates.push(range.max);

  const gridPosition = (clamped - base) / step;
  if (Number.isFinite(gridPosition)) {
    addGridCandidate(candidates, Math.floor(gridPosition), range, base, step);
    addGridCandidate(candidates, Math.ceil(gridPosition), range, base, step);
  }

  if (candidates.length === 0) return clamped;
  let nearest = candidates[0] as number;
  let nearestDistance = Math.abs(clamped - nearest);
  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(clamped - candidate);
    if (
      distance < nearestDistance ||
      (nearlyEqual(distance, nearestDistance) && candidate > nearest)
    ) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Moves through the ordered allowed-value set by an integer number of steps.
 *
 * This differs from adding `step * count` and snapping afterward at an
 * off-grid endpoint: with `max=94, step=10`, one decrement from `94` must land
 * on `90`, and one increment from `90` must reach the advertised maximum `94`.
 */
export function stepSteppedValue(current: number, count: number, range: SteppedRange): number {
  const value = snapSteppedValue(current, range);
  const distance = Math.abs(Math.trunc(count));
  if (!Number.isFinite(distance) || distance === 0) return value;
  const direction = Math.sign(count);
  const adjacent = adjacentSteppedValue(value, direction, range);

  // The first move accounts for a possibly off-grid endpoint. From there a
  // direct grid jump is equivalent to repeated adjacency, and avoids work that
  // grows with Page-step magnitudes or programmatic counts.
  const raw = adjacent + direction * (distance - 1) * effectiveStep(range.step);
  return snapSteppedValue(raw, range);
}

/** Returns the next member of the ordered endpoint-plus-grid set. */
function adjacentSteppedValue(current: number, direction: number, range: SteppedRange): number {
  const step = effectiveStep(range.step);
  const base = stepBase(range);
  const candidates: number[] = [];

  if (direction > 0) {
    const position = (current - base) / step;
    if (Number.isFinite(position)) {
      let gridIndex = Math.floor(position) + 1;
      let candidate = cleanGridValue(base + gridIndex * step, base, step);
      if (candidate < current || nearlyEqual(candidate, current)) {
        gridIndex += 1;
        candidate = cleanGridValue(base + gridIndex * step, base, step);
      }
      if (
        candidate > current &&
        !nearlyEqual(candidate, current) &&
        within(candidate, range.min, range.max)
      ) {
        candidates.push(clamp(candidate, range));
      }
    }
    return clamp(Math.min(...candidates), range);
  }

  const position = (current - base) / step;
  if (Number.isFinite(position)) {
    let gridIndex = Math.ceil(position) - 1;
    let candidate = cleanGridValue(base + gridIndex * step, base, step);
    if (candidate > current || nearlyEqual(candidate, current)) {
      gridIndex -= 1;
      candidate = cleanGridValue(base + gridIndex * step, base, step);
    }
    if (
      candidate < current &&
      !nearlyEqual(candidate, current) &&
      within(candidate, range.min, range.max)
    ) {
      candidates.push(clamp(candidate, range));
    }
  }
  return clamp(Math.max(...candidates), range);
}

/** Adds one grid value when it falls inside the inclusive range. */
function addGridCandidate(
  candidates: number[],
  index: number,
  range: SteppedRange,
  base: number,
  step: number,
): void {
  const candidate = cleanGridValue(base + index * step, base, step);
  if (within(candidate, range.min, range.max)) candidates.push(clamp(candidate, range));
}

/** A finite authored base wins; otherwise the finite lower bound or zero does. */
function stepBase(range: SteppedRange): number {
  if (range.base !== undefined && Number.isFinite(range.base)) return range.base;
  return Number.isFinite(range.min) ? range.min : 0;
}

/** Removes binary noise without discarding significant integer-place digits. */
function cleanGridValue(value: number, base: number, step: number): number {
  const precision = Math.max(decimalPlaces(base), decimalPlaces(step));
  // `toFixed` accepts at most 100 fractional digits. Below that limit it rounds
  // according to the authored grid precision rather than an arbitrary total
  // significant-digit count, which keeps unit steps distinct at large bases.
  return precision <= 100 ? Number(value.toFixed(precision)) : value;
}

/** Number of fractional decimal places represented by a finite JS number. */
function decimalPlaces(value: number): number {
  const [coefficient = "", exponentText] = Math.abs(value).toString().toLowerCase().split("e");
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent);
}

/** Inclusive range check tolerant only of arithmetic noise at an endpoint. */
function within(value: number, min: number, max: number): boolean {
  return (value > min || nearlyEqual(value, min)) && (value < max || nearlyEqual(value, max));
}

/** Clamps a candidate whose only overshoot may be floating-point noise. */
function clamp(value: number, range: SteppedRange): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/** Relative comparison used only to collapse arithmetic noise, not real steps. */
function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= Number.EPSILON * scale
  );
}

/** Stable fallback for malformed ranges or `NaN` input. */
function finiteFallback(min: number, max: number): number {
  if (Number.isFinite(min)) return min;
  if (Number.isFinite(max)) return max;
  return 0;
}
