/**
 * Plugin entry point — registers the SimpleChatRoom channel with OpenClaw.
 *
 * OpenClaw discovers this file via the openclaw.extensions field in package.json
 * and calls the default export's register() method during gateway startup.
 */
import { scrPlugin } from "./src/channel.js";
import { type PluginRuntime } from "./src/runtime.js";
declare const _default: {
    id: string;
    register(api: {
        runtime: PluginRuntime;
        registerChannel: (opts: {
            plugin: typeof scrPlugin;
        }) => void;
    }): void;
};
export default _default;
export { scrPlugin } from "./src/channel.js";
export type { ScrMessage, ResolvedScrAccount, ScrAccountConfig } from "./src/types.js";
//# sourceMappingURL=index.d.ts.map