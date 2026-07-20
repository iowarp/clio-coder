import { assertValidResponseSchema } from "../core/response-schema.js";
import type { ToolName } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import type {
	CapabilityFlags,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
	RuntimeTargetSnapshot,
	TargetDescriptor,
	ThinkingLevel,
} from "../domains/providers/index.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { ProtectedArtifact } from "../domains/safety/protected-artifacts.js";
import type { ToolProfileName } from "../tools/profiles.js";

/** Budget-free compatibility document accepted from pre-budget dispatchers. */
export const LEGACY_WORKER_SPEC_VERSION = 1;
/** Current budget-bearing dispatch document emitted by this release. */
export const WORKER_SPEC_VERSION = 2;
export const WORKER_RUNTIME_DESCRIPTOR_VERSION = 2;
export const WORKER_PROTECTED_ARTIFACT_STATE_VERSION = 1;

/**
 * Exit code a native worker uses to report that the run ended because a tool
 * call required interactive permission under workers.onPermission="fail".
 * The orchestrator's outcome resolver maps it to failed/permission_required.
 */
export const WORKER_EXIT_PERMISSION_REQUIRED = 3;

export interface SerializedWorkerRuntimeDescriptor {
	version: typeof WORKER_RUNTIME_DESCRIPTOR_VERSION;
	id: string;
	kind: RuntimeKind;
	apiFamily: RuntimeApiFamily;
	auth: RuntimeAuth;
}

/** Immutable, admission-time snapshot of the parent session's hard blocks. */
export interface WorkerProtectedArtifactState {
	version: typeof WORKER_PROTECTED_ARTIFACT_STATE_VERSION;
	artifacts: ReadonlyArray<ProtectedArtifact>;
}

/** Concrete dispatch-time budget after recipe policy and operator clamping. */
export interface WorkerBudget {
	/** Agent phase boundary before synthesis or bounded termination. */
	toolCalls: number;
	/** Tail of toolCalls reserved for canonical read calls. */
	readReserve: number;
	/** True enters text-only synthesis; false ends at the phase boundary. */
	synthesis: boolean;
	/** Independent operator-owned attempt ceiling; recipes cannot widen it. */
	hardCap: number;
}

interface WorkerSpecFields {
	systemPrompt: string;
	dynamicPromptMessages?: ReadonlyArray<WorkerPromptMessage>;
	promptSignature?: string;
	toolSignature?: string;
	dynamicHash?: string;
	agentId: string;
	task: string;
	target: TargetDescriptor;
	runtime: SerializedWorkerRuntimeDescriptor;
	/** Runtime id kept as a direct lookup key for older dispatch tests and receipts. */
	runtimeId: string;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	sessionId?: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
	/** JSON Schema enforced on the llama.cpp chat-completions request. */
	responseSchema?: Record<string, unknown>;
	/** Orchestrator-resolved effective runtime/capability decision for receipts and debugging. */
	runtimeResolution?: RuntimeTargetSnapshot;
	allowedTools: ReadonlyArray<ToolName>;
	middlewareSnapshot?: MiddlewareSnapshot;
	/** Parent-session protections frozen before placement and worker launch. */
	protectedArtifactState?: WorkerProtectedArtifactState;
	/**
	 * Wire model ids the operator's configuration references (orchestrator
	 * model, worker default/profile models, target default models). The worker
	 * seeds its residency layer with these so it never evicts another
	 * profile's model from a shared local server.
	 */
	protectedModels?: ReadonlyArray<string>;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	/** Skill names the agent recipe binds to this run; context(scope=skills) admits exactly these. */
	agentSkills?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
	/**
	 * Dispatch-time tool profile that narrowed `allowedTools`. Carried so
	 * black-box external CLI runtimes that cannot mediate per-tool calls can
	 * refuse a narrowing profile. Undefined or "full-agent" imposes no
	 * narrowing.
	 */
	toolProfile?: ToolProfileName;
	/**
	 * Non-stall posture for permission-requiring tool calls. "deny" converts
	 * the call into a structured tool denial and the run continues; "fail"
	 * aborts the run, which then exits with WORKER_EXIT_PERMISSION_REQUIRED;
	 * "escalate" parks the call, emits clio_permission_escalated, and waits for
	 * an operator permission_decision on stdin (falling back to the configured
	 * deny/fail on timeout). Default "deny".
	 */
	onPermission?: "deny" | "fail" | "escalate";
	/**
	 * Escalation bounds, honored only when onPermission="escalate". A parked
	 * call that receives no operator decision within timeoutMs applies fallback.
	 * Defaults: 120000 ms, "deny".
	 */
	escalation?: WorkerEscalationConfig;
	/**
	 * Session autonomy level captured at dispatch admission (sd-01 §2.5). The
	 * worker registry applies the same mapping as the orchestrator's, so a
	 * worker never acts more freely than the session that dispatched it.
	 * Default "auto-edit".
	 */
	autonomy?: AutonomyLevel;
	/**
	 * Absolute directories write-class tool calls are confined to for this run.
	 * Enforced at the shared worker safety seam so a write/edit target outside
	 * every root is a final block. Only set on runtimes that mediate per-tool
	 * calls (native, claude-sdk); dispatch refuses it on subprocess runtimes.
	 */
	writeRoots?: ReadonlyArray<string>;
}

/** Budget-free compatibility shape used only by pre-v2 dispatchers. */
export type LegacyWorkerSpec = WorkerSpecFields & {
	specVersion: typeof LEGACY_WORKER_SPEC_VERSION;
	budget?: never;
};

/** Current wire shape. Every v2 document carries its concrete admitted budget. */
export type CurrentWorkerSpec = WorkerSpecFields & {
	specVersion: typeof WORKER_SPEC_VERSION;
	budget: WorkerBudget;
};

export type WorkerSpec = LegacyWorkerSpec | CurrentWorkerSpec;

export interface WorkerPromptMessage {
	id: string;
	body: string;
	contentHash: string;
}

/** Bounds for the escalate posture; see WorkerSpec.escalation. */
export interface WorkerEscalationConfig {
	/** Wall-clock budget before the parked call applies the fallback. */
	timeoutMs: number;
	/** Posture applied when the operator does not decide within timeoutMs. */
	fallback: "deny" | "fail";
}

/** Default escalation bounds when onPermission="escalate" but no override is given. */
export const DEFAULT_ESCALATION_TIMEOUT_MS = 120_000;
export const DEFAULT_ESCALATION_FALLBACK: "deny" | "fail" = "deny";

const RUNTIME_KINDS = ["http", "sdk", "subprocess"] as const satisfies ReadonlyArray<RuntimeKind>;
const RUNTIME_API_FAMILIES = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"lmstudio-native",
	"mistral-conversations",
	"ollama-native",
	"rerank-http",
	"embeddings-http",
	"claude-agent-sdk",
	"claude-code-subprocess",
] as const satisfies ReadonlyArray<RuntimeApiFamily>;
const RUNTIME_AUTHS = [
	"api-key",
	"oauth",
	"aws-sdk",
	"vertex-adc",
	"claude-cli",
	"none",
] as const satisfies ReadonlyArray<RuntimeAuth>;
const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies ReadonlyArray<ThinkingLevel>;
const TOOL_PROFILE_NAMES = [
	"minimal-local",
	"science-local",
	"full-agent",
] as const satisfies ReadonlyArray<ToolProfileName>;
const TARGET_LIFECYCLES = ["user-managed", "clio-managed"] as const;
const MIDDLEWARE_HOOKS = ["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"] as const;
const MIDDLEWARE_EFFECT_KINDS = [
	"inject_reminder",
	"annotate_tool_result",
	"block_tool",
	"protect_path",
	"request_continuation",
	"require_tool",
	"lock_tools",
] as const;
const RUNTIME_RESOLUTION_SEVERITIES = ["info", "warning", "error"] as const;
const SPEC_AUTONOMY_LEVELS = [
	"read-only",
	"suggest",
	"auto-edit",
	"full-auto",
] as const satisfies ReadonlyArray<AutonomyLevel>;
const THINKING_MECHANISMS = ["effort-levels", "budget-tokens", "on-off", "always-on", "none"] as const;
const THINKING_BUDGET_ENFORCEMENTS = ["enforced", "informational", "none"] as const;
const THINKING_NOTICE_KINDS = ["applied", "ignored-on-off", "always-on", "unsupported"] as const;

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

function validateTarget(value: unknown, runtimeId: string): void {
	const target = readRecord(value, "WorkerSpec.target");
	const targetId = readString(target.id, "WorkerSpec.target.id");
	const targetRuntime = readString(target.runtime, "WorkerSpec.target.runtime");
	if (targetRuntime !== runtimeId) {
		throw new Error(`WorkerSpec target runtime mismatch: target.runtime=${targetRuntime} runtimeId=${runtimeId}`);
	}
	if (targetId.length === 0) throw new Error("WorkerSpec.target.id must be a non-empty string");
	readOptionalString(target, "url", "WorkerSpec.target");
	readOptionalString(target, "defaultModel", "WorkerSpec.target");
	readOptionalStringArray(target, "wireModels", "WorkerSpec.target");
	readOptionalBoolean(target, "gateway", "WorkerSpec.target");
	readOptionalEnum(target, "lifecycle", "WorkerSpec.target", TARGET_LIFECYCLES);
	if (target.auth !== undefined) validateTargetAuth(target.auth);
	if (target.pricing !== undefined) validateTargetPricing(target.pricing);
	if (target.capabilities !== undefined) validateCapabilityPatch(target.capabilities, "WorkerSpec.target.capabilities");
}

function validateTargetAuth(value: unknown): void {
	const auth = readRecord(value, "WorkerSpec.target.auth");
	readOptionalString(auth, "apiKeyEnvVar", "WorkerSpec.target.auth");
	readOptionalString(auth, "apiKeyRef", "WorkerSpec.target.auth");
	readOptionalString(auth, "oauthProfile", "WorkerSpec.target.auth");
	if (auth.headers === undefined) return;
	const headers = readRecord(auth.headers, "WorkerSpec.target.auth.headers");
	for (const [key, value] of Object.entries(headers)) {
		readString(value, `WorkerSpec.target.auth.headers.${key}`);
	}
}

function validateTargetPricing(value: unknown): void {
	const pricing = readRecord(value, "WorkerSpec.target.pricing");
	const input = pricing.input;
	const output = pricing.output;
	if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
		throw new Error("WorkerSpec.target.pricing.input must be a non-negative finite number");
	}
	if (typeof output !== "number" || !Number.isFinite(output) || output < 0) {
		throw new Error("WorkerSpec.target.pricing.output must be a non-negative finite number");
	}
	readOptionalNumber(pricing, "cacheRead", "WorkerSpec.target.pricing");
	readOptionalNumber(pricing, "cacheWrite", "WorkerSpec.target.pricing");
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

function validateWorkerBudget(value: unknown): void {
	if (value === undefined) return;
	const budget = readRecord(value, "WorkerSpec.budget");
	const expected = ["hardCap", "readReserve", "synthesis", "toolCalls"];
	const actual = Object.keys(budget).sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`WorkerSpec.budget must contain exactly: ${expected.join(", ")}`);
	}
	for (const key of ["toolCalls", "readReserve", "hardCap"] as const) {
		const value = budget[key];
		if (typeof value !== "number" || !Number.isSafeInteger(value)) {
			throw new Error(`WorkerSpec.budget.${key} must be a safe integer`);
		}
	}
	if ((budget.toolCalls as number) <= 0) throw new Error("WorkerSpec.budget.toolCalls must be greater than zero");
	if ((budget.hardCap as number) <= 0) throw new Error("WorkerSpec.budget.hardCap must be greater than zero");
	if ((budget.toolCalls as number) > (budget.hardCap as number)) {
		throw new Error("WorkerSpec.budget.toolCalls must not exceed WorkerSpec.budget.hardCap");
	}
	if ((budget.readReserve as number) < 0 || (budget.readReserve as number) >= (budget.toolCalls as number)) {
		throw new Error("WorkerSpec.budget.readReserve must be an integer in [0, toolCalls)");
	}
	if (typeof budget.synthesis !== "boolean") throw new Error("WorkerSpec.budget.synthesis must be a boolean");
}

function validateRuntimeCapabilityDecision(value: unknown, source: string): void {
	const caps = readRecord(value, source);
	for (const key of ["chat", "tools", "reasoning", "vision", "streaming"] as const) {
		if (typeof caps[key] !== "boolean") throw new Error(`${source}.${key} must be a boolean`);
	}
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const n = caps[key];
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
			throw new Error(`${source}.${key} must be a non-negative finite number`);
	}
}

function validateRuntimeResolution(value: unknown): void {
	if (value === undefined) return;
	const resolution = readRecord(value, "WorkerSpec.runtimeResolution");
	readString(resolution.targetId, "WorkerSpec.runtimeResolution.targetId");
	readString(resolution.runtimeId, "WorkerSpec.runtimeResolution.runtimeId");
	readEnum(resolution.runtimeKind, "WorkerSpec.runtimeResolution.runtimeKind", RUNTIME_KINDS);
	readEnum(resolution.apiFamily, "WorkerSpec.runtimeResolution.apiFamily", RUNTIME_API_FAMILIES);
	readEnum(resolution.auth, "WorkerSpec.runtimeResolution.auth", RUNTIME_AUTHS);
	if (typeof resolution.authRequired !== "boolean") {
		throw new Error("WorkerSpec.runtimeResolution.authRequired must be a boolean");
	}
	readString(resolution.wireModelId, "WorkerSpec.runtimeResolution.wireModelId");
	readEnum(resolution.requestedThinkingLevel, "WorkerSpec.runtimeResolution.requestedThinkingLevel", THINKING_LEVELS);
	readEnum(resolution.effectiveThinkingLevel, "WorkerSpec.runtimeResolution.effectiveThinkingLevel", THINKING_LEVELS);
	validateRuntimeCapabilityDecision(resolution.capabilities, "WorkerSpec.runtimeResolution.capabilities");
	const thinking = readRecord(resolution.thinking, "WorkerSpec.runtimeResolution.thinking");
	readEnum(thinking.mechanism, "WorkerSpec.runtimeResolution.thinking.mechanism", THINKING_MECHANISMS);
	readString(thinking.display, "WorkerSpec.runtimeResolution.thinking.display", { allowEmpty: true });
	for (const level of readStringArray(
		thinking.supportedLevels,
		"WorkerSpec.runtimeResolution.thinking.supportedLevels",
	)) {
		readEnum(level, "WorkerSpec.runtimeResolution.thinking.supportedLevels[]", THINKING_LEVELS);
	}
	readEnum(
		thinking.budgetEnforcement,
		"WorkerSpec.runtimeResolution.thinking.budgetEnforcement",
		THINKING_BUDGET_ENFORCEMENTS,
	);
	readEnum(thinking.noticeKind, "WorkerSpec.runtimeResolution.thinking.noticeKind", THINKING_NOTICE_KINDS);
	readString(thinking.notice, "WorkerSpec.runtimeResolution.thinking.notice", { allowEmpty: true });
	readRecord(resolution.request, "WorkerSpec.runtimeResolution.request");
	readRecord(resolution.response, "WorkerSpec.runtimeResolution.response");
	if (!Array.isArray(resolution.diagnostics)) {
		throw new Error("WorkerSpec.runtimeResolution.diagnostics must be an array");
	}
	for (let index = 0; index < resolution.diagnostics.length; index += 1) {
		const diag = readRecord(resolution.diagnostics[index], `WorkerSpec.runtimeResolution.diagnostics[${index}]`);
		readEnum(diag.severity, `WorkerSpec.runtimeResolution.diagnostics[${index}].severity`, RUNTIME_RESOLUTION_SEVERITIES);
		readString(diag.code, `WorkerSpec.runtimeResolution.diagnostics[${index}].code`);
		readString(diag.message, `WorkerSpec.runtimeResolution.diagnostics[${index}].message`);
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

function validateProtectedArtifactState(value: unknown): void {
	const state = readRecord(value, "WorkerSpec.protectedArtifactState");
	if (state.version !== WORKER_PROTECTED_ARTIFACT_STATE_VERSION) {
		throw new Error(
			`WorkerSpec.protectedArtifactState version ${String(state.version)} is unsupported; expected ${WORKER_PROTECTED_ARTIFACT_STATE_VERSION}`,
		);
	}
	if (!Array.isArray(state.artifacts)) {
		throw new Error("WorkerSpec.protectedArtifactState.artifacts must be an array");
	}
	const sources = ["validation", "middleware", "user", "session"] as const;
	for (let index = 0; index < state.artifacts.length; index += 1) {
		const source = `WorkerSpec.protectedArtifactState.artifacts[${index}]`;
		const artifact = readRecord(state.artifacts[index], source);
		readString(artifact.path, `${source}.path`);
		readString(artifact.protectedAt, `${source}.protectedAt`);
		readString(artifact.reason, `${source}.reason`);
		readEnum(artifact.source, `${source}.source`, sources);
		readOptionalString(artifact, "validationCommand", source);
		readOptionalNumber(artifact, "validationExitCode", source);
	}
}

export function parseWorkerSpec(value: unknown): WorkerSpec {
	const spec = readRecord(value, "WorkerSpec");
	if (spec.specVersion !== LEGACY_WORKER_SPEC_VERSION && spec.specVersion !== WORKER_SPEC_VERSION) {
		throw new Error(
			`WorkerSpec version ${String(spec.specVersion)} is unsupported; expected ${LEGACY_WORKER_SPEC_VERSION} or ${WORKER_SPEC_VERSION}`,
		);
	}
	if (spec.specVersion === LEGACY_WORKER_SPEC_VERSION && spec.budget !== undefined) {
		throw new Error("WorkerSpec version 1 is the budget-free legacy compatibility form and must not include budget");
	}
	if (spec.specVersion === WORKER_SPEC_VERSION && spec.budget === undefined) {
		throw new Error(`WorkerSpec version ${WORKER_SPEC_VERSION} requires budget`);
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
	readOptionalString(spec, "promptSignature", "WorkerSpec");
	readOptionalString(spec, "toolSignature", "WorkerSpec");
	readOptionalString(spec, "dynamicHash", "WorkerSpec");
	readString(spec.agentId, "WorkerSpec.agentId");
	readString(spec.task, "WorkerSpec.task");
	validateTarget(spec.target, runtimeId);
	readString(spec.wireModelId, "WorkerSpec.wireModelId");
	readOptionalString(spec, "sessionId", "WorkerSpec");
	readOptionalString(spec, "apiKey", "WorkerSpec");
	readOptionalEnum(spec, "thinkingLevel", "WorkerSpec", THINKING_LEVELS);
	if (spec.modelCapabilities !== undefined)
		validateCapabilityPatch(spec.modelCapabilities, "WorkerSpec.modelCapabilities");
	if (spec.responseSchema !== undefined) {
		assertValidResponseSchema(spec.responseSchema, "WorkerSpec.responseSchema");
		if (runtimeId !== "llamacpp" || runtime.kind !== "http" || runtime.apiFamily !== "openai-completions") {
			throw new Error("WorkerSpec.responseSchema is supported only by the native llamacpp runtime");
		}
		const structuredOutputs =
			spec.modelCapabilities === undefined
				? undefined
				: readRecord(spec.modelCapabilities, "WorkerSpec.modelCapabilities").structuredOutputs;
		if (structuredOutputs !== "json-schema") {
			throw new Error("WorkerSpec.responseSchema requires resolved JSON-schema model capability");
		}
	}
	validateAllowedTools(spec.allowedTools);
	validateWorkerBudget(spec.budget);
	readOptionalStringArray(spec, "protectedModels", "WorkerSpec");
	validateRuntimeResolution(spec.runtimeResolution);
	if (spec.middlewareSnapshot !== undefined) validateMiddlewareSnapshot(spec.middlewareSnapshot);
	if (spec.protectedArtifactState !== undefined) validateProtectedArtifactState(spec.protectedArtifactState);
	if (spec.noSkills !== undefined && typeof spec.noSkills !== "boolean") {
		throw new Error("WorkerSpec.noSkills must be a boolean");
	}
	if (spec.skillPaths !== undefined) {
		readStringArray(spec.skillPaths, "WorkerSpec.skillPaths");
	}
	if (spec.agentSkills !== undefined) {
		for (const name of readStringArray(spec.agentSkills, "WorkerSpec.agentSkills")) {
			if (name.trim().length === 0) throw new Error("WorkerSpec.agentSkills entries must be non-empty strings");
		}
	}
	if (spec.trustProjectCompatRoots !== undefined && typeof spec.trustProjectCompatRoots !== "boolean") {
		throw new Error("WorkerSpec.trustProjectCompatRoots must be a boolean");
	}
	readOptionalEnum(spec, "toolProfile", "WorkerSpec", TOOL_PROFILE_NAMES);
	if (
		spec.onPermission !== undefined &&
		spec.onPermission !== "deny" &&
		spec.onPermission !== "fail" &&
		spec.onPermission !== "escalate"
	) {
		throw new Error('WorkerSpec.onPermission must be "deny", "fail", or "escalate"');
	}
	if (spec.escalation !== undefined) {
		const escalation = readRecord(spec.escalation, "WorkerSpec.escalation");
		const timeoutMs = escalation.timeoutMs;
		if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new Error("WorkerSpec.escalation.timeoutMs must be a positive finite number");
		}
		if (escalation.fallback !== "deny" && escalation.fallback !== "fail") {
			throw new Error('WorkerSpec.escalation.fallback must be "deny" or "fail"');
		}
	}
	if (spec.autonomy !== undefined) {
		readEnum(spec.autonomy, "WorkerSpec.autonomy", SPEC_AUTONOMY_LEVELS);
	}
	if (spec.writeRoots !== undefined) {
		const roots = readStringArray(spec.writeRoots, "WorkerSpec.writeRoots");
		if (roots.length === 0) throw new Error("WorkerSpec.writeRoots must be a non-empty array when present");
		for (const root of roots) {
			if (root.trim().length === 0) throw new Error("WorkerSpec.writeRoots entries must be non-empty strings");
		}
	}
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
