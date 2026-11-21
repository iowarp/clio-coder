/**
 * The capability envelope of one dispatched run (DESIGN 4.4, slice M7).
 *
 * One pure resolution decides what a run may touch: its tool list, its write mode and roots, and every capability a
 * layer took away. Dispatch admission, the plan preview, the worker spec, the worker's prompt, the attestation and the
 * receipt all read the envelope this module produces, so no later stage narrows tools or re-derives read-only on its
 * own. Layers only subtract, in a fixed order, and each subtraction a caller could act on is a `withheld` entry:
 *
 *   1. role class ceiling (the run's position in the work graph, not its recipe)
 *   2. request (tool profile, deny list)
 *   3. runtime (what the selected runtime offers and mediates)
 *   4. host facts for the placement (network plane, shell, write confinement)
 *
 * A tool beyond the dispatching turn's delegation ceiling is not subtracted: dispatch refuses the request and names
 * the recipes that fit (tool-constraints.ts), because the parent's scope is the operator's.
 *
 * Orchestrator-only tools (ask_user, consult) and a ledger tool with no board are never a worker capability, so they
 * leave without an entry. Pure: no I/O, no clock; the caller passes every host fact in.
 */

import {
	isBuiltinToolName,
	isHarnessExtensionToolName,
	isMcpToolName,
	type ToolName,
	ToolNames,
} from "../../core/tool-names.js";
import { directSurfaceNames, withGatewayForCapabilities } from "../../tools/surface.js";
import { workerEnvelopeDigest } from "../../worker/protocol.js";
import type { AgentCapabilityClass } from "../agents/spec.js";
import { classify } from "../safety/action-classifier.js";
import { WRITE_ROOT_REFUSED_TOOLS } from "../safety/policy-engine.js";
import type { WorkerMcpAttestation } from "../safety/worker-permit.js";
import type { GateTopologyRole } from "./execution-role.js";
import { type RunRole, resolveRunRole } from "./obligation.js";

export const WORKER_ENVELOPE_VERSION = 1;

/**
 * The single definition of read-only. `none` changes nothing; `roots` writes only under its roots; `worktree` writes
 * in its own task worktree and merges back only its roots when it has any; `workspace` has no write boundary.
 */
export const ENVELOPE_WRITE_MODES = ["none", "roots", "worktree", "workspace"] as const;
export type EnvelopeWriteMode = (typeof ENVELOPE_WRITE_MODES)[number];

export const WITHHELD_REASONS = [
	"role",
	"tool-profile",
	"denied",
	"runtime",
	"no-network",
	"no-shell",
	"write-roots-unconfined",
	"judge-unseated",
	"main-route-unavailable",
] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

/** One capability a layer took from the run, why, and what would keep it. */
export interface WithheldCapability {
	capability: string;
	reason: WithheldReason;
	remedy?: string;
}

export interface WorkerEnvelope {
	version: typeof WORKER_ENVELOPE_VERSION;
	role: RunRole;
	/** Final tool surface, placement included: `direct` carries schemas, `gateway` is reached through `gateway`. */
	tools: { direct: ReadonlyArray<string>; gateway: ReadonlyArray<string> };
	write: {
		mode: EnvelopeWriteMode;
		/** Canonical absolute write boundaries; exact files lack a trailing slash, subtrees keep one. */
		roots: ReadonlyArray<string>;
		/**
		 * True when the run's commands cannot leave a change outside its roots in the operator's tree: the OS sandbox
		 * binds them, or the run is in its own worktree and merge-back takes only the roots. Shell and checks are then
		 * not an escape. Meaningless (false) without roots.
		 */
		commandsBounded: boolean;
	};
	/** Host fact of the placement that runs the worker, computed once by the host (M6, M7). */
	sandbox: { confinesWrites: boolean };
	withheld: ReadonlyArray<WithheldCapability>;
	/** The permit this envelope wraps; the worker refuses a spec whose permit has another digest. */
	permitDigest: string;
	/** sha256 over the canonical envelope without this field. */
	digest: string;
}

/** The capability names of an envelope, sorted: what the worker registers, attests and is told. */
export function envelopeToolNames(envelope: Pick<WorkerEnvelope, "tools">): ToolName[] {
	return [...envelope.tools.direct, ...envelope.tools.gateway].sort() as ToolName[];
}

/**
 * Whether the request asks the run to change nothing: the caller or the turn said read-only, the recipe's class is
 * read-only, or its contract is a Hoare proof. The only place this is derived; everything later reads the envelope.
 */
export function requestedWriteNone(input: {
	readOnly: boolean | undefined;
	capabilityClass: AgentCapabilityClass | string | null | undefined;
	hoareContract: boolean;
}): boolean {
	return input.readOnly === true || input.capabilityClass === "read-only" || input.hoareContract;
}

/** The run's role from its gate position, recipe class and requested write scope (DESIGN 4.2). */
export function envelopeRole(input: {
	gateRole?: GateTopologyRole | undefined;
	capabilityClass: AgentCapabilityClass | string | null;
	writeNone: boolean;
}): RunRole {
	return resolveRunRole({
		gateRole: input.gateRole,
		capabilityClass: input.capabilityClass,
		readOnly: input.writeNone,
	});
}

/**
 * Where a run writes (ruling 3). A builder with roots on a placement that cannot confine its commands to them gets
 * its own worktree, keeps its check tools, and merges back only its roots. Without a git checkout, or on a runtime
 * that cannot enforce roots per call, no worktree is possible and the roots stay unconfined.
 */
export function resolveWriteMode(input: {
	writeNone: boolean;
	roots: ReadonlyArray<string>;
	/** The run already has, or asked for, a task worktree. */
	worktree: boolean;
	confinesWrites: boolean;
	gitCheckout: boolean;
	scopeEnforcement: boolean;
}): EnvelopeWriteMode {
	if (input.writeNone) return "none";
	if (input.worktree) return "worktree";
	if (input.roots.length === 0) return "workspace";
	if (input.confinesWrites) return "roots";
	return input.gitCheckout && input.scopeEnforcement ? "worktree" : "roots";
}

/** True when a request with these facts is placed in a worktree it did not ask for (Q3). */
export function placedInWorktree(input: Parameters<typeof resolveWriteMode>[0]): boolean {
	return !input.worktree && resolveWriteMode(input) === "worktree";
}

/** Tool kinds a role ceiling admits beyond read-class tools. */
const ROLE_EXTRA_TOOLS: Record<RunRole, ReadonlySet<string> | "all"> = {
	builder: "all",
	explorer: new Set(),
	judge: new Set(),
	seat: new Set(),
	// A checker and a reviewer run declared checks through typed verification; neither holds a shell or a write tool.
	checker: new Set([ToolNames.Verify]),
	reviewer: new Set([ToolNames.Verify]),
};

/** The role class table's remedy for a tool the role does not hold. */
const ROLE_REMEDY: Record<RunRole, string | undefined> = {
	builder: undefined,
	explorer: "an explorer changes nothing; dispatch with a write scope to run as a builder",
	checker: "a checker runs declared checks through verify and changes nothing",
	reviewer: "a reviewer judges from evidence and declared checks and changes nothing",
	judge: "a judge chooses from the evidence it is given",
	seat: "a council seat answers from reads",
};

function toolActionClass(tool: string, mcp: WorkerMcpAttestation | undefined): string {
	if (isMcpToolName(tool)) {
		return mcp?.tools.find((entry) => `mcp_${entry.serverId}__${entry.tool}` === tool)?.actionClass ?? "unknown";
	}
	return classify({ tool }).actionClass;
}

function roleAdmits(role: RunRole, tool: string, mcp: WorkerMcpAttestation | undefined): boolean {
	const extra = ROLE_EXTRA_TOOLS[role];
	if (extra === "all") return true;
	// The gateway carries no authority of its own; what it reaches is filtered by name.
	if (tool === ToolNames.Gateway) return true;
	return extra.has(tool) || toolActionClass(tool, mcp) === "read";
}

export interface EnvelopeInput {
	role: RunRole;
	/** The recipe's declared tools. */
	recipeTools: ReadonlyArray<ToolName>;
	/** The recipe's tools after the request's tool profile, as admission attested them. */
	profiledTools: ReadonlyArray<ToolName>;
	denied: ReadonlySet<string>;
	/** True when the run coordinates on a ledger board. */
	ledger: boolean;
	write: { mode: EnvelopeWriteMode; roots: ReadonlyArray<string> };
	runtime: {
		/** False when the route takes no tools at all. */
		toolsSupported: boolean;
		/** Clio's own tool loop: gateway attached, MCP mediated, harness extensions reachable. */
		ownLoop: boolean;
		/** A tool the runtime's own tool set can carry. */
		offers: (tool: ToolName) => boolean;
	};
	host: {
		networkStripped: boolean;
		shellStripped: boolean;
		confinesWrites: boolean;
		/** Harness extension tools enabled on this host. */
		harnessTools: ReadonlySet<string>;
	};
	mcp?: WorkerMcpAttestation;
	/** Approval subtractions the permit resolution already made (judge with no judge seated, main with no route). */
	approvalWithheld?: ReadonlyArray<WithheldCapability>;
	permitDigest: string;
}

const UNCONFINED_REMEDY =
	"enable safety.sandbox (auto or required) with a usable bubblewrap backend, run in a git checkout so the run gets its own worktree, or omit write roots";

/** Resolve the envelope. Every caller, preview and run alike, goes through this one function. */
export function resolveWorkerEnvelope(input: EnvelopeInput): WorkerEnvelope {
	const withheld: WithheldCapability[] = [];
	const take = (capability: string, reason: WithheldReason, remedy?: string): void => {
		if (withheld.some((entry) => entry.capability === capability)) return;
		withheld.push({ capability, reason, ...(remedy !== undefined ? { remedy } : {}) });
	};
	const profiled = new Set<string>(input.profiledTools);
	for (const tool of input.recipeTools) {
		if (!profiled.has(tool)) take(tool, "tool-profile");
	}
	const rooted = input.write.roots.length > 0;
	const commandsBounded =
		rooted && (input.write.mode === "worktree" || (input.write.mode === "roots" && input.host.confinesWrites));
	const unconfined = rooted && input.write.mode === "roots" && !commandsBounded;
	const names: ToolName[] = [];
	for (const tool of new Set(input.profiledTools)) {
		// Never a worker capability: no worker runtime mediates them, and a solo run has no board.
		if (tool === ToolNames.AskUser || tool === ToolNames.Consult) continue;
		if (tool === ToolNames.Ledger && !input.ledger) continue;
		if (!roleAdmits(input.role, tool, input.mcp)) {
			take(tool, "role", ROLE_REMEDY[input.role]);
			continue;
		}
		if (input.denied.has(tool)) {
			take(tool, "denied");
			continue;
		}
		if (!input.runtime.toolsSupported) {
			take(tool, "runtime", "the route takes no tool calls; choose a model that does");
			continue;
		}
		const harness = isHarnessExtensionToolName(tool);
		if (isMcpToolName(tool) || harness ? !input.runtime.ownLoop : !input.runtime.offers(tool)) {
			take(tool, "runtime", "the selected runtime runs its own tools; choose a native target");
			continue;
		}
		// An extension tool this host has not enabled, or a name no build knows, is nothing to offer.
		if (harness ? !input.host.harnessTools.has(tool) : !isMcpToolName(tool) && !isBuiltinToolName(tool)) continue;
		if (input.host.networkStripped && (tool === ToolNames.WebFetch || tool === ToolNames.WebRead)) {
			take(tool, "no-network", "this host registers no network plane");
			continue;
		}
		if (input.host.shellStripped && tool === ToolNames.Bash) {
			take(tool, "no-shell", "this host has no bash");
			continue;
		}
		// A command escapes roots nothing binds, so the policy rail would refuse every call of it.
		if (unconfined && commandEscapesRoots(tool, input.mcp, harness)) {
			take(tool, "write-roots-unconfined", UNCONFINED_REMEDY);
			continue;
		}
		names.push(tool);
	}
	// Tool entries in name order, so every surface lists them the same way; approval entries follow.
	withheld.sort((left, right) => left.capability.localeCompare(right.capability));
	for (const entry of input.approvalWithheld ?? []) take(entry.capability, entry.reason, entry.remedy);
	const surface = (input.runtime.ownLoop ? withGatewayForCapabilities(names) : [...new Set(names)]).sort();
	const direct = directSurfaceNames(surface).filter((name) => surface.includes(name as ToolName));
	const gateway = surface.filter((name) => !direct.includes(name));
	const body = {
		version: WORKER_ENVELOPE_VERSION,
		role: input.role,
		tools: { direct: direct.sort(), gateway: gateway.sort() },
		write: { mode: input.write.mode, roots: [...input.write.roots], commandsBounded },
		sandbox: { confinesWrites: input.host.confinesWrites },
		withheld,
		permitDigest: input.permitDigest,
	} satisfies Omit<WorkerEnvelope, "digest">;
	return Object.freeze({ ...body, digest: workerEnvelopeDigest(body) });
}

function commandEscapesRoots(tool: string, mcp: WorkerMcpAttestation | undefined, harness: boolean): boolean {
	if (WRITE_ROOT_REFUSED_TOOLS.has(tool) || harness) return true;
	return isMcpToolName(tool) && toolActionClass(tool, mcp) === "execute";
}

/**
 * Required recipe tools the envelope may lack without refusing the run. Roles are positions and recipes personas: a
 * tool the role does not hold was never this run's to use. A council seat's profile is its ceiling the same way.
 */
export function waivedRequirements(envelope: Pick<WorkerEnvelope, "role" | "withheld">): ReadonlySet<string> {
	return new Set(
		envelope.withheld
			.filter((entry) => entry.reason === "role" || (envelope.role === "seat" && entry.reason === "tool-profile"))
			.map((entry) => entry.capability),
	);
}

/** The envelope with the permit it wraps swapped, sealed again (a permit re-resolved without yolo, for one). */
export function envelopeForPermit(envelope: WorkerEnvelope, permitDigest: string): WorkerEnvelope {
	if (envelope.permitDigest === permitDigest) return envelope;
	const { digest: _old, ...body } = envelope;
	const next = { ...body, permitDigest };
	return Object.freeze({ ...next, digest: workerEnvelopeDigest(next) });
}

const REASON_WORDS: Record<WithheldReason, string> = {
	role: "the run's role holds no such tool",
	"tool-profile": "the request's tool profile excludes it",
	denied: "the request denied it",
	runtime: "the runtime cannot carry it",
	"no-network": "no network plane on this host",
	"no-shell": "no shell on this host",
	"write-roots-unconfined": "the write roots have no sandbox or worktree binding commands to them",
	"judge-unseated": "no safety judge can answer this run's asks, so they are denied",
	"main-route-unavailable": "no main agent can answer this run's asks, so they are denied",
};

/** One line per withheld capability, for the plan card, the dispatch result and the worker's prompt. */
export function withheldLines(withheld: ReadonlyArray<WithheldCapability>): string[] {
	return withheld.map(
		(entry) =>
			`${entry.capability}: ${REASON_WORDS[entry.reason]}${entry.remedy !== undefined ? ` (${entry.remedy})` : ""}`,
	);
}

/** The plan card's write line: where the run writes and what merges back. */
export function writeModeLine(write: Pick<WorkerEnvelope["write"], "mode" | "roots">): string {
	switch (write.mode) {
		case "none":
			return "none (read-only)";
		case "workspace":
			return "workspace";
		case "roots":
			return `roots ${write.roots.join(", ")}`;
		case "worktree":
			return write.roots.length > 0
				? `own worktree, merges back only ${write.roots.join(", ")}`
				: "own worktree, merges back the whole tree";
	}
}
