// Throwaway: deliberately failing test to confirm the main ruleset blocks a red merge.
// This PR must never be merged; it will be closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('ruleset gate check (expected to fail)', () => { assert.equal(1, 2); });
