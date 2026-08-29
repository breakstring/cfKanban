import { isUuid } from "./crypto.ts";
import { notFound, platformUnavailable, validationError } from "./errors.ts";

export interface OperationCommit {
  committedAt: number;
  lastEventSequence: number;
  operationId: string;
  primarySubjectId: string;
  primarySubjectType: string;
}

interface OperationCommitRow {
  committed_at: number;
  last_event_sequence: number;
  operation_id: string;
  primary_subject_id: string;
  primary_subject_type: string;
}

export interface AtomicOperationPlan {
  businessStatements: D1PreparedStatement[];
  committedAt: number;
  /** Return true only after authoritative readback proves a business guard rejected the batch. */
  confirmBusinessRejection: () => Promise<boolean>;
  expectedEventCount: number;
  operationId: string;
  primarySubjectId: string;
  primarySubjectType: string;
  requireIdempotencySnapshot?: boolean;
}

export interface AtomicOperationResult {
  commit: OperationCommit;
  recovered: boolean;
}

export class AtomicBatchRejectedError extends Error {
  constructor() {
    super("The atomic operation did not satisfy its final guard.");
    this.name = "AtomicBatchRejectedError";
  }
}

const opaqueLookupSql = {
  credential: "SELECT id FROM credentials WHERE id = ?1",
  principal: "SELECT id FROM principals WHERE id = ?1",
} as const;

export type OpaqueLookupKind = keyof typeof opaqueLookupSql;

export function resolveSqlFragment<T extends string>(key: string, allowlist: Readonly<Record<T, string>>): string {
  if (!Object.hasOwn(allowlist, key)) throw validationError("unsupported_query_option");
  return allowlist[key as T];
}

export async function lookupOpaqueResourceId(
  db: D1Database,
  kind: OpaqueLookupKind,
  untrustedId: string,
): Promise<string | null> {
  const sql = resolveSqlFragment(kind, opaqueLookupSql);
  try {
    const row = await db.prepare(sql).bind(untrustedId).first<{ id: string }>();
    return row?.id ?? null;
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

export function requireDiscoverable<T>(resource: T | null, canDiscover: boolean): T {
  if (resource === null || !canDiscover) throw notFound();
  return resource;
}

function mapCommit(row: OperationCommitRow): OperationCommit {
  return {
    committedAt: row.committed_at,
    lastEventSequence: row.last_event_sequence,
    operationId: row.operation_id,
    primarySubjectId: row.primary_subject_id,
    primarySubjectType: row.primary_subject_type,
  };
}

export async function probeOperationCommit(
  db: D1Database,
  operationId: string,
): Promise<OperationCommit | null> {
  try {
    const row = await db.prepare(
      `SELECT operation_id, primary_subject_type, primary_subject_id,
              last_event_sequence, committed_at
       FROM operation_commits
       WHERE operation_id = ?1
       LIMIT 1`,
    ).bind(operationId).first<OperationCommitRow>();
    return row === null ? null : mapCommit(row);
  } catch (error) {
    throw platformUnavailable("d1", error);
  }
}

export async function executeAtomicBatch(
  db: D1Database,
  plan: AtomicOperationPlan,
): Promise<AtomicOperationResult> {
  if (
    !isUuid(plan.operationId)
    || plan.businessStatements.length === 0
    || typeof plan.confirmBusinessRejection !== "function"
  ) {
    throw validationError("invalid_atomic_operation_plan");
  }
  if (!Number.isSafeInteger(plan.expectedEventCount) || plan.expectedEventCount < 1) {
    throw validationError("invalid_atomic_event_count");
  }

  const sentinel = db.prepare(
    `INSERT INTO operation_commits
      (operation_id, primary_subject_type, primary_subject_id, last_event_sequence, committed_at)
     VALUES (?1, ?2, ?3, (
       SELECT CASE WHEN COUNT(*) = ?4 AND (
         ?6 = 0 OR EXISTS (
           SELECT 1 FROM idempotency_records snapshot_record
           WHERE snapshot_record.operation_id = ?1
             AND snapshot_record.state = 'pending'
             AND snapshot_record.operation_snapshot_json IS NOT NULL
         )
       ) THEN MAX(sequence) END
       FROM events
       WHERE operation_id = ?1
     ), ?5)`,
  ).bind(
    plan.operationId,
    plan.primarySubjectType,
    plan.primarySubjectId,
    plan.expectedEventCount,
    plan.committedAt,
    plan.requireIdempotencySnapshot ? 1 : 0,
  );

  try {
    await db.batch([...plan.businessStatements, sentinel]);
  } catch (error) {
    const recovered = await probeOperationCommit(db, plan.operationId);
    if (recovered !== null) return { commit: recovered, recovered: true };

    let businessRejected: boolean;
    try {
      businessRejected = await plan.confirmBusinessRejection();
    } catch (error) {
      throw platformUnavailable("d1", error);
    }
    if (businessRejected) throw new AtomicBatchRejectedError();
    throw platformUnavailable("d1", error);
  }

  const commit = await probeOperationCommit(db, plan.operationId);
  if (commit === null) throw new AtomicBatchRejectedError();
  return { commit, recovered: false };
}
