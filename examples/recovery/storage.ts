import { defineAdapter } from 'idbshift/browser';
import type { Json } from 'idbshift';

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
interface Note {
  id: number;
  title: string;
  tag: string;
}

/**
 * Version 2 changes one record, adds another and creates the `by-tag` index, all inside the upgrade
 * transaction. `finish` runs only after the browser confirmed every request.
 */
function migrate(tx: IDBTransaction, finish: () => void) {
  const notes = tx.objectStore('notes');
  notes.createIndex('by-tag', 'tag');
  const current = notes.get(2);
  current.onsuccess = () => {
    const writes: IDBRequest[] = [];
    if (current.result) writes.push(notes.put({ ...(current.result as Note), tag: 'archived' }));
    writes.push(notes.add({ id: 4, title: 'Delta', tag: 'migrated' } satisfies Note));
    let remaining = writes.length;
    for (const write of writes)
      write.onsuccess = () => {
        remaining -= 1;
        if (remaining === 0) finish();
      };
  };
}

/**
 * - A: native version 1, one `notes` store.
 * - B: native version 2 with the `by-tag` index.
 * - B-abort: the same migration, then the application aborts its own upgrade transaction.
 *   This failure injection belongs to the example. IDBShift only observes the open error.
 */
export function recoveryStorage(version: 'A' | 'B' | 'B-abort') {
  return defineAdapter({
    appVersion: `recovery-${version}`,
    async open({ databaseName }) {
      const open = indexedDB.open(databaseName, version === 'A' ? 1 : 2);
      const lifecycle = {
        upgradeEvents: 0,
        oldVersion: null as number | null,
        newVersion: null as number | null,
      };
      let injected = false;
      open.onupgradeneeded = (event) => {
        const tx = open.transaction;
        if (!tx) throw new Error('Missing upgrade transaction');
        lifecycle.upgradeEvents += 1;
        lifecycle.oldVersion = event.oldVersion;
        lifecycle.newVersion = event.newVersion;
        if (event.oldVersion < 1) open.result.createObjectStore('notes', { keyPath: 'id' });
        if (version !== 'A' && event.oldVersion < 2)
          migrate(tx, () => {
            if (version !== 'B-abort') return;
            injected = true;
            tx.abort();
          });
      };
      let db: IDBDatabase;
      try {
        db = await request(open);
      } catch (error) {
        // An AbortError is reported only when this adapter really aborted after its writes.
        if (version === 'B-abort' && !injected)
          throw new Error('Open failed before the injected abort was reached', { cause: error });
        throw error;
      }
      return {
        database: db,
        close: () => db.close(),
        operations: {
          put: async (input: Json) => {
            const note = input as unknown as Note;
            if (
              !Number.isInteger(note.id) ||
              typeof note.title !== 'string' ||
              typeof note.tag !== 'string'
            )
              throw new TypeError('put requires an integer id, a title and a tag');
            const tx = db.transaction('notes', 'readwrite');
            const done = completed(tx);
            tx.objectStore('notes').put(note);
            await done;
          },
        },
        queries: {
          records: async () =>
            (await request(db.transaction('notes').objectStore('notes').getAll())) as Json,
          record: async (input: Json) =>
            ((await request(
              db
                .transaction('notes')
                .objectStore('notes')
                .get(input as number),
            )) ?? null) as Json,
          byTag: async (input: Json) =>
            (await request(
              db
                .transaction('notes')
                .objectStore('notes')
                .index('by-tag')
                .getAllKeys(input as string),
            )) as Json,
          schema: () => {
            const tx = db.transaction(Array.from(db.objectStoreNames), 'readonly');
            const stores: Record<string, Json> = {};
            for (const name of Array.from(db.objectStoreNames)) {
              const store = tx.objectStore(name);
              stores[name] = {
                keyPath: store.keyPath,
                indexes: Array.from(store.indexNames).map((indexName) => {
                  const index = store.index(indexName);
                  return {
                    name: index.name,
                    keyPath: index.keyPath,
                    unique: index.unique,
                    multiEntry: index.multiEntry,
                  };
                }),
              };
            }
            return { version: db.version, stores };
          },
          lifecycle: () => ({ ...lifecycle }),
        },
      };
    },
  });
}
