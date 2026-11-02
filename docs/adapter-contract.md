# Adapter and history API

The public entrypoints are `idbshift`, `idbshift/browser`, and `idbshift/playwright`. They export TypeScript source for the local source-checkout workflow. Browser adapters are compiled by Vite on demand.

## Histories

A scenario exports `histories: (History | ConcurrentHistory)[]`; [concurrent histories](#concurrent-histories) are described at the end. Each sequential history has:

- `id`: a nonempty report label.
- `databaseName`: the disposable database shared by its stages.
- `versions`: version keys mapped to `{ appVersion, entrypoint }`.
- `stages`: an ordered, nonempty sequence.
- `deadlineMs`: an optional default stage deadline, 10000 ms by default.

Each stage declares a unique `id`, a version key, optional `operations`, and named `checks`. A stage-level `deadlineMs` overrides the history default. Deadlines must be integers from 1 to 120000 ms. Check names must be unique within a stage. An opened stage needs at least one semantic check.

An operation is `{ name, input? }`; omitted input becomes `null`. It runs only where declared. Operation return values are ignored. Await all durable writes before the operation completes.

A check implements `run({ query })` and returns `{ expected, actual }`. It runs in Node; `query(name, input?)` invokes the adapter's read-only browser query. Object key order is irrelevant to equality; array order matters. The runner validates and snapshots both values before comparison, so later changes to a scenario's objects cannot alter earlier evidence.

Use independent expectations: original fixture values, a documented calculation, or another read-only view of the invariant. Do not derive expected values from the same potentially broken implementation you are checking. The native ledger example checks original entries separately from its balance calculation.

## Browser adapters

Each root-relative entrypoint default-exports `defineAdapter({ appVersion, open })`. The observed `appVersion` must match the scenario declaration. A and B should import their respective real storage implementations.

`open({ databaseName })` returns a `StorageSession`:

- `database`: the actual open `IDBDatabase` connection used by the storage code. Dexie exposes it through `backendDB()`.
- `close()`: complete application cleanup and close storage connections.
- `operations`: named write/read functions receiving a JSON input. Methods retain this object's receiver.
- `queries`: named read-only functions receiving and returning JSON. Methods retain their query object's receiver.

Queries must not heal, migrate, seed, or write data. Put reconciliation in an explicitly selected version's open or write path. The runner's query-only check interface helps separate responsibilities; it does not sandbox trusted JavaScript or prove that a query is read-only.

The complete adapters are in [examples/dexie/storage.ts](../examples/dexie/storage.ts) and [examples/native/storage.ts](../examples/native/storage.ts).

## Diagnostic values

Inputs and assertion values support `null`, booleans, strings, finite numbers other than negative zero, plain objects, and ordinary dense arrays containing supported values. Null-prototype objects are accepted. Arrays with custom prototypes are rejected before serialization hooks can run.

Undefined, bigint, dates, maps, sets, binary objects, nonfinite numbers, functions, symbols, accessors, non-enumerable properties, sparse arrays, custom class instances, and cycles are errors. Repeated non-cyclic references are accepted and become independent JSON copies. Select a projection such as `{ id, amountCents }` instead of returning raw application objects or a full database.

## Refusal policies

Declare an intentional compatibility gate with `expectOpenRefusal: { name, reason }`. The exact error name must match. A refused stage may have an empty check list because its operations and checks do not execute.

Throw `new OpenRefusal(message, name?)` from an application gate. Its default name is `CompatibilityRefusal`; native `VersionError` also counts as refusal. Other exceptions are adapter errors. An expected refusal permits subsequent stages and produces an `expected-refusal` history verdict when no unexpected problem occurs. An unexpected refusal stops the remaining stages.

A missing expected refusal is an error. In a concurrent history, `OpenRefusal` can also be thrown from an operation; see below. A blocked upgrade that reaches its deadline is `blocked`, not a refusal or evidence of data loss.

## Lifecycle and isolation

One history owns one fresh, non-persistent browser context. Its stages use the exact same origin, including port, and database name. Each stage creates a new document and destroys it before the next one opens. Browser globals, modules, and singletons are therefore recreated while IndexedDB persists.

The runner checks native database metadata between stages, guards database names and deletion, verifies the exposed live connection, blocks ordinary requests outside the origin, and detects replaced documents or extra pages. It never clears data, reseeds implicitly, changes the physical database version to simulate rollback, or imports a snapshot. Rollback means executing A against B's installed schema.

The guards detect accidental adapter mistakes. For sequential histories, workers, same-origin frames, popups, concurrent tabs, and multiple databases are outside this contract. Concurrent histories add exactly two participants and nothing else. Entry modules should have no storage side effects before `open`.

The stage deadline is controlled by Node. After execution, application shutdown has a separate **1000 ms** deadline, also controlled by Node, so a stalled renderer cannot disable its timer. Cancellation remains active during shutdown. A timed-out or cancelled page is destroyed, and the history's context is closed in the final cleanup. Node verifier code must remain asynchronous and cooperative: an infinite synchronous loop in Node prevents its own timers from running.

A data mismatch allows subsequent stages to run. An operational error, unexpected refusal, or incomplete stage stops the sequence and marks the rest `not-run`. The earliest unexpected problem and earliest semantic violation are recorded separately and are never replaced by later events.

## Standalone runner

`runHistory(browser, history, { origin, signal?, tracePath?, step? })` returns a `HistoryResult` and owns its context and pages. The caller owns the browser and server. `startAdapterServer(root?)` starts a loopback Vite host on an ephemeral port and returns `{ origin, close }`. Close caller-owned resources in `finally`, or use the supplied CLI/fixture.

The CLI resolves `--scenario` relative to the working directory and uses `--root` as the Vite root. Keep adapters and imports in that root with a host `index.html` and a resolvable `idbshift/browser` export. No registry, production URL connector, or automatic production-bundle integration is provided.

v0.1 and v0.2 accept Chromium. Other engines are rejected until their lifecycle and acceptance behavior are verified.

## Concurrent histories

A `ConcurrentHistory` (`kind: 'concurrent'`) covers one situation: an old application document A stays open on a database while a new application document B requests a higher native version. It is a bounded extension, not a scheduler. There are exactly two participants, one origin, one database name and one browser context. Sequential histories and entrypoints are unchanged.

```ts
const history: ConcurrentHistory = {
  kind: 'concurrent',
  id: 'held-connection',
  databaseName: 'disposable-notes',
  versions: {
    old: { appVersion: 'notes-old', entrypoint: '/old.ts' },
    next: { appVersion: 'notes-next', entrypoint: '/new.ts' },
  },
  participants: {
    A: { version: 'old', policy: { kind: 'hold-until-released', reason: '...' } },
    B: { version: 'next' },
  },
  oracle: {
    schemas: [
      { version: 1, stores: { notes: { keyPath: 'id' } } },
      { version: 2, stores: { audit: { keyPath: 'id' }, notes: { keyPath: 'id' } } },
    ],
  },
  steps: [
    /* see below */
  ],
};
```

Participant adapters are ordinary adapters. Each participant opens at most once, in its own page.

### Steps

Steps run in order. Only this script order is a protocol order.

- `open`: create the page and await the adapter `open`.
- `start-open`: create the page and start the adapter `open` without waiting. The runner continues while B's upgrade is pending.
- `await-open`: wait for a started open to settle. Every `start-open` must be awaited or have its page closed.
- `wait-for { participant, type, name?, oldVersion?, newVersion? }`: wait for an observed event or an adapter signal. An event that already happened satisfies the wait. Each event satisfies at most one wait.
- `operation { participant, name, input?, expect? }`: run a named adapter operation. `expect` is `success` (default) or `policy-refusal`.
- `close-session`: call the adapter `session.close()`. `close-page`: close the participant page.
- `oracle { name, checks }`: independent reads, below. Not allowed while an open is pending, because a read could queue behind the upgrade it is meant to check.

Every step accepts `note` (shown in the report) and `deadlineMs` (1 to 120000, default from the history, else 10000). Every wait, operation, open and close is bounded by a Node timer and by cancellation. A deadline records `blocked` and says only that the awaited thing did not happen in time. It never proves that the event cannot occur or that data was lost. Synchronization uses events, completed operations and signals; there are no sleeps. IDBShift does not promise that all browser event sequences are deterministic, only that the declared script waits for what it names.

### Observed events

The observer records, per document and with a local `seq`: `open-requested`, `open-blocked`, `upgrade-needed`, `upgrade-transaction-complete`, `upgrade-transaction-abort`, `open-succeeded`, `open-failed`, `versionchange` (with `oldVersion` and `newVersion`), `connection-close-called`, `connection-closed-abnormally`, and `declared` events: `signal`, `operation-started`, `operation-finished`, `session-close-started`, `session-close-finished`, `page-close`.

`open-blocked` is the native IndexedDB `blocked` event on an open request. It is different from the run outcome `blocked`, which means a deadline or cancellation. Request and connection ids (`r1`, `c1`) are local to one document; the report qualifies them with the participant.

The observer works through `addEventListener` and through wrappers for `IDBFactory.prototype.open` and `IDBDatabase.prototype.close` that keep receiver, arguments, result and exceptions. It never replaces `on*` handlers, suppresses events or errors, closes connections, retries or invalidates application caches. The wrappers keep `name` and `length` but not the native `toString()`. It does not see connections made in workers or frames, and it does not see actions inside the browser that raise no event. Acceptance tests check wrapper transparency in Chromium.

### Signals

An adapter can declare a state change with `signal(name)` from `idbshift/browser`, after the state has changed. A signal carries a name of 1 to 80 letters, digits, dots, dashes or underscores, and nothing else. Outside an IDBShift run it does nothing.

### Declared policy of A

`participants.A.policy` states what the old document is expected to do after the version changes:

- `hold-until-released`: keeps its connection until the history closes it.
- `no-policy`: implements no stale-document behavior, so operations are expected to succeed.
- `refuse-writes`, `read-only`, `reload-required`: refuse operations with an exact `refusalName`.
- `reconnect`: closes and reopens a valid connection. Valid only for compatible schemas.

A refusal counts only when the operation throws an `OpenRefusal` whose name equals `refusalName`. A native error such as `InvalidStateError` is never a policy refusal. IDBShift checks the declaration; it does not retry, repair or reconnect for the application.

### Operation outcomes and verdicts

Step statuses: `completed`, `policy-refusal` (expected), `unexpected-failure`, `refusal-missing` (the declared refusal did not happen), `violation` (an oracle check proved a declared invariant false), `error`, `blocked`, `not-run`.

History verdicts, highest precedence first: `error` (adapter, configuration, oracle or infrastructure), `blocked` (deadline or cancellation), `contract-violation`, `unexpected-operation`, `expected-refusal`, `passed`. A failed operation is never a data-loss verdict: only an oracle comparison produces `contract-violation`. An accepted refusal never hides a real invariant violation, because both are recorded and the violation ranks higher. An unexpected operation or a violation lets later steps run, so the oracle can still describe the data. An error, deadline or cancellation stops the script and marks the remaining steps `not-run`.

### Independent oracle

The oracle runs in a separate page that never imports an adapter and never uses a participant's session or cache. Each read opens its own short-lived connection with no version, so it cannot create or upgrade the database, and closes it before returning. If the oracle's open would trigger `upgradeneeded`, it aborts and reports an error.

`oracle.schemas` lists the native versions the fixture knows, with their exact object stores and key paths. A database that is missing, at an undeclared version, or with different stores or key paths is an error, not an empty result. The `OracleApi` offers `version()`, `records(store, keys, fields)` and `all(store, fields)` (at most 1000 records). Reads select fields explicitly. A missing record and a missing field are `null`. A count alone is not a supported assertion.

### Lifecycle

One context per history. The runner owns every page it creates, including oracle pages, destroys them on every exit path, and closes the context. Cleanup never depends on a hanging adapter; it destroys pages directly with its own deadline. Results are produced only by the runner after a step returns, so a late browser or check callback cannot alter a finished step or the final result. The existing database identity and deletion guards, origin blocking and extra-page detection apply to both participants.

### Running

```sh
npm run experiment:concurrent
```

or `runConcurrentHistory(browser, history, { origin, signal?, tracePath?, step? })`. The Playwright fixture `idbshift(history)` accepts either kind. A scenario may mix both kinds in `histories`.
