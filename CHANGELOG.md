# Changelog

## 0.1.0 — Unreleased

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
