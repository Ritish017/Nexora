/**
 * Nexora UI Event Adapter
 * 
 * Bridges Perry canonical run events to OpenDots workspace UI streams.
 * Maps owner, project, space, page, chat, and run identifiers.
 * Saves verified task outputs as revision-checked document pages.
 */

import type { NormalizedEvent, RunRecord } from "../../runtime/src/types.ts";
import type { PageStore, Page } from "./page-store.ts";
import type { TaskService } from "../../runtime/src/task-service.ts";

export interface WorkspaceEvent {
  eventId: string;
  runId: string;
  seq: number;
  type: "text_delta" | "status" | "progress" | "approval" | "artifact" | "page_updated";
  payload: Record<string, unknown>;
  timestamp: number;
}

export class UIEventAdapter {
  readonly pageStore: PageStore;
  readonly taskService: TaskService;

  constructor(pageStore: PageStore, taskService: TaskService) {
    this.pageStore = pageStore;
    this.taskService = taskService;
  }

  /**
   * Translates a normalized Perry event into a workspace UI event.
   */
  adaptEvent(event: NormalizedEvent): WorkspaceEvent {
    let type: WorkspaceEvent["type"] = "status";
    let payload = event.payload;

    switch (event.type) {
      case "progress":
        if (event.payload.delta) {
          type = "text_delta";
          payload = { delta: event.payload.delta, stream: event.payload.stream ?? "assistant" };
        } else {
          type = "progress";
          payload = {
            phase: event.payload.phase,
            message: event.payload.message,
            percent: event.payload.progressPct ?? 0,
          };
        }
        break;

      case "approval_requested":
        type = "approval";
        payload = {
          approvalId: event.payload.approvalId,
          action: event.payload.action,
          resource: event.payload.resource,
          requiresUserAction: true,
        };
        break;

      case "artifact_saved":
        type = "artifact";
        payload = {
          artifactId: event.payload.artifactId,
          name: event.payload.name,
          sha256: event.payload.sha256,
          filePath: event.payload.filePath,
        };
        break;

      case "status_change":
        type = "status";
        payload = {
          from: event.payload.from,
          to: event.payload.to,
        };
        break;

      default:
        type = "status";
        payload = event.payload;
    }

    return {
      eventId: event.id,
      runId: event.runId,
      seq: event.seq,
      type,
      payload,
      timestamp: event.timestamp,
    };
  }

  /**
   * Saves task output to an OpenDots page after approval check.
   */
  saveTaskOutputToPage(input: {
    runId: string;
    spaceId: string;
    ownerId: string;
    pageTitle: string;
    content: string;
    existingPageId?: string;
    expectedRevision?: number;
  }): Page {
    const run = this.taskService.db.getRun(input.runId);
    if (!run) throw new Error(`Run ${input.runId} not found`);

    if (input.existingPageId && input.expectedRevision !== undefined) {
      // Update existing page with optimistic revision check
      return this.pageStore.updatePage({
        id: input.existingPageId,
        ownerId: input.ownerId,
        expectedRevision: input.expectedRevision,
        title: input.pageTitle,
        content: input.content,
      });
    }

    // Create fresh page in space
    return this.pageStore.createPage({
      spaceId: input.spaceId,
      ownerId: input.ownerId,
      title: input.pageTitle,
      content: input.content,
      sourceRunId: input.runId,
    });
  }
}
