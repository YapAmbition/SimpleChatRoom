/**
 * Configuration validation and defaults for the SCR channel plugin.
 *
 * Since we don't depend on Zod (to keep the plugin lightweight),
 * we implement validation manually with clear error messages.
 */

import type { ScrAccountConfig, ScrChannelConfig } from "./types.js";

const DEFAULTS: Omit<ScrAccountConfig, "serverUrl" | "room" | "botName"> = {
  requireMention: false,
  mentionPatterns: [],
  batchDebounceMs: 3000,
  batchMaxWaitMs: 10000,
  responsePrefix: "",
};

/**
 * Validate and merge a partial config with defaults.
 * Throws on missing required fields.
 */
export function validateAccountConfig(
  raw: Partial<ScrAccountConfig>,
  accountId: string
): ScrAccountConfig {
  const errors: string[] = [];

  if (!raw.serverUrl || typeof raw.serverUrl !== "string") {
    errors.push(`channels.scr.accounts.${accountId}.serverUrl is required`);
  }
  if (!raw.room || typeof raw.room !== "string") {
    errors.push(`channels.scr.accounts.${accountId}.room is required`);
  }
  if (!raw.botName || typeof raw.botName !== "string") {
    errors.push(`channels.scr.accounts.${accountId}.botName is required`);
  }

  if (errors.length > 0) {
    throw new Error(`SCR channel config validation failed:\n  ${errors.join("\n  ")}`);
  }

  return {
    serverUrl: raw.serverUrl!.replace(/\/+$/, ""),
    room: raw.room!,
    botName: raw.botName!,
    roomPassword: raw.roomPassword,
    requireMention:
      typeof raw.requireMention === "boolean"
        ? raw.requireMention
        : DEFAULTS.requireMention,
    mentionPatterns: Array.isArray(raw.mentionPatterns)
      ? raw.mentionPatterns
      : DEFAULTS.mentionPatterns!,
    batchDebounceMs:
      typeof raw.batchDebounceMs === "number" && raw.batchDebounceMs > 0
        ? raw.batchDebounceMs
        : DEFAULTS.batchDebounceMs,
    batchMaxWaitMs:
      typeof raw.batchMaxWaitMs === "number" && raw.batchMaxWaitMs > 0
        ? raw.batchMaxWaitMs
        : DEFAULTS.batchMaxWaitMs,
    responsePrefix:
      typeof raw.responsePrefix === "string"
        ? raw.responsePrefix
        : DEFAULTS.responsePrefix!,
  };
}

/**
 * Extract the channel config from a full OpenClaw config object.
 * Handles both the flat config shape and the nested accounts shape.
 */
export function extractChannelConfig(fullConfig: Record<string, unknown>): ScrChannelConfig | null {
  const channels = fullConfig.channels as Record<string, unknown> | undefined;
  if (!channels) return null;
  const scr = channels.scr as ScrChannelConfig | undefined;
  return scr ?? null;
}
