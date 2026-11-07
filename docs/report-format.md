# Report format

Each run writes `report.txt`, `report.json`, and `report.html` to the selected output directory. The HTML report is self-contained and works offline, including its JSON download. It uses native disclosure controls and contains no executable JavaScript or external assets.

## JSON schema version 1

The envelope is `{ "schemaVersion": "1", "histories": HistoryResult[] }`, plus `concurrentHistories: ConcurrentHistoryResult[]` when a run included concurrent histories. See [concurrent records](#concurrent-records). Each history also carries `schemaVersion: "1"`. The field definitions are exported from [src/types.ts](../src/types.ts). Consumers should reject unsupported schema versions. Removing a field or changing its meaning requires a new schema version. Version 0.2 adds the optional `concurrentHistories` array without changing any existing field. `histories` still contains only sequential results and the new key is omitted when empty, so a sequential-only report is byte-for-byte the same shape as before and a consumer that ignores unknown keys keeps working.

A history contains:

- `toolVersion`, `history`, `databaseName`, and the controlled `origin`.
- `startedAt`, an ISO UTC timestamp, and `durationMs`.
- `verdict` and ordered `stages`.
- `firstViolation`, the first semantic mismatch, when present.
- `firstProblem`, the first unexpected failure of any kind, when present.
- `environment`, containing browser/build, Node/platform, and installed tool dependency versions.
- `limitations`, describing the scope of the evidence, plus an optional setup or context-cleanup `error`.

Dependency versions include Playwright Test, Playwright, playwright-core, Vite, and the optional Dexie example. An unavailable dependency is labeled `not installed`. Applications can expose additional selected version metadata through their own diagnostic queries.

## Stage and check records

Each stage records its id, version key, declared application version, observed adapter version when available, observed native database version, document UUID, status, and duration. Dexie logical versions and native IndexedDB versions are distinct: the pinned example uses native v10 and v20 for logical v1 and v2.

`operations` lists names and outcomes of operations that started. It omits input payloads and return values. `checks` lists names, `passed`/`failed`/`error` status, and captured expected/actual values for completed assertions. Failed or unfinished checks include a short error diagnostic where available. These values are snapshots from check completion, not references to later mutable scenario state.

Refused stages include `refusalExpected` and the declared `policyReason`. A stage that declared `expectOpenError` includes `openError`: `expected` (`name`, `reason`), `actual` (`name`, `message`; absent when the adapter opened) and `outcome` (`expected`, `name-mismatch`, `refused` or `opened`). Its status is `expected-open-error` only for outcome `expected`; the other outcomes are `error` or `open-refused`. The field and the status appear only in histories that use the declaration, so other reports are unchanged. `expected-open-error` is a stage status and never a history `verdict`.

The error alone does not establish recovery. The text and HTML reports list the checks of the stages after it, and the history's limitations say so. The JSON carries those results in the ordinary `stages[].checks`. Recovery was shown only when those checks are `passed`. `error` describes the stage failure; `cleanupError` retains a separate shutdown failure. Diagnostics contain `kind`, `message`, and `phase`. Missing observations are absent, not fabricated. Unexecuted stages have status `not-run` and explain why execution stopped.

`firstProblem` is captured at the first unexpected event. An expected open error is not a problem. A name mismatch, an unexpected successful open or a cleanup failure after it is. A later verifier exception or cleanup failure cannot supply a new message for an earlier failed check. `firstViolation` remains visible even when an operational error determines the final verdict.

## Verdicts and precedence

From highest to lowest precedence:

1. `error`: adapter, assertion code, configuration, shutdown, or infrastructure error.
2. `blocked`: cancellation or execution deadline.
3. `contract-violation`: expected and actual data differed.
4. `open-refused`: an unexpected compatibility refusal.
5. `expected-refusal`: declared refusal policy matched, with no unexpected failures.
6. `passed`: all executed stages completed their declared checks.

An adapter shutdown deadline produces an error in the `close` phase; cancellation during shutdown is `blocked`. Neither is a data-loss verdict. Accepted refusals permit subsequent stages; unexpected refusals and operational failures stop the sequence. The runner performs no retries.

Read the timeline as well as the final verdict: precedence preserves all earlier evidence and does not hide it. PASS establishes only the executed history and declared checks. Expected refusal is a policy result, not successful cross-version writes.

## Concurrent records

A `ConcurrentHistoryResult` has `kind: "concurrent"`, its own `schemaVersion: "1"`, the common identity, timing, `environment`, `limitations` and `error` fields, and:

- `verdict`: `passed`, `expected-refusal`, `unexpected-operation`, `contract-violation`, `blocked` or `error`, with the precedence described in the [adapter contract](adapter-contract.md#operation-outcomes-and-verdicts). Verdict `blocked` is a deadline or cancellation. The native IndexedDB `blocked` event is the event type `open-blocked`.
- `participants`: A and B with the version key, declared and observed application version, document UUID, whether the adapter open settled, the first connection's native version, and A's declared `policy`.
- `steps`: the script in order, each with `status`, duration, the matched event of a wait, the open it settles, operation outcome and error name, oracle native version and checks. `index` is a protocol position.
- `events`: observed and declared events grouped by participant and ordered by `seq` inside each document. Ids such as `r1` and `c1` are local to one document. No timestamp and no global order is recorded, because the browser provides none. Collection order by the runner is not a causal order.
- `upgrade`: `state` (`not-requested`, `pending`, `waiting-for-connection`, `completed`, `aborted`), requested and previous versions, the B events that establish it, the step after which the runner first collected the completion, and the first native version read by the oracle.
- `incomplete`: reasons evidence is missing, for example steps that did not run, a deadline, an upgrade that never settled, or no completed oracle read.
- `firstViolation` and `firstProblem` use `{ step, check?, message }`. A violation is only a failed oracle comparison.

Causal links appear only where the script establishes them: a wait names the event that released it, and an await names the start it settles. The lanes in the HTML report are ordered only inside each document.

## Sharing reports

Default exports contain selected assertion diagnostics and tool metadata, not cookies, browser storage state, page logs, stacks, operation payloads, or database dumps. Concurrent reports add event types, ids, versions, signal and error names, and operation names, never input values or full records. Labels, expected/actual values, and application error messages are caller-controlled: select synthetic or redacted data before sharing. Automatic exception diagnostics truncate multiline stacks and redact current working/home directory prefixes; this is not a general secret scrubber.

`--trace` saves separate Playwright artifacts. Traces may contain sensitive browser details and source locations. Review them independently; they supplement assertions rather than proving correctness. See [SECURITY.md](../SECURITY.md).
