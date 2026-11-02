import { OpenRefusal, defineAdapter, signal } from 'idbshift/browser';
import type { Json } from 'idbshift';

/**
 * A small notes store used by the concurrent examples.
 *
 * - Schema 1 (native v1): `notes` with key path `id`.
 * - Schema 2 (native v2): adds an unrelated `audit` store. Schema 1 code can use schema 2 data
 *   unchanged, which is what makes the `reconnecting` control legitimate. It is a property of this
 *   fixture, not a claim about any other schema change.
 *
 * `holding`, `cached`, `guarded` and `reconnecting` are four ways the schema 1 application can
 * behave while another document upgrades the database. `next` is the schema 2 application.
 */
export type TabVariant = 'holding' | 'cached' | 'guarded' | 'reconnecting' | 'next';
interface Note {
  id: number;
  text: string;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    tx.onerror = () => reject(tx.error);
  });
}
/** `version` is omitted to adopt whatever version is installed. */
function openDatabase(name: string, version: number | undefined, latest: boolean) {
  const opening = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  opening.onupgradeneeded = (event) => {
    const db = opening.result;
    if (event.oldVersion < 1) db.createObjectStore('notes', { keyPath: 'id' });
    if (latest && event.oldVersion < 2) db.createObjectStore('audit', { keyPath: 'id' });
  };
  return request(opening);
}
function parse(input: Json): Note {
  const note = input as unknown as Note;
  if (!Number.isInteger(note?.id) || typeof note.text !== 'string')
    throw new TypeError('save requires an integer id and a text');
  return note;
}
async function put(db: IDBDatabase, note: Note) {
  const tx = db.transaction('notes', 'readwrite');
  const done = completed(tx);
  tx.objectStore('notes').put(note);
  await done;
}

export function tabStorage(variant: TabVariant) {
  return defineAdapter({
    appVersion: `notes-${variant}`,
    async open({ databaseName }) {
      const latest = variant === 'next';
      let connect: () => Promise<IDBDatabase>;
      let write: (note: Note) => Promise<void>;
      let close: () => Promise<void>;
      if (variant === 'cached') {
        // The failure class under test: the connection promise is cached for the page lifetime.
        // The handler closes the connection when another document upgrades, but nothing
        // invalidates the cache, so every later call receives a closed IDBDatabase.
        let cached: Promise<IDBDatabase> | undefined;
        connect = () =>
          (cached ??= openDatabase(databaseName, 1, false).then((db) => {
            db.onversionchange = () => db.close();
            return db;
          }));
        write = async (note) => put(await connect(), note);
        close = async () => (await cached)?.close();
      } else if (variant === 'guarded') {
        // Explicit policy: stop writing, report the state and wait for a reload.
        let state: 'ready' | 'upgrade-required' = 'ready';
        const db = await openDatabase(databaseName, 1, false);
        db.onversionchange = () => {
          state = 'upgrade-required';
          db.close();
          signal('upgrade-required');
        };
        connect = async () => db;
        write = async (note) => {
          if (state !== 'ready')
            throw new OpenRefusal(
              'The database was upgraded by another tab; reload to continue',
              'UpgradeRequired',
            );
          await put(db, note);
        };
        close = async () => db.close();
      } else if (variant === 'reconnecting') {
        // Explicit policy: drop the stale connection, then reconnect to the installed version.
        // Valid only because schema 2 keeps everything schema 1 uses.
        let current: Promise<IDBDatabase> | undefined;
        let reconnects = 0;
        connect = () =>
          (current ??= openDatabase(databaseName, reconnects++ ? undefined : 1, false).then(
            (db) => {
              db.onversionchange = () => {
                current = undefined;
                db.close();
                signal('connection-invalidated');
              };
              return db;
            },
          ));
        write = async (note) => put(await connect(), note);
        close = async () => (await current)?.close();
      } else {
        // `holding` keeps its connection and has no versionchange handler. `next` is schema 2.
        const db = await openDatabase(databaseName, latest ? 2 : 1, latest);
        connect = async () => db;
        write = (note) => put(db, note);
        close = async () => db.close();
      }
      const database = await connect();
      return {
        database,
        close: () => close(),
        operations: { save: (input: Json) => write(parse(input)) },
        queries: {
          notes: async () => {
            const tx = (await connect()).transaction('notes', 'readonly');
            return (await request(tx.objectStore('notes').getAll())) as Json;
          },
        },
      };
    },
  });
}
