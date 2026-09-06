import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { Value } from "typebox/value";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { readGateDecisionArtifacts } from "../../src/domains/dispatch/gate-decisions.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import {
	candidateDiffStat,
	claimCompeteGroup,
	cleanupCompeteGroup,
	commitCandidateWork,
	createCandidateWorktreeMapped,
	markCompeteGroupCleanupReady,
	mergeWinnerBranch,
} from "../../src/tools/compete-worktrees.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { dispatchSchemaCompositionFor } from "../../src/tools/dispatch-schema.js";
import { readTool } from "../../src/tools/read.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function snapshot(root: string) {
	return {
		head: git(root, "rev-parse", "HEAD"),
		tracked: git(root, "ls-files"),
		staged: git(root, "diff", "--cached", "--name-only"),
		status: git(root, "status", "--short", "--untracked-files=all"),
		diff: git(root, "diff", "HEAD"),
	};
}

for (const agent of ["scout", "coder"] as const) {
	it(`${agent} one-route compete executes two candidates and a judge while preserving caller work`, {
		timeout: 30_000,
	}, async (t) => {
		const writer = agent === "coder";
		const authoredPaths = [".clio-coder/profile.yaml", "new.txt", "removed.txt", "tracked.txt"];
		const env = await isolateClioEnv("clio-compete-state-");
		const root = join(env.dir, "project");
		mkdirSync(root);
		const previousCwd = process.cwd();
		process.chdir(root);
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.name", "Compete Contract");
		git(root, "config", "user.email", "compete@example.invalid");
		writeFileSync(join(root, "tracked.txt"), "baseline\n");
		writeFileSync(join(root, ".gitignore"), "node_modules/\n");
		if (writer) {
			mkdirSync(join(root, ".clio-coder"));
			writeFileSync(join(root, ".clio-coder/profile.yaml"), "responsePosture: concise\n");
			writeFileSync(join(root, "removed.txt"), "remove this\n");
		}
		git(root, "add", "-A");
		git(root, "commit", "-qm", "baseline");
		// context init's ignore update is pending in the caller, absent in candidates.
		writeFileSync(join(root, ".gitignore"), "node_modules/\n.clio-coder/\n");
		writeFileSync(join(root, "operator.txt"), "staged caller work\n");
		git(root, "add", "operator.txt");
		const before = snapshot(root);
		const candidateBefore: ReturnType<typeof snapshot>[] = [];
		const judged: ReturnType<typeof snapshot>[] = [];
		const candidatePaths: string[] = [];
		const changedPaths: string[] = [];
		let judgeTask = "";
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.fleet.retry.maxRetries = 0;
		settings.targets = [{ id: "only-route", runtime: "openai", defaultModel: "fixture-model" }];
		settings.fleet.default = { target: "only-route", model: "fixture-model", thinkingLevel: "off" };
		settings.fleet.profiles = {};
		settings.fleet.rosters = {
			panel: { members: ["a", "b", "judge"].map((label) => ({ label, target: "only-route", model: "fixture-model" })) },
		};
		const context = dispatchStubContext({
			settings,
			scheduling: {
				preflight: () => ({ verdict: "over", currentUsd: 100, ceilingUsd: 0.01 }),
				checkCeiling: () => "over",
			},
		});
		const specs = context.getContract<AgentsContract>("agents")?.listSpecs() ?? [];
		strictEqual(specs.find((spec) => spec.id === "scout")?.capabilityClass, "read-only");
		strictEqual(specs.find((spec) => spec.id === "coder")?.capabilityClass, "workspace-edit");
		const bundle = makeDispatchBundle(context, {
			spawnWorker: (spec, options) => {
				strictEqual(spec.budget.mode, "advisory");
				strictEqual(spec.budget.toolCalls, 1000);
				const cwd = options?.cwd;
				ok(cwd);
				const judge = spec.agentId === "verifier";
				if (judge) {
					judgeTask = spec.task;
					for (const path of candidatePaths) {
						judged.push(snapshot(path));
						changedPaths.push(git(path, "diff", "--name-only", `${before.head}...HEAD`));
					}
				} else {
					strictEqual(spec.agentId, agent);
					strictEqual(readFileSync(join(cwd, ".gitignore"), "utf8"), "node_modules/\n");
					mkdirSync(join(cwd, ".clio-coder"), { recursive: true });
					writeFileSync(join(cwd, ".clio-coder/codewiki.json"), '{"version":1,"entries":[]}\n');
					writeFileSync(join(cwd, ".clio-coder/state.json"), '{"version":1,"dirty":false}\n');
					if (writer) {
						writeFileSync(join(cwd, "tracked.txt"), "candidate work\n");
						writeFileSync(join(cwd, "new.txt"), "new candidate file\n");
						rmSync(join(cwd, "removed.txt"));
						writeFileSync(join(cwd, ".clio-coder/profile.yaml"), "responsePosture: thorough\n");
					}
					candidatePaths.push(cwd);
					candidateBefore.push(snapshot(cwd));
				}
				return {
					pid: null,
					promise: Promise.resolve({ exitCode: 0, signal: null }),
					heartbeatAt: { current: Date.now(), monotonic: performance.now() },
					abort() {},
					events: (async function* () {
						if (judge) {
							// This is the admitted production spec, with a source-only worker seam.
							ok(spec.autonomy === "read-only");
							ok(spec.allowedTools.includes(ToolNames.Read));
							const policy = createWorkerSafety({
								cwd,
								...(spec.writeRoots === undefined ? {} : { writeRoots: spec.writeRoots }),
								...(spec.protectedArtifactState === undefined
									? {}
									: { protectedArtifactState: { artifacts: [...spec.protectedArtifactState.artifacts] } }),
							});
							for (const line of spec.task.split("\n\n").filter((entry) => entry.startsWith('{"candidate":'))) {
								const evidence = JSON.parse(line);
								const call = { tool: ToolNames.Read, args: { path: evidence.receiptPath } };
								const decision = policy.evaluate(call);
								strictEqual(decision.kind, "allow");
								strictEqual(mapAutonomy(spec.autonomy, policy.classify(call).actionClass), "allow");
								const read = await readTool.run(call.args);
								strictEqual(read.kind, "ok");
								if (read.kind === "ok") {
									const receipt = JSON.parse(read.output);
									strictEqual(receipt.runId, evidence.runId);
									strictEqual(receipt.output.text, evidence.output.text);
								}
							}
						}
						if (writer && !judge) {
							// Model-free worker events carry the same ordinary tool facts as
							// the file operations above, including the deleted path.
							for (const path of authoredPaths) {
								const toolName = path === "removed.txt" ? "bash" : "write";
								const args = path === "removed.txt" ? { command: "rm removed.txt" } : { path };
								yield { type: "tool_execution_start", toolCallId: path, toolName, args };
								yield { type: "tool_execution_end", toolCallId: path, toolName, isError: false };
							}
							yield {
								type: "tool_execution_start",
								toolCallId: "check",
								toolName: "bash",
								args: { command: "git diff --check" },
							};
							git(cwd, "diff", "--check");
							yield { type: "tool_execution_end", toolCallId: "check", toolName: "bash", isError: false };
						}
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "stop",
								content: JSON.stringify(
									judge
										? { winner: 1, checks: [{ name: "grounded", passed: true, evidence: "tracked.txt:1" }] }
										: writer
											? {
													mutatedPaths: authoredPaths,
													validations: [{ name: "git diff --check", passed: true, evidence: "git diff --check exited 0" }],
												}
											: {
													findings: [
														{ claim: `The fixture contains baseline text; inspected ${cwd}.`, path: "tracked.txt", line: 1 },
													],
													needsSplit: false,
													proposedSubtasks: [],
												},
								),
							},
						};
					})(),
				};
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAgentSpecs: () => specs,
				getAutonomy: () => "full-auto",
				getSchemaComposition: () => dispatchSchemaCompositionFor(settings.fleet),
			});
			const args = {
				agent,
				task: writer ? "Update the fixture files and project profile." : "Inspect tracked.txt and explain its contents.",
				...(writer ? {} : { intent: { read_roots: ["tracked.txt"], write_roots: [], expected_outputs: [] } }),
				mode: "compete",
				budget: { toolCalls: 1000, readReserve: 10 },
				candidates: 2,
				cwd: root,
			};
			strictEqual(Value.Check(tool.parameters as never, args), true, "one-route schema must admit actual compete");
			for (const candidates of [1, 5, 2.5]) {
				const rejected = await tool.run({ ...args, candidates });
				strictEqual(rejected.kind, "error");
				if (rejected.kind === "error") match(rejected.message, /candidates must be an integer 2\.\.4/u);
				strictEqual(bundle.contract.listRuns().length, 0);
			}
			const result = await tool.run(args);
			const after = snapshot(root);
			t.diagnostic(
				JSON.stringify({ before, candidateBefore, judged, changedPaths, judgeTask, after, resultKind: result.kind }),
			);
			strictEqual(result.kind, "ok", JSON.stringify(result));
			const receipts = bundle.contract
				.listRuns()
				.filter((run) => run.agentId === agent)
				.map((run) => {
					ok(run.receiptPath);
					return JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
				});
			strictEqual(receipts.length, 2);
			const candidateEvidence = judgeTask
				.split("\n\n")
				.filter((line) => line.startsWith('{"candidate":'))
				.map((line) => JSON.parse(line));
			strictEqual(candidateEvidence.length, 2);
			for (const evidence of candidateEvidence) {
				const receipt = receipts.find((entry) => entry.runId === evidence.runId);
				ok(receipt);
				strictEqual(evidence.output.text, receipt.output?.text);
				strictEqual(evidence.digest, receipt.integrity?.digest);
				strictEqual(evidence.receiptIntegrity, true);
				strictEqual(evidence.worktree, receipt.gate?.worktree?.path);
				strictEqual(evidence.branch, receipt.gate?.worktree?.branch);
				strictEqual(evidence.candidate, candidatePaths.indexOf(evidence.worktree) + 1);
				strictEqual(JSON.parse(readFileSync(evidence.receiptPath, "utf8")).runId, receipt.runId);
			}

			strictEqual(new Set(receipts.map((receipt) => receipt.runId)).size, 2);
			strictEqual(new Set(candidatePaths).size, 2);
			const allRuns = bundle.contract.listRuns();
			strictEqual(allRuns.length, 3, "exactly two candidate executions plus one judge; no council substitution");
			const judgeRun = allRuns.find((run) => run.gate?.role === "judge");
			ok(judgeRun?.receiptPath);
			const judgeReceipt = JSON.parse(readFileSync(judgeRun.receiptPath, "utf8")) as RunReceipt;
			strictEqual(judgeReceipt.outcome, "succeeded");
			strictEqual(judgeReceipt.autonomyEnforcement?.autonomy, "read-only");
			deepStrictEqual(
				judgeReceipt.gate?.subjects?.map((subject) => subject.runId).sort(),
				receipts.map((receipt) => receipt.runId).sort(),
			);
			for (const receipt of [...receipts, judgeReceipt]) {
				strictEqual(receipt.targetId, "only-route");
				strictEqual(receipt.wireModelId, "fixture-model");
			}
			strictEqual(result.details?.mode, "compete");
			strictEqual(result.details?.receiptCount, 3);
			deepStrictEqual((result.details?.terminalRunIds as string[]).slice().sort(), allRuns.map((run) => run.id).sort());
			const winner = readGateDecisionArtifacts().find(({ artifact }) => artifact.outcome === "winner")?.artifact;
			ok(winner);
			strictEqual(winner.topology, "compete");
			strictEqual(winner.decider?.runId, judgeReceipt.runId);
			strictEqual(winner.subjects.length, 2);
			strictEqual(winner.winner?.index, 1);
			strictEqual(winner.correlation?.independent, false, "same-route judging must retain its correlation");
			deepStrictEqual(
				winner.subjects.map((subject) => subject.runId).sort(),
				receipts.map((receipt) => receipt.runId).sort(),
			);
			strictEqual(winner.winner?.subject.runId, receipts.find((receipt) => receipt.gate?.cycle === 1)?.runId);
			t.diagnostic(
				JSON.stringify({
					mode: result.details?.mode,
					candidateIds: receipts.map((receipt) => receipt.runId),
					judgeId: judgeReceipt.runId,
					receiptCount: result.details?.receiptCount,
					winner,
				}),
			);
			for (const receipt of receipts) {
				strictEqual(receipt.gate?.role, "candidate");
				strictEqual(receipt.outcome, "succeeded");
				strictEqual(receipt.autonomyEnforcement?.autonomy, writer ? "auto-edit" : "read-only");
				if (!writer) deepStrictEqual(receipt.intent?.writeRoots, []);
			}
			strictEqual(candidateBefore.length, 2);
			strictEqual(judged.length, 2);
			deepStrictEqual(changedPaths, Array(2).fill(writer ? authoredPaths.join("\n") : ""));
			if (writer) {
				strictEqual(git(root, "diff", "--name-only", `${before.head}..HEAD`), authoredPaths.join("\n"));
				strictEqual(after.head, judged[0]?.head);
				strictEqual(readFileSync(join(root, "tracked.txt"), "utf8"), "candidate work\n");
				strictEqual(readFileSync(join(root, ".clio-coder/profile.yaml"), "utf8"), "responsePosture: thorough\n");
				strictEqual(after.staged, before.staged);
				strictEqual(after.status, before.status);
				strictEqual(after.diff, before.diff);
			} else {
				deepStrictEqual(after, before);
				deepStrictEqual(
					candidateEvidence.map((evidence) => evidence.diffStat),
					["no changes", "no changes"],
				);
			}
			for (const candidate of judged) {
				if (!writer) strictEqual(candidate.head, before.head);
				strictEqual(candidate.staged, "");
				strictEqual(
					candidate.tracked,
					writer ? ".clio-coder/profile.yaml\n.gitignore\nnew.txt\ntracked.txt" : ".gitignore\ntracked.txt",
				);
			}
		} finally {
			await bundle.extension.stop?.();
			process.chdir(previousCwd);
			env.restore();
		}
	});
}

for (const trackedState of [false, true]) {
	it(`candidate finalization omits ${trackedState ? "tracked" : "untracked"} staged runtime state and preserves conflicting caller edits`, async (t) => {
		const env = await isolateClioEnv("clio-compete-staging-");
		const root = join(env.dir, "project");
		mkdirSync(join(root, ".clio-coder"), { recursive: true });
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.name", "Compete Contract");
		git(root, "config", "user.email", "compete@example.invalid");
		writeFileSync(join(root, ".gitignore"), ".clio-coder/worktrees/\n");
		writeFileSync(join(root, "tracked.txt"), "baseline\n");
		if (trackedState) {
			writeFileSync(join(root, ".clio-coder/codewiki.json"), "{}\n");
			writeFileSync(join(root, ".clio-coder/state.json"), "{}\n");
		}
		git(root, "add", "-A");
		git(root, "commit", "-qm", "baseline");
		writeFileSync(join(root, "tracked.txt"), "caller work\n");
		git(root, "add", "tracked.txt");
		writeFileSync(join(root, "tracked.txt"), "more caller work\n");
		const before = snapshot(root);
		const ownership = claimCompeteGroup(root, "staged-state");
		try {
			const candidate = await createCandidateWorktreeMapped(ownership, 1, before.head);
			mkdirSync(join(candidate.path, ".clio-coder"), { recursive: true });
			for (const name of ["codewiki.json", "state.json"]) {
				writeFileSync(join(candidate.path, ".clio-coder", name), '{"version":1}\n');
			}
			git(candidate.path, "add", "-A");
			const staged = snapshot(candidate.path);
			strictEqual(commitCandidateWork(candidate, "generated only"), false);
			strictEqual(candidateDiffStat(root, candidate.branch), "no changes");
			strictEqual(git(candidate.path, "diff", "--cached", "--name-only"), "");
			strictEqual(git(candidate.path, "rev-parse", "HEAD"), before.head);
			writeFileSync(join(candidate.path, "tracked.txt"), "candidate work\n");
			git(candidate.path, "add", "-A");
			strictEqual(commitCandidateWork(candidate, "authored change"), true);
			const changed = git(root, "diff", "--name-only", `HEAD...${candidate.branch}`);
			strictEqual(changed, "tracked.txt");
			const merge = mergeWinnerBranch(root, candidate.branch);
			const after = snapshot(root);
			t.diagnostic(JSON.stringify({ before, staged, changed, merge, after }));
			strictEqual(merge.ok, false);
			deepStrictEqual(after, before);
			strictEqual(readFileSync(join(candidate.path, "tracked.txt"), "utf8"), "candidate work\n");
			strictEqual(readFileSync(join(root, "tracked.txt"), "utf8"), "more caller work\n");
		} finally {
			cleanupCompeteGroup(markCompeteGroupCleanupReady(ownership));
			env.restore();
		}
	});
}

for (const phase of ["candidates", "judge"] as const) {
	for (const stopKind of ["timeout", "cancel"] as const) {
		it(`compete retains settled receipts after ${phase} ${stopKind}`, { timeout: 15_000 }, async () => {
			const env = await isolateClioEnv("clio-compete-stop-");
			const root = join(env.dir, "project");
			mkdirSync(root);
			const previousCwd = process.cwd();
			process.chdir(root);
			git(root, "init", "-q", "-b", "main");
			git(root, "config", "user.name", "Compete Contract");
			git(root, "config", "user.email", "compete@example.invalid");
			writeFileSync(join(root, "tracked.txt"), "baseline\n");
			git(root, "add", "-A");
			git(root, "commit", "-qm", "baseline");
			const before = snapshot(root);
			const controller = new AbortController();
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.fleet.retry.maxRetries = 0;
			const context = dispatchStubContext({ settings });
			const specs = context.getContract<AgentsContract>("agents")?.listSpecs() ?? [];
			let blockedCount = 0;
			let abortCount = 0;
			const bundle = makeDispatchBundle(context, {
				spawnWorker: (spec) => {
					const judge = spec.agentId === "verifier";
					const blocked = phase === "judge" ? judge : !judge;
					let finish = () => {};
					const stopped = new Promise<void>((resolve) => {
						finish = resolve;
					});
					if (blocked) {
						blockedCount += 1;
						if (stopKind === "cancel" && blockedCount === (phase === "judge" ? 1 : 2)) {
							setImmediate(() => controller.abort());
						}
					}
					return {
						pid: null,
						promise: blocked
							? stopped.then(() => ({ exitCode: 1, signal: null }))
							: Promise.resolve({ exitCode: 0, signal: null }),
						heartbeatAt: { current: Date.now(), monotonic: performance.now() },
						abort() {
							abortCount += 1;
							finish();
						},
						events: (async function* () {
							if (blocked) {
								await stopped;
								return;
							}
							yield {
								type: "message_end",
								message: {
									role: "assistant",
									stopReason: "stop",
									content: JSON.stringify({
										findings: [{ claim: "The fixture contains baseline text.", path: "tracked.txt", line: 1 }],
										needsSplit: false,
										proposedSubtasks: [],
									}),
								},
							};
						})(),
					};
				},
			});
			await bundle.extension.start();
			try {
				const tool = createDispatchTool({
					dispatch: bundle.contract,
					getAgentSpecs: () => specs,
					getAutonomy: () => "full-auto",
				});
				const result = await tool.run(
					{
						agent: "scout",
						task: "Explain tracked.txt with a grounded citation.",
						intent: { read_roots: ["tracked.txt"], write_roots: [], expected_outputs: [] },
						mode: "compete",
						candidates: 2,
						cwd: root,
						...(stopKind === "timeout" ? { timeout_ms: 1500 } : {}),
					},
					{ signal: controller.signal },
				);
				strictEqual(result.kind, "error");
				if (result.kind !== "error") throw new Error("expected stopped compete");
				match(result.message, stopKind === "timeout" ? /timed out after 1500ms/u : /aborted/u);
				strictEqual(blockedCount, phase === "judge" ? 1 : 2);
				strictEqual(abortCount, blockedCount);
				const runs = bundle.contract.listRuns();
				strictEqual(runs.length, phase === "judge" ? 3 : 2);
				for (const run of runs) {
					ok(run.receiptPath);
					const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
					const interrupted = phase === "candidates" || receipt.gate?.role === "judge";
					strictEqual(receipt.outcome, interrupted ? "canceled" : "succeeded");
					if (interrupted)
						match(receipt.outcomeDetail ?? "", stopKind === "timeout" ? /timed out after 1500ms/u : /operator abort/u);
					ok(result.message.includes(run.id), "stopped tool output must retain each terminal run identity");
					ok(result.message.includes(run.receiptPath), "stopped tool output must locate each receipt");
				}
				strictEqual(result.details?.receiptCount, runs.length);
				deepStrictEqual((result.details?.terminalRunIds as string[]).slice().sort(), runs.map((run) => run.id).sort());
				strictEqual((result.details?.compete as { winner: unknown }).winner, null);
				strictEqual(readGateDecisionArtifacts().length, 0, "interruption must not invent a judge verdict");
				deepStrictEqual(snapshot(root), before);
				strictEqual(git(root, "worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
				strictEqual(git(root, "branch", "--list", "clio-coder/compete/*"), "");
			} finally {
				await bundle.extension.stop?.();
				process.chdir(previousCwd);
				env.restore();
			}
		});
	}
}
