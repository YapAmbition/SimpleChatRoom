/**
 * Outbound message sender — delivers agent responses back to SimpleChatRoom.
 *
 * Uses the SCR HTTP API (POST /api/send) with Bearer token authentication.
 * Handles token expiry by re-authenticating once before failing.
 */

import type {
  ResolvedScrAccount,
  ScrLoginResponse,
  ScrSendResponse,
  ScrSession,
} from "./types.js";
import { getLogger } from "./runtime.js";

// Active sessions keyed by accountId
const sessions = new Map<string, ScrSession>();

/**
 * Perform HTTP login to SimpleChatRoom and store the session.
 */
export async function scrLogin(account: ResolvedScrAccount): Promise<ScrSession> {
  const log = getLogger();
  const url = `${account.serverUrl}/api/login`;

  const body: Record<string, string> = {
    room: account.room,
    user: account.botName,
  };
  if (account.roomPassword) {
    body.password = account.roomPassword;
  }

  log.info(`[send] logging in to ${account.serverUrl} as "${account.botName}" in room "${account.room}"`);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as ScrLoginResponse;

  if (!data.ok || !data.token) {
    throw new Error(`SCR login failed: ${data.error || resp.statusText}`);
  }

  const session: ScrSession = {
    token: data.token,
    roomId: data.room!,
    roomName: data.roomName!,
    user: data.user!,
    serverUrl: account.serverUrl,
  };

  sessions.set(account.accountId, session);
  log.info(`[send] logged in successfully, room: ${session.roomName} (${session.roomId})`);
  return session;
}

/**
 * Get existing session or create new one.
 */
export async function getOrCreateSession(
  account: ResolvedScrAccount
): Promise<ScrSession> {
  const existing = sessions.get(account.accountId);
  if (existing) return existing;
  return scrLogin(account);
}

/**
 * Clear stored session for an account (e.g. on auth failure).
 */
export function clearSession(accountId: string): void {
  sessions.delete(accountId);
}

/**
 * Send a text message to SimpleChatRoom via HTTP API.
 * Retries once on 401 (token expired) by re-authenticating.
 */
export async function sendMessageScr(
  text: string,
  account: ResolvedScrAccount
): Promise<{ messageId: string; target: string }> {
  const log = getLogger();

  // Apply response prefix
  const fullText = account.responsePrefix
    ? `${account.responsePrefix}${text}`
    : text;

  const doSend = async (session: ScrSession): Promise<ScrSendResponse> => {
    const resp = await fetch(`${session.serverUrl}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ text: fullText }),
    });

    if (resp.status === 401) {
      throw new TokenExpiredError();
    }

    const data = (await resp.json()) as ScrSendResponse;
    if (!data.ok) {
      throw new Error(`SCR send failed: ${data.error || resp.statusText}`);
    }
    return data;
  };

  // First attempt
  let session = await getOrCreateSession(account);
  try {
    const data = await doSend(session);
    log.debug(`[send] message sent: ${data.message?.id}`);
    return {
      messageId: data.message?.id ?? "unknown",
      target: session.roomId,
    };
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      // Re-authenticate and retry once
      log.warn("[send] token expired, re-authenticating...");
      clearSession(account.accountId);
      session = await scrLogin(account);
      const data = await doSend(session);
      log.debug(`[send] message sent after re-auth: ${data.message?.id}`);
      return {
        messageId: data.message?.id ?? "unknown",
        target: session.roomId,
      };
    }
    throw err;
  }
}

class TokenExpiredError extends Error {
  constructor() {
    super("Token expired");
    this.name = "TokenExpiredError";
  }
}
