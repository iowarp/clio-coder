/**
 * Validate a dispatch job spec before it enters the queue. Pure function, no
 * I/O. Accepts unknown input so callers can hand it raw JSON or CLI args
 * without a prior cast. Returns a discriminated union so the caller branches
 * on `ok` and gets either the typed spec or the list of reasons it failed.
 */

import path from "node:path";
import { cloneValidatedResponseSchema } from "../../core/response-schema.js";
import { isToolProfileName, type ToolProfileName } from "../../tools/profiles.js";
import { type AutonomyLevel, isAutonomyLevel } from "../safety/autonomy.js";
import type {
	DispatchRequestOrigin,
	RunGateProvenance,
	RunLineage,
	RunNodeIdentity,
	RunNodeReroute,
	RunPlanProvenance,
} from "./types.js";

export type JobThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Maximum UTF-8 size of caller-supplied parent-to-worker briefing data. */
export const DISPATCH_BRIEFING_MAX_BYTES = 12_000;

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

export interface ProtectedArtifactPathRemap {
	sourceRoot: string;
	workerRoot: string;
}

export interface JobSpec {
	agentId: string;
	task: string;
	/** Bounded parent-composed context delivered as untrusted dynamic task data. */
	briefing?: string;
	workerProfile?: string;
	workerRuntime?: string;
	delegationAgentId?: string;
	target?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	/** Explicit fleet node pin; `local` or a configured fleet.nodes id. */
	node?: string;
	/** Immutable plan-time node identity. Internal dispatch-tool field, never model-authored. */
	plannedNode?: RunNodeIdentity;
	/** Internal compete-worktree mapping that only expands inherited hard blocks. */
	protectedArtifactRemap?: ProtectedArtifactPathRemap;
	/**
	 * Failover lineage threaded by the internal retry path when a node was
	 * classified dead. Hops arrive with an empty toNode; placement fills it
	 * when the rerouted run lands. Never set by external callers.
	 */
	reroutes?: RunNodeReroute[];
	requiredCapabilities?: ReadonlyArray<string>;
	toolProfile?: ToolProfileName;
	cwd?: string;
	memorySection?: string;
	noSkills?: boolean;
	skillPaths?: ReadonlyArray<string>;
	trustProjectCompatRoots?: boolean;
	/** JSON Schema enforced by a supported native worker runtime for the final response. */
	responseSchema?: Record<string, unknown>;
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
	/**
	 * Per-run autonomy narrowing. Admission clamps the worker's effective
	 * autonomy to the LOWER of this and the session level, so a request can
	 * make a reviewer or judge read-only but can never grant a worker more
	 * authority than the orchestrator holds.
	 */
	autonomy?: AutonomyLevel;
	/** Review/compete gate provenance sealed into the run's receipt. */
	gate?: RunGateProvenance;
	/** Plan-approval provenance sealed into the run's receipt. */
	plan?: RunPlanProvenance;
}

type Validated = { ok: true; spec: JobSpec } | { ok: false; errors: string[] };

const KNOWN_KEYS = new Set([
	"agentId",
	"task",
	"briefing",
	"workerProfile",
	"workerRuntime",
	"delegationAgentId",
	"target",
	"model",
	"thinkingLevel",
	"node",
	"plannedNode",
	"protectedArtifactRemap",
	"reroutes",
	"requiredCapabilities",
	"toolProfile",
	"cwd",
	"memorySection",
	"noSkills",
	"skillPaths",
	"trustProjectCompatRoots",
	"responseSchema",
	"writeRoots",
	"requestOrigin",
	"pipelineInput",
	"lineage",
	"autonomy",
	"gate",
	"plan",
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

	let briefing: string | undefined;
	if ("briefing" in spec && spec.briefing !== undefined) {
		if (typeof spec.briefing !== "string") {
			errors.push("briefing must be a string");
		} else {
			const normalized = spec.briefing.trim();
			if (normalized.length > 0) {
				const bytes = Buffer.byteLength(normalized, "utf8");
				if (bytes > DISPATCH_BRIEFING_MAX_BYTES) {
					errors.push(`briefing must be ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes or fewer`);
				} else {
					briefing = normalized;
				}
			}
		}
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

	if ("node" in spec && spec.node !== undefined) {
		if (typeof spec.node !== "string" || spec.node.trim().length === 0) {
			errors.push("node must be a non-empty string");
		}
	}

	if ("plannedNode" in spec && spec.plannedNode !== undefined) {
		if (!isPlainObject(spec.plannedNode)) {
			errors.push("plannedNode must be an object");
		} else {
			for (const key of Object.keys(spec.plannedNode)) {
				if (key !== "id" && key !== "kind" && key !== "host") errors.push(`plannedNode unknown key: ${key}`);
			}
			if (typeof spec.plannedNode.id !== "string" || spec.plannedNode.id.trim().length === 0) {
				errors.push("plannedNode.id must be a non-empty string");
			}
			if (spec.plannedNode.kind !== "local" && spec.plannedNode.kind !== "ssh") {
				errors.push("plannedNode.kind must be local or ssh");
			}
			if (
				spec.plannedNode.kind === "ssh" &&
				(typeof spec.plannedNode.host !== "string" || spec.plannedNode.host.trim().length === 0)
			) {
				errors.push("plannedNode.host must be a non-empty string for ssh nodes");
			}
			if (spec.plannedNode.kind === "local" && spec.plannedNode.host !== undefined) {
				errors.push("plannedNode.host must be absent for local nodes");
			}
		}
	}

	if ("protectedArtifactRemap" in spec && spec.protectedArtifactRemap !== undefined) {
		if (
			!isPlainObject(spec.protectedArtifactRemap) ||
			Object.keys(spec.protectedArtifactRemap).some((key) => key !== "sourceRoot" && key !== "workerRoot") ||
			typeof spec.protectedArtifactRemap.sourceRoot !== "string" ||
			!path.isAbsolute(spec.protectedArtifactRemap.sourceRoot) ||
			typeof spec.protectedArtifactRemap.workerRoot !== "string" ||
			!path.isAbsolute(spec.protectedArtifactRemap.workerRoot)
		) {
			errors.push("protectedArtifactRemap must carry absolute sourceRoot and workerRoot paths");
		}
	}

	if ("reroutes" in spec && spec.reroutes !== undefined) {
		if (!Array.isArray(spec.reroutes) || spec.reroutes.some((hop) => !isValidReroute(hop))) {
			errors.push("reroutes must be an array of {attempt >= 1, fromNode (non-empty), toNode (string), reason (string)}");
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

	let responseSchema: Record<string, unknown> | undefined;
	if ("responseSchema" in spec && spec.responseSchema !== undefined) {
		try {
			responseSchema = cloneValidatedResponseSchema(spec.responseSchema);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
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

	if ("autonomy" in spec && spec.autonomy !== undefined) {
		if (!isAutonomyLevel(spec.autonomy)) {
			errors.push("autonomy must be one of: read-only|suggest|auto-edit|full-auto");
		}
	}

	if ("gate" in spec && spec.gate !== undefined) {
		if (!isValidGate(spec.gate)) {
			errors.push(
				"gate must carry role (builder|reviewer|candidate|judge), group (non-empty), cycle >= 1, optional subjects [{runId, digest|null}], optional verdict (pass|fail|revise)",
			);
		}
	}

	if ("plan" in spec && spec.plan !== undefined) {
		if (!isValidPlan(spec.plan)) {
			errors.push(
				"plan must carry hash (non-empty), topology (parallel|sequential|pipeline|review|compete|detached), taskCount >= 1, approval (operator|full-auto), optional costCeilingUsd > 0",
			);
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const out: JobSpec = {
		agentId: agentId as string,
		task: task as string,
	};
	if (briefing !== undefined) out.briefing = briefing;
	if (typeof spec.workerProfile === "string") out.workerProfile = spec.workerProfile;
	if (typeof spec.workerRuntime === "string") out.workerRuntime = spec.workerRuntime;
	if (typeof spec.delegationAgentId === "string") out.delegationAgentId = spec.delegationAgentId;
	if (typeof spec.target === "string") out.target = spec.target;
	if (typeof spec.model === "string") out.model = spec.model;
	if (typeof spec.node === "string") out.node = spec.node.trim();
	if (isValidPlannedNode(spec.plannedNode)) out.plannedNode = { ...spec.plannedNode };
	if (isValidProtectedArtifactRemap(spec.protectedArtifactRemap)) {
		out.protectedArtifactRemap = { ...spec.protectedArtifactRemap };
	}
	if (Array.isArray(spec.reroutes) && spec.reroutes.every((hop) => isValidReroute(hop))) {
		out.reroutes = spec.reroutes.map((hop) => ({ ...hop }));
	}
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
	if (responseSchema) out.responseSchema = responseSchema;
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
	if (isAutonomyLevel(spec.autonomy)) out.autonomy = spec.autonomy;
	if (isValidGate(spec.gate)) out.gate = cloneGate(spec.gate);
	if (isValidPlan(spec.plan)) out.plan = { ...spec.plan };
	return { ok: true, spec: out };
}

function isValidPipelineInput(value: unknown): value is PipelineInput {
	if (!isPlainObject(value)) return false;
	const fromRunOk = value.fromRunId === null || (typeof value.fromRunId === "string" && value.fromRunId.length > 0);
	const positionOk = typeof value.position === "number" && Number.isInteger(value.position) && value.position >= 1;
	const textOk = typeof value.text === "string";
	return fromRunOk && positionOk && textOk;
}

function isValidReroute(value: unknown): value is RunNodeReroute {
	if (!isPlainObject(value)) return false;
	const attemptOk = typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 1;
	const fromOk = typeof value.fromNode === "string" && value.fromNode.length > 0;
	const toOk = typeof value.toNode === "string";
	const reasonOk = typeof value.reason === "string";
	return attemptOk && fromOk && toOk && reasonOk;
}

function isValidPlannedNode(value: unknown): value is RunNodeIdentity {
	if (!isPlainObject(value) || typeof value.id !== "string" || value.id.trim().length === 0) return false;
	if (value.kind === "local") return value.host === undefined;
	return value.kind === "ssh" && typeof value.host === "string" && value.host.trim().length > 0;
}

function isValidProtectedArtifactRemap(value: unknown): value is ProtectedArtifactPathRemap {
	return (
		isPlainObject(value) &&
		typeof value.sourceRoot === "string" &&
		path.isAbsolute(value.sourceRoot) &&
		typeof value.workerRoot === "string" &&
		path.isAbsolute(value.workerRoot)
	);
}

const VALID_GATE_ROLES = new Set(["builder", "reviewer", "candidate", "judge"]);
const VALID_GATE_VERDICTS = new Set(["pass", "fail", "revise"]);
const VALID_PLAN_TOPOLOGIES = new Set(["parallel", "sequential", "pipeline", "review", "compete", "detached"]);
const VALID_PLAN_APPROVALS = new Set(["operator", "full-auto"]);

function isValidGate(value: unknown): value is RunGateProvenance {
	if (!isPlainObject(value)) return false;
	if (typeof value.role !== "string" || !VALID_GATE_ROLES.has(value.role)) return false;
	if (typeof value.group !== "string" || value.group.length === 0) return false;
	if (typeof value.cycle !== "number" || !Number.isInteger(value.cycle) || value.cycle < 1) return false;
	if (value.subjects !== undefined) {
		if (!Array.isArray(value.subjects)) return false;
		for (const subject of value.subjects) {
			if (!isPlainObject(subject)) return false;
			if (typeof subject.runId !== "string" || subject.runId.length === 0) return false;
			if (subject.digest !== null && typeof subject.digest !== "string") return false;
		}
	}
	if (value.verdict !== undefined && (typeof value.verdict !== "string" || !VALID_GATE_VERDICTS.has(value.verdict))) {
		return false;
	}
	return true;
}

function cloneGate(gate: RunGateProvenance): RunGateProvenance {
	return {
		role: gate.role,
		group: gate.group,
		cycle: gate.cycle,
		...(gate.subjects !== undefined ? { subjects: gate.subjects.map((subject) => ({ ...subject })) } : {}),
		...(gate.verdict !== undefined ? { verdict: gate.verdict } : {}),
	};
}

function isValidPlan(value: unknown): value is RunPlanProvenance {
	if (!isPlainObject(value)) return false;
	if (typeof value.hash !== "string" || value.hash.length === 0) return false;
	if (typeof value.topology !== "string" || !VALID_PLAN_TOPOLOGIES.has(value.topology)) return false;
	if (typeof value.taskCount !== "number" || !Number.isInteger(value.taskCount) || value.taskCount < 1) return false;
	if (typeof value.approval !== "string" || !VALID_PLAN_APPROVALS.has(value.approval)) return false;
	if (
		value.approvalRequestId !== undefined &&
		(typeof value.approvalRequestId !== "string" || value.approvalRequestId.length === 0)
	) {
		return false;
	}
	if (
		value.approvalRequestedBy !== undefined &&
		(typeof value.approvalRequestedBy !== "string" || value.approvalRequestedBy.length === 0)
	) {
		return false;
	}
	if (value.costCeilingUsd !== undefined && (typeof value.costCeilingUsd !== "number" || value.costCeilingUsd <= 0)) {
		return false;
	}
	return true;
}

function isValidLineage(value: unknown): value is RunLineage {
	if (!isPlainObject(value)) return false;
	const parentOk = value.parentRunId === null || (typeof value.parentRunId === "string" && value.parentRunId.length > 0);
	const rootOk = typeof value.rootRunId === "string" && value.rootRunId.length > 0;
	const attemptOk = typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 0;
	const depthOk = typeof value.depth === "number" && Number.isInteger(value.depth) && value.depth >= 0;
	return parentOk && rootOk && attemptOk && depthOk;
}
