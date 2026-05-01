import { readSettings } from "../core/config.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import {
	EMPTY_CAPABILITIES,
	listProviderSupportEntries,
	type ProviderSupportEntry,
	type ResolvedProviderReference,
	resolveProviderReference,
	resolveRuntimeAuthTarget,
	supportGroupLabel,
} from "../domains/providers/index.js";
import { getRuntimeRegistry } from "../domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../domains/providers/runtimes/builtins.js";
import { columnWidths, formatColumnRow } from "./shared.js";

export interface ConnectableProviderRow {
	entry: ProviderSupportEntry;
	status: ReturnType<ReturnType<typeof openAuthStorage>["statusForTarget"]> | null;
	targetCount: number;
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
			const status =
				runtime && runtime.auth !== "cli"
					? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false })
					: null;
			return {
				entry,
				status,
				targetCount: settings.endpoints.filter((endpoint) => endpoint.runtime === entry.runtimeId).length,
			};
		});
}

export function renderConnectableProviderRows(rows: ReadonlyArray<ConnectableProviderRow>): string {
	let lastGroup: ProviderSupportEntry["group"] | null = null;
	const lines: string[] = [];
	const renderedRows = rows.map((row) => {
		const status = row.status?.available
			? row.status.source === "environment"
				? `env${row.status.detail ? `:${row.status.detail}` : ""}`
				: row.status.source
			: row.entry.runtimeId.endsWith("-cli") || row.entry.runtimeId.endsWith("-sdk")
				? "native-cli"
				: "disconnected";
		return {
			group: row.entry.group,
			cells: [row.entry.runtimeId, row.entry.label, status, `targets=${row.targetCount}`],
		};
	});
	const widths = columnWidths(renderedRows.map((row) => row.cells));
	for (const row of renderedRows) {
		if (row.group !== lastGroup) {
			lastGroup = row.group;
			lines.push(`${supportGroupLabel(row.group)}:`);
		}
		lines.push(`  ${formatColumnRow(row.cells, widths)}`);
	}
	return `${lines.join("\n")}\n`;
}
