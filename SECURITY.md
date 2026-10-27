# Security policy

IDBShift is a local developer tool for trusted scenarios and disposable data. It executes scenario code in Node and adapter code in a test browser. It is not a sandbox for untrusted programs or a hosted multi-user service.

## Safe operation

Use synthetic data and non-persistent browser contexts. Do not connect experiments to production services, personal browser profiles, or user accounts. The local Vite host serves the selected project root on loopback for the duration of the run.

Browser origin/database guards detect ordinary integration mistakes. They do not prevent hostile Node code, overwritten platform APIs, worker-based access, or deliberate exfiltration in diagnostic values. Adapter queries must be read-only; service workers are blocked.

Default reports include selected assertions and tool metadata, not cookies, storage-state exports, page logs, operation payloads, or database dumps. Scenario labels and error messages may still contain data you supplied. Review every artifact before sharing.

Playwright traces are opt-in and can contain sensitive browser details and source locations. Review them separately. IDBShift has no telemetry.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/0then0/idbshift/security/advisories/new) when available. Otherwise, contact the [repository owner](https://github.com/0then0) through a private contact route on their profile. Keep exploit details, tokens, private databases, and full traces out of public issues.

Include the affected version, a minimal synthetic reproduction, impact, and relevant redacted diagnostics. Reports affecting the current 0.1.x development line are reviewed without a guaranteed response time.

## Dependencies

Review dependency alerts, including advisories affecting the historical Dexie fixture, according to the [dependency policy](docs/dependency-policy.md). Do not suppress an advisory merely to preserve an experiment. Repository owners should enable GitHub security alerts, security updates, and private vulnerability reporting.
