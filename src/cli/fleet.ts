/**
 * `clio fleet` operator surface.
 *
 *   clio fleet list                      enumerate .clio/fleets/*.md with validity
 *   clio fleet run <name> --var k=v ...  preflight + execute a fleet contract
 *   clio fleet status [--json]           runtime snapshot from the durable ledger
 *
 * Fleet contracts are repo-owned policy (.clio/fleets/<name>.md). Preflight
 * fails with zero side effects: nothing is dispatched until the contract
 * parses, every agent resolves, every step scope passes the orchestrator
 * subset check, and the budget gate is open.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDomains } from "../core/domain-loader.js";
import { clioStateDir } from "../core/xdg.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import {
	AgentsDomainModule,
	type FleetContract,
	listFleetContracts,
	loadFleetContract,
	renderFleetPrompt,
} from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule } from "../domains/context/index.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import { compileExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { agentRoleFactsResolver, requestExecutionRole } from "../domains/dispatch/execution-role.js";
import { executePlan } from "../domains/dispatch/execution-scheduler.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import { verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunReceipt } from "../domains/dispatch/types.js";
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

const HELP = `clio fleet <subcommand>

Repo-owned fleet contracts and the dispatch status surface.

Subcommands:
  list                          list .clio/fleets/*.md contracts with validation status
  run <name> [--var k=v ...]    preflight and execute a fleet contract
       [--json]                 emit step receipts as JSON
  status [--json]               show running, retrying, and total dispatch state

Notes:
  status reads the durable run ledger. Rows started by another process show
  heartbeat liveness from the recorded worker pid; per-token live meters are
  only available inside the process that owns the run.
`;

function fail(message: string): number {
	process.stderr.write(`clio fleet: ${message}\n`);
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

function newFleetRootId(): string {
	return `fleet-${randomBytes(6).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function runList(): number {
	const listings = listFleetContracts(process.cwd());
	if (listings.length === 0) {
		process.stdout.write("no fleet contracts found (.clio/fleets/*.md)\n");
		return 0;
	}
	for (const entry of listings) {
		if (entry.contract !== null) {
			const steps = entry.contract.steps.map((step) => `${step.agent}[${step.scope}]`).join(" -> ");
			process.stdout.write(`${entry.name}  valid    ${steps}\n`);
			if (entry.contract.description.length > 0) {
				process.stdout.write(`  ${entry.contract.description}\n`);
			}
			continue;
		}
		process.stdout.write(`${entry.name}  invalid  ${entry.error}\n`);
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

function preflightFleet(contract: FleetContract, deps: FleetPreflightDeps): string | null {
	for (const step of contract.steps) {
		if (!deps.agents.get(step.agent)) {
			return `unknown agent '${step.agent}' (step must name a recipe from 'clio agents')`;
		}
		const requested = step.scope === "readonly" ? deps.safety.scopes.readonly : deps.safety.scopes.workspace;
		if (!deps.safety.isSubset(requested, deps.safety.scopes.workspace)) {
			return `step '${step.agent}' scope '${step.scope}' exceeds the orchestrator scope`;
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
	if (!name) return fail("usage: clio fleet run <name> [--var key=value ...] [--json]");

	// Phase 1: zero-side-effect validation. Parse and render strictly before
	// any domain boots or any process spawns.
	let contract: FleetContract;
	let prompt: string;
	try {
		contract = loadFleetContract(process.cwd(), name);
		prompt = renderFleetPrompt(contract.body, vars);
	} catch (err) {
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
	const plan = compileExecutionPlan({
		topology: "fleet",
		rootTask: prompt,
		maxWorkers: contract.maxWorkers,
		onFailure: contract.onFailure,
		steps: contract.steps.map((step) => {
			const spec = agents.getSpec(step.agent);
			if (spec === null || spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
				throw new Error(`fleet step '${step.id}' has no automatable agent authority`);
			}
			return {
				id: step.id,
				agentId: step.agent,
				scope: step.scope,
				expectedResultContract: spec.resultContract.kind,
				requestedAuthority: spec.capabilityClass,
				approvedAuthority: spec.capabilityClass,
				dependencies: step.dependencies,
				task: prompt,
				executionRole: requestExecutionRole({ agentId: step.agent, resolveFacts: roleFacts }),
			};
		}),
	});
	process.stderr.write(`fleet ${contract.name}: root=${fleetRootId} plan=${plan.hash} steps=${contract.steps.length}\n`);
	const receipts: RunReceipt[] = [];
	try {
		await executePlan(plan, {
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
			async run(step, handoffs, reservation) {
				const request: DispatchRequest = {
					agentId: step.agentId,
					executionRole: step.executionRole,
					task: step.task,
					predecessorHandoffs: handoffs,
					requestOrigin: "user",
					lineage: { parentRunId: fleetRootId, rootRunId: fleetRootId, attempt: 0, depth: 1 },
					reservation,
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
						receipts.push(receipt);
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
			cancel: (assignmentId) => dispatch.abort(assignmentId),
			release: (ownerId) => {
				dispatch.reservations?.rollbackUnconsumed(ownerId);
			},
			releaseUnconsumed: (ownerId) => {
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
	if (!json) {
		const spentUsd = receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0);
		const succeeded = receipts.filter(
			(receipt) => (receipt.outcome ?? (receipt.exitCode === 0 ? "succeeded" : "failed")) === "succeeded",
		).length;
		process.stdout.write(
			`fleet ${contract.name}: ${succeeded}/${contract.steps.length} steps succeeded, total cost $${spentUsd.toFixed(4)}\n`,
		);
	}
	return receipts.length === contract.steps.length && receipts.every((receipt) => receipt.exitCode === 0) ? 0 : 1;
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

export function statusSnapshot(): {
	generatedAt: string;
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
	return { generatedAt: new Date(nowMs).toISOString(), running, retrying: [], totals };
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

export async function runFleetCommand(args: ReadonlyArray<string>): Promise<number> {
	const sub = args[0];
	if (sub === "--help" || sub === "-h" || sub === "help") {
		process.stdout.write(HELP);
		return 0;
	}
	if (sub === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	switch (sub) {
		case "list":
			return runList();
		case "run":
			return runFleet(args.slice(1));
		case "status":
			return runStatus(args.slice(1));
		default:
			process.stderr.write(`clio fleet: unknown subcommand '${sub}'\n`);
			process.stderr.write(HELP);
			return 2;
	}
}
