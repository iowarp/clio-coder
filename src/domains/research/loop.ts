/**
 * The campaign state machine. `openResearchCampaign` validates the objective against the project's verifier catalog,
 * freezes the checks, creates the research branch at HEAD and writes `campaign.json`. `runResearchCampaign` then runs
 * the A/A check and the iterations: PLAN+EDIT (one agent run in a fresh worktree at the current best commit), VERIFY
 * (no-op, duplicate, protected and scope rules), MEASURE (interleaved pairs), GRADE, RATCHET (compare-and-swap of the
 * research branch) and RECORD (hypothesis, check start, claims and test in the claims ledger). Every step lands in the
 * journal before the next begins. Budget stops are checked before each iteration, and an abort writes `stopped`.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readClioVersion } from "../../core/package-root.js";
import { StateFileLockTimeoutError, withStateFileLock } from "../../core/state-file-lock.js";
import { clampTimerDelayMs } from "../../core/timers.js";
import type { ToolResult } from "../../tools/registry.js";
import { gitCheckoutRoot } from "../../tools/task-worktree.js";
import {
	type DeclaredCheck,
	loadProjectVerifierCatalog,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
} from "../../tools/verify/catalog.js";
import { claimsProjectRoot } from "../claims/index.js";
import { type AgentRunner, hypothesisFromSummary, iterationPrompt } from "./agent.js";
import { budgetStop, nextRunLimits } from "./budget.js";
import { describeGrade } from "./format.js";
import {
	addResearchWorktree,
	casResearchRef,
	changedPaths,
	checkoutDetached,
	cleanWorktree,
	commitWorktree,
	createResearchRef,
	environmentEntries,
	fingerprintChanges,
	fingerprintEntries,
	gitFailure,
	removeResearchWorktree,
	researchWorktreeParent,
	resolveCommit,
	treeOf,
	untrackedEntries,
	withinEntries,
} from "./git.js";
import { aaIsNoisy, aaLabel, grade } from "./grader.js";
import {
	changeReachesProtected,
	filesNamedByCheck,
	inScope,
	measurePairs,
	type ObjectiveValue,
	runGateIn,
	runObjective,
} from "./measure.js";
import {
	beginIterationRecord,
	type CheckOutcome,
	executionOf,
	finishIterationRecord,
	researchHypothesisVerdict,
} from "./record.js";
import { planResearchResume, type ResearchResumeState } from "./resume.js";
import {
	appendJournal,
	campaignDir,
	newResearchCampaignId,
	readJournal,
	samplesName,
	writeCampaign,
	writeSamples,
} from "./store.js";
import {
	RESEARCH_BOOTSTRAP_RESAMPLES,
	RESEARCH_CAMPAIGN_VERSION,
	RESEARCH_REF_PREFIX,
	type ResearchArchiveReason,
	type ResearchAutonomy,
	type ResearchBudget,
	type ResearchCampaign,
	type ResearchCost,
	type ResearchGateResult,
	type ResearchJournalEvent,
	type ResearchObjective,
	type ResearchStopReason,
} from "./types.js";

export interface OpenCampaignInput {
	cwd: string;
	objective: ResearchObjective;
	gates: ReadonlyArray<string>;
	scope: ReadonlyArray<string>;
	budget: ResearchBudget;
	allowNoisy: boolean;
	keep: boolean;
	/** Absent is `default`; `yolo` runs every iteration's agent at contained yolo. */
	agent: { target?: string; model?: string; goal?: string; autonomy?: ResearchAutonomy };
	seed?: number;
	now?: Date;
}

export class ResearchOpenError extends Error {}

function checksDigest(checks: ReadonlyArray<DeclaredCheck>): string {
	return createHash("sha256").update(JSON.stringify(checks), "utf8").digest("hex");
}

/** Validate the objective, freeze its checks, create the research branch at HEAD and write `campaign.json`. */
export function openResearchCampaign(input: OpenCampaignInput): ResearchCampaign {
	const root = gitCheckoutRoot(input.cwd);
	if (root === null) throw new ResearchOpenError("research needs a git repository; this directory is not in one");
	let base: string;
	try {
		base = resolveCommit(root, "HEAD");
	} catch {
		throw new ResearchOpenError("the repository has no commits; commit the code the campaign starts from");
	}
	const catalog = loadProjectVerifierCatalog(root);
	if (!catalog.ok) throw new ResearchOpenError(`the verifier catalog cannot be read: ${catalog.reason}`);
	const declared = catalog.source?.checks ?? [];
	const find = (id: string): DeclaredCheck => {
		const check = declared.find((entry) => entry.id === id);
		if (check === undefined)
			throw new ResearchOpenError(
				`check '${id}' is not declared in ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}${declared.length > 0 ? ` (declared: ${declared.map((entry) => entry.id).join(", ")})` : ""}`,
			);
		if (check.runs !== undefined)
			throw new ResearchOpenError(`check '${id}' is a sweep (runs); name one run per campaign`);
		return check;
	};
	const objectiveCheck = find(input.objective.check);
	if (objectiveCheck.kind === "reproduce")
		throw new ResearchOpenError(
			`check '${objectiveCheck.id}' is a reproduce check; an objective must print a numeric payload (command, numeric-compare or perf-budget); use it as a --gate`,
		);
	// A --gate naming the objective stays a gate, and a judged objective is always one: its reference comparison must
	// pass before a candidate can ratchet. The check itself is frozen once.
	const gateIds = [...new Set([...(judgedKind(objectiveCheck) ? [objectiveCheck.id] : []), ...input.gates])];
	const gates = gateIds.filter((id) => id !== objectiveCheck.id).map(find);
	const protectedPaths = [
		PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
		...filesNamedByCheck(objectiveCheck, root),
		...gates.flatMap((check) => filesNamedByCheck(check, root)),
	];
	const project = claimsProjectRoot(root);
	const now = input.now ?? new Date();
	const id = newResearchCampaignId(now);
	const ref = `${RESEARCH_REF_PREFIX}${id}`;
	const checks = [objectiveCheck, ...gates];
	const campaign: ResearchCampaign = {
		version: RESEARCH_CAMPAIGN_VERSION,
		id,
		createdAt: now.toISOString(),
		project,
		objective: { ...input.objective },
		gates: gateIds,
		scope: [...input.scope],
		protected: [...new Set(protectedPaths)].sort(),
		budget: { ...input.budget },
		allowNoisy: input.allowNoisy,
		keep: input.keep,
		agent: {
			autonomy: input.agent.autonomy ?? "default",
			...(input.agent.target !== undefined ? { target: input.agent.target } : {}),
			...(input.agent.model !== undefined ? { model: input.agent.model } : {}),
			...(input.agent.goal !== undefined ? { goal: input.agent.goal } : {}),
		},
		base,
		ref,
		checks,
		checkDigest: checksDigest(checks),
		seed: input.seed ?? Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16),
		resamples: RESEARCH_BOOTSTRAP_RESAMPLES,
		clioVersion: readClioVersion(),
	};
	try {
		createResearchRef(root, ref, base);
	} catch (error) {
		throw new ResearchOpenError(`cannot create ${ref}: ${gitFailure(error)}`);
	}
	writeCampaign(campaign);
	appendJournal(project, id, { type: "opened", at: now.toISOString(), base, ref });
	return campaign;
}

export interface ResearchRecorder {
	begin: typeof beginIterationRecord;
	finish: typeof finishIterationRecord;
}

export interface ResearchLoopDeps {
	agent: AgentRunner;
	/** One objective run in a worktree. */
	measure?: (check: DeclaredCheck, metric: string, worktree: string, signal?: AbortSignal) => Promise<ObjectiveValue>;
	/** One gate run in a worktree, as `verify` would run it. */
	gate?: (worktree: string, check: DeclaredCheck, signal?: AbortSignal) => Promise<ToolResult>;
	recorder?: ResearchRecorder;
	/** Monotonic milliseconds for the wall budget. */
	clock?: () => number;
	now?: () => Date;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

export interface ResearchRunOutcome {
	reason: ResearchStopReason;
	detail: string;
	best: string;
	iterations: number;
}

/** A check whose run is judged into a claim: its result is a pass or fail against a reference, not just an exit code. */
function judgedKind(check: DeclaredCheck): boolean {
	return check.kind === "numeric-compare" || check.kind === "reproduce";
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim().slice(0, 300);
}

/** The campaign is running in another process, or its journal says it cannot go on. */
export class ResearchResumeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResearchResumeError";
	}
}

/**
 * Hold `<campaign>/run.lock` for the whole run, so a second `start` or `resume` of the same campaign is refused rather
 * than racing it. The lock records the owner's pid and birth token; one left by a process that died is reclaimed.
 */
async function withCampaignRun<T>(campaign: ResearchCampaign, fn: () => Promise<T>): Promise<T> {
	const target = join(campaignDir(campaign.project, campaign.id), "run");
	try {
		return await withStateFileLock(target, fn, { timeoutMs: 0, note: `research ${campaign.id}` });
	} catch (error) {
		if (!(error instanceof StateFileLockTimeoutError)) throw error;
		let owner = "another process";
		try {
			const pid = (JSON.parse(readFileSync(`${target}.lock`, "utf8")) as { pid?: unknown }).pid;
			if (typeof pid === "number") owner = `process ${pid}`;
		} catch {
			// The holder finished between the refusal and this read; the message still holds.
		}
		throw new ResearchResumeError(`campaign ${campaign.id} is already running in ${owner}; stop it first`);
	}
}

/**
 * Remove what a run that did not finish left in `.clio-coder/worktrees/`: always the base worktree, which the next run
 * recreates at the best commit, and every iteration worktree unless the campaign keeps them.
 */
function pruneCampaignWorktrees(campaign: ResearchCampaign): void {
	const root = campaign.project;
	const parent = researchWorktreeParent(root);
	if (!existsSync(parent)) return;
	const base = `research-${campaign.id}-base`;
	for (const name of readdirSync(parent)) {
		if (!name.startsWith(`research-${campaign.id}-`) || (campaign.keep && name !== base)) continue;
		const path = join(parent, name);
		try {
			removeResearchWorktree(root, path);
		} catch {
			// Not a registered worktree any more; the directory alone would block `git worktree add`.
		}
		rmSync(path, { recursive: true, force: true });
	}
}

/** Run the A/A check and the iterations until a budget stop, an abort or an error. */
export async function runResearchCampaign(
	campaign: ResearchCampaign,
	deps: ResearchLoopDeps,
): Promise<ResearchRunOutcome> {
	return withCampaignRun(campaign, () => runCampaignLoop(campaign, deps, null));
}

/**
 * Pick a stopped or abandoned campaign up again where its journal ends. Refused while another process runs it, when
 * its A/A check called a change, when its budget is already spent, or when something else moved its branch.
 * Iterations no run finished are archived as interrupted, a `resumed` event records what carried over, and the loop
 * continues at the next iteration from the best commit with the same budget.
 */
export async function resumeResearchCampaign(
	campaign: ResearchCampaign,
	deps: ResearchLoopDeps,
): Promise<ResearchRunOutcome> {
	return withCampaignRun(campaign, async () => {
		const project = campaign.project;
		let refHead: string | null;
		try {
			refHead = resolveCommit(project, campaign.ref);
		} catch {
			refHead = null;
		}
		const plan = planResearchResume(campaign, readJournal(project, campaign.id).events, refHead);
		if (!plan.ok) throw new ResearchResumeError(`cannot resume ${campaign.id}: ${plan.reason}`);
		pruneCampaignWorktrees(campaign);
		const at = (deps.now ?? (() => new Date()))().toISOString();
		for (const iteration of plan.interrupted)
			appendJournal(project, campaign.id, {
				type: "archived",
				at,
				iteration,
				reason: "interrupted",
				detail: "the campaign process ended before this iteration finished",
			});
		const { best, iterations, elapsedMs } = plan.state;
		appendJournal(project, campaign.id, {
			type: "resumed",
			at,
			best,
			iterations,
			elapsedMs,
			interrupted: plan.interrupted,
		});
		deps.log?.(
			`resumed at ${best.slice(0, 12)} after ${iterations} iteration(s) and ${(elapsedMs / 60_000).toFixed(1)} minute(s)${plan.interrupted.length > 0 ? `; archived unfinished iteration(s) ${plan.interrupted.join(", ")}` : ""}`,
		);
		return runCampaignLoop(campaign, deps, plan.state);
	});
}

async function runCampaignLoop(
	campaign: ResearchCampaign,
	deps: ResearchLoopDeps,
	resume: ResearchResumeState | null,
): Promise<ResearchRunOutcome> {
	const measure = deps.measure ?? runObjective;
	const gate = deps.gate ?? runGateIn;
	const recorder = deps.recorder ?? { begin: beginIterationRecord, finish: finishIterationRecord };
	const clock = deps.clock ?? (() => performance.now());
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? (() => {});
	const operator = deps.signal;
	const root = campaign.project;
	const project = campaign.project;
	const at = (): string => now().toISOString();
	const journal = (event: ResearchJournalEvent): void => appendJournal(project, campaign.id, event);
	const objectiveCheck = campaign.checks[0] as DeclaredCheck;
	const gateIds = new Set(campaign.gates);
	if (judgedKind(objectiveCheck)) gateIds.add(objectiveCheck.id);
	const gateChecks = [...gateIds].flatMap((id) => campaign.checks.filter((check) => check.id === id));
	const metric = campaign.objective.metric;
	const started = clock();
	// Wall time earlier runs of a resumed campaign already used.
	const priorMs = resume?.elapsedMs ?? 0;
	const elapsed = (): number => priorMs + clock() - started;
	// One signal for every phase: the operator's stop, or the campaign-wide wall deadline. Every agent run,
	// measurement and gate is cut off by it, and nothing graded after it is ratcheted.
	const wallMs = campaign.budget.maxWallMinutes === undefined ? undefined : campaign.budget.maxWallMinutes * 60_000;
	const control = new AbortController();
	const signal = control.signal;
	let deadlineHit = false;
	const onOperatorAbort = (): void => control.abort(operator?.reason);
	if (operator?.aborted) control.abort(operator.reason);
	else operator?.addEventListener("abort", onOperatorAbort, { once: true });
	const deadlineTimer =
		wallMs === undefined
			? undefined
			: setTimeout(
					() => {
						deadlineHit = true;
						control.abort(new Error("research wall deadline"));
					},
					Math.max(1, clampTimerDelayMs(wallMs - priorMs)),
				);
	deadlineTimer?.unref?.();
	const costs: ResearchCost[] = [...(resume?.costs ?? [])];
	let best = resume?.best ?? campaign.base;
	let iterations = resume?.iterations ?? 0;
	const baseWorktree = join(researchWorktreeParent(root), `research-${campaign.id}-base`);
	const openWorktrees = new Set<string>();
	// Untracked files the declared checks create when they run (interpreter caches, build output). An agent that runs
	// the checks itself leaves them beside its edit; committing them archived a good change as out of scope.
	const checkArtifacts = new Set<string>();
	const learnArtifacts = (worktree: string, before: ReadonlyArray<string>): void => {
		const known = new Set(before);
		for (const entry of untrackedEntries(worktree)) if (!known.has(entry)) checkArtifacts.add(entry);
	};

	const finish = (reason: ResearchStopReason, detail: string): ResearchRunOutcome => {
		journal({ type: "stopped", at: at(), reason, detail, best });
		log(`stopped: ${reason}: ${detail}`);
		return { reason, detail, best, iterations };
	};
	const stoppedByOperator = (): boolean => operator?.aborted === true;
	const pastDeadline = (): boolean => deadlineHit || (wallMs !== undefined && elapsed() >= wallMs);
	/** Why the campaign must stop now, if it must: the operator first, then the wall deadline. */
	const halt = (): { reason: "stopped" | "max-wall-minutes"; archive: ResearchArchiveReason } | null => {
		if (stoppedByOperator()) return { reason: "stopped", archive: "interrupted" };
		if (pastDeadline()) return { reason: "max-wall-minutes", archive: "deadline" };
		return null;
	};
	const aborted = (): boolean => signal.aborted || halt() !== null;
	const haltDetail = (phase: string): string =>
		stoppedByOperator()
			? `interrupted ${phase}`
			: `the ${campaign.budget.maxWallMinutes} minute wall budget ran out ${phase}`;

	try {
		addResearchWorktree(root, baseWorktree, best);
		openWorktrees.add(baseWorktree);
		const baseUntracked = untrackedEntries(baseWorktree);

		if (resume?.aaDone) {
			// The journal keeps the A/A grade. One objective run on the best commit re-learns the output it creates,
			// which a dead process held only in memory.
			log(`learning check output: one run of '${objectiveCheck.id}' and the gates on ${best.slice(0, 12)}`);
			const once = await measure(objectiveCheck, metric, baseWorktree, signal);
			const onceHalt = halt();
			if (onceHalt !== null) return finish(onceHalt.reason, haltDetail("while running the objective on the best commit"));
			if (!once.ok) return finish("error", `the objective check failed on the best commit: ${once.reason}`);
		} else {
			// A/A: base against base, the same number of pairs an iteration takes.
			log(`A/A check: ${campaign.objective.trials} interleaved pairs of '${objectiveCheck.id}' on the base`);
			const aa = await measurePairs(
				campaign.objective.trials,
				() => measure(objectiveCheck, metric, baseWorktree, signal),
				aborted,
			);
			const aaHalt = halt();
			if (aaHalt !== null) return finish(aaHalt.reason, haltDetail("during the A/A check"));
			if (!aa.ok) return finish("error", `the objective check failed on the base: ${aa.reason}`);
			const aaSamples = writeSamples(project, campaign.id, {
				iteration: "aa",
				metric,
				baseCommit: best,
				candidateCommit: best,
				pairs: aa.pairs,
			});
			const aaGrade = grade({
				direction: campaign.objective.direction,
				minImprovement: campaign.objective.minImprovement,
				base: aa.pairs.map((pair) => pair.base),
				candidate: aa.pairs.map((pair) => pair.candidate),
				seed: campaign.seed,
				resamples: campaign.resamples,
			});
			const noisy = aaIsNoisy(aaGrade);
			journal({ type: "aa", at: at(), samples: aaSamples, grade: aaGrade, noisy, allowed: !noisy || campaign.allowNoisy });
			log(`A/A: ${aaLabel(aaGrade)} (${describeGrade(aaGrade, campaign.objective)})`);
			if (noisy && !campaign.allowNoisy)
				return finish(
					"noisy",
					`the A/A check already calls a change (${describeGrade(aaGrade, campaign.objective)}); raise --trials, quiet the machine, or pass --allow-noisy`,
				);
		}
		// Each gate runs once on the base too, so what it creates is known before the first iteration commits.
		for (const check of gateChecks) if (check.id !== objectiveCheck.id) await gate(baseWorktree, check, signal);
		const learnHalt = halt();
		if (learnHalt !== null) return finish(learnHalt.reason, haltDetail("while running the gates on the base"));
		learnArtifacts(baseWorktree, baseUntracked);

		const seenTrees = new Set([treeOf(root, campaign.base), treeOf(root, best), ...(resume?.seenTrees ?? [])]);
		for (;;) {
			const state = { iterations, elapsedMs: elapsed(), costs };
			const stop = budgetStop(campaign.budget, state);
			const loopHalt = halt();
			if (loopHalt?.reason === "stopped") return finish("stopped", "interrupted");
			if (stop !== null) return finish(stop.reason, stop.detail);
			if (loopHalt !== null) return finish(loopHalt.reason, haltDetail("before the next iteration"));
			iterations += 1;
			const iteration = iterations;
			const name = samplesName(iteration);
			const worktree = join(researchWorktreeParent(root), `research-${campaign.id}-${name}`);
			addResearchWorktree(root, worktree, best);
			openWorktrees.add(worktree);
			const environment = environmentEntries(worktree);
			const environmentPrint = fingerprintEntries(worktree, environment);
			journal({ type: "iteration-started", at: at(), iteration, parent: best, worktree });
			log(`iteration ${iteration}: agent run in ${worktree}`);
			const archive = (reason: ResearchArchiveReason, detail: string): void => {
				journal({ type: "archived", at: at(), iteration, reason, detail });
				log(`iteration ${iteration}: archived (${reason}): ${detail}`);
			};
			const limits = nextRunLimits(campaign.budget, state);
			const run = await deps.agent({
				worktree,
				prompt: iterationPrompt(campaign, iteration, readJournal(project, campaign.id).events),
				// Campaigns written before yolo existed carry no other level.
				autonomy: campaign.agent.autonomy === "yolo" ? "yolo" : "default",
				...(campaign.agent.target !== undefined ? { target: campaign.agent.target } : {}),
				...(campaign.agent.model !== undefined ? { model: campaign.agent.model } : {}),
				...(limits.timeoutSeconds !== undefined ? { timeoutSeconds: limits.timeoutSeconds } : {}),
				...(limits.maxCostUsd !== undefined ? { maxCostUsd: limits.maxCostUsd } : {}),
				signal,
			});
			costs.push(run.cost);
			journal({
				type: "agent-finished",
				at: at(),
				iteration,
				exitCode: run.exitCode,
				sessionId: run.sessionId,
				outcome: run.outcome,
				summary: run.summary,
				cost: run.cost,
				...(run.autonomy !== undefined ? { autonomy: run.autonomy } : {}),
			});
			if (run.autonomy !== undefined && (run.autonomy.halted !== null || run.autonomy.openDecisions.length > 0))
				log(
					`iteration ${iteration}: yolo ${run.autonomy.halted !== null ? `paused (${run.autonomy.halted.kind}), ` : ""}${run.autonomy.openDecisions.length + run.autonomy.openDecisionsOmitted} open decision(s)`,
				);
			const cleanup = (): void => {
				if (campaign.keep) return;
				removeResearchWorktree(root, worktree);
				openWorktrees.delete(worktree);
			};
			const agentHalt = halt();
			if (agentHalt !== null) {
				archive(agentHalt.archive, haltDetail("during the agent run"));
				cleanup();
				return finish(agentHalt.reason, haltDetail("during the agent run"));
			}
			if (run.exitCode !== 0) {
				archive("agent-failed", `the agent run exited ${run.exitCode ?? "by signal"}: ${firstLine(run.summary)}`);
				cleanup();
				continue;
			}

			// VERIFY. The environment the worktree had before the agent ran (installed dependencies, build output) is
			// kept for measurement, so the agent may not change it; a change rejects the candidate unmeasured.
			const environmentChanged = fingerprintChanges(environmentPrint, fingerprintEntries(worktree, environment));
			if (environmentChanged.length > 0) {
				const shown = environmentChanged.slice(0, 5).join(", ");
				const more = environmentChanged.length > 5 ? ` and ${environmentChanged.length - 5} more` : "";
				archive("protected", `changed the pre-agent environment: ${shown}${more}`);
				cleanup();
				continue;
			}
			let commit: string;
			try {
				const committed = commitWorktree(
					worktree,
					`research ${campaign.id} ${name}\n\n${run.summary.slice(0, 2000)}`,
					(path) => withinEntries(path, checkArtifacts),
				);
				commit = committed.head;
				if (committed.leftOut.length > 0)
					log(`iteration ${iteration}: left out check output ${committed.leftOut.join(", ")}`);
				// Measure the commit in the environment the worktree had before the agent ran: whatever the agent
				// left untracked or ignored, check output and installs included, goes, so a file it planted cannot
				// steer the score. The checks recreate their own output.
				cleanWorktree(worktree, environment);
			} catch (error) {
				archive("agent-failed", `the change could not be committed: ${gitFailure(error)}`);
				cleanup();
				continue;
			}
			const tree = treeOf(root, commit);
			const changed = commit === best ? [] : changedPaths(root, best, commit);
			journal({ type: "committed", at: at(), iteration, commit, tree, changed });
			if (changed.length === 0 || tree === treeOf(root, best)) {
				archive("no-op", "the agent left no change");
				cleanup();
				continue;
			}
			if (seenTrees.has(tree)) {
				archive("duplicate", "the change reproduces a tree an earlier iteration already measured");
				cleanup();
				continue;
			}
			seenTrees.add(tree);
			const touched = changed.filter((path) => changeReachesProtected(worktree, path, campaign.protected));
			if (touched.length > 0) {
				archive("protected", `changed protected path(s): ${touched.join(", ")}`);
				cleanup();
				continue;
			}
			const outside = changed.filter((path) => !inScope(path, campaign.scope));
			if (outside.length > 0) {
				archive("out-of-scope", `changed path(s) outside --scope: ${outside.join(", ")}`);
				cleanup();
				continue;
			}

			// RECORD, first half: the plan as a hypothesis, bound to this run's checks before they execute.
			const stated = hypothesisFromSummary(run.summary) ?? {
				statement: `Iteration ${iteration} changes ${changed.join(", ")} to move ${metric} ${campaign.objective.direction === "min" ? "down" : "up"}.`,
				prediction: "",
			};
			const begun = await recorder.begin({
				campaign,
				iteration,
				at: at(),
				sessionId: run.sessionId,
				hypothesis: stated,
				checks: campaign.checks.map((check) => check.id),
			});

			// MEASURE
			const candidateUntracked = untrackedEntries(worktree);
			log(`iteration ${iteration}: measuring ${campaign.objective.trials} interleaved pairs`);
			const pairs = await measurePairs(
				campaign.objective.trials,
				(side) => measure(objectiveCheck, metric, side === "base" ? baseWorktree : worktree, signal),
				aborted,
			);
			const outcomes: CheckOutcome[] = [];
			const measureHalt = halt();
			if (!pairs.ok || measureHalt !== null) {
				outcomes.push({ check: objectiveCheck.id, execution: aborted() ? "aborted" : "failed" });
				await recorder.finish({ campaign, iteration, at: at(), bindings: begun.bindings, outcomes });
				journal({
					type: "recorded",
					at: at(),
					iteration,
					hypothesis: begun.hypothesis,
					verdict: researchHypothesisVerdict(null),
					claims: [],
				});
				if (measureHalt !== null) {
					archive(measureHalt.archive, haltDetail("while measuring"));
					cleanup();
					return finish(measureHalt.reason, haltDetail("while measuring"));
				}
				archive("measure-failed", pairs.ok ? "measurement incomplete" : pairs.reason);
				cleanup();
				continue;
			}
			const samples = writeSamples(project, campaign.id, {
				iteration,
				metric,
				baseCommit: best,
				candidateCommit: commit,
				pairs: pairs.pairs,
			});
			journal({ type: "measured", at: at(), iteration, samples });

			// GRADE: the objective, then every gate on the candidate.
			const result = grade({
				direction: campaign.objective.direction,
				minImprovement: campaign.objective.minImprovement,
				base: pairs.pairs.map((pair) => pair.base),
				candidate: pairs.pairs.map((pair) => pair.candidate),
				seed: campaign.seed + iteration,
				resamples: campaign.resamples,
			});
			const objectiveOutcome: CheckOutcome = { check: objectiveCheck.id, execution: "succeeded" };
			let objectiveJudged: ToolResult | undefined;
			if (gateIds.has(objectiveCheck.id)) {
				objectiveJudged = await gate(worktree, objectiveCheck, signal);
				objectiveOutcome.result = objectiveJudged;
				objectiveOutcome.execution = executionOf(objectiveJudged);
			}
			outcomes.push(objectiveOutcome);
			const gates: ResearchGateResult[] = [];
			for (const check of gateChecks) {
				const isObjective = check.id === objectiveCheck.id && objectiveJudged !== undefined;
				const judged = isObjective ? (objectiveJudged as ToolResult) : await gate(worktree, check, signal);
				if (!isObjective) outcomes.push({ check: check.id, execution: executionOf(judged), result: judged });
				gates.push({
					check: check.id,
					passed: judged.kind === "ok",
					execution: executionOf(judged),
					summary: firstLine(judged.kind === "ok" ? judged.output : judged.message),
				});
			}

			learnArtifacts(worktree, candidateUntracked);

			// RECORD, second half: claims from the judged runs and the hypothesis test.
			const recorded = await recorder.finish({ campaign, iteration, at: at(), bindings: begun.bindings, outcomes });
			for (const entry of gates) {
				const claim = recorded.claims.get(entry.check);
				if (claim !== undefined) entry.claim = claim.id;
			}
			journal({ type: "graded", at: at(), iteration, grade: result, gates });
			journal({
				type: "recorded",
				at: at(),
				iteration,
				hypothesis: begun.hypothesis,
				verdict: researchHypothesisVerdict(result),
				claims: [...recorded.claims.values()].map((claim) => claim.id),
			});
			log(`iteration ${iteration}: ${describeGrade(result, campaign.objective)}`);

			// RATCHET, only before the deadline and only with every gate, the judged objective included, passing.
			const gradeHalt = halt();
			if (gradeHalt !== null) {
				archive(gradeHalt.archive, haltDetail("before the ratchet"));
				cleanup();
				return finish(gradeHalt.reason, haltDetail("before the ratchet"));
			}
			const failedGates = gates.filter((entry) => !entry.passed);
			if (failedGates.length > 0) {
				archive(
					"gate-failed",
					failedGates.map((entry) => `${entry.check}: ${entry.summary || entry.execution}`).join("; "),
				);
			} else if (result.verdict !== "improved") {
				archive("not-improved", describeGrade(result, campaign.objective));
			} else if (
				casResearchRef(
					root,
					campaign.ref,
					commit,
					best,
					`clio-coder research: ${name} ${describeGrade(result, campaign.objective)}`,
				)
			) {
				journal({ type: "ratcheted", at: at(), iteration, from: best, to: commit });
				log(`iteration ${iteration}: ratcheted ${campaign.ref} ${best.slice(0, 12)} -> ${commit.slice(0, 12)}`);
				best = commit;
				checkoutDetached(baseWorktree, best);
			} else {
				archive("ratchet-lost", `${campaign.ref} no longer points at ${best}; something else moved it`);
			}
			cleanup();
		}
	} catch (error) {
		return finish("error", error instanceof Error ? error.message : String(error));
	} finally {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		operator?.removeEventListener("abort", onOperatorAbort);
		if (!campaign.keep)
			for (const path of openWorktrees) {
				try {
					removeResearchWorktree(root, path);
				} catch {
					// A worktree that will not go is left for `git worktree prune`; the journal already holds the outcome.
				}
			}
	}
}
