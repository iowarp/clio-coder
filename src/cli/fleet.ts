/**
 * `clio-coder fleet` operator surface.
 *
 *   clio-coder fleet list                      enumerate .clio-coder/fleets/*.md with validity
 *   clio-coder fleet new <name> --from <name>  copy a shipped contract into the project
 *   clio-coder fleet validate|graph <name>     inspect a contract without executing it
 *   clio-coder fleet commands init             draft a repository command registry
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
import { type ClioSettings, readSettings } from "../core/config.js";
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
} from "../domains/agents/index.js";
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
	DispatchDomainModule,
	type ExecuteFleetRunInput,
	executeFleetRun,
	type FleetRunOutcome,
	planFleetResume,
	readFleetRun,
} from "../domains/dispatch/index.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
import { WRITE_BOUNDARY_VIOLATION_REASON } from "../domains/dispatch/write-boundary.js";
import { preflightWriteBoundaries } from "../domains/dispatch/write-boundary-enforcer.js";
import { ensureClioState, LifecycleDomainModule } from "../domains/lifecycle/index.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { ObservabilityDomainModule } from "../domains/observability/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { foregroundStreamUsage, ProvidersDomainModule } from "../domains/providers/index.js";
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
  new <name> --from <builtin>   copy build-review, build-test, or sdlc into this repository
  validate <name> [--json]      run the fleet execution preflight without side effects
  graph <name> [--json]         print compiled waves, loops, scopes, and write boundaries
  commands init                 draft a commented command registry from declared project entries
  run <name> [--var k=v ...]    preflight and execute a fleet contract
       [--resume <runId>]        replay a completed prefix from a prior run of the same plan
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

function refuse(message: string): number {
	process.stderr.write(`clio-coder fleet: ${message}\n`);
	return 1;
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

function newFleetRootId(): string {
	return `fleet-${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function renderStep(step: FleetContractStep): string {
	if (step.kind === "code") return `code:${step.command}[${step.scope}]`;
	if (step.kind === "agent") return `${step.agent}[${step.scope}]`;
	if (step.kind === "gate") return `gate:${step.path}[${step.run}]`;
	if (step.kind === "plan") return `plan:${step.agent}[${step.roster.join(",")}; max ${step.maxTasks}]`;
	const check =
		step.check.kind === "code"
			? `code:${step.check.command}`
			: step.check.kind === "gate"
				? `gate:${step.check.gate}`
				: step.check.agent;
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
	settings: Readonly<ClioSettings>;
}

/** Every agent a contract dispatches, including both halves of every loop. */
function contractAgents(
	contract: FleetContract,
): Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> {
	const agents: Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> = [];
	for (const step of contract.steps) {
		if (step.kind === "agent") agents.push({ id: step.id, agent: step.agent, scope: step.scope });
		else if (step.kind === "gate") agents.push({ id: step.id, agent: step.agent, scope: "workspace" });
		else if (step.kind === "plan") {
			agents.push({ id: step.id, agent: step.agent, scope: step.scope });
			for (const agent of step.roster) agents.push({ id: `${step.id}.roster`, agent, scope: "readonly" });
		} else if (step.kind === "loop") {
			if (step.check.kind === "agent") {
				agents.push({ id: `${step.id}.check`, agent: step.check.agent, scope: step.check.scope });
			}
			agents.push({ id: `${step.id}.repair`, agent: step.repair.agent, scope: step.repair.scope });
		}
	}
	return agents;
}

function preflightFleet(contract: FleetContract, deps: FleetPreflightDeps): string | null {
	const targets = new Set(deps.settings.targets.map((target) => target.id));
	const profiles = new Set(Object.keys(deps.settings.workers?.profiles ?? {}));
	const checkRoute = (id: string, route: { target?: string; profile?: string }): string | null => {
		if (route.target !== undefined && !targets.has(route.target))
			return `unknown target '${route.target}' at step '${id}'`;
		if (route.profile !== undefined && !profiles.has(route.profile))
			return `unknown profile '${route.profile}' at step '${id}'`;
		return null;
	};
	for (const step of contract.steps) {
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
	const resumeIndex = rest.indexOf("--resume");
	const resumeId = resumeIndex === -1 ? undefined : rest[resumeIndex + 1];
	if (resumeIndex !== -1 && (resumeId === undefined || resumeId.startsWith("-")))
		return fail("--resume requires a run id");
	const name = rest.find((arg) => !arg.startsWith("-"));
	if (!name) return fail("usage: clio-coder fleet run <name> [--var key=value ...] [--resume <runId>] [--json]");

	let contract: FleetContract;
	let prompt: string;
	let commands: FleetCommandRegistry | null;
	try {
		contract = loadFleetContract(process.cwd(), name);
		prompt = renderFleetPrompt(contract.body, vars);
		commands = loadFleetCommands(process.cwd());
	} catch (err) {
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
	const preflightError = preflightFleet(contract, {
		agents,
		safety,
		scheduling,
		settings: config?.get() ?? readSettings(),
	});
	if (preflightError !== null) {
		await loaded.stop();
		return fail(`preflight failed: ${preflightError}`);
	}

	const fleetRootId = newFleetRootId();
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
					...(step.scope === "readonly" ? { autonomy: "read-only" as const } : {}),
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
			await loaded.stop();
			return fail(`route preflight failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	try {
		preflightWriteBoundaries(plan, process.cwd());
	} catch (err) {
		await loaded.stop();
		return fail(`preflight failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	let resume: ExecuteFleetRunInput["resume"];
	if (resumeId !== undefined) {
		const record = readFleetRun(resumeId);
		if (record === null) {
			await loaded.stop();
			return refuse(`resume run '${resumeId}' was not found in the durable fleet ledger`);
		}
		const planned = planFleetResume(record, plan, contract, vars);
		if (!planned.ok) {
			if (planned.reason === "fleet-name") {
				await loaded.stop();
				return refuse(`resume run '${resumeId}' belongs to fleet '${planned.priorFleet}', not '${planned.currentFleet}'`);
			}
			if (planned.reason === "vars") {
				await loaded.stop();
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
			await loaded.stop();
			return 1;
		}
		resume = { record, replayed: planned.replayed };
	}

	process.stderr.write(
		`fleet ${contract.name}: root=${fleetRootId} plan=${plan.hash} steps=${plan.steps.length} loops=${plan.loops.length}\n`,
	);
	let outcome: FleetRunOutcome;
	try {
		outcome = await executeFleetRun({
			plan,
			contractName: contract.name,
			commands,
			workspaceRoot: process.cwd(),
			fleetRootId,
			dispatch,
			agents: { getSpec: (agentId) => agents.getSpec(agentId) },
			attributionEnabled: config?.get().attribution.gitCommits ?? true,
			vars,
			...(resume !== undefined ? { resume } : {}),
			onStepSettled(step) {
				if (step.replayed === true && step.result !== undefined) {
					if (json)
						process.stdout.write(
							`${JSON.stringify({ stepId: step.stepId, status: "replayed", receipt: { runId: step.result.terminalRunId, digest: step.result.receiptDigest } })}\n`,
						);
					else
						process.stdout.write(
							`step ${step.stepId}: replayed terminal-run=${step.result.terminalRunId} receipt=${step.result.receiptDigest}\n`,
						);
					return;
				}
				if (step.receipt !== undefined) {
					if (json) process.stdout.write(`${JSON.stringify(step.receipt)}\n`);
					else
						process.stdout.write(
							`step ${step.stepId} ${step.agentId}: ${step.succeeded ? "succeeded" : "failed"}${step.failureReason !== undefined ? ` reason=${step.failureReason}` : ""} assignment=${step.assignmentId} terminal-run=${step.terminalRunId} cost=$${step.costUsd.toFixed(4)}\n`,
						);
					return;
				}
				if (step.codeStep !== undefined) {
					if (json) process.stdout.write(`${JSON.stringify({ codeStep: step.codeStep })}\n`);
					else
						process.stdout.write(
							`step ${step.stepId} code:${step.commandId}: ${step.succeeded ? "passed" : "failed"} exit=${step.codeStep.exitCode} ${step.codeStep.durationMs}ms record=${step.recordPath}\n`,
						);
				}
			},
			onNotice(text, kind) {
				if (kind === "write-boundary") process.stderr.write(`${text}\n`);
				else if (kind === "gate" && !json) process.stdout.write(`${text}\n`);
			},
		});
	} catch (err) {
		await dispatch.drain();
		await loaded.stop();
		return fail(err instanceof Error ? err.message : String(err));
	}
	await dispatch.drain();
	await loaded.stop();

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				fleet: contract.name,
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
		process.stdout.write(
			`fleet ${contract.name}: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded, ${outcome.resolvedLoopCount}/${outcome.result.loops.length} loops resolved, total cost $${outcome.totalCostUsd.toFixed(4)}\n`,
		);
		for (const loop of outcome.result.loops)
			process.stdout.write(
				`  loop ${loop.loopId}: ${loop.reason} after ${loop.attempts} verification(s) and ${loop.repairs} repair(s)\n`,
			);
		if (outcome.result.revalidated.length > 0)
			process.stdout.write(
				`  staleness: re-ran ${outcome.result.revalidated.join(", ")} because a workspace step landed after the last green\n`,
			);
		for (const message of outcome.result.needsDecision) process.stdout.write(`  needs operator decision: ${message}\n`);
		for (const boundary of outcome.result.writeBoundaries) {
			if (!boundary.violated) continue;
			process.stdout.write(`  write boundary ${boundary.window}: ${boundary.detail ?? WRITE_BOUNDARY_VIOLATION_REASON}\n`);
		}
	}
	return outcome.cleanRun ? 0 : 1;
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
				budget: row.budget ?? null,
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
		case "new":
			return (await import("./fleet-new.js")).runFleetNew(args.slice(1));
		case "validate":
			return (await import("./fleet-validate.js")).runFleetValidate(args.slice(1));
		case "graph":
			return (await import("./fleet-graph.js")).runFleetGraph(args.slice(1));
		case "commands":
			return (await import("./fleet-commands.js")).runFleetCommands(args.slice(1));
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
