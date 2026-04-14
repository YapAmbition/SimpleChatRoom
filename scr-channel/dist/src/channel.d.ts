/**
 * ChannelPlugin definition — wires together all SCR channel components.
 *
 * This is the central object that OpenClaw's gateway uses to:
 * - Discover and configure the channel
 * - Start/stop the Socket.IO connection (gateway lifecycle)
 * - Deliver outbound messages (agent → SimpleChatRoom)
 * - Probe connectivity status
 *
 * The plugin follows the OpenClaw ChannelPlugin interface pattern
 * as documented in the SDK and exemplified by built-in channel plugins.
 */
import type { ResolvedScrAccount } from "./types.js";
/**
 * The SCR channel plugin definition.
 *
 * Type is kept loose (Record-based) to avoid hard dependency on OpenClaw SDK
 * types which may not be available at compile time outside the OpenClaw monorepo.
 * The runtime will duck-type validate against ChannelPlugin<T, P>.
 */
export declare const scrPlugin: {
    id: "scr";
    meta: {
        id: string;
        label: string;
        selectionLabel: string;
        description: string;
        icon: string;
    };
    capabilities: {
        chatTypes: readonly ["group"];
        media: boolean;
        blockStreaming: boolean;
    };
    reload: {
        configPrefixes: string[];
    };
    config: {
        listAccountIds(cfg: Record<string, unknown>): string[];
        resolveAccount(params: {
            cfg: Record<string, unknown>;
            accountId: string;
        }): ResolvedScrAccount;
        defaultAccountId(cfg: Record<string, unknown>): string | undefined;
        isConfigured(account: ResolvedScrAccount): boolean;
        describeAccount(account: ResolvedScrAccount): string;
    };
    outbound: {
        deliveryMode: "direct";
        textChunkLimit: number;
        sendText(params: {
            to: string;
            text: string;
            accountId: string;
            cfg: Record<string, unknown>;
        }): Promise<{
            messageId: string;
            target: string;
        }>;
    };
    gateway: {
        startAccount(ctx: {
            account: ResolvedScrAccount;
            cfg: Record<string, unknown>;
            runtime: unknown;
            abortSignal?: AbortSignal;
            setStatus?: (patch: Record<string, unknown>) => void;
            core?: {
                channel?: {
                    reply?: {
                        dispatchReplyWithBufferedBlockDispatcher?: (params: Record<string, unknown>) => Promise<string | null>;
                        formatAgentEnvelope?: (params: Record<string, unknown>) => string;
                        finalizeInboundContext?: (params: Record<string, unknown>) => Record<string, unknown>;
                    };
                };
            };
        }): Promise<{
            stop: () => void;
        }>;
    };
    status: {
        probeAccount(params: {
            account: ResolvedScrAccount;
        }): Promise<{
            ok: boolean;
            latencyMs?: number;
            error?: string;
        }>;
    };
};
export type ScrPlugin = typeof scrPlugin;
//# sourceMappingURL=channel.d.ts.map