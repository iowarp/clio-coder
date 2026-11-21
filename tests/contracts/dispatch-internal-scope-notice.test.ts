import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { installDiagnosticSink } from "../../src/core/diagnostics.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import { declaredScopeReplacementDiagnostic, resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";
import { localNodeIdentity } from "../../src/domains/dispatch/transport.js";
import type { WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { workerSpecToolNames } from "../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

it("operator bootstrap report: internal schema retries keep scope provenance without transcript warnings", async () => {
	const env = await isolateClioEnv("internal-scope-notice-");
	const context = dispatchStubContext();
	const notices: unknown[] = [];
	const diagnostics: string[] = [];
	const removeSink = installDiagnosticSink((text) => diagnostics.push(text));
	const unsubscribe = context.bus.subscribe("run.scope_notice_raised", (notice) => {
		if (notice.code !== "worker_judge_withheld") notices.push(notice);
	});
	const bundle = makeDispatchBundle(context);
	try {
		await bundle.extension.start();
		const scope = declaredScopeIntent({ readRoots: ["."] });
		ok(scope.ok);
		const request = {
			agentId: "context-bootstrap",
			executionRole: "researcher" as const,
			task: "Inspect CLIO-CODER.md CLAUDE.md src/engine/types.ts and tests/contracts/bootstrap-route.test.ts.",
			cwd: env.dir,
			intent: scope.intent,
			responseSchema: { type: "object" },
		};
		for (let attempt = 0; attempt < 2; attempt++)
			await rejects(
				bundle.contract.dispatch({
					...request,
					requestOrigin: "internal",
					lineage: { rootRunId: "bootstrap-root", parentRunId: null, attempt, depth: 0 },
				}),
				/responseSchema/,
			);
		strictEqual(diagnostics.filter((text) => text.includes("typed scope replacement")).length, 0);
		strictEqual(
			notices.length,
			0,
			"harness-owned native-schema attempts must not repeat the generated prompt's path list in the transcript",
		);
		const resolved = resolveDispatchPathScope(request);
		deepStrictEqual(resolved.workingContextPaths, []);
		deepStrictEqual(resolved.writeBoundaries, []);
		ok(declaredScopeReplacementDiagnostic(resolved)?.includes("src/engine/types.ts"), "the diagnostic remains available");
		ok(resolved.inferredOnlyPaths.includes("CLIO-CODER.md"), "omissions remain recorded without expanding authority");
		for (const requestOrigin of ["user", "agent"] as const)
			await rejects(bundle.contract.dispatch({ ...request, agentId: "coder", requestOrigin }), /responseSchema/);
		strictEqual(notices.length, 0, "operator dispatches omit transcript scope warnings");
		for (const requestOrigin of ["user", "agent"] as const) {
			await rejects(
				bundle.contract.dispatch({
					...request,
					agentId: "coder",
					requestOrigin,
					lineage: { rootRunId: `retry-${requestOrigin}`, parentRunId: null, attempt: 1, depth: 0 },
				}),
				/responseSchema/,
			);
		}
		strictEqual(notices.length, 0, "operator retries omit transcript scope warnings");
		strictEqual(
			diagnostics.filter((text) => text.includes("typed scope replacement")).length,
			0,
			"context source inventories stay in receipt provenance without warning diagnostics",
		);
	} finally {
		unsubscribe();
		removeSink();
		await bundle.extension.stop?.();
		env.restore();
	}
});

it("announces withheld checks for narrow roots without an OS sandbox", async () => {
	const env = await isolateClioEnv("narrow-roots-notice-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.sandbox = "off";
	const context = dispatchStubContext({ settings });
	const notices: Array<{ code: string; message: string }> = [];
	const unsubscribe = context.bus.subscribe("run.scope_notice_raised", (notice) => {
		if (notice.code !== "worker_judge_withheld") notices.push(notice);
	});
	const tools: Array<ReadonlyArray<string>> = [];
	const bundle = makeDispatchBundle(context, {
		spawnWorker: (spec) => {
			tools.push(workerSpecToolNames(spec));
			throw new Error("fixture: scope admitted");
		},
	});
	try {
		await bundle.extension.start();
		for (const writeRoots of [["src/duration.js"], []]) {
			const scope = declaredScopeIntent({ writeRoots });
			ok(scope.ok);
			await rejects(
				bundle.contract.dispatch({
					agentId: "coder",
					executionRole: "builder",
					task: "Implement duration parsing and run npm test.",
					cwd: env.dir,
					intent: scope.intent,
				}),
				/fixture: scope admitted/u,
			);
		}
		strictEqual(notices.length, 1);
		strictEqual(notices[0]?.code, "write_roots_checks_withheld");
		match(notices[0]?.message ?? "", /bash and verify are withheld.*cannot run checks.*safety\.sandbox/u);
		ok(!tools[0]?.includes(ToolNames.Bash));
		ok(!tools[0]?.includes(ToolNames.Verify));
		ok(tools[1]?.includes(ToolNames.Bash));
		ok(tools[1]?.includes(ToolNames.Verify));
	} finally {
		unsubscribe();
		await bundle.extension.stop?.();
		env.restore();
	}
});

it("names withheld checks in the dispatch result and the worker's own prompt (CLI-H2)", async () => {
	const env = await isolateClioEnv("withheld-checks-result-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.sandbox = "off";
	const context = dispatchStubContext({ settings });
	const specs: WorkerSpec[] = [];
	const bundle = makeDispatchBundle(context, {
		spawnWorker: (spec) => {
			specs.push(spec);
			return {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort() {},
				events: (async function* () {
					yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "edited" } };
				})(),
			};
		},
	});
	const home = process.cwd();
	process.chdir(env.dir);
	try {
		await bundle.extension.start();
		const tool = createDispatchTool({
			dispatch: bundle.contract,
			getAgentSpecs: () => context.getContract("agents")?.listSpecs() ?? [],
			getAutonomy: () => "yolo",
		});
		const task = (path: string) => ({ task: `Edit ${path}.`, intent: { write_roots: [path] } });
		const detached = await tool.run({
			agent: "coder",
			tasks: [task("a.js"), task("b.js")],
			detach: true,
		});
		strictEqual(detached.kind, "ok", JSON.stringify(detached).slice(0, 600));
		const detachedText = detached.kind === "ok" ? detached.output : "";
		strictEqual(detachedText.match(/agent=coder \[withheld: bash, verify\b/gu)?.length, 2, detachedText);
		match(detachedText, /write roots with neither an OS sandbox nor a task worktree.*cannot run checks/u);
		const sync = await tool.run({ agent: "coder", ...task("c.js") });
		match(
			JSON.stringify(sync),
			/ran without bash, verify \(write-roots-unconfined\).*neither an OS sandbox nor a task worktree/u,
		);
		strictEqual(specs.length, 3);
		for (const spec of specs) {
			const notice = spec.dynamicPromptMessages?.find((message) => message.id === "dispatch-withheld");
			match(notice?.body ?? "", /- bash: .*- verify: .*Without bash, verify.*checks you could not run/su);
		}
	} finally {
		process.chdir(home);
		await bundle.extension.stop?.();
		env.restore();
	}
});

it("places unconfined rooted coders in their own worktrees with bash and verify, merging back only their roots (M7)", async () => {
	const env = await isolateClioEnv("worktree-placement-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.sandbox = "off";
	const context = dispatchStubContext({ settings });
	const repo = join(env.dir, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	for (const file of ["a.js", "b.js", "stray.js"]) writeFileSync(join(repo, file), "base\n");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	const specs: WorkerSpec[] = [];
	const bundle = makeDispatchBundle(context, {
		spawnWorker: (spec) => {
			specs.push(spec);
			// The stub edits its worktree as a worker would: its own root, and one tracked file outside it.
			const own = spec.task.includes("a.js") ? "a.js" : "b.js";
			const tree = spec.taskWorktree?.path ?? "";
			ok(tree.length > 0, "the run must have its own worktree");
			const edits = own === "a.js" ? [own, "stray.js"] : [own];
			for (const file of edits) writeFileSync(join(tree, file), "edited\n");
			return {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort() {},
				events: (async function* () {
					for (const [index, file] of edits.entries()) {
						const args = { path: join(tree, file), oldText: "base", newText: "edited" };
						yield { type: "tool_execution_start", toolCallId: `e${index}`, toolName: "edit", args };
						yield {
							type: "tool_execution_end",
							toolCallId: `e${index}`,
							toolName: "edit",
							isError: false,
							result: { content: [{ type: "text", text: `edited ${file}` }] },
						};
						yield {
							type: "clio_coder_tool_finish",
							payload: { tool: "edit", toolCallId: `e${index}`, outcome: "ok", durationMs: 1 },
						};
					}
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							stopReason: "stop",
							content: JSON.stringify({ mutatedPaths: edits, validations: [], summary: `edited ${own}` }),
						},
					};
				})(),
			};
		},
	});
	const home = process.cwd();
	process.chdir(repo);
	try {
		await bundle.extension.start();
		const tool = createDispatchTool({
			dispatch: bundle.contract,
			getAgentSpecs: () => context.getContract("agents")?.listSpecs() ?? [],
			getAutonomy: () => "yolo",
		});
		const task = (path: string) => ({ task: `Edit ${path}.`, intent: { write_roots: [path] } });
		const result = await tool.run({ agent: "coder", tasks: [task("a.js"), task("b.js")] });
		strictEqual(specs.length, 2);
		for (const spec of specs) {
			strictEqual(spec.envelope.write.mode, "worktree");
			strictEqual(spec.envelope.write.commandsBounded, true);
			ok(workerSpecToolNames(spec).includes(ToolNames.Bash));
			ok(workerSpecToolNames(spec).includes(ToolNames.Verify));
			ok(!spec.envelope.withheld.some((entry) => entry.reason === "write-roots-unconfined"));
		}
		strictEqual(readFileSync(join(repo, "a.js"), "utf8"), "edited\n", JSON.stringify(result).slice(0, 600));
		strictEqual(readFileSync(join(repo, "b.js"), "utf8"), "edited\n");
		strictEqual(readFileSync(join(repo, "stray.js"), "utf8"), "base\n", "only the declared roots merge back");
		match(JSON.stringify(result), /changes outside the write roots stay uncommitted in worktree [^"]*: stray\.js/u);
	} finally {
		process.chdir(home);
		await bundle.extension.stop?.();
		env.restore();
	}
});

it("a worker placed on this host expects its sandbox backend even with fleet nodes configured", async (t) => {
	if (!sandboxAvailability().available) return t.skip("no OS sandbox backend on this host");
	const env = await isolateClioEnv("placed-here-backend-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.nodes = [{ id: "gpu1", host: "gpu1.invalid", maxWorkers: 1 }];
	const sandboxes: Array<WorkerSpec["sandbox"]> = [];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		spawnWorker: (spec) => {
			sandboxes.push(spec.sandbox);
			throw new Error("fixture: placed");
		},
		resolveNode: () => ({ node: localNodeIdentity() }),
		previewNode: () => ({ node: localNodeIdentity() }),
	});
	try {
		await bundle.extension.start();
		await rejects(
			bundle.contract.dispatch({ agentId: "coder", executionRole: "builder", task: "Run npm test.", cwd: env.dir }),
			/fixture: placed/u,
		);
		strictEqual(sandboxes.length, 1);
		strictEqual(sandboxes[0]?.mode, "auto");
		strictEqual(sandboxes[0]?.backendExpected, true, "a timed-out probe in the worker must refuse, not run direct");
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});

it("a local writer with write roots keeps bash and verify when fleet nodes are configured (M6)", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") return t.skip("no bubblewrap on this host");
	const env = await isolateClioEnv("placed-here-confined-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.nodes = [{ id: "gpu1", host: "gpu1.invalid", maxWorkers: 1 }];
	const tools: Array<ReadonlyArray<string>> = [];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		spawnWorker: (spec) => {
			tools.push(workerSpecToolNames(spec));
			throw new Error("fixture: placed");
		},
		resolveNode: () => ({ node: localNodeIdentity() }),
		previewNode: () => ({ node: localNodeIdentity() }),
	});
	try {
		await bundle.extension.start();
		const scope = declaredScopeIntent({ writeRoots: ["src/duration.js"] });
		ok(scope.ok);
		const request = {
			agentId: "coder",
			executionRole: "builder" as const,
			task: "Implement duration parsing and run npm test.",
			cwd: env.dir,
			intent: scope.intent,
		};
		await rejects(bundle.contract.dispatch(request), /fixture: placed/u);
		ok(tools[0]?.includes(ToolNames.Bash), JSON.stringify(tools[0]));
		ok(tools[0]?.includes(ToolNames.Verify), JSON.stringify(tools[0]));
	} finally {
		await bundle.extension.stop?.();
		env.restore();
	}
});

it("names the deny permit a judge-mode dispatch runs with when no safety judge is seated (N2)", async () => {
	const env = await isolateClioEnv("judge-withheld-notice-");
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.permissions.mode = "judge";
	settings.safety.judge.enabled = true;
	const notices: Array<{ code: string; message: string }> = [];
	const permissions: Array<WorkerSpec["onPermission"]> = [];
	const spawnWorker = (spec: WorkerSpec): never => {
		permissions.push(spec.onPermission);
		throw new Error("fixture: admitted");
	};
	const dispatchOnce = async (options: Parameters<typeof makeDispatchBundle>[1]) => {
		const context = dispatchStubContext({ settings });
		const unsubscribe = context.bus.subscribe("run.scope_notice_raised", (notice) => {
			notices.push(notice);
		});
		const bundle = makeDispatchBundle(context, { ...options, spawnWorker });
		try {
			await bundle.extension.start();
			for (let n = 0; n < 2; n++)
				await rejects(
					bundle.contract.dispatch({
						agentId: "scout",
						executionRole: "researcher",
						task: "Read the README.",
						cwd: env.dir,
					}),
					/fixture: admitted/u,
				);
		} finally {
			unsubscribe();
			await bundle.extension.stop?.();
		}
	};
	try {
		await dispatchOnce({});
		strictEqual(notices.length, 1, "raised once per process, not on every dispatch");
		strictEqual(notices[0]?.code, "worker_judge_withheld");
		match(
			notices[0]?.message ?? "",
			/mode is judge, but this process seats no safety judge.*workers dispatched here run with the deny permit/u,
		);
		strictEqual(permissions[0] ?? "deny", "deny");
		await dispatchOnce({ workerAskJudge: { seat: () => undefined, autonomy: () => "default" } });
		strictEqual(notices.length, 1, "a seated judge answers the asks, so nothing is announced");
	} finally {
		env.restore();
	}
});
