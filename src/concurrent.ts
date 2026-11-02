import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { ParticipantOpen, StorageAdapter } from './browser.js';
import { RunFailure, dependencies, diagnostic, safeMessage, toolVersion } from './common.js';
import { installGuards } from './guards.js';
import { assertJson } from './json.js';
import { oracleApi } from './oracle.js';
import type { RunOptions } from './runner.js';
import type {
  ConcurrentHistory,
  ConcurrentHistoryResult,
  ConcurrentStep,
  ConcurrentStepResult,
  ConcurrentVerdict,
  History,
  Json,
  ObservedEvent,
  ParticipantEvent,
  ParticipantId,
  UpgradeSummary,
} from './types.js';

const participantIds: ParticipantId[] = ['A', 'B'];
const defaultDeadlineMs = 10_000;
const drainDeadlineMs = 1000;
const cleanupDeadlineMs = 3000;
const refusalNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

export function isConcurrentHistory(
  value: History | ConcurrentHistory,
): value is ConcurrentHistory {
  return 'kind' in value && value.kind === 'concurrent';
}

function stepLabel(step: ConcurrentStep): string {
  switch (step.action) {
    case 'open':
      return `Open ${step.participant}`;
    case 'start-open':
      return `Start opening ${step.participant}`;
    case 'await-open':
      return `Await ${step.participant} open`;
    case 'wait-for':
      return `Wait for ${step.event.participant} ${step.event.type}${step.event.name ? ` ${step.event.name}` : ''}`;
    case 'operation':
      return `${step.participant} operation ${step.name}`;
    case 'close-session':
      return `Close ${step.participant} session`;
    case 'close-page':
      return `Close ${step.participant} page`;
    case 'oracle':
      return `Oracle ${step.name}`;
  }
}

/** Static checks only; nothing here touches a browser. Exported for unit tests. */
export function validateConcurrentHistory(history: ConcurrentHistory, origin: string) {
  function bad(message: string): never {
    throw new RunFailure('configuration', message);
  }
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    bad('Use an exact HTTP loopback origin, including its port');
  if (!history.id || !history.databaseName) bad('History id and database name are required');
  if (!history.steps.length) bad('A concurrent history requires steps');
  for (const id of participantIds) {
    const key = history.participants[id]?.version;
    const entry = key === undefined ? undefined : history.versions[key];
    if (
      !entry?.appVersion ||
      !entry.entrypoint.startsWith('/') ||
      entry.entrypoint.startsWith('//')
    )
      bad(`Participant ${id} requires a version with appVersion and a root-relative entrypoint`);
    if (new URL(entry.entrypoint, origin).origin !== origin)
      throw new RunFailure('origin', 'Adapter entrypoint changes origin');
  }
  const policy = history.participants.A.policy;
  if (!policy?.reason) bad('Participant A requires a declared policy with a reason');
  if ('refusalName' in policy && !refusalNamePattern.test(policy.refusalName))
    bad('Refusal policies require an exact refusal name');
  if (
    ![
      'hold-until-released',
      'no-policy',
      'refuse-writes',
      'read-only',
      'reload-required',
      'reconnect',
    ].includes(policy.kind)
  )
    bad('Unknown participant policy');
  const deadline = (value: number | undefined, label: string) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 120_000))
      bad(`${label} deadlines must be integers from 1 to 120000 ms`);
  };
  deadline(history.deadlineMs, 'History');
  if (!history.oracle?.schemas?.length) bad('The oracle requires at least one declared schema');
  const versions = new Set<number>();
  for (const schema of history.oracle.schemas) {
    if (!Number.isInteger(schema.version) || schema.version < 1 || versions.has(schema.version))
      bad('Oracle schema versions must be unique positive integers');
    versions.add(schema.version);
    if (!Object.keys(schema.stores).length) bad('Oracle schemas require object stores');
  }

  type State = 'new' | 'opening' | 'open' | 'session-closed' | 'page-closed';
  const state: Record<ParticipantId, State> = { A: 'new', B: 'new' };
  const starter: Partial<Record<ParticipantId, number>> = {};
  const oracleNames = new Set<string>();
  let oracleSteps = 0;
  for (const [index, step] of history.steps.entries()) {
    const at = `Step ${index + 1} (${stepLabel(step)})`;
    deadline(step.deadlineMs, at);
    const id = 'participant' in step ? step.participant : undefined;
    if (id !== undefined && !participantIds.includes(id)) bad(`${at}: unknown participant`);
    switch (step.action) {
      case 'open':
      case 'start-open':
        if (state[step.participant] !== 'new') bad(`${at}: each participant opens at most once`);
        state[step.participant] = step.action === 'open' ? 'open' : 'opening';
        if (step.action === 'start-open') starter[step.participant] = index;
        break;
      case 'await-open':
        if (state[step.participant] !== 'opening')
          bad(`${at}: requires a preceding start-open that has not been awaited`);
        state[step.participant] = 'open';
        break;
      case 'wait-for': {
        const target = step.event.participant;
        if (!participantIds.includes(target)) bad(`${at}: unknown participant`);
        if (state[target] === 'new' || state[target] === 'page-closed')
          bad(`${at}: ${target} has no live document to observe`);
        break;
      }
      case 'operation':
        if (!step.name) bad(`${at}: operations require a name`);
        if (step.input !== undefined) assertJson(step.input);
        if (state[step.participant] !== 'open' && state[step.participant] !== 'session-closed')
          bad(`${at}: the participant adapter has not finished opening`);
        if (step.expect === 'policy-refusal') {
          if (step.participant !== 'A') bad(`${at}: only participant A declares a refusal policy`);
          if (!('refusalName' in policy))
            bad(
              `${at}: policy-refusal requires a refuse-writes, read-only or reload-required policy`,
            );
        }
        break;
      case 'close-session':
        if (state[step.participant] !== 'open') bad(`${at}: the session is not open`);
        state[step.participant] = 'session-closed';
        break;
      case 'close-page':
        if (state[step.participant] === 'new' || state[step.participant] === 'page-closed')
          bad(`${at}: there is no live document to close`);
        state[step.participant] = 'page-closed';
        break;
      case 'oracle': {
        if (!step.name || oracleNames.has(step.name))
          bad(`${at}: oracle step names must be unique`);
        oracleNames.add(step.name);
        if (!step.checks.length) bad(`${at}: an oracle step requires at least one check`);
        const names = new Set<string>();
        for (const check of step.checks) {
          if (!check.name || names.has(check.name)) bad(`${at}: check names must be unique`);
          names.add(check.name);
        }
        // A read queued behind a pending upgrade could wait for the very connection under test.
        for (const id of participantIds)
          if (state[id] === 'opening') bad(`${at}: ${id} open is still pending; await it first`);
        oracleSteps++;
        break;
      }
    }
  }
  for (const id of participantIds)
    if (state[id] === 'opening')
      bad(
        `Participant ${id} starts opening at step ${(starter[id] ?? 0) + 1} but never awaits it or closes its page`,
      );
  if (!oracleSteps) bad('A concurrent history requires an independent oracle step');
  if (state.A === 'new') bad('Participant A must open');
}

/** Rejects at the deadline or on cancellation. The abandoned work is never read again. */
async function bounded<T>(
  work: Promise<T>,
  ms: number,
  what: string,
  signal?: AbortSignal,
): Promise<T> {
  work.catch(() => {});
  if (signal?.aborted) throw new RunFailure('cancelled', 'History cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RunFailure('deadline', `${what} deadline exceeded; data loss is not established`),
        ),
      ms,
    );
    abort = () => reject(new RunFailure('cancelled', 'History cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, interruption]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

type RunningParticipant = {
  page?: Page;
  /** Next event position to collect from the document. */
  cursor: number;
  consumed: number[];
  lastSeq: number;
  drainBroken: boolean;
};

const limitations = [
  'PASS applies only to this executed script and its declared oracle checks.',
  'Two documents of one origin share one disposable Chromium context and one database. Other engines, origins, databases, workers, crashes, quota and throttling are not covered.',
  'Events are ordered only within one document. Order across participants is a protocol order from wait-for and await-open steps, never a global browser order.',
  'The observer sees IndexedDB open requests, connections and the declared adapter signals. It does not see every internal browser or application action.',
  'A deadline or a missing event does not prove that the event cannot occur, and it is not evidence of data loss.',
  'Adapters and read-only queries are trusted test code. Diagnostic values are explicitly selected JSON.',
];

/**
 * Runs one two-document script in a single disposable context. The caller owns the browser and the
 * adapter server. Every wait, operation, open and close is bounded. No step is retried.
 */
export async function runConcurrentHistory(
  browser: Browser,
  history: ConcurrentHistory,
  options: RunOptions,
): Promise<ConcurrentHistoryResult> {
  const started = performance.now();
  const result: ConcurrentHistoryResult = {
    schemaVersion: '1',
    kind: 'concurrent',
    toolVersion,
    history: history.id,
    databaseName: history.databaseName,
    origin: options.origin,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    verdict: 'passed',
    participants: {
      A: { version: history.participants?.A?.version ?? '', appVersion: '', opened: false },
      B: { version: history.participants?.B?.version ?? '', appVersion: '', opened: false },
    },
    steps: [],
    events: [],
    upgrade: { state: 'not-requested', evidence: [] },
    incomplete: [],
    environment: {
      browser: browser.browserType().name(),
      browserVersion: browser.version(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      dependencies,
    },
    limitations: [...limitations],
  };
  const world: Record<ParticipantId, RunningParticipant> = {
    A: { cursor: 0, consumed: [], lastSeq: 0, drainBroken: false },
    B: { cursor: 0, consumed: [], lastSeq: 0, drainBroken: false },
  };
  const events: ParticipantEvent[] = [];
  const firstCollectedAt = new Map<ParticipantEvent, number>();
  const ownedPages = new Set<Page>();
  let context: BrowserContext | undefined;
  let tracing = false;
  let closed = false;
  let networkViolation: string | undefined;
  let stopReason: string | undefined;
  let currentStep = -1;

  const recordProblem = (step: number, message: string, check?: string) => {
    result.firstProblem ??= { step, check, message };
  };

  const entryOf = (id: ParticipantId) => {
    const key = history.participants[id].version;
    const entry = history.versions[key];
    if (!entry) throw new RunFailure('configuration', 'Missing version');
    return entry;
  };

  /** Collects new events and checks document identity. Failure only limits the evidence. */
  const drain = async (id: ParticipantId, step: number, wait = drainDeadlineMs) => {
    const participant = world[id];
    const page = participant.page;
    if (!page || page.isClosed() || participant.drainBroken) return;
    try {
      const snapshot = await bounded(
        page.evaluate((from) => {
          const guard = window.__idbshiftGuard;
          return {
            documentId: guard?.documentId,
            violations: guard?.violations ?? [],
            events: guard?.events?.slice(from) ?? null,
          };
        }, participant.cursor),
        wait,
        'Event collection',
      );
      if (closed) return;
      if (!snapshot.events) throw new RunFailure('observer', 'The event observer is not installed');
      for (const event of snapshot.events) {
        const entry: ParticipantEvent = { participant: id, ...event };
        events.push(entry);
        firstCollectedAt.set(entry, step);
        participant.lastSeq = Math.max(participant.lastSeq, event.seq);
      }
      participant.cursor += snapshot.events.length;
      if (
        result.participants[id].documentId &&
        snapshot.documentId !== result.participants[id].documentId
      )
        throw new RunFailure(
          'document',
          'Adapter replaced the participant document or changed origin',
        );
      if (snapshot.violations.length)
        throw new RunFailure('database-identity', snapshot.violations.join('; '));
    } catch (error) {
      if (
        error instanceof RunFailure &&
        ['document', 'database-identity', 'observer'].includes(error.kind)
      )
        throw error;
      participant.drainBroken = true;
      result.incomplete.push(
        `Events from ${id} could not be collected after step ${step + 1}; later ${id} events are missing.`,
      );
    }
  };

  const integrity = async (step: number) => {
    if (networkViolation) throw new RunFailure('origin', networkViolation);
    const extra = context?.pages().filter((page) => !ownedPages.has(page)) ?? [];
    if (extra.length) {
      for (const page of extra) await page.close().catch(() => {});
      throw new RunFailure(
        'extra-page',
        'Adapter opened an extra page; only two participants are supported',
      );
    }
    for (const id of participantIds) await drain(id, step);
  };

  const pageOf = (id: ParticipantId) => {
    const page = world[id].page;
    if (!page || page.isClosed())
      throw new RunFailure('lifecycle', `Participant ${id} has no live document`);
    return page;
  };

  const finish = (id: ParticipantId, outcome: ParticipantOpen) => {
    const record = result.participants[id];
    if (outcome.status !== 'opened') {
      if (outcome.appVersion) record.observedAppVersion = outcome.appVersion;
      throw new RunFailure(
        outcome.status === 'refused' ? 'open-refused' : outcome.name,
        safeMessage(outcome.message),
      );
    }
    record.observedAppVersion = outcome.appVersion;
    record.databaseVersion = outcome.version;
    record.opened = true;
    return { observedAppVersion: outcome.appVersion, databaseVersion: outcome.version };
  };

  /** Creates the document and starts the adapter open. Does not wait for it to settle. */
  const startOpen = async (id: ParticipantId, deadlineMs: number, live: () => boolean) => {
    if (!context) throw new Error('Missing context');
    const entry = entryOf(id);
    const page = await context.newPage();
    if (!live() || closed) {
      await page.close().catch(() => {});
      throw new RunFailure('stale', 'Step is no longer active');
    }
    ownedPages.add(page);
    world[id].page = page;
    page.setDefaultTimeout(deadlineMs);
    await page.goto(`${options.origin}/`, { waitUntil: 'load' });
    const documentId = await page.evaluate(() => window.__idbshiftGuard?.documentId);
    if (!live() || closed) throw new RunFailure('stale', 'Step is no longer active');
    result.participants[id].documentId = documentId;
    await page.evaluate(
      ({ entrypoint, databaseName, appVersion }) => {
        const opening = (async (): Promise<ParticipantOpen> => {
          let adapter: StorageAdapter | undefined;
          try {
            const module = await import(/* @vite-ignore */ entrypoint);
            adapter = module.default as StorageAdapter;
            if (adapter?.protocolVersion !== 1 || adapter.appVersion !== appVersion)
              throw new Error('Adapter protocol or declared app version mismatch');
            const session = await adapter.open({ databaseName });
            window.__idbshift = { session, documentId: window.__idbshiftGuard?.documentId ?? '' };
            if (
              !(session.database instanceof IDBDatabase) ||
              session.database.name !== databaseName
            )
              throw new Error('Adapter must expose the actual IDBDatabase with the requested name');
            // A transaction on the connection also detects an already-closed handle.
            const store = session.database.objectStoreNames[0];
            if (!store) throw new Error('Adapter database has no object stores');
            session.database.transaction(store, 'readonly');
            return {
              status: 'opened',
              appVersion: adapter.appVersion,
              version: session.database.version,
            };
          } catch (error) {
            const name = error instanceof Error ? error.name : 'Error';
            const message = error instanceof Error ? error.message : 'Non-Error thrown by adapter';
            const refused =
              error instanceof Error &&
              (('idbshiftRefusal' in error && error.idbshiftRefusal === true) ||
                name === 'VersionError');
            return {
              status: refused ? 'refused' : 'failed',
              name,
              message,
              appVersion: adapter?.appVersion,
            };
          }
        })();
        window.__idbshiftParticipant = { opening };
      },
      {
        entrypoint: entry.entrypoint,
        databaseName: history.databaseName,
        appVersion: entry.appVersion,
      },
    );
  };

  const awaitOpen = async (id: ParticipantId, live: () => boolean) => {
    const outcome = await pageOf(id).evaluate(async () => {
      const participant = window.__idbshiftParticipant;
      if (!participant) throw new Error('Participant open was not started');
      return participant.opening;
    });
    if (!live() || closed) throw new RunFailure('stale', 'Step is no longer active');
    return outcome;
  };

  const classifyOperation = (
    step: Extract<ConcurrentStep, { action: 'operation' }>,
    outcome: { threw: false } | { threw: true; name: string; message: string; refusal: boolean },
    sr: ConcurrentStepResult,
    index: number,
  ) => {
    const expect = step.expect ?? 'success';
    const refusalName =
      'refusalName' in history.participants.A.policy
        ? history.participants.A.policy.refusalName
        : undefined;
    const operation: NonNullable<ConcurrentStepResult['operation']> = {
      name: step.name,
      expect,
      outcome: 'completed',
    };
    sr.operation = operation;
    if (!outcome.threw) {
      if (expect === 'policy-refusal') {
        sr.status = 'refusal-missing';
        recordProblem(
          index,
          `${step.participant} ${step.name} was accepted although the declared policy requires a refusal`,
        );
      } else sr.status = 'completed';
      return;
    }
    operation.error = { name: outcome.name, message: safeMessage(outcome.message) };
    if (expect === 'policy-refusal' && outcome.refusal && outcome.name === refusalName) {
      operation.outcome = 'refused-by-policy';
      sr.status = 'policy-refusal';
      return;
    }
    operation.outcome = 'failed';
    sr.status = 'unexpected-failure';
    recordProblem(
      index,
      expect === 'policy-refusal'
        ? `${step.participant} ${step.name} failed with ${outcome.name} instead of the declared ${refusalName} refusal`
        : `${step.participant} ${step.name} failed unexpectedly with ${outcome.name}`,
    );
  };

  const execute = async (
    step: ConcurrentStep,
    index: number,
    sr: ConcurrentStepResult,
    live: () => boolean,
    deadlineMs: number,
  ): Promise<void> => {
    switch (step.action) {
      case 'open':
      case 'start-open': {
        await startOpen(step.participant, deadlineMs, live);
        if (step.action === 'start-open') return;
        const opened = finish(step.participant, await awaitOpen(step.participant, live));
        sr.open = opened;
        return;
      }
      case 'await-open': {
        const opened = finish(step.participant, await awaitOpen(step.participant, live));
        sr.open = opened;
        sr.startedBy = result.steps.findLast(
          (candidate) =>
            candidate.action === 'start-open' && candidate.participant === step.participant,
        )?.index;
        return;
      }
      case 'wait-for': {
        const matcher = step.event;
        const consumed = [...world[matcher.participant].consumed];
        const wanted: Record<string, unknown> = { type: matcher.type };
        for (const key of ['name', 'oldVersion', 'newVersion'] as const)
          if (matcher[key] !== undefined) wanted[key] = matcher[key];
        const hit = await pageOf(matcher.participant).evaluate(
          ({ wanted, consumed }) => {
            const guard = window.__idbshiftGuard;
            const log = guard?.events;
            const waiters = guard?.waiters;
            if (!log || !waiters) throw new Error('The event observer is not installed');
            const find = () =>
              log.find(
                (event) =>
                  !consumed.includes(event.seq) &&
                  Object.entries(wanted).every(
                    ([key, value]) => (event as unknown as Record<string, unknown>)[key] === value,
                  ),
              );
            return new Promise<ObservedEvent>((resolve) => {
              const now = find();
              if (now) return resolve(now);
              waiters.push(() => {
                const event = find();
                if (!event) return false;
                resolve(event);
                return true;
              });
            });
          },
          { wanted, consumed },
        );
        if (!live() || closed) throw new RunFailure('stale', 'Step is no longer active');
        world[matcher.participant].consumed.push(hit.seq);
        sr.matched = { participant: matcher.participant, seq: hit.seq, type: hit.type };
        return;
      }
      case 'operation': {
        const outcome = await pageOf(step.participant).evaluate(
          async ({ name, json }) => {
            const input = JSON.parse(json) as Json;
            const operations = window.__idbshift?.session.operations;
            if (!operations || !Object.hasOwn(operations, name)) return { unknown: true as const };
            const emit = window.__idbshiftGuard?.emit;
            emit?.({ type: 'operation-started', declared: true, name });
            try {
              await operations[name]?.call(operations, input);
              emit?.({ type: 'operation-finished', declared: true, name, outcome: 'completed' });
              return { unknown: false as const, threw: false as const };
            } catch (error) {
              const errorName = error instanceof Error ? error.name : 'Error';
              emit?.({
                type: 'operation-finished',
                declared: true,
                name,
                outcome: `failed:${errorName}`,
              });
              return {
                unknown: false as const,
                threw: true as const,
                name: errorName,
                message: error instanceof Error ? error.message : 'Non-Error thrown by operation',
                refusal:
                  error instanceof Error &&
                  'idbshiftRefusal' in error &&
                  error.idbshiftRefusal === true,
              };
            }
          },
          { name: step.name, json: JSON.stringify(step.input ?? null) },
        );
        if (!live() || closed) throw new RunFailure('stale', 'Step is no longer active');
        if (outcome.unknown) throw new RunFailure('adapter', `Unknown operation: ${step.name}`);
        classifyOperation(step, outcome, sr, index);
        return;
      }
      case 'close-session': {
        await pageOf(step.participant).evaluate(async () => {
          const emit = window.__idbshiftGuard?.emit;
          emit?.({ type: 'session-close-started', declared: true });
          await window.__idbshift?.session.close();
          emit?.({ type: 'session-close-finished', declared: true });
        });
        if (!live() || closed) throw new RunFailure('stale', 'Step is no longer active');
        return;
      }
      case 'close-page': {
        const id = step.participant;
        await drain(id, index);
        const page = pageOf(id);
        const entry: ParticipantEvent = {
          participant: id,
          seq: world[id].lastSeq + 1,
          type: 'page-close',
          declared: true,
        };
        world[id].lastSeq = entry.seq;
        events.push(entry);
        firstCollectedAt.set(entry, index);
        await page.close();
        if (!live() || closed) throw new RunFailure('stale', 'Step is no longer active');
        result.participants[id].pageClosed = 'step';
        return;
      }
      case 'oracle': {
        if (!context) throw new Error('Missing context');
        const page = await context.newPage();
        if (!live() || closed) {
          await page.close().catch(() => {});
          throw new RunFailure('stale', 'Step is no longer active');
        }
        ownedPages.add(page);
        page.setDefaultTimeout(deadlineMs);
        let oracleEvents: ObservedEvent[] | null = null;
        try {
          await page.goto(`${options.origin}/`, { waitUntil: 'load' });
          const guard = () => {
            if (!live() || closed) throw new RunFailure('stale', 'Step is no longer active');
          };
          const api = oracleApi(page, history.databaseName, history.oracle.schemas, guard);
          guard();
          sr.checks = [];
          sr.oracle = {};
          // The schema and availability check comes first, so unreadable data never looks like a pass.
          const nativeVersion = await api.readVersion();
          sr.oracle.nativeVersion = nativeVersion;
          result.upgrade.oracleNativeVersion ??= nativeVersion;
          sr.status = 'completed';
          for (const check of step.checks) {
            const cr: NonNullable<ConcurrentStepResult['checks']>[number] = {
              name: check.name,
              status: 'error',
            };
            sr.checks.push(cr);
            try {
              const values = await check.run(api);
              guard();
              assertJson(values.expected);
              assertJson(values.actual);
              cr.expected = JSON.parse(JSON.stringify(values.expected)) as Json;
              cr.actual = JSON.parse(JSON.stringify(values.actual)) as Json;
              cr.status = isDeepStrictEqual(cr.expected, cr.actual) ? 'passed' : 'failed';
              if (cr.status === 'failed') {
                sr.status = 'violation';
                recordProblem(index, 'Expected and actual values differ', check.name);
                result.firstViolation ??= {
                  step: index,
                  check: check.name,
                  message: 'Expected and actual values differ',
                };
              }
            } catch (error) {
              if (live() && !closed) {
                cr.error = diagnostic(error, `check:${check.name}`);
                recordProblem(index, cr.error.message, check.name);
              }
              throw error;
            }
          }
          oracleEvents = await page
            .evaluate(() => window.__idbshiftGuard?.events ?? null)
            .catch(() => null);
        } finally {
          await bounded(page.close(), cleanupDeadlineMs, 'Oracle page close').catch(() => {});
        }
        if (oracleEvents?.some((event) => event.type === 'upgrade-needed'))
          throw new RunFailure('oracle-would-create', 'The oracle connection triggered an upgrade');
        return;
      }
    }
  };

  try {
    validateConcurrentHistory(history, options.origin);
    for (const id of participantIds) result.participants[id].appVersion = entryOf(id).appVersion;
    result.participants.A.policy = history.participants.A.policy;
    if (browser.browserType().name() !== 'chromium')
      throw new RunFailure(
        'configuration',
        'Concurrent histories have only been acceptance-tested with Chromium',
      );
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await installGuards(context, history.databaseName, true);
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

    for (const [index, step] of history.steps.entries()) {
      currentStep = index;
      const sr: ConcurrentStepResult = {
        index,
        action: step.action,
        participant:
          'participant' in step
            ? step.participant
            : 'event' in step
              ? step.event.participant
              : undefined,
        note: step.note,
        status: 'not-run',
        durationMs: 0,
      };
      if (sr.participant === undefined) delete sr.participant;
      if (sr.note === undefined) delete sr.note;
      result.steps.push(sr);
      if (stopReason) {
        sr.reason = stopReason;
        continue;
      }
      if (options.signal?.aborted) {
        sr.status = 'blocked';
        sr.error = { kind: 'cancelled', message: 'History cancelled', phase: stepLabel(step) };
        recordProblem(index, 'History cancelled');
        stopReason = 'History cancelled before this step';
        continue;
      }
      const stepStart = performance.now();
      const deadlineMs = step.deadlineMs ?? history.deadlineMs ?? defaultDeadlineMs;
      let live = true;
      const body = async () => {
        await execute(step, index, sr, () => live, deadlineMs);
        if (sr.status === 'not-run') sr.status = 'completed';
      };
      const run = () => bounded(body(), deadlineMs, stepLabel(step), options.signal);
      try {
        if (options.step) await options.step(`${index + 1}. ${stepLabel(step)}`, run);
        else await run();
        await bounded(integrity(index), drainDeadlineMs * 3, 'Integrity check');
      } catch (error) {
        const kind = error instanceof RunFailure ? error.kind : undefined;
        sr.error = diagnostic(error, stepLabel(step));
        // A check that never finished explains itself instead of showing empty values.
        for (const check of sr.checks ?? [])
          if (check.status === 'error' && !check.error) check.error = sr.error;
        sr.status = kind === 'deadline' || kind === 'cancelled' ? 'blocked' : 'error';
        recordProblem(index, sr.error.message, sr.checks?.find((c) => c.status === 'error')?.name);
        if (sr.status === 'blocked' || sr.status === 'error')
          stopReason = `Step ${index + 1} (${stepLabel(step)}) did not complete`;
      } finally {
        live = false;
        sr.durationMs = Math.round(performance.now() - stepStart);
      }
    }
  } catch (error) {
    result.error = diagnostic(error, 'setup');
    result.verdict = 'error';
  } finally {
    // Late events and a final integrity read, then destroy everything this run owns.
    if (context) {
      for (const id of participantIds)
        try {
          await drain(id, currentStep, 500);
        } catch (error) {
          result.error ??= diagnostic(error, 'close');
        }
    }
    closed = true;
    for (const id of participantIds) {
      const page = world[id].page;
      if (page && !page.isClosed()) {
        result.participants[id].pageClosed ??= 'cleanup';
        await bounded(page.close(), cleanupDeadlineMs, 'Page close').catch(() => {});
      }
    }
    if (tracing && context) {
      try {
        await context.tracing.stop({ path: options.tracePath });
      } catch (error) {
        result.error ??= diagnostic(error, 'trace');
      }
    }
    try {
      if (context) await bounded(context.close(), cleanupDeadlineMs * 2, 'Context close');
    } catch (error) {
      result.error ??= diagnostic(error, 'context-close');
    }
    result.durationMs = Math.round(performance.now() - started);
  }

  result.events = events.sort(
    (a, b) =>
      participantIds.indexOf(a.participant) - participantIds.indexOf(b.participant) ||
      a.seq - b.seq,
  );
  result.upgrade = summarizeUpgrade(
    result.events,
    firstCollectedAt,
    result.upgrade.oracleNativeVersion,
  );
  result.incomplete.push(...incompleteReasons(result));
  result.verdict = verdictOf(result);
  return result;
}

function summarizeUpgrade(
  events: ParticipantEvent[],
  collectedAt: Map<ParticipantEvent, number>,
  oracleNativeVersion?: number,
): UpgradeSummary {
  const own = events.filter((event) => event.participant === 'B');
  const find = (type: ObservedEvent['type']) => own.find((event) => event.type === type);
  const ref = (event: ParticipantEvent) => ({
    participant: event.participant,
    seq: event.seq,
    type: event.type,
  });
  const requested = find('open-requested');
  const blocked = find('open-blocked');
  const needed = find('upgrade-needed');
  const complete = find('upgrade-transaction-complete');
  const aborted = find('upgrade-transaction-abort') ?? (needed ? find('open-failed') : undefined);
  const summary: UpgradeSummary = { state: 'not-requested', evidence: [] };
  if (oracleNativeVersion !== undefined) summary.oracleNativeVersion = oracleNativeVersion;
  if (needed) {
    summary.requestedVersion = needed.newVersion ?? undefined;
    summary.fromVersion = needed.oldVersion;
  }
  const add = (...items: (ParticipantEvent | undefined)[]) =>
    summary.evidence.push(...items.filter((event): event is ParticipantEvent => !!event).map(ref));
  if (complete) {
    summary.state = 'completed';
    summary.confirmedAfterStep = collectedAt.get(complete);
    add(blocked, needed, complete, find('open-succeeded'));
  } else if (aborted) {
    summary.state = 'aborted';
    add(blocked, needed, aborted);
  } else if (blocked) {
    summary.state = 'waiting-for-connection';
    add(requested, blocked);
  } else if (requested && !find('open-succeeded') && !find('open-failed')) {
    summary.state = 'pending';
    add(requested);
  }
  if (!summary.requestedVersion && requested?.version) summary.requestedVersion = requested.version;
  return summary;
}

function incompleteReasons(result: ConcurrentHistoryResult): string[] {
  const reasons: string[] = [];
  for (const step of result.steps)
    if (step.status === 'not-run')
      reasons.push(
        `Step ${step.index + 1} (${step.action}) did not run: ${step.reason ?? 'unknown'}.`,
      );
  const blocked = result.steps.find((step) => step.status === 'blocked');
  if (blocked)
    reasons.push(
      `Step ${blocked.index + 1} (${blocked.action}) hit a deadline or was cancelled; this does not establish absence of the event or data loss.`,
    );
  if (result.upgrade.state === 'waiting-for-connection' || result.upgrade.state === 'pending')
    reasons.push(
      'B upgrade was not confirmed: its open request had not settled when the history ended.',
    );
  if (
    !result.steps.some(
      (step) => step.action === 'oracle' && step.oracle?.nativeVersion !== undefined,
    )
  )
    reasons.push('No independent oracle read completed; data preservation is not established.');
  return reasons;
}

function verdictOf(result: ConcurrentHistoryResult): ConcurrentVerdict {
  if (result.error || result.steps.some((step) => step.status === 'error')) return 'error';
  if (result.steps.some((step) => step.status === 'blocked')) return 'blocked';
  if (result.steps.some((step) => step.status === 'violation')) return 'contract-violation';
  if (
    result.steps.some(
      (step) => step.status === 'unexpected-failure' || step.status === 'refusal-missing',
    )
  )
    return 'unexpected-operation';
  if (result.steps.some((step) => step.status === 'not-run')) return 'error';
  if (result.steps.some((step) => step.status === 'policy-refusal')) return 'expected-refusal';
  return 'passed';
}
