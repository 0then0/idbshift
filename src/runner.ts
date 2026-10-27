import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { StorageAdapter } from './browser.js';
import { assertJson } from './json.js';
import type { Diagnostic, History, HistoryResult, Json, StageResult } from './types.js';

const require = createRequire(import.meta.url);
const toolVersion = '0.1.0';
const dependencies = Object.fromEntries(
  ['@playwright/test', 'playwright', 'playwright-core', 'vite', 'dexie'].map((name) => {
    try {
      return [name, (require(`${name}/package.json`) as { version: string }).version];
    } catch {
      return [name, 'not installed'];
    }
  }),
);

export interface RunOptions {
  origin: string;
  signal?: AbortSignal;
  /** Opt-in: traces can contain sensitive data and source locations. */
  tracePath?: string;
  step?: <T>(name: string, body: () => Promise<T>) => Promise<T>;
}

class RunFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

function safeMessage(message: string): string {
  let safe = message.split('\n')[0] ?? 'Unknown error';
  for (const path of [process.cwd(), process.env.HOME, process.env.USERPROFILE]) {
    if (path) safe = safe.replaceAll(path, '[local path]');
  }
  return safe.slice(0, 2000);
}

function diagnostic(error: unknown, phase: string): Diagnostic {
  // No stack, page logs, cookies, storage state, or database dump in default diagnostics.
  return {
    kind: error instanceof RunFailure ? error.kind : error instanceof Error ? error.name : 'Error',
    message:
      error instanceof Error ? safeMessage(error.message) : 'Non-Error thrown by adapter or check',
    phase,
  };
}

function validate(history: History, origin: string) {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new RunFailure('configuration', 'Use an exact HTTP loopback origin, including its port');
  if (!history.id || !history.databaseName || !history.stages.length)
    throw new RunFailure('configuration', 'History id, database name and stages are required');
  const ids = new Set<string>();
  for (const stage of history.stages) {
    if (!stage.id || ids.has(stage.id))
      throw new RunFailure('configuration', 'Stage ids must be unique');
    ids.add(stage.id);
    const version = history.versions[stage.version];
    if (
      !version?.appVersion ||
      !version.entrypoint.startsWith('/') ||
      version.entrypoint.startsWith('//')
    )
      throw new RunFailure(
        'configuration',
        'Versions require appVersion and a root-relative entrypoint',
      );
    if (new URL(version.entrypoint, origin).origin !== origin)
      throw new RunFailure('origin', 'Adapter entrypoint changes origin');
    const deadline = stage.deadlineMs ?? history.deadlineMs ?? 10_000;
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > 120_000)
      throw new RunFailure('configuration', 'Stage deadlines must be integers from 1 to 120000 ms');
    const checks = new Set<string>();
    for (const check of stage.checks) {
      if (!check.name || checks.has(check.name))
        throw new RunFailure('configuration', 'Check names must be nonempty and unique per stage');
      checks.add(check.name);
    }
    for (const op of stage.operations ?? []) if (op.input !== undefined) assertJson(op.input);
    if (
      stage.expectOpenRefusal &&
      (!stage.expectOpenRefusal.name || !stage.expectOpenRefusal.reason)
    )
      throw new RunFailure(
        'configuration',
        'Expected refusals require an exact name and a policy reason',
      );
  }
}

async function installGuards(context: BrowserContext, databaseName: string) {
  await context.addInitScript(
    ({ databaseName }) => {
      const violations: string[] = [];
      window.__idbshiftGuard = { violations, documentId: crypto.randomUUID() };
      const originalOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, version) {
        if (String(name) !== databaseName) {
          violations.push('Adapter attempted to open a different database');
          throw new Error('IDBShift database identity guard');
        }
        return version === undefined
          ? originalOpen.call(this, name)
          : originalOpen.call(this, name, version);
      };
      IDBFactory.prototype.deleteDatabase = () => {
        violations.push('Database deletion is forbidden within a history');
        throw new Error('IDBShift database deletion guard');
      };
    },
    { databaseName },
  );
}

async function closeStage(
  page: Page,
  databaseName: string,
  sr: StageResult,
  origin: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new RunFailure('cancelled', 'History cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RunFailure('close-deadline', 'Adapter close deadline exceeded')),
      1000,
    );
    abort = () => reject(new RunFailure('cancelled', 'History cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  const close = async () => {
    await page.evaluate(async () => {
      await window.__idbshift?.session.close();
    });
    const after = await page.evaluate(
      async (name) => ({
        documentId: window.__idbshiftGuard?.documentId,
        violations: window.__idbshiftGuard?.violations,
        database: (await indexedDB.databases()).find((db) => db.name === name),
      }),
      databaseName,
    );
    if (after.documentId !== sr.documentId || page.url() !== `${origin}/`)
      throw new RunFailure('document', 'Adapter replaced the stage document or changed origin');
    if (after.violations?.length)
      throw new RunFailure('database-identity', after.violations.join('; '));
    const observedVersion = after.database?.version;
    if (sr.databaseVersion !== undefined && observedVersion !== sr.databaseVersion)
      throw new RunFailure('database-identity', 'Observed database changed during the stage');
    return observedVersion;
  };
  try {
    // The deadline must run in Node, independently of a stalled renderer event loop.
    return await Promise.race([close(), interruption]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** One context per history. Browser ownership stays with Playwright or the caller. No retries. */
export async function runHistory(
  browser: Browser,
  history: History,
  options: RunOptions,
): Promise<HistoryResult> {
  const started = performance.now();
  const result: HistoryResult = {
    schemaVersion: '1',
    toolVersion,
    history: history.id,
    databaseName: history.databaseName,
    origin: options.origin,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    verdict: 'passed',
    stages: [],
    environment: {
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      dependencies,
    },
    limitations: [
      'PASS applies only to this executed history and its declared checks.',
      'Sequential documents only. No multi-tab, service worker, crash, quota or eviction testing.',
      'Adapters and read-only queries are trusted test code. Diagnostic values are explicitly selected JSON.',
      'A trace supplements semantic assertions; it does not establish data correctness.',
    ],
  };
  let context: BrowserContext | undefined;
  let tracing = false;
  let previousVersion: number | undefined;
  let stopReason: string | undefined;
  try {
    validate(history, options.origin);
    if (browser.browserType().name() !== 'chromium')
      throw new RunFailure('configuration', 'v0.1 has only been acceptance-tested with Chromium');
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await installGuards(context, history.databaseName);
    let networkViolation: string | undefined;
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== options.origin) {
        networkViolation = 'Request attempted to leave the controlled origin';
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    if (options.tracePath) {
      await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
      tracing = true;
    }
    for (const stage of history.stages) {
      const entry = history.versions[stage.version];
      if (!entry) throw new RunFailure('configuration', 'Missing version');
      const sr: StageResult = {
        id: stage.id,
        version: stage.version,
        appVersion: entry.appVersion,
        status: 'not-run',
        durationMs: 0,
        operations: [],
        checks: [],
      };
      result.stages.push(sr);
      const recordProblem = (message: string, check?: string) => {
        result.firstProblem ??= { stage: stage.id, check, message };
      };
      if (stopReason || options.signal?.aborted) {
        sr.error = {
          kind: options.signal?.aborted ? 'cancelled' : 'previous-stage',
          message: stopReason ?? 'History cancelled',
          phase: 'setup',
        };
        if (!stopReason) {
          sr.status = 'blocked';
          stopReason = 'History cancelled';
          recordProblem(stopReason);
        }
        continue;
      }
      const stageStart = performance.now();
      let page: Page | undefined;
      let phase = 'document';
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      let stageFinished = false;
      const body = async () => {
        if (!context) throw new Error('Missing context');
        page = await context.newPage();
        page.setDefaultTimeout(stage.deadlineMs ?? history.deadlineMs ?? 10_000);
        await page.goto(`${options.origin}/`, { waitUntil: 'load' });
        const before = await page.evaluate(
          async (name) => ({
            documentId: window.__idbshiftGuard?.documentId,
            database: (await indexedDB.databases()).find((db) => db.name === name),
          }),
          history.databaseName,
        );
        sr.documentId = before.documentId;
        if (previousVersion !== undefined && before.database?.version !== previousVersion)
          throw new RunFailure(
            'database-identity',
            'Database disappeared or changed version between stages',
          );
        phase = 'adapter';
        const opened = await page.evaluate(
          async ({ entrypoint, databaseName, appVersion }) => {
            const module = await import(/* @vite-ignore */ entrypoint);
            const adapter = module.default as StorageAdapter;
            if (adapter?.protocolVersion !== 1 || adapter.appVersion !== appVersion)
              throw new Error('Adapter protocol or declared app version mismatch');
            try {
              const session = await adapter.open({ databaseName });
              window.__idbshift = { session, documentId: window.__idbshiftGuard?.documentId ?? '' };
              if (
                !(session.database instanceof IDBDatabase) ||
                session.database.name !== databaseName
              )
                throw new Error(
                  'Adapter must expose the actual IDBDatabase with the requested name',
                );
              // A transaction on the connection also detects an already-closed handle.
              const store = session.database.objectStoreNames[0];
              if (!store) throw new Error('Adapter database has no object stores');
              session.database.transaction(store, 'readonly');
              return {
                refused: false as const,
                appVersion: adapter.appVersion,
                version: session.database.version,
              };
            } catch (error) {
              if (
                error instanceof Error &&
                (('idbshiftRefusal' in error && error.idbshiftRefusal === true) ||
                  error.name === 'VersionError')
              )
                return {
                  refused: true as const,
                  name: error.name,
                  message: error.message,
                  appVersion: adapter.appVersion,
                };
              throw error;
            }
          },
          {
            entrypoint: entry.entrypoint,
            databaseName: history.databaseName,
            appVersion: entry.appVersion,
          },
        );
        sr.observedAppVersion = opened.appVersion;
        phase = 'open';
        if (opened.refused) {
          sr.status = 'open-refused';
          sr.refusalExpected = opened.name === stage.expectOpenRefusal?.name;
          sr.policyReason = stage.expectOpenRefusal?.reason;
          sr.error = { kind: opened.name, message: safeMessage(opened.message), phase };
          if (!sr.refusalExpected) recordProblem(sr.error.message);
          // Report installed native version even when the old application declines to open.
          sr.databaseVersion = before.database?.version;
          return;
        }
        sr.databaseVersion = opened.version;
        if (stage.expectOpenRefusal)
          throw new RunFailure('unexpected-open', 'Application opened despite expected refusal');
        const activePage = page;
        const ensureActive = () => {
          if (stageFinished) throw new RunFailure('deadline', 'Stage is no longer active');
        };
        for (const operation of stage.operations ?? []) {
          phase = `operation:${operation.name}`;
          const opResult: StageResult['operations'][number] = {
            name: operation.name,
            status: 'error',
          };
          sr.operations.push(opResult);
          await activePage.evaluate(
            async ({ name, json }) => {
              const input = JSON.parse(json) as Json;
              const operations = window.__idbshift?.session.operations;
              const operation = operations?.[name];
              if (!operation || !operations || !Object.hasOwn(operations, name))
                throw new Error(`Unknown operation: ${name}`);
              await operation.call(operations, input);
            },
            { name: operation.name, json: JSON.stringify(operation.input ?? null) },
          );
          ensureActive();
          opResult.status = 'completed';
        }
        sr.status = 'passed';
        for (const check of stage.checks) {
          phase = `check:${check.name}`;
          const cr: StageResult['checks'][number] = { name: check.name, status: 'error' };
          sr.checks.push(cr);
          try {
            const values = await check.run({
              query: async (name, input = null): Promise<Json> => {
                ensureActive();
                assertJson(input);
                const json = await activePage.evaluate(
                  async ({ name, json }) => {
                    const input = JSON.parse(json) as Json;
                    const query = window.__idbshift?.session.queries[name];
                    if (!query || !Object.hasOwn(window.__idbshift?.session.queries ?? {}, name))
                      throw new Error(`Unknown read-only query: ${name}`);
                    return JSON.stringify(await query(input));
                  },
                  { name, json: JSON.stringify(input) },
                );
                return JSON.parse(json) as Json;
              },
            });
            ensureActive();
            assertJson(values.expected);
            assertJson(values.actual);
            cr.expected = JSON.parse(JSON.stringify(values.expected)) as Json;
            cr.actual = JSON.parse(JSON.stringify(values.actual)) as Json;
            cr.status = isDeepStrictEqual(cr.expected, cr.actual) ? 'passed' : 'failed';
            if (cr.status === 'failed') {
              sr.status = 'contract-violation';
              recordProblem('Expected and actual values differ', check.name);
              result.firstViolation ??= {
                stage: stage.id,
                check: check.name,
                message: 'Expected and actual values differ',
              };
            }
          } catch (error) {
            ensureActive();
            cr.error = diagnostic(error, phase);
            recordProblem(cr.error.message, check.name);
            sr.status = 'error';
            throw error;
          }
        }
        if (!stage.checks.length)
          throw new RunFailure(
            'configuration',
            'An opened stage requires at least one semantic check',
          );
      };
      try {
        const interruption = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () =>
              reject(
                new RunFailure('deadline', 'Stage deadline exceeded; data loss is not established'),
              ),
            stage.deadlineMs ?? history.deadlineMs ?? 10_000,
          );
          abort = () => reject(new RunFailure('cancelled', 'History cancelled'));
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
        });
        const execute = () => Promise.race([body(), interruption]);
        if (options.step) await options.step(`${stage.id} (${entry.appVersion})`, execute);
        else await execute();
      } catch (error) {
        sr.error = diagnostic(error, phase);
        const unfinished = sr.checks.at(-1);
        if (unfinished?.status === 'error' && !unfinished.error) unfinished.error = sr.error;
        recordProblem(sr.error.message, phase.startsWith('check:') ? unfinished?.name : undefined);
        sr.status =
          error instanceof RunFailure && ['deadline', 'cancelled'].includes(error.kind)
            ? 'blocked'
            : 'error';
      } finally {
        stageFinished = true;
        clearTimeout(deadlineTimer);
        if (abort) options.signal?.removeEventListener('abort', abort);
        if (page && !page.isClosed()) {
          try {
            // Close is bounded independently, even when open or a check timed out.
            if (sr.status !== 'blocked') {
              phase = 'close';
              previousVersion = await closeStage(
                page,
                history.databaseName,
                sr,
                options.origin,
                options.signal,
              );
            }
          } catch (error) {
            sr.cleanupError = diagnostic(error, phase);
            recordProblem(sr.cleanupError.message);
            if (!sr.error) sr.error = sr.cleanupError;
            sr.status =
              sr.status === 'blocked' || (error instanceof RunFailure && error.kind === 'cancelled')
                ? 'blocked'
                : 'error';
          } finally {
            await page.close().catch(() => {});
          }
        }
        // A buggy adapter cannot leave auxiliary pages alive between stages.
        if (context?.pages().length) {
          for (const extra of context.pages()) await extra.close().catch(() => {});
          sr.status = 'error';
          sr.error ??= {
            kind: 'extra-page',
            message: 'Adapter opened an extra page; multi-tab histories are unsupported',
            phase: 'close',
          };
        }
        if (networkViolation) {
          sr.status = 'error';
          sr.error = { kind: 'origin', message: networkViolation, phase };
        }
        sr.durationMs = Math.round(performance.now() - stageStart);
      }
      const accepted = sr.status === 'open-refused' && sr.refusalExpected;
      if (sr.status !== 'passed' && !accepted) {
        recordProblem(sr.error?.message ?? 'Declared data contract violated');
        if (sr.status !== 'contract-violation')
          stopReason = `Previous stage ${sr.id} did not complete`;
      }
    }
  } catch (error) {
    result.error = diagnostic(error, 'setup');
    result.verdict = 'error';
  } finally {
    if (tracing && context) {
      try {
        await context.tracing.stop({ path: options.tracePath });
      } catch (error) {
        result.error ??= diagnostic(error, 'trace');
      }
    }
    try {
      await context?.close();
    } catch (error) {
      result.error ??= diagnostic(error, 'context-close');
    }
    result.durationMs = Math.round(performance.now() - started);
  }
  // Operational failure remains visible even if a previous check already found a violation.
  result.verdict =
    result.error || result.stages.some((s) => s.status === 'error')
      ? 'error'
      : result.stages.some((s) => s.status === 'blocked')
        ? 'blocked'
        : result.firstViolation
          ? 'contract-violation'
          : result.stages.some((s) => s.status === 'open-refused' && !s.refusalExpected)
            ? 'open-refused'
            : result.stages.some((s) => s.status === 'open-refused')
              ? 'expected-refusal'
              : 'passed';
  return result;
}
