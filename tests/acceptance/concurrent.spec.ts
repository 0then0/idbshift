import { readFile } from 'node:fs/promises';
import type { Browser } from '@playwright/test';
import {
  cachedClosedConnection,
  compatibleReconnect,
  declaredStaleWriteRefusal,
  heldConnection,
} from '../../examples/concurrent.js';
import { nativeHistory } from '../../examples/histories.js';
import { installGuards } from '../../src/guards.js';
import { oracleApi } from '../../src/oracle.js';
import type { RunOptions } from '../../src/runner.js';
import { test, expect } from 'idbshift/playwright';
import { renderHtml, runConcurrentHistory, startAdapterServer, writeReports } from 'idbshift';
import type {
  ConcurrentHistory,
  ConcurrentHistoryResult,
  ConcurrentStep,
  OldTabPolicy,
  OracleSchema,
  ParticipantEvent,
} from 'idbshift';

const schemas: OracleSchema[] = [
  { version: 1, stores: { notes: { keyPath: 'id' } } },
  { version: 2, stores: { audit: { keyPath: 'id' }, notes: { keyPath: 'id' } } },
];
const control = { id: 1, text: 'control' };
const entry = (version: 1 | 2, mode = '') => ({
  appVersion: 'concurrent-probe',
  entrypoint: `/tests/acceptance/concurrent-probe.ts?v=${version}&mode=${mode}`,
});
const holdPolicy: OldTabPolicy = { kind: 'hold-until-released', reason: 'Test participant A' };

/** A at native v1, B at native v2, one shared database. */
function pair(
  steps: ConcurrentStep[],
  modes: { a?: string; b?: string } = {},
  extra: Partial<ConcurrentHistory> = {},
  policy: OldTabPolicy = holdPolicy,
): ConcurrentHistory {
  return {
    kind: 'concurrent',
    id: 'concurrent-probe',
    databaseName: 'concurrent-probe-database',
    versions: { old: entry(1, modes.a), next: entry(2, modes.b) },
    participants: { A: { version: 'old', policy }, B: { version: 'next' } },
    oracle: { schemas },
    deadlineMs: 5000,
    steps,
    ...extra,
  };
}
const openA: ConcurrentStep = { action: 'open', participant: 'A' };
const saveControl: ConcurrentStep = {
  action: 'operation',
  participant: 'A',
  name: 'save',
  input: control,
};
const startB: ConcurrentStep = { action: 'start-open', participant: 'B' };
const awaitB: ConcurrentStep = { action: 'await-open', participant: 'B' };
const blockedB: ConcurrentStep = {
  action: 'wait-for',
  event: { participant: 'B', type: 'open-blocked' },
};
const closeA: ConcurrentStep = { action: 'close-session', participant: 'A' };
const oracleStep = (name = 'final', expected: unknown[] = [control]): ConcurrentStep => ({
  action: 'oracle',
  name,
  checks: [
    {
      name: 'Records',
      run: async (oracle) => ({
        expected: expected as never,
        actual: await oracle.records(
          'notes',
          expected.map((_, index) => index + 1),
          ['id', 'text'],
        ),
      }),
    },
  ],
});

async function run(
  browser: Browser,
  history: ConcurrentHistory,
  options: Partial<RunOptions> = {},
): Promise<ConcurrentHistoryResult> {
  const host = await startAdapterServer();
  try {
    return await runConcurrentHistory(browser, history, { origin: host.origin, ...options });
  } finally {
    await host.close();
  }
}
const events = (report: ConcurrentHistoryResult, participant: 'A' | 'B'): ParticipantEvent[] =>
  report.events.filter((event) => event.participant === participant);
const types = (list: ParticipantEvent[]) => list.map((event) => event.type);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('A. A holds its connection: versionchange reaches A, blocked reaches B, upgrade follows an explicit release', async ({
  idbshift,
}) => {
  const report = await idbshift(heldConnection);
  expect(report.verdict).toBe('passed');
  const a = events(report, 'A');
  const b = events(report, 'B');
  expect(a.find((event) => event.type === 'versionchange')).toMatchObject({
    connection: 'c1',
    oldVersion: 1,
    newVersion: 2,
  });
  expect(b.find((event) => event.type === 'open-blocked')).toMatchObject({
    oldVersion: 1,
    newVersion: 2,
  });
  // Inside B's own document the order is real: blocked precedes the upgrade it delayed.
  expect(types(b)).toEqual([
    'open-requested',
    'open-blocked',
    'upgrade-needed',
    'upgrade-transaction-complete',
    'open-succeeded',
  ]);
  // A was never closed for the application: the only close is the declared session close.
  expect(types(a).filter((type) => type === 'connection-close-called')).toHaveLength(1);
  expect(types(a).indexOf('session-close-started')).toBeLessThan(
    types(a).indexOf('connection-close-called'),
  );
  expect(report.upgrade).toMatchObject({
    state: 'completed',
    fromVersion: 1,
    requestedVersion: 2,
    oracleNativeVersion: 2,
  });
  const awaited = report.steps.find((step) => step.action === 'await-open');
  expect(awaited?.startedBy).toBe(2);
  expect(report.steps.at(-1)?.checks?.every((check) => check.status === 'passed')).toBe(true);
  // The native blocked event is not the run outcome `blocked`.
  expect(report.steps.some((step) => step.status === 'blocked')).toBe(false);
  expect(report.incomplete).toEqual([]);
});

test('B. A reuses a cached closed connection: operational failure, preserved data, no data-loss verdict', async ({
  idbshift,
}) => {
  const report = await idbshift(cachedClosedConnection);
  expect(report.verdict).toBe('unexpected-operation');
  const failed = report.steps.find((step) => step.status === 'unexpected-failure');
  expect(failed?.operation).toMatchObject({
    name: 'save',
    outcome: 'failed',
    error: { name: 'InvalidStateError' },
  });
  expect(report.firstViolation).toBeUndefined();
  expect(report.firstProblem?.message).toContain('InvalidStateError');
  const oracle = report.steps.at(-1);
  expect(oracle?.status).toBe('completed');
  expect(oracle?.checks?.map((check) => check.status)).toEqual(['passed', 'passed', 'passed']);
  const a = events(report, 'A');
  // The application closed the connection in its own handler and never reopened it.
  expect(types(a).slice(-4)).toEqual([
    'versionchange',
    'connection-close-called',
    'operation-started',
    'operation-finished',
  ]);
  expect(a.at(-1)?.outcome).toBe('failed:InvalidStateError');
  expect(types(events(report, 'B'))).not.toContain('open-blocked');
});

test('C. A declares an upgrade-required policy: the refusal is expected and data is preserved', async ({
  idbshift,
}) => {
  const report = await idbshift(declaredStaleWriteRefusal);
  expect(report.verdict).toBe('expected-refusal');
  const refusal = report.steps.find((step) => step.status === 'policy-refusal');
  expect(refusal?.operation).toMatchObject({
    outcome: 'refused-by-policy',
    error: { name: 'UpgradeRequired' },
  });
  expect(report.firstProblem).toBeUndefined();
  expect(report.steps.at(-1)?.checks?.every((check) => check.status === 'passed')).toBe(true);
  expect(
    events(report, 'A').some((e) => e.type === 'signal' && e.name === 'upgrade-required'),
  ).toBe(true);
});

test('D. Compatible fixture: A invalidates its cache, reconnects and the oracle sees both records', async ({
  idbshift,
}) => {
  const report = await idbshift(compatibleReconnect);
  expect(report.verdict).toBe('passed');
  const a = events(report, 'A');
  const reopened = a.filter((event) => event.type === 'open-succeeded');
  expect(reopened.map((event) => [event.connection, event.version])).toEqual([
    ['c1', 1],
    ['c2', 2],
  ]);
  expect(report.steps.at(-1)?.checks?.[1]?.actual).toEqual([
    { id: 1, text: 'control' },
    { id: 2, text: 'after-upgrade' },
  ]);
});

test('A can act while B is still opening, and the open settles only when awaited', async ({
  idbshift,
}) => {
  const report = await idbshift(
    pair([
      openA,
      saveControl,
      startB,
      blockedB,
      {
        action: 'operation',
        participant: 'A',
        name: 'save',
        input: { id: 2, text: 'while-waiting' },
      },
      closeA,
      awaitB,
      oracleStep('both', [control, { id: 2, text: 'while-waiting' }]),
    ]),
  );
  expect(report.verdict).toBe('passed');
  expect(report.steps[2]?.status).toBe('completed');
  expect(report.steps[2]?.open).toBeUndefined();
  expect(report.steps[6]?.startedBy).toBe(2);
  expect(report.participants.B.opened).toBe(true);
});

test('A second connection of the same participant keeps the upgrade waiting until it closes', async ({
  idbshift,
  browser,
}) => {
  const second: ConcurrentStep = { action: 'operation', participant: 'A', name: 'openSecond' };
  const ok = await idbshift(
    pair([
      openA,
      saveControl,
      second,
      startB,
      blockedB,
      closeA,
      { action: 'operation', participant: 'A', name: 'closeSecond' },
      awaitB,
      oracleStep(),
    ]),
  );
  expect(ok.verdict).toBe('passed');
  const a = events(ok, 'A');
  expect(a.filter((e) => e.type === 'versionchange').map((e) => e.connection)).toEqual([
    'c1',
    'c2',
  ]);
  expect(a.filter((e) => e.type === 'connection-close-called').map((e) => e.connection)).toEqual([
    'c1',
    'c2',
  ]);
  const count = browser.contexts().length;
  const stuck = await idbshift(
    pair([
      openA,
      saveControl,
      second,
      startB,
      blockedB,
      closeA,
      { ...awaitB, deadlineMs: 400 },
      oracleStep(),
    ]),
  );
  // One connection is still open, so the upgrade is genuinely waiting. A deadline says nothing more.
  expect(stuck.verdict).toBe('blocked');
  expect(stuck.upgrade.state).toBe('waiting-for-connection');
  expect(types(events(stuck, 'B'))).toContain('open-blocked');
  expect(stuck.steps[6]?.error?.message).toContain('data loss is not established');
  expect(stuck.steps[7]?.status).toBe('not-run');
  expect(stuck.incomplete.join(' ')).toContain('B upgrade was not confirmed');
  expect(browser.contexts()).toHaveLength(count);
});

test('Application handlers keep working next to the observer', async ({ idbshift }) => {
  const report = await idbshift(
    pair(
      [
        openA,
        saveControl,
        startB,
        {
          action: 'wait-for',
          event: { participant: 'A', type: 'signal', name: 'user-versionchange-handler' },
        },
        {
          action: 'wait-for',
          event: { participant: 'B', type: 'signal', name: 'user-blocked-handler' },
        },
        { action: 'operation', participant: 'A', name: 'checkHandlers' },
        closeA,
        awaitB,
        oracleStep(),
      ],
      { a: 'handlers', b: 'handlers' },
    ),
  );
  expect(report.verdict).toBe('passed');
  // The observer saw the same events the application handlers reacted to.
  expect(types(events(report, 'A'))).toContain('versionchange');
  expect(types(events(report, 'B'))).toContain('open-blocked');
  expect(report.steps[5]?.status).toBe('completed');
});

test('The observer is transparent: names, receivers, arguments, results, handlers and exceptions', async ({
  browser,
}) => {
  const host = await startAdapterServer();
  const context = await browser.newContext();
  try {
    await installGuards(context, 'transparency-database', true);
    const page = await context.newPage();
    await page.goto(`${host.origin}/`);
    const facts = await page.evaluate(async () => {
      const name = 'transparency-database';
      const thrown = (action: () => unknown) => {
        try {
          action();
        } catch (error) {
          return error instanceof Error ? error.name : 'non-error';
        }
        return 'returned';
      };
      const out: Record<string, unknown> = {
        openName: indexedDB.open.name,
        openLength: indexedDB.open.length,
        closeName: IDBDatabase.prototype.close.name,
        closeLength: IDBDatabase.prototype.close.length,
        invalidVersion: thrown(() => indexedDB.open(name, 0)),
        wrongReceiverOpen: thrown(() => Reflect.apply(indexedDB.open, {}, [name])),
        wrongReceiverClose: thrown(() => Reflect.apply(IDBDatabase.prototype.close, {}, [])),
      };
      const request = indexedDB.open(name, 1);
      out.isOpenRequest = request instanceof IDBOpenDBRequest;
      const calls: string[] = [];
      const upgrade = () => {
        request.result.createObjectStore('s');
        calls.push('upgrade');
      };
      request.onupgradeneeded = upgrade;
      out.handlerIdentity = request.onupgradeneeded === upgrade;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => {
          calls.push('success');
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
      });
      out.calls = calls;
      out.closeResult = db.close() === undefined;
      out.deleteGuard = thrown(() => indexedDB.deleteDatabase(name));
      const events = window.__idbshiftGuard?.events?.map((event) => event.type) ?? [];
      out.observed = events;
      out.violations = window.__idbshiftGuard?.violations;
      return out;
    });
    expect(facts).toMatchObject({
      openName: 'open',
      openLength: 1,
      closeName: 'close',
      closeLength: 0,
      invalidVersion: 'TypeError',
      wrongReceiverOpen: 'TypeError',
      wrongReceiverClose: 'TypeError',
      isOpenRequest: true,
      handlerIdentity: true,
      calls: ['upgrade', 'success'],
      closeResult: true,
      observed: [
        'open-requested',
        'upgrade-needed',
        'upgrade-transaction-complete',
        'open-succeeded',
        'connection-close-called',
      ],
    });
    expect(facts.violations).toEqual(['Database deletion is forbidden within a history']);
  } finally {
    await context.close();
    await host.close();
  }
});

test('Cancellation during a blocked open, an adapter open and a stalled close is bounded and releases the context', async ({
  browser,
}) => {
  const count = browser.contexts().length;
  const cancelAt =
    (prefix: string, after: number, controller: AbortController) =>
    async <T>(name: string, body: () => Promise<T>) => {
      if (name.startsWith(prefix)) setTimeout(() => controller.abort(), after);
      return body();
    };

  const blocked = new AbortController();
  const waiting = await run(
    browser,
    pair([openA, saveControl, startB, blockedB, { ...awaitB, deadlineMs: 30_000 }, oracleStep()]),
    {
      signal: blocked.signal,
      step: cancelAt('5.', 300, blocked),
    },
  );
  expect(waiting.verdict).toBe('blocked');
  expect(waiting.steps[4]?.error?.kind).toBe('cancelled');
  expect(waiting.steps[5]?.status).toBe('not-run');
  expect(types(events(waiting, 'B'))).toContain('open-blocked');
  expect(waiting.upgrade.state).toBe('waiting-for-connection');

  const opening = new AbortController();
  const hung = await run(browser, pair([openA, oracleStep('x', [])], { a: 'hang-open' }), {
    signal: opening.signal,
    step: cancelAt('1.', 200, opening),
  });
  expect(hung.verdict).toBe('blocked');
  expect(hung.steps[0]?.error?.kind).toBe('cancelled');

  const closing = new AbortController();
  const stalled = await run(
    browser,
    pair([openA, { ...closeA, deadlineMs: 30_000 }, oracleStep('x', [])], { a: 'busy-close' }),
    { signal: closing.signal, step: cancelAt('2.', 300, closing) },
  );
  expect(stalled.verdict).toBe('blocked');
  expect(stalled.steps[1]?.error?.kind).toBe('cancelled');
  expect(browser.contexts()).toHaveLength(count);
});

test('Deadlines bound a stalled session close and a missing event, and they are not data-loss verdicts', async ({
  browser,
}) => {
  const count = browser.contexts().length;
  const stalled = await run(
    browser,
    pair([openA, { ...closeA, deadlineMs: 300 }, oracleStep('x', [])], { a: 'busy-close' }),
  );
  expect(stalled.verdict).toBe('blocked');
  expect(stalled.steps[1]?.error?.kind).toBe('deadline');
  const silent = await run(
    browser,
    pair([
      openA,
      { action: 'wait-for', event: { participant: 'A', type: 'versionchange' }, deadlineMs: 250 },
      oracleStep('x', []),
    ]),
  );
  expect(silent.verdict).toBe('blocked');
  expect(silent.steps[1]?.error?.message).toContain('data loss is not established');
  expect(silent.firstViolation).toBeUndefined();
  expect(browser.contexts()).toHaveLength(count);
});

test('An adapter failure before the upgrade and one after it are distinguished', async ({
  idbshift,
}) => {
  const releaseOnChange = { a: 'close-on-versionchange' };
  const before = await idbshift(
    pair([openA, saveControl, startB, awaitB, oracleStep()], {
      ...releaseOnChange,
      b: 'fail-before',
    }),
  );
  expect(before.verdict).toBe('error');
  expect(before.steps[3]?.error?.message).toBe('Adapter failed before the upgrade');
  expect(before.upgrade.state).toBe('not-requested');
  expect(before.steps[4]?.status).toBe('not-run');
  const after = await idbshift(
    pair([openA, saveControl, startB, awaitB, oracleStep()], {
      ...releaseOnChange,
      b: 'fail-after',
    }),
  );
  expect(after.verdict).toBe('error');
  expect(after.steps[3]?.error?.message).toBe('Adapter failed after the upgrade');
  expect(after.upgrade.state).toBe('completed');
  expect(after.incomplete.join(' ')).toContain('No independent oracle read completed');
});

test('A refusal that does not happen, or is a native error, never satisfies the declared policy', async ({
  idbshift,
}) => {
  const refusal: OldTabPolicy = {
    kind: 'refuse-writes',
    refusalName: 'UpgradeRequired',
    reason: 'Declared in the test',
  };
  const save = (expect: 'success' | 'policy-refusal'): ConcurrentStep => ({
    action: 'operation',
    participant: 'A',
    name: 'save',
    input: control,
    expect,
  });
  const missing = await idbshift(
    pair([openA, save('policy-refusal'), oracleStep()], {}, {}, refusal),
  );
  expect(missing.verdict).toBe('unexpected-operation');
  expect(missing.steps[1]).toMatchObject({
    status: 'refusal-missing',
    operation: { outcome: 'completed' },
  });
  expect(missing.firstViolation).toBeUndefined();

  // A native InvalidStateError is not a policy refusal, even if the policy names it.
  const native = await idbshift(
    pair(
      [
        openA,
        { action: 'operation', participant: 'A', name: 'closeConnection' },
        save('policy-refusal'),
        oracleStep('x', []),
      ],
      {},
      {},
      { ...refusal, refusalName: 'InvalidStateError' },
    ),
  );
  expect(native.verdict).toBe('unexpected-operation');
  expect(native.steps[2]?.operation?.error?.name).toBe('InvalidStateError');

  // The right refusal where success was declared is an unexpected failure.
  const surprise = await idbshift(
    pair(
      [openA, { action: 'operation', participant: 'A', name: 'refuse' }, oracleStep('x', [])],
      {},
      {},
      refusal,
    ),
  );
  expect(surprise.verdict).toBe('unexpected-operation');
  const accepted = await idbshift(
    pair(
      [
        openA,
        { action: 'operation', participant: 'A', name: 'refuse', expect: 'policy-refusal' },
        oracleStep('x', []),
      ],
      {},
      {},
      refusal,
    ),
  );
  expect(accepted.verdict).toBe('expected-refusal');
});

test('The oracle reports a real mismatch even when the application reported success', async ({
  idbshift,
}) => {
  const report = await idbshift(
    pair([
      openA,
      { action: 'operation', participant: 'A', name: 'ghostSave', input: control },
      oracleStep(),
    ]),
  );
  expect(report.steps[1]?.status).toBe('completed');
  expect(report.verdict).toBe('contract-violation');
  expect(report.firstViolation).toMatchObject({ step: 2, check: 'Records' });
  expect(report.steps[2]?.checks?.[0]?.actual).toEqual([null]);
});

test('Unreadable oracle data is an error, never an empty or passing result', async ({
  idbshift,
  browser,
}) => {
  const steps = [openA, saveControl, oracleStep()];
  const unknownVersion = await idbshift(
    pair(
      steps,
      {},
      { oracle: { schemas: [{ version: 3, stores: { notes: { keyPath: 'id' } } }] } },
    ),
  );
  expect(unknownVersion.verdict).toBe('error');
  expect(unknownVersion.steps[2]?.error?.kind).toBe('oracle-schema-unknown');
  expect(unknownVersion.firstViolation).toBeUndefined();
  const wrongKey = await idbshift(
    pair(
      steps,
      {},
      { oracle: { schemas: [{ version: 1, stores: { notes: { keyPath: 'other' } } }] } },
    ),
  );
  expect(wrongKey.steps[2]?.error?.kind).toBe('oracle-schema-unknown');
  const extraStore = await idbshift(
    pair(
      steps,
      {},
      {
        oracle: {
          schemas: [{ version: 1, stores: { notes: { keyPath: 'id' }, more: { keyPath: 'id' } } }],
        },
      },
    ),
  );
  expect(extraStore.verdict).toBe('error');

  // A missing database is reported and is not created by the attempt.
  const host = await startAdapterServer();
  const context = await browser.newContext();
  try {
    await installGuards(context, 'never-created', true);
    const page = await context.newPage();
    await page.goto(`${host.origin}/`);
    const api = oracleApi(page, 'never-created', schemas, () => {});
    await expect(api.version()).rejects.toMatchObject({ kind: 'oracle-database-missing' });
    await expect(api.records('notes', [1], ['id'])).rejects.toMatchObject({
      kind: 'oracle-database-missing',
    });
    expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
  } finally {
    await context.close();
    await host.close();
  }
});

test('The oracle neither upgrades the database nor holds the upgrade back', async ({
  idbshift,
}) => {
  const report = await idbshift(
    pair(
      [
        openA,
        saveControl,
        oracleStep('before'),
        startB,
        { action: 'wait-for', event: { participant: 'A', type: 'versionchange' } },
        awaitB,
        oracleStep('after'),
      ],
      { a: 'close-on-versionchange' },
    ),
  );
  expect(report.verdict).toBe('passed');
  expect(report.steps.filter((s) => s.oracle).map((s) => s.oracle?.nativeVersion)).toEqual([1, 2]);
  // With A closing on versionchange, the earlier oracle connection left nothing for B to wait on.
  expect(types(events(report, 'B'))).not.toContain('open-blocked');
});

test('Access to another database or origin, or deleting the database, is an error', async ({
  idbshift,
}) => {
  for (const mode of ['wrong-db', 'delete']) {
    const report = await idbshift(pair([openA, oracleStep('x', [])], { a: mode }));
    expect(report.verdict).toBe('error');
    expect(report.steps[0]?.error?.kind).toBe('database-identity');
  }
  const outside = await idbshift(
    pair([openA, { action: 'operation', participant: 'A', name: 'outside' }, oracleStep('x', [])]),
  );
  expect(outside.verdict).toBe('error');
  expect(outside.steps[1]?.error?.kind).toBe('origin');
});

test('Late callbacks after a deadline cannot change the result or leak pages', async ({
  browser,
}) => {
  const count = browser.contexts().length;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  let late: unknown;
  try {
    const report = await run(
      browser,
      pair([
        openA,
        saveControl,
        { action: 'operation', participant: 'A', name: 'lateSignal' },
        {
          action: 'oracle',
          name: 'slow',
          deadlineMs: 1000,
          checks: [
            {
              name: 'Reads after the deadline',
              run: async (oracle) => {
                await pause(1500);
                try {
                  late = await oracle.version();
                } catch (error) {
                  late = error;
                }
                return { expected: 1, actual: 1 };
              },
            },
          ],
        },
      ]),
    );
    const snapshot = JSON.stringify(report);
    expect(report.verdict).toBe('blocked');
    expect(report.steps[3]?.checks?.[0]?.status).toBe('error');
    // The unfinished check explains itself instead of showing empty expected and actual values.
    expect(report.steps[3]?.checks?.[0]?.error).toMatchObject({ kind: 'deadline' });
    await pause(1200);
    expect(late).toMatchObject({ kind: 'stale' });
    expect(JSON.stringify(report)).toBe(snapshot);
    expect(rejections).toEqual([]);
    expect(browser.contexts()).toHaveLength(count);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('Mixed reports keep sequential results unchanged and show two lanes offline', async ({
  idbshift,
  browser,
}, testInfo) => {
  const sequential = await idbshift(nativeHistory(false));
  const concurrent = await idbshift({
    ...heldConnection,
    id: 'lanes <script>alert(1)</script>',
    steps: heldConnection.steps.map((step, index) =>
      index === 5 ? { ...step, note: '<img src=x onerror=alert(2)>' } : step,
    ),
  });
  const only = await writeReports([sequential], testInfo.outputPath('sequential'));
  const onlyJson = JSON.parse(await readFile(only.json, 'utf8'));
  expect(Object.keys(onlyJson)).toEqual(['schemaVersion', 'histories']);
  expect(await readFile(only.html, 'utf8')).not.toContain('class="lanes"');

  const paths = await writeReports([sequential, concurrent], testInfo.outputPath('mixed'));
  const json = JSON.parse(await readFile(paths.json, 'utf8'));
  expect(json.schemaVersion).toBe('1');
  expect(json.histories).toHaveLength(1);
  expect(json.histories[0]).toEqual(onlyJson.histories[0]);
  expect(json.concurrentHistories).toHaveLength(1);
  expect(json.concurrentHistories[0]).toMatchObject({ kind: 'concurrent', verdict: 'passed' });
  const text = await readFile(paths.text, 'utf8');
  expect(text).toContain('PASSED native-ledger-upgrade');
  expect(text).toContain('Upgrade: completed');
  const html = await readFile(paths.html, 'utf8');
  expect(renderHtml([sequential, concurrent])).toBe(html);
  expect(html).toContain('&lt;img src=x');
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('<script>alert');
  expect(html).toContain('IDB blocked event');

  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  try {
    await page.goto(new URL(`file://${paths.html}`).href);
    await expect(page.getByRole('region', { name: 'Participant A' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Participant B' })).toBeVisible();
    await expect(page.getByText('IDB blocked event').first()).toBeVisible();
    await expect(
      page.getByText('not a global browser order', { exact: false }).first(),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({
      path: testInfo.outputPath('concurrent-mobile-dark.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({
      path: testInfo.outputPath('concurrent-desktop-light.png'),
      fullPage: true,
    });
    expect(requests.filter((url) => !url.startsWith('file:'))).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Reports contain selected diagnostics only', async ({ idbshift }) => {
  const report = await idbshift(cachedClosedConnection);
  const serialized = JSON.stringify(report);
  expect(serialized).not.toContain(process.cwd());
  for (const forbidden of ['cookie', 'localStorage', 'sessionStorage', 'storageState', 'stack'])
    expect(serialized).not.toContain(forbidden);
  expect(serialized).not.toContain('after-upgrade');
});
