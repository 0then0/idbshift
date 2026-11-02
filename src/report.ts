import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConcurrentHistoryResult,
  ConcurrentStepResult,
  HistoryResult,
  ParticipantEvent,
  ParticipantId,
} from './types.js';

export type AnyResult = HistoryResult | ConcurrentHistoryResult;
const isConcurrent = (result: AnyResult): result is ConcurrentHistoryResult =>
  'kind' in result && result.kind === 'concurrent';
/**
 * Schema 1 keeps `histories` strictly sequential. Concurrent results live in the optional
 * `concurrentHistories` array, which is omitted when empty, so older consumers and sequential-only
 * reports are unchanged.
 */
function envelope(results: AnyResult[]) {
  const concurrentHistories = results.filter(isConcurrent);
  const histories = results.filter((result): result is HistoryResult => !isConcurrent(result));
  return concurrentHistories.length
    ? { schemaVersion: '1', histories, concurrentHistories }
    : { schemaVersion: '1', histories };
}

function summarizeConcurrent(r: ConcurrentHistoryResult): string {
  const point = r.firstViolation ?? r.firstProblem;
  const lines = [
    `${r.verdict.toUpperCase()} ${r.history} (${r.durationMs} ms, concurrent)`,
    `  Upgrade: ${r.upgrade.state}${r.upgrade.requestedVersion !== undefined ? ` (B requested v${r.upgrade.requestedVersion}${r.upgrade.fromVersion !== undefined ? ` from v${r.upgrade.fromVersion}` : ''}${r.upgrade.confirmedAfterStep !== undefined ? `; collected after step ${r.upgrade.confirmedAfterStep + 1}` : ''}${r.upgrade.oracleNativeVersion !== undefined ? `; oracle read native v${r.upgrade.oracleNativeVersion}` : ''})` : ''}`,
  ];
  const policy = r.participants.A.policy;
  if (policy)
    lines.push(
      `  A policy: ${policy.kind}${'refusalName' in policy ? ` (${policy.refusalName})` : ''}: ${policy.reason}`,
    );
  for (const step of r.steps)
    lines.push(
      `  ${step.index + 1}. ${stepTitle(step)}: ${step.status}${step.error ? ` (${step.error.kind}: ${step.error.message})` : ''}`,
    );
  if (point)
    lines.push(
      `  First ${r.firstViolation ? 'violation' : 'problem'}: step ${point.step + 1}${point.check ? ` / ${point.check}` : ''}: ${point.message}`,
    );
  if (r.error) lines.push(`  ${r.error.phase}: ${r.error.kind}: ${r.error.message}`);
  for (const reason of r.incomplete) lines.push(`  Incomplete: ${reason}`);
  return lines.join('\n');
}

export function summarize(all: AnyResult[]): string {
  const results = all.filter((result): result is HistoryResult => !isConcurrent(result));
  const concurrent = all.filter(isConcurrent);
  return (
    [
      ...results.map((r) => {
        const point = r.firstViolation ?? r.firstProblem;
        return `${r.verdict.toUpperCase()} ${r.history} (${r.durationMs} ms)${point ? `\n  First ${r.firstViolation ? 'violation' : 'problem'}: ${point.stage}${point.check ? ` / ${point.check}` : ''}: ${point.message}` : ''}${r.error ? `\n  ${r.error.phase}: ${r.error.kind}: ${r.error.message}` : ''}`;
      }),
      ...concurrent.map(summarizeConcurrent),
    ].join('\n') +
    '\nPASS covers only the executed history and declared checks. Expected refusal is a policy result, not successful coexistence.\n'
  );
}

const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
const pretty = (value: unknown) => esc(JSON.stringify(value, null, 2));
const label = (value: string) => value.replaceAll('-', ' ');

const eventLabels: Record<ParticipantEvent['type'], string> = {
  'open-requested': 'open requested',
  'open-blocked': 'IDB blocked event',
  'upgrade-needed': 'upgradeneeded',
  'upgrade-transaction-complete': 'upgrade transaction complete',
  'upgrade-transaction-abort': 'upgrade transaction abort',
  'open-succeeded': 'open succeeded',
  'open-failed': 'open failed',
  versionchange: 'versionchange',
  'connection-close-called': 'close() called',
  'connection-closed-abnormally': 'closed by browser',
  signal: 'signal',
  'operation-started': 'operation started',
  'operation-finished': 'operation finished',
  'session-close-started': 'session close started',
  'session-close-finished': 'session close finished',
  'page-close': 'page closed',
};
function stepTitle(step: ConcurrentStepResult): string {
  const who = step.participant ? ` ${step.participant}` : '';
  switch (step.action) {
    case 'open':
      return `Open${who}`;
    case 'start-open':
      return `Start opening${who}`;
    case 'await-open':
      return `Await${who} open`;
    case 'wait-for':
      return `Wait for${who} event`;
    case 'operation':
      return `${step.operation?.name ?? 'Operation'} on${who}`;
    case 'close-session':
      return `Close${who} session`;
    case 'close-page':
      return `Close${who} page`;
    case 'oracle':
      return 'Independent oracle';
  }
}
function eventDetail(event: ParticipantEvent): string {
  const parts: string[] = [];
  if (event.request) parts.push(`request ${event.participant}/${event.request}`);
  if (event.connection) parts.push(`connection ${event.participant}/${event.connection}`);
  if (event.oldVersion !== undefined || event.newVersion !== undefined)
    parts.push(
      `v${event.oldVersion ?? '?'} → ${event.newVersion === null ? 'delete' : `v${event.newVersion ?? '?'}`}`,
    );
  else if (event.version !== undefined)
    parts.push(event.version === null ? 'no version argument' : `version ${event.version}`);
  if (event.name) parts.push(event.name);
  if (event.outcome) parts.push(event.outcome);
  return parts.join(' · ');
}

function renderConcurrent(r: ConcurrentHistoryResult, i: number): string {
  const point = r.firstViolation ?? r.firstProblem;
  const policy = r.participants.A.policy;
  const lane = (id: ParticipantId) => {
    const participant = r.participants[id];
    const laneEvents = r.events.filter((event) => event.participant === id);
    return `<section class="lane" aria-label="Participant ${id}"><h4>${id} · ${esc(participant.appVersion)}${participant.observedAppVersion && participant.observedAppVersion !== participant.appVersion ? ` (observed ${esc(participant.observedAppVersion)})` : ''}</h4><p class="meta">${participant.opened ? `adapter open settled at native v${participant.databaseVersion ?? 'unavailable'}` : 'adapter open did not settle successfully'}${participant.pageClosed ? ` · page closed by ${participant.pageClosed === 'step' ? 'a declared step' : 'cleanup'}` : ''}</p>${laneEvents.length ? `<ol class="events">${laneEvents.map((event) => `<li class="${event.type === 'open-blocked' ? 'native-blocked' : ''}"><span class="seq">${event.seq}</span> <strong>${esc(eventLabels[event.type])}</strong>${event.declared ? ' <span class="chip">declared</span>' : ''}${eventDetail(event) ? `<br><span class="detail">${esc(eventDetail(event))}</span>` : ''}</li>`).join('')}</ol>` : '<p class="muted">No events were collected.</p>'}</section>`;
  };
  return `<article id="concurrent-${i}" class="concurrent"><header class="history-head"><div><p class="eyebrow">CONCURRENT HISTORY ${i + 1}</p><h2>${esc(r.history)}</h2><p class="route">A ${esc(r.participants.A.appVersion)} <span aria-hidden="true">+</span> B ${esc(r.participants.B.appVersion)}</p></div><strong class="status ${esc(r.verdict)}">${esc(label(r.verdict))}</strong></header>
      <p class="meta">${esc(r.environment.browser)} ${esc(r.environment.browserVersion)} · ${esc(r.environment.platform)} · ${r.durationMs} ms · ${esc(r.startedAt)}</p>
      ${point ? `<aside class="notice"><strong>First ${r.firstViolation ? 'contract violation' : 'problem'}</strong><p>Step ${point.step + 1}${point.check ? ` / ${esc(point.check)}` : ''}: ${esc(point.message)}</p></aside>` : ''}
      ${r.error ? `<aside class="notice"><strong>${esc(r.error.kind)} · ${esc(r.error.phase)}</strong><p>${esc(r.error.message)}</p></aside>` : ''}
      <section class="facts"><h3>Upgrade</h3><p><strong class="status ${esc(r.upgrade.state)}">${esc(label(r.upgrade.state))}</strong>${r.upgrade.requestedVersion !== undefined ? ` · B requested native v${r.upgrade.requestedVersion}${r.upgrade.fromVersion !== undefined ? ` from v${r.upgrade.fromVersion}` : ''}` : ''}${r.upgrade.confirmedAfterStep !== undefined ? ` · completion collected after step ${r.upgrade.confirmedAfterStep + 1}` : ''}${r.upgrade.oracleNativeVersion !== undefined ? ` · independent oracle read native v${r.upgrade.oracleNativeVersion}` : ''}</p>${r.upgrade.evidence.length ? `<p class="meta">Evidence: ${r.upgrade.evidence.map((e) => `${esc(e.participant)}#${e.seq} ${esc(eventLabels[e.type])}`).join(', ')}</p>` : ''}</section>
      ${policy ? `<section class="facts"><h3>Declared policy of A</h3><p><strong>${esc(label(policy.kind))}</strong>${'refusalName' in policy ? ` · refusal <code>${esc(policy.refusalName)}</code>` : ''}</p><p class="meta">${esc(policy.reason)}</p></section>` : ''}
      ${r.incomplete.length ? `<aside class="notice incomplete"><strong>Evidence is incomplete</strong><ul>${r.incomplete.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul></aside>` : ''}
      <h3 class="section-title">Protocol steps</h3>
      <ol class="timeline">${r.steps
        .map(
          (
            s,
          ) => `<li><div class="stage-title"><h3><span class="ordinal">${s.index + 1}</span> ${s.participant ? `<span class="chip who">${esc(s.participant)}</span> ` : ''}${esc(stepTitle(s))}</h3><strong class="status ${esc(s.status)}">${esc(label(s.status))}</strong></div>
        ${s.note ? `<p>${esc(s.note)}</p>` : ''}
        <p class="meta">${s.durationMs} ms${s.startedBy !== undefined ? ` · settles the open started by step ${s.startedBy + 1}` : ''}${s.matched ? ` · satisfied by ${esc(s.matched.participant)}#${s.matched.seq} ${esc(eventLabels[s.matched.type])}` : ''}${s.open ? ` · observed ${esc(s.open.observedAppVersion)} at native v${s.open.databaseVersion}` : ''}${s.oracle?.nativeVersion !== undefined ? ` · oracle read native v${s.oracle.nativeVersion}` : ''}</p>
        ${s.operation ? `<p class="operation">${esc(s.operation.name)} · expected ${esc(label(s.operation.expect))} · ${esc(label(s.operation.outcome))}${s.operation.error ? ` · <code>${esc(s.operation.error.name)}</code>: ${esc(s.operation.error.message)}` : ''}</p>` : ''}
        ${s.error ? `<p class="error-text">${esc(s.error.phase)} · ${esc(s.error.kind)}: ${esc(s.error.message)}</p>` : ''}
        ${s.reason ? `<p class="muted">Not run: ${esc(s.reason)}</p>` : ''}
        ${s.checks ? `<div class="checks">${s.checks.map((c) => `<details${c.status !== 'passed' ? ' open' : ''}><summary><span class="check-status ${esc(c.status)}">${esc(c.status)}</span> ${esc(c.name)}</summary>${c.error ? `<p class="error-text">${esc(c.error.kind)}: ${esc(c.error.message)}</p>` : `<div class="comparison"><section><h4>Expected</h4><pre>${pretty(c.expected)}</pre></section><section><h4>Actual</h4><pre>${pretty(c.actual)}</pre></section></div>`}</details>`).join('')}</div>` : ''}
      </li>`,
        )
        .join('')}</ol>
      <h3 class="section-title">Participant lanes</h3>
      <div class="lanes">${lane('A')}${lane('B')}</div>
      <p class="muted">Each lane is ordered by event position inside its own document. The order of the two lanes relative to each other is not a global browser order; only wait-for and await-open steps establish protocol order. The IDB blocked event is the native IndexedDB <code>blocked</code> event of an open request. It is unrelated to the blocked run outcome.</p>
      <details class="environment"><summary>Environment and evidence limits</summary><dl><dt>Origin</dt><dd>${esc(r.origin)}</dd><dt>Database</dt><dd>${esc(r.databaseName)}</dd><dt>Node</dt><dd>${esc(r.environment.node)}</dd><dt>IDBShift</dt><dd>${esc(r.toolVersion)}</dd></dl><pre>${pretty(r.environment.dependencies)}</pre><ul>${r.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>
    </article>`;
}

const concurrentStyle = `.concurrent .section-title{margin:28px 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.facts{border-top:1px solid var(--line);padding:10px 0}.facts h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.facts p{margin:4px 0}.incomplete ul{margin:8px 0 0;padding-left:20px}.chip{display:inline-block;font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}.chip.who{color:var(--accent);border-color:var(--accent);font-weight:700}.lanes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.lane{border:1px solid var(--line);border-radius:6px;padding:12px 14px}.lane h4{margin:0 0 4px;font-size:14px;text-transform:none;letter-spacing:0;color:var(--ink);overflow-wrap:anywhere}.events{list-style:none;margin:10px 0 0;padding:0;font-size:13px}.events li{border-top:1px solid var(--line);padding:6px 0;overflow-wrap:anywhere}.events li.native-blocked{border-left:3px solid var(--warn);padding-left:8px}.seq{display:inline-block;min-width:22px;color:var(--muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.detail{color:var(--muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.operation{font:13px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace}.completed,.policy-refusal{color:var(--ok)}.policy-refusal,.waiting-for-connection,.pending{color:var(--warn)}.unexpected-failure,.refusal-missing,.violation,.unexpected-operation,.aborted{color:var(--bad)}@media(max-width:600px){.lanes{grid-template-columns:1fr}}`;

export function renderHtml(all: AnyResult[]): string {
  const results = all.filter((result): result is HistoryResult => !isConcurrent(result));
  const concurrent = all.filter(isConcurrent);
  const json = JSON.stringify(envelope(all), null, 2);
  const histories = results
    .map((r, i) => {
      const point = r.firstViolation ?? r.firstProblem;
      return `<article id="history-${i}"><header class="history-head"><div><p class="eyebrow">HISTORY ${i + 1}</p><h2>${esc(r.history)}</h2><p class="route">${r.stages.map((s) => esc(s.version)).join(' <span aria-hidden="true">→</span> ')}</p></div><strong class="status ${esc(r.verdict)}">${esc(label(r.verdict))}</strong></header>
      <p class="meta">${esc(r.environment.browser)} ${esc(r.environment.browserVersion)} · ${esc(r.environment.platform)} · ${r.durationMs} ms · ${esc(r.startedAt)}</p>
      ${point ? `<aside class="notice"><strong>First ${r.firstViolation ? 'contract violation' : 'problem'}</strong><p>${esc(point.stage)}${point.check ? ` / ${esc(point.check)}` : ''}: ${esc(point.message)}</p></aside>` : ''}
      ${r.error ? `<aside class="notice"><strong>${esc(r.error.kind)} · ${esc(r.error.phase)}</strong><p>${esc(r.error.message)}</p></aside>` : ''}
      <ol class="timeline">${r.stages
        .map(
          (
            s,
            n,
          ) => `<li><div class="stage-title"><h3><span class="ordinal">${n + 1}</span> ${esc(s.id)}</h3><strong class="status ${esc(s.status)}">${esc(label(s.status))}${s.refusalExpected ? ' (expected policy)' : ''}</strong></div>
        <p class="meta">App ${esc(s.appVersion)}${s.observedAppVersion ? ` · observed ${esc(s.observedAppVersion)}` : ''} · native DB v${s.databaseVersion ?? 'unavailable'} · ${s.durationMs} ms</p>
        ${s.operations.length ? `<ul class="operations">${s.operations.map((op) => `<li>${esc(op.name)} <span>${esc(op.status)}</span></li>`).join('')}</ul>` : '<p class="muted">No write operations declared.</p>'}
        ${s.error ? `<p class="error-text">${esc(s.error.phase)} · ${esc(s.error.kind)}: ${esc(s.error.message)}</p>` : ''}
        ${s.policyReason ? `<p>Policy: ${esc(s.policyReason)}</p>` : ''}
        ${s.cleanupError ? `<p class="error-text">Cleanup: ${esc(s.cleanupError.message)}</p>` : ''}
        <div class="checks">${s.checks.map((c) => `<details${c.status !== 'passed' ? ' open' : ''}><summary><span class="check-status ${esc(c.status)}">${esc(c.status)}</span> ${esc(c.name)}</summary>${c.error ? `<p class="error-text">${esc(c.error.kind)}: ${esc(c.error.message)}</p>` : `<div class="comparison"><section><h4>Expected</h4><pre>${pretty(c.expected)}</pre></section><section><h4>Actual</h4><pre>${pretty(c.actual)}</pre></section></div>`}</details>`).join('')}</div>
      </li>`,
        )
        .join('')}</ol>
      <details class="environment"><summary>Environment and evidence limits</summary><dl><dt>Origin</dt><dd>${esc(r.origin)}</dd><dt>Database</dt><dd>${esc(r.databaseName)}</dd><dt>Node</dt><dd>${esc(r.environment.node)}</dd><dt>IDBShift</dt><dd>${esc(r.toolVersion)}</dd></dl><pre>${pretty(r.environment.dependencies)}</pre><ul>${r.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>
    </article>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>IDBShift · History report</title><style>
:root{color-scheme:light dark;--bg:#f4f6f8;--paper:#fff;--ink:#152434;--muted:#536477;--line:#d4dde5;--accent:#075d94;--bad:#ac2334;--ok:#14623e;--code:#edf2f6;--warn:#83520a;font:15px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink)}main{max-width:1080px;margin:auto;padding:40px 28px 70px}a{color:var(--accent)}.masthead{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid var(--ink);padding-bottom:22px;gap:18px}.brand{font-weight:800;letter-spacing:-.04em;font-size:28px}.brand span{color:var(--accent)}.eyebrow{font-size:11px;font-weight:750;letter-spacing:.13em;color:var(--muted);margin:0 0 8px}h1{font-size:32px;line-height:1.2;margin:26px 0 12px}h2{font-size:22px;margin:0;overflow-wrap:anywhere}h3{font-size:16px;margin:0}p{margin:8px 0 14px}.intro{max-width:75ch;color:var(--muted)}nav{display:flex;flex-wrap:wrap;gap:10px 20px;margin:24px 0}article{background:var(--paper);border:1px solid var(--line);border-radius:8px;margin:24px 0;padding:26px}.history-head,.stage-title{display:flex;justify-content:space-between;align-items:baseline;gap:14px}.route{font:14px ui-monospace,SFMono-Regular,Consolas,monospace;margin:10px 0 0}.route span{color:var(--muted);padding:0 6px}.status{font-size:12px;font-weight:750;text-transform:uppercase;letter-spacing:.03em;white-space:normal;text-align:right}.passed{color:var(--ok)}.contract-violation,.failed,.error,.open-refused{color:var(--bad)}.expected-refusal,.blocked,.not-run{color:var(--warn)}.meta,.muted{font-size:13px;color:var(--muted)}.notice{border-left:3px solid var(--bad);padding:12px 18px;background:var(--code);margin:20px 0;overflow-wrap:anywhere}.notice p{margin-bottom:0}.timeline{list-style:none;padding:0 0 0 16px;margin:26px 0;border-left:2px solid var(--line)}.timeline>li{padding:0 0 26px 12px;margin:0 0 16px;border-bottom:1px solid var(--line)}.timeline>li:last-child{border:0;margin-bottom:0;padding-bottom:0}.ordinal{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--line);border-radius:50%;font-size:12px;margin-left:-41px;margin-right:10px;background:var(--paper)}.operations{padding-left:20px;font:13px ui-monospace,SFMono-Regular,Consolas,monospace;margin:16px 0}.operations span{font:12px system-ui;color:var(--muted);margin-left:12px}details{border-top:1px solid var(--line);padding:11px 0}summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}summary:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.check-status{font-size:11px;text-transform:uppercase;margin-right:8px;letter-spacing:.03em}.comparison{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin:14px 0 4px}h4{font-size:12px;text-transform:uppercase;color:var(--muted);margin:0 0 6px}pre{background:var(--code);padding:14px;border-radius:4px;overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.error-text{color:var(--bad);overflow-wrap:anywhere}.environment{margin-top:18px;color:var(--muted);font-size:13px}dl{display:grid;grid-template-columns:85px 1fr;gap:5px 12px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}footer{font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:20px}@media(prefers-color-scheme:dark){:root{--bg:#101820;--paper:#17222d;--ink:#e2eaf2;--muted:#a8b8c8;--line:#354756;--accent:#74c4f5;--bad:#ff9ca9;--ok:#8cdbb4;--code:#202f3d;--warn:#f2cb83}}@media(max-width:600px){main{padding:20px 12px 40px}article{padding:20px 16px}.history-head,.stage-title{display:block}.status{display:block;text-align:left;margin-top:8px}.comparison{grid-template-columns:1fr}h1{font-size:27px}.timeline{padding-left:12px}.timeline>li{padding-left:10px}.ordinal{margin-left:-36px;margin-right:6px}nav{display:block}nav a{display:block;margin:10px 0}}@media print{body{background:white}main{max-width:none;padding:0}details{break-inside:avoid}.masthead a{display:none}article{break-before:page}}${concurrent.length ? concurrentStyle : ''}
</style></head><body><main><div class="masthead"><div class="brand">IDB<span>Shift</span></div><a download="report.json" href="data:application/json;base64,${Buffer.from(json).toString('base64')}">Download JSON</a></div><p class="eyebrow" style="margin-top:28px">LOCAL STORAGE · EXECUTED EVIDENCE</p><h1>Version history report</h1><p class="intro">One browser context per history. One fresh document per stage. PASS applies only to the executed history and declared checks. An expected refusal records a compatibility policy, not successful coexistence.${concurrent.length ? ' Concurrent histories show two documents of one origin that share a database at the same time; their event lanes are ordered only within each document.' : ''}</p><nav aria-label="Histories">${results.map((r, i) => `<a href="#history-${i}">${esc(r.history)}</a>`).join('')}${concurrent.map((r, i) => `<a href="#concurrent-${i}">${esc(r.history)}</a>`).join('')}</nav>${histories}${concurrent.map(renderConcurrent).join('')}<footer>Report schema 1 · Offline document, no external assets or telemetry. Expected and actual values are explicitly selected diagnostics. Traces, when enabled, are separate supporting artifacts.</footer></main></body></html>`.replace(
    /^[\t ]+$/gm,
    '',
  );
}

export async function writeReports(results: AnyResult[], directory: string) {
  await mkdir(directory, { recursive: true });
  const paths = {
    json: join(directory, 'report.json'),
    html: join(directory, 'report.html'),
    text: join(directory, 'report.txt'),
  };
  await Promise.all([
    writeFile(paths.json, `${JSON.stringify(envelope(results), null, 2)}\n`),
    writeFile(paths.html, renderHtml(results)),
    writeFile(paths.text, summarize(results)),
  ]);
  return paths;
}
