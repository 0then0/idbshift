import { OpenRefusal, defineAdapter, signal } from 'idbshift/browser';
import type { Json } from 'idbshift';

/**
 * Configurable probe for concurrent histories. `?v=` selects the native version to request and
 * `?mode=` a comma separated list of behaviors.
 */
const params = new URL(import.meta.url).searchParams;
const modes = new Set((params.get('mode') ?? '').split(',').filter(Boolean));
const requested = Number(params.get('v') ?? '1');

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const pause = () => new Promise<never>(() => {});

export default defineAdapter({
  appVersion: 'concurrent-probe',
  async open({ databaseName }) {
    if (modes.has('fail-before')) throw new Error('Adapter failed before the upgrade');
    if (modes.has('hang-open')) await pause();
    if (modes.has('wrong-db')) {
      try {
        indexedDB.open(`${databaseName}-other`);
      } catch {}
    }
    if (modes.has('delete')) {
      try {
        indexedDB.deleteDatabase(databaseName);
      } catch {}
    }
    const opening = indexedDB.open(databaseName, requested);
    opening.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) opening.result.createObjectStore('notes', { keyPath: 'id' });
      if (requested >= 2 && event.oldVersion < 2)
        opening.result.createObjectStore('audit', { keyPath: 'id' });
    };
    const onblocked = () => signal('user-blocked-handler');
    if (modes.has('handlers')) opening.onblocked = onblocked;
    const db = await request(opening);
    const onversionchange = () => signal('user-versionchange-handler');
    if (modes.has('handlers')) db.onversionchange = onversionchange;
    if (modes.has('close-on-versionchange')) db.onversionchange = () => db.close();
    if (modes.has('fail-after')) throw new Error('Adapter failed after the upgrade');
    let second: IDBDatabase | undefined;
    const put = async (value: Json) => {
      const tx = db.transaction('notes', 'readwrite');
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
      });
      tx.objectStore('notes').put(value);
      await done;
    };
    return {
      database: db,
      close: async () => {
        if (modes.has('hang-close')) await pause();
        if (modes.has('busy-close')) {
          const until = Date.now() + 3500;
          while (Date.now() < until) {
            /* Simulate a stalled storage shutdown. */
          }
        }
        db.close();
      },
      operations: {
        save: (input: Json) => put(input),
        // Resolves without writing: a successful operation is not proof that data exists.
        ghostSave: async () => {},
        refuse: async () => {
          throw new OpenRefusal('Writes are refused after an upgrade', 'UpgradeRequired');
        },
        closeConnection: async () => db.close(),
        openSecond: async () => {
          second = await request(indexedDB.open(databaseName));
        },
        closeSecond: async () => second?.close(),
        checkHandlers: async () => {
          if (
            modes.has('handlers') &&
            (db.onversionchange !== onversionchange || opening.onblocked !== onblocked)
          )
            throw new Error('An application handler was replaced');
        },
        lateSignal: async () => {
          setTimeout(() => signal('late-callback'), 300);
        },
        outside: async () => {
          await fetch('http://127.0.0.1:1/').catch(() => {});
        },
      },
      queries: {},
    };
  },
});
