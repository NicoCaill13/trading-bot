import assert from 'node:assert/strict';

/**
 * Compares ratios and percentages within float tolerance.
 *
 * Values derived from price arithmetic almost never land on their exact decimal:
 * (99.2 - 100) / 100 yields -0.007999999999999972. Strict equality on such
 * results tests the IEEE-754 representation rather than the logic under test.
 */
export function assertRatio(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ~${expected}, got ${actual}`,
  );
}
