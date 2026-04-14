/**
 * PluginRuntime singleton holder.
 *
 * OpenClaw injects the runtime during plugin registration.
 * Other modules retrieve it via getScrRuntime().
 */
export type PluginRuntime = {
    logger: {
        info: (msg: string, ...args: unknown[]) => void;
        warn: (msg: string, ...args: unknown[]) => void;
        error: (msg: string, ...args: unknown[]) => void;
        debug: (msg: string, ...args: unknown[]) => void;
    };
    [key: string]: unknown;
};
export declare function setScrRuntime(next: PluginRuntime): void;
export declare function getScrRuntime(): PluginRuntime;
/**
 * Fallback logger used before runtime is available (e.g. during standalone testing).
 */
export declare const fallbackLogger: PluginRuntime["logger"];
/**
 * Get logger — uses runtime logger if available, otherwise fallback.
 */
export declare function getLogger(): PluginRuntime["logger"];
//# sourceMappingURL=runtime.d.ts.map