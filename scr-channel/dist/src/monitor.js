/**
 * Socket.IO connection monitor — manages the persistent connection to SimpleChatRoom.
 *
 * Acts as a "bot client" that logs in, joins a room, and listens for messages.
 * Inbound messages (from real users) are forwarded to the batcher.
 * The bot's own messages are filtered out to prevent loops.
 */
import { io as ioClient } from "socket.io-client";
import { getOrCreateSession } from "./send.js";
import { getLogger } from "./runtime.js";
/**
 * Start monitoring a SimpleChatRoom server.
 *
 * Connects via Socket.IO, authenticates, joins the configured room,
 * and dispatches inbound messages through the provided callback.
 */
export async function startMonitor(opts) {
    const { account, onMessage, onStatusChange, abortSignal } = opts;
    const log = getLogger();
    let stopped = false;
    let socket = null;
    let lastSeenMessageId = null;
    const setStatus = (status) => {
        if (!stopped)
            onStatusChange?.(status);
    };
    // Step 1: HTTP login to get a token for outbound sends
    // (also validates credentials before opening Socket.IO)
    setStatus("connecting");
    try {
        await getOrCreateSession(account);
    }
    catch (err) {
        log.error(`[monitor] HTTP login failed: ${err}`);
        setStatus("auth_failed");
        // Still try Socket.IO — maybe the room doesn't require password for reading
    }
    // Step 2: Create Socket.IO connection
    socket = ioClient(account.serverUrl, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 30000,
        timeout: 20000,
    });
    // Step 3: On connect, authenticate and join room
    const authenticate = () => {
        if (stopped || !socket)
            return;
        log.info("[monitor] Socket.IO connected, authenticating...");
        socket.emit("login", account.botName, (resp) => {
            if (stopped || !socket)
                return;
            if (!resp.ok) {
                // If username is taken, try with suffix
                if (resp.error?.includes("已在线")) {
                    const altName = `${account.botName}-${Date.now().toString(36).slice(-4)}`;
                    log.warn(`[monitor] Username "${account.botName}" is taken, trying "${altName}"`);
                    socket.emit("login", altName, (resp2) => {
                        if (resp2.ok) {
                            joinRoom();
                        }
                        else {
                            log.error(`[monitor] Login failed with alt name: ${resp2.error}`);
                            setStatus("auth_failed");
                        }
                    });
                    return;
                }
                log.error(`[monitor] Socket.IO login failed: ${resp.error}`);
                setStatus("auth_failed");
                return;
            }
            joinRoom();
        });
    };
    const joinRoom = () => {
        if (stopped || !socket)
            return;
        const args = [account.room];
        if (account.roomPassword)
            args.push(account.roomPassword);
        // Callback for join-room
        const onJoined = (resp) => {
            if (stopped)
                return;
            if (!resp.ok) {
                log.error(`[monitor] join-room failed: ${resp.error}`);
                setStatus("error");
                return;
            }
            log.info(`[monitor] joined room: ${resp.name} (${resp.id})`);
            setStatus("connected");
        };
        args.push(onJoined);
        socket.emit("join-room", ...args);
    };
    socket.on("connect", authenticate);
    // Step 4: Listen for messages
    socket.on("message", (msg) => {
        if (stopped)
            return;
        // Echo suppression: ignore bot's own messages
        if (msg.user === account.botName)
            return;
        // Also ignore any variant name we might have logged in with
        if (msg.user.startsWith(account.botName + "-"))
            return;
        // Track last seen for reconnect replay prevention
        lastSeenMessageId = msg.id;
        log.debug(`[monitor] message from ${msg.user}: ${msg.text?.slice(0, 80)}`);
        onMessage(msg);
    });
    // Step 5: Handle history (sent on join)
    socket.on("history", (messages) => {
        if (stopped || !messages?.length)
            return;
        // On reconnect, we may get history that includes already-seen messages
        if (lastSeenMessageId) {
            const idx = messages.findIndex((m) => m.id === lastSeenMessageId);
            if (idx >= 0) {
                // Only process messages newer than what we've seen
                const newMsgs = messages.slice(idx + 1);
                log.debug(`[monitor] history: ${messages.length} total, ${newMsgs.length} new since last seen`);
                for (const msg of newMsgs) {
                    if (msg.user !== account.botName && !msg.user.startsWith(account.botName + "-")) {
                        onMessage(msg);
                    }
                }
                if (messages.length > 0) {
                    lastSeenMessageId = messages[messages.length - 1].id;
                }
                return;
            }
        }
        // First connection: just record the last ID, don't replay old history
        log.debug(`[monitor] initial history: ${messages.length} messages, skipping replay`);
        lastSeenMessageId = messages[messages.length - 1].id;
    });
    // Step 6: Connection lifecycle events
    socket.on("disconnect", (reason) => {
        if (stopped)
            return;
        log.warn(`[monitor] disconnected: ${reason}`);
        setStatus("disconnected");
    });
    socket.on("connect_error", (err) => {
        if (stopped)
            return;
        log.error(`[monitor] connection error: ${err.message}`);
        setStatus("error");
    });
    socket.on("presence", (data) => {
        if (stopped)
            return;
        log.debug(`[monitor] presence: ${data.event} ${data.user} (${data.users.length} online)`);
    });
    // Step 7: Handle abort signal
    if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
            stop();
        }, { once: true });
    }
    // Stop function
    function stop() {
        if (stopped)
            return;
        stopped = true;
        log.info("[monitor] stopping...");
        if (socket) {
            socket.removeAllListeners();
            socket.disconnect();
            socket = null;
        }
    }
    return { stop };
}
//# sourceMappingURL=monitor.js.map