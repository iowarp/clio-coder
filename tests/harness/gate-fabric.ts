/**
 * Scripted worker fabric for review and compete gate contract tests.
 *
 * Roles are recognized from the task text the dispatch tool composes: reviewer
 * tasks start with "Review the work of builder run", judge tasks with "Rank".
 * Reviewer and judge answers pop from queues; builders answer with a fixed text
 * and optionally write a file into their cwd (the candidate worktree under
 * compete). Gate deciders answer their typed contract, never a prose sentinel.
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

export interface GateFabricScript {
	builderText?: string;
	builderWritesFile?: string;
	reviewerAnswers?: string[];
	judgeAnswers?: string[];
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
		} else {
			text = script.builderText ?? "built it";
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
