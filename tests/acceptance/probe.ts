import { defineAdapter, OpenRefusal } from 'idbshift/browser';
import type { Json } from 'idbshift';

const mode = new URL(import.meta.url).searchParams.get('mode');
let moduleCount = 0;
moduleCount++;
const moduleDocument = crypto.randomUUID();
function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export default defineAdapter({
  appVersion: 'probe',
  async open({ databaseName }) {
    if (mode === 'refuse') throw new OpenRefusal('Old app intentionally refuses this schema');
    if (mode === 'error') throw new Error('Adapter programming error');
    if (mode === 'hang-open') await new Promise(() => {});
    if (mode === 'wrong-db') {
      try {
        indexedDB.open(`${databaseName}-other`);
      } catch {}
    }
    if (mode === 'delete') {
      try {
        indexedDB.deleteDatabase(databaseName);
      } catch {}
    }
    const opening = indexedDB.open(databaseName, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('data');
    const db = await request(opening);
    return {
      database: db,
      close: async () => {
        if (mode === 'hang-close') await new Promise(() => {});
        if (mode === 'busy-close') {
          const until = Date.now() + 3500;
          while (Date.now() < until) await Promise.resolve();
        }
        if (mode === 'sync-close') {
          const until = Date.now() + 3500;
          while (Date.now() < until) {
            /* Simulate a stalled storage shutdown. */
          }
        }
        db.close();
      },
      operations: {
        seed: async () => {
          const tx = db.transaction('data', 'readwrite');
          await request(tx.objectStore('data').add('original', 'seed'));
        },
        write: async () => {
          const tx = db.transaction('data', 'readwrite');
          await request(tx.objectStore('data').put('written', 'later'));
        },
        async writeViaMethod() {
          const write = this.write;
          if (!write) throw new Error('Missing write operation');
          await write(null);
        },
        navigate: async () => {
          location.href = 'http://127.0.0.1:1/';
          await new Promise((r) => setTimeout(r, 200));
        },
      },
      queries: {
        rows: async () =>
          (await request(db.transaction('data').objectStore('data').getAll())) as Json,
        document: () => ({ moduleCount, moduleDocument }),
        wrong: () => 'wrong',
        hang: async () => {
          await new Promise(() => {});
          return null;
        },
        // Deliberately defeat TypeScript to verify the runtime boundary before Playwright transport.
        unsupported: () => ({ date: new Date() }) as unknown as Json,
        unsupportedArray: () => {
          class DiagnosticArray extends Array<Json> {
            toJSON() {
              return ['changed'];
            }
          }
          return new DiagnosticArray('original');
        },
      },
    };
  },
});
