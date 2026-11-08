/**
 * The campaign state machine. `openResearchCampaign` validates the objective against the project's verifier catalog,
 * freezes the checks, creates the research branch at HEAD and writes `campaign.json`. `runResearchCampaign` then runs
 * the A/A check and the iterations: PLAN+EDIT (one agent run in a fresh worktree at the current best commit), VERIFY
 * (no-op, duplicate, protected and scope rules), MEASURE (interleaved pairs), GRADE, RATCHET (compare-and-swap of the
 * research branch) and RECORD (hypothesis, check start, claims and test in the claims ledger). Every step lands in the
 * journal before the next begins. Budget stops are checked before each iteration, and an abort writes `stopped`.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readClioVersion } from "../../core/package-root.js";
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
import {
	addResearchWorktree,
	casResearchRef,
	changedPaths,
	checkoutDetached,
	commitWorktree,
	createResearchRef,
	gitFailure,
	removeResearchWorktree,
	researchWorktreeParent,
	resolveCommit,
	treeOf,
} from "./git.js";
import { aaIsNoisy, grade } from "./grader.js";
import {
	filesNamedByCheck,
	inScope,
	measurePairs,
	type ObjectiveValue,
	runGateIn,
	runObjective,
	touchesProtected,
} from "./measure.js";
import { beginIterationRecord, type CheckOutcome, executionOf, finishIterationRecord } from "./record.js";
import {
	appendJournal,
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
	agent: { target?: string; model?: string; goal?: string };
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
	const gates = [...new Set(input.gates)].filter((id) => id !== objectiveCheck.id).map(find);
	const exists = (relative: string): boolean => existsSync(join(root, relative));
	const protectedPaths = [
		PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
		...filesNamedByCheck(objectiveCheck, exists),
		...gates.flatMap((check) => filesNamedByCheck(check, exists)),
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
		gates: gates.map((check) => check.id),
		scope: [...input.scope],
		protected: [...new Set(protectedPaths)].sort(),
		budget: { ...input.budget },
		allowNoisy: input.allowNoisy,
		keep: input.keep,
		agent: {
			autonomy: "default",
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

function judgedKind(check: DeclaredCheck): boolean {
	return check.kind === "numeric-compare" || check.kind === "reproduce";
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim().slice(0, 300);
}

/** Run the A/A check and the iterations until a budget stop, an abort or an error. */
export async function runResearchCampaign(
	campaign: ResearchCampaign,
	deps: ResearchLoopDeps,
): Promise<ResearchRunOutcome> {
	const measure = deps.measure ?? runObjective;
	const gate = deps.gate ?? runGateIn;
	const recorder = deps.recorder ?? { begin: beginIterationRecord, finish: finishIterationRecord };
	const clock = deps.clock ?? (() => performance.now());
	const now = deps.now ?? (() => new Date());
	const log = deps.log ?? (() => {});
	const signal = deps.signal;
	const root = campaign.project;
	const project = campaign.project;
	const at = (): string => now().toISOString();
	const journal = (event: ResearchJournalEvent): void => appendJournal(project, campaign.id, event);
	const [objectiveCheck, ...gateChecks] = campaign.checks as [DeclaredCheck, ...DeclaredCheck[]];
	const metric = campaign.objective.metric;
	const started = clock();
	const costs: ResearchCost[] = [];
	let best = campaign.base;
	let iterations = 0;
	const baseWorktree = join(researchWorktreeParent(root), `research-${campaign.id}-base`);
	const openWorktrees = new Set<string>();

	const finish = (reason: ResearchStopReason, detail: string): ResearchRunOutcome => {
		journal({ type: "stopped", at: at(), reason, detail, best });
		log(`stopped: ${reason}: ${detail}`);
		return { reason, detail, best, iterations };
	};
	const aborted = (): boolean => signal?.aborted === true;

	try {
		addResearchWorktree(root, baseWorktree, best);
		openWorktrees.add(baseWorktree);

		// A/A: base against base, the same number of pairs an iteration takes.
		log(`A/A check: ${campaign.objective.trials} interleaved pairs of '${objectiveCheck.id}' on the base`);
		const aa = await measurePairs(campaign.objective.trials, () => measure(objectiveCheck, metric, baseWorktree, signal));
		if (aborted()) return finish("stopped", "interrupted during the A/A check");
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
		log(`A/A: ${noisy ? "noisy" : "quiet"} (${describeGrade(aaGrade)})`);
		if (noisy && !campaign.allowNoisy)
			return finish(
				"noisy",
				`the A/A check already calls a change (${describeGrade(aaGrade)}); raise --trials, quiet the machine, or pass --allow-noisy`,
			);

		const seenTrees = new Set([treeOf(root, best)]);
		for (;;) {
			const state = { iterations, elapsedMs: clock() - started, costs };
			const stop = budgetStop(campaign.budget, state);
			if (stop !== null) return finish(stop.reason, stop.detail);
			if (aborted()) return finish("stopped", "interrupted");
			iterations += 1;
			const iteration = iterations;
			const name = samplesName(iteration);
			const worktree = join(researchWorktreeParent(root), `research-${campaign.id}-${name}`);
			addResearchWorktree(root, worktree, best);
			openWorktrees.add(worktree);
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
				...(campaign.agent.target !== undefined ? { target: campaign.agent.target } : {}),
				...(campaign.agent.model !== undefined ? { model: campaign.agent.model } : {}),
				...(limits.timeoutSeconds !== undefined ? { timeoutSeconds: limits.timeoutSeconds } : {}),
				...(limits.maxCostUsd !== undefined ? { maxCostUsd: limits.maxCostUsd } : {}),
				...(signal !== undefined ? { signal } : {}),
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
			});
			const cleanup = (): void => {
				if (campaign.keep) return;
				removeResearchWorktree(root, worktree);
				openWorktrees.delete(worktree);
			};
			if (aborted()) {
				archive("agent-failed", "interrupted during the agent run");
				cleanup();
				return finish("stopped", "interrupted");
			}
			if (run.exitCode !== 0) {
				archive("agent-failed", `the agent run exited ${run.exitCode ?? "by signal"}: ${firstLine(run.summary)}`);
				cleanup();
				continue;
			}

			// VERIFY
			let commit: string;
			try {
				commit = commitWorktree(worktree, `research ${campaign.id} ${name}\n\n${run.summary.slice(0, 2000)}`);
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
			const touched = changed.filter((path) => touchesProtected(path, campaign.protected));
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
			log(`iteration ${iteration}: measuring ${campaign.objective.trials} interleaved pairs`);
			const pairs = await measurePairs(campaign.objective.trials, (side) =>
				measure(objectiveCheck, metric, side === "base" ? baseWorktree : worktree, signal),
			);
			const outcomes: CheckOutcome[] = [];
			if (!pairs.ok) {
				outcomes.push({ check: objectiveCheck.id, execution: aborted() ? "aborted" : "failed" });
				await recorder.finish({ campaign, iteration, at: at(), bindings: begun.bindings, outcomes });
				journal({ type: "recorded", at: at(), iteration, hypothesis: begun.hypothesis, claims: [] });
				archive("measure-failed", pairs.reason);
				cleanup();
				if (aborted()) return finish("stopped", "interrupted while measuring");
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
			if (judgedKind(objectiveCheck)) {
				const judged = await gate(worktree, objectiveCheck, signal);
				objectiveOutcome.result = judged;
				objectiveOutcome.execution = executionOf(judged);
			}
			outcomes.push(objectiveOutcome);
			const gates: ResearchGateResult[] = [];
			for (const check of gateChecks) {
				const judged = await gate(worktree, check, signal);
				outcomes.push({ check: check.id, execution: executionOf(judged), result: judged });
				gates.push({
					check: check.id,
					passed: judged.kind === "ok",
					execution: executionOf(judged),
					summary: firstLine(judged.kind === "ok" ? judged.output : judged.message),
				});
			}

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
				claims: [...recorded.claims.values()].map((claim) => claim.id),
			});
			log(`iteration ${iteration}: ${describeGrade(result)}`);

			// RATCHET
			const failedGates = gates.filter((entry) => !entry.passed);
			if (failedGates.length > 0) {
				archive(
					"gate-failed",
					failedGates.map((entry) => `${entry.check}: ${entry.summary || entry.execution}`).join("; "),
				);
			} else if (result.verdict !== "improved") {
				archive("not-improved", describeGrade(result));
			} else if (
				casResearchRef(root, campaign.ref, commit, best, `clio-coder research: ${name} ${describeGrade(result)}`)
			) {
				journal({ type: "ratcheted", at: at(), iteration, from: best, to: commit });
				log(`iteration ${iteration}: ratcheted ${campaign.ref} ${best.slice(0, 12)} -> ${commit.slice(0, 12)}`);
				best = commit;
				checkoutDetached(baseWorktree, best);
			} else {
				archive("ratchet-lost", `${campaign.ref} no longer points at ${best}; something else moved it`);
			}
			cleanup();
			if (aborted()) return finish("stopped", "interrupted");
		}
	} catch (error) {
		return finish("error", error instanceof Error ? error.message : String(error));
	} finally {
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

export function describeGrade(result: {
	verdict: string;
	delta: number | null;
	ci: { low: number; high: number } | null;
}): string {
	const pct = (value: number): string => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
	const delta = result.delta === null ? "delta n/a" : `median delta ${pct(result.delta)}`;
	const ci = result.ci === null ? "CI n/a" : `95% CI [${pct(result.ci.low)}, ${pct(result.ci.high)}]`;
	return `${result.verdict}, ${delta}, ${ci}`;
}
