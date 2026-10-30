import type { ClioSettings } from "../../core/config.js";
import { isLocalAddress } from "../providers/cache-deployment.js";
import { isModelRoutedGatewayRuntime } from "../providers/model-routed-gateway.js";
import { getRuntimeRegistry } from "../providers/registry.js";
import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";

const derivedEngines = new WeakSet<object>();

/** Explicit engines, including ones using the reserved name, keep their policy (#429). */
export function capabilityEngineSource(engine: object): "context.memory" | undefined {
	return derivedEngines.has(engine) ? "context.memory" : undefined;
}

/** FW-1: reuse an explicitly configured side model through the normal calibrated decision engine. */
export function capabilitySettings(settings: Readonly<ClioSettings>): Readonly<ClioSettings> {
	if (settings.systemOne.sites.relevance !== undefined) return settings;
	const { target, model } = settings.context.memory;
	if (!settings.context.memory.enabled || !target || !model) return settings;
	const destination = settings.targets.find((entry) => entry.id === target);
	if (destination === undefined) return settings;
	const runtime = getRuntimeRegistry().get(destination.runtime) ?? findBuiltinRuntimeBootMetadata(destination.runtime);
	// A gateway's address proves nothing about the selected model's locality.
	// Without downstream evidence, keep relevance opt-in through systemOne (#429).
	if (
		destination.gateway ||
		isModelRoutedGatewayRuntime(runtime?.id ?? destination.runtime) ||
		runtime?.tier === "cloud" ||
		runtime?.tier === "subscription"
	) {
		return settings;
	}
	let local = runtime?.tier === "local-native";
	if (!local && destination.url) {
		try {
			const url = new URL(destination.url);
			const host = url.hostname.replace(/^\[|\]$/g, "");
			local = ["http:", "https:"].includes(url.protocol) && (host === "localhost" || isLocalAddress(host));
		} catch {
			// An invalid endpoint cannot establish a local side model (#429).
		}
	}
	if (!local) return settings;
	// Skill routing must never pay a second pass through the foreground model.
	if (target === settings.chat.target && model === settings.chat.model) return settings;
	const engine = "clio-capability-side-model";
	if (settings.systemOne.engines[engine] !== undefined) return settings;
	const config = { kind: "llm", target, model, mode: "auto" } as const;
	derivedEngines.add(config);
	return {
		...settings,
		systemOne: {
			...settings.systemOne,
			engines: { ...settings.systemOne.engines, [engine]: config },
			sites: { ...settings.systemOne.sites, relevance: { engine } },
		},
	};
}
