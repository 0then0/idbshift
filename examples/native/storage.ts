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
interface Entry {
  id: number;
  cents: number;
}

export function ledgerStorage(version: 'A' | 'B') {
  return defineAdapter({
    appVersion: `ledger-${version}`,
    async open({ databaseName }) {
      const open = indexedDB.open(databaseName, version === 'A' ? 1 : 2);
      open.onupgradeneeded = (event) => {
        const db = open.result;
        if (event.oldVersion < 1) db.createObjectStore('entries', { keyPath: 'id' });
        if (version === 'B' && event.oldVersion < 2) {
          const balances = db.createObjectStore('balances');
          const all = open.transaction?.objectStore('entries').getAll();
          if (all)
            all.onsuccess = () =>
              balances.put(
                (all.result as Entry[]).reduce((sum, e) => sum + e.cents, 0),
                'main',
              );
        }
      };
      const db = await request(open); // Native VersionError intentionally refuses rollback.
      return {
        database: db,
        close: () => db.close(),
        operations: {
          deposit: async (input: Json) => {
            const entry = input as unknown as Entry;
            if (!Number.isInteger(entry.id) || !Number.isSafeInteger(entry.cents))
              throw new TypeError('deposit requires an integer id and safe integer cents');
            const tx = db.transaction(
              version === 'B' ? ['entries', 'balances'] : ['entries'],
              'readwrite',
            );
            const done = completed(tx);
            tx.objectStore('entries').add(entry);
            if (version === 'B') {
              const balances = tx.objectStore('balances');
              const balance = balances.get('main');
              balance.onsuccess = () => balances.put(Number(balance.result) + entry.cents, 'main');
            }
            await done;
          },
        },
        queries: {
          entries: async () => {
            const tx = db.transaction('entries', 'readonly');
            return (await request(tx.objectStore('entries').getAll())) as Json;
          },
          balance: async () => {
            const tx = db.transaction('balances', 'readonly');
            return (await request(tx.objectStore('balances').get('main'))) as number;
          },
        },
      };
    },
  });
}
