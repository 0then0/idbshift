import type { Page } from '@playwright/test';
import { RunFailure } from './common.js';
import { assertJson } from './json.js';
import type { Json, OracleApi, OracleSchema } from './types.js';

type OracleRequest =
  | { op: 'version' }
  | { op: 'records'; store: string; keys: (string | number)[]; fields: string[] }
  | { op: 'all'; store: string; fields: string[] };
type OracleReply = { ok: true; value: Json } | { ok: false; kind: string; message: string };

export const oracleRecordLimit = 1000;

/**
 * Runs inside a fresh page that never imports an adapter. Each call opens its own connection
 * without a version, so it cannot create or upgrade the database, and closes it before returning.
 */
async function readInPage(arg: {
  databaseName: string;
  schemas: OracleSchema[];
  request: OracleRequest;
  limit: number;
}): Promise<OracleReply> {
  const fail = (kind: string, message: string): OracleReply => ({ ok: false, kind, message });
  const plain = (value: unknown): boolean => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
    if (typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) return prototype === Array.prototype && value.every(plain);
    return (
      (prototype === Object.prototype || prototype === null) && Object.values(value).every(plain)
    );
  };
  const { databaseName, schemas, request, limit } = arg;
  const listed = (await indexedDB.databases()).find((entry) => entry.name === databaseName);
  if (!listed)
    return fail(
      'oracle-database-missing',
      'The database does not exist; the oracle never creates it',
    );
  let created = false;
  const opening = indexedDB.open(databaseName);
  opening.onupgradeneeded = () => {
    // Opening without a version must not upgrade. Abort rather than leave a new empty database.
    created = true;
    opening.transaction?.abort();
  };
  let database: IDBDatabase;
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error ?? new Error('Open failed'));
    });
  } catch (error) {
    return created
      ? fail('oracle-would-create', 'The oracle open would have created the database')
      : fail('oracle-open-failed', error instanceof Error ? error.name : 'Open failed');
  }
  try {
    const schema = schemas.find((candidate) => candidate.version === database.version);
    if (!schema)
      return fail(
        'oracle-schema-unknown',
        `No oracle schema declared for native version ${database.version}`,
      );
    const actualStores = [...database.objectStoreNames].sort();
    const declaredStores = Object.keys(schema.stores).sort();
    if (JSON.stringify(actualStores) !== JSON.stringify(declaredStores))
      return fail(
        'oracle-schema-unknown',
        `Object stores differ from the schema for version ${database.version}`,
      );
    if (request.op === 'version') return { ok: true, value: database.version };
    const declared = schema.stores[request.store];
    if (!declared || !Object.hasOwn(schema.stores, request.store))
      return fail(
        'oracle-schema-unknown',
        `Store ${request.store} is not declared for version ${database.version}`,
      );
    const transaction = database.transaction(request.store, 'readonly');
    const store = transaction.objectStore(request.store);
    if (store.keyPath !== declared.keyPath)
      return fail(
        'oracle-schema-unknown',
        `Key path of ${request.store} differs from the declared schema`,
      );
    const wait = <T>(idbRequest: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        idbRequest.onsuccess = () => resolve(idbRequest.result);
        idbRequest.onerror = () => reject(idbRequest.error);
      });
    const project = (record: unknown, fields: string[]): unknown => {
      if (typeof record !== 'object' || record === null || Array.isArray(record))
        throw new TypeError('Oracle records must be plain objects');
      const picked: Record<string, unknown> = {};
      for (const field of fields)
        picked[field] = Object.hasOwn(record, field)
          ? (record as Record<string, unknown>)[field]
          : null;
      return picked;
    };
    let value: unknown;
    if (request.op === 'records') {
      value = [];
      for (const key of request.keys) {
        const record = await wait(store.get(key));
        (value as unknown[]).push(record === undefined ? null : project(record, request.fields));
      }
    } else {
      const count = await wait(store.count());
      if (count > limit)
        return fail(
          'oracle-limit',
          `Store ${request.store} has ${count} records; the oracle reads at most ${limit}`,
        );
      value = (await wait(store.getAll())).map((record) => project(record, request.fields));
    }
    if (!plain(value))
      return fail('oracle-unsupported-value', 'Oracle reads support only plain JSON values');
    return { ok: true, value: value as Json };
  } catch (error) {
    return fail(
      'oracle-read-failed',
      error instanceof Error ? `${error.name}: ${error.message}` : 'Oracle read failed',
    );
  } finally {
    database.close();
  }
}

/** Node-side oracle API bound to one oracle page and the lifetime of one step. */
export function oracleApi(
  page: Page,
  databaseName: string,
  schemas: OracleSchema[],
  guard: () => void,
): OracleApi & { readVersion(): Promise<number> } {
  const call = async (request: OracleRequest): Promise<Json> => {
    guard();
    const reply = await page.evaluate(readInPage, {
      databaseName,
      schemas,
      request,
      limit: oracleRecordLimit,
    });
    guard();
    if (!reply.ok) throw new RunFailure(reply.kind, reply.message);
    assertJson(reply.value);
    return reply.value;
  };
  const checkFields = (fields: string[]) => {
    if (
      !Array.isArray(fields) ||
      !fields.length ||
      !fields.every((field) => typeof field === 'string' && field)
    )
      throw new TypeError('Oracle reads require a nonempty list of field names');
  };
  const api = {
    async readVersion() {
      return (await call({ op: 'version' })) as number;
    },
    version: async () => (await call({ op: 'version' })) as number,
    async records(store: string, keys: (string | number)[], fields: string[]) {
      checkFields(fields);
      if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' || Number.isFinite(k)))
        throw new TypeError('Oracle keys must be strings or finite numbers');
      return call({ op: 'records', store, keys, fields });
    },
    async all(store: string, fields: string[]) {
      checkFields(fields);
      return call({ op: 'all', store, fields });
    },
  };
  return api;
}
