import type { ToolName } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import type { ModeName } from "../domains/modes/matrix.js";
import type {
	CapabilityFlags,
	EndpointDescriptor,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
	ThinkingLevel,
} from "../domains/providers/index.js";

export const WORKER_SPEC_VERSION = 1;
export const WORKER_RUNTIME_DESCRIPTOR_VERSION = 1;

export interface SerializedWorkerRuntimeDescriptor {
	version: typeof WORKER_RUNTIME_DESCRIPTOR_VERSION;
	id: string;
	kind: RuntimeKind;
	apiFamily: RuntimeApiFamily;
	auth: RuntimeAuth;
}

export interface WorkerSpec {
	specVersion: typeof WORKER_SPEC_VERSION;
	systemPrompt: string;
	dynamicPromptMessages?: ReadonlyArray<WorkerPromptMessage>;
	task: string;
	endpoint: EndpointDescriptor;
	runtime: SerializedWorkerRuntimeDescriptor;
	/** Runtime id kept as a direct lookup key for older dispatch tests and receipts. */
	runtimeId: string;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	sessionId?: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
	allowedTools: ReadonlyArray<ToolName>;
	mode?: ModeName;
	middlewareSnapshot?: MiddlewareSnapshot;
	autoApprove?: "allow" | "deny";
}

export interface WorkerPromptMessage {
	id: string;
	body: string;
	contentHash: string;
}

const RUNTIME_KINDS = ["http", "subprocess", "sdk"] as const satisfies ReadonlyArray<RuntimeKind>;
const RUNTIME_API_FAMILIES = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"lmstudio-native",
	"mistral-conversations",
	"ollama-native",
	"rerank-http",
	"embeddings-http",
	"claude-agent-sdk",
	"subprocess-claude-code",
	"subprocess-codex",
	"subprocess-gemini",
	"subprocess-copilot",
	"subprocess-opencode",
] as const satisfies ReadonlyArray<RuntimeApiFamily>;
const RUNTIME_AUTHS = [
	"api-key",
	"oauth",
	"aws-sdk",
	"vertex-adc",
	"cli",
	"none",
] as const satisfies ReadonlyArray<RuntimeAuth>;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const satisfies ReadonlyArray<ThinkingLevel>;
const MODE_NAMES = ["default", "advise", "super"] as const satisfies ReadonlyArray<ModeName>;
const AUTO_APPROVE_VALUES = ["allow", "deny"] as const;
const ENDPOINT_LIFECYCLES = ["user-managed", "clio-managed"] as const;
const MIDDLEWARE_HOOKS = [
	"before_model",
	"after_model",
	"before_tool",
	"after_tool",
	"before_finish",
	"after_finish",
	"on_blocked_tool",
	"on_retry",
	"on_compaction",
	"on_dispatch_start",
	"on_dispatch_end",
] as const;
const MIDDLEWARE_EFFECT_KINDS = [
	"inject_reminder",
	"annotate_tool_result",
	"block_tool",
	"protect_path",
	"require_validation",
	"record_memory_candidate",
] as const;

export function serializeWorkerRuntimeDescriptor(runtime: RuntimeDescriptor): SerializedWorkerRuntimeDescriptor {
	return {
		version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
		id: runtime.id,
		kind: runtime.kind,
		apiFamily: runtime.apiFamily,
		auth: runtime.auth,
	};
}

function readRecord(value: unknown, source: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${source} must be an object`);
	}
	return value as Record<string, unknown>;
}

function readWorkerPromptMessages(value: unknown, source: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error(`${source} must be an array`);
	for (let index = 0; index < value.length; index++) {
		const entry = readRecord(value[index], `${source}[${index}]`);
		readString(entry.id, `${source}[${index}].id`);
		readString(entry.body, `${source}[${index}].body`);
		readString(entry.contentHash, `${source}[${index}].contentHash`);
	}
}

function readString(value: unknown, source: string, options?: { allowEmpty?: boolean }): string {
	if (typeof value !== "string") throw new Error(`${source} must be a string`);
	if (!options?.allowEmpty && value.length === 0) throw new Error(`${source} must be a non-empty string`);
	return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, source: string): void {
	if (record[key] !== undefined) readString(record[key], `${source}.${key}`);
}

function readOptionalBoolean(record: Record<string, unknown>, key: string, source: string): void {
	const value = record[key];
	if (value !== undefined && typeof value !== "boolean") throw new Error(`${source}.${key} must be a boolean`);
}

function readOptionalNumber(record: Record<string, unknown>, key: string, source: string): void {
	const value = record[key];
	if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
		throw new Error(`${source}.${key} must be a finite number`);
	}
}

function readEnum<T extends string>(value: unknown, source: string, allowed: ReadonlyArray<T>): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`${source} must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

function readOptionalEnum<T extends string>(
	record: Record<string, unknown>,
	key: string,
	source: string,
	allowed: ReadonlyArray<T>,
): void {
	if (record[key] !== undefined) readEnum(record[key], `${source}.${key}`, allowed);
}

function readStringArray(value: unknown, source: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${source} must be an array`);
	return value.map((item, index) => readString(item, `${source}[${index}]`));
}

function readOptionalStringArray(record: Record<string, unknown>, key: string, source: string): void {
	if (record[key] !== undefined) readStringArray(record[key], `${source}.${key}`);
}

function validateEndpoint(value: unknown, runtimeId: string): void {
	const endpoint = readRecord(value, "WorkerSpec.endpoint");
	const endpointId = readString(endpoint.id, "WorkerSpec.endpoint.id");
	const endpointRuntime = readString(endpoint.runtime, "WorkerSpec.endpoint.runtime");
	if (endpointRuntime !== runtimeId) {
		throw new Error(`WorkerSpec endpoint runtime mismatch: endpoint.runtime=${endpointRuntime} runtimeId=${runtimeId}`);
	}
	if (endpointId.length === 0) throw new Error("WorkerSpec.endpoint.id must be a non-empty string");
	readOptionalString(endpoint, "url", "WorkerSpec.endpoint");
	readOptionalString(endpoint, "defaultModel", "WorkerSpec.endpoint");
	readOptionalStringArray(endpoint, "wireModels", "WorkerSpec.endpoint");
	readOptionalBoolean(endpoint, "gateway", "WorkerSpec.endpoint");
	readOptionalEnum(endpoint, "lifecycle", "WorkerSpec.endpoint", ENDPOINT_LIFECYCLES);
	if (endpoint.auth !== undefined) validateEndpointAuth(endpoint.auth);
	if (endpoint.pricing !== undefined) validateEndpointPricing(endpoint.pricing);
	if (endpoint.capabilities !== undefined)
		validateCapabilityPatch(endpoint.capabilities, "WorkerSpec.endpoint.capabilities");
}

function validateEndpointAuth(value: unknown): void {
	const auth = readRecord(value, "WorkerSpec.endpoint.auth");
	readOptionalString(auth, "apiKeyEnvVar", "WorkerSpec.endpoint.auth");
	readOptionalString(auth, "apiKeyRef", "WorkerSpec.endpoint.auth");
	readOptionalString(auth, "oauthProfile", "WorkerSpec.endpoint.auth");
	if (auth.headers === undefined) return;
	const headers = readRecord(auth.headers, "WorkerSpec.endpoint.auth.headers");
	for (const [key, value] of Object.entries(headers)) {
		readString(value, `WorkerSpec.endpoint.auth.headers.${key}`);
	}
}

function validateEndpointPricing(value: unknown): void {
	const pricing = readRecord(value, "WorkerSpec.endpoint.pricing");
	const input = pricing.input;
	const output = pricing.output;
	if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
		throw new Error("WorkerSpec.endpoint.pricing.input must be a non-negative finite number");
	}
	if (typeof output !== "number" || !Number.isFinite(output) || output < 0) {
		throw new Error("WorkerSpec.endpoint.pricing.output must be a non-negative finite number");
	}
	readOptionalNumber(pricing, "cacheRead", "WorkerSpec.endpoint.pricing");
	readOptionalNumber(pricing, "cacheWrite", "WorkerSpec.endpoint.pricing");
}

function validateCapabilityPatch(value: unknown, source: string): void {
	const caps = readRecord(value, source);
	for (const key of ["chat", "tools", "reasoning", "vision", "audio", "embeddings", "rerank", "fim"] as const) {
		readOptionalBoolean(caps, key, source);
	}
	for (const key of ["contextWindow", "maxTokens"] as const) {
		readOptionalNumber(caps, key, source);
	}
	for (const key of ["toolCallFormat", "thinkingFormat", "structuredOutputs"] as const) {
		readOptionalString(caps, key, source);
	}
}

function validateAllowedTools(value: unknown): void {
	for (const name of readStringArray(value, "WorkerSpec.allowedTools")) {
		if (name.trim().length === 0) throw new Error("WorkerSpec.allowedTools entries must be non-empty strings");
	}
}

function validateMiddlewareSnapshot(value: unknown): void {
	const snapshot = readRecord(value, "WorkerSpec.middlewareSnapshot");
	if (snapshot.version !== 1) throw new Error("WorkerSpec.middlewareSnapshot version must be 1");
	if (!Array.isArray(snapshot.rules)) throw new Error("WorkerSpec.middlewareSnapshot.rules must be an array");
	for (let index = 0; index < snapshot.rules.length; index += 1) {
		const source = `WorkerSpec.middlewareSnapshot.rules[${index}]`;
		const rule = readRecord(snapshot.rules[index], source);
		readString(rule.id, `${source}.id`);
		if (rule.source !== "builtin") throw new Error(`${source}.source must be builtin`);
		readString(rule.description, `${source}.description`);
		if (typeof rule.enabled !== "boolean") throw new Error(`${source}.enabled must be a boolean`);
		for (const hook of readStringArray(rule.hooks, `${source}.hooks`)) {
			readEnum(hook, `${source}.hooks[]`, MIDDLEWARE_HOOKS);
		}
		for (const kind of readStringArray(rule.effectKinds, `${source}.effectKinds`)) {
			readEnum(kind, `${source}.effectKinds[]`, MIDDLEWARE_EFFECT_KINDS);
		}
	}
}

export function parseWorkerSpec(value: unknown): WorkerSpec {
	const spec = readRecord(value, "WorkerSpec");
	if (spec.specVersion !== WORKER_SPEC_VERSION) {
		throw new Error(`WorkerSpec version ${String(spec.specVersion)} is unsupported; expected ${WORKER_SPEC_VERSION}`);
	}
	const runtime = readRecord(spec.runtime, "WorkerSpec.runtime");
	if (runtime.version !== WORKER_RUNTIME_DESCRIPTOR_VERSION) {
		throw new Error(
			`WorkerSpec.runtime version ${String(runtime.version)} is unsupported; expected ${WORKER_RUNTIME_DESCRIPTOR_VERSION}`,
		);
	}
	const runtimeId = readString(spec.runtimeId, "WorkerSpec.runtimeId");
	const runtimeRefId = readString(runtime.id, "WorkerSpec.runtime.id");
	if (runtimeId !== runtimeRefId) {
		throw new Error(`WorkerSpec runtime id mismatch: runtimeId=${runtimeId} runtime.id=${runtimeRefId}`);
	}
	readEnum(runtime.kind, "WorkerSpec.runtime.kind", RUNTIME_KINDS);
	readEnum(runtime.apiFamily, "WorkerSpec.runtime.apiFamily", RUNTIME_API_FAMILIES);
	readEnum(runtime.auth, "WorkerSpec.runtime.auth", RUNTIME_AUTHS);
	readString(spec.systemPrompt, "WorkerSpec.systemPrompt", { allowEmpty: true });
	readWorkerPromptMessages(spec.dynamicPromptMessages, "WorkerSpec.dynamicPromptMessages");
	readString(spec.task, "WorkerSpec.task");
	validateEndpoint(spec.endpoint, runtimeId);
	readString(spec.wireModelId, "WorkerSpec.wireModelId");
	readOptionalString(spec, "sessionId", "WorkerSpec");
	readOptionalString(spec, "apiKey", "WorkerSpec");
	readOptionalEnum(spec, "thinkingLevel", "WorkerSpec", THINKING_LEVELS);
	readOptionalEnum(spec, "mode", "WorkerSpec", MODE_NAMES);
	readOptionalEnum(spec, "autoApprove", "WorkerSpec", AUTO_APPROVE_VALUES);
	validateAllowedTools(spec.allowedTools);
	if (spec.modelCapabilities !== undefined)
		validateCapabilityPatch(spec.modelCapabilities, "WorkerSpec.modelCapabilities");
	if (spec.middlewareSnapshot !== undefined) validateMiddlewareSnapshot(spec.middlewareSnapshot);
	return spec as unknown as WorkerSpec;
}

export function validateRehydratedWorkerRuntime(spec: WorkerSpec, runtime: RuntimeDescriptor): void {
	const expected = spec.runtime;
	if (runtime.id !== expected.id) {
		throw new Error(`WorkerSpec runtime rehydration mismatch for id: expected ${expected.id}, got ${runtime.id}`);
	}
	if (runtime.kind !== expected.kind) {
		throw new Error(`WorkerSpec runtime rehydration mismatch for kind: expected ${expected.kind}, got ${runtime.kind}`);
	}
	if (runtime.apiFamily !== expected.apiFamily) {
		throw new Error(
			`WorkerSpec runtime rehydration mismatch for apiFamily: expected ${expected.apiFamily}, got ${runtime.apiFamily}`,
		);
	}
	if (runtime.auth !== expected.auth) {
		throw new Error(`WorkerSpec runtime rehydration mismatch for auth: expected ${expected.auth}, got ${runtime.auth}`);
	}
}
