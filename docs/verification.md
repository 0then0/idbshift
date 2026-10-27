# Testing and compatibility

IDBShift checks real IndexedDB behavior with Playwright's Chromium. Unit tests cover the JSON diagnostic boundary and historical dependency pins. Acceptance tests cover storage histories, failure handling, resource cleanup, CLI behavior, and offline reports.

## Run the checks

Use the versions in `.nvmrc` and `package.json`, then run:

```sh
npm ci
npx playwright install chromium
npm run check
```

On Linux, use `npx playwright install --with-deps chromium`. The full check runs formatting, lint, TypeScript, unit tests, build, Chromium acceptance, license inventory, and recorded-example input verification. No retry is configured.

For focused work:

```sh
npm run test:unit
npm run test:acceptance
npm run typecheck
npm run build
```

Browser test results and screenshots are written to `test-results/`. Playwright's HTML report is in `playwright-report/`; use `npx playwright show-report` to open it. These generated artifacts are ignored by Git.

## What the suite checks

The browser suite verifies isolation of histories at the same origin/database name, preservation between stages, fresh documents and module globals, one-time preparation, origin/database guards, real rollback writes, exact field values, and index query results. The native example checks a separate ledger invariant without Dexie.

Failure tests cover intentional and unexpected refusals, incorrect expectations, thrown assertions, unsupported JSON values, stage deadlines, cancellation, and shutdown. Shutdown tests include a renderer occupied by synchronous code or an uninterrupted microtask queue, so deadlines are checked independently of browser timers. Contexts and pages must be released after failure.

Report tests preserve the first failure and its diagnostic snapshots after later mutations, successful stages, or errors. They check the offline HTML's escaped output, JSON download, keyboard/pointer disclosures, and narrow-screen overflow. The icon is rendered on both light and dark backgrounds.

## Recorded example results

The [HTML report](evidence/report.html), [JSON](evidence/report.json), and [text summary](evidence/report.txt) are generated from the checked-in examples using synthetic data. Their environment fields identify the exact Node, browser, and dependency versions; timestamps and durations belong to that recorded run.

- **Dexie A → B:** the upgrade runs once, stores `alice`, and the new index returns `[1]`.
- **Dexie A → B → A-write → B:** both rows remain, but derived fields are absent and the new index returns `[]` instead of `[1, 2]`. The second B open runs zero upgrades. Diagnostic projections represent missing fields explicitly as `null`.
- **Dexie repair control:** B repairs two rows on reopening and the index returns `[1, 2]`, with exact values `alice updated` and `bob`.
- **Native ledger upgrade:** original entries remain and the materialized balance equals their sum, 900 cents.
- **Native ledger refusal:** A raises `VersionError` against native v2, performs no rollback writes, and B verifies the preserved entries and balance afterward.

The runner does not recognize these history names or prescribe their outcomes. Acceptance tests assert the expected experiment results.

Regenerate the examples and their input checksums with:

```sh
npm run examples:record
```

This command returns **1** because the original Dexie rollback history violates its contract. It still writes all three reports and `sources.sha256`. Only CLI setup/export errors prevent a new input manifest from being recorded. Use `npm run evidence:check` to detect changed inputs before sharing a recorded report. For a separate output directory, run `npm run examples:record -- --out reports/reference`.

## Environments

The recorded local run uses macOS 15.7.9 on arm64, Node 24.22.1, Playwright 1.64.1, and Chromium 156.0.8078.4. The [CI workflow](../.github/workflows/ci.yml) runs the same checks on macOS 15 and Ubuntu 24.04. Consult [workflow results](https://github.com/0then0/idbshift/actions/workflows/ci.yml) for completed runs; a configured job alone is not evidence that an environment passed.

Chromium is the supported browser for v0.1. Firefox, WebKit, and Windows have not been validated. New compatibility claims need completed acceptance runs and reproducible results.

## Evidence limits

A passing result covers selected synthetic histories and declared invariants. It does not establish general application safety or reproduce the full production context of Dexie #2097. The repair control demonstrates a policy for one derived field, without multi-tab or concurrent-write guarantees. Crash, quota, service-worker, and production-data testing are outside the suite's scope.
