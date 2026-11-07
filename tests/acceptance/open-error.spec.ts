import { readFile } from 'node:fs/promises';
import { recoveryHistory } from '../../examples/histories.js';
import { test, expect } from 'idbshift/playwright';
import { renderHtml, runHistory, startAdapterServer, summarize, writeReports } from 'idbshift';
import type { Check, History, Json, Stage } from 'idbshift';
import { nativeHistory } from '../../examples/histories.js';

const rows = (expected: Json): Check => ({
  name: 'Persisted records',
  run: async ({ query }) => ({ expected, actual: await query('rows') }),
});
function stage(history: History, id: string): Stage {
  const found = history.stages.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing stage ${id}`);
  return found;
}
/** A → failing open → A, driven by the probe adapter instead of the example storage. */
function failingOpen(mode: string, name = 'AbortError', entrypoint?: string): History {
  return {
    id: 'open-error-probe',
    databaseName: 'probe-database',
    versions: {
      A: { appVersion: 'probe', entrypoint: '/tests/acceptance/probe.ts' },
      F: {
        appVersion: 'probe',
        entrypoint: entrypoint ?? `/tests/acceptance/probe.ts?mode=${mode}`,
      },
    },
    stages: [
      { id: 'seed', version: 'A', operations: [{ name: 'seed' }], checks: [rows(['original'])] },
      {
        id: 'failing-open',
        version: 'F',
        expectOpenError: { name, reason: 'The probe injects this failure' },
        checks: [],
      },
      { id: 'verify', version: 'A', checks: [rows(['original'])] },
    ],
  };
}

test('Aborted migration: A → B-abort (AbortError) → A-check → B-retry completes in one history', async ({
  idbshift,
  browser,
}, testInfo) => {
  const report = await idbshift(recoveryHistory());
  expect(report.verdict).toBe('passed');
  expect(report.firstProblem).toBeUndefined();
  expect(report.firstViolation).toBeUndefined();
  expect(report.stages.map((s) => [s.id, s.status, s.databaseVersion])).toEqual([
    ['seed-A', 'passed', 1],
    ['abort-B', 'expected-open-error', 1],
    ['check-A-after-abort', 'passed', 1],
    ['retry-B', 'passed', 2],
  ]);
  const aborted = report.stages[1];
  expect(aborted?.openError).toMatchObject({
    expected: { name: 'AbortError' },
    actual: { name: 'AbortError' },
    outcome: 'expected',
  });
  expect(aborted?.openError?.expected.reason).toContain('aborts its own upgrade transaction');
  expect(aborted?.operations).toEqual([]);
  expect(aborted?.checks).toEqual([]);
  expect(aborted?.refusalExpected).toBeUndefined();
  // Recovery is shown by independent data and schema checks, never by the error itself.
  const verification = report.stages.slice(2).flatMap((s) => s.checks);
  expect(verification).toHaveLength(9);
  expect(verification.every((c) => c.status === 'passed')).toBe(true);
  expect(report.stages[3]?.checks[0]?.actual).toEqual({
    upgradeEvents: 1,
    oldVersion: 1,
    newVersion: 2,
  });
  expect(report.stages[2]?.checks[4]?.actual).toEqual({
    upgradeEvents: 0,
    oldVersion: null,
    newVersion: null,
  });
  // Every stage is a new document of the same origin and database.
  expect(new Set(report.stages.map((s) => s.documentId)).size).toBe(4);
  expect(report.databaseName).toBe('idbshift-recovery');
  expect(report.limitations.join(' ')).toContain('not evidence of recovery');

  const paths = await writeReports([report], testInfo.outputPath('recovery'));
  const json = JSON.parse(await readFile(paths.json, 'utf8'));
  expect(json.schemaVersion).toBe('1');
  expect(json.histories[0].stages[1].openError).toEqual(aborted?.openError);
  const text = await readFile(paths.text, 'utf8');
  expect(text).toContain('PASSED native-aborted-migration-recovery');
  expect(text).toContain('expected AbortError, observed AbortError');
  expect(text).toContain('does not establish recovery');
  expect(text).toContain('retry-B / Data is reachable through the by-tag index: passed');
  const html = await readFile(paths.html, 'utf8');
  expect(renderHtml([report])).toBe(html);

  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  try {
    await page.goto(new URL(`file://${paths.html}`).href);
    await expect(page.getByText('Expected open error', { exact: true })).toBeVisible();
    const evidence = page.getByRole('region', { name: 'Recovery evidence after abort-B' });
    await expect(evidence).toContainText('expected AbortError, observed AbortError');
    await expect(evidence).toContainText('The error alone does not establish recovery');
    await expect(evidence.getByRole('listitem')).toHaveCount(9);
    await expect(evidence.getByText('Native version is still 1')).toBeVisible();
    await expect(page.getByText('expected open error', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({
      path: testInfo.outputPath('recovery-mobile-dark.png'),
      fullPage: true,
    });
    expect(requests.filter((url) => !url.startsWith('file:'))).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Reports of histories without an expected open error carry no open-error output', async ({
  idbshift,
}) => {
  const report = await idbshift(nativeHistory(true));
  expect(report.verdict).toBe('expected-refusal');
  expect(report.stages.some((s) => 'openError' in s)).toBe(false);
  expect(report.limitations).toHaveLength(4);
  expect(summarize([report])).not.toContain('open error');
  expect(renderHtml([report])).not.toContain('open-error');
});

test('The same probe-driven abort also recovers, so the outcome is not tied to the example', async ({
  idbshift,
}) => {
  const report = await idbshift(failingOpen('abort-open'));
  expect(report.verdict).toBe('passed');
  expect(report.stages.map((s) => s.status)).toEqual(['passed', 'expected-open-error', 'passed']);
  expect(report.stages.map((s) => s.databaseVersion)).toEqual([1, 1, 1]);
});

test('Success while an open error is expected is a problem and stops the history', async ({
  idbshift,
}) => {
  const history = recoveryHistory();
  stage(history, 'abort-B').version = 'B';
  const report = await idbshift(history);
  expect(report.verdict).toBe('error');
  expect(report.stages[1]).toMatchObject({
    status: 'error',
    openError: { outcome: 'opened', expected: { name: 'AbortError' } },
    error: { kind: 'unexpected-open-success' },
  });
  expect(report.stages[1]?.openError?.actual).toBeUndefined();
  expect(report.firstProblem).toMatchObject({ stage: 'abort-B' });
  expect(report.stages.slice(2).map((s) => s.status)).toEqual(['not-run', 'not-run']);
});

for (const [label, mode] of [
  ['example storage', undefined],
  ['programming error', 'error'],
] as const)
  test(`A different error name is a problem and keeps both names (${label})`, async ({
    idbshift,
  }) => {
    const history = mode ? failingOpen(mode) : recoveryHistory();
    if (!mode) stage(history, 'abort-B').expectOpenError = { name: 'ConstraintError', reason: 'x' };
    const report = await idbshift(history);
    expect(report.verdict).toBe('error');
    const failing = report.stages[1];
    expect(failing?.status).toBe('error');
    expect(failing?.error?.kind).toBe('open-error-mismatch');
    expect(failing?.openError?.outcome).toBe('name-mismatch');
    expect(failing?.openError?.actual?.name).toBe(mode ? 'Error' : 'AbortError');
    expect(failing?.error?.message).toContain(mode ? 'observed Error' : 'observed AbortError');
    expect(report.firstProblem?.stage).toBe(failing?.id);
    expect(report.stages[2]?.status).toBe('not-run');
    const text = summarize([report]);
    expect(text).toContain('name-mismatch');
  });

for (const mode of ['abort-delete', 'commit-then-abort-error'])
  test(`Cleanup failure after the expected error is not absorbed (${mode})`, async ({
    idbshift,
  }) => {
    const report = await idbshift(failingOpen(mode));
    expect(report.verdict).toBe('error');
    const failing = report.stages[1];
    expect(failing?.openError).toMatchObject({ outcome: 'expected' });
    expect(failing?.status).toBe('error');
    expect(failing?.cleanupError).toMatchObject({ kind: 'database-identity', phase: 'close' });
    expect(report.firstProblem?.stage).toBe('failing-open');
    expect(report.stages[2]?.status).toBe('not-run');
  });

test('An application compatibility refusal is never an expected open error', async ({
  idbshift,
}) => {
  const report = await idbshift(failingOpen('refuse', 'CompatibilityRefusal'));
  expect(report.verdict).toBe('open-refused');
  expect(report.stages[1]?.status).toBe('open-refused');
  expect(report.stages[1]?.refusalExpected).toBe(false);
  expect(report.stages[1]?.openError?.outcome).toBe('refused');
  expect(report.stages[2]?.status).toBe('not-run');
});

test('Adapter loading, version and session failures are not absorbed by the expectation', async ({
  idbshift,
}) => {
  const missing = await idbshift(failingOpen('', 'Error', '/tests/acceptance/does-not-exist.ts'));
  expect(missing.verdict).toBe('error');
  expect(missing.stages[1]?.status).toBe('error');
  expect(missing.stages[1]?.openError).toBeUndefined();
  expect(missing.stages[2]?.status).toBe('not-run');

  const version = failingOpen('abort-open');
  const declared = version.versions.F;
  if (!declared) throw new Error('Missing version');
  declared.appVersion = 'another-version';
  const mismatch = await idbshift(version);
  expect(mismatch.verdict).toBe('error');
  expect(mismatch.stages[1]?.error?.message).toContain('declared app version mismatch');
  expect(mismatch.stages[1]?.openError).toBeUndefined();

  // The expected name equals the generic name of a runner contract failure after a successful open.
  const session = await idbshift(failingOpen('bad-session', 'Error'));
  expect(session.verdict).toBe('error');
  expect(session.stages[1]?.status).toBe('error');
  expect(session.stages[1]?.openError).toBeUndefined();
  expect(session.stages[1]?.error?.message).toContain('actual IDBDatabase');
});

test('Deadline and cancellation still block while an open error is expected', async ({
  browser,
  idbshift,
}) => {
  const count = browser.contexts().length;
  const timeout = failingOpen('hang-open');
  stage(timeout, 'failing-open').deadlineMs = 250;
  const timedOut = await idbshift(timeout);
  expect(timedOut.verdict).toBe('blocked');
  expect(timedOut.stages[1]).toMatchObject({ status: 'blocked', error: { kind: 'deadline' } });
  expect(timedOut.stages[1]?.openError).toBeUndefined();
  expect(timedOut.stages[2]?.status).toBe('not-run');

  const host = await startAdapterServer();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Armed after the seed stage reads its data, so the cancellation always lands on the failing open.
  const hanging = failingOpen('hang-open');
  hanging.stages[0]?.checks.push({
    name: 'Arm cancellation',
    run: async ({ query }) => {
      const actual = await query('rows');
      timer = setTimeout(() => controller.abort(), 400);
      return { expected: ['original'], actual };
    },
  });
  try {
    const cancelled = await runHistory(browser, hanging, {
      origin: host.origin,
      signal: controller.signal,
    });
    expect(cancelled.verdict).toBe('blocked');
    expect(cancelled.stages[1]?.error?.kind).toBe('cancelled');
    expect(cancelled.stages[2]?.status).toBe('not-run');
  } finally {
    clearTimeout(timer);
    await host.close();
  }
  expect(browser.contexts()).toHaveLength(count);
});

test('Negative control: a leaked write is found by the read-only check despite the expected AbortError', async ({
  idbshift,
}, testInfo) => {
  const history = recoveryHistory();
  history.versions['B-abort'] = {
    appVersion: 'recovery-B-abort',
    entrypoint: '/tests/acceptance/recovery-leaky.ts',
  };
  const report = await idbshift(history);
  expect(report.verdict).toBe('contract-violation');
  // The declared failure is still recorded as expected and is not hidden by the violation.
  expect(report.stages[1]).toMatchObject({
    status: 'expected-open-error',
    openError: { outcome: 'expected', actual: { name: 'AbortError' } },
  });
  const checked = report.stages[2];
  expect(checked?.status).toBe('contract-violation');
  expect(checked?.checks.map((c) => c.status)).toEqual([
    'passed',
    'failed',
    'passed',
    'passed',
    'passed',
  ]);
  expect(JSON.stringify(checked?.checks[1]?.actual)).toContain('"id":5');
  expect(report.firstViolation).toEqual({
    stage: 'check-A-after-abort',
    check: 'Original records are exact',
    message: 'Expected and actual values differ',
  });
  expect(report.firstProblem).toEqual(report.firstViolation);
  // The data mismatch lets the history continue, so later stages still describe the database.
  expect(report.stages[3]?.status).toBe('contract-violation');
  const paths = await writeReports([report], testInfo.outputPath('leaky'));
  expect(await readFile(paths.text, 'utf8')).toContain(
    'First violation: check-A-after-abort / Original records are exact',
  );
  const html = await readFile(paths.html, 'utf8');
  expect(html).toContain('First contract violation');
  expect(html).toContain('Expected open error');
});

test('An expected open error needs an exact name, a reason and later verification', async ({
  idbshift,
}) => {
  const invalid: [string, (history: History) => void][] = [
    ['reason', (h) => (stage(h, 'abort-B').expectOpenError = { name: 'AbortError', reason: ' ' })],
    ['name', (h) => (stage(h, 'abort-B').expectOpenError = { name: '', reason: 'x' })],
    [
      'refusal',
      (h) => (stage(h, 'abort-B').expectOpenRefusal = { name: 'AbortError', reason: 'x' }),
    ],
    [
      'VersionError',
      (h) => (stage(h, 'abort-B').expectOpenError = { name: 'VersionError', reason: 'x' }),
    ],
    ['checks', (h) => stage(h, 'abort-B').checks.push(rows([]))],
    ['operations', (h) => (stage(h, 'abort-B').operations = [{ name: 'put', input: {} }])],
    ['no later stage', (h) => h.stages.splice(2)],
    [
      'only a refusal later',
      (h) => {
        h.stages.splice(2);
        h.stages.push({
          id: 'refusal',
          version: 'A',
          checks: [],
          expectOpenRefusal: { name: 'VersionError', reason: 'x' },
        });
      },
    ],
  ];
  for (const [label, change] of invalid) {
    const history = recoveryHistory();
    change(history);
    const report = await idbshift(history);
    expect(report.verdict, label).toBe('error');
    expect(report.error?.kind, label).toBe('configuration');
    expect(report.stages, label).toEqual([]);
  }
});
