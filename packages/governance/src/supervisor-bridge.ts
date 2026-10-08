/**
 * Nexora OpenBot Container Supervisor Bridge
 * 
 * Adapts OpenBot container supervisor lifecycle (pin b6932d31a8d6e7896c15139dfc27a6c6911deb27)
 * - Container namespace & naming: `${namespace}-computer-${dotId}`
 * - Persistent volumes:
 *   - Workspace: `${namespace}-computer-${dotId}-workspace` (persists files across restarts)
 *   - Profile: `${namespace}-computer-${dotId}-profile` (persists browser cookies/logins)
 * - Handles offline / stopped Docker daemon gracefully with structured diagnostics.
 * - Produces HMAC-derived isolated credentials for container tools.
 */

import { deriveComputerToken } from "./credential-derivation.ts";

export interface SupervisorConfig {
  supervisorUrl?: string;
  supervisorToken?: string;
  computerToken?: string;
  namespace?: string;
  transport?: typeof fetch;
}

export interface ContainerState {
  botId: string;
  container: string;
  status: "running" | "stopped" | "failed" | "unavailable";
  port?: number;
  url?: string;
  volumes?: {
    workspace: string;
    profile: string;
  };
  error?: string;
}

export class SupervisorBridge {
  readonly supervisorUrl: string;
  readonly supervisorToken: string;
  readonly computerToken: string;
  readonly namespace: string;
  private readonly transport: typeof fetch;

  constructor(config: SupervisorConfig = {}) {
    this.supervisorUrl = config.supervisorUrl ?? "http://127.0.0.1:4312";
    this.supervisorToken = config.supervisorToken ?? "";
    this.computerToken = config.computerToken ?? "";
    this.namespace = config.namespace ?? "opendots";
    this.transport = config.transport ?? fetch;
  }

  get configured(): boolean {
    return Boolean(
      this.supervisorUrl.trim() &&
      this.supervisorToken.trim() &&
      this.computerToken.trim() &&
      this.computerToken.trim().length >= 24
    );
  }

  /**
   * Returns deterministic container and volume names for a given Dot/Agent.
   */
  getContainerSpec(dotId: string) {
    const containerName = `${this.namespace}-computer-${dotId}`;
    return {
      botId: dotId,
      containerName,
      workspaceVolume: `${containerName}-workspace`,
      profileVolume: `${containerName}-profile`,
    };
  }

  /**
   * Generates HMAC-derived container credential.
   */
  getContainerToken(dotId: string): string {
    if (!this.computerToken || this.computerToken.length < 24) {
      throw new Error("Master COMPUTER_TOKEN must contain at least 24 characters.");
    }
    return deriveComputerToken(this.computerToken, dotId);
  }

  /**
   * Probes container status for a specific dot.
   * If supervisor or Docker daemon is offline, returns status 'unavailable' without throwing.
   */
  async getStatus(dotId: string): Promise<ContainerState> {
    const spec = this.getContainerSpec(dotId);

    if (!this.configured) {
      return {
        botId: dotId,
        container: spec.containerName,
        status: "unavailable",
        error: "Computer service is not configured (missing supervisor or master token).",
        volumes: {
          workspace: spec.workspaceVolume,
          profile: spec.profileVolume,
        },
      };
    }

    try {
      const res = await this.transport(`${this.supervisorUrl.replace(/\/$/, "")}/computers`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.supervisorToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        return {
          botId: dotId,
          container: spec.containerName,
          status: "unavailable",
          error: `Supervisor returned HTTP ${res.status}.`,
        };
      }

      const data = (await res.json()) as { computers?: Array<Record<string, unknown>> };
      const match = data.computers?.find((c) => c.botId === dotId);

      if (!match) {
        return {
          botId: dotId,
          container: spec.containerName,
          status: "stopped",
          volumes: {
            workspace: spec.workspaceVolume,
            profile: spec.profileVolume,
          },
        };
      }

      return {
        botId: dotId,
        container: (match.container as string) ?? spec.containerName,
        status: (match.status as any) ?? "stopped",
        port: match.port as number | undefined,
        url: match.url as string | undefined,
        volumes: {
          workspace: spec.workspaceVolume,
          profile: spec.profileVolume,
        },
      };
    } catch (err: any) {
      return {
        botId: dotId,
        container: spec.containerName,
        status: "unavailable",
        error: `Computer supervisor unreachable (Docker daemon may be stopped): ${err.message ?? err}`,
        volumes: {
          workspace: spec.workspaceVolume,
          profile: spec.profileVolume,
        },
      };
    }
  }

  /**
   * Ensures a computer container is provisioned and running.
   */
  async ensureContainer(dotId: string): Promise<ContainerState> {
    const spec = this.getContainerSpec(dotId);

    if (!this.configured) {
      throw new Error("Cannot ensure container: supervisor or master token not configured.");
    }

    try {
      const res = await this.transport(
        `${this.supervisorUrl.replace(/\/$/, "")}/computers/${encodeURIComponent(dotId)}/ensure`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.supervisorToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      if (!res.ok) {
        throw new Error(`Supervisor returned HTTP ${res.status} on ensure.`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      return {
        botId: dotId,
        container: (data.container as string) ?? spec.containerName,
        status: (data.status as any) ?? "running",
        port: data.port as number | undefined,
        url: data.url as string | undefined,
        volumes: {
          workspace: spec.workspaceVolume,
          profile: spec.profileVolume,
        },
      };
    } catch (err: any) {
      throw new Error(`Failed to ensure container for '${dotId}': ${err.message ?? err}`);
    }
  }

  /**
   * Stops an active computer container while preserving persistent volumes.
   */
  async stopContainer(dotId: string): Promise<void> {
    if (!this.configured) {
      throw new Error("Cannot stop container: supervisor is not configured.");
    }

    const res = await this.transport(
      `${this.supervisorUrl.replace(/\/$/, "")}/computers/${encodeURIComponent(dotId)}/stop`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.supervisorToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }
    );

    if (!res.ok) {
      throw new Error(`Supervisor returned HTTP ${res.status} on stop.`);
    }
  }
}
