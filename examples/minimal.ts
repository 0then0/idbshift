import type { History } from 'idbshift';

// Replace these browser entrypoints and operation/query names with your own storage API.
export const histories: History[] = [
  {
    id: 'my-ledger-upgrade',
    databaseName: 'my-disposable-ledger',
    versions: {
      A: { appVersion: 'ledger-A', entrypoint: '/examples/native/A.ts' },
      B: { appVersion: 'ledger-B', entrypoint: '/examples/native/B.ts' },
    },
    stages: [
      {
        id: 'prepare-A',
        version: 'A',
        operations: [{ name: 'deposit', input: { id: 1, cents: 1200 } }],
        checks: [
          {
            name: 'Public read preserves deposit',
            run: async ({ query }) => ({
              expected: [{ id: 1, cents: 1200 }],
              actual: await query('entries'),
            }),
          },
        ],
      },
      {
        id: 'open-B',
        version: 'B',
        checks: [
          {
            name: 'Balance preserved by migration',
            run: async ({ query }) => ({ expected: 1200, actual: await query('balance') }),
          },
        ],
      },
    ],
  },
];
