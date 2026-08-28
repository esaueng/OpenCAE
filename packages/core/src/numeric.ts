export type FiniteExtrema = {
  min: number;
  max: number;
};

export function finiteExtrema(values: ArrayLike<number>): FiniteExtrema | null;
export function finiteExtrema<T>(values: ArrayLike<T>, select: (value: T, index: number) => number): FiniteExtrema | null;

/**
 * Returns the minimum and maximum finite values in one pass.
 *
 * Empty inputs and inputs containing only NaN or infinities return null.
 * Nonfinite values are ignored. Ordinary arrays, sparse arrays, and typed
 * arrays follow the same contract without copying the input.
 */
export function finiteExtrema<T>(
  values: ArrayLike<T>,
  select?: (value: T, index: number) => number
): FiniteExtrema | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let found = false;
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    const value = select ? select(item, index) : (item as number);
    if (!Number.isFinite(value)) continue;
    found = true;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return found ? { min, max } : null;
}
