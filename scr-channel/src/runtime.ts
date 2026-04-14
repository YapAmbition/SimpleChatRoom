/**
 * PluginRuntime singleton holder.
 *
 * OpenClaw injects the runtime during plugin registration.
 * Other modules retrieve it via getScrRuntime().
 */

// We type this loosely because we don't import the OpenClaw SDK directly.
// In a full SDK environment, this would be `import { PluginRuntime } from 'openclaw/plugin-sdk'`.
export type PluginRuntime = {
  logger: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
  [key: string]: unknown;
};

let runtime: PluginRuntime | null = null;

export function setScrRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getScrRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("[scr-channel] Plugin runtime not initialized. Was register() called?");
  }
  return runtime;
}

/**
 * Fallback logger used before runtime is available (e.g. during standalone testing).
 */
export const fallbackLogger: PluginRuntime["logger"] = {
  info: (msg, ...args) => console.log(`[scr] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[scr] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[scr] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[scr] ${msg}`, ...args),
};

/**
 * Get logger — uses runtime logger if available, otherwise fallback.
 */
export function getLogger(): PluginRuntime["logger"] {
  try {
    return getScrRuntime().logger;
  } catch {
    return fallbackLogger;
  }
}
