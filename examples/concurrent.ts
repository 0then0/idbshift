import type {
  ConcurrentHistory,
  ConcurrentStep,
  History,
  OracleCheck,
  OracleSchema,
} from 'idbshift';

/**
 * Two documents of one origin use one disposable database at the same time. A is the old
 * application and stays open. B is the new application and requests native version 2.
 *
 * Run with: npm run experiment:concurrent
 */
const databaseName = 'idbshift-notes';
const entry = (name: string): History['versions'][string] => ({
  appVersion: `notes-${name}`,
  entrypoint: `/examples/concurrent/${name === 'next' ? 'new' : `old-${name}`}.ts`,
});
const schemas: OracleSchema[] = [
  { version: 1, stores: { notes: { keyPath: 'id' } } },
  { version: 2, stores: { audit: { keyPath: 'id' }, notes: { keyPath: 'id' } } },
];
const control = { id: 1, text: 'control' };

const nativeVersionIs = (version: number): OracleCheck => ({
  name: `The independent oracle reads native version ${version}`,
  run: async (oracle) => ({ expected: version, actual: await oracle.version() }),
});
const notes = (name: string, expected: unknown[]): OracleCheck => ({
  name,
  run: async (oracle) => ({
    expected: expected as never,
    actual: await oracle.records(
      'notes',
      expected.map((_, index) => index + 1),
      ['id', 'text'],
    ),
  }),
});

function history(
  id: string,
  old: 'holding' | 'cached' | 'guarded' | 'reconnecting',
  policy: ConcurrentHistory['participants']['A']['policy'],
  steps: ConcurrentStep[],
): ConcurrentHistory {
  return {
    kind: 'concurrent',
    id,
    databaseName,
    versions: { old: entry(old), next: entry('next') },
    participants: { A: { version: 'old', policy }, B: { version: 'next' } },
    oracle: { schemas },
    deadlineMs: 10_000,
    steps,
  };
}
const saveControl: ConcurrentStep = {
  action: 'operation',
  participant: 'A',
  name: 'save',
  input: control,
};
const requestUpgrade: ConcurrentStep[] = [
  { action: 'open', participant: 'A' },
  saveControl,
  {
    action: 'start-open',
    participant: 'B',
    note: 'B requests native version 2 and the runner does not wait for it.',
  },
];

/** A holds its connection until a declared command releases it. */
export const heldConnection = history(
  'held-connection-blocks-upgrade',
  'holding',
  {
    kind: 'hold-until-released',
    reason: 'A has no versionchange handler. The history releases its connection explicitly.',
  },
  [
    ...requestUpgrade,
    {
      action: 'wait-for',
      event: { participant: 'A', type: 'versionchange', oldVersion: 1, newVersion: 2 },
    },
    {
      action: 'wait-for',
      event: { participant: 'B', type: 'open-blocked', oldVersion: 1, newVersion: 2 },
      note: 'The native blocked event of the open request: the upgrade waits for A.',
    },
    {
      action: 'close-session',
      participant: 'A',
      note: 'The explicit command that lets the upgrade continue.',
    },
    { action: 'await-open', participant: 'B' },
    {
      action: 'oracle',
      name: 'Control record after the upgrade',
      checks: [nativeVersionIs(2), notes('Control record is preserved', [control])],
    },
  ],
);

/**
 * Adapts the failure class of a cached, closed connection promise (see the README). The history
 * shows the operational failure and the data state. It does not claim data loss.
 */
export const cachedClosedConnection = history(
  'cached-closed-connection-write-fails',
  'cached',
  {
    kind: 'no-policy',
    reason:
      'A caches its connection promise and closes the connection on versionchange. It declares no stale-tab behavior, so later writes are expected to succeed.',
  },
  [
    ...requestUpgrade,
    {
      action: 'wait-for',
      event: { participant: 'A', type: 'versionchange', oldVersion: 1, newVersion: 2 },
    },
    { action: 'await-open', participant: 'B' },
    {
      action: 'operation',
      participant: 'A',
      name: 'save',
      input: { id: 2, text: 'after-upgrade' },
      note: 'Expected to succeed. A still holds the cached promise of the closed connection.',
    },
    {
      action: 'oracle',
      name: 'Data state after the failed write',
      checks: [
        nativeVersionIs(2),
        notes('Control record is preserved', [control]),
        {
          name: 'The failed write left no record',
          run: async (oracle) => ({
            expected: [null],
            actual: await oracle.records('notes', [2], ['id', 'text']),
          }),
        },
      ],
    },
  ],
);

/** A declares that it stops writing and requires a reload. */
export const declaredStaleWriteRefusal = history(
  'declared-stale-write-refusal',
  'guarded',
  {
    kind: 'refuse-writes',
    refusalName: 'UpgradeRequired',
    reason: 'After versionchange A closes its connection and refuses writes until it is reloaded.',
  },
  [
    ...requestUpgrade,
    {
      action: 'wait-for',
      event: { participant: 'A', type: 'signal', name: 'upgrade-required' },
    },
    {
      action: 'operation',
      participant: 'A',
      name: 'save',
      input: { id: 2, text: 'rejected' },
      expect: 'policy-refusal',
      note: 'Runs while B is still opening. The refusal is the declared behavior.',
    },
    { action: 'await-open', participant: 'B' },
    {
      action: 'oracle',
      name: 'Data state after the refusal',
      checks: [
        nativeVersionIs(2),
        notes('Control record is preserved', [control]),
        {
          name: 'The refused write left no record',
          run: async (oracle) => ({
            expected: [null],
            actual: await oracle.records('notes', [2], ['id', 'text']),
          }),
        },
      ],
    },
  ],
);

/**
 * A invalidates its connection and reopens the installed version. This control is valid only for
 * this fixture, where schema 2 adds an unrelated store and keeps everything schema 1 uses.
 */
export const compatibleReconnect = history(
  'compatible-reconnect',
  'reconnecting',
  {
    kind: 'reconnect',
    reason:
      'A drops the closed connection and reopens the installed version. Safe here because schema 2 only adds an unrelated store.',
  },
  [
    ...requestUpgrade,
    {
      action: 'wait-for',
      event: { participant: 'A', type: 'signal', name: 'connection-invalidated' },
    },
    { action: 'await-open', participant: 'B' },
    {
      action: 'operation',
      participant: 'A',
      name: 'save',
      input: { id: 2, text: 'after-upgrade' },
      note: 'A reconnects before writing. The write is expected to succeed.',
    },
    {
      action: 'oracle',
      name: 'Original and new records',
      checks: [
        nativeVersionIs(2),
        notes('Both records are preserved', [control, { id: 2, text: 'after-upgrade' }]),
      ],
    },
  ],
);

export const histories: ConcurrentHistory[] = [
  heldConnection,
  cachedClosedConnection,
  declaredStaleWriteRefusal,
  compatibleReconnect,
];
