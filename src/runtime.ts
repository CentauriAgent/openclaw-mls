import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setMlsRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getMlsRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("MLS runtime not initialized");
  }
  return runtime;
}
