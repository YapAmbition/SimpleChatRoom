/**
 * Outbound message sender — delivers agent responses back to SimpleChatRoom.
 *
 * Uses the SCR HTTP API (POST /api/send) with Bearer token authentication.
 * Handles token expiry by re-authenticating once before failing.
 */
import type { ResolvedScrAccount, ScrSession } from "./types.js";
/**
 * Perform HTTP login to SimpleChatRoom and store the session.
 */
export declare function scrLogin(account: ResolvedScrAccount): Promise<ScrSession>;
/**
 * Get existing session or create new one.
 */
export declare function getOrCreateSession(account: ResolvedScrAccount): Promise<ScrSession>;
/**
 * Clear stored session for an account (e.g. on auth failure).
 */
export declare function clearSession(accountId: string): void;
/**
 * Send a text message to SimpleChatRoom via HTTP API.
 * Retries once on 401 (token expired) by re-authenticating.
 */
export declare function sendMessageScr(text: string, account: ResolvedScrAccount): Promise<{
    messageId: string;
    target: string;
}>;
//# sourceMappingURL=send.d.ts.map