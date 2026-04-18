/**
 * Validate a dispatch job spec before it enters the queue. Pure function, no
 * I/O. Accepts unknown input so callers can hand it raw JSON or CLI args
 * without a prior cast. Returns a discriminated union so the caller branches
 * on `ok` and gets either the typed spec or the list of reasons it failed.
 */

export type JobThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface JobSpec {
	agentId: string;
	task: string;
	endpoint?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	requiredCapabilities?: ReadonlyArray<string>;
	cwd?: string;
}

type Validated = { ok: true; spec: JobSpec } | { ok: false; errors: string[] };

const KNOWN_KEYS = new Set(["agentId", "task", "endpoint", "model", "thinkingLevel", "requiredCapabilities", "cwd"]);
const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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

	if ("endpoint" in spec && spec.endpoint !== undefined) {
		if (typeof spec.endpoint !== "string" || spec.endpoint.length === 0) {
			errors.push("endpoint must be a non-empty string");
		}
	}

	if ("model" in spec && spec.model !== undefined) {
		if (typeof spec.model !== "string" || spec.model.length === 0) {
			errors.push("model must be a non-empty string");
		}
	}

	if ("thinkingLevel" in spec && spec.thinkingLevel !== undefined) {
		if (typeof spec.thinkingLevel !== "string" || !VALID_THINKING.has(spec.thinkingLevel)) {
			errors.push("thinkingLevel must be one of: off|minimal|low|medium|high|xhigh");
		}
	}

	if ("requiredCapabilities" in spec && spec.requiredCapabilities !== undefined) {
		if (!Array.isArray(spec.requiredCapabilities) || spec.requiredCapabilities.some((c) => typeof c !== "string")) {
			errors.push("requiredCapabilities must be a string[]");
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
	if (typeof spec.endpoint === "string") out.endpoint = spec.endpoint;
	if (typeof spec.model === "string") out.model = spec.model;
	if (typeof spec.thinkingLevel === "string") out.thinkingLevel = spec.thinkingLevel as JobThinkingLevel;
	if (Array.isArray(spec.requiredCapabilities)) {
		out.requiredCapabilities = spec.requiredCapabilities.map((c) => String(c));
	}
	if (typeof spec.cwd === "string") out.cwd = spec.cwd;
	return { ok: true, spec: out };
}
