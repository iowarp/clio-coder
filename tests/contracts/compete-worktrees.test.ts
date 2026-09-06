import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
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
	it(`${agent} compete excludes generated state and preserves caller work`, async (t) => {
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
		const context = dispatchStubContext({ settings });
		const specs = context.getContract<AgentsContract>("agents")?.listSpecs() ?? [];
		strictEqual(specs.find((spec) => spec.id === "scout")?.capabilityClass, "read-only");
		strictEqual(specs.find((spec) => spec.id === "coder")?.capabilityClass, "workspace-edit");
		const bundle = makeDispatchBundle(context, {
			spawnWorker: (spec, options) => {
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
					heartbeatAt: { current: Date.now(), monotonic: 0 },
					abort() {},
					events: (async function* () {
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
													findings: [{ claim: "The fixture contains baseline text.", path: "tracked.txt", line: 1 }],
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
			});
			const result = await tool.run({
				agent,
				task: writer ? "Update the fixture files and project profile." : "Inspect tracked.txt and explain its contents.",
				...(writer ? {} : { intent: { read_roots: ["tracked.txt"], write_roots: [], expected_outputs: [] } }),
				mode: "compete",
				candidates: 2,
				cwd: root,
			});
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
					return JSON.parse(readFileSync(run.receiptPath, "utf8"));
				});
			strictEqual(receipts.length, 2);
			for (const receipt of receipts) {
				strictEqual(receipt.outcome, "succeeded");
				strictEqual(receipt.autonomyEnforcement.autonomy, writer ? "auto-edit" : "read-only");
				if (!writer) deepStrictEqual(receipt.intent.writeRoots, []);
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
				match(judgeTask, /candidate-1 \(no changes\)/u);
				match(judgeTask, /candidate-2 \(no changes\)/u);
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
