import { readSettings } from "../core/config.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import {
	EMPTY_CAPABILITIES,
	type ProviderSupportEntry,
	type ResolvedProviderReference,
	listProviderSupportEntries,
	resolveProviderReference,
	resolveRuntimeAuthTarget,
	supportGroupLabel,
} from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";

export interface ConnectableProviderRow {
	entry: ProviderSupportEntry;
	status: ReturnType<ReturnType<typeof openAuthStorage>["statusForTarget"]> | null;
	endpointCount: number;
}

export function ensureSetupRuntimeRegistry(): void {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
}

export function resolveCliProviderReference(input: string): ResolvedProviderReference | null {
	ensureSetupRuntimeRegistry();
	const resolved = resolveProviderReference(input, readSettings(), (runtimeId) => getRuntimeRegistry().get(runtimeId));
	if (resolved) return resolved;
	const oauthProvider = openAuthStorage()
		.getOAuthProviders()
		.find((provider) => provider.id === input);
	if (!oauthProvider) return null;
	return {
		input,
		endpoint: null,
		runtime: {
			id: oauthProvider.id,
			displayName: oauthProvider.name,
			kind: "http",
			apiFamily: "openai-codex-responses",
			auth: "oauth",
			defaultCapabilities: EMPTY_CAPABILITIES,
			synthesizeModel: () => {
				throw new Error(`runtime ${oauthProvider.id} is auth-only in this context`);
			},
		},
		authTarget: {
			providerId: oauthProvider.id,
			runtimeAuth: "oauth",
		},
	};
}

export function listConnectableProviderRows(): ConnectableProviderRow[] {
	ensureSetupRuntimeRegistry();
	const settings = readSettings();
	const auth = openAuthStorage();
	return listProviderSupportEntries(getRuntimeRegistry().list())
		.filter((entry) => entry.connectable)
		.map((entry) => {
			const runtime = getRuntimeRegistry().get(entry.runtimeId);
			const status = runtime ? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false }) : null;
			return {
				entry,
				status,
				endpointCount: settings.endpoints.filter((endpoint) => endpoint.runtime === entry.runtimeId).length,
			};
		});
}

export function renderConnectableProviderRows(rows: ReadonlyArray<ConnectableProviderRow>): string {
	let lastGroup: ProviderSupportEntry["group"] | null = null;
	const lines: string[] = [];
	for (const row of rows) {
		if (row.entry.group !== lastGroup) {
			lastGroup = row.entry.group;
			lines.push(`${supportGroupLabel(row.entry.group)}:`);
		}
		const status = row.status?.available
			? row.status.source === "environment"
				? `env${row.status.detail ? `:${row.status.detail}` : ""}`
				: row.status.source
			: "disconnected";
		lines.push(
			`  ${row.entry.runtimeId.padEnd(22)} ${row.entry.label.padEnd(18)} ${status.padEnd(20)} endpoints=${row.endpointCount}`,
		);
	}
	return `${lines.join("\n")}\n`;
}
