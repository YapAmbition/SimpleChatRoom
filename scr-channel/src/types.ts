/**
 * Type definitions for the SimpleChatRoom channel plugin.
 *
 * These types model the SCR message format, plugin configuration,
 * and the resolved account state used throughout the plugin.
 */

// ---------------------------------------------------------------------------
// SimpleChatRoom message types (matches SCR server's message format)
// ---------------------------------------------------------------------------

export interface ScrFileAttachment {
  url: string;
  name: string;
  size: number;
  mimetype: string;
  isSticker?: boolean;
}

export interface ScrMessage {
  id: string;
  user: string;
  ts: string;       // ISO 8601
  room: string;
  text: string;
  type?: "file";
  file?: ScrFileAttachment;
}

// ---------------------------------------------------------------------------
// Plugin configuration (maps to openclaw.json channels.scr)
// ---------------------------------------------------------------------------

export interface ScrAccountConfig {
  serverUrl: string;
  room: string;
  botName: string;
  roomPassword?: string;
  requireMention: boolean;
  mentionPatterns?: string[];
  batchDebounceMs: number;
  batchMaxWaitMs: number;
  responsePrefix?: string;
}

export interface ScrChannelConfig extends Partial<ScrAccountConfig> {
  enabled?: boolean;
  accounts?: Record<string, Partial<ScrAccountConfig>>;
  defaultAccount?: string;
}

// ---------------------------------------------------------------------------
// Resolved account (ready for use by monitor/send)
// ---------------------------------------------------------------------------

export interface ResolvedScrAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  serverUrl: string;
  room: string;
  botName: string;
  roomPassword?: string;
  requireMention: boolean;
  mentionPatterns: string[];
  batchDebounceMs: number;
  batchMaxWaitMs: number;
  responsePrefix: string;
}

// ---------------------------------------------------------------------------
// HTTP API response types (from SimpleChatRoom server)
// ---------------------------------------------------------------------------

export interface ScrLoginResponse {
  ok: boolean;
  token?: string;
  room?: string;
  roomName?: string;
  user?: string;
  error?: string;
}

export interface ScrSendResponse {
  ok: boolean;
  message?: ScrMessage;
  error?: string;
}

export interface ScrMessagesResponse {
  ok: boolean;
  count?: number;
  messages?: ScrMessage[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

export interface ScrSession {
  token: string;
  roomId: string;
  roomName: string;
  user: string;
  serverUrl: string;
}

export interface ScrMonitorOptions {
  account: ResolvedScrAccount;
  onMessage: (msg: ScrMessage) => void;
  onStatusChange?: (status: ScrConnectionStatus) => void;
  abortSignal?: AbortSignal;
}

export type ScrConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "auth_failed";

// ---------------------------------------------------------------------------
// Batched context passed to inbound handler
// ---------------------------------------------------------------------------

export interface BatchedContext {
  messages: ScrMessage[];
  roomId: string;
  timeSpan: {
    from: string;
    to: string;
  };
}
