import { readSettings } from "../../../../../src/core/config.js";
import { openAuthStorage, targetRequiresAuth } from "../../../../../src/domains/providers/auth/index.js";
import { resolveRuntimeAuthTarget } from "../../../../../src/domains/providers/auth/storage.js";
import { getRuntimeRegistry } from "../../../../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../../../../src/domains/providers/runtimes/builtins.js";
import {
	configuredTargetsForRuntime,
	listProviderSupportEntries,
	supportGroupLabel,
} from "../../../../../src/domains/providers/support.js";
import type { TargetRuntimes } from "../../../contracts/targets-cli.js";

/** The runtimes `configure --list` offers, with the same auth vocabulary. Status only: no credential is read out. */
export function readTargetRuntimes(): TargetRuntimes {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const settings = readSettings();
	const auth = openAuthStorage();
	return {
		runtimes: listProviderSupportEntries(registry.list())
			.slice(0, 200)
			.map((entry) => {
				const runtime = registry.get(entry.runtimeId);
				const status =
					runtime && entry.connectable
						? auth.statusForTarget(resolveRuntimeAuthTarget(runtime), { includeFallback: false })
						: null;
				const state: TargetRuntimes["runtimes"][number]["auth"] =
					runtime?.auth === "oauth"
						? status?.available
							? "connected"
							: "login"
						: runtime?.auth === "api-key"
							? status?.available
								? "credential"
								: targetRequiresAuth({ id: entry.runtimeId, runtime: entry.runtimeId }, runtime)
									? "needs-key"
									: "key-optional"
							: !runtime || runtime.auth === "none"
								? "none"
								: "other";
				return {
					id: entry.runtimeId,
					label: entry.label.slice(0, 256),
					group: supportGroupLabel(entry.group),
					summary: entry.summary.slice(0, 256),
					defaultModel: entry.defaultModel ?? null,
					modelHints: entry.modelHints.slice(0, 60).map((hint) => hint.slice(0, 256)),
					modelRequired: entry.modelSource === "catalog",
					supportsCustomUrl: entry.supportsCustomUrl,
					auth: state,
					targetCount: configuredTargetsForRuntime(settings, entry.runtimeId).length,
				};
			}),
	};
}
