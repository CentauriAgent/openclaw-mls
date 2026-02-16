import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { mlsPlugin } from "./src/channel.js";
import { setMlsRuntime } from "./src/runtime.js";

const plugin = {
  id: "mls",
  name: "MLS",
  description: "MLS encrypted group messaging channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMlsRuntime(api.runtime);
    api.registerChannel({ plugin: mlsPlugin });
  },
};

export default plugin;
