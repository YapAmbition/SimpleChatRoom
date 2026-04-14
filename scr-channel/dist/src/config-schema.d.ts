/**
 * Configuration validation and defaults for the SCR channel plugin.
 *
 * Since we don't depend on Zod (to keep the plugin lightweight),
 * we implement validation manually with clear error messages.
 */
import type { ScrAccountConfig, ScrChannelConfig } from "./types.js";
/**
 * Validate and merge a partial config with defaults.
 * Throws on missing required fields.
 */
export declare function validateAccountConfig(raw: Partial<ScrAccountConfig>, accountId: string): ScrAccountConfig;
/**
 * Extract the channel config from a full OpenClaw config object.
 * Handles both the flat config shape and the nested accounts shape.
 */
export declare function extractChannelConfig(fullConfig: Record<string, unknown>): ScrChannelConfig | null;
//# sourceMappingURL=config-schema.d.ts.map