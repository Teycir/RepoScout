// tests/helpers/runner.ts
// Minimal test runner using Node.js built-in test module (Node 18+).
// Import this from every test file to get assert helpers and structured output.

import { test, describe, before, after, it } from 'node:test';
import assert from 'node:assert/strict';

export { test, describe, before, after, it, assert };

// Pretty-print pass/fail with timing
export function pass(label: string): void {
  process.stdout.write(`  ✓ ${label}\n`);
}

export function fail(label: string, err: unknown): void {
  process.stderr.write(`  ✗ ${label}\n    ${err}\n`);
}

// Lightweight expect wrapper so tests read like: expect(x).toBe(y)
export function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected);
    },
    toMatch(pattern: RegExp) {
      if (typeof actual !== 'string') throw new Error(`toMatch: expected string, got ${typeof actual}`);
      assert.match(actual, pattern);
    },
    toBeNull() {
      assert.equal(actual, null);
    },
    toBeTruthy() {
      assert.ok(actual, `Expected truthy, got ${actual}`);
    },
    toBeFalsy() {
      assert.ok(!actual, `Expected falsy, got ${actual}`);
    },
    toContain(item: unknown) {
      if (Array.isArray(actual)) {
        assert.ok(actual.includes(item), `Array does not contain ${item}`);
      } else if (typeof actual === 'string') {
        assert.ok(actual.includes(String(item)), `String does not contain ${item}`);
      } else {
        throw new Error(`toContain: unsupported type ${typeof actual}`);
      }
    },
    toBeGreaterThan(n: number) {
      assert.ok((actual as number) > n, `Expected ${actual} > ${n}`);
    },
    toBeGreaterThanOrEqual(n: number) {
      assert.ok((actual as number) >= n, `Expected ${actual} >= ${n}`);
    },
    toBeLessThan(n: number) {
      assert.ok((actual as number) < n, `Expected ${actual} < ${n}`);
    },
    toHaveLength(n: number) {
      const len = (actual as unknown[]).length;
      assert.equal(len, n, `Expected length ${n}, got ${len}`);
    },
    toBeOneOf(options: unknown[]) {
      assert.ok(options.includes(actual), `Expected one of [${options.join(', ')}], got ${actual}`);
    },
  };
}
