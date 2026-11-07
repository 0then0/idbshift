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

/**
 * A → B-abort → A → B in one database. B-abort runs the real v2 migration, then aborts its own
 * upgrade transaction. The AbortError is declared, but only the later stages can show recovery.
 */
export function recoveryHistory(): History {
  const original = [
    { id: 1, title: 'Alpha', tag: 'draft' },
    { id: 2, title: 'Beta', tag: 'final' },
    { id: 3, title: 'Gamma', tag: 'draft' },
  ];
  const migrated = [
    { id: 1, title: 'Alpha', tag: 'draft' },
    { id: 2, title: 'Beta', tag: 'archived' },
    { id: 3, title: 'Gamma', tag: 'draft' },
    { id: 4, title: 'Delta', tag: 'migrated' },
  ];
  const notes = (indexes: Json[]): Json => ({ notes: { keyPath: 'id', indexes } });
  const byTag = { name: 'by-tag', keyPath: 'tag', unique: false, multiEntry: false };
  const stages: Stage[] = [
    {
      id: 'seed-A',
      version: 'A',
      operations: original.map((note) => ({ name: 'put', input: note })),
      checks: [
        {
          name: 'A stores the original records',
          run: async ({ query }) => ({ expected: original, actual: await query('records') }),
        },
      ],
    },
    {
      id: 'abort-B',
      version: 'B-abort',
      expectOpenError: {
        name: 'AbortError',
        reason:
          'B-abort completes its v2 writes, then aborts its own upgrade transaction. The browser must reject the open request with AbortError and roll everything back.',
      },
      checks: [],
    },
    {
      id: 'check-A-after-abort',
      version: 'A',
      checks: [
        {
          name: 'Native version is still 1',
          run: async ({ query }) => ({
            expected: 1,
            actual: ((await query('schema')) as { version: number }).version,
          }),
        },
        {
          name: 'Original records are exact',
          run: async ({ query }) => ({ expected: original, actual: await query('records') }),
        },
        {
          name: 'Record added by the aborted upgrade is absent',
          run: async ({ query }) => ({ expected: null, actual: await query('record', 4) }),
        },
        {
          name: 'Index created by the aborted upgrade is absent',
          run: async ({ query }) => ({
            expected: notes([]),
            actual: ((await query('schema')) as { stores: Json }).stores,
          }),
        },
        {
          name: 'Reopening A ran no upgrade',
          run: async ({ query }) => ({
            expected: { upgradeEvents: 0, oldVersion: null, newVersion: null },
            actual: await query('lifecycle'),
          }),
        },
      ],
    },
    {
      id: 'retry-B',
      version: 'B',
      checks: [
        {
          name: 'Migration ran again, from version 1 to 2',
          run: async ({ query }) => ({
            expected: { upgradeEvents: 1, oldVersion: 1, newVersion: 2 },
            actual: await query('lifecycle'),
          }),
        },
        {
          name: 'Final records are exact',
          run: async ({ query }) => ({ expected: migrated, actual: await query('records') }),
        },
        {
          name: 'Schema has the by-tag index at version 2',
          run: async ({ query }) => {
            const schema = (await query('schema')) as { version: number; stores: Json };
            return {
              expected: { version: 2, stores: notes([byTag]) },
              actual: { version: schema.version, stores: schema.stores },
            };
          },
        },
        {
          name: 'Data is reachable through the by-tag index',
          run: async ({ query }) => ({
            expected: { draft: [1, 3], final: [], archived: [2], migrated: [4] },
            actual: {
              draft: await query('byTag', 'draft'),
              final: await query('byTag', 'final'),
              archived: await query('byTag', 'archived'),
              migrated: await query('byTag', 'migrated'),
            },
          }),
        },
      ],
    },
  ];
  return {
    id: 'native-aborted-migration-recovery',
    databaseName: 'idbshift-recovery',
    versions: {
      A: { appVersion: 'recovery-A', entrypoint: '/examples/recovery/A.ts' },
      'B-abort': { appVersion: 'recovery-B-abort', entrypoint: '/examples/recovery/B-abort.ts' },
      B: { appVersion: 'recovery-B', entrypoint: '/examples/recovery/B.ts' },
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
  recoveryHistory(),
];
