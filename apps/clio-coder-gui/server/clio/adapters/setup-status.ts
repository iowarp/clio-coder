import { readSettings } from "../../../../../src/core/config.js";
import {
	openAuthStorage,
	resolveAuthTarget,
	targetRequiresAuth,
} from "../../../../../src/domains/providers/auth/index.js";
import { getRuntimeRegistry } from "../../../../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../../../../src/domains/providers/runtimes/builtins.js";
import type { SetupStatus } from "../../../contracts/setup.js";

/** Saved routing and credential presence only; never probes, refreshes OAuth, or generates. */
export function readSetupStatus(): SetupStatus {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
	const settings = readSettings();
	const target = settings.targets.find((entry) => entry.id === settings.chat.target);
	const runtime = target ? registry.get(target.runtime) : undefined;
	if (!target || !runtime || runtime.kind !== "http")
		return {
			state: "unconfigured",
			targetId: null,
			model: null,
			message: "Connect a model to start your first conversation.",
		};
	const model = settings.chat.model ?? target.defaultModel ?? null;
	if (
		targetRequiresAuth(target, runtime) &&
		!openAuthStorage().statusForTarget(resolveAuthTarget(target, runtime), { includeFallback: false }).available
	)
		return {
			state: "needs-credentials",
			targetId: target.id,
			model,
			message: "Your saved connection needs a key or browser sign-in.",
		};
	return {
		state: model ? "ready" : "needs-model",
		targetId: target.id,
		model,
		message: model
			? "Using your saved setup. Live reachability has not been checked."
			: "Choose a model for your saved connection.",
	};
}
