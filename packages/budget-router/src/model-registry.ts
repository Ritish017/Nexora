/**
 * Nexora Model Registry
 * 
 * Maintains catalog of model capabilities, protocols, entitlements,
 * and price classifications. Defaults to verified free-tier models.
 */

import type {
  ModelRegistration,
  ModelCapabilities,
  PriceClass,
  EntitlementStatus,
  ModelProtocol,
} from "../../contracts/src/provider.ts";

export const GEMINI_3_8_FLASH: ModelRegistration = {
  id: "gemini-3.8-flash",
  provider: "google",
  displayName: "Gemini 3.8 Flash",
  protocol: "gemini-rest",
  priceClass: "free",
  entitlement: "verified_free",
  capabilities: {
    functionCalling: true,
    structuredOutput: true,
    vision: true,
    thinking: true,
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
  },
  supportedEfforts: ["low", "medium", "high"],
  lastVerifiedAt: Date.now(),
};

export class ModelRegistry {
  private readonly models = new Map<string, ModelRegistration>();

  constructor(initialModels: ModelRegistration[] = [GEMINI_3_8_FLASH]) {
    for (const model of initialModels) {
      this.register(model);
    }
  }

  /**
   * Register or update a model in the catalog.
   */
  register(model: ModelRegistration): void {
    if (!model.id) {
      throw new Error("Model registration requires a valid 'id'");
    }
    this.models.set(model.id, { ...model });
  }

  /**
   * Unregister a model by its identifier.
   */
  unregister(modelId: string): boolean {
    return this.models.delete(modelId);
  }

  /**
   * Retrieve a model registration by identifier.
   */
  get(modelId: string): ModelRegistration | undefined {
    const model = this.models.get(modelId);
    return model ? { ...model } : undefined;
  }

  /**
   * Check whether a model is registered.
   */
  has(modelId: string): boolean {
    return this.models.has(modelId);
  }

  /**
   * List all registered models.
   */
  list(): ModelRegistration[] {
    return Array.from(this.models.values()).map((m) => ({ ...m }));
  }

  /**
   * List only verified free-tier models.
   */
  listFree(): ModelRegistration[] {
    return this.list().filter(
      (m) => m.priceClass === "free" && m.entitlement === "verified_free"
    );
  }

  /**
   * Filter models satisfying minimum required capabilities.
   */
  findCapable(required: Partial<ModelCapabilities>): ModelRegistration[] {
    return this.list().filter((model) => {
      const caps = model.capabilities;
      if (required.functionCalling && !caps.functionCalling) return false;
      if (required.structuredOutput && !caps.structuredOutput) return false;
      if (required.vision && !caps.vision) return false;
      if (required.thinking && !caps.thinking) return false;
      if (required.maxInputTokens && caps.maxInputTokens < required.maxInputTokens) return false;
      if (required.maxOutputTokens && caps.maxOutputTokens < required.maxOutputTokens) return false;
      return true;
    });
  }

  /**
   * Create a shallow copy of the registry.
   */
  clone(): ModelRegistry {
    return new ModelRegistry(this.list());
  }
}
