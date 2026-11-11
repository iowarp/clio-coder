import { readSettings } from "../core/config.js";
import { openAuthStorage, resolveAuthTarget, targetRequiresAuth } from "../domains/providers/auth/index.js";
import {
	type AuthStatus,
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
 * `clio-coder auth` shows the runtimes whose credential Clio owns: an OAuth flow it
 * drives or an API key it stores (`connectable` in
 * `buildProviderSupportEntry`). Runtimes that authenticate through a vendor CLI
 * (`claude-cli`), a cloud credential chain (`aws-sdk`), or nothing at all are
 * registered, configurable, and absent here. `clio-coder configure --list` renders
 * the same registry unfiltered, so a user reading one screen found eight
 * runtimes that the other did not admit existed. Both now say which set they
 * are showing and name the command that shows the rest.
 */
export const CONNECTABLE_LIST_CAPTION =
	"runtimes clio authenticates itself. run `clio-coder configure --list` for every registered runtime, including those that authenticate through their own tool or need no credential.";

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
			const targets = settings.targets.filter((target) => target.runtime === entry.runtimeId);
			let status = runtime ? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false }) : null;
			// configure stores a target's key under its own `apiKeyRef` (`target:<id>`),
			// which the runtime's credential never reads. A connected target connects
			// the runtime.
			if (runtime && status && !status.available) {
				for (const target of targets) {
					if (!targetRequiresAuth(target, runtime)) continue;
					const targetStatus = auth.statusForTarget(resolveAuthTarget(target, runtime), { includeFallback: false });
					if (targetStatus.available) {
						status = targetStatus;
						break;
					}
				}
			}
			return { entry, status, targetCount: targets.length };
		});
}

/** One credential `auth logout` can remove, named by the id that removes it. */
export interface LogoutChoice {
	/** A runtime id for the runtime's own credential, a target id for a key stored under `target:<id>`. */
	id: string;
	label: string;
	group: ProviderSupportEntry["group"];
	source: "stored-api-key" | "stored-oauth";
}

/**
 * The stored credentials `auth logout` can remove. A target's own key is listed
 * under the target id, because logout by runtime id removes only the runtime's
 * credential; listing the runtime would offer a choice that removes nothing.
 */
export function listLogoutChoices(): LogoutChoice[] {
	ensureSetupRuntimeRegistry();
	const settings = readSettings();
	const auth = openAuthStorage();
	const stored = (status: AuthStatus): LogoutChoice["source"] | null =>
		status.available && (status.source === "stored-api-key" || status.source === "stored-oauth") ? status.source : null;
	return listProviderSupportEntries(getRuntimeRegistry().list())
		.filter((entry) => entry.connectable)
		.flatMap((entry) => {
			const runtime = getRuntimeRegistry().get(entry.runtimeId);
			if (!runtime) return [];
			const choices: LogoutChoice[] = [];
			const runtimeAuth = resolveRuntimeAuthTarget(runtime);
			const own = stored(auth.statusForTarget(runtimeAuth, { includeFallback: false }));
			if (own) choices.push({ id: entry.runtimeId, label: entry.label, group: entry.group, source: own });
			for (const target of settings.targets) {
				if (target.runtime !== entry.runtimeId || !targetRequiresAuth(target, runtime)) continue;
				const targetAuth = resolveAuthTarget(target, runtime);
				if (targetAuth.providerId === runtimeAuth.providerId) continue;
				const source = stored(auth.statusForTarget(targetAuth, { includeFallback: false }));
				if (source) choices.push({ id: target.id, label: `${entry.label} target`, group: entry.group, source });
			}
			return choices;
		});
}

export function renderLogoutChoices(choices: ReadonlyArray<LogoutChoice>, numbered = false): string {
	let lastGroup: ProviderSupportEntry["group"] | null = null;
	const lines: string[] = [];
	const widths = columnWidths(choices.map((choice) => [choice.id, choice.label, choice.source]));
	for (const [index, choice] of choices.entries()) {
		if (choice.group !== lastGroup) {
			lastGroup = choice.group;
			lines.push(`${supportGroupLabel(choice.group)}:`);
		}
		const number = numbered ? `${String(index + 1).padStart(2)}. ` : "";
		lines.push(`  ${number}${formatColumnRow([choice.id, choice.label, choice.source], widths)}`);
	}
	return `${lines.join("\n")}\n`;
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
