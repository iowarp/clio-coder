import { createHash } from "node:crypto";
import type { WorkerPermissionMode } from "../../core/defaults.js";
import { ToolNames } from "../../core/tool-names.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { turnDelegatesTool } from "../../core/turn-constraints.js";
import type { AgentCapabilityClass } from "../agents/spec.js";
import type { RuntimeEnforcement } from "../providers/index.js";
import { classify } from "./action-classifier.js";
import type { ApprovalAuthority } from "./admission.js";

/**
 * The effective worker permit (Codex review, "The corrected authority
 * contract"). The host computes it once per attempt and it never changes
 * during the run. It separates the hard ceiling C, which nothing grants past,
 * from the standing allowance S inside it. A grant never changes either.
 */

export const WORKER_PERMIT_VERSION = 1;

/** Standing Git allowance. `inspect` grants no standing mutation; `worktree` is Phase C's attested task-branch set. */
export const WORKER_GIT_ALLOWANCES = ["inspect", "worktree"] as const;
export type WorkerGitAllowance = (typeof WORKER_GIT_ALLOWANCES)[number];

/** Where an ordinary approval-required call goes. `deny` and `fail` have equal authority. */
export const WORKER_ASK_ROUTES = ["deny", "fail", "main"] as const;
export type WorkerAskRoute = (typeof WORKER_ASK_ROUTES)[number];

/** The recipe frontmatter `permissions:` block, and the per-task narrowing, share this shape. */
export interface WorkerPermissionDeclaration {
	git?: WorkerGitAllowance;
	asks?: WorkerAskRoute;
}

export interface WorkerPermitCeiling {
	capabilityClass: AgentCapabilityClass;
	/** Tools this run may ever call: admitted tools the delegation ceiling also covers, sorted. */
	tools: ReadonlyArray<string>;
	readOnly: boolean;
	writeRoots: ReadonlyArray<string>;
	/** What the selected runtime itself enforces for this run. */
	enforcement: RuntimeEnforcement;
}

export interface WorkerPermitAllowance {
	git: WorkerGitAllowance;
	asks: WorkerAskRoute;
	/**
	 * Who decides an ask routed to `main`. `operator` is the legacy escalate
	 * route: the main agent's card, always decided by a person. `main` lets
	 * the main agent grant, which Phase B refuses (no broker yet).
	 */
	approvalAuthority: ApprovalAuthority;
}

export interface WorkerPermit {
	version: typeof WORKER_PERMIT_VERSION;
	ceiling: WorkerPermitCeiling;
	allowance: WorkerPermitAllowance;
	/**
	 * Present when an unmediated runtime took write-capable work because the
	 * operator marked its target trusted: the runtime's own authority, not
	 * Clio's per-call mediation, governed the run.
	 */
	trustedUnmediated?: true;
	/** sha256 over the canonical ceiling, allowance and trust opt-in. */
	digest: string;
}

/** A permit request the host must refuse rather than quietly narrow. */
export class WorkerPermitAdmissionError extends Error {
	constructor(message: string) {
		super(`dispatch: permit admission denied: ${message}`);
		this.name = "WorkerPermitAdmissionError";
	}
}

function includes<T extends string>(values: ReadonlyArray<T>, value: unknown): value is T {
	return typeof value === "string" && (values as ReadonlyArray<string>).includes(value);
}

/**
 * Strict parser for a `permissions:` block. Unknown keys and values are
 * rejected, never ignored: a misspelled `asks: mian` must not silently keep
 * the default route.
 */
export function parseWorkerPermissionDeclaration(value: unknown, source: string): WorkerPermissionDeclaration {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${source} must be a map with optional git and asks keys`);
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "git" && key !== "asks") throw new Error(`${source}.${key} is unknown; expected git or asks`);
	}
	const out: WorkerPermissionDeclaration = {};
	if (record.git !== undefined) {
		if (!includes(WORKER_GIT_ALLOWANCES, record.git)) {
			throw new Error(`${source}.git must be one of ${WORKER_GIT_ALLOWANCES.join(", ")}`);
		}
		out.git = record.git;
	}
	if (record.asks !== undefined) {
		if (!includes(WORKER_ASK_ROUTES, record.asks)) {
			throw new Error(`${source}.asks must be one of ${WORKER_ASK_ROUTES.join(", ")}`);
		}
		out.asks = record.asks;
	}
	return out;
}

/** Declaration errors that depend on the capability class. */
export function workerPermissionDeclarationErrors(
	capabilityClass: AgentCapabilityClass,
	declaration: WorkerPermissionDeclaration | undefined,
): string[] {
	if (declaration?.git === "worktree" && capabilityClass !== "workspace-edit") {
		return [`permissions.git: worktree requires capabilityClass workspace-edit, not ${capabilityClass}`];
	}
	return [];
}

/** The legacy fleet setting expressed as a standing ask route. */
export function askRouteForMode(mode: WorkerPermissionMode): {
	asks: WorkerAskRoute;
	approvalAuthority: ApprovalAuthority;
} {
	// escalate always meant an operator decision; it keeps that meaning (Q7 revised).
	if (mode === "escalate") return { asks: "main", approvalAuthority: "operator" };
	// The explicit opt-in for the main agent to decide ordinary worker asks.
	if (mode === "main") return { asks: "main", approvalAuthority: "main" };
	return { asks: mode, approvalAuthority: "operator" };
}

/**
 * The worker-side resolution the permit's allowance runs as today. Main
 * authority resolves as a denial until the Phase D grant broker exists: it is
 * refused, never silently allowed and never quietly sent to the operator.
 */
export function workerPermissionModeForPermit(allowance: WorkerPermitAllowance): "deny" | "fail" | "escalate" {
	if (allowance.asks === "main") return allowance.approvalAuthority === "operator" ? "escalate" : "deny";
	return allowance.asks;
}

/** True when asks go to the main agent with main authority, which Phase B cannot honor yet. */
export function mainGrantsUnavailable(allowance: Pick<WorkerPermitAllowance, "asks" | "approvalAuthority">): boolean {
	return allowance.asks === "main" && allowance.approvalAuthority === "main";
}

/** Denial reason for an ask a main-authority permit cannot route yet. */
export const MAIN_GRANTS_UNAVAILABLE_REASON =
	"main-agent grants are not available yet (fleet.permissions.mode=main); the ask is denied, not sent to the operator";

/** Why a tool list exceeds a capability class's direct ceiling, per the review's class table. */
function capabilityClassCeilingErrors(capabilityClass: AgentCapabilityClass, tools: ReadonlyArray<string>): string[] {
	const errors: string[] = [];
	for (const tool of tools) {
		// The gateway is the transport for capabilities already named; it carries no authority of its own.
		if (tool === ToolNames.Gateway) continue;
		const action = classify({ tool }).actionClass;
		if (action === "dispatch" || tool === ToolNames.AskUser) {
			errors.push(`${tool} is orchestrator-only and no worker runtime mediates it`);
			continue;
		}
		switch (capabilityClass) {
			case "read-only":
				if (action !== "read") errors.push(`read-only ceiling excludes ${action} tool ${tool}`);
				break;
			case "artifact-write":
				if (action === "execute" || action === "system_modify" || action === "git_destructive") {
					errors.push(`artifact-write ceiling excludes ${action} tool ${tool}`);
				} else if (action === "write" && tool !== ToolNames.Artifact) {
					errors.push(`artifact-write ceiling allows only the artifact write, not ${tool}`);
				}
				break;
			case "verification":
				if (action === "write" || action === "system_modify" || action === "git_destructive" || tool === ToolNames.Bash) {
					errors.push(`verification ceiling excludes ${tool}; checks run through typed verification`);
				}
				break;
			case "workspace-edit":
			case "orchestration":
			case "internal":
				break;
		}
	}
	return errors;
}

export interface WorkerPermitInput {
	agentId: string;
	capabilityClass: AgentCapabilityClass;
	/** The final admitted tool surface for this attempt. */
	tools: ReadonlyArray<string>;
	/** Host task scope; its delegation ceiling is `delegatedTools ?? allowedTools`. */
	turnConstraints?: TurnConstraints;
	readOnly: boolean;
	writeRoots: ReadonlyArray<string>;
	/** The recipe's `permissions:` block, when it declares one. */
	declared?: WorkerPermissionDeclaration;
	/** Per-task narrowing a host caller requests. A widening request is refused. */
	narrowing?: WorkerPermissionDeclaration;
	/**
	 * The allowance of the attempt this one retries. It caps the result
	 * without refusing: a retry that fails over to another recipe or sees
	 * changed settings still runs no wider than the attempt it replaces.
	 */
	inherited?: WorkerPermitAllowance;
	/** fleet.permissions.mode. */
	mode: WorkerPermissionMode;
	/** True when the host selected an internal helper protocol for this run. */
	hostHelper?: boolean;
	/** The selected runtime and target, and whether the operator trusts it unmediated. */
	runtime: { id: string; targetId: string; enforcement: RuntimeEnforcement; trustedUnmediated: boolean };
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

function workerPermitDigest(
	ceiling: WorkerPermitCeiling,
	allowance: WorkerPermitAllowance,
	trustedUnmediated: boolean,
): string {
	const payload = {
		version: WORKER_PERMIT_VERSION,
		ceiling,
		allowance,
		...(trustedUnmediated ? { trustedUnmediated } : {}),
	};
	return createHash("sha256")
		.update(`clio-coder.workerPermit:${canonical(payload)}`, "utf8")
		.digest("hex");
}

/**
 * Resolve the immutable permit for one attempt. Narrowing only narrows: a
 * request for a wider allowance than the recipe and settings give is an
 * admission error, not an ignored preference.
 */
export function resolveWorkerPermit(input: WorkerPermitInput): WorkerPermit {
	const who = `agent '${input.agentId}'`;
	if (input.capabilityClass === "orchestration") {
		throw new WorkerPermitAdmissionError(
			`${who} is an orchestration agent; no worker runtime mediates nested dispatch, so it cannot run as a worker`,
		);
	}
	if (input.capabilityClass === "internal" && input.hostHelper !== true) {
		throw new WorkerPermitAdmissionError(
			`${who} declares capabilityClass internal without a host-selected helper protocol; internal authority is never derived from the label`,
		);
	}
	const declarationErrors = workerPermissionDeclarationErrors(input.capabilityClass, input.declared);
	if (declarationErrors.length > 0) throw new WorkerPermitAdmissionError(`${who}: ${declarationErrors.join("; ")}`);
	const ceilingErrors = capabilityClassCeilingErrors(input.capabilityClass, input.tools);
	if (ceilingErrors.length > 0) throw new WorkerPermitAdmissionError(`${who}: ${ceilingErrors.join("; ")}`);
	// Operator decision Q6: a runtime Clio cannot mediate per call takes
	// write-capable work only when its target is explicitly trusted.
	const unmediatedWrite = !input.readOnly && !input.runtime.enforcement.perCallMediation;
	if (unmediatedWrite && !input.runtime.trustedUnmediated) {
		throw new WorkerPermitAdmissionError(
			`runtime '${input.runtime.id}' runs its own tool loop and Clio cannot mediate its individual calls, so it is refused write-capable work; dispatch a read-only run, choose a native or claude-sdk target, or set trustedUnmediated: true on target '${input.runtime.targetId}' in settings.yaml to accept the runtime's own authority`,
		);
	}

	const route = askRouteForMode(input.mode);
	const baseAsks = input.declared?.asks ?? route.asks;
	const baseGit = input.declared?.git ?? "inspect";
	const narrowing = input.narrowing ?? {};
	if (narrowing.git === "worktree" && baseGit !== "worktree") {
		throw new WorkerPermitAdmissionError(`${who}: git ${baseGit} cannot be widened to worktree for one task`);
	}
	if (narrowing.asks === "main" && baseAsks !== "main") {
		throw new WorkerPermitAdmissionError(`${who}: asks ${baseAsks} cannot be widened to main for one task`);
	}
	const inherited = input.inherited;
	let asks = narrowing.asks ?? baseAsks;
	if (inherited !== undefined && inherited.asks !== "main" && asks === "main") asks = inherited.asks;
	// The ceiling dominates the allowance: a read-only run has no Git mutation to allow.
	const git = input.readOnly || inherited?.git === "inspect" ? "inspect" : (narrowing.git ?? baseGit);
	// Authority is the operator's setting; a recipe routing asks to main never
	// raises who decides them.
	const approvalAuthority: ApprovalAuthority =
		asks === "main" && route.asks === "main" && inherited?.approvalAuthority !== "operator"
			? route.approvalAuthority
			: "operator";

	const ceiling: WorkerPermitCeiling = {
		capabilityClass: input.capabilityClass,
		tools: [...new Set(input.tools.filter((tool) => turnDelegatesTool(input.turnConstraints, tool)))].sort(),
		readOnly: input.readOnly,
		writeRoots: [...input.writeRoots],
		enforcement: { ...input.runtime.enforcement },
	};
	const allowance: WorkerPermitAllowance = { git, asks, approvalAuthority };
	return Object.freeze({
		version: WORKER_PERMIT_VERSION,
		...(unmediatedWrite ? { trustedUnmediated: true as const } : {}),
		ceiling: Object.freeze({
			...ceiling,
			tools: Object.freeze([...ceiling.tools]),
			writeRoots: Object.freeze([...ceiling.writeRoots]),
		}),
		allowance: Object.freeze(allowance),
		digest: workerPermitDigest(ceiling, allowance, unmediatedWrite),
	});
}

/** One prompt line naming the permit the worker runs under. */
export function workerPermitPromptLine(view: {
	capabilityClass?: AgentCapabilityClass;
	git: WorkerGitAllowance;
	asks: WorkerAskRoute;
	approvalAuthority: ApprovalAuthority;
}): string {
	const asks =
		view.asks === "main"
			? view.approvalAuthority === "main"
				? "main (main-agent grants are not available yet, so they are denied)"
				: "main (operator decides)"
			: view.asks;
	const scope = view.capabilityClass !== undefined ? `${view.capabilityClass}, ` : "";
	return `Permit: ${scope}git ${view.git}, asks ${asks}.`;
}
