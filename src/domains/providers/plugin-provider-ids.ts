/**
 * Provider ids a runtime plugin brought in. The environment-key fallback that
 * maps a well-known provider id to its variable (`xai` to `XAI_API_KEY`) is
 * for Clio's own runtimes only: a plugin that names itself after a provider it
 * does not represent must not receive that provider's key. A plugin still gets
 * the variable it declares in `credentialsEnvVar` or a target's `apiKeyEnvVar`.
 */
const pluginProviderIds = new Set<string>();

export function markPluginProviderIds(ids: Iterable<string>): void {
	for (const id of ids) pluginProviderIds.add(id);
}

export function unmarkPluginProviderIds(ids: Iterable<string>): void {
	for (const id of ids) pluginProviderIds.delete(id);
}

export function isPluginProviderId(id: string): boolean {
	return pluginProviderIds.has(id);
}
