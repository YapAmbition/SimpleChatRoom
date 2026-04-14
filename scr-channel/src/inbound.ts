/**
 * Inbound message processing — handles batched messages from the batcher
 * and dispatches them to the OpenClaw agent.
 *
 * This module:
 * 1. Applies mention filtering (if requireMention is enabled)
 * 2. Formats batched messages into a context string for the agent
 * 3. Dispatches to the agent via the OpenClaw plugin core API
 * 4. Routes the agent's response back through outbound.sendText
 */

import type { ScrMessage, ResolvedScrAccount, BatchedContext } from "./types.js";
import { sendMessageScr } from "./send.js";
import { getLogger } from "./runtime.js";

/**
 * Check if a message mentions the bot.
 */
function isMentioned(msg: ScrMessage, account: ResolvedScrAccount): boolean {
  const text = msg.text.toLowerCase();
  const botName = account.botName.toLowerCase();

  // Direct name match
  if (text.includes(botName)) return true;
  if (text.includes(`@${botName}`)) return true;

  // Custom mention patterns
  for (const pattern of account.mentionPatterns) {
    if (text.includes(pattern.toLowerCase())) return true;
  }

  return false;
}

/**
 * Format a batch of messages into a readable context string.
 */
function formatBatchContext(messages: ScrMessage[]): string {
  return messages
    .map((m) => {
      const time = formatTime(m.ts);
      if (m.type === "file" && m.file) {
        return `[${time}] ${m.user}: [file: ${m.file.name}]`;
      }
      return `[${time}] ${m.user}: ${m.text}`;
    })
    .join("\n");
}

/**
 * Format ISO timestamp to HH:MM:SS.
 */
function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8);
  } catch {
    return ts;
  }
}

/**
 * Build a batched context object from messages.
 */
function buildBatchedContext(messages: ScrMessage[]): BatchedContext {
  return {
    messages,
    roomId: messages[0]?.room ?? "unknown",
    timeSpan: {
      from: messages[0]?.ts ?? new Date().toISOString(),
      to: messages[messages.length - 1]?.ts ?? new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// OpenClaw agent dispatch interface
// ---------------------------------------------------------------------------

/**
 * Function type for dispatching messages to the OpenClaw agent.
 * This is injected by the channel plugin wiring (channel.ts).
 *
 * In a full OpenClaw SDK environment, this wraps:
 *   core.channel.reply.dispatchReplyWithBufferedBlockDispatcher(...)
 *
 * For standalone/testing mode, a simpler HTTP-based dispatcher is provided.
 */
export type AgentDispatcher = (params: {
  body: string;
  sessionKey: string;
  senderName: string;
  chatType: "group";
  provider: "scr";
}) => Promise<string | null>;

// The active dispatcher — set by channel.ts during startup
let activeDispatcher: AgentDispatcher | null = null;

export function setAgentDispatcher(dispatcher: AgentDispatcher): void {
  activeDispatcher = dispatcher;
}

/**
 * Handle a batch of inbound messages.
 * Called by the MessageBatcher's onFlush callback.
 */
export async function handleBatchedInbound(
  messages: ScrMessage[],
  account: ResolvedScrAccount
): Promise<void> {
  const log = getLogger();

  if (messages.length === 0) return;

  // Step 1: Mention filtering
  if (account.requireMention) {
    const mentionedMessages = messages.filter((m) => isMentioned(m, account));
    if (mentionedMessages.length === 0) {
      log.debug(
        `[inbound] batch of ${messages.length} messages, none mention bot — skipping`
      );
      return;
    }
    log.debug(
      `[inbound] ${mentionedMessages.length}/${messages.length} messages mention bot`
    );
    // Keep all messages for context but only process if at least one mention exists
  }

  // Step 2: Format context
  const context = formatBatchContext(messages);
  const batchCtx = buildBatchedContext(messages);
  const lastSender = messages[messages.length - 1].user;
  const senderDesc =
    messages.length === 1
      ? lastSender
      : `${new Set(messages.map((m) => m.user)).size} users`;

  log.info(
    `[inbound] processing batch: ${messages.length} msg(s) from ${senderDesc} ` +
      `(${batchCtx.timeSpan.from} → ${batchCtx.timeSpan.to})`
  );

  // Step 3: Dispatch to agent
  const sessionKey = `scr:${account.accountId}:room:${batchCtx.roomId}`;

  if (activeDispatcher) {
    // OpenClaw SDK path
    try {
      const reply = await activeDispatcher({
        body: context,
        sessionKey,
        senderName: senderDesc,
        chatType: "group",
        provider: "scr",
      });

      // Step 4: Send reply back to SimpleChatRoom
      if (reply) {
        await sendMessageScr(reply, account);
        log.info(`[inbound] agent reply sent (${reply.length} chars)`);
      } else {
        log.debug("[inbound] agent returned no reply");
      }
    } catch (err) {
      log.error(`[inbound] agent dispatch failed: ${err}`);
    }
  } else {
    // Standalone/fallback mode — use HTTP API directly
    log.warn("[inbound] no agent dispatcher set, attempting HTTP API fallback");
    try {
      const reply = await dispatchViaHttpApi(context, sessionKey, account);
      if (reply) {
        await sendMessageScr(reply, account);
        log.info(`[inbound] HTTP API reply sent (${reply.length} chars)`);
      }
    } catch (err) {
      log.error(`[inbound] HTTP API dispatch failed: ${err}`);
    }
  }
}

/**
 * Fallback: dispatch to OpenClaw agent via HTTP API.
 * Uses POST /v1/agent/run on the local OpenClaw gateway.
 */
async function dispatchViaHttpApi(
  body: string,
  sessionKey: string,
  account: ResolvedScrAccount
): Promise<string | null> {
  const log = getLogger();
  const gatewayUrl =
    process.env.OPENCLAW_GATEWAY_URL || "http://localhost:18789";
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

  const url = `${gatewayUrl}/v1/agent/run`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (gatewayToken) {
    headers.Authorization = `Bearer ${gatewayToken}`;
  }

  log.debug(`[inbound] dispatching to ${url} with session ${sessionKey}`);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: body,
      sessionKey,
      channel: "scr",
      metadata: {
        accountId: account.accountId,
        room: account.room,
        botName: account.botName,
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Gateway returned ${resp.status}: ${errText}`);
  }

  const data = (await resp.json()) as { reply?: string; text?: string; content?: string };
  return data.reply || data.text || data.content || null;
}

// Re-export for testing
export { isMentioned, formatBatchContext, formatTime, buildBatchedContext };
