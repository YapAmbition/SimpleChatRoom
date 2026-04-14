/**
 * Account resolution — merges base channel config with per-account overrides
 * and environment variable fallbacks.
 */
import type { ResolvedScrAccount, ScrChannelConfig } from "./types.js";
/**
 * List all configured account IDs.
 */
export declare function listScrAccountIds(cfg: ScrChannelConfig): string[];
/**
 * Get the default account ID.
 */
export declare function resolveDefaultScrAccountId(cfg: ScrChannelConfig): string | undefined;
/**
 * Resolve a single account by merging: env vars → base config → account override.
 */
export declare function resolveScrAccount(cfg: ScrChannelConfig, accountId: string): ResolvedScrAccount;
//# sourceMappingURL=accounts.d.ts.map