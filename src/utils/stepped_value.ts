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
 * exactly between two allowed values resolves upward. "Exactly" allows for the
 * rounding error of binary floating point at the size of the numbers compared,
 * so the decimal midpoint `4.7105` of `2.15` and `7.271` resolves to `7.271`.
 *
 * A finite `raw` gives a finite result. Grid values are counted from a grid
 * value within a step of zero, so a finite `min` far from zero costs a value
 * near zero none of its precision. On a range unbounded on both sides,
 * `±Infinity` is returned as it is.
 */
export function snapSteppedValue(raw: number, range: SteppedRange): number {
  if (!(range.min <= range.max)) return finiteFallback(range.min, range.max);

  const input = Number.isNaN(raw) ? finiteFallback(range.min, range.max) : raw;
  const clamped = Math.min(range.max, Math.max(range.min, input));
  const grid = stepGrid(range);
  const candidates: number[] = [];

  if (Number.isFinite(range.min)) candidates.push(range.min);
  if (Number.isFinite(range.max)) candidates.push(range.max);

  const position = gridPosition(clamped, grid);
  if (Number.isFinite(position)) {
    for (const index of [Math.floor(position), Math.ceil(position)]) {
      const candidate = gridValue(index, grid);
      if (inRange(candidate, range)) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) return clamped;
  let nearest = candidates[0] as number;
  for (const candidate of candidates.slice(1)) {
    const nearer = isMidpoint(clamped, candidate, nearest, range, grid)
      ? candidate > nearest
      : Math.abs(clamped - candidate) < Math.abs(clamped - nearest);
    if (nearer) nearest = candidate;
  }
  return nearest;
}

/**
 * Moves through the ordered allowed-value set by an integer number of steps.
 *
 * This differs from adding `step * count` and snapping afterward at an
 * off-grid endpoint: with `max=94, step=10`, one decrement from `94` must land
 * on `90`, and one increment from `90` must reach the advertised maximum `94`.
 *
 * A finite value always gives a finite result. While the value and the base,
 * counted in the grid's last decimal place (the finer of the step's and the
 * base's), stay below 2^51 such units, one step reaches exactly the next
 * allowed value. Further out, grid values round to the precision a number holds
 * there: a step moves the way `count` points, possibly past the next grid value,
 * or leaves the value where it is, as where the next grid value rounds to the
 * current one (`1e17 + 1` is `1e17`), and never moves it the other way. Where
 * the next grid value lies past the largest finite number, the step stops at a
 * finite endpoint that way, or else the value stays. A move of several steps
 * whose first step stays does not move at all, and one that would pass the
 * largest finite number stops at a finite endpoint that way, or else stays.
 */
export function stepSteppedValue(current: number, count: number, range: SteppedRange): number {
  const value = snapSteppedValue(current, range);
  const distance = Math.abs(Math.trunc(count));
  if (!Number.isFinite(distance) || distance === 0) return value;
  const direction = Math.sign(count);
  const adjacent = nextGridValue(value, direction, range);
  if (adjacent === value) return value;

  // The first move leaves a possibly off-grid endpoint for the grid. From there a
  // direct grid jump is equivalent to repeated adjacency, and avoids work that
  // grows with Page-step magnitudes or programmatic counts. The snap clamps a move
  // past the range onto the finite endpoint that way, even a move past the largest
  // finite number; with no finite endpoint that way, such a move does not happen.
  const raw = adjacent + direction * (distance - 1) * effectiveStep(range.step);
  const endpoint = direction > 0 ? range.max : range.min;
  return Number.isFinite(raw) || Number.isFinite(endpoint) ? snapSteppedValue(raw, range) : value;
}

/**
 * The grid value next to `current` in `direction`, or `current` itself when no
 * grid value found that way lies beyond it. The result may lie past the range,
 * or be infinite where it passes the largest finite number.
 */
function nextGridValue(current: number, direction: number, range: SteppedRange): number {
  const grid = stepGrid(range);
  const position = gridPosition(current, grid);
  // The step is too small for `current / step` to be a number at all.
  if (!Number.isFinite(position)) return current;

  const index = direction > 0 ? Math.floor(position) + 1 : Math.ceil(position) - 1;
  const first = gridValue(index, grid);
  // Rounding in `position` can name the grid value `current` already holds.
  if (direction * (first - current) > 0 && !sameGridValue(first, current, grid.step)) {
    return first;
  }
  // Where positions outgrow the integers a number holds, the next index can
  // round to a value behind `current` too.
  const second = gridValue(index + direction, grid);
  return direction * (second - current) > 0 ? second : current;
}

/** A range's step grid in the terms its values are computed from. */
interface StepGrid {
  /** The positive finite step. */
  readonly step: number;
  /** The grid's base, whose decimal places bound the grid's precision. */
  readonly base: number;
  /**
   * The base less a whole number of steps: a grid value no further than a step
   * from zero. Indices counted from it stay as small as the values they name,
   * where indices counted from a distant base would outgrow the integers a
   * number holds.
   */
  readonly origin: number;
}

/** The step grid of `range`. */
function stepGrid(range: SteppedRange): StepGrid {
  const step = effectiveStep(range.step);
  const base = stepBase(range);
  // Taking whole steps off the base rounds their product at the base's magnitude,
  // so a decimal step's binary error summed over those steps reaches the result
  // no further than the base's own precision; `base % step` alone carries all of
  // it into a value near zero. The remainder folds a product rounded by more than
  // a step back within one, and `base % step` stands in where that product
  // passes the largest finite number.
  const near = base - Math.trunc(base / step) * step;
  const origin = cleanGridValue(Number.isFinite(near) ? near % step : base % step, base, step);
  return { step, base, origin };
}

/**
 * The fractional grid index of `value`. Each term is divided on its own, so an
 * index a number can hold stays finite even where `value - origin` would overflow.
 */
function gridPosition(value: number, grid: StepGrid): number {
  return value / grid.step - grid.origin / grid.step;
}

/** The grid value at an integer `index`, cleaned of binary noise. */
function gridValue(index: number, grid: StepGrid): number {
  return cleanGridValue(grid.origin + index * grid.step, grid.base, grid.step);
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

/**
 * Whether a grid value is a finite member of the inclusive range. No tolerance
 * applies at an endpoint: each finite endpoint is itself an allowed value, so a
 * grid value past it by rounding noise is left out and the endpoint stands in.
 */
function inRange(value: number, range: SteppedRange): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

/**
 * Whether two computed grid values name the same grid value. They may differ by
 * the rounding error of numbers their size, but never by more than a quarter
 * step, so neighbouring grid values stay apart however large they are. An
 * infinite operand never matches.
 */
function sameGridValue(left: number, right: number, step: number): boolean {
  const rounding = Number.EPSILON * Math.max(Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Math.min(rounding, step / 4);
}

/**
 * Whether `value` lies exactly between `left` and `right`: its two distances
 * differ by no more than writing the three numbers in binary and subtracting
 * them can make them differ, at most four `Number.EPSILON` of the largest
 * magnitude. Beyond a quarter of the gap, require the exact decimal midpoint
 * rounded to the input's precision. Widening the tolerance alone would also
 * accept neighbouring numbers. Callers pass finite numbers only.
 */
function isMidpoint(
  value: number,
  left: number,
  right: number,
  range: SteppedRange,
  grid: StepGrid,
): boolean {
  const imbalance = Math.abs(Math.abs(value - left) - Math.abs(value - right));
  const rounding = 4 * Number.EPSILON * Math.max(Math.abs(value), Math.abs(left), Math.abs(right));
  if (!(imbalance <= rounding)) return false;
  if (imbalance <= Math.abs(left - right) / 4) return true;
  const lower = Math.min(left, right);
  const upper = Math.max(left, right);
  return value > lower && value < upper && isDecimalMidpoint(value, lower, upper, range, grid);
}

/** Tests the authored decimal midpoint without taking an average of rounded grid values. */
function isDecimalMidpoint(
  value: number,
  lower: number,
  upper: number,
  range: SteppedRange,
  grid: StepGrid,
): boolean {
  const raw = decimalParts(value);
  const base = decimalParts(grid.base);
  const step = decimalParts(grid.step);
  const min = decimalParts(lower);
  const max = decimalParts(upper);
  const place = Math.min(raw.place, base.place, step.place, min.place, max.place);
  const units = (part: ReturnType<typeof decimalParts>) =>
    part.units * 10n ** BigInt(part.place - place);
  const origin = units(base);
  const stride = units(step);
  const rawUnits = units(raw);
  const remainder = (rawUnits - origin) % stride;
  const below = rawUnits - (remainder < 0n ? remainder + stride : remainder);
  const above = below + stride;
  const minUnits = units(min);
  const maxUnits = units(max);
  // A grid value and an endpoint can round to the same number. Use the closer
  // allowed decimal when they do, so the endpoint cannot shift the midpoint.
  const lowerUnits = lower === range.min && minUnits > below ? minUnits : below;
  const upperUnits = upper === range.max && maxUnits < above ? maxUnits : above;
  return (
    Number(`${lowerUnits}e${place}`) === lower &&
    Number(`${upperUnits}e${place}`) === upper &&
    Number(`${(lowerUnits + upperUnits) * 5n}e${place - 1}`) === value
  );
}

/** Separates a finite number's shortest decimal into integer units and a power of ten. */
function decimalParts(value: number): { units: bigint; place: number } {
  const [coefficient = "", exponent = "0"] = value.toString().split("e");
  const [whole = "", fraction = ""] = coefficient.split(".");
  return { units: BigInt(whole + fraction), place: Number(exponent) - fraction.length };
}

/** Stable fallback for malformed ranges or `NaN` input. */
function finiteFallback(min: number, max: number): number {
  if (Number.isFinite(min)) return min;
  if (Number.isFinite(max)) return max;
  return 0;
}
