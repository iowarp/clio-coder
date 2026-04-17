/**
 * Validate a dispatch job spec before it enters the queue. Pure function, no
 * I/O. Accepts unknown input so callers can hand it raw JSON or CLI args
 * without a prior cast. Returns a discriminated union so the caller branches
 * on `ok` and gets either the typed spec or the list of reasons it failed.
 */

export interface JobSpec {
	agentId: string;
	task: string;
	runtime?: "native";
	providerId?: string;
	modelId?: string;
	endpoint?: string;
	cwd?: string;
}

type Validated = { ok: true; spec: JobSpec } | { ok: false; errors: string[] };

const KNOWN_KEYS = new Set(["agentId", "task", "runtime", "providerId", "modelId", "endpoint", "cwd"]);
const RUNTIME_VALUES = new Set(["native"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateJobSpec(spec: unknown): Validated {
	const errors: string[] = [];

	if (!isPlainObject(spec)) {
		return { ok: false, errors: ["spec must be an object"] };
	}

	for (const key of Object.keys(spec)) {
		if (!KNOWN_KEYS.has(key)) {
			errors.push(`unknown key: ${key}`);
		}
	}

	const agentId = spec.agentId;
	if (typeof agentId !== "string" || agentId.length === 0) {
		errors.push("agentId must be a non-empty string");
	}

	const task = spec.task;
	if (typeof task !== "string" || task.length === 0) {
		errors.push("task must be a non-empty string");
	}

	if ("runtime" in spec && spec.runtime !== undefined) {
		if (spec.runtime === "sdk" || spec.runtime === "cli") {
			errors.push(`runtime=${spec.runtime} not supported in v0.1`);
		} else if (typeof spec.runtime !== "string" || !RUNTIME_VALUES.has(spec.runtime)) {
			errors.push("runtime must be one of: native");
		}
	}

	if ("providerId" in spec && spec.providerId !== undefined) {
		if (typeof spec.providerId !== "string" || spec.providerId.length === 0) {
			errors.push("providerId must be a non-empty string");
		}
	}

	if ("modelId" in spec && spec.modelId !== undefined) {
		if (typeof spec.modelId !== "string" || spec.modelId.length === 0) {
			errors.push("modelId must be a non-empty string");
		}
	}

	if ("endpoint" in spec && spec.endpoint !== undefined) {
		if (typeof spec.endpoint !== "string" || spec.endpoint.length === 0) {
			errors.push("endpoint must be a non-empty string");
		}
	}

	if ("cwd" in spec && spec.cwd !== undefined) {
		if (typeof spec.cwd !== "string" || spec.cwd.length === 0) {
			errors.push("cwd must be a non-empty string");
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const out: JobSpec = {
		agentId: agentId as string,
		task: task as string,
	};
	if (typeof spec.runtime === "string") out.runtime = spec.runtime as Exclude<JobSpec["runtime"], undefined>;
	if (typeof spec.providerId === "string") out.providerId = spec.providerId;
	if (typeof spec.modelId === "string") out.modelId = spec.modelId;
	if (typeof spec.endpoint === "string") out.endpoint = spec.endpoint;
	if (typeof spec.cwd === "string") out.cwd = spec.cwd;
	return { ok: true, spec: out };
}
