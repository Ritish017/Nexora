/**
 * Nexora Conversation Profile Manager
 * 
 * Supports two selectable conversation profiles:
 * 1. 'local': Backed directly by Perry/Nexora SQLite task/run/event ledger.
 *    Requires zero paid external CopilotKit Intelligence license.
 * 2. 'copilotkit-compat': Upstream-compatible CopilotKit Intelligence profile.
 *    Maintains documented account/license hooks with clear setup status.
 */

export type ConversationProfileType = "local" | "copilotkit-compat";

export interface ProfileMetadata {
  id: ConversationProfileType;
  displayName: string;
  description: string;
  isDefault: boolean;
  requiresCloudLicense: boolean;
  cloudFeaturesAvailable: boolean;
  status: "active" | "setup_required" | "evaluation_mode";
}

export class ProfileManager {
  private activeProfile: ConversationProfileType = "local";

  private readonly profiles: Record<ConversationProfileType, ProfileMetadata> = {
    local: {
      id: "local",
      displayName: "Local Autonomous Profile (Perry Backed)",
      description: "Direct SQLite run ledger, local task queue, streaming events, and governed approvals. Zero cloud fee or external license required.",
      isDefault: true,
      requiresCloudLicense: false,
      cloudFeaturesAvailable: false,
      status: "active",
    },
    "copilotkit-compat": {
      id: "copilotkit-compat",
      displayName: "CopilotKit Intelligence Profile (Upstream Compatible)",
      description: "Upstream-compatible CopilotKit cloud intelligence profile. Requires 30-day evaluation or production CopilotKit license.",
      isDefault: false,
      requiresCloudLicense: true,
      cloudFeaturesAvailable: true,
      status: "setup_required",
    },
  };

  getActiveProfile(): ProfileMetadata {
    return this.profiles[this.activeProfile];
  }

  listProfiles(): ProfileMetadata[] {
    return Object.values(this.profiles);
  }

  selectProfile(profileId: ConversationProfileType): ProfileMetadata {
    if (!this.profiles[profileId]) {
      throw new Error(`Profile '${profileId}' is not recognized. Valid options: 'local' | 'copilotkit-compat'.`);
    }
    this.activeProfile = profileId;
    return this.profiles[profileId];
  }
}
