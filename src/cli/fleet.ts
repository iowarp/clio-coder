/**
 * `clio-coder fleet` operator surface.
 *
 *   clio-coder fleet run <playbook> --var k=v ...  preflight + execute a playbook
 *   clio-coder fleet status [--json] [--all]   runtime snapshot from the durable ledger
 *   clio-coder fleet decisions --json [--all]  bounded sealed review and compete gate verdicts
 *   clio-coder fleet view <runId|fleetRootId>  one run's transcript, or a root's step index
 *   clio-coder fleet drain|resume [--json]      close or reopen durable dispatch admission
 *   clio-coder fleet cancel <runId>             cancel one run from any terminal
 *
 * Playbooks are repo-owned policy (.clio-coder/playbooks/<name>.md); the fleet
 * runs them. Preflight fails with zero side effects: nothing is dispatched until the playbook
 * parses, every agent resolves, every step scope passes the orchestrator
 * subset check, and the budget gate is open.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type ClioSettings, readSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import { getTerminationCoordinator, resolveShutdownHookBudgetMs } from "../core/termination.js";
import { clioStateDir } from "../core/xdg.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import {
	AgentsDomainModule,
	loadPlaybook,
	loadPlaybookCommands,
	PLAYBOOK_COMMANDS_REMEDY,
	type Playbook,
	type PlaybookCommandRegistry,
	PlaybookCommandRegistryMissingError,
	renderPlaybookPrompt,
} from "../domains/agents/index.js";
import { isShadowAgent, userOriginAudienceRefusal } from "../domains/agents/spec.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule } from "../domains/context/runtime.js";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
	type RunToolBudgetEnvelope,
} from "../domains/dispatch/budget-envelope.js";
import { type CapacityDrain, capacityDrain, setCapacityDraining } from "../domains/dispatch/capacity-lease.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { bindExecutionPlanEndpoints, type ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { agentRoleFactsResolver, requestExecutionRole, withAttemptRole } from "../domains/dispatch/execution-role.js";
import { compileFleetExecutionPlan } from "../domains/dispatch/fleet-plan.js";
import {
	createDispatchDomainModule,
	type ExecuteFleetRunInput,
	executeFleetRun,
	type FleetRunOutcome,
	FleetWorkspaceBusyError,
	FleetWorkspaceLockUnavailableError,
	planFleetResume,
	readFleetRun,
} from "../domains/dispatch/index.js";
import { readReceiptTextSync } from "../domains/dispatch/receipt-store.js";
import { configureRunEventJournal } from "../domains/dispatch/run-event-journal.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { WRITE_BOUNDARY_VIOLATION_REASON } from "../domains/dispatch/write-boundary.js";
import { preflightWriteBoundaries } from "../domains/dispatch/write-boundary-enforcer.js";
import { ExtensionsDomainModule } from "../domains/extensions/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import {
	type CostProvenance,
	foregroundStreamUsage,
	normalizeCostProvenance,
	ProvidersDomainModule,
} from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { budgetRemainingText, budgetSpendText, SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import {
	aggregateCostAmounts,
	type CostAggregate,
	renderCostAggregate,
	renderCostAmount,
	TelemetryDomainModule,
} from "../domains/telemetry/index.js";
import { type RunTokenField, runsTotal } from "../domains/telemetry/read-model.js";
import { runFleetWithShutdown } from "./fleet-lifecycle.js";
import { fleetInspectionScope } from "./fleet-project-scope.js";
import { createFleetReporter } from "./fleet-reporting.js";
import { parsePlaybookVars } from "./playbook-vars.js";
import { createCliWorkerHooks } from "./worker-extension-hooks.js";
import { convertWorkspaceForCommand } from "./workspace-conversion.js";

const HELP = `clio-coder fleet <subcommand>

Run repo-owned playbooks on the fleet, and inspect the dispatch status surface.
Author and check playbooks with clio-coder playbook.

Subcommands:
  nodes add|list|remove|test     manage SSH worker nodes and project verification
  land [<run>] [--squash] [--yes]  list, preview or land task branches finished runs kept
  run <playbook> [--var k=v ...]  preflight and execute a playbook
       [--resume <runId>]        replay a completed prefix from a prior run of the same plan
       [--json]                 emit step receipts as JSON
  status [--json] [--all]       show running, retrying, and total dispatch state
  decisions --json [--all]      emit a bounded window of sealed review and compete gate verdicts
  view <runId> [--follow] [--all]  read one run's ledger entry, event journal, and receipt
  view <fleetRootId> [--all]    list a fleet run's steps and the run id to view for each
  events <fleetRootId> [--follow] [--json] [--all]
                                print a fleet run's live event journal of hash-chained, unsigned
                                lines; each settled step names the manifest bytes written at that
                                moment, and --follow exits after fleet_sealed
  drain [--json]                deny new execution starts for up to one hour
  resume [--json]               reopen dispatch admission immediately
  cancel <runId> [--json] [--reason <text>]
                                cancel one running run from any terminal

Notes:
  Inspection defaults to this project. Pass --all to inspect machine-wide state.
  status reads the durable run ledger. Rows started by another process show
  heartbeat liveness from the recorded worker pid; per-token live meters are
  only available inside the process that owns the run.
  view is read-only and shares no memory with the orchestrator, so it follows a
  run from a second terminal or over SSH. Its transcript comes from the run
  event journal, written when fleet.history.journal is on (the default). Handed the
  fleet-<hex> root id that run prints, it lists that run's steps instead.
  drain preserves running work. Repeat it to renew the one-hour expiry; resume
  clears it early. The expiry prevents an abandoned drain from wedging Clio.
  cancel asks the process that owns the run to abort it and waits up to 15s
  for the run to seal canceled; it exits 1 while the request is still pending.
  When the owning process is gone it terminates the orphaned worker's process
  group and settles the ledger row itself.
`;

function fail(message: string): number {
	process.stderr.write(`clio-coder fleet: ${message}\n`);
	return 2;
}

function refuse(message: string): number {
	process.stderr.write(`clio-coder fleet: ${message}\n`);
	return 1;
}

function newFleetRootId(): string {
	return `fleet-${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface FleetPreflightDeps {
	agents: AgentsContract;
	safety: SafetyContract;
	scheduling: SchedulingContract | undefined;
	settings: Readonly<ClioSettings>;
}

/** Every agent a playbook dispatches, including both halves of every loop. */
function playbookAgents(playbook: Playbook): Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> {
	const agents: Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> = [];
	for (const step of playbook.steps) {
		if (step.kind === "agent") {
			agents.push({ id: step.id, agent: step.agent, scope: step.scope });
		} else if (step.kind === "gate") {
			agents.push({ id: step.id, agent: step.agent, scope: "workspace" });
		} else if (step.kind === "plan") {
			agents.push({ id: step.id, agent: step.agent, scope: step.scope });
			for (const agent of step.roster) {
				agents.push({ id: `${step.id}.roster`, agent, scope: "readonly" });
			}
		} else if (step.kind === "loop") {
			if (step.check.kind === "agent") {
				agents.push({
					id: `${step.id}.check`,
					agent: step.check.agent,
					scope: step.check.scope,
				});
			}
			agents.push({
				id: `${step.id}.repair`,
				agent: step.repair.agent,
				scope: step.repair.scope,
			});
		}
	}
	return agents;
}

function preflightPlaybook(playbook: Playbook, deps: FleetPreflightDeps): string | null {
	const targets = new Set(deps.settings.targets.map((target) => target.id));
	const profiles = new Set(Object.keys(deps.settings.fleet?.profiles ?? {}));
	const checkRoute = (id: string, route: { target?: string; profile?: string }): string | null => {
		if (route.target !== undefined && !targets.has(route.target)) {
			return `unknown target '${route.target}' at step '${id}'`;
		}
		if (route.profile !== undefined && !profiles.has(route.profile)) {
			return `unknown profile '${route.profile}' at step '${id}'`;
		}
		return null;
	};
	for (const step of playbook.steps) {
		if (step.kind === "agent" || step.kind === "gate" || step.kind === "plan") {
			const error = checkRoute(step.id, step);
			if (error !== null) return error;
		}
		if (step.kind !== "loop") continue;
		if (step.check.kind === "agent") {
			const error = checkRoute(`${step.id}.check`, step.check);
			if (error !== null) return error;
		}
		const error = checkRoute(`${step.id}.repair`, step.repair);
		if (error !== null) return error;
	}
	for (const step of playbookAgents(playbook)) {
		if (!deps.agents.get(step.agent)) {
			return `unknown agent '${step.agent}' (step '${step.id}' must name a recipe from 'clio-coder agents')`;
		}
		const spec = deps.agents.getSpec(step.agent);
		if (spec !== null && isShadowAgent(spec)) {
			return `${userOriginAudienceRefusal(spec)} (step '${step.id}')`;
		}
		const requested = step.scope === "readonly" ? deps.safety.scopes.readonly : deps.safety.scopes.workspace;
		if (!deps.safety.isSubset(requested, deps.safety.scopes.workspace)) {
			return `step '${step.id}' scope '${step.scope}' exceeds the orchestrator scope`;
		}
	}
	if (deps.scheduling) {
		const budget = deps.scheduling.preflight();
		if (budget.verdict === "over" || budget.verdict === "at") {
			return `budget ceiling crossed: ${budgetSpendText(budget.currentUsd, budget.pricing)} / ${renderCostAmount(budget.ceilingUsd, "known")}`;
		}
		if (playbook.budgetUsd !== null && budget.ceilingUsd > 0) {
			const remaining = budget.ceilingUsd - budget.currentUsd;
			if (playbook.budgetUsd > remaining) {
				return `fleet budget ${renderCostAmount(playbook.budgetUsd, "known")} exceeds remaining session budget ${budgetRemainingText(budget.ceilingUsd, budget.currentUsd, budget.pricing)}`;
			}
		}
	}
	return null;
}

async function runFleet(
	args: ReadonlyArray<string>,
	reporter: ReturnType<typeof createFleetReporter>,
): Promise<number> {
	const { vars, rest, error } = parsePlaybookVars(args);
	if (error !== undefined) return fail(error);
	// A positional scan, so an option value is never read as the playbook name
	// (`--resume <runId> <name>` used to run a playbook named after the run id)
	// and an unknown flag is refused instead of running the playbook anyway.
	let json = false;
	let resumeId: string | undefined;
	let name: string | undefined;
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === undefined) continue;
		if (arg === "--json") json = true;
		else if (arg === "--resume") {
			const value = rest[index + 1];
			if (value === undefined || value.startsWith("-")) return fail("--resume requires a run id");
			resumeId = value;
			index += 1;
		} else if (arg.startsWith("-")) return fail(`unknown fleet run option: ${arg}`);
		else name ??= arg;
	}
	if (!name) {
		return fail("usage: clio-coder fleet run <playbook> [--var key=value ...] [--resume <runId>] [--json]");
	}

	let playbook: Playbook;
	let prompt: string;
	let commands: PlaybookCommandRegistry | null;
	try {
		playbook = loadPlaybook(process.cwd(), name);
		prompt = renderPlaybookPrompt(playbook.body, vars);
		commands = loadPlaybookCommands(process.cwd());
	} catch (err) {
		if (err instanceof PlaybookCommandRegistryMissingError) {
			process.stderr.write(`clio-coder fleet: ${err.message}\n  ${PLAYBOOK_COMMANDS_REMEDY}\n`);
			return 2;
		}
		return fail(err instanceof Error ? err.message : String(err));
	}

	ensureClioState();
	const workerHooks = createCliWorkerHooks("fleet");
	const loaded = await loadDomains([
		ConfigDomainModule,
		ExtensionsDomainModule,
		ResourcesDomainModule,
		ContextDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: true }),
		AgentsDomainModule,
		MiddlewareDomainModule,
		TelemetryDomainModule,
		SchedulingDomainModule,
		// A fleet step is dispatched by executeFleetRun, which drains the handle
		// itself and never builds a dispatch event registry, so the domain is the
		// only thing that can write each step's durable transcript.
		createDispatchDomainModule({ journalRunEvents: true, workerSteering: false, workerHooks: workerHooks.workerHooks }),
		SessionDomainModule,
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
	const fleetSettings = config?.get() ?? readSettings();
	// Install `fleet.history.journal` the same way the interactive composition root
	// does, so a fleet run honours the setting without the journal ever reading
	// settings.yaml from the dispatch event path.
	configureRunEventJournal(fleetSettings.fleet.history.journal);
	const roleFacts = agentRoleFactsResolver((id) => agents.getSpec(id));
	const preflightError = preflightPlaybook(playbook, {
		agents,
		safety,
		scheduling,
		settings: fleetSettings,
	});
	if (preflightError !== null) {
		await loaded.stop();
		return fail(`preflight failed: ${preflightError}`);
	}

	const fleetRootId = newFleetRootId();
	let plan: ExecutionPlan;
	try {
		plan = compileFleetExecutionPlan({
			commands,
			...(vars ? { vars } : {}),
			playbook,
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
					expectedResultContract:
						context.planRole === true
							? "delegation-plan"
							: context.gateAuthorRole === true
								? "artifact-report"
								: context.gateRole === "reviewer"
									? "verifier-report"
									: spec.resultContract.kind,
					executionRole: withAttemptRole(requestRole, context.attempt),
				};
			},
		});
	} catch (err) {
		await loaded.stop();
		return fail(err instanceof Error ? err.message : String(err));
	}
	// Started before route preflight, so preview sees the tool hooks dispatch
	// will and refuses a step whose route cannot carry a blocking one before any
	// step runs and writes. Every exit from here disposes the host.
	const stopRun = async (): Promise<void> => {
		await workerHooks.dispose();
		await loaded.stop();
	};
	let hookRefusal: string | null;
	try {
		hookRefusal = await workerHooks.start(loaded);
	} catch (err) {
		await stopRun();
		return fail(err instanceof Error ? err.message : String(err));
	}
	if (hookRefusal !== null) {
		await stopRun();
		return refuse(hookRefusal);
	}
	if (dispatch.preview !== undefined) {
		try {
			const foreground = foregroundStreamUsage();
			const bindings: Record<string, { key: string; limit: number; foregroundHeld?: number } | undefined> = {};
			for (const step of plan.steps) {
				if (step.kind === "code") continue;
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					...(step.scope === "readonly" ? { readOnly: true as const } : {}),
					...(step.target !== undefined ? { target: step.target } : {}),
					...(step.profile !== undefined ? { workerProfile: step.profile } : {}),
				};
				const endpoint = dispatch.preview(request).endpoint;
				if (endpoint === undefined) continue;
				const foregroundHeld = foreground[endpoint.key] ?? 0;
				bindings[step.id] = {
					key: endpoint.key,
					limit: endpoint.limit,
					...(foregroundHeld > 0 ? { foregroundHeld } : {}),
				};
			}
			plan = bindExecutionPlanEndpoints(plan, bindings);
		} catch (err) {
			await stopRun();
			return fail(`route preflight failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	try {
		preflightWriteBoundaries(plan, process.cwd());
	} catch (err) {
		await stopRun();
		return fail(`preflight failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	let resume: ExecuteFleetRunInput["resume"];
	if (resumeId !== undefined) {
		const record = readFleetRun(resumeId);
		if (record === null) {
			await stopRun();
			return refuse(`resume run '${resumeId}' was not found in the durable fleet ledger`);
		}
		const planned = planFleetResume(record, plan, playbook, vars, process.cwd());
		if (!planned.ok) {
			if (planned.reason === "fleet-name") {
				await stopRun();
				return refuse(`resume run '${resumeId}' belongs to fleet '${planned.priorFleet}', not '${planned.currentFleet}'`);
			}
			if (planned.reason === "workspace") {
				await loaded.stop();
				return refuse(
					planned.priorCwd === null
						? `resume run '${resumeId}' predates recorded workspaces, so it cannot be resumed in ${planned.currentCwd}`
						: `resume run '${resumeId}' ran in ${planned.priorCwd}, not ${planned.currentCwd}`,
				);
			}
			if (planned.reason === "running") {
				await loaded.stop();
				return refuse(
					`resume run '${resumeId}' is still running in process ${planned.pid}; wait for it to settle or cancel it first`,
				);
			}
			if (planned.reason === "vars") {
				await stopRun();
				return refuse(`resume run '${resumeId}' used different --var values`);
			}
			process.stderr.write(
				`clio-coder fleet: resume plan hash differs: prior=${planned.priorHash} current=${planned.currentHash}\n`,
			);
			for (const entry of planned.diff) {
				process.stderr.write(`  step ${entry.index + 1}: ${entry.priorId} -> ${entry.currentId}\n`);
				process.stderr.write(`    prior: ${JSON.stringify(entry.prior)}\n`);
				process.stderr.write(`    current: ${JSON.stringify(entry.current)}\n`);
			}
			await stopRun();
			return 1;
		}
		resume = { record, replayed: planned.replayed };
	}

	let dispatchDrain: Promise<void> | undefined;
	const beginDispatchDrain = (): Promise<void> => (dispatchDrain ??= dispatch.drain());
	let outcome: FleetRunOutcome;
	let runSignal: AbortSignal | undefined;
	try {
		outcome = await runFleetWithShutdown(
			(signal, registerEmergencySeal) => {
				runSignal = signal;
				return executeFleetRun({
					registerEmergencySeal,
					plan,
					signal,
					playbookName: playbook.name,
					commands,
					workspaceRoot: process.cwd(),
					fleetRootId,
					dispatch,
					agents: { getSpec: (agentId) => agents.getSpec(agentId) },
					attributionEnabled: config?.get().integrations.git.commitAttribution ?? true,
					vars,
					...(resume !== undefined ? { resume } : {}),
					onStarted() {
						reporter.stderr(
							`fleet ${playbook.name}: root=${fleetRootId} plan=${plan.hash} steps=${plan.steps.length} loops=${plan.loops.length}\n`,
						);
					},
					onStepSettled(step) {
						if (step.replayed === true && step.result !== undefined) {
							if (json) {
								reporter.stdout(
									`${JSON.stringify({
										stepId: step.stepId,
										status: "replayed",
										receipt: {
											runId: step.result.terminalRunId,
											digest: step.result.receiptDigest,
										},
									})}\n`,
								);
							} else {
								reporter.stdout(
									`step ${step.stepId}: replayed terminal-run=${step.result.terminalRunId} receipt=${step.result.receiptDigest}\n`,
								);
							}
							return;
						}
						if (step.receipt !== undefined) {
							if (json) reporter.stdout(`${JSON.stringify(step.receipt)}\n`);
							else {
								reporter.stdout(
									`step ${step.stepId} ${step.agentId}: ${step.succeeded ? "succeeded" : "failed"}${step.failureReason !== undefined ? ` reason=${step.failureReason}` : ""} assignment=${step.assignmentId} terminal-run=${step.terminalRunId} cost=${renderCostAmount(step.costUsd, step.costProvenance, step.costSummary)}\n`,
								);
							}
							return;
						}
						if (step.codeStep !== undefined) {
							if (json) {
								reporter.stdout(`${JSON.stringify({ codeStep: step.codeStep })}\n`);
							} else {
								reporter.stdout(
									`step ${step.stepId} code:${step.commandId}: ${
										step.succeeded ? "passed" : "failed"
									} exit=${step.codeStep.exitCode} ${step.codeStep.durationMs}ms record=${step.recordPath}\n`,
								);
							}
						}
					},
					onNotice(text, kind) {
						// A notice without a kind (a failed workspace lock release) goes to stderr like a write boundary.
						if (kind === "gate") {
							if (!json) reporter.stdout(`${text}\n`);
						} else reporter.stderr(`${text}\n`);
					},
				});
			},
			async () => {
				await beginDispatchDrain();
				await workerHooks.drain();
				await workerHooks.dispose();
				await loaded.stop();
			},
			dispatch.drainAllowanceMs?.(),
			undefined,
			{
				beginDrain: beginDispatchDrain,
				notice: (text) => reporter.stderr(`${text}\n`),
				cleanupAllowanceMs: (loaded.loaded.length + 1) * resolveShutdownHookBudgetMs(),
			},
		);
	} catch (err) {
		if (runSignal?.aborted && err === runSignal.reason) return getTerminationCoordinator().getExitCode();
		// A busy or unjudgeable workspace lock refuses this run; it is not a usage error, so it exits 1 like the other refusals.
		if (err instanceof FleetWorkspaceBusyError || err instanceof FleetWorkspaceLockUnavailableError) {
			return refuse(err.message);
		}
		return fail(err instanceof Error ? err.message : String(err));
	}

	if (json) {
		reporter.stdout(
			`${JSON.stringify({
				playbook: playbook.name,
				rootId: fleetRootId,
				planHash: plan.hash,
				loops: outcome.result.loops,
				revalidated: outcome.result.revalidated,
				unneeded: outcome.result.unneeded,
				skipped: outcome.result.skipped,
				needsDecision: outcome.result.needsDecision,
				writeBoundaries: outcome.result.writeBoundaries,
			})}\n`,
		);
	} else {
		reporter.stdout(
			`fleet ${playbook.name}: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded, ${outcome.resolvedLoopCount}/${outcome.result.loops.length} loops resolved, total cost ${renderCostAggregate(outcome.totalCost)}\n`,
		);
		for (const loop of outcome.result.loops) {
			reporter.stdout(
				`  loop ${loop.loopId}: ${loop.reason} after ${loop.attempts} verification(s) and ${loop.repairs} repair(s)\n`,
			);
		}
		if (outcome.result.revalidated.length > 0) {
			reporter.stdout(
				`  staleness: re-ran ${outcome.result.revalidated.join(
					", ",
				)} because a workspace step landed after the last green\n`,
			);
		}
		for (const message of outcome.result.needsDecision) {
			reporter.stdout(`  needs operator decision: ${message}\n`);
		}
		for (const boundary of outcome.result.writeBoundaries) {
			if (!boundary.violated) continue;
			reporter.stdout(`  write boundary ${boundary.window}: ${boundary.detail ?? WRITE_BOUNDARY_VIOLATION_REASON}\n`);
		}
		// The root id printed at the top is the only identifier this command
		// advertises, so say what it is good for rather than leaving an operator
		// to guess that the viewer wants a per-step run id.
		reporter.stdout(`  clio-coder fleet view ${fleetRootId}   step index with each step's run id\n`);
	}
	return runSignal?.aborted ? getTerminationCoordinator().getExitCode() : outcome.cleanRun ? 0 : 1;
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

/** A running row's input/output split, which the owning process writes to the ledger on each reconciler tick. */
function rowTokenSplit(row: RunEnvelope): { input: number; output: number } {
	return { input: finiteCount(row.inputTokenCount), output: finiteCount(row.outputTokenCount) };
}

const countOrNull = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export type FleetAdmissionStatus =
	| { state: "open" }
	| {
			state: "draining";
			requestedByPid: number;
			requestedAt: string;
			expiresAt: string;
	  };

function admissionStatus(drain: CapacityDrain | null): FleetAdmissionStatus {
	if (drain === null) return { state: "open" };
	return { state: "draining", ...drain };
}

function statusSnapshot(all = false): {
	generatedAt: string;
	admission: FleetAdmissionStatus;
	running: Array<Record<string, unknown>>;
	retrying: Array<Record<string, unknown>>;
	totals: {
		/** The known part of each token field: a run whose ledger row and receipt hold no count adds nothing here. */
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		/** The bare sum, kept for JSON readers that already parse it. Render `cost`. */
		costUsd: number;
		/** Mirrors what `DispatchSnapshot.totals.cost` declares for the in-process surface. */
		cost: CostAggregate;
		runtimeSeconds: number;
		/** How many runs the totals cover, and how many left each token field partial or unknown (#434 §11.3). */
		coverage: { runs: number; unknownRuns: { input: number; output: number; total: number } };
		/** Each token field as the read model words it, a lower bound beside its unknown runs. */
		display: { input: string; output: string; total: string };
	};
} {
	const ledger = openLedger();
	const nowMs = Date.now();
	const scope = fleetInspectionScope(all);
	const rows = ledger.list().filter(scope.seesRun);
	const running = rows
		.filter((row) => row.endedAt === null && (row.status === "running" || row.status === "stale"))
		.map((row) => {
			const startedMs = Date.parse(row.startedAt);
			return {
				runId: row.id,
				agentId: row.agentId,
				budget: row.budget ?? null,
				runtimeKind: row.runtimeKind,
				outcomePhase: row.status,
				heartbeat: rowHeartbeat(row),
				lineage: row.lineage ?? { parentRunId: null, rootRunId: row.id, attempt: 0, depth: 0 },
				startedAt: row.startedAt,
				elapsedMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0,
				tokens: { ...rowTokenSplit(row), total: row.tokenCount },
				costUsd: row.costUsd,
				// Absent on pre-provenance ledger rows, which readers must treat as
				// unknown; `renderCostAmount` normalizes it rather than assuming free.
				costProvenance: row.costProvenance,
				costSummary: row.costSummary,
				node: row.node?.id ?? "local",
			};
		});
	// The rows' own counts, folded so a run that recorded none is unknown rather than zero. Reading every run journal
	// instead cost ~3 s over a full 1,000-run ring, against ~12 ms for the ledger alone.
	const fields = rows.map(rowTokenFields);
	const tokens = {
		input: runsTotal(fields.map((field) => field.input)),
		output: runsTotal(fields.map((field) => field.output)),
		total: runsTotal(fields.map((field) => field.total)),
	};
	let runtimeSeconds = 0;
	// Folded rather than summed: a ledger of runs nobody priced totals to an
	// absent cost claim, not to zero dollars.
	const cost = aggregateCostAmounts(
		rows.map((row) => ({
			usd: row.costUsd,
			provenance: normalizeCostProvenance(row.costProvenance),
			apiCalls: row.apiCalls ?? 1,
			missingTokenCalls: row.missingTokenCalls ?? 0,
			...(row.costSummary ? { costSummary: row.costSummary } : {}),
		})),
	);
	for (const row of rows) {
		const startedMs = Date.parse(row.startedAt);
		const endedMs = row.endedAt !== null ? Date.parse(row.endedAt) : nowMs;
		if (Number.isFinite(startedMs) && Number.isFinite(endedMs)) {
			runtimeSeconds += Math.max(0, endedMs - startedMs) / 1000;
		}
	}
	// The retry queue is in-memory orchestrator state and intentionally not
	// durable (Symphony §14.3); cross-process it is always empty here.
	return {
		generatedAt: new Date(nowMs).toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running,
		retrying: [],
		totals: {
			inputTokens: tokens.input.known,
			outputTokens: tokens.output.known,
			totalTokens: tokens.total.known,
			costUsd: cost.knownUsd,
			cost,
			runtimeSeconds,
			coverage: {
				runs: rows.length,
				unknownRuns: {
					input: tokens.input.unknownRuns,
					output: tokens.output.unknownRuns,
					total: tokens.total.unknownRuns,
				},
			},
			display: { input: tokens.input.display, output: tokens.output.display, total: tokens.total.display },
		},
	};
}

/**
 * A ledger row's token fields as the read model folds them. A row is partial when some of its calls reported no usage,
 * or when it predates the count that says so. A row written before the ledger carried the split takes its receipt's,
 * and a field neither holds is unknown, never zero (#434 §6.3).
 */
function rowTokenFields(row: RunEnvelope): Record<"input" | "output" | "total", RunTokenField> {
	const partial = row.missingTokenCalls === undefined ? row.apiCalls === undefined : row.missingTokenCalls > 0;
	const split =
		row.inputTokenCount !== undefined || row.outputTokenCount !== undefined
			? { input: countOrNull(row.inputTokenCount), output: countOrNull(row.outputTokenCount) }
			: row.endedAt !== null
				? receiptTokenFields(row)
				: { input: null, output: null };
	return {
		input: { known: split.input, partial },
		output: { known: split.output, partial },
		total: { known: countOrNull(row.tokenCount), partial },
	};
}

function receiptTokenFields(row: RunEnvelope): { input: number | null; output: number | null } {
	const path = row.receiptPath ?? join(clioStateDir(), "receipts", `${row.id}.json`);
	try {
		const parsed = JSON.parse(readReceiptTextSync(path)) as Partial<RunReceipt>;
		return { input: countOrNull(parsed.inputTokenCount), output: countOrNull(parsed.outputTokenCount) };
	} catch {
		return { input: null, output: null };
	}
}

function runStatus(args: ReadonlyArray<string>): number {
	const unknown = args.find((arg) => arg !== "--json" && arg !== "--all");
	if (unknown) return fail(`status: unknown flag: ${unknown}`);
	const snapshot = statusSnapshot(args.includes("--all"));
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
				`  ${row.runId}  ${row.agentId}  node=${row.node}  ${row.heartbeat}  attempt=${lineage.attempt} depth=${lineage.depth}  ${Math.round((row.elapsedMs as number) / 1000)}s  ${renderCostAmount(row.costUsd as number, row.costProvenance as CostProvenance | undefined, row.costSummary as CostAggregate | undefined)}\n`,
			);
			const budget = row.budget as RunToolBudgetEnvelope | null;
			if (budget !== null) {
				process.stdout.write(`    recipe policy: ${formatBudgetPolicy(budget)}\n`);
				process.stdout.write(`    requested envelope: ${formatBudgetRequest(budget)}\n`);
				process.stdout.write(`    effective envelope: ${formatEffectiveBudget(budget)}\n`);
				process.stdout.write(`    clamp or escalation reason: ${formatBudgetReasons(budget)}\n`);
			}
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
		`totals: tokens=${t.display.total} (in=${t.display.input} out=${t.display.output}) cost=${renderCostAggregate(t.cost)} runtime=${Math.round(t.runtimeSeconds)}s\n`,
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
	if (sub === "view" && (args.includes("--help") || args.includes("-h"))) {
		return (await import("./fleet-view.js")).runFleetView(args.slice(1));
	}
	if (sub === "events" && (args.includes("--help") || args.includes("-h"))) {
		return (await import("./fleet-events.js")).runFleetEvents(args.slice(1));
	}
	// Asking for help is not a usage error, and it is not an argument either.
	// `status|drain|resume --help` answered `unknown flag: --help` on stderr with
	// status 2, and `run --help` answered its usage the same way. Anywhere on the
	// line it is a question, answered here before any subcommand executes.
	if (sub === "help" || args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (sub === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	switch (sub) {
		case "run": {
			const reporter = createFleetReporter();
			try {
				await convertWorkspaceForCommand();
				return await runFleet(args.slice(1), reporter);
			} finally {
				// Signal shutdown still writes notices after the run has sealed.
				if (getTerminationCoordinator().getPhase() === "idle") await reporter.dispose();
			}
		}
		case "status":
			return runStatus(args.slice(1));
		case "inspect":
			// The callerless host projection was removed at the maintainer's decision; the run board and the read model
			// serve what it carried (#434 §11.3).
			process.stderr.write(
				"fleet inspect was removed: read the run board with `clio-coder fleet status --json [--all]` and one run's telemetry with `clio-coder telemetry inspect --run <runId> --json`\n",
			);
			return 2;
		case "decisions":
			return (await import("./fleet-decisions.js")).runFleetDecisions(args.slice(1));
		case "verify":
			return (await import("./fleet-verify.js")).runFleetVerify(args.slice(1));
		case "view":
			return (await import("./fleet-view.js")).runFleetView(args.slice(1));
		case "events":
			return (await import("./fleet-events.js")).runFleetEvents(args.slice(1));
		case "drain":
			return runAdmissionControl("drain", args.slice(1));
		case "resume":
			return runAdmissionControl("resume", args.slice(1));
		case "cancel":
			return (await import("./fleet-cancel.js")).runFleetCancel(args.slice(1));
		default:
			process.stderr.write(`clio-coder fleet: unknown subcommand '${sub}'\n`);
			process.stderr.write(HELP);
			return 2;
	}
}
