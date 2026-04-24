import { readSettings } from "../core/config.js";
import type { RuntimeDescriptor } from "../domains/providers/index.js";
import { loadPluginRuntimes } from "../domains/providers/plugins.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";

export async function resolveWorkerRuntime(runtimeId: string): Promise<RuntimeDescriptor | null> {
	const registry = getRuntimeRegistry();
	registerBuiltinRuntimes(registry);
	await loadPluginRuntimes(registry, readSettings());
	return registry.get(runtimeId);
}
