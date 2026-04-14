/**
 * Type definitions for the SimpleChatRoom channel plugin.
 *
 * These types model the SCR message format, plugin configuration,
 * and the resolved account state used throughout the plugin.
 */
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
    ts: string;
    room: string;
    text: string;
    type?: "file";
    file?: ScrFileAttachment;
}
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
export type ScrConnectionStatus = "connecting" | "connected" | "disconnected" | "error" | "auth_failed";
export interface BatchedContext {
    messages: ScrMessage[];
    roomId: string;
    timeSpan: {
        from: string;
        to: string;
    };
}
//# sourceMappingURL=types.d.ts.map