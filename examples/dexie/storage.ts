import { Dexie, type Table } from 'dexie';
import { defineAdapter } from 'idbshift/browser';
import type { Json } from 'idbshift';

interface Person {
  id: number;
  name: string;
  normalizedName?: string;
}
const normalize = (name: string) => name.trim().toLowerCase();

/** Actual storage code shared by the small browser entrypoints, never called by the verifier. */
export function personStorage(version: 'A' | 'B' | 'B-repair') {
  return defineAdapter({
    appVersion: version,
    async open({ databaseName }) {
      let upgrades = 0;
      let repairs = 0;
      const db = new Dexie(databaseName, { autoOpen: false });
      db.version(1).stores({ people: 'id,name' });
      if (version !== 'A') {
        db.version(2)
          .stores({ people: 'id,name,normalizedName' })
          .upgrade(async (tx) => {
            upgrades++;
            await tx
              .table<Person>('people')
              .toCollection()
              .modify((person) => {
                person.normalizedName = normalize(person.name);
              });
          });
      }
      await db.open();
      const people: Table<Person, number> = db.table('people');
      if (version === 'B-repair') {
        // Explicit application policy: reconcile this derived field on EVERY open.
        await db.transaction('rw', people, async () => {
          await people.toCollection().modify((person) => {
            if (person.normalizedName !== normalize(person.name)) {
              person.normalizedName = normalize(person.name);
              repairs++;
            }
          });
        });
      }
      async function save(input: Json) {
        const value = input as { id: number; name: string };
        if (!Number.isInteger(value.id) || typeof value.name !== 'string')
          throw new TypeError('save requires an integer id and a name');
        const person: Person = { id: value.id, name: value.name };
        if (version !== 'A') person.normalizedName = normalize(value.name);
        // A really replaces the object through its normal write path.
        await people.put(person);
      }
      return {
        database: db.backendDB(),
        close: () => db.close(),
        operations: { save },
        queries: {
          rows: async () =>
            (await people.orderBy('id').toArray()).map((p) => ({
              id: p.id,
              name: p.name,
              normalizedName: p.normalizedName ?? null,
            })),
          indexedIds: async (names) => {
            if (!Array.isArray(names) || !names.every((name) => typeof name === 'string'))
              throw new TypeError('indexedIds requires string names');
            return (
              await people
                .where('normalizedName')
                .anyOf(names as string[])
                .primaryKeys()
            ).sort((a, b) => a - b);
          },
          lifecycle: () => ({ upgrades, repairs }),
        },
      };
    },
  });
}
