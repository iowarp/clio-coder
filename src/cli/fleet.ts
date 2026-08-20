/**
 * `clio-coder fleet` operator surface.
 *
 *   clio-coder fleet list                      enumerate .clio-coder/fleets/*.md with validity
 *   clio-coder fleet run <name> --var k=v ...  preflight + execute a fleet contract
 *   clio-coder fleet status [--json]           runtime snapshot from the durable ledger
 *   clio-coder fleet drain|resume [--json]      close or reopen durable dispatch admission
 *
 * Fleet contracts are repo-owned policy (.clio-coder/fleets/<name>.md). Preflight
 * fails with zero side effects: nothing is dispatched until the contract
 * parses, every agent resolves, every step scope passes the orchestrator
 * subset check, and the budget gate is open.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attributeCommitMessage } from "../core/commit-attribution.js";
import { loadDomains } from "../core/domain-loader.js";
import { clioStateDir } from "../core/xdg.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import {
	AgentsDomainModule,
	FLEET_COMMANDS_REMEDY,
	FLEET_COMMANDS_REPO_PATH,
	type FleetCommandRegistry,
	FleetCommandRegistryMissingError,
	type FleetContract,
	type FleetContractListing,
	type FleetContractStep,
	listFleetContracts,
	loadFleetCommands,
	loadFleetContract,
	renderFleetPrompt,
	resultContractAuthorship,
} from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule } from "../domains/context/runtime.js";
import { type CapacityDrain, capacityDrain, setCapacityDraining } from "../domains/dispatch/capacity-lease.js";
import { runCodeStep } from "../domains/dispatch/code-step.js";
import { codeStepDir, writeCodeStepRecord } from "../domains/dispatch/code-step-store.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import {
	type ExecutionPlan,
	type ExecutionPlanCodeStep,
	executionPlanAncestors,
} from "../domains/dispatch/execution-plan.js";
import {
	agentRoleFactsResolver,
	gateRouteCorrelation,
	requestExecutionRole,
	withAttemptRole,
} from "../domains/dispatch/execution-role.js";
import { type ExecutionPlanResult, executePlan } from "../domains/dispatch/execution-scheduler.js";
import { deriveFleetCommitAttribution } from "../domains/dispatch/fleet-commit-attribution.js";
import { compileFleetExecutionPlan } from "../domains/dispatch/fleet-plan.js";
import {
	decideReviewGate,
	type GateDecisionCorrelation,
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "../domains/dispatch/gate-decisions.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import { verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { WRITE_BOUNDARY_VIOLATION_REASON } from "../domains/dispatch/write-boundary.js";
import { createWriteBoundaryEnforcer, preflightWriteBoundaries } from "../domains/dispatch/write-boundary-enforcer.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";

const HELP = `clio-coder fleet <subcommand>

Repo-owned fleet contracts and the dispatch status surface.

Subcommands:
  list                          list .clio-coder/fleets/*.md contracts with validation status
  run <name> [--var k=v ...]    preflight and execute a fleet contract
       [--json]                 emit step receipts as JSON
  status [--json]               show running, retrying, and total dispatch state
  drain [--json]                deny new execution starts for up to one hour
  resume [--json]               reopen dispatch admission immediately

Notes:
  status reads the durable run ledger. Rows started by another process show
  heartbeat liveness from the recorded worker pid; per-token live meters are
  only available inside the process that owns the run.
  drain preserves running work. Repeat it to renew the one-hour expiry; resume
  clears it early. The expiry prevents an abandoned drain from wedging Clio.
`;

function fail(message: string): number {
	process.stderr.write(`clio-coder fleet: ${message}\n`);
	return 2;
}

function parseVars(args: ReadonlyArray<string>): { vars: Record<string, string>; rest: string[]; error?: string } {
	const vars: Record<string, string> = {};
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg !== "--var") {
			if (arg !== undefined) rest.push(arg);
			continue;
		}
		const pair = args[i + 1];
		i += 1;
		if (pair === undefined || !pair.includes("=")) {
			return { vars, rest, error: "--var requires key=value" };
		}
		const eq = pair.indexOf("=");
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1);
		if (key.length === 0) return { vars, rest, error: "--var requires a non-empty key" };
		vars[key] = value;
	}
	return { vars, rest };
}

/** Sealed independence facts between the work under review and its reviewer. */
function fleetGateCorrelation(subject: RunReceipt, decider: RunReceipt): GateDecisionCorrelation {
	const facts = (receipt: RunReceipt) => ({
		agentId: receipt.agentId,
		targetId: receipt.targetId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		nodeId: receipt.node?.id ?? "local",
	});
	const { agent, target, modelFamily, runtime, node, independent } = gateRouteCorrelation(
		facts(subject),
		facts(decider),
	);
	return { agent, target, modelFamily, runtime, node, independent };
}

/** Owner id for a plan with no model runs; it holds nothing to release. */
const NO_WORKER_RESERVATION = "fleet-no-worker-reservation";

function newFleetRootId(): string {
	return `fleet-${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function renderStep(step: FleetContractStep): string {
	if (step.kind === "code") return `code:${step.command}[${step.scope}]`;
	if (step.kind === "agent") return `${step.agent}[${step.scope}]`;
	const check = step.check.kind === "code" ? `code:${step.check.command}` : step.check.agent;
	return `loop:${step.id}(${check} -> ${step.repair.agent} x${step.maxAttempts})`;
}

function listingLine(entry: FleetContractListing, state: string, detail: string): string {
	return `${entry.name}  ${entry.source}  ${state.padEnd(7)}  ${detail}\n`;
}

function runList(args: ReadonlyArray<string>): number {
	// `list` took no arguments and silently ignored whatever followed it, so
	// `fleet list --bogus` exited 0 with the normal table and `fleet list --json`
	// printed the human one. Its siblings status, drain, and resume all reject an
	// unrecognised flag, and so do `agents` and `models`.
	const unknown = args[0];
	if (unknown !== undefined) return fail(`list: unknown flag: ${unknown}`);
	const listings = listFleetContracts(process.cwd());
	if (listings.length === 0) {
		process.stdout.write("no fleet contracts found (.clio-coder/fleets/*.md)\n");
		return 0;
	}
	for (const entry of listings) {
		if (entry.contract !== null) {
			const steps = entry.contract.steps.map(renderStep).join(" -> ");
			process.stdout.write(listingLine(entry, "valid", steps));
			if (entry.contract.description.length > 0) {
				process.stdout.write(`  ${entry.contract.description}\n`);
			}
			continue;
		}
		// A shipped fleet whose only gap is a registry this repo has never written
		// is unfinished setup, not a broken contract. Both stay unrunnable; only
		// one of them is fixed by writing a file, so only one is told to.
		if (entry.needsCommands !== null) {
			process.stdout.write(
				listingLine(entry, "setup", `needs ${FLEET_COMMANDS_REPO_PATH} declaring ${entry.needsCommands.join(", ")}`),
			);
			process.stdout.write(`  ${FLEET_COMMANDS_REMEDY}\n`);
			continue;
		}
		process.stdout.write(listingLine(entry, "invalid", entry.error ?? "unknown error"));
	}
	return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface FleetPreflightDeps {
	agents: AgentsContract;
	safety: SafetyContract;
	scheduling: SchedulingContract | undefined;
}

/** Every agent a contract dispatches, including both halves of every loop. */
function contractAgents(
	contract: FleetContract,
): Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> {
	const agents: Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> = [];
	for (const step of contract.steps) {
		if (step.kind === "agent") agents.push({ id: step.id, agent: step.agent, scope: step.scope });
		else if (step.kind === "loop") {
			if (step.check.kind === "agent") {
				agents.push({ id: `${step.id}.check`, agent: step.check.agent, scope: step.check.scope });
			}
			agents.push({ id: `${step.id}.repair`, agent: step.repair.agent, scope: step.repair.scope });
		}
	}
	return agents;
}

function preflightFleet(contract: FleetContract, deps: FleetPreflightDeps): string | null {
	for (const step of contractAgents(contract)) {
		if (!deps.agents.get(step.agent)) {
			return `unknown agent '${step.agent}' (step '${step.id}' must name a recipe from 'clio-coder agents')`;
		}
		const requested = step.scope === "readonly" ? deps.safety.scopes.readonly : deps.safety.scopes.workspace;
		if (!deps.safety.isSubset(requested, deps.safety.scopes.workspace)) {
			return `step '${step.id}' scope '${step.scope}' exceeds the orchestrator scope`;
		}
	}
	if (deps.scheduling) {
		const budget = deps.scheduling.preflight();
		if (budget.verdict === "over" || budget.verdict === "at") {
			return `budget ceiling crossed: $${budget.currentUsd.toFixed(4)} / $${budget.ceilingUsd.toFixed(4)}`;
		}
		if (contract.budgetUsd !== null) {
			const remaining = budget.ceilingUsd - budget.currentUsd;
			if (contract.budgetUsd > remaining) {
				return `fleet budget $${contract.budgetUsd.toFixed(2)} exceeds remaining session budget $${remaining.toFixed(2)}`;
			}
		}
	}
	return null;
}

async function runFleet(args: ReadonlyArray<string>): Promise<number> {
	const { vars, rest, error } = parseVars(args);
	if (error !== undefined) return fail(error);
	const json = rest.includes("--json");
	const name = rest.find((arg) => !arg.startsWith("-"));
	if (!name) return fail("usage: clio-coder fleet run <name> [--var key=value ...] [--json]");

	// Phase 1: zero-side-effect validation. Parse and render strictly before
	// any domain boots or any process spawns.
	let contract: FleetContract;
	let prompt: string;
	let commands: FleetCommandRegistry | null;
	try {
		contract = loadFleetContract(process.cwd(), name);
		prompt = renderFleetPrompt(contract.body, vars);
		// loadFleetContract already refused any unregistered command id; this
		// read is the binding the runner executes.
		commands = loadFleetCommands(process.cwd());
	} catch (err) {
		// The listing calls this state `setup` and says how to leave it; the run
		// path is where a user meets it with intent, so it says the same thing.
		if (err instanceof FleetCommandRegistryMissingError) {
			process.stderr.write(`clio-coder fleet: ${err.message}\n  ${FLEET_COMMANDS_REMEDY}\n`);
			return 2;
		}
		return fail(err instanceof Error ? err.message : String(err));
	}

	ensureClioState();
	const loaded = await loadDomains([
		ConfigDomainModule,
		ResourcesDomainModule,
		ContextDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: true }),
		AgentsDomainModule,
		MiddlewareDomainModule,
		ObservabilityDomainModule,
		SchedulingDomainModule,
		DispatchDomainModule,
		SessionDomainModule,
		LifecycleDomainModule,
	]);
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	const agents = loaded.getContract<AgentsContract>("agents");
	const config = loaded.getContract<ConfigContract>("config");
	const safety = loaded.getContract<SafetyContract>("safety");
	const scheduling = loaded.getContract<SchedulingContract>("scheduling");
	if (!dispatch || !agents || !safety) {
		await loaded.stop();
		return fail("required domains unavailable (dispatch/agents/safety)");
	}

	const roleFacts = agentRoleFactsResolver((id) => agents.getSpec(id));
	const preflightError = preflightFleet(contract, { agents, safety, scheduling });
	if (preflightError !== null) {
		await loaded.stop();
		return fail(`preflight failed: ${preflightError}`);
	}

	const fleetRootId = newFleetRootId();
	let planOutcome: ExecutionPlanResult;
	let plan: ExecutionPlan;
	try {
		plan = compileFleetExecutionPlan({
			contract,
			task: prompt,
			resolveAgent(context) {
				const spec = agents.getSpec(context.agentId);
				if (spec === null || spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
					throw new Error(`fleet step '${context.stepId}' has no automatable agent authority`);
				}
				const requestRole = requestExecutionRole({
					agentId: context.agentId,
					resolveFacts: roleFacts,
					...(context.gateRole !== undefined ? { gateRole: context.gateRole } : {}),
				});
				return {
					requestedAuthority: spec.capabilityClass,
					approvedAuthority: spec.capabilityClass,
					// A gate decider answers the coordinator's question, so its
					// postcondition is the gate result contract, not its recipe's.
					expectedResultContract: context.gateRole === "reviewer" ? "verifier-report" : spec.resultContract.kind,
					executionRole: withAttemptRole(requestRole, context.attempt),
				};
			},
		});
	} catch (err) {
		await loaded.stop();
		return fail(err instanceof Error ? err.message : String(err));
	}
	// A declared boundary is verified against the checkout, so the checkout has
	// to be one this can read. Refused here, before any spawn, rather than
	// discovered as an unenforceable claim halfway through the run.
	try {
		preflightWriteBoundaries(plan, process.cwd());
	} catch (err) {
		await loaded.stop();
		return fail(`preflight failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	const boundaryByStep = new Map(plan.steps.map((step) => [step.id, step.writes]));
	const boundaryEnforcer = createWriteBoundaryEnforcer({
		root: process.cwd(),
		rootId: fleetRootId,
		boundaryFor: (stepId) => boundaryByStep.get(stepId),
		onVerdict(verdict, path) {
			if (verdict.reason === null) return;
			process.stderr.write(`write boundary ${verdict.window}: ${verdict.detail ?? verdict.reason} record=${path}\n`);
		},
	});
	process.stderr.write(
		`fleet ${contract.name}: root=${fleetRootId} plan=${plan.hash} steps=${plan.steps.length} loops=${plan.loops.length}\n`,
	);
	const receipts: RunReceipt[] = [];
	const receiptsByStep = new Map<string, RunReceipt>();
	const planStep = (stepId: string) => plan.steps.find((entry) => entry.id === stepId);
	const attributionEnabled = config?.get().attribution.gitCommits ?? true;
	// Freshness is coordinator-owned execution state. Worker prose cannot set
	// either flag: a successful deterministic verification sets the first, and
	// an integrity-valid independent gate decision sets the second. Any later
	// workspace agent invalidates both before a commit may read them.
	let validationFresh = false;
	let independentReviewFresh = false;

	/**
	 * The commit message is the words of the agent that produced the work, and
	 * only that agent's. Candidates are consulted newest first; when none of
	 * them authored one, code writes a deterministic line rather than inventing
	 * a sentence or reusing somebody else's.
	 */
	const commitMessageFor = (
		step: ExecutionPlanCodeStep,
		priorResults: ReadonlyMap<string, { output: string }>,
	): string => {
		for (const candidate of step.commitFrom ?? []) {
			const source = planStep(candidate);
			const result = priorResults.get(candidate);
			if (source === undefined || source.kind !== "agent" || result === undefined) continue;
			const resultContract = agents.getSpec(source.agentId)?.resultContract ?? null;
			if (resultContract === null) continue;
			const authored = resultContractAuthorship(resultContract, result.output);
			if (authored.commitMessage !== null) return authored.commitMessage;
			if (authored.summary !== null) return `clio(${fleetRootId}): ${authored.summary}`;
		}
		return `clio(${fleetRootId}): ${contract.name} ${step.id}`;
	};
	try {
		planOutcome = await executePlan(plan, {
			preflight(step) {
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					requestOrigin: "user",
					lineage: { parentRunId: fleetRootId, rootRunId: fleetRootId, attempt: 0, depth: 1 },
					...(step.scope === "readonly" ? { autonomy: "read-only" as const } : {}),
				};
				const resolution = dispatch.preview?.(request);
				if (!resolution) throw new Error(`fleet preflight cannot resolve step '${step.id}'`);
				return { step, costUpperBoundUsd: resolution.costUpperBoundUsd, nodeId: resolution.node.id };
			},
			reserve(_plan, admissions) {
				// A fleet of deterministic steps admits no worker and holds no
				// capacity. The reservation authority refuses an empty reservation,
				// correctly: there is nothing to reserve, so nothing is asked of it.
				if (admissions.length === 0) return { ownerId: NO_WORKER_RESERVATION };
				const reservation = dispatch.reservations?.prepare({
					topology: "parallel",
					tasks: admissions.map((admission) => ({
						memberId: admission.step.id,
						wave: plan.waves.findIndex((wave) => wave.includes(admission.step.id)),
						resolution: dispatch.preview?.({
							agentId: admission.step.agentId,
							executionRole: admission.step.executionRole,
							task: admission.step.task,
						}) as NonNullable<ReturnType<NonNullable<DispatchContract["preview"]>>>,
					})),
				});
				if (!reservation) throw new Error("fleet whole-plan reservation is unavailable");
				return { ownerId: reservation.ownerId };
			},
			async run(step, handoffs, reservation, ledger) {
				// A loop repair is attempt n of the same logical work, so it enters
				// the run ledger as one: recovery evidence, not a fresh observation.
				const attempt = step.loop?.role === "repair" ? step.loop.attempt : 0;
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					predecessorHandoffs: handoffs,
					requestOrigin: "user",
					lineage: { parentRunId: fleetRootId, rootRunId: fleetRootId, attempt, depth: 1 },
					reservation,
					...(ledger !== undefined ? { ledger } : {}),
					...(step.loop?.role === "check"
						? {
								gate: {
									role: "reviewer" as const,
									group: `${fleetRootId}:${step.loop.loopId}`,
									cycle: step.loop.attempt,
									subjects: handoffs.map((handoff) => ({
										runId: handoff.terminalRunId,
										digest: handoff.receiptDigest,
									})),
								},
							}
						: {}),
					...(step.scope === "readonly" ? { autonomy: "read-only" as const } : {}),
				};
				const handle = await dispatch.dispatch(request);
				void (async () => {
					for await (const _event of handle.events) {
						/* background display drain */
					}
				})().catch(() => {});
				return {
					assignmentId: handle.runId,
					result: handle.finalPromise.then((receipt) => {
						if (step.scope === "workspace") {
							validationFresh = false;
							independentReviewFresh = false;
						}
						receipts.push(receipt);
						receiptsByStep.set(step.id, receipt);
						const envelope = dispatch.getRun(receipt.runId);
						const integrityValid = envelope !== null && verifyReceiptIntegrity(receipt, envelope).ok;
						const succeeded = receipt.exitCode === 0 && (receipt.outcome === undefined || receipt.outcome === "succeeded");
						if (json) process.stdout.write(`${JSON.stringify(receipt)}\n`);
						else
							process.stdout.write(
								`step ${step.id} ${step.agentId}: ${succeeded ? "succeeded" : "failed"} assignment=${handle.runId} terminal-run=${receipt.runId} cost=$${receipt.costUsd.toFixed(4)}\n`,
							);
						return {
							stepId: step.id,
							assignmentId: handle.runId,
							terminalRunId: receipt.runId,
							receiptDigest: receipt.integrity.digest,
							output: receipt.output?.state === "final" ? receipt.output.text : "",
							succeeded,
							integrityValid,
						};
					}),
				};
			},
			async runCode(step, _handoffs, signal, priorResults) {
				const command = commands?.commands.get(step.commandId);
				if (command === undefined) throw new Error(`fleet code step '${step.id}' has no registered command`);
				const isCommit = step.commitFrom !== undefined;
				const evidence = isCommit
					? deriveFleetCommitAttribution({
							plan,
							step,
							priorResults,
							validationFresh,
							independentReviewFresh,
						})
					: null;
				if (!isCommit && step.scope === "workspace" && step.verification !== true) {
					validationFresh = false;
					independentReviewFresh = false;
				}
				const originalMessage = isCommit ? commitMessageFor(step, priorResults) : null;
				const outcome = await runCodeStep({
					stepId: step.id,
					command,
					workspaceRoot: process.cwd(),
					artifactDir: codeStepDir(fleetRootId),
					signal,
					...(isCommit && evidence !== null && originalMessage !== null
						? {
								substitutions: {
									commitMessage: attributeCommitMessage(originalMessage, evidence, attributionEnabled),
								},
								requireWorkspaceChanges: true,
								commitAttribution: { enabled: attributionEnabled, evidence },
							}
						: {}),
				});
				if (step.verification === true) validationFresh = outcome.report.passed;
				const recordPath = await writeCodeStepRecord(fleetRootId, outcome.record);
				if (json) process.stdout.write(`${JSON.stringify({ codeStep: outcome.record })}\n`);
				else
					process.stdout.write(
						`step ${step.id} code:${command.id}: ${outcome.report.passed ? "passed" : "failed"} exit=${outcome.report.exitCode} ${outcome.record.durationMs}ms record=${recordPath}\n`,
					);
				return {
					stepId: step.id,
					assignmentId: outcome.record.runId,
					terminalRunId: outcome.record.runId,
					receiptDigest: outcome.record.reportDigest,
					output: outcome.output,
					succeeded: outcome.report.passed,
					// The runner authored this report itself, so its provenance is
					// valid by construction; only the command's verdict can be red.
					integrityValid: true,
				};
			},
			async decideLoop({ loop, step, attempt, terminalAttempt, result }) {
				// Reuse the coordinator's existing review policy verbatim: pass ends
				// the loop, a failure with attempts left earns one repair, and the
				// same failure at the bound is simply the terminal answer. `revise`
				// is never a verdict the reviewed model authors.
				const decider = receiptsByStep.get(step.id);
				// The subject is the work under review: the most recent agent run
				// upstream of this verification. A direct dependency is not enough,
				// because a loop's declared dependency is another loop's
				// deterministic check, which produced no receipt at all.
				const ancestors = executionPlanAncestors(plan, step.id);
				let subject: RunReceipt | undefined;
				for (const [stepId, receipt] of receiptsByStep) {
					if (ancestors.has(stepId)) subject = receipt;
				}
				if (decider === undefined || subject === undefined) {
					return {
						resolved: false,
						findings: null,
						needsDecision: `loop '${loop.id}' cycle ${attempt} has no sealed reviewer or subject receipt`,
					};
				}
				const correlation = fleetGateCorrelation(subject, decider);
				const decided = decideReviewGate({
					group: `${fleetRootId}:${loop.id}`,
					cycle: attempt,
					terminalCycle: terminalAttempt,
					subjects: [{ runId: subject.runId, digest: subject.integrity.digest }],
					decider: { runId: decider.runId, digest: decider.integrity.digest },
					correlation,
					output: result.output,
				});
				independentReviewFresh = decided.verdict === "pass" && correlation.independent;
				const staged = stagePendingGateDecision(decided.draft);
				const { path: decisionPath } = materializePendingGateDecision(staged);
				if (!json) {
					process.stdout.write(
						`loop ${loop.id} cycle ${attempt}: ${decided.draft.outcome}${decided.draft.detail === undefined ? "" : ` (${decided.draft.detail})`} decision=${decisionPath}\n`,
					);
				}
				return {
					resolved: decided.verdict === "pass",
					findings: decided.findings,
					needsDecision: decided.needsDecision,
				};
			},
			beginWriteBoundary: (window, stepIds) => boundaryEnforcer.begin(window, stepIds),
			verifyWriteBoundary: (window, stepIds) => boundaryEnforcer.verify(window, stepIds),
			cancel: (assignmentId) => dispatch.abort(assignmentId),
			release: (ownerId) => {
				if (ownerId === NO_WORKER_RESERVATION) return;
				dispatch.reservations?.rollbackUnconsumed(ownerId);
			},
			releaseUnconsumed: (ownerId) => {
				if (ownerId === NO_WORKER_RESERVATION) return;
				dispatch.reservations?.rollbackUnconsumed(ownerId);
			},
		});
	} catch (err) {
		await dispatch.drain();
		await loaded.stop();
		return fail(err instanceof Error ? err.message : String(err));
	}
	await dispatch.drain();
	await loaded.stop();
	// A loop is judged by whether it converged, not attempt by attempt: a red
	// verification that a later attempt fixed is the loop working as declared,
	// and a node a resolved loop made unnecessary never had to run at all.
	const required = plan.steps.filter((step) => step.loop === undefined && !planOutcome.unneeded.includes(step.id));
	const failedLoops = planOutcome.loops.filter((loop) => !loop.resolved);
	const succeededSteps = required.filter((step) => planOutcome.results.get(step.id)?.succeeded === true).length;
	const resolvedLoops = planOutcome.loops.length - failedLoops.length;
	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				fleet: contract.name,
				rootId: fleetRootId,
				planHash: plan.hash,
				loops: planOutcome.loops,
				revalidated: planOutcome.revalidated,
				unneeded: planOutcome.unneeded,
				skipped: planOutcome.skipped,
				needsDecision: planOutcome.needsDecision,
				writeBoundaries: planOutcome.writeBoundaries,
			})}\n`,
		);
	} else {
		const spentUsd = receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0);
		process.stdout.write(
			`fleet ${contract.name}: ${succeededSteps}/${required.length} steps succeeded, ${resolvedLoops}/${planOutcome.loops.length} loops resolved, total cost $${spentUsd.toFixed(4)}\n`,
		);
		for (const loop of planOutcome.loops) {
			process.stdout.write(
				`  loop ${loop.loopId}: ${loop.reason} after ${loop.attempts} verification(s) and ${loop.repairs} repair(s)\n`,
			);
		}
		if (planOutcome.revalidated.length > 0) {
			process.stdout.write(
				`  staleness: re-ran ${planOutcome.revalidated.join(", ")} because a workspace step landed after the last green\n`,
			);
		}
		for (const message of planOutcome.needsDecision) process.stdout.write(`  needs operator decision: ${message}\n`);
		for (const boundary of planOutcome.writeBoundaries) {
			if (!boundary.violated) continue;
			process.stdout.write(`  write boundary ${boundary.window}: ${boundary.detail ?? WRITE_BOUNDARY_VIOLATION_REASON}\n`);
		}
	}
	const cleanRun =
		failedLoops.length === 0 &&
		planOutcome.skipped.length === 0 &&
		required.every((step) => planOutcome.results.get(step.id)?.succeeded === true);
	return cleanRun ? 0 : 1;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number | null): boolean {
	if (pid === null || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function rowHeartbeat(row: RunEnvelope): "alive" | "stale" | "dead" | "n/a" {
	if (row.status === "stale") return "stale";
	if (row.status === "dead") return "dead";
	return isProcessAlive(row.pid) ? "alive" : "dead";
}

function finiteCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function receiptTokenSplit(row: RunEnvelope): { input: number; output: number } | null {
	const path = row.receiptPath ?? join(clioStateDir(), "receipts", `${row.id}.json`);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunReceipt>;
		return { input: finiteCount(parsed.inputTokenCount), output: finiteCount(parsed.outputTokenCount) };
	} catch {
		return null;
	}
}

/**
 * Input/output token split for a ledger row. Finalized rows carry the split
 * directly; rows written before the ledger carried it fall back to the
 * durable receipt so status totals agree with what the receipt records.
 */
function rowTokenSplit(row: RunEnvelope): { input: number; output: number } {
	if (row.inputTokenCount !== undefined || row.outputTokenCount !== undefined) {
		return { input: finiteCount(row.inputTokenCount), output: finiteCount(row.outputTokenCount) };
	}
	if (row.endedAt !== null) {
		return receiptTokenSplit(row) ?? { input: 0, output: 0 };
	}
	return { input: 0, output: 0 };
}

export type FleetAdmissionStatus =
	| { state: "open" }
	| { state: "draining"; requestedByPid: number; requestedAt: string; expiresAt: string };

function admissionStatus(drain: CapacityDrain | null): FleetAdmissionStatus {
	if (drain === null) return { state: "open" };
	return { state: "draining", ...drain };
}

export function statusSnapshot(): {
	generatedAt: string;
	admission: FleetAdmissionStatus;
	running: Array<Record<string, unknown>>;
	retrying: Array<Record<string, unknown>>;
	totals: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; runtimeSeconds: number };
} {
	const ledger = openLedger();
	const nowMs = Date.now();
	const rows = ledger.list();
	const running = rows
		.filter((row) => row.endedAt === null && (row.status === "running" || row.status === "stale"))
		.map((row) => {
			const startedMs = Date.parse(row.startedAt);
			return {
				runId: row.id,
				agentId: row.agentId,
				runtimeKind: row.runtimeKind,
				outcomePhase: row.status,
				heartbeat: rowHeartbeat(row),
				lineage: row.lineage ?? { parentRunId: null, rootRunId: row.id, attempt: 0, depth: 0 },
				startedAt: row.startedAt,
				elapsedMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0,
				tokens: { input: 0, output: 0, total: row.tokenCount },
				costUsd: row.costUsd,
				node: row.node?.id ?? "local",
			};
		});
	const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 };
	for (const row of rows) {
		const split = rowTokenSplit(row);
		totals.inputTokens += split.input;
		totals.outputTokens += split.output;
		totals.totalTokens += row.tokenCount;
		totals.costUsd += row.costUsd;
		const startedMs = Date.parse(row.startedAt);
		const endedMs = row.endedAt !== null ? Date.parse(row.endedAt) : nowMs;
		if (Number.isFinite(startedMs) && Number.isFinite(endedMs)) {
			totals.runtimeSeconds += Math.max(0, endedMs - startedMs) / 1000;
		}
	}
	// The retry queue is in-memory orchestrator state and intentionally not
	// durable (Symphony §14.3); cross-process it is always empty here.
	return {
		generatedAt: new Date(nowMs).toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running,
		retrying: [],
		totals,
	};
}

function runStatus(args: ReadonlyArray<string>): number {
	const unknown = args.find((arg) => arg !== "--json");
	if (unknown) return fail(`status: unknown flag: ${unknown}`);
	const snapshot = statusSnapshot();
	if (args.includes("--json")) {
		process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
		return 0;
	}
	process.stdout.write(`dispatch status @ ${snapshot.generatedAt} (ledger: ${clioStateDir()})\n`);
	process.stdout.write(
		snapshot.admission.state === "draining"
			? `admission: draining until ${snapshot.admission.expiresAt} (requested by pid ${snapshot.admission.requestedByPid} at ${snapshot.admission.requestedAt})\n`
			: "admission: open\n",
	);
	if (snapshot.running.length === 0) {
		process.stdout.write("running: none\n");
	} else {
		process.stdout.write("running:\n");
		for (const row of snapshot.running) {
			const lineage = row.lineage as { attempt: number; depth: number };
			process.stdout.write(
				`  ${row.runId}  ${row.agentId}  node=${row.node}  ${row.heartbeat}  attempt=${lineage.attempt} depth=${lineage.depth}  ${Math.round((row.elapsedMs as number) / 1000)}s  $${(row.costUsd as number).toFixed(4)}\n`,
			);
		}
	}
	if (snapshot.retrying.length === 0) {
		process.stdout.write("retrying: none (retry queue is in-memory and only visible in the owning process)\n");
	} else {
		process.stdout.write("retrying:\n");
		for (const row of snapshot.retrying) {
			process.stdout.write(`  ${row.runId}  ${row.agentId}  attempt=${row.attempt} due=${row.dueAt}  ${row.reason}\n`);
		}
	}
	const t = snapshot.totals;
	process.stdout.write(
		`totals: tokens=${t.totalTokens} (in=${t.inputTokens} out=${t.outputTokens}) cost=$${t.costUsd.toFixed(4)} runtime=${Math.round(t.runtimeSeconds)}s\n`,
	);
	return 0;
}

function runAdmissionControl(command: "drain" | "resume", args: ReadonlyArray<string>): number {
	const unknown = args.find((arg) => arg !== "--json");
	if (unknown) return fail(`${command}: unknown flag: ${unknown}`);
	ensureClioState();
	const admission = admissionStatus(setCapacityDraining(command === "drain"));
	if (args.includes("--json")) {
		process.stdout.write(`${JSON.stringify({ admission }, null, 2)}\n`);
		return 0;
	}
	if (admission.state === "draining") {
		process.stdout.write(
			`dispatch admission is draining until ${admission.expiresAt}; running work continues (requested by pid ${admission.requestedByPid})\n`,
		);
	} else {
		process.stdout.write("dispatch admission is open\n");
	}
	return 0;
}

export async function runFleetCommand(args: ReadonlyArray<string>): Promise<number> {
	const sub = args[0];
	// Asking for help is not a usage error, and it is not an argument either.
	// `status|drain|resume --help` answered `unknown flag: --help` on stderr with
	// status 2, `run --help` answered its usage the same way, and `list --help`
	// ignored the flag and listed the contracts. Anywhere on the line it is a
	// question, answered here before any subcommand executes.
	if (sub === "help" || args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (sub === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	switch (sub) {
		case "list":
			return runList(args.slice(1));
		case "run":
			return runFleet(args.slice(1));
		case "status":
			return runStatus(args.slice(1));
		case "drain":
			return runAdmissionControl("drain", args.slice(1));
		case "resume":
			return runAdmissionControl("resume", args.slice(1));
		default:
			process.stderr.write(`clio-coder fleet: unknown subcommand '${sub}'\n`);
			process.stderr.write(HELP);
			return 2;
	}
}
