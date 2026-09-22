/**
 * Dispatch admission authority scenarios: the ceiling a worker's permissions
 * run under, the scope an approval is reusable within, and what deny and stop
 * actually do to the rest of the queue.
 *
 * Every scenario reads the production seam rather than a copy of its table, so
 * a change to the mapping moves the recorded digest instead of passing against
 * a stale fixture.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../../../src/core/defaults.js";
import type { AgentRecipe } from "../../../src/domains/agents/recipe.js";
import type { AgentCapabilityClass } from "../../../src/domains/agents/spec.js";
import { requestExecutionRole } from "../../../src/domains/dispatch/execution-role.js";
import { effectiveWorkerAutonomy } from "../../../src/domains/dispatch/extension.js";
import type { SpawnedWorker } from "../../../src/domains/dispatch/worker-spawn.js";
import type { ActionClass } from "../../../src/domains/safety/action-classifier.js";
import { approvalAxisId, askAxis } from "../../../src/domains/safety/approval-axis.js";
import { AUTONOMY_LEVELS, type AutonomyLevel, mapAutonomy } from "../../../src/domains/safety/autonomy.js";
import type { SafetyDecision } from "../../../src/domains/safety/contract.js";
import {
	classifyDecisionPresentation,
	type DecisionOrigin,
	decisionFactsForPermission,
} from "../../../src/domains/safety/decision-presentation.js";
import type { RejectionMessage } from "../../../src/domains/safety/rejection-feedback.js";
import {
	CONFIRMED_SCOPE,
	isSubset,
	READONLY_SCOPE,
	type ScopeSpec,
	WORKSPACE_SCOPE,
} from "../../../src/domains/safety/scope.js";
import type { WorkerSpec } from "../../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../../../tests/harness/dispatch.js";
import { dispatchStubContext } from "../../../tests/harness/dispatch-stub-context.js";
import { type MachineryObservation, type MachineryScenario, observe } from "./observation.js";

const ACTION_CLASSES: ReadonlyArray<ActionClass> = [
	"read",
	"write",
	"execute",
	"dispatch",
	"system_modify",
	"git_destructive",
	"unknown",
];

const CAPABILITY_CLASSES: ReadonlyArray<AgentCapabilityClass> = [
	"read-only",
	"verification",
	"artifact-write",
	"workspace-edit",
	"orchestration",
	"internal",
];

/** Ordered strictest to most permissive, so "never wider than" is an index comparison. */
const AUTONOMY_RANK = new Map(AUTONOMY_LEVELS.map((level, index) => [level, index] as const));

function rank(level: AutonomyLevel): number {
	return AUTONOMY_RANK.get(level) ?? -1;
}

async function workerAutonomyCeiling(): Promise<MachineryObservation> {
	const resolved: Record<string, AutonomyLevel> = {};
	let everWidened = false;
	let readOnlyRecipeEverEscaped = false;
	for (const session of AUTONOMY_LEVELS) {
		for (const requested of [undefined, ...AUTONOMY_LEVELS]) {
			for (const capabilityClass of CAPABILITY_CLASSES) {
				const level = effectiveWorkerAutonomy(session, requested, capabilityClass);
				resolved[`${session}/${requested ?? "unrequested"}/${capabilityClass}`] = level;
				if (rank(level) > rank(session)) everWidened = true;
				if (capabilityClass === "read-only" && level !== "read-only") readOnlyRecipeEverEscaped = true;
			}
		}
	}
	return observe(
		{ resolved },
		{
			"a request never widens past the session level": !everWidened,
			"a read-only recipe pins read-only at every session level": !readOnlyRecipeEverEscaped,
		},
	);
}

async function autonomyDispositionMatrix(): Promise<MachineryObservation> {
	const dispositions: Record<string, string> = {};
	let readOnlyEverActed = false;
	let outwardEverRanUnsupervised = false;
	for (const level of AUTONOMY_LEVELS) {
		for (const actionClass of ACTION_CLASSES) {
			for (const [label, options] of [
				["plain", {}],
				["execute-recognized", { executeRecognized: true }],
				["plan-scale-dispatch", { dispatchPlanScale: true }],
				["outward", { exposure: "outward" as const }],
				["read-outside-workspace", { readOutsideWorkspace: true }],
			] as const) {
				const disposition = mapAutonomy(level, actionClass, options);
				dispositions[`${level}/${actionClass}/${label}`] = disposition;
				if (level === "read-only" && actionClass !== "read" && disposition === "allow") readOnlyEverActed = true;
				if (label === "outward" && (level === "suggest" || level === "auto-edit") && disposition === "allow") {
					outwardEverRanUnsupervised = true;
				}
			}
		}
	}
	return observe(
		{ dispositions },
		{
			"read-only never allows a non-read class": !readOnlyEverActed,
			"a supervised level never runs an outward gate unasked": !outwardEverRanUnsupervised,
		},
	);
}

async function workerScopeSubset(): Promise<MachineryObservation> {
	const scopes: ReadonlyArray<readonly [string, ScopeSpec]> = [
		["readonly", READONLY_SCOPE],
		["workspace", WORKSPACE_SCOPE],
		["confirmed", CONFIRMED_SCOPE],
	];
	const admitted: Record<string, boolean> = {};
	for (const [workerName, worker] of scopes) {
		for (const [orchestratorName, orchestrator] of scopes) {
			admitted[`${workerName}-under-${orchestratorName}`] = isSubset(worker, orchestrator);
		}
	}
	// A worker that names a write root outside the orchestrator's is the
	// escalation this check exists for; the subtree inside it is the case that
	// must still be admitted, so a legitimate narrowing is not refused.
	const outside: ScopeSpec = { ...WORKSPACE_SCOPE, allowedWriteRoots: ["/etc/"] };
	const inside: ScopeSpec = { ...WORKSPACE_SCOPE, allowedWriteRoots: [join(process.cwd(), "src/")] };
	admitted["escaping-write-root-under-workspace"] = isSubset(outside, WORKSPACE_SCOPE);
	admitted["nested-write-root-under-workspace"] = isSubset(inside, WORKSPACE_SCOPE);
	return observe(
		{ admitted },
		{
			"every scope is a subset of itself": scopes.every(([name]) => admitted[`${name}-under-${name}`] === true),
			"a wider scope is never admitted under a narrower one": admitted["confirmed-under-readonly"] === false,
			"a write root outside the orchestrator's is refused": admitted["escaping-write-root-under-workspace"] === false,
			"a write root inside the orchestrator's is admitted": admitted["nested-write-root-under-workspace"] === true,
		},
	);
}

const PARKED: RejectionMessage = { short: "bash blocked: write", detail: "parked for approval", hints: [] };

function askDecision(match?: { ruleId: string }): SafetyDecision {
	return {
		kind: "ask",
		classification: { actionClass: "write", reasons: [] },
		rejection: PARKED,
		...(match === undefined ? {} : { match: { ruleId: match.ruleId } as never }),
	};
}

async function approvalAxisScoping(): Promise<MachineryObservation> {
	// The axis is the identity an approval is remembered under. A net rail asks
	// at every level, so its axis names the rule; an autonomy ask exists only
	// because of the current level, so its axis names the level. Two asks with
	// different axis ids can never reuse each other's approval.
	const axes: Record<string, string> = {};
	const kinds: Record<string, string> = {};
	for (const level of AUTONOMY_LEVELS) {
		const autonomy = askDecision();
		axes[`autonomy/${level}`] = approvalAxisId(autonomy, level);
		kinds[`autonomy/${level}`] = askAxis(autonomy).kind;
		for (const ruleId of ["rm-rf-root", "curl-pipe-shell"]) {
			const net = askDecision({ ruleId });
			axes[`net/${ruleId}/${level}`] = approvalAxisId(net, level);
			kinds[`net/${ruleId}/${level}`] = askAxis(net).kind;
		}
	}
	const allow: SafetyDecision = { kind: "allow", classification: { actionClass: "read", reasons: [] } };
	axes["allow/auto-edit"] = approvalAxisId(allow, "auto-edit");
	const distinct = new Set(Object.values(axes));
	return observe(
		{ axes, kinds },
		{
			"an autonomy ask is scoped to its level": new Set(AUTONOMY_LEVELS.map((l) => axes[`autonomy/${l}`])).size === 4,
			"a net ask is scoped to its rule, not the level":
				axes["net/rm-rf-root/read-only"] === axes["net/rm-rf-root/full-auto"],
			"two rails never share an approval scope": axes["net/rm-rf-root/suggest"] !== axes["net/curl-pipe-shell/suggest"],
			"every distinct ask keeps a distinct scope": distinct.size === 6,
		},
	);
}

const MAIN_ORIGIN: DecisionOrigin = { kind: "main" };
const WORKER_ORIGIN: DecisionOrigin = { kind: "worker", agentId: "coder", runId: "run-fixture" };

function presentation(origin: DecisionOrigin, actionClass: ActionClass, axis: "autonomy" | "safety-net") {
	return classifyDecisionPresentation(
		decisionFactsForPermission({
			tool: "bash",
			actionClass,
			axis: axis === "autonomy" ? { kind: "autonomy", level: "auto-edit" } : { kind: "safety-net", ruleId: "rm-rf-root" },
			origin,
		}),
	);
}

async function approvalReuseScoping(): Promise<MachineryObservation> {
	// Approving once in the main agent authorizes exactly the presented call.
	// Approving inside a worker run is remembered for identical calls under the
	// same permission conditions, and that memory dies with the run.
	const consequences: Record<string, string> = {};
	const tiers: Record<string, string> = {};
	for (const [originName, origin] of [
		["main", MAIN_ORIGIN],
		["worker", WORKER_ORIGIN],
	] as const) {
		for (const actionClass of ["write", "execute", "system_modify"] as const) {
			for (const axis of ["autonomy", "safety-net"] as const) {
				const key = `${originName}/${actionClass}/${axis}`;
				const view = presentation(origin, actionClass, axis);
				tiers[key] = view.tier;
				const approve = view.requiredActions.find((action) => action.id === "approve-once");
				consequences[key] = approve?.consequence ?? "<absent>";
			}
		}
	}
	const mainGrants = Object.entries(consequences).filter(([key]) => key.startsWith("main/"));
	const workerGrants = Object.entries(consequences).filter(([key]) => key.startsWith("worker/"));
	return observe(
		{ consequences, tiers },
		{
			"a main-agent approval covers only the presented request": mainGrants.every(([, text]) =>
				text.includes("Runs only the presented request"),
			),
			"a main-agent approval never changes the autonomy level": mainGrants.every(([, text]) =>
				text.includes("does not change the autonomy level"),
			),
			"a worker approval is remembered only for identical calls in that run": workerGrants.every(([, text]) =>
				text.includes("identical calls under the same permission conditions in this worker run"),
			),
			"the two origins never share approval wording": mainGrants.every(([, text]) =>
				workerGrants.every(([, other]) => other !== text),
			),
		},
	);
}

async function denyStopSemantics(): Promise<MachineryObservation> {
	const actions: Record<string, ReadonlyArray<string>> = {};
	const denies: Record<string, string> = {};
	const stops: Record<string, string> = {};
	for (const [originName, origin] of [
		["main", MAIN_ORIGIN],
		["worker", WORKER_ORIGIN],
	] as const) {
		for (const actionClass of ACTION_CLASSES) {
			const key = `${originName}/${actionClass}`;
			const view = presentation(origin, actionClass, "autonomy");
			actions[key] = view.requiredActions.map((action) => action.id);
			denies[key] = view.requiredActions.find((action) => action.id === "deny")?.consequence ?? "<absent>";
			stops[key] = view.requiredActions.find((action) => action.id === "stop")?.consequence ?? "<absent>";
		}
	}
	const values = (rows: Record<string, string>, prefix: string) =>
		Object.entries(rows)
			.filter(([key]) => key.startsWith(prefix))
			.map(([, text]) => text);
	return observe(
		{ actions, denies, stops },
		{
			"every permission decision offers approve, deny and stop": Object.values(actions).every(
				(ids) => ids.includes("approve-once") && ids.includes("deny") && ids.includes("stop"),
			),
			"deny in the main agent advances the queue": values(denies, "main/").every((text) =>
				text.includes("Denies only the presented request and advances the queue"),
			),
			"stop in the main agent ends the run and the whole parked queue": values(stops, "main/").every((text) =>
				text.includes("Denies every parked request from this turn and ends the run"),
			),
			"stop in a worker ends the main turn without touching other workers": values(stops, "worker/").every((text) =>
				text.includes("Other worker requests retain their timeout policy"),
			),
			"deny and stop never read the same": Object.keys(actions).every((key) => denies[key] !== stops[key]),
		},
	);
}

interface AdmittedRun {
	agentId: string;
	sessionAutonomy: AutonomyLevel;
	requestedAutonomy?: AutonomyLevel;
	specAutonomy: string | undefined;
	specOnPermission: string | undefined;
	outcome: string;
	outcomeCode: string | null | undefined;
	enforcement: unknown;
}

/** Script one worker result at the worker boundary; all admission and sealing stays in production. */
function scriptedWorker(text: string): () => SpawnedWorker {
	return () => ({
		pid: 400,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events: (async function* () {
			yield {
				type: "message_end",
				message: { role: "assistant", content: text, usage: { input: 1, output: 1 } },
			};
		})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	});
}

const SCOUT_REPORT = JSON.stringify({
	findings: [],
	needsSplit: true,
	proposedSubtasks: [
		{
			id: "inspect-fixture",
			task: "Inspect the bounded fixture",
			dependencies: [],
			expectedResultContract: "scout-report",
			requestedAuthority: "read-only",
		},
	],
});
const MUTATION_REPORT = JSON.stringify({
	mutatedPaths: [],
	validations: [{ name: "scripted fixture", passed: true, evidence: "deterministic harness" }],
});

async function admitOneRun(input: {
	agentId: string;
	result: string;
	task: string;
	sessionAutonomy: AutonomyLevel;
	requestedAutonomy?: AutonomyLevel;
}): Promise<AdmittedRun> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = input.sessionAutonomy;
	const context = dispatchStubContext({ settings });
	const recipes = context.getContract<{ get(id: string): AgentRecipe | null }>("agents");
	const specs: WorkerSpec[] = [];
	const spawn = scriptedWorker(input.result);
	const bundle = makeDispatchBundle(context, {
		spawnWorker: (spec) => {
			specs.push(spec);
			return spawn();
		},
		resilienceCooldownMs: 0,
	});
	const cwd = mkdtempSync(join(tmpdir(), "clio-coder-machinery-dispatch-"));
	await bundle.extension.start();
	try {
		const handle = await bundle.contract.dispatch({
			agentId: input.agentId,
			cwd,
			task: input.task,
			executionRole: requestExecutionRole({
				agentId: input.agentId,
				resolveFacts: (id) => {
					const found = recipes?.get(id);
					return found === null || found === undefined
						? null
						: { capabilityClass: found.capabilityClass, resultContractKind: found.resultContract.kind };
				},
			}),
			...(input.requestedAutonomy === undefined ? {} : { autonomy: input.requestedAutonomy }),
		});
		const receipt = await handle.finalPromise;
		return {
			agentId: input.agentId,
			sessionAutonomy: input.sessionAutonomy,
			...(input.requestedAutonomy === undefined ? {} : { requestedAutonomy: input.requestedAutonomy }),
			specAutonomy: specs[0]?.autonomy,
			specOnPermission: specs[0]?.onPermission,
			outcome: receipt.outcome,
			outcomeCode: receipt.outcomeCode,
			enforcement: receipt.autonomyEnforcement,
		};
	} finally {
		await bundle.extension.stop?.();
		rmSync(cwd, { recursive: true, force: true });
	}
}

async function sealedAutonomyEnforcement(): Promise<MachineryObservation> {
	// The ceiling proved end to end rather than as a table lookup: a request that
	// asks for more authority than the session holds, and a read-only recipe that
	// asks for the most, both reach the worker spec and the sealed receipt at the
	// level admission decided.
	const runs = [
		await admitOneRun({
			agentId: "coder",
			result: MUTATION_REPORT,
			task: "Make the bounded requested fixture update and return the role's declared mutation result.",
			sessionAutonomy: "suggest",
		}),
		await admitOneRun({
			agentId: "coder",
			result: MUTATION_REPORT,
			task: "Make the bounded requested fixture update and return the role's declared mutation result.",
			sessionAutonomy: "suggest",
			requestedAutonomy: "full-auto",
		}),
		await admitOneRun({
			agentId: "scout",
			result: SCOUT_REPORT,
			task: "Inspect the supplied local fixture and return the role's declared evidence report.",
			sessionAutonomy: "full-auto",
			requestedAutonomy: "full-auto",
		}),
	];
	const [inherited, widened, readOnlyRecipe] = runs;
	return observe(
		{ runs },
		{
			"a worker inherits the session level": inherited?.specAutonomy === "suggest",
			"a request cannot widen past the session level": widened?.specAutonomy === "suggest",
			"a read-only recipe stays read-only under full-auto": readOnlyRecipe?.specAutonomy === "read-only",
			"every admitted worker routes asks through the configured permission mode": runs.every(
				(run) => run.specOnPermission === "deny",
			),
			"every run sealed a mediated enforcement grade": runs.every(
				(run) => (run.enforcement as { grade?: string } | undefined)?.grade === "mediated",
			),
			"every run succeeded": runs.every((run) => run.outcome === "succeeded"),
		},
	);
}

export const SCENARIOS: Record<string, MachineryScenario> = {
	"worker-autonomy-ceiling": workerAutonomyCeiling,
	"autonomy-disposition-matrix": autonomyDispositionMatrix,
	"worker-scope-subset": workerScopeSubset,
	"approval-axis-scoping": approvalAxisScoping,
	"approval-reuse-scoping": approvalReuseScoping,
	"deny-stop-semantics": denyStopSemantics,
	"sealed-autonomy-enforcement": sealedAutonomyEnforcement,
};
