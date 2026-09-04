/**
 * Durable routing facts reported by an AI gateway for one upstream response.
 *
 * The gateway is authoritative for the physical deployment that served an
 * alias. Clio deliberately records only the host portion of an upstream API
 * base: LiteLLM deployments may embed paths, query credentials, or user-info
 * in the configured URL, none of which belongs in a session or sealed receipt.
 */
export interface LiteLLMGatewayRoutingObservation {
	gateway: "litellm";
	callId?: string;
	modelGroup?: string;
	modelName?: string;
	apiBaseHost?: string;
	deploymentId?: string;
	attemptedFallbacks?: number;
	attemptedRetries?: number;
	overheadMs?: number;
	responseDurationMs?: number;
	version?: string;
}

export type GatewayRoutingObservation = LiteLLMGatewayRoutingObservation;

interface HeaderReader {
	get(name: string): string | null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
	const parsed = nonnegativeNumber(value);
	return parsed === undefined ? undefined : Math.floor(parsed);
}

function apiBaseHost(value: unknown): string | undefined {
	const raw = nonEmptyString(value);
	if (raw === undefined) return undefined;
	try {
		return new URL(raw).host || undefined;
	} catch {
		return undefined;
	}
}

function storedApiBaseHost(value: unknown): string | undefined {
	const raw = nonEmptyString(value);
	if (raw === undefined) return undefined;
	try {
		return new URL(raw.includes("://") ? raw : `http://${raw}`).host || undefined;
	} catch {
		return undefined;
	}
}

/** Read LiteLLM's response headers without retaining sensitive API-base data. */
export function liteLLMGatewayRoutingFromHeaders(headers: HeaderReader): GatewayRoutingObservation | null {
	const callId = nonEmptyString(headers.get("x-litellm-call-id"));
	const modelGroup = nonEmptyString(headers.get("x-litellm-model-group"));
	const modelName = nonEmptyString(headers.get("x-litellm-model-name"));
	const host = apiBaseHost(headers.get("x-litellm-model-api-base"));
	const deploymentId = nonEmptyString(headers.get("x-litellm-model-id"));
	const attemptedFallbacks = nonnegativeInteger(headers.get("x-litellm-attempted-fallbacks"));
	const attemptedRetries = nonnegativeInteger(headers.get("x-litellm-attempted-retries"));
	const overheadMs = nonnegativeNumber(headers.get("x-litellm-overhead-duration-ms"));
	const responseDurationMs = nonnegativeNumber(headers.get("x-litellm-response-duration-ms"));
	const version = nonEmptyString(headers.get("x-litellm-version"));
	const observation: GatewayRoutingObservation = {
		gateway: "litellm",
		...(callId !== undefined ? { callId } : {}),
		...(modelGroup !== undefined ? { modelGroup } : {}),
		...(modelName !== undefined ? { modelName } : {}),
		...(host !== undefined ? { apiBaseHost: host } : {}),
		...(deploymentId !== undefined ? { deploymentId } : {}),
		...(attemptedFallbacks !== undefined ? { attemptedFallbacks } : {}),
		...(attemptedRetries !== undefined ? { attemptedRetries } : {}),
		...(overheadMs !== undefined ? { overheadMs } : {}),
		...(responseDurationMs !== undefined ? { responseDurationMs } : {}),
		...(version !== undefined ? { version } : {}),
	};
	return Object.keys(observation).length > 1 ? observation : null;
}

/** Parse a live message, persisted session row, or receipt response defensively. */
export function gatewayRoutingObservationFromRecord(
	record: Readonly<Record<string, unknown>>,
): GatewayRoutingObservation | null {
	const value = record.gatewayRouting;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	if (raw.gateway !== "litellm") return null;
	const callId = nonEmptyString(raw.callId);
	const modelGroup = nonEmptyString(raw.modelGroup);
	const modelName = nonEmptyString(raw.modelName);
	const host = storedApiBaseHost(raw.apiBaseHost);
	const deploymentId = nonEmptyString(raw.deploymentId);
	const attemptedFallbacks = nonnegativeInteger(raw.attemptedFallbacks);
	const attemptedRetries = nonnegativeInteger(raw.attemptedRetries);
	const overheadMs = nonnegativeNumber(raw.overheadMs);
	const responseDurationMs = nonnegativeNumber(raw.responseDurationMs);
	const version = nonEmptyString(raw.version);
	const observation: GatewayRoutingObservation = {
		gateway: "litellm",
		...(callId !== undefined ? { callId } : {}),
		...(modelGroup !== undefined ? { modelGroup } : {}),
		...(modelName !== undefined ? { modelName } : {}),
		...(host !== undefined ? { apiBaseHost: host } : {}),
		...(deploymentId !== undefined ? { deploymentId } : {}),
		...(attemptedFallbacks !== undefined ? { attemptedFallbacks } : {}),
		...(attemptedRetries !== undefined ? { attemptedRetries } : {}),
		...(overheadMs !== undefined ? { overheadMs } : {}),
		...(responseDurationMs !== undefined ? { responseDurationMs } : {}),
		...(version !== undefined ? { version } : {}),
	};
	return Object.keys(observation).length > 1 ? observation : null;
}

/** Compact human projection for receipts and operator notices. */
export function gatewayRoutingObservationLabel(observation: GatewayRoutingObservation): string {
	const route = [observation.modelGroup, observation.modelName].filter(Boolean).join("->");
	const destination = [route, observation.apiBaseHost ? `@${observation.apiBaseHost}` : ""].filter(Boolean).join("");
	const parts = [
		"gateway=litellm",
		...(destination ? [`route=${destination}`] : []),
		...(observation.attemptedFallbacks !== undefined ? [`fallbacks=${observation.attemptedFallbacks}`] : []),
		...(observation.attemptedRetries !== undefined ? [`retries=${observation.attemptedRetries}`] : []),
		...(observation.overheadMs !== undefined ? [`overhead_ms=${observation.overheadMs}`] : []),
	];
	return parts.join(" ");
}
