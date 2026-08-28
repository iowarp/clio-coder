/**
 * Scripted worker fabric for review and compete gate contract tests.
 *
 * Roles are recognized from the task text the dispatch tool composes: reviewer
 * tasks start with "Review the work of builder run", judge tasks with "Rank",
 * and the council synthesis with "Synthesize the council answers". Reviewer,
 * judge, and synthesis answers pop from queues; anything else takes a `memberAnswers`
 * entry if one is queued, otherwise a fixed builder text, and optionally writes a
 * file into its cwd (the candidate worktree under compete). Gate deciders answer
 * their typed contract, never a prose sentinel.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";

export interface GateSpawnRecord {
	spec: WorkerSpec;
	cwd: string | undefined;
}

/** The reviewer's Slice 2 verifier-report contract. */
export function reviewReport(verdict: "pass" | "fail", evidence = "inspected the workspace"): string {
	return JSON.stringify({ verdict, checks: [{ name: "review", passed: verdict === "pass", evidence }] });
}

/** The judge's compete gate-result contract. */
export function judgeReport(winner: number, evidence = "compared the candidate branches"): string {
	return JSON.stringify({ winner, checks: [{ name: "ranking", passed: true, evidence }] });
}

/** The council judge's answer shape, which COUNCIL_JUDGE_PROMPT asks for. */
export function councilSynthesisReport(verdict: string, text: string): string {
	return JSON.stringify({ verdict, text });
}

/** The researcher recipe's `research-report` contract, which a `none` or `judge` council member seals against. */
export function researchReport(claim: string, evidence = "read the file"): string {
	return JSON.stringify({ source: "local", findings: [{ claim, evidence }] });
}

/**
 * A council member's `council-ballot`, which is what a `vote` council asks for
 * and seals instead of the seated recipe's own contract.
 */
export function councilBallot(verdict: string, text: string): string {
	return JSON.stringify({ verdict, text });
}

export interface GateFabricScript {
	builderText?: string;
	builderWritesFile?: string;
	reviewerAnswers?: string[];
	judgeAnswers?: string[];
	/** Answers for the council synthesis run, which is neither a builder nor a compete judge. */
	synthesisAnswers?: string[];
	/**
	 * Answers popped ahead of `builderText`, so a council can be given one
	 * distinct answer per member. Members run concurrently and a spec carries no
	 * roster label, so which member takes which answer is not fixed; assert on
	 * the tally rather than on a member-to-verdict pairing.
	 */
	memberAnswers?: string[];
	/** Number of retryable reviewer attempts to fail before scripted answers succeed. */
	reviewerFailures?: number;
	/** Number of retryable judge attempts to fail before scripted answers succeed. */
	judgeFailures?: number;
}

export function scriptedGateFabric(script: GateFabricScript): {
	spawn: (spec: WorkerSpec, opts?: { cwd?: string }) => SpawnedWorker;
	spawns: GateSpawnRecord[];
} {
	const spawns: GateSpawnRecord[] = [];
	const reviewerAnswers = [...(script.reviewerAnswers ?? [])];
	const judgeAnswers = [...(script.judgeAnswers ?? [])];
	const synthesisAnswers = [...(script.synthesisAnswers ?? [])];
	const memberAnswers = [...(script.memberAnswers ?? [])];
	let reviewerFailures = script.reviewerFailures ?? 0;
	let judgeFailures = script.judgeFailures ?? 0;
	const spawn = (spec: WorkerSpec, opts?: { cwd?: string }): SpawnedWorker => {
		spawns.push({ spec, cwd: opts?.cwd });
		let text: string;
		let exitCode = 0;
		if (spec.task.startsWith("Review the work of builder run")) {
			if (reviewerFailures > 0) {
				reviewerFailures -= 1;
				exitCode = 1;
				text = "";
			} else {
				text = reviewerAnswers.shift() ?? reviewReport("pass");
			}
		} else if (spec.task.startsWith("Rank ")) {
			if (judgeFailures > 0) {
				judgeFailures -= 1;
				exitCode = 1;
				text = "";
			} else {
				text = judgeAnswers.shift() ?? judgeReport(1);
			}
		} else if (spec.task.startsWith("Synthesize the council answers")) {
			text = synthesisAnswers.shift() ?? councilSynthesisReport("supported", "the council agrees");
		} else {
			text = memberAnswers.shift() ?? script.builderText ?? "built it";
			if (script.builderWritesFile !== undefined && opts?.cwd !== undefined) {
				writeFileSync(join(opts.cwd, script.builderWritesFile), `work in ${opts.cwd}\n`);
			}
		}
		const events = (async function* () {
			yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
		})();
		return {
			pid: 300 + spawns.length,
			promise: Promise.resolve({ exitCode, signal: null }),
			events,
			abort: () => {},
			heartbeatAt: { current: Date.now() },
		};
	};
	return { spawn, spawns };
}
