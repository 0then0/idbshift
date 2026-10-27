# Contributing to IDBShift

Bug reports, documentation improvements, regression tests, and small storage examples are welcome. Use English in code, interface text, diagnostics, and project discussions.

## Development setup

Use Node 24.22.1 and npm 11.19.1, then install the locked dependencies and Chromium:

```sh
npm ci
npx playwright install chromium
npm run check
```

On Linux, install browser prerequisites with `npx playwright install --with-deps chromium`.

`npm run format` applies formatting. `npm run typecheck`, `npm run test:unit`, and `npm run test:acceptance` run focused checks. `npm run build` compiles the library into `dist/lib` and builds the adapter host into `dist/host`; experiments serve browser adapters through Vite from source.

## Changes and tests

Keep changes focused on a concrete history or failure. Add a regression test that checks observable behavior, especially data meaning, lifecycle boundaries, or error classification. Acceptance tests must use real IndexedDB and disposable browser contexts.

The original Dexie rollback example is expected to violate its contract. Its CLI exit 1 is part of the experiment; the test suite passes when it detects that violation. Do not change the example or add retries to turn the counterexample into PASS.

New examples should use the public adapter/history API without changing the runner. Keep the core independent of storage libraries. Discuss consequential contract changes or new browser/storage integrations in an issue first. Any repair policy must belong to an explicitly selected application version, not the verifier.

After changes to source, tests, or configuration, run `npm run examples:record` to refresh sample reports and their input hashes, then run `npm run check`. The recorder returns 1 for the included counterexample; inspect the generated outcomes before committing. Do not commit `reports/`, `test-results/`, `playwright-report/`, browser profiles, or dependency caches.

See [testing and compatibility](docs/verification.md) for coverage and supported environments, and [dependency policy](docs/dependency-policy.md) before updating versions or the license inventory.

## Pull requests

Describe the triggering history, the resulting behavior, and the checks actually run. Include selected expected/actual diagnostics when useful. Use synthetic or redacted data in all shared reports and traces.

Commit messages follow Conventional Commits in English, for example `fix: preserve assertion snapshots`. Package publication and releases are separate maintainer workflows; normal CI only verifies changes.
