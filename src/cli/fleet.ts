/**
 * `clio-coder fleet` operator surface.
 *
 *   clio-coder fleet run <playbook> --var k=v ...  preflight + execute a playbook
 *   clio-coder fleet status [--json] [--all]   runtime snapshot from the durable ledger
 *   clio-coder fleet decisions --json [--all]  bounded sealed review and compete gate verdicts
 *   clio-coder fleet view <runId|fleetRootId>  one run's transcript, or a root's step index
 *   clio-coder fleet code-steps <rootId> [--json]  deterministic code steps of one fleet root
 *   clio-coder fleet drain|resume [--json]      close or reopen durable dispatch admission
 *   clio-coder fleet cancel <runId>             cancel one run from any terminal
 *
 * Playbooks are repo-owned policy (.clio-coder/playbooks/<name>.md); the fleet
 * runs them. Preflight fails with zero side effects: nothing is dispatched until the playbook
 * parses, every agent resolves, every step scope passes the orchestrator
 * subset check, and the budget gate is open.
 */

import { randomBytes } from "node:crypto";
import { type ClioSettings, readSettings } from "../core/config.js";
import { loadDomains } from "../core/domain-loader.js";
import type { FactSum } from "../core/telemetry/fact.js";
import { factKnownValue } from "../core/telemetry/known.js";
import { sumFactSums } from "../core/telemetry/pricing.js";
import { renderPricingSum, renderUsdLimit, renderUsdSum } from "../core/telemetry/render.js";
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
import type { DispatchRequest } from "../domains/dispatch/contract.js";
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
import { configureRunEventJournal } from "../domains/dispatch/run-event-journal.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { WRITE_BOUNDARY_VIOLATION_REASON } from "../domains/dispatch/write-boundary.js";
import { preflightWriteBoundaries } from "../domains/dispatch/write-boundary-enforcer.js";
import { ExtensionsDomainModule } from "../domains/extensions/index.js";
import { ensureClioState } from "../domains/lifecycle/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { foregroundStreamUsage, ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import type { SafetyContract } from "../domains/safety/contract.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import { budgetRemainingText, budgetSpendText, SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { loadRunTelemetrySource } from "../domains/session/telemetry-source.js";
import { TelemetryDomainModule } from "../domains/telemetry/index.js";
import { fleetTotals, runTelemetry } from "../domains/telemetry/read-model.js";
import { runFleetWithShutdown } from "./fleet-lifecycle.js";
import { fleetInspectionScope } from "./fleet-project-scope.js";
import { createFleetReporter } from "./fleet-reporting.js";
import { parseDuration } from "./kit/duration.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { parseCommandFlags } from "./kit/flags.js";
import { jsonDocument, writeCliFailure, writeJson } from "./kit/json-out.js";
import { type RunCause, resolveRunExit, signalForExitCode } from "./modes/run-json-schema-v2.js";
import { playbookAgents, playbookPreflightDiagnostic } from "./playbook-preflight.js";
import { parsePlaybookVars } from "./playbook-vars.js";
import { createCliWorkerHooks } from "./worker-extension-hooks.js";
import { convertWorkspaceForCommand } from "./workspace-conversion.js";

const HELP = `clio-coder fleet <subcommand>

Run repo-owned playbooks on the fleet, and inspect the dispatch status surface.
Author and check playbooks with clio-coder playbook.

Subcommands:
  nodes add|discover|install|tools|list|remove|test
                                manage SSH worker nodes and project verification
  land [<run>] [options]        list, preview or land task branches finished runs kept
  run <playbook> [--var k=v ...]  preflight and execute a playbook
       [--resume <runId>]        replay a completed prefix from a prior run of the same plan
       [--output-format text|json|stream-json]
                                json prints one fleet_end result document; stream-json prints
                                fleet_started, step_dispatched, step_settled and fleet_end lines
       [--cwd <dir>]             run as if started in <dir>
       [--timeout <duration>]    stop the fleet when the deadline passes and exit 124 (bare number: seconds)
       [--max-cost-usd <usd>]    stop the fleet once settled steps spend this much and exit 4; the cap
                                is the lower of this and the playbook's budgetUsd
       [--json]                 deprecated: the per-step JSON lines of earlier releases
  status [--json] [--all]       show running, retrying, and total dispatch state
  list [--all-projects] [--limit N] [--json]
                                list this project's fleet roots, newest first, with each one's state
                                (sealed, ended, running, orphaned) and sealed outcome; --all is an alias
  decisions --json [--all]      emit a bounded window of sealed review and compete gate verdicts
  view <runId> [--follow] [--all]  read one run's ledger entry, event journal, and run record
  view <fleetRootId> [--all]    list a fleet run's steps and the run id to view for each
  code-steps <rootId> [--json]  list the deterministic code steps one fleet root ran, from the
                                code_step.settled records in the root's run journal
  events <fleetRootId> [--follow] [--json] [--all]
                                print a fleet run's live event journal of hash-chained, unsigned
                                lines; each settled step names the manifest bytes written at that
                                moment, and --follow exits after fleet_sealed
  verify <runId> [--json] [--exit-code]
                                re-verify one run's sealed scope now and print its trust state;
                                --exit-code exits 0 verified, 1 failed or unavailable, 75 pending
  admission [status|drain|open] [--json]
                                show the dispatch admission gate, deny new execution starts for up
                                to one hour (drain), or reopen it (open)
  drain [--json]                alias of admission drain
  resume [--json]               alias of admission open
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
  clears it early. The expiry keeps an abandoned drain from wedging CLIO Coder.
  cancel asks the process that owns the run to abort it and waits up to 15s
  for the run to seal canceled; it exits 1 while the request is still pending.
  When the owning process is gone it terminates the orphaned worker's process
  group and settles the ledger row itself.
  fleet run exits 0 when every required step succeeded and every loop converged,
  1 otherwise, and the signal's code when interrupted. With --output-format it
  exits 141 once the fleet has sealed if stdout's reader went away; the fleet is
  never canceled for that.
`;

/** A busy or unjudgeable workspace lock refuses a run; it is not a usage error, so it exits 1 like the other refusals. */
function fleetFailureExitCode(err: unknown): number {
	return err instanceof FleetWorkspaceBusyError || err instanceof FleetWorkspaceLockUnavailableError ? 1 : 2;
}

/** The last diagnostic `fail` or `refuse` printed, so a structured fleet run can carry it in its refusal document. */
let lastFleetDiagnostic: string | null = null;

function fail(message: string): number {
	lastFleetDiagnostic = message;
	process.stderr.write(`clio-coder fleet: ${message}\n`);
	return 2;
}

function refuse(message: string): number {
	lastFleetDiagnostic = message;
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
	/** The fleet's effective spend cap: the playbook's budgetUsd, lowered by --max-cost-usd. */
	budgetUsd: number | null;
}

/** The shared static preflight, then the checks only a booted session can make: step scope and session budget. */
function preflightPlaybook(playbook: Playbook, deps: FleetPreflightDeps): string | null {
	const shared = playbookPreflightDiagnostic(playbook, {
		settings: deps.settings,
		agentSpec: (id) => (deps.agents.get(id) ? deps.agents.getSpec(id) : undefined),
	});
	if (shared !== null) return shared;
	for (const step of playbookAgents(playbook)) {
		const requested = step.scope === "readonly" ? deps.safety.scopes.readonly : deps.safety.scopes.workspace;
		if (!deps.safety.isSubset(requested, deps.safety.scopes.workspace)) {
			return `step '${step.id}' scope '${step.scope}' exceeds the orchestrator scope`;
		}
	}
	if (deps.scheduling) {
		const budget = deps.scheduling.preflight();
		if (budget.verdict === "over" || budget.verdict === "at") {
			return `budget ceiling crossed: ${budgetSpendText(budget.currentUsd, budget.pricing)} / ${renderUsdLimit(budget.ceilingUsd)}`;
		}
		if (deps.budgetUsd !== null && budget.ceilingUsd > 0) {
			const remaining = budget.ceilingUsd - budget.currentUsd;
			if (deps.budgetUsd > remaining) {
				return `fleet budget ${renderUsdLimit(deps.budgetUsd)} exceeds remaining session budget ${budgetRemainingText(budget.ceilingUsd, budget.currentUsd, budget.pricing)}`;
			}
		}
	}
	return null;
}

type FleetOutputFormat = "text" | "json" | "stream-json";

interface FleetRunOptions {
	name: string;
	vars: ReturnType<typeof parsePlaybookVars>["vars"];
	resumeId?: string;
	/** The deprecated `--json` stream, kept byte for byte. */
	legacyJson: boolean;
	format: FleetOutputFormat;
	/** `--output-format` was given, which opts the run into the exit codes of 6.5 (exit 141 on a closed reader). */
	formatGiven: boolean;
	cwd?: string;
	timeoutMs?: number;
	maxCostUsd?: number;
}

const FLEET_RUN_USAGE =
	"usage: clio-coder fleet run <playbook> [--var key=value ...] [--resume <runId>] [--output-format text|json|stream-json] [--cwd <dir>] [--timeout <duration>] [--max-cost-usd <usd>]";

/** Parse `fleet run` arguments once, before anything reads the working directory `--cwd` may change. */
function parseFleetRunArgs(args: ReadonlyArray<string>): FleetRunOptions | { error: string } {
	const { vars, rest, error } = parsePlaybookVars(args);
	if (error !== undefined) return { error };
	// A positional scan, so an option value is never read as the playbook name
	// (`--resume <runId> <name>` used to run a playbook named after the run id)
	// and an unknown flag is refused instead of running the playbook anyway.
	let legacyJson = false;
	let name: string | undefined;
	const values = new Map<string, string>();
	const VALUE_OPTIONS = new Set(["--resume", "--output-format", "--cwd", "--timeout", "--max-cost-usd"]);
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === undefined) continue;
		if (arg === "--json") {
			legacyJson = true;
			continue;
		}
		const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		if (VALUE_OPTIONS.has(flag)) {
			const value = equals === -1 ? rest[index + 1] : arg.slice(equals + 1);
			if (value === undefined || (equals === -1 && value.startsWith("-")) || value.length === 0) {
				return { error: flag === "--resume" ? "--resume requires a run id" : `${flag} requires a value` };
			}
			if (values.has(flag)) return { error: `${flag} given more than once` };
			values.set(flag, value);
			if (equals === -1) index += 1;
		} else if (arg.startsWith("-")) return { error: `unknown fleet run option: ${arg}` };
		else name ??= arg;
	}
	if (!name) return { error: FLEET_RUN_USAGE };
	const format = values.get("--output-format");
	if (format !== undefined && format !== "text" && format !== "json" && format !== "stream-json") {
		return { error: `--output-format takes text, json or stream-json, got '${format}'` };
	}
	if (format !== undefined && legacyJson) return { error: "--json and --output-format cannot be combined" };
	const options: FleetRunOptions = {
		name,
		vars,
		legacyJson,
		format: format ?? "text",
		formatGiven: format !== undefined,
	};
	const resumeId = values.get("--resume");
	if (resumeId !== undefined) options.resumeId = resumeId;
	const cwd = values.get("--cwd");
	if (cwd !== undefined) options.cwd = cwd;
	const timeout = values.get("--timeout");
	if (timeout !== undefined) {
		const parsed = parseDuration(timeout, { bareUnit: "s" });
		if (!parsed.ok) return { error: `--timeout: ${parsed.message}` };
		options.timeoutMs = parsed.ms;
	}
	const cost = values.get("--max-cost-usd");
	if (cost !== undefined) {
		const usd = Number(cost);
		if (!/^\d+(\.\d+)?$/u.test(cost) || !Number.isFinite(usd) || usd <= 0) {
			return { error: `--max-cost-usd takes a positive amount in USD, got '${cost}'` };
		}
		options.maxCostUsd = usd;
	}
	return options;
}

type FleetStepOutcome = "succeeded" | "failed" | "replayed";
type FleetCost = FleetRunOutcome["totalCost"];

/** What one fleet run learned on its way, for the fleet result document (6.13) every structured exit path writes. */
interface FleetRunTrack {
	rootId: string | null;
	planHash: string | null;
	started: boolean;
	documentWritten: boolean;
	steps: Array<{ stepId: string; runId: string | null; outcome: FleetStepOutcome }>;
	stopCause: "deadline" | "max_cost_usd" | null;
	/** USD the settled, non-replayed steps spent, folded by core so this surface sums no cost field. */
	spent: FactSum;
	totalCost: FleetCost | null;
	cleanRun: boolean | null;
	limits: {
		maxCostUsd: number | null;
		maxCostSource: "flag" | "playbook" | null;
		/** Only --max-cost-usd stops a running fleet; a playbook budgetUsd alone is a preflight check. */
		enforced: boolean;
		/** A step already in flight finishes its spend before the stop lands. */
		overshootPossible: boolean;
		timeoutMs: number | null;
	};
}

function fleetEndDocument(
	options: FleetRunOptions,
	track: FleetRunTrack,
	exitCode: number,
	causes: ReadonlyArray<RunCause>,
): Record<string, unknown> {
	const completionState = !track.started
		? "refused"
		: track.stopCause !== null || causes.some((cause) => cause.code === "interrupted")
			? "stopped"
			: "completed";
	const stopReason =
		completionState !== "stopped"
			? null
			: (track.stopCause ?? (causes.some((cause) => cause.code === "interrupted") ? "signal" : null));
	const succeeded = track.steps.filter((step) => step.outcome !== "failed").length;
	const aggregate = track.cleanRun === true && exitCode === 0 ? "pass" : succeeded === 0 ? "fail" : "partial";
	return {
		type: "fleet_end",
		schemaVersion: 1,
		rootId: track.rootId,
		playbook: options.name,
		planHash: track.planHash,
		exitCode,
		completion: { state: completionState, stopReason },
		verdict: { aggregate, steps: track.steps },
		// Token usage is per step in each step's run record; the fleet total is the step counts it settled.
		usage: { steps: track.steps.length, succeededSteps: succeeded },
		cost:
			track.totalCost === null
				? null
				: {
						usd: factKnownValue(track.totalCost.usd),
						measuredUsd: track.totalCost.usd.measured,
						estimatedUsd: track.totalCost.usd.estimated,
						unknownCount: track.totalCost.usd.unknownCount,
						display: renderPricingSum(track.totalCost),
					},
		causes,
		limits: track.limits,
	};
}

async function runFleet(options: FleetRunOptions, reporter: ReturnType<typeof createFleetReporter>): Promise<number> {
	const track: FleetRunTrack = {
		rootId: null,
		planHash: null,
		started: false,
		documentWritten: false,
		steps: [],
		stopCause: null,
		spent: sumFactSums([]),
		totalCost: null,
		cleanRun: null,
		limits: {
			maxCostUsd: options.maxCostUsd ?? null,
			maxCostSource: options.maxCostUsd !== undefined ? "flag" : null,
			enforced: options.maxCostUsd !== undefined,
			overshootPossible: options.maxCostUsd !== undefined,
			timeoutMs: options.timeoutMs ?? null,
		},
	};
	lastFleetDiagnostic = null;
	const code = await runFleetTracked(options, reporter, track);
	if (options.format !== "text" && !track.documentWritten) {
		// Every exit that never reached the end of the run still answers with the one result document (6.6).
		const cause: RunCause = {
			code: track.started ? "run_failed" : "not_started",
			...(lastFleetDiagnostic !== null ? { message: lastFleetDiagnostic } : {}),
		};
		reporter.stdout(`${JSON.stringify(fleetEndDocument(options, track, code, [cause]))}\n`);
	}
	return code;
}

async function runFleetTracked(
	options: FleetRunOptions,
	reporter: ReturnType<typeof createFleetReporter>,
	track: FleetRunTrack,
): Promise<number> {
	const { name, vars, resumeId } = options;
	const json = options.legacyJson;
	const structured = options.format !== "text";
	const stream = options.format === "stream-json";
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
		workerHooks.middlewareModule,
		TelemetryDomainModule,
		SchedulingDomainModule,
		// A fleet step is dispatched by executeFleetRun, which drains the handle
		// itself and never builds a dispatch event registry, so the domain is the
		// only thing that can write each step's durable transcript.
		createDispatchDomainModule({ journalRunEvents: true, workerSteering: false, workerHooks: workerHooks.workerHooks }),
		SessionDomainModule,
	]);
	const dispatch = loaded.getContract("dispatch");
	const agents = loaded.getContract("agents");
	const config = loaded.getContract("config");
	const safety = loaded.getContract("safety");
	const scheduling = loaded.getContract("scheduling");
	// The process journal records the status an early exit returns, as the settled run's exit does (#434).
	const exitWith = async (code: number, stop: () => Promise<void>): Promise<number> => {
		loaded.getContract("telemetry")?.setExitStatus?.(code);
		await stop();
		return code;
	};
	if (!dispatch || !agents || !safety) {
		return exitWith(fail("required domains unavailable (dispatch/agents/safety)"), () => loaded.stop());
	}
	const fleetSettings = config?.get() ?? readSettings();
	// Install `fleet.history.journal` the same way the interactive composition root
	// does, so a fleet run honours the setting without the journal ever reading
	// settings.yaml from the dispatch event path.
	configureRunEventJournal(fleetSettings.fleet.history.journal);
	const roleFacts = agentRoleFactsResolver((id) => agents.getSpec(id));
	// The effective cap is the lower of --max-cost-usd and the playbook's own budgetUsd (6.6).
	const effectiveBudgetUsd =
		options.maxCostUsd === undefined
			? playbook.budgetUsd
			: playbook.budgetUsd === null
				? options.maxCostUsd
				: Math.min(options.maxCostUsd, playbook.budgetUsd);
	if (effectiveBudgetUsd !== null) {
		track.limits.maxCostUsd = effectiveBudgetUsd;
		track.limits.maxCostSource =
			options.maxCostUsd !== undefined && options.maxCostUsd <= (playbook.budgetUsd ?? Number.POSITIVE_INFINITY)
				? "flag"
				: "playbook";
	}
	const preflightError = preflightPlaybook(playbook, {
		agents,
		safety,
		scheduling,
		settings: fleetSettings,
		budgetUsd: effectiveBudgetUsd,
	});
	if (preflightError !== null) {
		return exitWith(fail(`preflight failed: ${preflightError}`), () => loaded.stop());
	}

	const fleetRootId = newFleetRootId();
	track.rootId = fleetRootId;
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
					resultContract: spec.resultContract,
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
		return exitWith(fail(err instanceof Error ? err.message : String(err)), () => loaded.stop());
	}
	track.planHash = plan.hash;
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
		return exitWith(fail(err instanceof Error ? err.message : String(err)), stopRun);
	}
	if (hookRefusal !== null) {
		return exitWith(refuse(hookRefusal), stopRun);
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
			return exitWith(fail(`route preflight failed: ${err instanceof Error ? err.message : String(err)}`), stopRun);
		}
	}
	try {
		preflightWriteBoundaries(plan, process.cwd());
	} catch (err) {
		return exitWith(fail(`preflight failed: ${err instanceof Error ? err.message : String(err)}`), stopRun);
	}

	let resume: ExecuteFleetRunInput["resume"];
	if (resumeId !== undefined) {
		const record = readFleetRun(resumeId);
		if (record === null) {
			return exitWith(refuse(`resume run '${resumeId}' was not found in the durable fleet ledger`), stopRun);
		}
		const planned = planFleetResume(record, plan, playbook, vars, process.cwd());
		if (!planned.ok) {
			if (planned.reason === "fleet-name") {
				return exitWith(
					refuse(`resume run '${resumeId}' belongs to fleet '${planned.priorFleet}', not '${planned.currentFleet}'`),
					stopRun,
				);
			}
			if (planned.reason === "workspace") {
				return exitWith(
					refuse(
						planned.priorCwd === null
							? `resume run '${resumeId}' predates recorded workspaces, so it cannot be resumed in ${planned.currentCwd}`
							: `resume run '${resumeId}' ran in ${planned.priorCwd}, not ${planned.currentCwd}`,
					),
					stopRun,
				);
			}
			if (planned.reason === "running") {
				return exitWith(
					refuse(
						`resume run '${resumeId}' is still running in process ${planned.pid}; wait for it to settle or cancel it first`,
					),
					stopRun,
				);
			}
			if (planned.reason === "vars") {
				return exitWith(refuse(`resume run '${resumeId}' used different --var values`), stopRun);
			}
			process.stderr.write(
				`clio-coder fleet: resume plan hash differs: prior=${planned.priorHash} current=${planned.currentHash}\n`,
			);
			for (const entry of planned.diff) {
				process.stderr.write(`  step ${entry.index + 1}: ${entry.priorId} -> ${entry.currentId}\n`);
				process.stderr.write(`    prior: ${JSON.stringify(entry.prior)}\n`);
				process.stderr.write(`    current: ${JSON.stringify(entry.current)}\n`);
			}
			return exitWith(1, stopRun);
		}
		resume = { record, replayed: planned.replayed };
	}

	let dispatchDrain: Promise<void> | undefined;
	const beginDispatchDrain = (): Promise<void> => (dispatchDrain ??= dispatch.drain());
	let outcome: FleetRunOutcome;
	let runSignal: AbortSignal | undefined;
	let shutdownSignal: AbortSignal | undefined;
	// --timeout and --max-cost-usd stop the fleet through this controller, beside the shutdown coordinator's signal, so
	// the run seals aborted and this process still writes its result and returns 124 or 4 itself.
	const limitStop = new AbortController();
	const stopFleet = (cause: "deadline" | "max_cost_usd", message: string): void => {
		if (limitStop.signal.aborted) return;
		track.stopCause = cause;
		reporter.stderr(`clio-coder fleet run: ${message}\n`);
		limitStop.abort(new Error(message));
	};
	const deadline =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(
					() => stopFleet("deadline", `--timeout expired after ${options.timeoutMs}ms; stopping the fleet`),
					// Measured from process start, as `run --timeout` is.
					Math.max(0, options.timeoutMs - performance.now()),
				);
	deadline?.unref();
	/** The exit code the settled run returns, before a closed reader is weighed: signal, deadline, limit, failure. */
	const settledExitCode = (cleanRun: boolean): number => {
		if (shutdownSignal?.aborted === true) return getTerminationCoordinator().getExitCode();
		if (track.stopCause === "deadline") return EXIT_CODES.deadline;
		if (track.stopCause === "max_cost_usd") return EXIT_CODES.limitReached;
		return cleanRun ? 0 : 1;
	};
	try {
		outcome = await runFleetWithShutdown(
			(signal, registerEmergencySeal) => {
				shutdownSignal = signal;
				const combined = AbortSignal.any([signal, limitStop.signal]);
				runSignal = combined;
				return executeFleetRun({
					registerEmergencySeal,
					plan,
					signal: combined,
					playbookName: playbook.name,
					commands,
					workspaceRoot: process.cwd(),
					fleetRootId,
					dispatch,
					agents: { getSpec: (agentId) => agents.getSpec(agentId) },
					attributionEnabled: config?.get().integrations.git.commitAttribution ?? true,
					settings: fleetSettings,
					vars,
					...(resume !== undefined ? { resume } : {}),
					onStarted() {
						track.started = true;
						reporter.stderr(
							`fleet ${playbook.name}: root=${fleetRootId} plan=${plan.hash} steps=${plan.steps.length} loops=${plan.loops.length}\n`,
						);
						if (stream) {
							reporter.stdout(
								`${JSON.stringify({
									type: "fleet_started",
									schemaVersion: 1,
									rootId: fleetRootId,
									playbook: playbook.name,
									planHash: plan.hash,
									stepIds: plan.steps.map((step) => step.id),
									loops: plan.loops.length,
									resumedFrom: resume?.record.id ?? null,
									limits: track.limits,
								})}\n`,
							);
						}
					},
					onStepDispatched(event) {
						if (stream) reporter.stdout(`${JSON.stringify({ type: "step_dispatched", ...event })}\n`);
					},
					onStepSettled(step) {
						const stepOutcome: FleetStepOutcome =
							step.replayed === true ? "replayed" : step.succeeded ? "succeeded" : "failed";
						const stepRunId =
							step.replayed === true
								? (step.result?.terminalRunId ?? null)
								: (step.codeStep?.runId ?? step.terminalRunId ?? null);
						track.steps.push({ stepId: step.stepId, runId: stepRunId, outcome: stepOutcome });
						if (step.replayed !== true) track.spent = sumFactSums([track.spent, step.pricing.usd]);
						if (stream) {
							reporter.stdout(
								`${JSON.stringify({
									type: "step_settled",
									stepId: step.stepId,
									outcome: stepOutcome,
									runId: stepRunId,
									...(step.failureReason !== undefined ? { failureReason: step.failureReason } : {}),
									...(step.recordPath !== undefined ? { recordPath: step.recordPath } : {}),
									costUsd: factKnownValue(step.pricing.usd),
									cost: renderPricingSum(step.pricing),
								})}\n`,
							);
						}
						if (
							options.maxCostUsd !== undefined &&
							track.limits.maxCostUsd !== null &&
							factKnownValue(track.spent) >= track.limits.maxCostUsd
						) {
							stopFleet(
								"max_cost_usd",
								`fleet spend ${renderUsdSum(track.spent, false)} reached the ${renderUsdLimit(track.limits.maxCostUsd)} cap; stopping the fleet`,
							);
						}
						if (structured) return;
						if (step.replayed === true && step.result !== undefined) {
							if (json) {
								reporter.stdout(
									`${JSON.stringify({
										stepId: step.stepId,
										status: "replayed",
										run: {
											runId: step.result.terminalRunId,
											digest: step.result.runDigest,
										},
									})}\n`,
								);
							} else {
								reporter.stdout(
									`step ${step.stepId}: replayed terminal-run=${step.result.terminalRunId} run-digest=${step.result.runDigest}\n`,
								);
							}
							return;
						}
						if (step.run !== undefined) {
							if (json) reporter.stdout(`${JSON.stringify(step.run)}\n`);
							else {
								reporter.stdout(
									`step ${step.stepId} ${step.agentId}: ${step.succeeded ? "succeeded" : "failed"}${step.failureReason !== undefined ? ` reason=${step.failureReason}` : ""} assignment=${step.assignmentId} terminal-run=${step.terminalRunId} cost=${renderPricingSum(step.pricing)}\n`,
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
							if (!json && !structured) reporter.stdout(`${text}\n`);
						} else reporter.stderr(`${text}\n`);
					},
				});
			},
			async (settled) => {
				await beginDispatchDrain();
				await workerHooks.drain();
				await workerHooks.dispose();
				// The process journal records the status this command returns (#434).
				loaded
					.getContract("telemetry")
					?.setExitStatus?.(
						settled.ok
							? settledExitCode(settled.value.cleanRun)
							: runSignal?.aborted
								? settledExitCode(false)
								: fleetFailureExitCode(settled.error),
					);
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
		clearTimeout(deadline);
		if (runSignal?.aborted && err === runSignal.reason) {
			track.cleanRun = false;
			return finishFleetRun(options, reporter, track, settledExitCode(false), shutdownSignal?.aborted === true);
		}
		const message = err instanceof Error ? err.message : String(err);
		return fleetFailureExitCode(err) === 1 ? refuse(message) : fail(message);
	}
	clearTimeout(deadline);
	track.cleanRun = outcome.cleanRun;
	track.totalCost = outcome.totalCost;

	if (structured) {
		return finishFleetRun(options, reporter, track, settledExitCode(outcome.cleanRun), shutdownSignal?.aborted === true);
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
			`fleet ${playbook.name}: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded, ${outcome.resolvedLoopCount}/${outcome.result.loops.length} loops resolved, total cost ${renderPricingSum(outcome.totalCost)}\n`,
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
	if (options.formatGiven) {
		return finishFleetRun(options, reporter, track, settledExitCode(outcome.cleanRun), shutdownSignal?.aborted === true);
	}
	return settledExitCode(outcome.cleanRun);
}

/**
 * The settled run's exit code and, for json and stream-json, its fleet result document as the last line. Under
 * --output-format a reader that went away turns the code into 141 once the fleet has sealed; the fleet itself is never
 * canceled for it. Precedence is 6.5's: signal, deadline, reader closed, limit, failure.
 */
async function finishFleetRun(
	options: FleetRunOptions,
	reporter: ReturnType<typeof createFleetReporter>,
	track: FleetRunTrack,
	settledCode: number,
	signaled: boolean,
): Promise<number> {
	const resolve = (): { exitCode: number; causes: RunCause[] } => {
		const facts: RunCause[] = [];
		if (signaled) facts.push({ code: "interrupted", signal: signalForExitCode(settledCode) });
		if (track.stopCause === "deadline") facts.push({ code: "deadline", timeoutMs: track.limits.timeoutMs });
		if (options.formatGiven && reporter.readerClosed()) facts.push({ code: "reader_closed" });
		if (track.stopCause === "max_cost_usd") {
			facts.push({ code: "max_cost_usd", limitUsd: track.limits.maxCostUsd, spentUsd: factKnownValue(track.spent) });
		}
		if (track.cleanRun !== true) facts.push({ code: "run_failed" });
		const resolved = resolveRunExit(facts);
		// A signal's own code stands, whatever the coordinator recorded; without --output-format the pre-6.5 code stands.
		const exitCode = signaled || !options.formatGiven ? settledCode : resolved.exitCode;
		return { exitCode, causes: resolved.causes };
	};
	let result = resolve();
	if (options.format !== "text") {
		reporter.stdout(`${JSON.stringify(fleetEndDocument(options, track, result.exitCode, result.causes))}\n`);
		track.documentWritten = true;
	}
	// A closed pipe reports EPIPE on a later tick than the write that found it.
	await new Promise<void>((done) => setImmediate(done));
	result = resolve();
	return result.exitCode;
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

function statusSnapshot(all = false) {
	const nowMs = Date.now();
	const scope = fleetInspectionScope(all);
	const rows = openLedger().list().filter(scope.seesRun);
	const records = rows.map((row) => ({
		row,
		telemetry: runTelemetry(row.id, loadRunTelemetrySource(clioStateDir(), row.id), { now: new Date(nowMs) }),
	}));
	return {
		generatedAt: new Date(nowMs).toISOString(),
		admission: admissionStatus(capacityDrain(nowMs)),
		running: records
			.filter(({ row }) => row.endedAt === null && (row.status === "running" || row.status === "stale"))
			.map(({ row, telemetry }) => ({
				runId: row.id,
				agentId: row.agentId,
				budget: row.budget ?? null,
				runtimeKind: row.runtimeKind,
				outcomePhase: row.status,
				heartbeat: rowHeartbeat(row),
				lineage: row.lineage ?? { parentRunId: null, rootRunId: row.id, attempt: 0, depth: 0 },
				startedAt: row.startedAt,
				elapsed: telemetry.activity.elapsed,
				tokens: telemetry.tokens,
				usd: telemetry.row.usd,
				node: row.node?.id ?? "local",
			})),
		retrying: [] as Array<Record<string, unknown>>,
		totals: fleetTotals(records.map(({ telemetry }) => telemetry)),
	};
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
			const lineage = row.lineage;
			process.stdout.write(
				`  ${row.runId}  ${row.agentId}  node=${row.node}  ${row.heartbeat}  attempt=${lineage.attempt} depth=${lineage.depth}  ${row.elapsed.display}  ${row.usd.display}\n`,
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
		`totals: tokens=${t.total.display} (in=${t.input.display} out=${t.output.display}) cost=${t.usd.display} runtime=${t.elapsed.display}\n`,
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
	writeAdmissionText(admission);
	return 0;
}

function writeAdmissionText(admission: FleetAdmissionStatus): void {
	if (admission.state === "draining") {
		process.stdout.write(
			`dispatch admission is draining until ${admission.expiresAt}; running work continues (requested by pid ${admission.requestedByPid})\n`,
		);
	} else {
		process.stdout.write("dispatch admission is open\n");
	}
}

/**
 * `fleet admission [status|drain|open] [--json]`: one leaf for the admission gate. `status` (the default) only reads;
 * `drain` and `open` change it. `fleet drain` and `fleet resume` stay as aliases with their own unchanged output.
 */
function runAdmission(args: ReadonlyArray<string>): number {
	const parsed = parseCommandFlags(args, { json: { kind: "boolean" } });
	const json = parsed.ok ? parsed.flags.json === true : args.includes("--json");
	const path = ["fleet", "admission"];
	if (!parsed.ok) {
		writeCliFailure({ path, slug: parsed.slug, message: parsed.message, json });
		return 2;
	}
	const [action = "status", extra] = parsed.positional;
	if ((action !== "status" && action !== "drain" && action !== "open") || extra !== undefined) {
		const message = `usage: clio-coder fleet admission [status|drain|open] [--json]`;
		writeCliFailure({ path, slug: "usage", message, json });
		return 2;
	}
	let admission: FleetAdmissionStatus;
	if (action === "status") admission = admissionStatus(capacityDrain(Date.now()));
	else {
		ensureClioState();
		admission = admissionStatus(setCapacityDraining(action === "drain"));
	}
	if (json) writeJson(process.stdout, jsonDocument({ admission }));
	else writeAdmissionText(admission);
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
			const options = parseFleetRunArgs(args.slice(1));
			if ("error" in options) return fail(options.error);
			if (options.legacyJson) {
				process.stderr.write(
					"clio-coder fleet run: --json is deprecated; use --output-format stream-json for step events or json for one result document\n",
				);
			}
			if (options.cwd !== undefined) {
				// Before workspace conversion and playbook lookup, which both read the working directory.
				try {
					process.chdir(options.cwd);
				} catch (err) {
					return fail(`--cwd: cannot enter ${options.cwd}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			const reporter = createFleetReporter();
			try {
				await convertWorkspaceForCommand();
				return await runFleet(options, reporter);
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
		case "code-steps":
			return (await import("./fleet-code-steps.js")).runFleetCodeSteps(args.slice(1));
		case "drain":
			return runAdmissionControl("drain", args.slice(1));
		case "resume":
			return runAdmissionControl("resume", args.slice(1));
		case "admission":
			return runAdmission(args.slice(1));
		case "list":
			return (await import("./fleet-list.js")).runFleetList(args.slice(1));
		case "cancel":
			return (await import("./fleet-cancel.js")).runFleetCancel(args.slice(1));
		default:
			process.stderr.write(`clio-coder fleet: unknown subcommand '${sub}'\n`);
			process.stderr.write(HELP);
			return 2;
	}
}
