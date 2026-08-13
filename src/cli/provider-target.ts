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
import { registerClioOAuthProviders } from "../engine/oauth.js";
import { columnWidths, formatColumnRow } from "./shared.js";

/**
 * What the connectable listing is a listing of.
 *
 * `clio auth` shows the runtimes whose credential Clio owns: an OAuth flow it
 * drives or an API key it stores (`connectable` in
 * `buildProviderSupportEntry`). Runtimes that authenticate through a vendor CLI
 * (`claude-cli`), a cloud credential chain (`aws-sdk`), or nothing at all are
 * registered, configurable, and absent here. `clio configure --list` renders
 * the same registry unfiltered, so a user reading one screen found eight
 * runtimes that the other did not admit existed. Both now say which set they
 * are showing and name the command that shows the rest.
 */
export const CONNECTABLE_LIST_CAPTION =
	"runtimes clio authenticates itself. run `clio configure --list` for every registered runtime, including those that authenticate through their own tool or need no credential.";

export interface ConnectableProviderRow {
	entry: ProviderSupportEntry;
	status: ReturnType<ReturnType<typeof openAuthStorage>["statusForTarget"]> | null;
	targetCount: number;
}

function ensureSetupRuntimeRegistry(): void {
	registerClioOAuthProviders();
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
		target: null,
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
				targetCount: settings.targets.filter((target) => target.runtime === entry.runtimeId).length,
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
