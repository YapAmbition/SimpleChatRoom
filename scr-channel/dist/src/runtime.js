/**
 * PluginRuntime singleton holder.
 *
 * OpenClaw injects the runtime during plugin registration.
 * Other modules retrieve it via getScrRuntime().
 */
let runtime = null;
export function setScrRuntime(next) {
    runtime = next;
}
export function getScrRuntime() {
    if (!runtime) {
        throw new Error("[scr-channel] Plugin runtime not initialized. Was register() called?");
    }
    return runtime;
}
/**
 * Fallback logger used before runtime is available (e.g. during standalone testing).
 */
export const fallbackLogger = {
    info: (msg, ...args) => console.log(`[scr] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[scr] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[scr] ${msg}`, ...args),
    debug: (msg, ...args) => console.debug(`[scr] ${msg}`, ...args),
};
/**
 * Get logger — uses runtime logger if available, otherwise fallback.
 */
export function getLogger() {
    try {
        return getScrRuntime().logger;
    }
    catch {
        return fallbackLogger;
    }
}
//# sourceMappingURL=runtime.js.map