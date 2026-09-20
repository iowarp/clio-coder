import { publishClioCompileCache } from "../core/compile-cache.js";
import type { ClioSettings } from "../core/config.js";
import { canonicalEndpointUrl } from "../core/endpoint-key.js";
import { endpointCapacityUsage } from "../domains/dispatch/index.js";
import { observeCacheDeployment } from "../domains/providers/cache-deployment.js";
import type { ProvidersContract, TargetStatus } from "../domains/providers/contract.js";
import { canonicalEndpointKey, registerForegroundStream } from "../domains/providers/endpoint-capacity.js";
import { type PrewarmRoundResult, runPrewarmRound } from "../engine/prewarm.js";
import { recordStartupDiagnostic } from "./startup-diagnostics.js";

interface StartupPreparation {
	settings: Readonly<ClioSettings>;
	providers: ProvidersContract;
	signal: AbortSignal;
	isBusy: () => boolean;
	recordWarm?: (target: string, model: string, result: PrewarmRoundResult) => void;
	/** Test seams; production always uses the normal engine and deployment checks. */
	observe?: typeof observeCacheDeployment;
	warm?: typeof runPrewarmRound;
}

/** One tiny inference handshake, not a claim to cache a future worker's prompt. */
async function warmWorkerTarget(input: StartupPreparation, status: TargetStatus, modelId: string): Promise<void> {
	const { target, runtime } = status;
	if (!runtime || target.cache?.warm?.startup !== true || target.cache.retention === "none") return;
	if (target.pricing && Object.values(target.pricing).some((rate) => rate > 0)) return;
	const identity = JSON.stringify(target);
	const signal = AbortSignal.any([
		input.signal,
		AbortSignal.timeout(Math.min(2000, target.cache.warm.maxDurationMs ?? 2000)),
	]);
	const auth = await input.providers.auth.resolveForTarget(target, runtime, { signal });
	const deployment = await (input.observe ?? observeCacheDeployment)(target, modelId, {
		signal,
		...(auth.apiKey ? { gatewayApiKey: auth.apiKey } : {}),
	});
	if (
		!deployment.endpoint ||
		(deployment.warm !== "bounded" && !(deployment.backend === "lmstudio" && deployment.reason === "model-not-loaded"))
	) {
		recordStartupDiagnostic({
			kind: "worker-warm",
			target: target.id,
			model: modelId,
			ran: false,
			reason: deployment.reason,
		});
		return;
	}
	if (signal.aborted || input.isBusy() || JSON.stringify(input.providers.getTarget(target.id)) !== identity) return;
	if ((endpointCapacityUsage()[deployment.endpoint] ?? 0) > 0) return;
	const model = runtime.synthesizeModel(target, modelId, input.providers.knowledgeBase?.lookup(modelId) ?? null);
	const release = registerForegroundStream(deployment.endpoint);
	let result: PrewarmRoundResult;
	try {
		result = await (input.warm ?? runPrewarmRound)({
			model,
			state: { systemPrompt: "", messages: [], tools: [], thinkingLevel: "off" },
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			signal,
			maxInputTokens: Math.min(256, target.cache.warm.maxInputTokens ?? 256),
			canSend: () =>
				!signal.aborted && !input.isBusy() && JSON.stringify(input.providers.getTarget(target.id)) === identity,
		});
	} finally {
		release();
	}
	input.recordWarm?.(target.id, modelId, result);
	recordStartupDiagnostic({
		kind: "worker-warm",
		target: target.id,
		model: modelId,
		ran: true,
		timing: result.timing,
		aborted: result.aborted,
		failed: Boolean(result.errorMessage),
	});
}

/** Post-paint, bounded work. No model requests unless the target explicitly opts in. */
export async function prepareWorkerTargets(input: StartupPreparation): Promise<void> {
	const { settings, providers, signal, isBusy } = input;
	if (signal.aborted || isBusy()) return;
	publishClioCompileCache();
	const routes = [
		settings.fleet.default,
		...Object.values(settings.fleet.profiles),
		...Object.values(settings.fleet.rosters).flatMap((roster) => roster.members),
	];
	const mainTarget = settings.chat.target ? providers.getTarget(settings.chat.target) : null;
	const mainEndpoints = new Set([
		mainTarget ? canonicalEndpointKey(mainTarget) : null,
		canonicalEndpointUrl(mainTarget?.cache?.deployment?.controlUrl),
	]);
	const endpoints = new Set<string>();
	let remaining = 4;
	for (const route of routes) {
		if (signal.aborted || isBusy()) return;
		if (!route.target || route.target === settings.chat.target || ("node" in route && route.node)) continue;
		const status = providers.list().find((entry) => entry.target.id === route.target);
		if (!status?.available || !status.runtime || status.runtime.kind !== "http") continue;
		if (
			status.runtime.tier !== "local-native" &&
			!(
				status.runtime.id === "litellm" &&
				status.target.cache?.deployment?.backend === "lmstudio" &&
				status.target.cache.warm?.startup === true
			)
		)
			continue;
		const endpoint =
			canonicalEndpointUrl(status.target.cache?.deployment?.controlUrl) ?? canonicalEndpointKey(status.target);
		if (!endpoint || mainEndpoints.has(endpoint) || endpoints.has(endpoint)) continue;
		endpoints.add(endpoint);
		if (remaining-- <= 0) break;
		try {
			if (status.health.lastCheckAt === null) {
				await providers.probeTarget(route.target, {
					reasoning: false,
					tools: false,
					signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
				});
			}
			if (signal.aborted || isBusy()) return;
			const model = route.model ?? status.target.defaultModel;
			if (model) await warmWorkerTarget(input, status, model);
		} catch {
			// Foreground admission retries normally. An optional warm is never a notice.
		}
	}
}
