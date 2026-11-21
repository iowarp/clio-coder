/**
 * The capability envelope of one dispatched run (DESIGN 4.4, slice M7).
 *
 * One pure resolution decides what a run may touch: its tools, bound skills, read and write scope, command and
 * check reach, network, approval route, sandbox facts, static request head, and every capability a layer took
 * away. Dispatch admission, the plan preview, the worker spec, the worker's prompt, the attestation and the
 * receipt all read the envelope this module produces, so no later stage narrows tools or re-derives read-only on its
 * own. Layers only subtract, in a fixed order, and each subtraction a caller could act on is a `withheld` entry:
 *
 *   1. role class ceiling (the run's position in the work graph, not its recipe); the row also adds the tools every
 *      run in it holds, such as code_nav, which the later layers subtract like any other
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
import { applyToolProfile, type ToolProfileName } from "../../tools/profiles.js";
import { directSurfaceNames, withGatewayForCapabilities } from "../../tools/surface.js";
import { type WorkerStaticHeadInput, workerEnvelopeDigest, workerStaticHead } from "../../worker/protocol.js";
import { roleExcludes, roleHeldTools, roleRemedy, toolActionClass } from "../agents/role-class.js";
import type { AgentCapabilityClass } from "../agents/spec.js";
import { toolEscapesWriteRoots } from "../safety/policy-engine.js";
import type { WorkerMcpAttestation, WorkerPermitAllowance } from "../safety/worker-permit.js";
import type { RunRole } from "./obligation.js";

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

/** How a run finds skills: none, only the recipe's bound ones, or the ranked catalog. */
export const ENVELOPE_SKILL_DISCOVERY = ["off", "bound-only", "ranked"] as const;
export type EnvelopeSkillDiscovery = (typeof ENVELOPE_SKILL_DISCOVERY)[number];

/** Where the run's commands execute: no shell tool, under the OS sandbox, or directly on the host. */
export const ENVELOPE_SHELLS = ["none", "sandboxed", "host"] as const;
export type EnvelopeShell = (typeof ENVELOPE_SHELLS)[number];

/** Which checks the run may run through verify: none, the declared task gates and checks, or any. */
export const ENVELOPE_CHECKS = ["none", "declared", "any"] as const;
export type EnvelopeChecks = (typeof ENVELOPE_CHECKS)[number];

/**
 * Who answers an approval-required call. `main` is the main agent with main authority, `operator` the main route
 * decided by a person, `judge` the main session's safety judge with main authority.
 */
export const ENVELOPE_ASKS = ["deny", "fail", "main", "operator", "judge"] as const;
export type EnvelopeAsks = (typeof ENVELOPE_ASKS)[number];

export const ENVELOPE_SANDBOX_BACKENDS = ["bwrap", "seatbelt", "none"] as const;
export type EnvelopeSandboxBackend = (typeof ENVELOPE_SANDBOX_BACKENDS)[number];

export interface EnvelopeApproval {
	autonomy: "default" | "yolo";
	asks: EnvelopeAsks;
}

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
	/** Skill names the recipe binds, the skill files the run may load, and how it discovers others. */
	skills: { bound: ReadonlyArray<string>; paths: ReadonlyArray<string>; discovery: EnvelopeSkillDiscovery };
	/** Declared read roots inside the workspace, and the outside roots admission approved. */
	read: { roots: ReadonlyArray<string>; outside: ReadonlyArray<string> };
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
	exec: { shell: EnvelopeShell; checks: EnvelopeChecks };
	/** Whether the run's commands (shell and checks) reach the network, its network tools, and MCP servers granted it. */
	network: { shell: boolean; tools: ReadonlyArray<string>; mcp: ReadonlyArray<string> };
	approval: EnvelopeApproval;
	/** Host facts of the placement that runs the worker, computed once by the host (M6, M7). */
	sandbox: { backend: EnvelopeSandboxBackend; confinesWrites: boolean };
	withheld: ReadonlyArray<WithheldCapability>;
	/** `workerStaticHead` of the request head the worker sends; empty until the host compiles the prompt. */
	staticHead: string;
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

function toolAction(tool: string, mcp: WorkerMcpAttestation | undefined): string {
	if (!isMcpToolName(tool)) return toolActionClass(tool);
	return mcp?.tools.find((entry) => `mcp_${entry.serverId}__${entry.tool}` === tool)?.actionClass ?? "unknown";
}

export interface EnvelopeInput {
	role: RunRole;
	/** The recipe's class, which narrows the role's row (an artifact writer builds only artifacts). */
	capabilityClass: AgentCapabilityClass | string | null;
	/** The recipe's declared tools. */
	recipeTools: ReadonlyArray<ToolName>;
	/** The recipe's tools after the request's tool profile, as admission attested them. */
	profiledTools: ReadonlyArray<ToolName>;
	/** The request's tool profile, which narrows the role's held tools as it narrowed the recipe's. */
	toolProfile?: ToolProfileName;
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
	skills: {
		/** Skill names the recipe binds. */
		names: ReadonlyArray<string>;
		/** Skill files the request and recipe name. */
		paths: ReadonlyArray<string>;
		/** The request turned skills off. */
		disabled: boolean;
		/** Whether the canonical context tool is attached for this final tool list on this runtime. */
		contextAttached: (tools: ReadonlyArray<ToolName>) => boolean;
	};
	read: { roots: ReadonlyArray<string>; outside: ReadonlyArray<string> };
	/** Facts of the OS sandbox the placement runs the worker's commands under. */
	sandbox: {
		backend: EnvelopeSandboxBackend;
		/** The worker's own commands run under an OS sandbox policy. */
		applies: boolean;
		/** `safety.sandboxNetwork`: the operator opened the sandbox's network. */
		networkSetting: boolean;
		/** The run's contract forbids network for its commands (a Hoare proof). */
		networkOff: boolean;
	};
	approval: EnvelopeApproval;
	permitDigest: string;
}

const NETWORK_TOOLS: ReadonlySet<string> = new Set([ToolNames.WebFetch, ToolNames.WebRead]);
const SHELL_TOOLS: ReadonlySet<string> = new Set([ToolNames.Bash, ToolNames.RunScript]);

const UNCONFINED_REMEDY =
	"enable safety.sandbox (auto or required) with a usable bubblewrap backend, run in a git checkout so the run gets its own worktree, or omit write roots";

/** Resolve the envelope. Every caller, preview and run alike, goes through this one function. */
export function resolveWorkerEnvelope(input: EnvelopeInput): WorkerEnvelope {
	const withheld: WithheldCapability[] = [];
	const take = (capability: string, reason: WithheldReason, remedy?: string): void => {
		if (withheld.some((entry) => entry.capability === capability)) return;
		withheld.push({ capability, reason, ...(remedy !== undefined ? { remedy } : {}) });
	};
	const held = roleHeldTools(input.role, input.capabilityClass);
	const offered = new Set<string>(input.recipeTools);
	// A held tool the recipe never named is nothing the caller asked for: a profile or runtime without it says nothing.
	const unasked = (tool: string): boolean => !offered.has(tool) && held.includes(tool as ToolName);
	const profiled = new Set<string>([...input.profiledTools, ...applyToolProfile(held, input.toolProfile)]);
	for (const tool of input.recipeTools) {
		if (!profiled.has(tool)) take(tool, "tool-profile");
	}
	const rooted = input.write.roots.length > 0;
	const commandsBounded =
		rooted && (input.write.mode === "worktree" || (input.write.mode === "roots" && input.host.confinesWrites));
	const unconfined = rooted && input.write.mode === "roots" && !commandsBounded;
	const names: ToolName[] = [];
	for (const tool of profiled as Set<ToolName>) {
		// Never a worker capability: no worker runtime mediates them, and a solo run has no board.
		if (tool === ToolNames.AskUser || tool === ToolNames.Consult) continue;
		if (tool === ToolNames.Ledger && !input.ledger) continue;
		if (roleExcludes(input.role, input.capabilityClass, tool, toolAction(tool, input.mcp)) !== null) {
			take(tool, "role", roleRemedy(input.role, input.capabilityClass));
			continue;
		}
		if (input.denied.has(tool)) {
			take(tool, "denied");
			continue;
		}
		if (!input.runtime.toolsSupported) {
			if (unasked(tool)) continue;
			take(tool, "runtime", "the route takes no tool calls; choose a model that does");
			continue;
		}
		const harness = isHarnessExtensionToolName(tool);
		if (isMcpToolName(tool) || harness ? !input.runtime.ownLoop : !input.runtime.offers(tool)) {
			if (unasked(tool)) continue;
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
		skills: resolveSkills(input.skills, surface),
		read: { roots: sortedUnique(input.read.roots), outside: sortedUnique(input.read.outside) },
		write: { mode: input.write.mode, roots: [...input.write.roots], commandsBounded },
		...resolveExecAndNetwork(input, surface),
		approval: { ...input.approval },
		sandbox: { backend: input.sandbox.backend, confinesWrites: input.host.confinesWrites },
		withheld,
		staticHead: "",
		permitDigest: input.permitDigest,
	} satisfies Omit<WorkerEnvelope, "digest">;
	return Object.freeze({ ...body, digest: workerEnvelopeDigest(body) });
}

function sortedUnique(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)].sort();
}

function resolveSkills(skills: EnvelopeInput["skills"], surface: ReadonlyArray<ToolName>): WorkerEnvelope["skills"] {
	// Skills reach a run only through the canonical context tool its runtime attaches.
	if (skills.disabled || !skills.contextAttached(surface)) return { bound: [], paths: [], discovery: "off" };
	const bound = sortedUnique(skills.names.map((name) => name.trim()).filter((name) => name.length > 0));
	return { bound, paths: sortedUnique(skills.paths), discovery: bound.length > 0 ? "bound-only" : "ranked" };
}

function resolveExecAndNetwork(
	input: EnvelopeInput,
	surface: ReadonlyArray<ToolName>,
): Pick<WorkerEnvelope, "exec" | "network"> {
	const hasShell = surface.some((tool) => SHELL_TOOLS.has(tool));
	const shell: EnvelopeShell = !hasShell ? "none" : input.sandbox.applies ? "sandboxed" : "host";
	const checks: EnvelopeChecks = !surface.includes(ToolNames.Verify)
		? "none"
		: input.role === "checker" || input.role === "reviewer"
			? "declared"
			: "any";
	const networkTools = surface.filter((tool) => NETWORK_TOOLS.has(tool));
	// Sandboxed commands follow the retrieval grant: a run trusted with web_fetch or web_read already has egress, so an
	// isolated shell would protect nothing while breaking package installs. Unsandboxed commands have the host's network.
	const commands = hasShell || surface.includes(ToolNames.Verify);
	const shellNetwork = input.sandbox.applies
		? !input.sandbox.networkOff && (input.sandbox.networkSetting || networkTools.length > 0)
		: commands;
	const mcp = sortedUnique(
		(input.mcp?.tools ?? [])
			.filter((entry) => entry.network === true && surface.includes(`mcp_${entry.serverId}__${entry.tool}` as ToolName))
			.map((entry) => entry.serverId),
	);
	return { exec: { shell, checks }, network: { shell: shellNetwork, tools: networkTools, mcp } };
}

/** The envelope's approval block from the permit's allowance; `judgeRouted` when the safety judge decides main asks. */
export function envelopeApproval(
	allowance: Pick<WorkerPermitAllowance, "asks" | "approvalAuthority" | "executeAutonomy">,
	judgeRouted: boolean,
): EnvelopeApproval {
	const asks: EnvelopeAsks =
		allowance.asks !== "main"
			? allowance.asks
			: allowance.approvalAuthority === "operator"
				? "operator"
				: judgeRouted
					? "judge"
					: "main";
	return { autonomy: allowance.executeAutonomy === "yolo" ? "yolo" : "default", asks };
}

/** The envelope sealed again with the static head of the request the worker will send. */
export function withStaticHead(envelope: WorkerEnvelope, head: WorkerStaticHeadInput): WorkerEnvelope {
	const { digest: _old, ...body } = envelope;
	const next = { ...body, staticHead: workerStaticHead(head) };
	return Object.freeze({ ...next, digest: workerEnvelopeDigest(next) });
}

function commandEscapesRoots(tool: string, mcp: WorkerMcpAttestation | undefined, harness: boolean): boolean {
	if (toolEscapesWriteRoots(tool) || harness) return true;
	return isMcpToolName(tool) && toolAction(tool, mcp) === "execute";
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

/**
 * The envelope with the permit it wraps swapped, sealed again. Only the operator's yolo may leave a permit after
 * admission (a dispatcher that left yolo while its attempt waited), so the approval block follows that one field.
 */
export function envelopeForPermit(
	envelope: WorkerEnvelope,
	permit: { digest: string; allowance: Pick<WorkerPermitAllowance, "executeAutonomy"> },
): WorkerEnvelope {
	if (envelope.permitDigest === permit.digest) return envelope;
	const { digest: _old, ...body } = envelope;
	const autonomy: EnvelopeApproval["autonomy"] = permit.allowance.executeAutonomy === "yolo" ? "yolo" : "default";
	const next = { ...body, approval: { ...body.approval, autonomy }, permitDigest: permit.digest };
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
