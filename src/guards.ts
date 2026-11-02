import type { BrowserContext } from '@playwright/test';
import type { ObservedEvent } from './types.js';

/**
 * Installs the database identity guards in every document of the context. With `observe`, the same
 * `IDBFactory.open` wrapper also records IndexedDB events through addEventListener. Application
 * handlers, results and exceptions are never replaced, suppressed or retried.
 */
export async function installGuards(
  context: BrowserContext,
  databaseName: string,
  observe = false,
) {
  // tsx and esbuild may wrap named functions in __name(...). Functions serialized into the page
  // would then call a helper that only exists in Node, so the page gets an identity version.
  if (observe) await context.addInitScript('globalThis.__name ??= (target) => target;');
  await context.addInitScript(
    ({ databaseName, observe }) => {
      const violations: string[] = [];
      const events: ObservedEvent[] = [];
      const waiters: (() => boolean)[] = [];
      let sequence = 0;
      const emit = (event: Omit<ObservedEvent, 'seq'>) => {
        events.push({ seq: ++sequence, ...event });
        for (const waiter of [...waiters]) {
          let done = false;
          try {
            done = waiter();
          } catch {
            done = true;
          }
          if (done) waiters.splice(waiters.indexOf(waiter), 1);
        }
      };
      window.__idbshiftGuard = {
        violations,
        documentId: crypto.randomUUID(),
        ...(observe ? { events, waiters, emit } : {}),
      };
      // Observer faults must never reach application code.
      const safely = (action: () => void) => {
        try {
          action();
        } catch {}
      };

      const connectionIds = new WeakMap<object, string>();
      let connectionCount = 0;
      let requestCount = 0;
      const track = (database: IDBDatabase) => {
        let id = connectionIds.get(database);
        if (id) return id;
        id = `c${++connectionCount}`;
        connectionIds.set(database, id);
        const connection = id;
        database.addEventListener('versionchange', (event) =>
          safely(() => {
            const change = event as IDBVersionChangeEvent;
            emit({
              type: 'versionchange',
              connection,
              oldVersion: change.oldVersion,
              newVersion: change.newVersion,
            });
          }),
        );
        database.addEventListener('close', () =>
          safely(() => emit({ type: 'connection-closed-abnormally', connection })),
        );
        return id;
      };
      const watch = (request: IDBOpenDBRequest, version: unknown) => {
        const id = `r${++requestCount}`;
        safely(() => {
          emit({
            type: 'open-requested',
            request: id,
            version: typeof version === 'number' ? version : null,
          });
          request.addEventListener('blocked', (event) =>
            safely(() => {
              const change = event as IDBVersionChangeEvent;
              emit({
                type: 'open-blocked',
                request: id,
                oldVersion: change.oldVersion,
                newVersion: change.newVersion,
              });
            }),
          );
          request.addEventListener('upgradeneeded', (event) =>
            safely(() => {
              const change = event as IDBVersionChangeEvent;
              const connection = track(request.result);
              emit({
                type: 'upgrade-needed',
                request: id,
                connection,
                oldVersion: change.oldVersion,
                newVersion: change.newVersion,
              });
              const transaction = request.transaction;
              transaction?.addEventListener('complete', () =>
                safely(() =>
                  emit({ type: 'upgrade-transaction-complete', request: id, connection }),
                ),
              );
              transaction?.addEventListener('abort', () =>
                safely(() =>
                  emit({
                    type: 'upgrade-transaction-abort',
                    request: id,
                    connection,
                    name: transaction.error?.name,
                  }),
                ),
              );
            }),
          );
          request.addEventListener('success', () =>
            safely(() => {
              const connection = track(request.result);
              emit({
                type: 'open-succeeded',
                request: id,
                connection,
                version: request.result.version,
              });
            }),
          );
          request.addEventListener('error', () =>
            safely(() => emit({ type: 'open-failed', request: id, name: request.error?.name })),
          );
        });
      };

      const originalOpen = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function open(
        this: IDBFactory,
        name: string,
        ...rest: unknown[]
      ) {
        if (String(name) !== databaseName) {
          violations.push('Adapter attempted to open a different database');
          throw new Error('IDBShift database identity guard');
        }
        const version = rest[0];
        const request =
          version === undefined
            ? Reflect.apply(originalOpen, this, [name])
            : Reflect.apply(originalOpen, this, [name, version]);
        if (observe) watch(request, version);
        return request;
      };
      IDBFactory.prototype.deleteDatabase = () => {
        violations.push('Database deletion is forbidden within a history');
        throw new Error('IDBShift database deletion guard');
      };
      if (observe) {
        const originalClose = IDBDatabase.prototype.close;
        IDBDatabase.prototype.close = function close(this: IDBDatabase, ...args: []) {
          const result = Reflect.apply(originalClose, this, args);
          const connection = connectionIds.get(this);
          if (connection) safely(() => emit({ type: 'connection-close-called', connection }));
          return result;
        };
      }
    },
    { databaseName, observe },
  );
}
