/**
 * Nexora SQLite Storage Engine
 * 
 * Reuses the document storage architecture of Perry (repos/perry/server/db.ts, MIT).
 * Utilizes Node 24 native DatabaseSync from node:sqlite with WAL mode.
 */

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type {
  TaskRecord,
  RunRecord,
  NormalizedEvent,
  ApprovalRecord,
  ArtifactRecord
} from "./types.ts";

export function generateId(prefix: string): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(16);
  let id = "";
  for (const byte of bytes) id += alphabet[byte % 32];
  return `${prefix}_${id}`;
}

export class NexoraDatabase {
  readonly db: DatabaseSync;

  constructor(dbPath: string = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        projectId TEXT NOT NULL,
        idempotencyKey TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL,
        createdAt REAL NOT NULL,
        updatedAt REAL NOT NULL,
        doc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_owner_project ON tasks (ownerId, projectId);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        status TEXT NOT NULL,
        claimedBy TEXT,
        leaseExpiresAt REAL,
        startedAt REAL NOT NULL,
        doc TEXT NOT NULL,
        FOREIGN KEY (taskId) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (taskId);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
      CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs (claimedBy, leaseExpiresAt);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp REAL NOT NULL,
        doc TEXT NOT NULL,
        UNIQUE(runId, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events (runId, seq);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        status TEXT NOT NULL,
        expiry REAL NOT NULL,
        doc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals (runId);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        taskId TEXT NOT NULL,
        name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        createdAt REAL NOT NULL,
        doc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (runId);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts (taskId);
    `);
  }

  // --- Task Methods ---

  insertTask(task: TaskRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, ownerId, projectId, idempotencyKey, status, createdAt, updatedAt, doc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      task.id,
      task.ownerId,
      task.projectId,
      task.idempotencyKey,
      task.status,
      task.createdAt,
      task.updatedAt,
      JSON.stringify(task)
    );
  }

  getTask(id: string): TaskRecord | null {
    const stmt = this.db.prepare(`SELECT doc FROM tasks WHERE id = ?`);
    const row = stmt.get(id) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) : null;
  }

  getTaskByIdempotencyKey(key: string): TaskRecord | null {
    const stmt = this.db.prepare(`SELECT doc FROM tasks WHERE idempotencyKey = ?`);
    const row = stmt.get(key) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) : null;
  }

  updateTask(task: TaskRecord): void {
    task.updatedAt = Date.now();
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET status = ?, updatedAt = ?, doc = ?
      WHERE id = ?
    `);
    stmt.run(task.status, task.updatedAt, JSON.stringify(task), task.id);
  }

  listQueuedTasks(): TaskRecord[] {
    const stmt = this.db.prepare(`SELECT doc FROM tasks WHERE status = 'queued' ORDER BY createdAt ASC`);
    const rows = stmt.all() as Array<{ doc: string }>;
    return rows.map((r) => JSON.parse(r.doc));
  }

  // --- Run Methods ---

  insertRun(run: RunRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, taskId, status, claimedBy, leaseExpiresAt, startedAt, doc)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.id,
      run.taskId,
      run.status,
      run.claimedBy ?? null,
      run.leaseExpiresAt ?? null,
      run.startedAt,
      JSON.stringify(run)
    );
  }

  getRun(id: string): RunRecord | null {
    const stmt = this.db.prepare(`SELECT doc FROM runs WHERE id = ?`);
    const row = stmt.get(id) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) : null;
  }

  updateRun(run: RunRecord): void {
    const stmt = this.db.prepare(`
      UPDATE runs 
      SET status = ?, claimedBy = ?, leaseExpiresAt = ?, doc = ?
      WHERE id = ?
    `);
    stmt.run(run.status, run.claimedBy ?? null, run.leaseExpiresAt ?? null, JSON.stringify(run), run.id);
  }

  listActiveRuns(): RunRecord[] {
    const stmt = this.db.prepare(`
      SELECT doc FROM runs WHERE status IN ('running', 'waiting_for_approval', 'uncertain_effect')
    `);
    const rows = stmt.all() as Array<{ doc: string }>;
    return rows.map((r) => JSON.parse(r.doc));
  }

  // --- Event Methods ---

  appendEvent(event: NormalizedEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO events (id, runId, seq, type, timestamp, doc)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(event.id, event.runId, event.seq, event.type, event.timestamp, JSON.stringify(event));
  }

  getEvents(runId: string): NormalizedEvent[] {
    const stmt = this.db.prepare(`
      SELECT doc FROM events WHERE runId = ? ORDER BY seq ASC
    `);
    const rows = stmt.all(runId) as Array<{ doc: string }>;
    return rows.map((r) => JSON.parse(r.doc));
  }

  getNextEventSeq(runId: string): number {
    const stmt = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM events WHERE runId = ?
    `);
    const row = stmt.get(runId) as { nextSeq: number };
    return row.nextSeq;
  }

  // --- Approval Methods ---

  insertApproval(approval: ApprovalRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO approvals (id, runId, status, expiry, doc)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(approval.id, approval.runId, approval.status, approval.expiry, JSON.stringify(approval));
  }

  getApproval(id: string): ApprovalRecord | null {
    const stmt = this.db.prepare(`SELECT doc FROM approvals WHERE id = ?`);
    const row = stmt.get(id) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) : null;
  }

  updateApproval(approval: ApprovalRecord): void {
    const stmt = this.db.prepare(`
      UPDATE approvals SET status = ?, doc = ? WHERE id = ?
    `);
    stmt.run(approval.status, JSON.stringify(approval), approval.id);
  }

  // --- Artifact Methods ---

  insertArtifact(artifact: ArtifactRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO artifacts (id, runId, taskId, name, sha256, createdAt, doc)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      artifact.id,
      artifact.runId,
      artifact.taskId,
      artifact.name,
      artifact.sha256,
      artifact.createdAt,
      JSON.stringify(artifact)
    );
  }

  getArtifact(id: string): ArtifactRecord | null {
    const stmt = this.db.prepare(`SELECT doc FROM artifacts WHERE id = ?`);
    const row = stmt.get(id) as { doc: string } | undefined;
    return row ? JSON.parse(row.doc) : null;
  }

  listArtifactsForTask(taskId: string): ArtifactRecord[] {
    const stmt = this.db.prepare(`SELECT doc FROM artifacts WHERE taskId = ? ORDER BY createdAt ASC`);
    const rows = stmt.all(taskId) as Array<{ doc: string }>;
    return rows.map((r) => JSON.parse(r.doc));
  }

  close(): void {
    this.db.close();
  }
}
