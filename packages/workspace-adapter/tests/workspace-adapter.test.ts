/**
 * Nexora Phase 3 Workspace Adapter Test Suite
 * 
 * Verifies:
 * 1. OpenDots revision-checked page store: optimistic concurrency prevents overwrite.
 * 2. Stale page revision is rejected with PageConflictError (draftRecoverable: true).
 * 3. Unauthorized page / space access is rejected with UnauthorizedAccessError.
 * 4. Two selectable conversation profiles: local vs copilotkit-compat.
 * 5. Event adapter translates Perry normalized events into workspace UI streams.
 * 6. Task emits streamed progress, output saved as a page upon approval, surviving restart.
 */

import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NexoraDatabase } from "../../runtime/src/db.ts";
import { TaskService } from "../../runtime/src/task-service.ts";
import {
  PageStore,
  PageConflictError,
  UnauthorizedAccessError,
} from "../src/page-store.ts";
import { ProfileManager } from "../src/profile-manager.ts";
import { UIEventAdapter } from "../src/ui-event-adapter.ts";

test("Phase 3: OpenDots Revision-Checked Page Store", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nexora-pages-"));
  const dbPath = join(tempDir, "pages.db");
  const store = new PageStore(dbPath);

  const space = store.createSpace("owner-alice", "Personal Notes");
  assert.ok(space.id.startsWith("space_"));
  assert.strictEqual(space.name, "Personal Notes");

  await t.test("Creates initial page with revision 1", () => {
    const page = store.createPage({
      spaceId: space.id,
      ownerId: "owner-alice",
      title: "Architecture Design",
      content: "# Nexora Architecture\nInitial thoughts...",
    });

    assert.ok(page.id.startsWith("page_"));
    assert.strictEqual(page.revision, 1);
    assert.strictEqual(page.title, "Architecture Design");
  });

  await t.test("Updates page successfully when expectedRevision matches", () => {
    const pages = store.listPagesInSpace(space.id, "owner-alice");
    const page = pages[0];

    const updated = store.updatePage({
      id: page.id,
      ownerId: "owner-alice",
      expectedRevision: 1,
      content: "# Nexora Architecture\nUpdated content with revision 2.",
    });

    assert.strictEqual(updated.revision, 2);
    assert.ok(updated.content.includes("revision 2"));
  });

  await t.test("Rejects stale revision with PageConflictError and draftRecoverable", () => {
    const pages = store.listPagesInSpace(space.id, "owner-alice");
    const page = pages[0]; // Current revision is 2

    // Client attempts update assuming revision is still 1
    assert.throws(
      () => {
        store.updatePage({
          id: page.id,
          ownerId: "owner-alice",
          expectedRevision: 1, // STALE!
          content: "Stale edit trying to overwrite",
        });
      },
      (err: any) => {
        assert.ok(err instanceof PageConflictError);
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.draftRecoverable, true);
        assert.strictEqual(err.expectedRevision, 1);
        assert.strictEqual(err.currentRevision, 2);
        return true;
      }
    );
  });

  await t.test("Rejects unauthorized access from different user", () => {
    const pages = store.listPagesInSpace(space.id, "owner-alice");
    const page = pages[0];

    assert.throws(
      () => {
        store.getPage(page.id, "owner-eve");
      },
      (err: any) => {
        assert.ok(err instanceof UnauthorizedAccessError);
        assert.strictEqual(err.status, 403);
        return true;
      }
    );

    assert.throws(
      () => {
        store.listPagesInSpace(space.id, "owner-eve");
      },
      (err: any) => {
        assert.ok(err instanceof UnauthorizedAccessError);
        assert.strictEqual(err.status, 403);
        return true;
      }
    );
  });

  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test("Phase 3: Conversation Profiles Configuration", async (t) => {
  const manager = new ProfileManager();

  await t.test("Defaults to local Perry profile with zero cloud dependency", () => {
    const active = manager.getActiveProfile();
    assert.strictEqual(active.id, "local");
    assert.strictEqual(active.requiresCloudLicense, false);
    assert.strictEqual(active.status, "active");
  });

  await t.test("Selectable upstream CopilotKit Intelligence profile", () => {
    const compat = manager.selectProfile("copilotkit-compat");
    assert.strictEqual(compat.id, "copilotkit-compat");
    assert.strictEqual(compat.requiresCloudLicense, true);
    assert.strictEqual(compat.status, "setup_required");

    // Can switch back to local
    const local = manager.selectProfile("local");
    assert.strictEqual(local.id, "local");
  });
});

test("Phase 3: Task Output Saved as Page upon Approval with Streamed Events", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "nexora-workspace-e2e-"));
  const dbPath = join(tempDir, "nexora.db");

  const db = new NexoraDatabase(dbPath);
  const taskService = new TaskService(db);
  const pageStore = new PageStore(db.db);
  const adapter = new UIEventAdapter(pageStore, taskService);

  const space = pageStore.createSpace("owner-1", "Default Space");

  await t.test("Translates Perry normalized events into workspace UI streams", () => {
    const { task } = taskService.submitTask({
      ownerId: "owner-1",
      projectId: "proj-1",
      idempotencyKey: "stream-e2e-task",
      title: "Analysis Task",
      description: "Testing UI event adapter stream",
    });

    const claim = taskService.claimTask("worker-1", 30000, task.id);
    assert.ok(claim);

    // Emit progress event
    const event = taskService.emitEvent(claim.run.id, "progress", {
      delta: "Starting report synthesis...",
      stream: "assistant",
    });

    const uiEvent = adapter.adaptEvent(event);
    assert.strictEqual(uiEvent.type, "text_delta");
    assert.strictEqual(uiEvent.payload.delta, "Starting report synthesis...");
    assert.strictEqual(uiEvent.seq, event.seq);
  });

  await t.test("Saves task output as revision-checked page upon approval", () => {
    const queuedRuns = db.listActiveRuns();
    const run = queuedRuns[0];

    // Request approval to publish report as a page
    const approval = taskService.requestApproval(
      run.id,
      "publish_page",
      { title: "Market Research Report", spaceId: space.id },
      space.id,
      "worker-1"
    );

    assert.strictEqual(approval.status, "pending");

    // Owner approves the action
    const { approval: resolved } = taskService.resolveApproval(approval.id, true, "owner-1");
    assert.strictEqual(resolved.status, "approved");

    // Save task output to page
    const page = adapter.saveTaskOutputToPage({
      runId: run.id,
      spaceId: space.id,
      ownerId: "owner-1",
      pageTitle: "Market Research Report",
      content: "# Market Analysis\nKey findings from execution run.",
    });

    assert.strictEqual(page.revision, 1);
    assert.strictEqual(page.sourceRunId, run.id);

    // Complete run
    taskService.completeRun(run.id, { pageId: page.id });
  });

  await t.test("Refresh preserves history and pages across database restart", () => {
    db.close();

    const dbRecovered = new NexoraDatabase(dbPath);
    const taskServiceRecovered = new TaskService(dbRecovered);
    const pageStoreRecovered = new PageStore(dbRecovered.db);

    const pages = pageStoreRecovered.listPagesInSpace(space.id, "owner-1");
    assert.strictEqual(pages.length, 1);
    assert.strictEqual(pages[0].title, "Market Research Report");
    assert.strictEqual(pages[0].revision, 1);

    const task = taskServiceRecovered.db.getTaskByIdempotencyKey("stream-e2e-task");
    assert.ok(task);
    assert.strictEqual(task.status, "completed");

    const events = taskServiceRecovered.db.getEvents(task.activeRunId!);
    assert.ok(events.length >= 4);

    dbRecovered.close();
  });

  rmSync(tempDir, { recursive: true, force: true });
});
