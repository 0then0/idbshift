import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { heldConnection } from '../../examples/concurrent.js';
import { toolVersion } from '../../src/common.js';
import { validateConcurrentHistory } from '../../src/concurrent.js';
import { renderHtml, summarize } from '../../src/report.js';
import type {
  ConcurrentHistory,
  ConcurrentHistoryResult,
  ConcurrentStep,
} from '../../src/types.js';

const origin = 'http://127.0.0.1:4000';
const oracle: ConcurrentStep = {
  action: 'oracle',
  name: 'final',
  checks: [{ name: 'c', run: async () => ({ expected: 1, actual: 1 }) }],
};
function history(
  steps: ConcurrentStep[],
  patch: Partial<ConcurrentHistory> = {},
): ConcurrentHistory {
  return { ...heldConnection, steps, ...patch };
}
const rejects = (value: ConcurrentHistory, pattern: RegExp) =>
  assert.throws(() => validateConcurrentHistory(value, origin), pattern);

test('The tool version, package version and changelog agree', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(toolVersion, pkg.version);
  assert.match(
    readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
    /^## \[?0\.2\.0/m,
  );
});

test('The shipped examples are valid scripts', () => {
  assert.doesNotThrow(() => validateConcurrentHistory(heldConnection, origin));
});

test('Scripts that could deadlock or prove nothing are rejected before a browser starts', () => {
  const openA: ConcurrentStep = { action: 'open', participant: 'A' };
  const startB: ConcurrentStep = { action: 'start-open', participant: 'B' };
  rejects(history([openA, startB]), /never awaits/);
  rejects(history([openA, startB, oracle]), /still pending/);
  rejects(
    history([openA, startB, oracle, { action: 'await-open', participant: 'B' }]),
    /still pending/,
  );
  rejects(history([openA, { action: 'await-open', participant: 'B' }, oracle]), /start-open/);
  rejects(history([openA, openA, oracle]), /at most once/);
  rejects(history([openA]), /oracle/);
  rejects(history([startB, { action: 'await-open', participant: 'B' }, oracle]), /A must open/);
  rejects(
    history([{ action: 'operation', participant: 'A', name: 'save' }, oracle]),
    /finished opening/,
  );
  rejects(
    history([
      openA,
      { action: 'wait-for', event: { participant: 'B', type: 'versionchange' } },
      oracle,
    ]),
    /no live document/,
  );
  rejects(history([openA, { ...oracle, checks: [] } as ConcurrentStep]), /at least one check/);
  rejects(history([openA, { ...oracle, deadlineMs: 0 }]), /deadlines/);
  rejects(history([openA, oracle], { deadlineMs: 1e9 }), /deadlines/);
});

test('A policy refusal needs a declared refusal name and belongs to A', () => {
  const openA: ConcurrentStep = { action: 'open', participant: 'A' };
  const refused: ConcurrentStep = {
    action: 'operation',
    participant: 'A',
    name: 'save',
    expect: 'policy-refusal',
  };
  rejects(history([openA, refused, oracle]), /requires a refuse-writes/);
  const bOperation: ConcurrentStep = { ...refused, participant: 'B' };
  rejects(
    history([openA, { action: 'open', participant: 'B' }, bOperation, oracle]),
    /only participant A/,
  );
});

test('Entrypoints must stay on the controlled origin', () => {
  const versions = {
    ...heldConnection.versions,
    old: { appVersion: 'x', entrypoint: '//evil.test/a.js' },
  };
  rejects(history(heldConnection.steps, { versions }), /root-relative/);
  assert.throws(
    () => validateConcurrentHistory(heldConnection, 'https://example.test'),
    /loopback origin/,
  );
});

const result: ConcurrentHistoryResult = {
  schemaVersion: '1',
  kind: 'concurrent',
  toolVersion,
  history: 'synthetic <b>history</b>',
  databaseName: 'db',
  origin,
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 1,
  verdict: 'blocked',
  participants: {
    A: { version: 'old', appVersion: 'a', opened: true, databaseVersion: 1 },
    B: { version: 'new', appVersion: 'b', opened: false },
  },
  steps: [
    {
      index: 0,
      action: 'wait-for',
      participant: 'B',
      status: 'blocked',
      durationMs: 1,
      note: '<i>note</i>',
      error: { kind: 'deadline', message: 'x <script>', phase: 'Wait' },
    },
  ],
  events: [
    { participant: 'B', seq: 1, type: 'open-blocked', request: 'r1', oldVersion: 1, newVersion: 2 },
  ],
  upgrade: {
    state: 'waiting-for-connection',
    evidence: [{ participant: 'B', seq: 1, type: 'open-blocked' }],
  },
  incomplete: ['B upgrade was not confirmed'],
  environment: {
    browser: 'chromium',
    browserVersion: '1',
    node: 'n',
    platform: 'p',
    dependencies: {},
  },
  limitations: ['limit'],
};

test('The native blocked event is labeled apart from the blocked run outcome', () => {
  const html = renderHtml([result]);
  assert.match(html, /IDB blocked event/);
  assert.match(html, /status blocked/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>history</b>'));
  assert.match(summarize([result]), /BLOCKED synthetic <b>history<\/b> .*concurrent/);
  assert.match(summarize([result]), /Upgrade: waiting-for-connection/);
  assert.match(summarize([result]), /Incomplete: B upgrade was not confirmed/);
});
