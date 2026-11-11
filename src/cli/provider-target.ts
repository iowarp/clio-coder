import { readSettings } from "../core/config.js";
import {
	type AuthTarget,
	openAuthStorage,
	resolveAuthTarget,
	targetRequiresAuth,
} from "../domains/providers/auth/index.js";
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

/** The spelling `auth logout` accepts for a runtime whose id a target also uses. */
export const RUNTIME_LOGOUT_PREFIX = "runtime:";

/**
 * Resolve an `auth logout` argument. A bare id names the target when a target
 * has that id; `runtime:<id>` always names the runtime's own credential.
 */
export function resolveLogoutReference(input: string): ResolvedProviderReference | null {
	if (!input.startsWith(RUNTIME_LOGOUT_PREFIX)) return resolveCliProviderReference(input);
	ensureSetupRuntimeRegistry();
	const runtime = getRuntimeRegistry().get(input.slice(RUNTIME_LOGOUT_PREFIX.length));
	if (!runtime) return null;
	return { input, target: null, runtime, authTarget: resolveRuntimeAuthTarget(runtime) };
}

/** One stored credential `auth logout` can remove, named by an id that removes exactly it. */
export interface LogoutChoice {
	/** A runtime id (`runtime:<id>` when a target has the same id) or a target id. */
	id: string;
	label: string;
	group: ProviderSupportEntry["group"];
	source: "stored-api-key" | "stored-oauth";
	/** The credential removing this choice drops; `authTarget.providerId` is its storage key. */
	authTarget: AuthTarget;
}

/**
 * The stored credentials `auth logout` can remove, one row per stored key. A
 * key several targets point at is listed once and names the targets that also
 * use it, because removing it signs all of them out.
 */
export function listLogoutChoices(): LogoutChoice[] {
	ensureSetupRuntimeRegistry();
	const settings = readSettings();
	const auth = openAuthStorage();
	const targetIds = new Set(settings.targets.map((target) => target.id));
	const stored = (status: AuthStatus): LogoutChoice["source"] | null =>
		status.available && (status.source === "stored-api-key" || status.source === "stored-oauth") ? status.source : null;
	const byKey = new Map<string, { choice: LogoutChoice; sharedWith: string[] }>();
	const add = (choice: Omit<LogoutChoice, "source">, status: AuthStatus): void => {
		const existing = byKey.get(choice.authTarget.providerId);
		if (existing) {
			existing.sharedWith.push(choice.id);
			return;
		}
		const source = stored(status);
		if (source) byKey.set(choice.authTarget.providerId, { choice: { ...choice, source }, sharedWith: [] });
	};
	for (const entry of listProviderSupportEntries(getRuntimeRegistry().list())) {
		if (!entry.connectable) continue;
		const runtime = getRuntimeRegistry().get(entry.runtimeId);
		if (!runtime) continue;
		const runtimeAuth = resolveRuntimeAuthTarget(runtime);
		const id = targetIds.has(entry.runtimeId) ? `${RUNTIME_LOGOUT_PREFIX}${entry.runtimeId}` : entry.runtimeId;
		add(
			{ id, label: entry.label, group: entry.group, authTarget: runtimeAuth },
			auth.statusForTarget(runtimeAuth, { includeFallback: false }),
		);
		for (const target of settings.targets) {
			if (target.runtime !== entry.runtimeId || !targetRequiresAuth(target, runtime)) continue;
			const targetAuth = resolveAuthTarget(target, runtime);
			add(
				{ id: target.id, label: `${entry.label} target`, group: entry.group, authTarget: targetAuth },
				auth.statusForTarget(targetAuth, { includeFallback: false }),
			);
		}
	}
	return [...byKey.values()].map(({ choice, sharedWith }) =>
		sharedWith.length === 0 ? choice : { ...choice, label: `${choice.label}, also ${sharedWith.join(", ")}` },
	);
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
