import { defineAdapter } from 'idbshift/browser';
import { recoveryStorage } from '../../examples/recovery/storage.js';

/**
 * Negative control. Before the real aborted migration, this adapter commits a write in its own
 * transaction, so the abort cannot roll it back. The open still fails with AbortError.
 */
const aborting = recoveryStorage('B-abort');
export default defineAdapter({
  appVersion: aborting.appVersion,
  async open({ databaseName }) {
    const connecting = indexedDB.open(databaseName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      connecting.onsuccess = () => resolve(connecting.result);
      connecting.onerror = () => reject(connecting.error);
    });
    const tx = db.transaction('notes', 'readwrite');
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    tx.objectStore('notes').put({ id: 5, title: 'Leaked', tag: 'leaked' });
    await committed;
    db.close();
    return aborting.open({ databaseName });
  },
});
