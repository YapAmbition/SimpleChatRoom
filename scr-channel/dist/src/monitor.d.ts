/**
 * Socket.IO connection monitor — manages the persistent connection to SimpleChatRoom.
 *
 * Acts as a "bot client" that logs in, joins a room, and listens for messages.
 * Inbound messages (from real users) are forwarded to the batcher.
 * The bot's own messages are filtered out to prevent loops.
 */
import type { ScrMonitorOptions } from "./types.js";
export interface MonitorHandle {
    stop: () => void;
}
/**
 * Start monitoring a SimpleChatRoom server.
 *
 * Connects via Socket.IO, authenticates, joins the configured room,
 * and dispatches inbound messages through the provided callback.
 */
export declare function startMonitor(opts: ScrMonitorOptions): Promise<MonitorHandle>;
//# sourceMappingURL=monitor.d.ts.map