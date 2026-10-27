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
  | 'blocked'
  | 'error'
  | 'not-run';
export type Verdict = Exclude<StageStatus, 'not-run'> | 'expected-refusal';

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
