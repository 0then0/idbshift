# Dependency policy

Direct dependencies use exact versions, and `package-lock.json` pins the resolved graph. Use `npm ci` to install it. Node and npm versions are recorded in `.nvmrc` and `package.json`.

## Dexie experiment baseline

Dexie **4.4.7** is a development dependency used by the [rollback example](../examples/dexie/storage.ts). The runner contract does not depend on Dexie.

This version is an experimental baseline. Dependabot excludes its ordinary major, minor, and patch version updates so that routine maintenance cannot silently change what the #2097 adaptation demonstrates. A baseline change needs a dedicated review with a rationale, source/lock changes, both upgrade and rollback histories, the repair control, refreshed results, and a changelog entry. Add a separate labeled experiment when comparing library versions.

The version-update exclusion does not disable security fixes: its `version-update:semver-*` conditions are ignored in security-update jobs, as implemented in [Dependabot's ignore-condition code](https://github.com/dependabot/dependabot-core/blob/main/common/lib/dependabot/config/ignore_condition.rb). Security PRs still require review of the experiment. A historical pin is not grounds to suppress an advisory; assess its relevance and stop running the fixture if safe use cannot be established.

## Toolchain updates

Dependabot checks npm and GitHub Actions monthly, with at most three npm and two Actions version-update PRs open. Related Playwright minor/patch changes are grouped; remaining toolchain minor/patch changes form another group. Major updates stay separate. There is no automerge.

Keep `@playwright/test`, transitive `playwright`/`playwright-core`, and the installed browser revision aligned. After changing Playwright, run `npx playwright install chromium` and the full acceptance suite. Use the browser supplied by the locked installer rather than substituting system Chrome. The pin regression test checks package alignment.

Actions use full commit SHAs with version comments. Review permission/runtime changes when updating them. CI uses `contents: read` and does not publish packages or releases. Repository owners should enable GitHub dependency alerts and security updates in repository settings.

## Review an update

1. Change the intended exact versions and regenerate the lockfile with npm.
2. Review license changes. Run `npm run licenses:update` to refresh the inventory after checking new components; unknown license identifiers require an explicit update to the reviewed allowlist.
3. Run `npm run format`, focused tests, and `npm run examples:record`. The recorder's exit 1 is expected for the original counterexample; inspect the reports for the intended outcomes.
4. Run `npm run check` and `npm audit` before submitting the update.

The [license inventory](dependency-licenses.json) includes optional platform packages. Keep upstream notices when redistributing dependencies; see [third-party notices](../THIRD_PARTY_NOTICES.md).

## API references

Use installed declarations and the official API documentation when changing integrations:

- [Node release/LTS status](https://nodejs.org/en/about/previous-releases).
- [Playwright contexts](https://playwright.dev/docs/browser-contexts), [fixtures](https://playwright.dev/docs/test-fixtures), and [tracing](https://playwright.dev/docs/api/class-tracing).
- [Vite's server API](https://vite.dev/guide/api-javascript.html).
- [Dexie versioning](https://dexie.org/docs/Tutorial/Design), [open](https://dexie.org/docs/Dexie/Dexie.open()), [native connection](https://dexie.org/docs/Dexie/Dexie.backendDB()), and [VersionError](https://dexie.org/docs/DexieErrors/Dexie.VersionError).
- [Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
