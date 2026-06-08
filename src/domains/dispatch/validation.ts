/**
 * Validate a dispatch job spec before it enters the queue. Pure function, no
 * I/O. Accepts unknown input so callers can hand it raw JSON or CLI args
 * without a prior cast. Returns a discriminated union so the caller branches
 * on `ok` and gets either the typed spec or the list of reasons it failed.
 */

import { isToolProfileName, type ToolProfileName } from "../../tools/profiles.js";
import type { DispatchRequestOrigin } from "./types.js";

export type JobThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface JobSpec {
	agentId: string;
	task: string;
	workerProfile?: string;
	workerRuntime?: string;
	delegationAgentId?: string;
	endpoint?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	requiredCapabilities?: ReadonlyArray<string>;
	toolProfile?: ToolProfileName;
	cwd?: string;
	memorySection?: string;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
	requestOrigin?: DispatchRequestOrigin;
}

type Validated = { ok: true; spec: JobSpec } | { ok: false; errors: string[] };

const KNOWN_KEYS = new Set([
	"agentId",
	"task",
	"workerProfile",
	"workerRuntime",
	"delegationAgentId",
	"endpoint",
	"model",
	"thinkingLevel",
	"requiredCapabilities",
	"toolProfile",
	"cwd",
	"memorySection",
	"noSkills",
	"skillPaths",
	"trustProjectCompatRoots",
	"requestOrigin",
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

	if ("endpoint" in spec && spec.endpoint !== undefined) {
		if (typeof spec.endpoint !== "string" || spec.endpoint.length === 0) {
			errors.push("endpoint must be a non-empty string");
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

	if ("requestOrigin" in spec && spec.requestOrigin !== undefined) {
		if (typeof spec.requestOrigin !== "string" || !VALID_REQUEST_ORIGINS.has(spec.requestOrigin)) {
			errors.push("requestOrigin must be one of: user|agent|internal");
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
	if (typeof spec.endpoint === "string") out.endpoint = spec.endpoint;
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
	if (typeof spec.requestOrigin === "string" && VALID_REQUEST_ORIGINS.has(spec.requestOrigin)) {
		out.requestOrigin = spec.requestOrigin as DispatchRequestOrigin;
	}
	return { ok: true, spec: out };
}
