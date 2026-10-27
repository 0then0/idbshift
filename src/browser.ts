import { assertJson } from './json.js';
import type { Json } from './types.js';

export interface StorageSession {
  /** The actual connection used by this adapter, not a reported name or number. */
  database: IDBDatabase;
  close(): void | Promise<void>;
  operations: Record<string, (input: Json) => void | Promise<void>>;
  queries: Record<string, (input: Json) => Json | Promise<Json>>;
}
export interface StorageAdapter {
  appVersion: string;
  protocolVersion?: 1;
  open(options: { databaseName: string }): Promise<StorageSession>;
}
export function defineAdapter(adapter: StorageAdapter): StorageAdapter {
  return {
    ...adapter,
    protocolVersion: 1,
    async open(options) {
      const session = await adapter.open(options);
      const queries: StorageSession['queries'] = Object.create(null);
      for (const [name, query] of Object.entries(session.queries)) {
        queries[name] = async (input) => {
          assertJson(input);
          const value = await query.call(session.queries, input);
          assertJson(value);
          return value;
        };
      }
      return {
        database: session.database,
        close: () => session.close(),
        operations: session.operations,
        queries,
      };
    },
  };
}

/** Use only for intentional application compatibility refusal, not programming errors. */
export class OpenRefusal extends Error {
  readonly idbshiftRefusal = true;
  constructor(message: string, name = 'CompatibilityRefusal') {
    super(message);
    this.name = name;
  }
}

declare global {
  interface Window {
    __idbshift?: { session: StorageSession; documentId: string };
    __idbshiftGuard?: { violations: string[]; documentId: string };
  }
}
