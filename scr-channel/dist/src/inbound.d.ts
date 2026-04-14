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
/**
 * Check if a message mentions the bot.
 */
declare function isMentioned(msg: ScrMessage, account: ResolvedScrAccount): boolean;
/**
 * Format a batch of messages into a readable context string.
 */
declare function formatBatchContext(messages: ScrMessage[]): string;
/**
 * Format ISO timestamp to HH:MM:SS.
 */
declare function formatTime(ts: string): string;
/**
 * Build a batched context object from messages.
 */
declare function buildBatchedContext(messages: ScrMessage[]): BatchedContext;
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
export declare function setAgentDispatcher(dispatcher: AgentDispatcher): void;
/**
 * Handle a batch of inbound messages.
 * Called by the MessageBatcher's onFlush callback.
 */
export declare function handleBatchedInbound(messages: ScrMessage[], account: ResolvedScrAccount): Promise<void>;
export { isMentioned, formatBatchContext, formatTime, buildBatchedContext };
//# sourceMappingURL=inbound.d.ts.map