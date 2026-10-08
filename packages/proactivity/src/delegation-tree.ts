/**
 * Nexora Bounded Sub-Agent Delegation Manager
 * 
 * Enforces strict delegation depth and recursion limits.
 * Propagates status and cancellation down the child agent hierarchy.
 */

import type { DelegationNode } from "./types.ts";

export class MaxDelegationDepthExceededError extends Error {
  constructor(depth: number, maxDepth: number) {
    super(`Delegation depth limit exceeded: current depth ${depth} exceeds max depth ${maxDepth}`);
    this.name = "MaxDelegationDepthExceededError";
  }
}

export class DelegationManager {
  readonly defaultMaxDepth: number;
  private readonly nodes: Map<string, DelegationNode> = new Map();

  constructor(defaultMaxDepth: number = 3) {
    this.defaultMaxDepth = defaultMaxDepth;
  }

  /**
   * Spawns a child agent under a parent, checking depth limits.
   */
  spawnAgent(params: {
    agentId: string;
    parentId?: string | null;
    taskId: string;
    maxDepth?: number;
  }): DelegationNode {
    const parentId = params.parentId ?? null;
    let depth = 0;

    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (!parent) {
        throw new Error(`Parent agent '${parentId}' not found.`);
      }
      depth = parent.depth + 1;
    }

    const maxDepth = params.maxDepth ?? this.defaultMaxDepth;
    if (depth > maxDepth) {
      throw new MaxDelegationDepthExceededError(depth, maxDepth);
    }

    const node: DelegationNode = {
      agentId: params.agentId,
      parentId,
      depth,
      maxDepth,
      taskId: params.taskId,
      status: "running",
    };

    this.nodes.set(params.agentId, node);
    return node;
  }

  getNode(agentId: string): DelegationNode | undefined {
    return this.nodes.get(agentId);
  }

  /**
   * Returns all direct child agents of a parent.
   */
  getChildren(agentId: string): DelegationNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.parentId === agentId);
  }

  /**
   * Recursively cancels an agent and all descendant agents down the hierarchy.
   */
  cancelAgentHierarchy(agentId: string): string[] {
    const cancelledIds: string[] = [];
    const queue = [agentId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const node = this.nodes.get(currentId);
      if (node && node.status === "running") {
        node.status = "cancelled";
        cancelledIds.push(currentId);
      }

      // Find children
      const children = this.getChildren(currentId);
      for (const child of children) {
        queue.push(child.agentId);
      }
    }

    return cancelledIds;
  }
}
