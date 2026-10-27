import { readFile } from 'node:fs/promises';
import { dexieHistory, nativeHistory } from '../../examples/histories.js';
import { test, expect } from 'idbshift/playwright';
import { renderHtml, runHistory, startAdapterServer, writeReports } from 'idbshift';
import type { Check, History, Json } from 'idbshift';

const rows = (expected: Json): Check => ({
  name: 'Persisted records',
  run: async ({ query }) => ({ expected, actual: await query('rows') }),
});
function probe(mode = ''): History {
  return {
    id: 'external-probe',
    databaseName: 'probe-database',
    versions: { A: { appVersion: 'probe', entrypoint: `/tests/acceptance/probe.ts?mode=${mode}` } },
    stages: [
      { id: 'initial', version: 'A', operations: [{ name: 'seed' }], checks: [rows(['original'])] },
    ],
  };
}

test('Dexie A → B upgrades actual data and indexes', async ({ idbshift }) => {
  const report = await idbshift(dexieHistory(false, false));
  expect(report.verdict).toBe('passed');
  expect(report.stages.map((s) => s.databaseVersion)).toEqual([10, 20]);
});

test('Dexie rollback writes break semantics; upgrade does not repeat', async ({ idbshift }) => {
  const report = await idbshift(dexieHistory(true, false));
  expect(report.verdict).toBe('contract-violation');
  expect(report.firstViolation?.stage).toBe('reopen-B');
  expect(report.stages.map((s) => s.databaseVersion)).toEqual([10, 20, 20, 20]);
  const checks = report.stages[3]?.checks;
  expect(checks?.[0]?.actual).toEqual([
    { id: 1, name: ' ALICE UPDATED ', normalizedName: null },
    { id: 2, name: ' Bob ', normalizedName: null },
  ]);
  expect(checks?.[1]?.actual).toEqual([]);
  expect(checks?.[2]?.actual).toEqual({ upgrades: 0, repairs: 0 });
});

test('Explicit B open-repair policy restores exact normalization and index keys', async ({
  idbshift,
}) => {
  const report = await idbshift(dexieHistory(true, true));
  expect(report.verdict).toBe('passed');
  expect(report.stages[3]?.checks[1]?.actual).toEqual([1, 2]);
  expect(report.stages[3]?.checks[2]?.actual).toEqual({ upgrades: 0, repairs: 2 });
});

test('Native ledger plugs into the same public API and conserves signed cents', async ({
  idbshift,
}) => {
  const report = await idbshift(nativeHistory(false));
  expect(report.verdict).toBe('passed');
  expect(report.stages[1]?.checks[1]?.actual).toBe(900);
});

test('Native strict rollback refusal is accepted policy, not compatibility PASS', async ({
  idbshift,
}) => {
  const report = await idbshift(nativeHistory(true));
  expect(report.verdict).toBe('expected-refusal');
  expect(report.stages[2]?.status).toBe('open-refused');
  expect(report.stages[2]?.databaseVersion).toBe(2);
  expect(report.stages[2]?.refusalExpected).toBe(true);
  expect(report.stages[3]?.status).toBe('passed');
});

test('Histories isolate the same origin and database name; seed runs only once; stages use new documents', async ({
  idbshift,
}) => {
  const history = probe();
  const documents: string[] = [];
  const documentCheck: Check = {
    name: 'Fresh module globals',
    run: async ({ query }) => {
      const value = (await query('document')) as { moduleCount: number; moduleDocument: string };
      documents.push(value.moduleDocument);
      return { expected: 1, actual: value.moduleCount };
    },
  };
  history.stages[0]?.checks.push(documentCheck);
  history.stages.push(
    {
      id: 'write-again',
      version: 'A',
      operations: [{ name: 'write' }],
      checks: [rows(['written', 'original']), documentCheck],
    },
    { id: 'read-again', version: 'A', checks: [rows(['written', 'original']), documentCheck] },
  );
  const first = await idbshift(history);
  const second = await idbshift(history);
  expect(first.verdict).toBe('passed');
  expect(second.verdict).toBe('passed');
  expect(new Set(documents).size).toBe(6);
  expect(new Set([...first.stages, ...second.stages].map((s) => s.documentId)).size).toBe(6);
  expect(first.origin).toBe(second.origin);
  expect(first.stages.flatMap((s) => s.operations).filter((op) => op.name === 'seed')).toHaveLength(
    1,
  );
});

test('Wrong origin is rejected before open and an attempted origin escape is detected', async ({
  browser,
  idbshift,
}) => {
  const invalid = probe();
  invalid.versions.A = { appVersion: 'probe', entrypoint: 'http://127.0.0.1:4999/probe.ts' };
  const report = await runHistory(browser, invalid, { origin: 'http://127.0.0.1:4998' });
  expect(report.verdict).toBe('error');
  const navigation = probe();
  navigation.stages[0]?.operations?.push({ name: 'navigate' });
  const escaped = await idbshift(navigation);
  expect(escaped.verdict).toBe('error');
  expect(escaped.stages[0]?.error?.kind).toBe('origin');
});

for (const mode of ['wrong-db', 'delete'])
  test(`Database identity guard detects ${mode}, even when adapter swallows error`, async ({
    idbshift,
  }) => {
    const report = await idbshift(probe(mode));
    expect(report.verdict).toBe('error');
    expect(report.stages[0]?.cleanupError?.kind).toBe('database-identity');
  });

test('Unexpected refusal, programming error and assertion failure have different outcomes', async ({
  idbshift,
}) => {
  const refused = await idbshift(probe('refuse'));
  expect(refused.verdict).toBe('open-refused');
  const error = await idbshift(probe('error'));
  expect(error.verdict).toBe('error');
  const failed = probe();
  failed.stages[0]?.checks.push({ ...rows(['missing']), name: 'Missing record invariant' });
  const violation = await idbshift(failed);
  expect(violation.verdict).toBe('contract-violation');
});

test('A missing expected refusal cannot pass and an empty assertion list cannot pass', async ({
  idbshift,
}) => {
  const history = probe();
  const first = history.stages[0];
  if (!first) throw new Error('Missing stage');
  first.expectOpenRefusal = { name: 'VersionError', reason: 'Test policy' };
  expect((await idbshift(history)).verdict).toBe('error');
  delete first.expectOpenRefusal;
  first.checks = [];
  expect((await idbshift(history)).verdict).toBe('error');
});

test('Assertion exceptions and unsupported diagnostic values are errors, never PASS', async ({
  idbshift,
}) => {
  const throwing = probe();
  throwing.stages[0]?.checks.push({
    name: 'Broken verifier',
    run: async () => {
      throw new Error('Verifier crashed');
    },
  });
  const result = await idbshift(throwing);
  expect(result.verdict).toBe('error');
  expect(result.stages[0]?.checks[1]?.status).toBe('error');
  const unsupported = probe();
  unsupported.stages[0]?.checks.push({
    name: 'Unsupported date',
    run: async ({ query }) => ({ expected: null, actual: await query('unsupported') }),
  });
  expect((await idbshift(unsupported)).verdict).toBe('error');
});

test('Timeout and cancellation stop remaining stages and release contexts and pages', async ({
  browser,
  idbshift,
}) => {
  const count = browser.contexts().length;
  const hanging = probe('hang-open');
  hanging.deadlineMs = 250;
  hanging.stages.push({ id: 'never-run', version: 'A', checks: [rows([])] });
  const timedOut = await idbshift(hanging);
  expect(timedOut.verdict).toBe('blocked');
  expect(timedOut.stages[0]?.error?.kind).toBe('deadline');
  expect(timedOut.stages[1]?.status).toBe('not-run');
  expect(browser.contexts()).toHaveLength(count);
  const host = await startAdapterServer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    const cancelled = await runHistory(browser, probe('hang-open'), {
      origin: host.origin,
      signal: controller.signal,
    });
    expect(cancelled.verdict).toBe('blocked');
    expect(cancelled.stages[0]?.error?.kind).toBe('cancelled');
  } finally {
    clearTimeout(timer);
    await host.close();
  }
  expect(browser.contexts()).toHaveLength(count);
  await expect(fetch(`${host.origin}/`)).rejects.toThrow();
  expect((await idbshift(probe())).verdict).toBe('passed');
});

test('Hanging assertion and hanging close are bounded and resources are released after errors', async ({
  browser,
  idbshift,
}) => {
  const count = browser.contexts().length;
  const hanging = probe();
  hanging.deadlineMs = 500;
  hanging.stages[0]?.checks.push({
    name: 'Unfinished query',
    run: async ({ query }) => ({ expected: null, actual: await query('hang') }),
  });
  const timeout = await idbshift(hanging);
  expect(timeout.verdict).toBe('blocked');
  const closed = await idbshift(probe('hang-close'));
  expect(closed.verdict).toBe('error');
  expect(closed.stages[0]?.cleanupError?.phase).toBe('close');
  await idbshift(probe('error'));
  expect(browser.contexts()).toHaveLength(count);
});

test('First violation survives later PASS in JSON, text and portable offline HTML', async ({
  idbshift,
  browser,
}, testInfo) => {
  const history = probe();
  history.stages[0]?.checks.push({
    name: 'First broken invariant <script>alert(1)</script>',
    run: async () => ({ expected: 'expected-value', actual: 'actual-value' }),
  });
  history.stages.push({ id: 'later-pass', version: 'A', checks: [rows(['original'])] });
  const report = await idbshift(history);
  expect(report.verdict).toBe('contract-violation');
  expect(report.stages[1]?.status).toBe('passed');
  const paths = await writeReports([report], testInfo.outputPath('portable'));
  const json = JSON.parse(await readFile(paths.json, 'utf8'));
  expect(json.schemaVersion).toBe('1');
  expect(json.histories[0].firstViolation.stage).toBe('initial');
  expect(await readFile(paths.text, 'utf8')).toContain('First violation: initial');
  const html = await readFile(paths.html, 'utf8');
  expect(html).toContain('First contract violation');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>alert');
  expect(renderHtml([report])).toBe(html);
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  try {
    await page.goto(new URL(`file://${paths.html}`).href);
    await expect(page.getByRole('heading', { name: 'Version history report' })).toBeVisible();
    await expect(page.getByText('First contract violation', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Actual', exact: true })).toBeVisible();
    expect(await page.locator('details[open]').count()).toBeGreaterThan(0);
    const disclosure = page.locator('details').first();
    await disclosure.locator('summary').click();
    await expect(disclosure).toHaveAttribute('open', '');
    await disclosure.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).not.toHaveAttribute('open', '');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download JSON' }).click();
    const download = await downloadEvent;
    const downloaded = testInfo.outputPath('downloaded-report.json');
    await download.saveAs(downloaded);
    expect(JSON.parse(await readFile(downloaded, 'utf8'))).toEqual(json);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: testInfo.outputPath('report-mobile-dark.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({
      path: testInfo.outputPath('report-desktop-light.png'),
      fullPage: true,
    });
    expect(requests.filter((url) => !url.startsWith('file:'))).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Later adapter error preserves earlier semantic violation and reports unexecuted stages', async ({
  idbshift,
}) => {
  const history = probe();
  history.stages[0]?.checks.push({
    name: 'Earlier violation',
    run: async () => ({ expected: 1, actual: 2 }),
  });
  history.versions.B = { appVersion: 'probe', entrypoint: '/tests/acceptance/probe.ts?mode=error' };
  history.stages.push(
    { id: 'later-error', version: 'B', checks: [rows([])] },
    { id: 'not-executed', version: 'A', checks: [rows([])] },
  );
  const result = await idbshift(history);
  expect(result.verdict).toBe('error');
  expect(result.firstViolation?.stage).toBe('initial');
  expect(result.firstProblem?.stage).toBe('initial');
  expect(result.stages[2]?.status).toBe('not-run');
  expect(result.stages[1]?.error?.message).toContain('Adapter programming error');
});

test('Application declaration mismatch and inherited API names cannot pass', async ({
  idbshift,
}) => {
  const mismatch = probe();
  mismatch.versions.A = { appVersion: 'incorrect', entrypoint: '/tests/acceptance/probe.ts' };
  expect((await idbshift(mismatch)).verdict).toBe('error');
  const inherited = probe();
  inherited.stages[0]?.checks.push({
    name: 'Invalid query',
    run: async ({ query }) => ({ expected: {}, actual: await query('constructor') }),
  });
  expect((await idbshift(inherited)).verdict).toBe('error');
});

test('Original SVG icon remains visible on light and dark backgrounds', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const svg = await readFile(new URL('../../assets/icon.svg', import.meta.url), 'utf8');
  try {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 380, height: 220 });
      await page.setContent(
        `<html lang="en"><body style="margin:0;padding:40px;background:${scheme === 'light' ? '#fff' : '#101820'}">${svg}</body></html>`,
      );
      await expect(page.getByRole('img')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`icon-${scheme}.png`) });
    }
  } finally {
    await context.close();
  }
});

for (const mode of ['busy-close', 'sync-close']) {
  test(`Node deadline interrupts ${mode} and releases its context`, async ({
    browser,
    idbshift,
  }) => {
    const count = browser.contexts().length;
    const result = await idbshift(probe(mode));
    expect(result.verdict).toBe('error');
    expect(result.stages[0]?.cleanupError).toMatchObject({
      kind: 'close-deadline',
      phase: 'close',
    });
    expect(result.firstProblem?.message).toContain('close deadline');
    expect(browser.contexts()).toHaveLength(count);
  });
}

test('Cancellation remains active during storage shutdown', async ({ browser, idbshift }) => {
  const count = browser.contexts().length;
  const controller = new AbortController();
  const history = probe('busy-close');
  let timer: ReturnType<typeof setTimeout> | undefined;
  history.stages[0]?.checks.push({
    name: 'Read before shutdown',
    run: async ({ query }) => {
      const actual = await query('rows');
      timer = setTimeout(() => controller.abort(), 250);
      return { expected: ['original'], actual };
    },
  });
  try {
    const result = await idbshift(history, { signal: controller.signal });
    expect(result.verdict).toBe('blocked');
    expect(result.stages[0]?.cleanupError).toMatchObject({ kind: 'cancelled', phase: 'close' });
    expect(result.firstProblem?.message).toBe('History cancelled');
    expect(browser.contexts()).toHaveLength(count);
  } finally {
    clearTimeout(timer);
  }
});

test('Custom array serialization is rejected in browser queries and Node assertions', async ({
  idbshift,
}) => {
  const browserValue = probe();
  browserValue.stages[0]?.checks.push({
    name: 'Reject transformed diagnostics',
    run: async ({ query }) => ({ expected: ['changed'], actual: await query('unsupportedArray') }),
  });
  const browserResult = await idbshift(browserValue);
  expect(browserResult.verdict).toBe('error');
  expect(browserResult.stages[0]?.checks[1]?.error?.message).toContain('plain JSON');

  class DiagnosticArray extends Array<Json> {
    toJSON() {
      return ['changed'];
    }
  }
  const nodeValue = probe();
  nodeValue.stages[0]?.checks.push({
    name: 'Reject transformed expectations',
    run: async () => ({ expected: new DiagnosticArray('original'), actual: ['changed'] }),
  });
  expect((await idbshift(nodeValue)).verdict).toBe('error');
});

test('Reports snapshot diagnostics before later checks mutate their source objects', async ({
  idbshift,
}, testInfo) => {
  const expected: Json[] = [1];
  const actual: Json[] = [2];
  const history = probe();
  history.stages[0]?.checks.push({
    name: 'Original mismatch',
    run: async () => ({ expected, actual }),
  });
  history.stages.push({
    id: 'later-pass',
    version: 'A',
    checks: [
      {
        name: 'Later read',
        run: async ({ query }) => {
          expected[0] = 2;
          actual[0] = 3;
          return { expected: ['original'], actual: await query('rows') };
        },
      },
    ],
  });
  const result = await idbshift(history);
  expect(result.verdict).toBe('contract-violation');
  expect(result.stages[0]?.checks[1]).toMatchObject({
    status: 'failed',
    expected: [1],
    actual: [2],
  });
  expect(result.stages[1]?.status).toBe('passed');
  const paths = await writeReports([result], testInfo.outputPath('snapshots'));
  const json = JSON.parse(await readFile(paths.json, 'utf8'));
  expect(json.histories[0].stages[0].checks[1]).toMatchObject({ expected: [1], actual: [2] });
  const html = await readFile(paths.html, 'utf8');
  expect(html).toContain('<pre>[\n  1\n]</pre>');
  expect(html).toContain('<pre>[\n  2\n]</pre>');
});

test('Operation methods retain their receiver and execute the real write path', async ({
  idbshift,
}) => {
  const history = probe();
  const stage = history.stages[0];
  if (!stage) throw new Error('Missing stage');
  stage.operations?.push({ name: 'writeViaMethod' });
  stage.checks = [rows(['written', 'original'])];
  const result = await idbshift(history);
  expect(result.verdict).toBe('passed');
  expect(result.stages[0]?.operations.map((op) => op.status)).toEqual(['completed', 'completed']);
});

test('First problem keeps the cause of the first mismatch when a later verifier throws', async ({
  idbshift,
}) => {
  const history = probe();
  history.stages[0]?.checks.push(
    { name: 'First mismatch', run: async () => ({ expected: 1, actual: 2 }) },
    {
      name: 'Later error',
      run: async () => {
        throw new Error('Second verifier crashed');
      },
    },
  );
  const result = await idbshift(history);
  expect(result.verdict).toBe('error');
  expect(result.firstProblem).toEqual(result.firstViolation);
  expect(result.firstProblem?.check).toBe('First mismatch');
  expect(result.firstProblem?.message).toBe('Expected and actual values differ');
  expect(result.stages[0]?.error).toMatchObject({
    phase: 'check:Later error',
    message: 'Second verifier crashed',
  });
});

test('Cancellation before the first stage records its first problem without running operations', async ({
  idbshift,
}) => {
  const result = await idbshift(probe(), { signal: AbortSignal.abort() });
  expect(result.verdict).toBe('blocked');
  expect(result.firstProblem).toMatchObject({ stage: 'initial', message: 'History cancelled' });
  expect(result.stages[0]?.operations).toEqual([]);
});
