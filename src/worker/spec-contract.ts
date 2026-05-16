import type { ToolName } from "../core/tool-names.js";
import type { MiddlewareSnapshot } from "../domains/middleware/index.js";
import type {
	CapabilityFlags,
	EndpointDescriptor,
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
	ThinkingLevel,
} from "../domains/providers/index.js";
import type { SelfDevMode } from "../selfdev/mode.js";

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
	allowedTools?: ReadonlyArray<ToolName>;
	mode?: string;
	middlewareSnapshot?: MiddlewareSnapshot;
	selfDev?: SelfDevMode;
	supervised?: boolean;
	autoApprove?: "allow" | "deny";
}

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

function readString(value: unknown, source: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${source} must be a non-empty string`);
	return value;
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
