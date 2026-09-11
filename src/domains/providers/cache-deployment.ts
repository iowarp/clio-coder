import { canonicalEndpointUrl } from "../../core/endpoint-key.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

/** Fresh observations, not a persisted cache handle or permission to administer a server. */
export interface CacheDeploymentObservation {
	observedAt: number;
	backend: "llamacpp" | "vllm" | "unknown";
	model: string;
	build: string | null;
	/** Absent server epoch stays unknown; Clio never invents one from a build number. */
	epoch: string | null;
	endpoint: string | null;
	requestControls: ReadonlyArray<"cache_prompt">;
	warm: "bounded" | "unsupported";
	administration: "unsupported";
	reason: string;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Read-only admission evidence. Every invocation probes again, so an old route,
 * build, resident state or process epoch is never reused to authorize a warm.
 * Control-plane credentials are deliberately independent: this initial reader
 * sends none. An authenticated/unknown control plane remains passive.
 */
export async function observeCacheDeployment(
	target: TargetDescriptor,
	wireModelId: string,
	options: { signal?: AbortSignal; gatewayApiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<CacheDeploymentObservation> {
	const binding = target.cache?.deployment;
	const observation: CacheDeploymentObservation = {
		observedAt: Date.now(),
		backend: binding?.backend ?? "unknown",
		model: binding?.model ?? wireModelId,
		build: null,
		epoch: null,
		endpoint: null,
		requestControls: [],
		warm: "unsupported",
		administration: "unsupported",
		reason: "deployment-unbound",
	};
	if (!binding) return observation;
	try {
		const control = new URL(binding.controlUrl);
		if (
			!["http:", "https:"].includes(control.protocol) ||
			control.username ||
			control.password ||
			control.search ||
			control.hash
		) {
			return { ...observation, reason: "deployment-invalid" };
		}
		const root = control.href.replace(/\/$/, "").replace(/\/v1$/, "");
		observation.endpoint = canonicalEndpointUrl(root);
		const signal = AbortSignal.any([AbortSignal.timeout(2000), ...(options.signal ? [options.signal] : [])]);
		const get = async (url: string, headers?: Record<string, string>) => {
			const response = await (options.fetchImpl ?? fetch)(url, {
				method: "GET",
				signal,
				redirect: "error",
				credentials: "omit",
				...(headers ? { headers } : {}),
			});
			if (!response.ok) throw new Error("discovery unavailable");
			return (await response.json()) as unknown;
		};
		const gateway = target.runtime === "litellm";
		if (gateway) {
			if (!binding.gatewayDeploymentId || !target.url) return { ...observation, reason: "gateway-unbound" };
			const gatewayRoot = target.url.replace(/\/$/, "").replace(/\/v1$/, "");
			const info = record(
				await get(`${gatewayRoot}/v1/model/info`, {
					...target.auth?.headers,
					...(options.gatewayApiKey ? { authorization: `Bearer ${options.gatewayApiKey}` } : {}),
				}),
			);
			const rows = Array.isArray(info.data) ? info.data.map(record).filter((row) => row.model_name === wireModelId) : [];
			// Multiple replicas/fallback routes do not establish a single physical
			// cache. A deployment response header arrives too late for admission.
			const row = rows.length === 1 ? rows[0] : undefined;
			const params = record(row?.litellm_params);
			const modelInfo = record(row?.model_info);
			if (
				!row ||
				modelInfo.id !== binding.gatewayDeploymentId ||
				(params.model !== binding.model && params.model !== `openai/${binding.model}`) ||
				canonicalEndpointUrl(typeof params.api_base === "string" ? params.api_base : undefined) !== observation.endpoint
			) {
				return { ...observation, reason: "gateway-route-mismatch" };
			}
		} else if (
			target.runtime !== binding.backend ||
			wireModelId !== binding.model ||
			canonicalEndpointUrl(target.url) !== observation.endpoint
		) {
			return { ...observation, reason: "deployment-mismatch" };
		}
		if (binding.backend === "vllm") {
			const version = record(await get(`${root}/version`));
			observation.build = typeof version.version === "string" ? version.version : null;
			// APC and queue/memory metrics vary by deployment. A version and an
			// OpenAI schema alone establish neither APC nor safe speculative load.
			return {
				...observation,
				reason: observation.build === binding.build ? "vllm-scheduler-unverified" : "deployment-build-mismatch",
			};
		}
		let props = record(await get(`${root}/props`));
		const router = props.role === "router";
		if (router) {
			const models = record(await get(`${root}/models`));
			const selected = Array.isArray(models.data)
				? models.data.map(record).find((row) => row.id === binding.model)
				: undefined;
			if (record(selected?.status).value !== "loaded") return { ...observation, reason: "model-not-loaded" };
			// Never wake sleeping models or load an absent worker during discovery.
			props = record(await get(`${root}/props?model=${encodeURIComponent(binding.model)}&autoload=false`));
		}
		observation.build = typeof props.build_info === "string" ? props.build_info : null;
		if (observation.build !== binding.build) return { ...observation, reason: "deployment-build-mismatch" };
		if (!observation.build.endsWith("-c841aee"))
			return { ...observation, reason: "deployment-cache-protocol-unverified" };
		if (props.is_sleeping !== false) return { ...observation, reason: "model-not-loaded" };
		if (typeof props.model_alias === "string" && props.model_alias !== binding.model)
			return { ...observation, reason: "deployment-model-mismatch" };
		if (!router) {
			const models = record(await get(`${root}/v1/models`));
			if (!Array.isArray(models.data) || models.data.length !== 1 || record(models.data[0]).id !== binding.model)
				return { ...observation, reason: "deployment-model-mismatch" };
		}
		if (typeof props.start_time === "string") observation.epoch = props.start_time;
		const slots = await get(`${root}/slots?model=${encodeURIComponent(binding.model)}&autoload=false`);
		if (!Array.isArray(slots) || slots.length === 0 || slots.some((slot) => record(slot).is_processing !== false)) {
			return { ...observation, reason: "endpoint-busy-or-unknown" };
		}
		if (gateway) return { ...observation, reason: "gateway-cache-transport-unverified" };
		return { ...observation, requestControls: ["cache_prompt"], warm: "bounded", reason: "loaded-idle-deployment" };
	} catch {
		return { ...observation, reason: options.signal?.aborted ? "superseded" : "deployment-unavailable" };
	}
}
