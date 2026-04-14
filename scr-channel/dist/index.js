/**
 * Plugin entry point — registers the SimpleChatRoom channel with OpenClaw.
 *
 * OpenClaw discovers this file via the openclaw.extensions field in package.json
 * and calls the default export's register() method during gateway startup.
 */
import { scrPlugin } from "./src/channel.js";
import { setScrRuntime } from "./src/runtime.js";
export default {
    id: "scr",
    register(api) {
        setScrRuntime(api.runtime);
        api.registerChannel({ plugin: scrPlugin });
    },
};
// Re-export for direct imports
export { scrPlugin } from "./src/channel.js";
//# sourceMappingURL=index.js.map