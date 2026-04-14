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
import { listScrAccountIds, resolveDefaultScrAccountId, resolveScrAccount, } from "./accounts.js";
import { extractChannelConfig } from "./config-schema.js";
import { startMonitor } from "./monitor.js";
import { MessageBatcher } from "./batcher.js";
import { handleBatchedInbound, setAgentDispatcher } from "./inbound.js";
import { sendMessageScr, clearSession } from "./send.js";
import { getLogger } from "./runtime.js";
// ---------------------------------------------------------------------------
// ChannelPlugin object
// ---------------------------------------------------------------------------
/**
 * The SCR channel plugin definition.
 *
 * Type is kept loose (Record-based) to avoid hard dependency on OpenClaw SDK
 * types which may not be available at compile time outside the OpenClaw monorepo.
 * The runtime will duck-type validate against ChannelPlugin<T, P>.
 */
export const scrPlugin = {
    id: "scr",
    meta: {
        id: "scr",
        label: "SimpleChatRoom",
        selectionLabel: "SimpleChatRoom",
        description: "Chat via SimpleChatRoom web interface",
        icon: "💬",
    },
    capabilities: {
        chatTypes: ["group"],
        media: false,
        blockStreaming: true,
    },
    reload: {
        configPrefixes: ["channels.scr"],
    },
    // -----------------------------------------------------------------------
    // Config adapter
    // -----------------------------------------------------------------------
    config: {
        listAccountIds(cfg) {
            const channelCfg = extractChannelConfig(cfg);
            if (!channelCfg)
                return [];
            return listScrAccountIds(channelCfg);
        },
        resolveAccount(params) {
            const channelCfg = extractChannelConfig(params.cfg);
            if (!channelCfg) {
                throw new Error("No channels.scr configuration found");
            }
            return resolveScrAccount(channelCfg, params.accountId);
        },
        defaultAccountId(cfg) {
            const channelCfg = extractChannelConfig(cfg);
            if (!channelCfg)
                return undefined;
            return resolveDefaultScrAccountId(channelCfg);
        },
        isConfigured(account) {
            return account.configured;
        },
        describeAccount(account) {
            return `${account.botName} @ ${account.serverUrl} / ${account.room}`;
        },
    },
    // -----------------------------------------------------------------------
    // Outbound (agent → SimpleChatRoom)
    // -----------------------------------------------------------------------
    outbound: {
        deliveryMode: "direct",
        textChunkLimit: 2000,
        async sendText(params) {
            const channelCfg = extractChannelConfig(params.cfg);
            if (!channelCfg)
                throw new Error("No channels.scr config");
            const account = resolveScrAccount(channelCfg, params.accountId);
            return sendMessageScr(params.text, account);
        },
    },
    // -----------------------------------------------------------------------
    // Gateway lifecycle (start/stop Socket.IO monitor + batcher)
    // -----------------------------------------------------------------------
    gateway: {
        async startAccount(ctx) {
            const log = getLogger();
            const account = ctx.account;
            log.info(`[channel] starting account "${account.accountId}": ` +
                `${account.botName} @ ${account.serverUrl} / ${account.room}`);
            // Set up the agent dispatcher if core API is available
            if (ctx.core?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
                const coreDispatch = ctx.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher;
                setAgentDispatcher(async (params) => {
                    const result = await coreDispatch({
                        body: params.body,
                        sessionKey: params.sessionKey,
                        senderName: params.senderName,
                        chatType: params.chatType,
                        provider: params.provider,
                        surface: "scr",
                        channelId: "scr",
                        accountId: account.accountId,
                    });
                    return typeof result === "string" ? result : null;
                });
            }
            // Create batcher
            const batcher = new MessageBatcher(account.batchDebounceMs, account.batchMaxWaitMs, async (messages) => {
                await handleBatchedInbound(messages, account);
            });
            // Start Socket.IO monitor
            const monitor = await startMonitor({
                account,
                onMessage: (msg) => batcher.push(msg),
                onStatusChange: (status) => {
                    log.info(`[channel] connection status: ${status}`);
                    ctx.setStatus?.({
                        accountId: account.accountId,
                        running: status === "connected",
                        status,
                    });
                },
                abortSignal: ctx.abortSignal,
            });
            return {
                stop: () => {
                    log.info(`[channel] stopping account "${account.accountId}"`);
                    batcher.destroy();
                    monitor.stop();
                    clearSession(account.accountId);
                },
            };
        },
    },
    // -----------------------------------------------------------------------
    // Status / probe
    // -----------------------------------------------------------------------
    status: {
        async probeAccount(params) {
            const { account } = params;
            const start = Date.now();
            try {
                const resp = await fetch(`${account.serverUrl}/rooms`, {
                    method: "GET",
                    signal: AbortSignal.timeout(10000),
                });
                const latencyMs = Date.now() - start;
                if (resp.ok) {
                    return { ok: true, latencyMs };
                }
                return { ok: false, error: `HTTP ${resp.status}`, latencyMs };
            }
            catch (err) {
                return {
                    ok: false,
                    error: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
                    latencyMs: Date.now() - start,
                };
            }
        },
    },
};
//# sourceMappingURL=channel.js.map