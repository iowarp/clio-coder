import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { installDiagnosticSink } from "../../src/core/diagnostics.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import { declaredScopeReplacementDiagnostic, resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";
import { localNodeIdentity } from "../../src/domains/dispatch/transport.js";
import type { WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
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
			tools.push(spec.allowedTools);
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
