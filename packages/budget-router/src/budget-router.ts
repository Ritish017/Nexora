/**
 * Nexora Budget Router
 * 
 * Enforces strict 'free-only' model routing policy.
 * Disallows paid endpoints, unverified entitlements, unknown pricing,
 * paid fallbacks, and credit overages.
 */

import {
  DisallowedPaidEndpointError,
  type RoutingPolicyMode,
} from "../../contracts/src/budget.ts";
import type {
  ModelRegistration,
  ModelCapabilities,
  PriceClass,
} from "../../contracts/src/provider.ts";
import { ModelRegistry, GEMINI_3_8_FLASH } from "./model-registry.ts";

export interface RouteRequest {
  modelId?: string;
  requiredCapabilities?: Partial<ModelCapabilities>;
  allowedModelIds?: string[];
}

export class BudgetRouter {
  public readonly policy: RoutingPolicyMode = "free-only";
  private readonly registry: ModelRegistry;
  private readonly defaultModelId: string;

  constructor(
    registry?: ModelRegistry,
    defaultModelId = GEMINI_3_8_FLASH.id
  ) {
    this.registry = registry ?? new ModelRegistry();
    this.defaultModelId = defaultModelId;
  }

  /**
   * Return the enforced routing policy mode.
   */
  getPolicy(): RoutingPolicyMode {
    return this.policy;
  }

  /**
   * Validate that a model meets the strict free-only requirements:
   * 1. priceClass must be 'free'
   * 2. entitlement must be 'verified_free'
   * Throws DisallowedPaidEndpointError if violated.
   */
  validateModel(model: ModelRegistration): void {
    if (model.priceClass !== "free") {
      throw new DisallowedPaidEndpointError(model.id, model.priceClass);
    }
    if (model.entitlement !== "verified_free") {
      // Rejects non-verified entitlements (e.g. quota_exhausted, unverified, paid_active)
      throw new DisallowedPaidEndpointError(model.id, model.priceClass);
    }
  }

  /**
   * Resolve and validate a model by identifier.
   * If model is not found in registry, its pricing is unknown and rejected.
   */
  resolveModel(modelId?: string): ModelRegistration {
    const targetId = modelId ?? this.defaultModelId;
    const model = this.registry.get(targetId);

    if (!model) {
      // Unknown model -> unknown pricing -> disallowed under free-only policy
      throw new DisallowedPaidEndpointError(targetId, "unknown" as PriceClass);
    }

    this.validateModel(model);
    return model;
  }

  /**
   * Route a request to an eligible verified free model.
   * Zero paid fallback: guarantees that no paid or unverified model is ever selected.
   */
  route(request?: RouteRequest): ModelRegistration {
    if (request?.modelId) {
      return this.resolveModel(request.modelId);
    }

    // Find all verified free models in registry
    let candidates = this.registry.listFree();

    if (request?.allowedModelIds && request.allowedModelIds.length > 0) {
      const allowedSet = new Set(request.allowedModelIds);
      candidates = candidates.filter((m) => allowedSet.has(m.id));
    }

    if (request?.requiredCapabilities) {
      const req = request.requiredCapabilities;
      candidates = candidates.filter((m) => {
        const caps = m.capabilities;
        if (req.functionCalling && !caps.functionCalling) return false;
        if (req.structuredOutput && !caps.structuredOutput) return false;
        if (req.vision && !caps.vision) return false;
        if (req.thinking && !caps.thinking) return false;
        if (req.maxInputTokens && caps.maxInputTokens < req.maxInputTokens) return false;
        if (req.maxOutputTokens && caps.maxOutputTokens < req.maxOutputTokens) return false;
        return true;
      });
    }

    if (candidates.length === 0) {
      throw new Error(
        "Zero free models available: runtime is restricted to free-only routing and zero paid fallback is allowed."
      );
    }

    // Prefer defaultModelId if available among candidates
    const defaultCandidate = candidates.find((m) => m.id === this.defaultModelId);
    return defaultCandidate ?? candidates[0];
  }

  /**
   * Select a fallback model when the primary model fails or encounters rate limits.
   * Enforces zero paid fallback: only alternative verified-free models are allowed.
   */
  fallback(failedModelId: string, alternateModelIds?: string[]): ModelRegistration {
    const candidates = this.registry.listFree().filter((m) => m.id !== failedModelId);

    if (alternateModelIds && alternateModelIds.length > 0) {
      const alternateSet = new Set(alternateModelIds);
      const filtered = candidates.filter((m) => alternateSet.has(m.id));
      if (filtered.length > 0) {
        return filtered[0];
      }
    }

    if (candidates.length > 0) {
      return candidates[0];
    }

    throw new Error(
      `Zero paid fallback violation: no alternative verified free models available to fallback from '${failedModelId}'.`
    );
  }

  /**
   * Get underlying registry.
   */
  getRegistry(): ModelRegistry {
    return this.registry;
  }
}
