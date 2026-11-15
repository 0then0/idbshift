# Changelog

## [0.4.0](https://github.com/0then0/idbshift/releases/tag/v0.4.0) — 2026-11-15

### Features

- Sequential and concurrent histories run in Playwright's Chromium, Firefox and WebKit. `runHistory` and `runConcurrentHistory` no longer reject non-Chromium browsers; the engine is the `Browser` the caller passes.
- CLI option `--browser chromium|firefox|webkit`. One run uses one engine. An unknown name is rejected before the scenario loads; a missing binary stops with `BrowserLaunchError`, the engine name and the `npx playwright install` command. Both exit 2 and write no report. There is no fallback engine and no retry.
- Without `--out`, Firefox and WebKit write to `reports/firefox/` and `reports/webkit/`, so their reports and traces do not overwrite Chromium's.
- The CLI prints the launched engine and version. `scripts/evidence.mjs record` accepts `--browser`.
- `playwright.config.ts` defines `chromium`, `firefox` and `webkit` projects. The `idbshift/playwright` fixture uses the project's browser.
- CI runs the static checks once and acceptance in a limited matrix: Chromium on Ubuntu and macOS, Firefox on Ubuntu, WebKit on macOS.
- Recorded example results for Firefox and WebKit in `docs/evidence/firefox/` and `docs/evidence/webkit/`.

### Compatibility

- Without `--browser`, the CLI still uses Chromium and `reports/`. Verdicts, exit codes and report schema 1 are unchanged. `environment.browser` and `environment.browserVersion` already identified the engine and now take the values `firefox` and `webkit` as well.
- The concurrent limitation text names the engine that ran the history instead of always saying Chromium.
- The origin-escape test probes use a routable port. Firefox and WebKit refuse the banned port 1 before Playwright's request interception, so that attempt never reached the origin guard.
- The Chromium example evidence was re-recorded because the pinned input manifest changed; its outcomes are unchanged.

## [0.3.0](https://github.com/0then0/idbshift/releases/tag/v0.3.0) — 2026-11-07

### Features

- Sequential stages can declare `expectOpenError: { name, reason }` for an adapter open that is expected to fail with an exact error name, such as `AbortError` after the application aborted its own upgrade. The stage ends as `expected-open-error`, the history continues, and later stages must verify recovery. This is separate from `expectOpenRefusal`.
- Native example `recoveryHistory()`: A → B-abort → A-check → B-retry. The failure injection is in the example adapter, not the runner.
- Text and HTML reports show the expected and observed error and the results of the later checks.

### Compatibility

- Report schema 1 gains the optional stage field `openError` and the stage status `expected-open-error`. Both appear only when a history declares `expectOpenError`; history verdicts, exit codes, refusal policies and concurrent histories are unchanged.

## [0.2.0](https://github.com/0then0/idbshift/releases/tag/v0.2.0) — 2026-11-02

### Features

- Concurrent histories: two documents of one origin, A (old application, stays open) and B (new application, requests the upgrade), share one disposable database inside one browser context. A script of explicit steps starts B's open without waiting, waits for real IndexedDB events or adapter signals, runs operations on A while B waits, closes sessions or pages by declaration, and awaits B's open.
- Observation of `versionchange`, native `blocked`, `upgradeneeded`, upgrade transaction complete/abort, open success or failure, `close()` calls, operations and declared lifecycle actions, with ids local to each document. The observer uses `addEventListener` and transparent prototype wrappers; it never replaces handlers, suppresses events or errors, closes connections or invalidates application caches.
- A declared old-tab policy (hold until released, no policy, refuse writes, read-only, reload required, reconnect) checked against each operation. Outcomes distinguish an expected refusal, an unexpected operation failure, a missing refusal, a confirmed data violation, a deadline or cancellation, and an adapter or infrastructure error.
- An independent oracle that reads declared records and fields from a separate short-lived page. It opens without a version, never creates or upgrades the database, and treats a missing database, unknown schema or failed read as an error.
- Four runnable histories (`npm run experiment:concurrent`): held connection, cached closed connection, declared stale-write refusal, and a compatible reconnect control.
- `signal()` in `idbshift/browser` lets an adapter declare a state change that a history can wait for.
- Reports show participant lanes, steps, upgrade state, declared policy and the reasons evidence is incomplete.

### Compatibility

- Sequential histories, adapters, `runHistory`, the CLI defaults and the report schema 1 are unchanged. Concurrent results are added in an optional `concurrentHistories` array; `histories` stays sequential, and the key is omitted when there are none.
- `idbshift/playwright` `idbshift(history)` also accepts a concurrent history. `OpenRefusal` may now also be thrown from an operation to enforce a declared policy.

### Visual

- Simplified project icon: an old and a new version exchange arrows above one database.

## [0.1.0](https://github.com/0then0/idbshift/releases/tag/v0.1.0) — 2026-10-28

### Features

- TypeScript scenarios and browser adapters for sequential IndexedDB upgrade, rollback, and second-upgrade histories.
- Per-history browser isolation, preserved database state, fresh stage documents, and origin/database identity guards.
- Semantic assertions, explicit refusal policies, bounded execution and shutdown, and cancellation.
- CLI and Playwright Test integration with text, versioned JSON, and self-contained offline HTML reports.
- A Dexie 4.4.7 rollback counterexample, an explicit open-repair control, and a native IndexedDB ledger example.
- Exact dependency pins, license inventory, monthly dependency updates, and Chromium acceptance checks.

### Reliability

- Control shutdown deadlines from Node so stalled browser code cannot disable them.
- Keep cancellation active during storage shutdown.
- Capture diagnostic snapshots and preserve the original cause of the first problem.
- Reject array subclasses before serialization can transform their values.
- Preserve method receivers when invoking adapter operations.

See [testing and compatibility](docs/verification.md) for the verification workflow and recorded results.
