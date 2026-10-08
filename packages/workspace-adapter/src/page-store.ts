/**
 * Nexora Page Store
 * 
 * Reuses OpenDots document page storage architecture (repos/opendots/src/server/pages.ts, MIT).
 * Implements optimistic concurrency control (revision checks) to prevent silent overwrite.
 */

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

export interface Page {
  id: string;
  spaceId: string;
  ownerId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceRunId: string | null;
}

export interface Space {
  id: string;
  ownerId: string;
  name: string;
  createdAt: number;
}

export class PageConflictError extends Error {
  readonly status = 409;
  readonly draftRecoverable = true;
  readonly currentRevision: number;
  readonly expectedRevision: number;

  constructor(pageId: string, expectedRevision: number, currentRevision: number) {
    super(`Conflict on page ${pageId}: expected revision ${expectedRevision}, but current revision is ${currentRevision}. Draft is recoverable.`);
    this.name = "PageConflictError";
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

export class UnauthorizedAccessError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedAccessError";
  }
}

export class PageStore {
  readonly db: DatabaseSync;

  constructor(dbOrPath: DatabaseSync | string = ":memory:") {
    if (typeof dbOrPath === "string") {
      this.db = new DatabaseSync(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
    this.init();
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        ownerId TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(ownerId);

      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        spaceId TEXT NOT NULL,
        ownerId TEXT NOT NULL,
        parentId TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL,
        createdAt REAL NOT NULL,
        updatedAt REAL NOT NULL,
        sourceRunId TEXT,
        FOREIGN KEY (spaceId) REFERENCES spaces(id)
      );

      CREATE INDEX IF NOT EXISTS idx_pages_space ON pages(spaceId);
      CREATE INDEX IF NOT EXISTS idx_pages_owner ON pages(ownerId);
    `);
  }

  createSpace(ownerId: string, name: string): Space {
    const id = `space_${randomBytes(12).toString("hex")}`;
    const space: Space = {
      id,
      ownerId,
      name,
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO spaces (id, ownerId, name, createdAt)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(space.id, space.ownerId, space.name, space.createdAt);
    return space;
  }

  getSpace(id: string): Space | null {
    const stmt = this.db.prepare(`SELECT * FROM spaces WHERE id = ?`);
    const row = stmt.get(id) as Space | undefined;
    return row ?? null;
  }

  createPage(input: {
    spaceId: string;
    ownerId: string;
    title: string;
    content?: string;
    parentId?: string | null;
    sourceRunId?: string | null;
  }): Page {
    const space = this.getSpace(input.spaceId);
    if (!space) throw new Error(`Space ${input.spaceId} not found`);
    if (space.ownerId !== input.ownerId) {
      throw new UnauthorizedAccessError(`User ${input.ownerId} is not authorized to create pages in space ${input.spaceId}`);
    }

    const id = `page_${randomBytes(12).toString("hex")}`;
    const now = Date.now();
    const page: Page = {
      id,
      spaceId: input.spaceId,
      ownerId: input.ownerId,
      parentId: input.parentId ?? null,
      title: input.title,
      content: input.content ?? "",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      sourceRunId: input.sourceRunId ?? null,
    };

    const stmt = this.db.prepare(`
      INSERT INTO pages (id, spaceId, ownerId, parentId, title, content, revision, createdAt, updatedAt, sourceRunId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      page.id,
      page.spaceId,
      page.ownerId,
      page.parentId,
      page.title,
      page.content,
      page.revision,
      page.createdAt,
      page.updatedAt,
      page.sourceRunId
    );

    return page;
  }

  getPage(id: string, requesterOwnerId?: string): Page | null {
    const stmt = this.db.prepare(`SELECT * FROM pages WHERE id = ?`);
    const row = stmt.get(id) as Page | undefined;
    if (!row) return null;

    if (requesterOwnerId && row.ownerId !== requesterOwnerId) {
      throw new UnauthorizedAccessError(`User ${requesterOwnerId} is not authorized to access page ${id}`);
    }

    return row;
  }

  listPagesInSpace(spaceId: string, requesterOwnerId?: string): Page[] {
    const space = this.getSpace(spaceId);
    if (!space) return [];
    if (requesterOwnerId && space.ownerId !== requesterOwnerId) {
      throw new UnauthorizedAccessError(`User ${requesterOwnerId} is not authorized to access space ${spaceId}`);
    }

    const stmt = this.db.prepare(`SELECT * FROM pages WHERE spaceId = ? ORDER BY updatedAt DESC`);
    return (stmt.all(spaceId) as Page[]) ?? [];
  }

  updatePage(input: {
    id: string;
    ownerId: string;
    expectedRevision: number;
    title?: string;
    content?: string;
    parentId?: string | null;
  }): Page {
    const page = this.getPage(input.id, input.ownerId);
    if (!page) throw new Error(`Page ${input.id} not found`);

    // Strict optimistic revision check
    if (page.revision !== input.expectedRevision) {
      throw new PageConflictError(input.id, input.expectedRevision, page.revision);
    }

    const nextRevision = page.revision + 1;
    const now = Date.now();
    const updatedTitle = input.title ?? page.title;
    const updatedContent = input.content ?? page.content;
    const updatedParentId = input.parentId !== undefined ? input.parentId : page.parentId;

    const stmt = this.db.prepare(`
      UPDATE pages
      SET title = ?, content = ?, parentId = ?, revision = ?, updatedAt = ?
      WHERE id = ? AND revision = ?
    `);
    const result = stmt.run(
      updatedTitle,
      updatedContent,
      updatedParentId,
      nextRevision,
      now,
      page.id,
      page.revision
    );

    if (result.changes === 0) {
      throw new PageConflictError(input.id, input.expectedRevision, page.revision);
    }

    return {
      ...page,
      title: updatedTitle,
      content: updatedContent,
      parentId: updatedParentId,
      revision: nextRevision,
      updatedAt: now,
    };
  }

  close(): void {
    this.db.close();
  }
}
