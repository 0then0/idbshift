import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertJson } from '../../src/json.js';

test('JSON diagnostics accept nested plain values and reject lossy structured-clone values', () => {
  assert.doesNotThrow(() => assertJson({ x: [1, null, true, 'name'], shared: {} }));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const accessor = {
    get x() {
      throw new Error('must not execute');
    },
  };
  const sparse = Array(1);
  const nonEnumerable = Object.defineProperty({}, 'x', { value: 1 });
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -0,
    1n,
    new Date(),
    new Map(),
    new Set(),
    new Uint8Array(1),
    /x/,
    () => 1,
    Symbol('x'),
    { x: undefined },
    cycle,
    sparse,
    accessor,
    nonEnumerable,
    { [Symbol('x')]: 1 },
  ])
    assert.throws(() => assertJson(value), TypeError);
});

test('Repeated references are valid JSON when they are not cyclic', () => {
  const shared = { name: 'same' };
  assert.doesNotThrow(() => assertJson([shared, shared]));
});

test('Array subclasses are rejected before their serialization hooks can run', () => {
  let serialized = 0;
  class DiagnosticArray extends Array<string> {
    toJSON() {
      serialized++;
      return ['changed'];
    }
  }
  const value = new DiagnosticArray('original');
  assert.throws(() => assertJson(value), TypeError);
  assert.throws(() => assertJson({ nested: value }), TypeError);
  assert.equal(serialized, 0);
  assert.doesNotThrow(() => assertJson(['original']));
});
