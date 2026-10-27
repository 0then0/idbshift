import type { Json } from './types.js';

/** Intentionally rejects structured-clone types instead of inventing a serializer. */
export function assertJson(value: unknown, ancestors = new Set<object>()): asserts value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== 'object' || value === null) throw new TypeError('Unsupported JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new TypeError('Only plain JSON objects and arrays are supported');
  if (ancestors.has(value)) throw new TypeError('Cyclic diagnostic value');
  if (Object.getOwnPropertySymbols(value).length)
    throw new TypeError('Symbol keys are unsupported');
  ancestors.add(value);
  const keys = Object.keys(value);
  if (
    Array.isArray(value) &&
    (keys.length !== value.length || keys.some((k, i) => k !== String(i)))
  )
    throw new TypeError('Sparse arrays and array properties are unsupported');
  if (Object.getOwnPropertyNames(value).length !== keys.length + (Array.isArray(value) ? 1 : 0))
    throw new TypeError('Non-enumerable properties are unsupported');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Accessors are unsupported');
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}
