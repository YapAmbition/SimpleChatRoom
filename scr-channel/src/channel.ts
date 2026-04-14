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

import type { ResolvedScrAccount, ScrChannelConfig, ScrMessage } from "./types.js";
import {
  listScrAccountIds,
  resolveDefaultScrAccountId,
  resolveScrAccount,
} from "./accounts.js";
import { extractChannelConfig } from "./config-schema.js";
import { startMonitor } from "./monitor.js";
import { MessageBatcher } from "./batcher.js";
import { handleBatchedInbound, setAgentDispatcher } from "./inbound.js";
import { sendMessageScr, scrLogin, clearSession } from "./send.js";
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
  id: "scr" as const,

  meta: {
    id: "scr",
    label: "SimpleChatRoom",
    selectionLabel: "SimpleChatRoom",
    description: "Chat via SimpleChatRoom web interface",
    icon: "💬",
  },

  capabilities: {
    chatTypes: ["group"] as const,
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
    listAccountIds(cfg: Record<string, unknown>): string[] {
      const channelCfg = extractChannelConfig(cfg);
      if (!channelCfg) return [];
      return listScrAccountIds(channelCfg);
    },

    resolveAccount(params: {
      cfg: Record<string, unknown>;
      accountId: string;
    }): ResolvedScrAccount {
      const channelCfg = extractChannelConfig(params.cfg);
      if (!channelCfg) {
        throw new Error("No channels.scr configuration found");
      }
      return resolveScrAccount(channelCfg, params.accountId);
    },

    defaultAccountId(cfg: Record<string, unknown>): string | undefined {
      const channelCfg = extractChannelConfig(cfg);
      if (!channelCfg) return undefined;
      return resolveDefaultScrAccountId(channelCfg);
    },

    isConfigured(account: ResolvedScrAccount): boolean {
      return account.configured;
    },

    describeAccount(account: ResolvedScrAccount): string {
      return `${account.botName} @ ${account.serverUrl} / ${account.room}`;
    },
  },

  // -----------------------------------------------------------------------
  // Outbound (agent → SimpleChatRoom)
  // -----------------------------------------------------------------------

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 2000,

    async sendText(params: {
      to: string;
      text: string;
      accountId: string;
      cfg: Record<string, unknown>;
    }): Promise<{ messageId: string; target: string }> {
      const channelCfg = extractChannelConfig(params.cfg);
      if (!channelCfg) throw new Error("No channels.scr config");
      const account = resolveScrAccount(channelCfg, params.accountId);
      return sendMessageScr(params.text, account);
    },
  },

  // -----------------------------------------------------------------------
  // Gateway lifecycle (start/stop Socket.IO monitor + batcher)
  // -----------------------------------------------------------------------

  gateway: {
    async startAccount(ctx: {
      account: ResolvedScrAccount;
      cfg: Record<string, unknown>;
      runtime: unknown;
      abortSignal?: AbortSignal;
      setStatus?: (patch: Record<string, unknown>) => void;
      // OpenClaw SDK provides core API for agent dispatch
      core?: {
        channel?: {
          reply?: {
            dispatchReplyWithBufferedBlockDispatcher?: (
              params: Record<string, unknown>
            ) => Promise<string | null>;
            formatAgentEnvelope?: (params: Record<string, unknown>) => string;
            finalizeInboundContext?: (params: Record<string, unknown>) => Record<string, unknown>;
          };
        };
      };
    }): Promise<{ stop: () => void }> {
      const log = getLogger();
      const account = ctx.account;

      log.info(
        `[channel] starting account "${account.accountId}": ` +
          `${account.botName} @ ${account.serverUrl} / ${account.room}`
      );

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
      const batcher = new MessageBatcher(
        account.batchDebounceMs,
        account.batchMaxWaitMs,
        async (messages: ScrMessage[]) => {
          await handleBatchedInbound(messages, account);
        }
      );

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
    async probeAccount(params: {
      account: ResolvedScrAccount;
    }): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
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
      } catch (err) {
        return {
          ok: false,
          error: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
          latencyMs: Date.now() - start,
        };
      }
    },
  },
};

export type ScrPlugin = typeof scrPlugin;
