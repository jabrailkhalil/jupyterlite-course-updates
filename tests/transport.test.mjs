import { test } from 'node:test';
import assert from 'node:assert/strict';

test('native Atomics.waitAsync can return a synchronous string, not a Promise', () => {
  const values = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  // A worker may write the response before the receiving side starts waiting.
  Atomics.store(values, 0, 1);
  const result = Atomics.waitAsync(values, 0, 0);
  assert.equal(result.async, false);
  assert.equal(result.value, 'not-equal');
  assert.throws(() => result.value.then(() => {}), TypeError);
});
