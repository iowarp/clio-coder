/**
 * Validate a dispatch job spec before it enters the queue. Pure function, no
 * I/O. Accepts unknown input so callers can hand it raw JSON or CLI args
 * without a prior cast. Returns a discriminated union so the caller branches
 * on `ok` and gets either the typed spec or the list of reasons it failed.
 */

import path from "node:path";
import { isToolProfileName, type ToolProfileName } from "../../tools/profiles.js";
import type { DispatchRequestOrigin, RunLineage } from "./types.js";

export type JobThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Data threaded from one pipeline step to the next. `fromRunId` is the source
 * run (null when unknown), `position` is the 1-based index of the receiving
 * step, and `text` is the source's final assistant output (empty allowed; an
 * empty previous output still threads with an explicit empty marker so the
 * chain stays deterministic).
 */
export interface PipelineInput {
	fromRunId: string | null;
	position: number;
	text: string;
}

export interface JobSpec {
	agentId: string;
	task: string;
	workerProfile?: string;
	workerRuntime?: string;
	delegationAgentId?: string;
	target?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	requiredCapabilities?: ReadonlyArray<string>;
	toolProfile?: ToolProfileName;
	cwd?: string;
	memorySection?: string;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
	/**
	 * Absolute directories write-class tool calls are confined to for this run.
	 * Resolved against the job cwd at validation time. Enforced at the worker
	 * safety seam; dispatch admission refuses it on runtimes that cannot mediate
	 * per-tool calls (subprocess).
	 */
	writeRoots?: ReadonlyArray<string>;
	requestOrigin?: DispatchRequestOrigin;
	/**
	 * Threaded output from the previous pipeline step. Set only by the dispatch
	 * tool's pipeline mode; step 1 and all non-pipeline runs omit it. The text
	 * is delivered to the worker as data through the dynamic-message channel,
	 * never substituted into the task string.
	 */
	pipelineInput?: PipelineInput;
	/**
	 * Caller-supplied lineage for retries and nested dispatch (fleet steps).
	 * Omitted for root runs; the dispatch extension then mints a root lineage
	 * with rootRunId = the new run's own id.
	 */
	lineage?: RunLineage;
}

type Validated = { ok: true; spec: JobSpec } | { ok: false; errors: string[] };

const KNOWN_KEYS = new Set([
	"agentId",
	"task",
	"workerProfile",
	"workerRuntime",
	"delegationAgentId",
	"target",
	"model",
	"thinkingLevel",
	"requiredCapabilities",
	"toolProfile",
	"cwd",
	"memorySection",
	"noSkills",
	"skillPaths",
	"trustProjectCompatRoots",
	"writeRoots",
	"requestOrigin",
	"pipelineInput",
	"lineage",
]);
const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_REQUEST_ORIGINS = new Set(["user", "agent", "internal"]);

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

	if ("target" in spec && spec.target !== undefined) {
		if (typeof spec.target !== "string" || spec.target.length === 0) {
			errors.push("target must be a non-empty string");
		}
	}

	if ("workerProfile" in spec && spec.workerProfile !== undefined) {
		if (typeof spec.workerProfile !== "string" || spec.workerProfile.length === 0) {
			errors.push("workerProfile must be a non-empty string");
		}
	}

	if ("workerRuntime" in spec && spec.workerRuntime !== undefined) {
		if (typeof spec.workerRuntime !== "string" || spec.workerRuntime.length === 0) {
			errors.push("workerRuntime must be a non-empty string");
		}
	}

	if ("delegationAgentId" in spec && spec.delegationAgentId !== undefined) {
		if (typeof spec.delegationAgentId !== "string" || spec.delegationAgentId.length === 0) {
			errors.push("delegationAgentId must be a non-empty string");
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

	if ("toolProfile" in spec && spec.toolProfile !== undefined) {
		if (typeof spec.toolProfile !== "string" || !isToolProfileName(spec.toolProfile)) {
			errors.push("toolProfile must be one of: minimal-local|science-local|full-agent");
		}
	}

	if ("cwd" in spec && spec.cwd !== undefined) {
		if (typeof spec.cwd !== "string" || spec.cwd.length === 0) {
			errors.push("cwd must be a non-empty string");
		}
	}

	if ("memorySection" in spec && spec.memorySection !== undefined) {
		if (typeof spec.memorySection !== "string") {
			errors.push("memorySection must be a string");
		}
	}

	if ("noSkills" in spec && spec.noSkills !== undefined) {
		if (typeof spec.noSkills !== "boolean") {
			errors.push("noSkills must be a boolean");
		}
	}

	if ("skillPaths" in spec && spec.skillPaths !== undefined) {
		if (!Array.isArray(spec.skillPaths) || spec.skillPaths.some((p) => typeof p !== "string")) {
			errors.push("skillPaths must be a string[]");
		}
	}

	if ("trustProjectCompatRoots" in spec && spec.trustProjectCompatRoots !== undefined) {
		if (typeof spec.trustProjectCompatRoots !== "boolean") {
			errors.push("trustProjectCompatRoots must be a boolean");
		}
	}

	if ("writeRoots" in spec && spec.writeRoots !== undefined) {
		if (
			!Array.isArray(spec.writeRoots) ||
			spec.writeRoots.length === 0 ||
			spec.writeRoots.some((root) => typeof root !== "string" || root.length === 0)
		) {
			errors.push("writeRoots must be a non-empty array of non-empty strings");
		}
	}

	if ("requestOrigin" in spec && spec.requestOrigin !== undefined) {
		if (typeof spec.requestOrigin !== "string" || !VALID_REQUEST_ORIGINS.has(spec.requestOrigin)) {
			errors.push("requestOrigin must be one of: user|agent|internal");
		}
	}

	if ("pipelineInput" in spec && spec.pipelineInput !== undefined) {
		if (!isValidPipelineInput(spec.pipelineInput)) {
			errors.push("pipelineInput must carry fromRunId (string|null), position (integer >= 1), text (string)");
		}
	}

	if ("lineage" in spec && spec.lineage !== undefined) {
		if (!isValidLineage(spec.lineage)) {
			errors.push("lineage must carry parentRunId (string|null), rootRunId (string), attempt >= 0, depth >= 0");
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const out: JobSpec = {
		agentId: agentId as string,
		task: task as string,
	};
	if (typeof spec.workerProfile === "string") out.workerProfile = spec.workerProfile;
	if (typeof spec.workerRuntime === "string") out.workerRuntime = spec.workerRuntime;
	if (typeof spec.delegationAgentId === "string") out.delegationAgentId = spec.delegationAgentId;
	if (typeof spec.target === "string") out.target = spec.target;
	if (typeof spec.model === "string") out.model = spec.model;
	if (typeof spec.thinkingLevel === "string") out.thinkingLevel = spec.thinkingLevel as JobThinkingLevel;
	if (Array.isArray(spec.requiredCapabilities)) {
		out.requiredCapabilities = spec.requiredCapabilities.map((c) => String(c));
	}
	if (typeof spec.toolProfile === "string" && isToolProfileName(spec.toolProfile)) out.toolProfile = spec.toolProfile;
	if (typeof spec.cwd === "string") out.cwd = spec.cwd;
	if (typeof spec.memorySection === "string") out.memorySection = spec.memorySection;
	if (typeof spec.noSkills === "boolean") out.noSkills = spec.noSkills;
	if (Array.isArray(spec.skillPaths)) out.skillPaths = spec.skillPaths.map((p) => String(p));
	if (typeof spec.trustProjectCompatRoots === "boolean") out.trustProjectCompatRoots = spec.trustProjectCompatRoots;
	if (
		Array.isArray(spec.writeRoots) &&
		spec.writeRoots.length > 0 &&
		spec.writeRoots.every((root) => typeof root === "string" && root.length > 0)
	) {
		const jobCwd = typeof spec.cwd === "string" && spec.cwd.length > 0 ? spec.cwd : process.cwd();
		out.writeRoots = spec.writeRoots.map((root) => path.resolve(jobCwd, String(root)));
	}
	if (typeof spec.requestOrigin === "string" && VALID_REQUEST_ORIGINS.has(spec.requestOrigin)) {
		out.requestOrigin = spec.requestOrigin as DispatchRequestOrigin;
	}
	if (isValidPipelineInput(spec.pipelineInput)) out.pipelineInput = spec.pipelineInput;
	if (isValidLineage(spec.lineage)) out.lineage = spec.lineage;
	return { ok: true, spec: out };
}

function isValidPipelineInput(value: unknown): value is PipelineInput {
	if (!isPlainObject(value)) return false;
	const fromRunOk = value.fromRunId === null || (typeof value.fromRunId === "string" && value.fromRunId.length > 0);
	const positionOk = typeof value.position === "number" && Number.isInteger(value.position) && value.position >= 1;
	const textOk = typeof value.text === "string";
	return fromRunOk && positionOk && textOk;
}

function isValidLineage(value: unknown): value is RunLineage {
	if (!isPlainObject(value)) return false;
	const parentOk = value.parentRunId === null || (typeof value.parentRunId === "string" && value.parentRunId.length > 0);
	const rootOk = typeof value.rootRunId === "string" && value.rootRunId.length > 0;
	const attemptOk = typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 0;
	const depthOk = typeof value.depth === "number" && Number.isInteger(value.depth) && value.depth >= 0;
	return parentOk && rootOk && attemptOk && depthOk;
}
