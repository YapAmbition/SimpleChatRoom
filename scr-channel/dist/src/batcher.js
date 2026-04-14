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
import { getLogger } from "./runtime.js";
export class MessageBatcher {
    debounceMs;
    maxWaitMs;
    onFlush;
    queue = [];
    debounceTimer = null;
    maxWaitTimer = null;
    processing = false;
    destroyed = false;
    constructor(debounceMs, maxWaitMs, onFlush) {
        this.debounceMs = debounceMs;
        this.maxWaitMs = maxWaitMs;
        this.onFlush = onFlush;
    }
    /**
     * Push a message into the batch queue.
     */
    push(msg) {
        if (this.destroyed)
            return;
        this.queue.push(msg);
        const log = getLogger();
        log.debug(`[batcher] queued message from ${msg.user}, queue size: ${this.queue.length}`);
        // If currently processing a batch, just enqueue — flush will restart timers
        if (this.processing)
            return;
        this.resetDebounce();
        // Start max-wait timer on first message of a batch
        if (!this.maxWaitTimer) {
            this.maxWaitTimer = setTimeout(() => {
                log.debug("[batcher] max-wait timer fired");
                this.flush();
            }, this.maxWaitMs);
        }
    }
    /**
     * Get the current queue length (for diagnostics).
     */
    get pendingCount() {
        return this.queue.length;
    }
    /**
     * Whether a flush is currently in progress.
     */
    get isProcessing() {
        return this.processing;
    }
    /**
     * Clean up all timers. No further pushes will be accepted.
     */
    destroy() {
        this.destroyed = true;
        this.clearTimers();
        this.queue = [];
    }
    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------
    resetDebounce() {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            getLogger().debug("[batcher] debounce timer fired");
            this.flush();
        }, this.debounceMs);
    }
    clearTimers() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.maxWaitTimer) {
            clearTimeout(this.maxWaitTimer);
            this.maxWaitTimer = null;
        }
    }
    async flush() {
        this.clearTimers();
        if (this.queue.length === 0 || this.processing || this.destroyed)
            return;
        // Take current batch
        const batch = [...this.queue];
        this.queue = [];
        this.processing = true;
        const log = getLogger();
        log.info(`[batcher] flushing batch of ${batch.length} message(s)`);
        try {
            await this.onFlush(batch);
        }
        catch (err) {
            log.error(`[batcher] flush handler error: ${err}`);
        }
        finally {
            this.processing = false;
            // If more messages arrived during processing, restart timers
            if (this.queue.length > 0 && !this.destroyed) {
                log.debug(`[batcher] ${this.queue.length} message(s) queued during processing, restarting timers`);
                this.resetDebounce();
                this.maxWaitTimer = setTimeout(() => {
                    log.debug("[batcher] max-wait timer fired (post-processing)");
                    this.flush();
                }, this.maxWaitMs);
            }
        }
    }
}
//# sourceMappingURL=batcher.js.map