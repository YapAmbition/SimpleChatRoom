/**
 * MessageBatcher — debounce + max-wait batching for inbound messages.
 *
 * Solves the single-concurrency Ollama constraint: instead of dispatching
 * each message individually to the agent, we buffer messages and flush
 * them as a batch after a quiet period or maximum wait time.
 *
 * Behavior:
 * - First message starts both a debounce timer and a max-wait timer
 * - Each new message resets the debounce timer
 * - When debounce expires (no new messages for N ms) → flush
 * - When max-wait expires (even if messages keep coming) → flush
 * - During flush (async), new messages queue for the next batch
 * - After flush completes, if queue is non-empty, restart timers
 */
import type { ScrMessage } from "./types.js";
export declare class MessageBatcher {
    private readonly debounceMs;
    private readonly maxWaitMs;
    private readonly onFlush;
    private queue;
    private debounceTimer;
    private maxWaitTimer;
    private processing;
    private destroyed;
    constructor(debounceMs: number, maxWaitMs: number, onFlush: (messages: ScrMessage[]) => Promise<void>);
    /**
     * Push a message into the batch queue.
     */
    push(msg: ScrMessage): void;
    /**
     * Get the current queue length (for diagnostics).
     */
    get pendingCount(): number;
    /**
     * Whether a flush is currently in progress.
     */
    get isProcessing(): boolean;
    /**
     * Clean up all timers. No further pushes will be accepted.
     */
    destroy(): void;
    private resetDebounce;
    private clearTimers;
    private flush;
}
//# sourceMappingURL=batcher.d.ts.map