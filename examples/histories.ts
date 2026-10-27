import type { Check, History, Json, Stage } from 'idbshift';

const versions = {
  A: { appVersion: 'A', entrypoint: '/examples/dexie/A.ts' },
  B: { appVersion: 'B', entrypoint: '/examples/dexie/B.ts' },
  'B-repair': { appVersion: 'B-repair', entrypoint: '/examples/dexie/B-repair.ts' },
};
const seed: Stage = {
  id: 'seed-A',
  version: 'A',
  operations: [{ name: 'save', input: { id: 1, name: ' Alice ' } }],
  checks: [
    {
      name: 'A public read preserves initial data',
      run: async ({ query }) => ({
        expected: [{ id: 1, name: ' Alice ', normalizedName: null }],
        actual: await query('rows'),
      }),
    },
  ],
};

function peopleChecks(afterRollback: boolean, upgrades: number, repairs: number): Check[] {
  const source = afterRollback
    ? [
        { id: 1, name: ' ALICE UPDATED ' },
        { id: 2, name: ' Bob ' },
      ]
    : [{ id: 1, name: ' Alice ' }];
  return [
    {
      name: 'Stored names and computed normalization match source',
      run: async ({ query }) => ({
        expected: source.map((p) => ({ ...p, normalizedName: p.name.trim().toLowerCase() })),
        actual: await query('rows'),
      }),
    },
    {
      name: 'Public index query returns every expected key',
      run: async ({ query }) => ({
        expected: source.map((p) => p.id),
        actual: await query(
          'indexedIds',
          source.map((p) => p.name.trim().toLowerCase()),
        ),
      }),
    },
    {
      name: 'Upgrade and repair execution in this document',
      run: async ({ query }) => ({
        expected: { upgrades, repairs },
        actual: await query('lifecycle'),
      }),
    },
  ];
}

export function dexieHistory(rollback: boolean, repair: boolean): History {
  const b = repair ? 'B-repair' : 'B';
  const stages: Stage[] = [seed, { id: 'first-B', version: b, checks: peopleChecks(false, 1, 0) }];
  if (rollback)
    stages.push(
      {
        id: 'rollback-A-write',
        version: 'A',
        operations: [
          { name: 'save', input: { id: 1, name: ' ALICE UPDATED ' } },
          { name: 'save', input: { id: 2, name: ' Bob ' } },
        ],
        checks: [
          {
            name: 'A writes through its public API',
            run: async ({ query }) => ({
              expected: [
                { id: 1, name: ' ALICE UPDATED ', normalizedName: null },
                { id: 2, name: ' Bob ', normalizedName: null },
              ],
              actual: await query('rows'),
            }),
          },
        ],
      },
      { id: 'reopen-B', version: b, checks: peopleChecks(true, 0, repair ? 2 : 0) },
    );
  return {
    id: `dexie-${rollback ? 'rollback' : 'upgrade'}-${repair ? 'repair' : 'original'}`,
    databaseName: 'idbshift-people',
    versions,
    stages,
  };
}

export function nativeHistory(rollback: boolean): History {
  const entries: Json = [
    { id: 1, cents: 1250 },
    { id: 2, cents: -350 },
  ];
  const bChecks: Check[] = [
    {
      name: 'Original ledger entries preserved',
      run: async ({ query }) => ({ expected: entries, actual: await query('entries') }),
    },
    {
      name: 'Materialized balance equals sum of signed cents',
      run: async ({ query }) => {
        const rows = (await query('entries')) as { cents: number }[];
        return {
          expected: rows.reduce((sum, row) => sum + row.cents, 0),
          actual: await query('balance'),
        };
      },
    },
  ];
  const stages: Stage[] = [
    {
      id: 'seed-ledger-A',
      version: 'A',
      operations: [
        { name: 'deposit', input: { id: 1, cents: 1250 } },
        { name: 'deposit', input: { id: 2, cents: -350 } },
      ],
      checks: [
        {
          name: 'Ledger public API preserves signed amounts',
          run: async ({ query }) => ({ expected: entries, actual: await query('entries') }),
        },
      ],
    },
    { id: 'upgrade-ledger-B', version: 'B', checks: bChecks },
  ];
  if (rollback)
    stages.push(
      {
        id: 'refuse-ledger-A',
        version: 'A',
        checks: [],
        expectOpenRefusal: {
          name: 'VersionError',
          reason: 'Native version 1 refuses a version 2 database. No rollback writes occur.',
        },
      },
      { id: 'reopen-ledger-B', version: 'B', checks: bChecks },
    );
  return {
    id: `native-ledger-${rollback ? 'refusal' : 'upgrade'}`,
    databaseName: 'idbshift-ledger',
    versions: {
      A: { appVersion: 'ledger-A', entrypoint: '/examples/native/A.ts' },
      B: { appVersion: 'ledger-B', entrypoint: '/examples/native/B.ts' },
    },
    stages,
  };
}

export const histories: History[] = [
  dexieHistory(false, false),
  dexieHistory(true, false),
  dexieHistory(true, true),
  nativeHistory(false),
  nativeHistory(true),
];
