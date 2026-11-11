import { readSettings } from "../../../../../src/core/config.js";
import { projectChosenTargetUrl } from "../../../../../src/core/project-target-urls.js";
import { readLayeredSettings } from "../../../../../src/core/settings-layers.js";
import { describeMissing, setupStatus } from "../../../../../src/domains/lifecycle/setup-status.js";
import {
	openAuthStorage,
	resolveAuthTarget,
	targetRequiresAuth,
} from "../../../../../src/domains/providers/auth/index.js";
import { getRuntimeRegistry } from "../../../../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../../../../src/domains/providers/runtimes/builtins.js";
import type { SetupStatus } from "../../../contracts/setup.js";

/**
 * Saved routing and credential presence only; never probes, refreshes OAuth, or generates. With a
 * project directory the answer uses that project's effective settings, the same layers a task started
 * there runs with; without one it is the user settings alone, which is what first-run setup asks.
 * The stage and the fix sentence come from the setup status every terminal surface reads.
 */
export function readSetupStatus(cwd?: string): SetupStatus {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const settings = cwd ? readLayeredSettings(cwd).settings : readSettings();
	const target = settings.targets.find((entry) => entry.id === settings.chat.target);
	const runtime = target ? registry.get(target.runtime) : undefined;
	const authTarget = target && runtime ? resolveAuthTarget(target, runtime) : undefined;
	const envVariable = target?.auth?.apiKeyEnvVar?.trim();
	const projectUrl = target ? projectChosenTargetUrl(target, true) : null;
	const status = setupStatus({
		chat: settings.chat,
		...(target && runtime?.kind === "http" && authTarget
			? {
					target: {
						id: target.id,
						runtime: target.runtime,
						...(target.url !== undefined ? { url: target.url } : {}),
						...(target.defaultModel !== undefined ? { defaultModel: target.defaultModel } : {}),
						drivesChat: true,
						...(targetRequiresAuth(target, runtime)
							? {
									credential: {
										available: openAuthStorage().statusForTarget(authTarget, { includeFallback: false }).available,
										provider: authTarget.providerId,
										...(envVariable ? { envVariable } : {}),
										...(projectUrl !== null ? { projectUrl } : {}),
									},
								}
							: {}),
					},
				}
			: {}),
	});
	if (status.stage === "choose")
		return {
			state: "unconfigured",
			targetId: null,
			model: null,
			message: "Connect a model to start your first conversation.",
		};
	const model = status.route.model ?? null;
	const first =
		status.stage === "needs"
			? status.missing.find((item) => item.kind === "credential" || item.kind === "env")
			: undefined;
	if (first !== undefined)
		return {
			state: "needs-credentials",
			targetId: status.route.target,
			model,
			message: describeMissing(first).sentence,
		};
	return {
		state: model ? "ready" : "needs-model",
		targetId: status.route.target,
		model,
		message: model
			? "Using your saved setup. Live reachability has not been checked."
			: "Choose a model for your saved connection.",
	};
}
