/**
 * Account resolution — merges base channel config with per-account overrides
 * and environment variable fallbacks.
 */

import type { ResolvedScrAccount, ScrChannelConfig } from "./types.js";
import { validateAccountConfig } from "./config-schema.js";

const DEFAULT_ACCOUNT_ID = "default";

/**
 * Environment variable fallbacks for the default account.
 */
function envFallbacks(): Partial<Record<string, string>> {
  return {
    serverUrl: process.env.SCR_SERVER_URL,
    room: process.env.SCR_ROOM,
    botName: process.env.SCR_BOT_NAME,
    roomPassword: process.env.SCR_ROOM_PASSWORD,
  };
}

/**
 * List all configured account IDs.
 */
export function listScrAccountIds(cfg: ScrChannelConfig): string[] {
  if (cfg.accounts && Object.keys(cfg.accounts).length > 0) {
    return Object.keys(cfg.accounts);
  }
  // If no explicit accounts but top-level fields are set, treat as "default"
  if (cfg.serverUrl && cfg.room && cfg.botName) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

/**
 * Get the default account ID.
 */
export function resolveDefaultScrAccountId(cfg: ScrChannelConfig): string | undefined {
  if (cfg.defaultAccount) return cfg.defaultAccount;
  const ids = listScrAccountIds(cfg);
  return ids.length > 0 ? ids[0] : undefined;
}

/**
 * Resolve a single account by merging: env vars → base config → account override.
 */
export function resolveScrAccount(
  cfg: ScrChannelConfig,
  accountId: string
): ResolvedScrAccount {
  const env = envFallbacks();

  // Start with env fallbacks
  const base: Record<string, unknown> = {};
  if (env.serverUrl) base.serverUrl = env.serverUrl;
  if (env.room) base.room = env.room;
  if (env.botName) base.botName = env.botName;
  if (env.roomPassword) base.roomPassword = env.roomPassword;

  // Layer top-level config fields
  const topLevel: Record<string, unknown> = { ...cfg };
  delete topLevel.accounts;
  delete topLevel.defaultAccount;
  delete topLevel.enabled;
  for (const [k, v] of Object.entries(topLevel)) {
    if (v !== undefined && v !== null) base[k] = v;
  }

  // Layer account-specific override
  const accountOverride = cfg.accounts?.[accountId];
  if (accountOverride) {
    for (const [k, v] of Object.entries(accountOverride)) {
      if (v !== undefined && v !== null) base[k] = v;
    }
  }

  // Validate and get typed config
  const validated = validateAccountConfig(base as Record<string, unknown>, accountId);

  const isConfigured = !!(validated.serverUrl && validated.room && validated.botName);

  return {
    accountId,
    enabled: cfg.enabled !== false,
    configured: isConfigured,
    serverUrl: validated.serverUrl,
    room: validated.room,
    botName: validated.botName,
    roomPassword: validated.roomPassword,
    requireMention: validated.requireMention,
    mentionPatterns: validated.mentionPatterns ?? [],
    batchDebounceMs: validated.batchDebounceMs,
    batchMaxWaitMs: validated.batchMaxWaitMs,
    responsePrefix: validated.responsePrefix ?? "",
  };
}
