export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ReadApi {
  /** Only call explicitly read-only application queries. No repair in verifiers. */
  query(name: string, input?: Json): Promise<Json>;
}

export interface Check {
  name: string;
  run(api: ReadApi): Promise<{ expected: Json; actual: Json }>;
}

export interface Stage {
  id: string;
  version: string;
  operations?: { name: string; input?: Json }[];
  checks: Check[];
  /** Exact error name. An expected refusal is a policy result, never a compatibility PASS. */
  expectOpenRefusal?: { name: string; reason: string };
  /**
   * Exact error name of an adapter open that is expected to fail, for example `AbortError` after
   * the adapter deliberately aborted its own upgrade transaction. `reason` explains why. The stage
   * never opens, so it declares no operations or checks. The error alone does not establish
   * recovery: a later stage with checks must. A compatibility refusal (`OpenRefusal`,
   * `VersionError`) is a different outcome and is declared with `expectOpenRefusal`.
   */
  expectOpenError?: { name: string; reason: string };
  deadlineMs?: number;
}

export interface History {
  id: string;
  databaseName: string;
  versions: Record<string, { appVersion: string; entrypoint: string }>;
  stages: Stage[];
  deadlineMs?: number;
}

export type StageStatus =
  | 'passed'
  | 'contract-violation'
  | 'open-refused'
  /** The adapter open failed with the error declared by `expectOpenError`. Not a recovery PASS. */
  | 'expected-open-error'
  | 'blocked'
  | 'error'
  | 'not-run';
/** An expected open error is a stage outcome only. It never becomes a history verdict. */
export type Verdict = Exclude<StageStatus, 'not-run' | 'expected-open-error'> | 'expected-refusal';

export interface Diagnostic {
  kind: string;
  message: string;
  phase: string;
}
export interface CheckResult {
  name: string;
  status: 'passed' | 'failed' | 'error';
  expected?: Json;
  actual?: Json;
  error?: Diagnostic;
}
/** Present only on a stage that declared `expectOpenError`. */
export interface OpenErrorResult {
  expected: { name: string; reason: string };
  /** Absent when the adapter opened. */
  actual?: { name: string; message: string };
  /**
   * - expected: the declared error name was observed.
   * - name-mismatch: another error was observed.
   * - refused: an application compatibility refusal, which is never an expected open error.
   * - opened: the adapter opened although a failure was declared.
   */
  outcome: 'expected' | 'name-mismatch' | 'refused' | 'opened';
}
export interface StageResult {
  id: string;
  version: string;
  appVersion: string;
  observedAppVersion?: string;
  databaseVersion?: number;
  documentId?: string;
  status: StageStatus;
  durationMs: number;
  operations: { name: string; status: 'completed' | 'error' }[];
  checks: CheckResult[];
  refusalExpected?: boolean;
  policyReason?: string;
  openError?: OpenErrorResult;
  error?: Diagnostic;
  cleanupError?: Diagnostic;
}
export interface Point {
  stage: string;
  check?: string;
  message: string;
}
export interface HistoryResult {
  schemaVersion: '1';
  toolVersion: string;
  history: string;
  databaseName: string;
  origin: string;
  startedAt: string;
  durationMs: number;
  verdict: Verdict;
  firstViolation?: Point;
  firstProblem?: Point;
  stages: StageResult[];
  environment: {
    browser: string;
    browserVersion: string;
    node: string;
    platform: string;
    dependencies: Record<string, string>;
  };
  limitations: string[];
  error?: Diagnostic;
}

/* ------------------------------------------------------------------------------------------ */
/* Concurrent histories (v0.2): two documents of one origin share one disposable database.     */
/* ------------------------------------------------------------------------------------------ */

/** A stays open and holds the old application. B is the document that requests the upgrade. */
export type ParticipantId = 'A' | 'B';

/**
 * Declared behavior of the old document after another document changes the database version.
 * IDBShift checks operations against this declaration. It never applies a recovery itself.
 */
export type OldTabPolicy =
  | { kind: 'hold-until-released'; reason: string }
  | { kind: 'no-policy'; reason: string }
  | {
      kind: 'refuse-writes' | 'read-only' | 'reload-required';
      /** Exact name of the application refusal. Thrown with OpenRefusal. */
      refusalName: string;
      reason: string;
    }
  | { kind: 'reconnect'; reason: string };

/**
 * `open-blocked` is the native IndexedDB `blocked` event of an open request. It is unrelated to
 * the run outcome `blocked`, which means a deadline or cancellation.
 */
export type ObservedEventType =
  | 'open-requested'
  | 'open-blocked'
  | 'upgrade-needed'
  | 'upgrade-transaction-complete'
  | 'upgrade-transaction-abort'
  | 'open-succeeded'
  | 'open-failed'
  | 'versionchange'
  | 'connection-close-called'
  | 'connection-closed-abnormally'
  | 'signal'
  | 'operation-started'
  | 'operation-finished'
  | 'session-close-started'
  | 'session-close-finished'
  | 'page-close';

/** Position `seq` is local to one document. Request and connection ids are local to it as well. */
export interface ObservedEvent {
  seq: number;
  type: ObservedEventType;
  /** True for protocol or adapter declarations. False for IndexedDB events seen by the observer. */
  declared?: true;
  request?: string;
  connection?: string;
  /** open-requested: version argument, or null when omitted. open-succeeded: connection version. */
  version?: number | null;
  oldVersion?: number;
  newVersion?: number | null;
  /** Signal, operation or error name. */
  name?: string;
  outcome?: string;
}
export interface ParticipantEvent extends ObservedEvent {
  participant: ParticipantId;
}

export interface EventMatcher {
  participant: ParticipantId;
  type: ObservedEventType;
  /** Signal name, operation name or error name, depending on the event type. */
  name?: string;
  oldVersion?: number;
  newVersion?: number | null;
}

export interface OracleSchema {
  /** Native IndexedDB version this schema describes. */
  version: number;
  /** Exact object store set. An unlisted store or a different key path is an oracle error. */
  stores: Record<string, { keyPath: string | null }>;
}
export interface OracleApi {
  /** Native version seen by a short-lived read-only oracle connection. */
  version(): Promise<number>;
  /**
   * Selected fields of the records with these keys, aligned with `keys`. A missing record is null.
   * A missing field is null. Fields are required so a count can never stand in for data.
   */
  records(store: string, keys: (string | number)[], fields: string[]): Promise<Json>;
  /** Selected fields of every record ordered by primary key. Fails above 1000 records. */
  all(store: string, fields: string[]): Promise<Json>;
}
export interface OracleCheck {
  name: string;
  run(api: OracleApi): Promise<{ expected: Json; actual: Json }>;
}

interface StepCommon {
  /** Short protocol explanation shown in the report. */
  note?: string;
  /** Applies to this step only. Defaults to the history deadline. */
  deadlineMs?: number;
}
export type ConcurrentStep = StepCommon &
  (
    | {
        /** Opens the participant document and awaits its adapter open. */
        action: 'open';
        participant: ParticipantId;
      }
    | {
        /** Opens the document and starts the adapter open without waiting for it to settle. */
        action: 'start-open';
        participant: ParticipantId;
      }
    | { action: 'await-open'; participant: ParticipantId }
    | {
        /** Waits for an observed event or adapter signal. Each event can satisfy one wait. */
        action: 'wait-for';
        event: EventMatcher;
      }
    | {
        action: 'operation';
        participant: ParticipantId;
        name: string;
        input?: Json;
        /** Default: success. policy-refusal needs the participant's declared refusalName. */
        expect?: 'success' | 'policy-refusal';
      }
    | { action: 'close-session'; participant: ParticipantId }
    | { action: 'close-page'; participant: ParticipantId }
    | {
        /** Independent reads from a separate short-lived page. */
        action: 'oracle';
        name: string;
        checks: OracleCheck[];
      }
  );

export interface ConcurrentHistory {
  kind: 'concurrent';
  id: string;
  databaseName: string;
  versions: History['versions'];
  participants: {
    A: { version: string; policy: OldTabPolicy };
    B: { version: string };
  };
  oracle: { schemas: OracleSchema[] };
  steps: ConcurrentStep[];
  deadlineMs?: number;
}

export type ConcurrentStepStatus =
  | 'completed'
  | 'policy-refusal'
  | 'unexpected-failure'
  | 'refusal-missing'
  | 'violation'
  | 'error'
  | 'blocked'
  | 'not-run';

/**
 * - passed: every step completed and every oracle check matched.
 * - expected-refusal: a declared policy refusal happened and nothing else went wrong.
 * - unexpected-operation: an operation failed or was accepted contrary to the declared policy.
 * - contract-violation: an oracle check proved a declared data invariant false.
 * - blocked: deadline or cancellation. Not evidence about data.
 * - error: adapter, configuration, oracle or infrastructure failure.
 */
export type ConcurrentVerdict =
  | 'passed'
  | 'expected-refusal'
  | 'unexpected-operation'
  | 'contract-violation'
  | 'blocked'
  | 'error';

export interface ConcurrentStepResult {
  /** Position in the declared script. Only this order is a protocol order. */
  index: number;
  action: ConcurrentStep['action'];
  participant?: ParticipantId;
  note?: string;
  status: ConcurrentStepStatus;
  durationMs: number;
  /** wait-for: the observed event that satisfied the wait. */
  matched?: { participant: ParticipantId; seq: number; type: ObservedEventType };
  /** await-open: index of the step that started this open. */
  startedBy?: number;
  open?: { observedAppVersion: string; databaseVersion: number };
  operation?: {
    name: string;
    expect: 'success' | 'policy-refusal';
    outcome: 'completed' | 'refused-by-policy' | 'failed';
    error?: { name: string; message: string };
  };
  oracle?: { nativeVersion?: number };
  checks?: CheckResult[];
  error?: Diagnostic;
  /** not-run: why the step did not execute. */
  reason?: string;
}

export type UpgradeState =
  | 'not-requested'
  | 'pending'
  | 'waiting-for-connection'
  | 'completed'
  | 'aborted';
export interface UpgradeSummary {
  state: UpgradeState;
  /** Version requested by B's upgrade, when an upgradeneeded event was observed. */
  requestedVersion?: number;
  fromVersion?: number;
  /** B events that establish the state. */
  evidence: { participant: ParticipantId; seq: number; type: ObservedEventType }[];
  /** Script step after which the runner first collected the completion event. */
  confirmedAfterStep?: number;
  /** First native version read by the independent oracle, when one ran. */
  oracleNativeVersion?: number;
}

export interface ParticipantRecord {
  version: string;
  appVersion: string;
  observedAppVersion?: string;
  documentId?: string;
  /** True after the adapter open settled successfully. */
  opened: boolean;
  /** Version of the first connection when the adapter open settled. */
  databaseVersion?: number;
  policy?: OldTabPolicy;
  pageClosed?: 'step' | 'cleanup';
}

export interface ConcurrentPoint {
  /** Script position of the step. */
  step: number;
  check?: string;
  message: string;
}

export interface ConcurrentHistoryResult {
  schemaVersion: '1';
  kind: 'concurrent';
  toolVersion: string;
  history: string;
  databaseName: string;
  origin: string;
  startedAt: string;
  durationMs: number;
  verdict: ConcurrentVerdict;
  firstViolation?: ConcurrentPoint;
  firstProblem?: ConcurrentPoint;
  participants: Record<ParticipantId, ParticipantRecord>;
  steps: ConcurrentStepResult[];
  /** Grouped by participant, ordered by local seq. No global order between participants. */
  events: ParticipantEvent[];
  upgrade: UpgradeSummary;
  /** Why the evidence is incomplete, when it is. */
  incomplete: string[];
  environment: HistoryResult['environment'];
  limitations: string[];
  error?: Diagnostic;
}
