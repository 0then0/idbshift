# Adapter and history API

The public entrypoints are `idbshift`, `idbshift/browser`, and `idbshift/playwright`. They export TypeScript source for the local source-checkout workflow. Browser adapters are compiled by Vite on demand.

## Histories

A scenario exports `histories: History[]`. Each history has:

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

A missing expected refusal is an error. A blocked upgrade that reaches its deadline is `blocked`, not a refusal or evidence of data loss.

## Lifecycle and isolation

One history owns one fresh, non-persistent browser context. Its stages use the exact same origin, including port, and database name. Each stage creates a new document and destroys it before the next one opens. Browser globals, modules, and singletons are therefore recreated while IndexedDB persists.

The runner checks native database metadata between stages, guards database names and deletion, verifies the exposed live connection, blocks ordinary requests outside the origin, and detects replaced documents or extra pages. It never clears data, reseeds implicitly, changes the physical database version to simulate rollback, or imports a snapshot. Rollback means executing A against B's installed schema.

The guards detect accidental adapter mistakes. Workers, same-origin frames, popups, concurrent tabs, and multiple databases per history are outside this contract. Entry modules should have no storage side effects before `open`.

The stage deadline is controlled by Node. After execution, application shutdown has a separate **1000 ms** deadline, also controlled by Node, so a stalled renderer cannot disable its timer. Cancellation remains active during shutdown. A timed-out or cancelled page is destroyed, and the history's context is closed in the final cleanup. Node verifier code must remain asynchronous and cooperative: an infinite synchronous loop in Node prevents its own timers from running.

A data mismatch allows subsequent stages to run. An operational error, unexpected refusal, or incomplete stage stops the sequence and marks the rest `not-run`. The earliest unexpected problem and earliest semantic violation are recorded separately and are never replaced by later events.

## Standalone runner

`runHistory(browser, history, { origin, signal?, tracePath?, step? })` returns a `HistoryResult` and owns its context and pages. The caller owns the browser and server. `startAdapterServer(root?)` starts a loopback Vite host on an ephemeral port and returns `{ origin, close }`. Close caller-owned resources in `finally`, or use the supplied CLI/fixture.

The CLI resolves `--scenario` relative to the working directory and uses `--root` as the Vite root. Keep adapters and imports in that root with a host `index.html` and a resolvable `idbshift/browser` export. No registry, production URL connector, or automatic production-bundle integration is provided.

v0.1 accepts Chromium. Other engines are rejected until their lifecycle and acceptance behavior are verified.
