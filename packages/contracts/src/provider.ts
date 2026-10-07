/**
 * Nexora Provider & Model Capabilities Contract
 */

export type ModelProtocol = "gemini-rest" | "gemini-sdk" | "openai-compatible";

export type PriceClass = "free" | "paid" | "unknown";

export type EntitlementStatus = "verified_free" | "paid_active" | "quota_exhausted" | "unverified";

export interface ModelCapabilities {
  functionCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  thinking: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface ModelRegistration {
  id: string; // e.g., 'gemini-3.8-flash'
  provider: string; // e.g., 'google'
  displayName: string;
  protocol: ModelProtocol;
  endpointUrl?: string;
  priceClass: PriceClass;
  entitlement: EntitlementStatus;
  capabilities: ModelCapabilities;
  supportedEfforts?: string[];
  lastVerifiedAt?: number;
}

export interface ProviderConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  allowedPriceClasses: PriceClass[];
}
