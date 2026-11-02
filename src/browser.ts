import { assertJson } from './json.js';
import type { Json, ObservedEvent } from './types.js';

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

/**
 * Use only for an intentional application refusal, not programming errors. Throw it from `open`
 * for a compatibility gate, or from an operation to enforce a declared stale-document policy.
 */
export class OpenRefusal extends Error {
  readonly idbshiftRefusal = true;
  constructor(message: string, name = 'CompatibilityRefusal') {
    super(message);
    this.name = name;
  }
}

const signalName = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
/**
 * Declares an application state change, for example `upgrade-required`, so a history can wait for
 * it. It carries a name only and has no effect outside an IDBShift run. Declare it after the state
 * has actually changed.
 */
export function signal(name: string): void {
  if (!signalName.test(name))
    throw new TypeError('Signal names use 1 to 80 letters, digits, dots, dashes or underscores');
  window.__idbshiftGuard?.emit?.({ type: 'signal', declared: true, name });
}

declare global {
  interface Window {
    __idbshift?: { session: StorageSession; documentId: string };
    __idbshiftGuard?: {
      violations: string[];
      documentId: string;
      /** Present only in concurrent histories. */
      events?: ObservedEvent[];
      waiters?: (() => boolean)[];
      emit?: (event: Omit<ObservedEvent, 'seq'>) => void;
    };
    __idbshiftParticipant?: {
      opening: Promise<ParticipantOpen>;
    };
  }
}
/** Outcome of a participant's adapter open, collected inside the document. */
export type ParticipantOpen =
  | { status: 'opened'; appVersion: string; version: number }
  | { status: 'refused' | 'failed'; name: string; message: string; appVersion?: string };
