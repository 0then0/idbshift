# Changelog

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
