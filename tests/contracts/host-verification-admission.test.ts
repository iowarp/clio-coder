import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { createSessionCodeConsent } from "../../src/domains/safety/session-code-consent.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createRegistry, type PermissionRequiredMeta } from "../../src/tools/registry.js";
import { resolveVerifyCall } from "../../src/tools/verify/resolve.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

// F6: dispatch host verification executes declared checks as the dispatching
// agent. It must admit each check as the direct verify call would, and a
// worktree dispatch must verify the task worktree, not the source checkout.

beforeEach(async () => isolateDispatchState());
afterEach(() => restoreDispatchState());

function project(checks: ReadonlyArray<{ id: string; command: string[] }>): string {
	const stateDir = process.env.CLIO_CODER_STATE_DIR;
	ok(stateDir);
	// Beside Clio's state root, not in it: host checks run in the main-session
	// sandbox, which keeps Clio's own directories read-only.
	const root = join(dirname(stateDir), "project");
	mkdirSync(join(root, ".clio-coder"), { recursive: true });
	writeFileSync(join(root, "input.txt"), "base\n");
	writeFileSync(
		join(root, ".clio-coder", "verifiers.yaml"),
		JSON.stringify({
			version: 2,
			checks: checks.map((check) => ({
				...check,
				description: `Check ${check.id}`,
				cwd: ".",
				timeoutMs: 5_000,
				tags: [],
			})),
		}),
	);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	git("add", "-A");
	git("commit", "-qm", "fixture");
	return realpathSync(root);
}

it("refuses a dispatch whose host check the direct verify call would not admit, and verifies the task worktree", async () => {
	// Command strings are policy data only: the refused dispatch never runs them.
	const root = project([
		{ id: "build", command: ["./scripts/build.sh"] },
		{ id: "publish", command: ["git", "push", "--force"] },
	]);
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "default" });
		let dispatched = 0;
		const contract = {
			dispatch: async () => {
				dispatched += 1;
				throw new Error("dispatch must not run");
			},
		} as unknown as DispatchContract;
		registry.register(
			createDispatchTool({
				dispatch: contract,
				getAgentSpecs: () => [{ id: "coder", capabilityClass: "workspace-edit" }] as never,
			}),
		);
		const dispatchWith = (checks: string[]) =>
			registry.invoke({
				tool: "dispatch",
				args: {
					agent: "coder",
					task: "Edit input.txt.",
					intent: { version: 2, write_roots: ["input.txt"], verification: checks.map((check) => ({ check })) },
				},
			});
		const asked = await dispatchWith(["build"]);
		strictEqual(asked.kind, "blocked");
		match(asked.kind === "blocked" ? asked.reason : "", /host verification check 'build' would not be admitted/);
		const blocked = await dispatchWith(["build", "publish"]);
		strictEqual(blocked.kind, "blocked");
		match(blocked.kind === "blocked" ? blocked.reason : "", /host verification check 'publish'/);
		strictEqual(dispatched, 0);
	} finally {
		process.chdir(previousCwd);
	}

	// The check runs in the main-session sandbox rooted at the task worktree, so
	// it records its cwd inside the tree it may write.
	const cwdLog = "check-cwd.log";
	let finish!: (result: SpawnedWorkerResult) => void;
	const done = new Promise<SpawnedWorkerResult>((resolve) => {
		finish = resolve;
	});
	const worker: SpawnedWorker = {
		pid: null,
		promise: done,
		heartbeatAt: { current: Date.now(), monotonic: 0 },
		events: (async function* () {
			await done;
			// A builder that executes no tool seals failed, so the run needs one call.
			yield { type: "clio_coder_tool_finish", payload: { tool: "read", outcome: "ok", durationMs: 1 } };
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
				},
			};
		})(),
		abort() {
			finish({ exitCode: null, signal: "SIGTERM" });
		},
	};
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), { spawnWorker: () => worker });
	await bundle.extension.start();
	try {
		const handle = await bundle.contract.dispatch({
			agentId: "coder",
			task: "Edit input.txt.",
			executionRole: "builder",
			requestOrigin: "internal",
			resultContractOverride: { kind: "provenance-report" },
			cwd: root,
			worktree: true,
			apply: "preserve",
			resolvedVerification: [
				{
					check: "cwd",
					argv: [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(cwdLog)}, process.cwd());`],
					cwd: root,
					timeoutMs: 5_000,
				},
			],
		});
		finish({ exitCode: 0, signal: null });
		const receipt = await handle.finalPromise;
		const worktree = receipt.worktree?.path;
		ok(worktree !== undefined, JSON.stringify(receipt.worktree));
		const checkedCwd = readFileSync(join(worktree, cwdLog), "utf8");
		ok(!relative(worktree, checkedCwd).startsWith(".."), `check ran in ${checkedCwd}, worktree ${worktree}`);
		strictEqual(receipt.hostVerification?.checks[0]?.tree?.root, worktree);
	} finally {
		finish({ exitCode: 0, signal: null });
		await bundle.extension.stop?.();
	}
});

it("parks an attended dispatch whose test-runner check needs the session's consent, and runs it once approved", async () => {
	// The command string is policy data only: the stubbed dispatch never runs it.
	const root = project([{ id: "unit", command: ["pytest", "-q"] }]);
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const consent = createSessionCodeConsent();
		const registry = createRegistry({
			safety: createWorkerSafety({ cwd: root }),
			autonomy: () => "default",
			sessionCodeConsent: consent,
		});
		let dispatched = 0;
		const contract = {
			dispatch: async () => {
				dispatched += 1;
				throw new Error("dispatched");
			},
		} as unknown as DispatchContract;
		registry.register(
			createDispatchTool({
				dispatch: contract,
				getAgentSpecs: () => [{ id: "coder", capabilityClass: "workspace-edit" }] as never,
			}),
		);
		const asks: PermissionRequiredMeta[] = [];
		const details: string[] = [];
		registry.onPermissionRequired((_call, decision, meta) => {
			asks.push(meta);
			details.push(decision.kind === "ask" ? decision.rejection.detail : "");
			setImmediate(() => {
				void registry.resumeParkedCalls({
					actionClass: decision.classification.actionClass,
					requestId: meta.requestId,
					requestedBy: "tool:one_shot",
				});
			});
		});
		const verdict = await registry.invoke({
			tool: "dispatch",
			args: {
				agent: "coder",
				task: "Edit input.txt.",
				intent: { version: 2, write_roots: ["input.txt"], verification: [{ check: "unit" }] },
			},
		});
		strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
		deepStrictEqual(
			asks.map((meta) => meta.axis),
			["net:session-code-consent"],
		);
		match(details[0] ?? "", /Approving this call approves this task:/);
		strictEqual(dispatched, 1);
		strictEqual(consent.pending(), false, "approving the dispatch's ask gives the session's consent");
	} finally {
		process.chdir(previousCwd);
	}
});

it("asks once for a multi-task dispatch that needs the session's test-runner consent, and runs it after one approval", async () => {
	// The command string is policy data only: the stubbed dispatch never runs it.
	const root = project([{ id: "unit", command: ["pytest", "-q"] }]);
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const consent = createSessionCodeConsent();
		const registry = createRegistry({
			safety: createWorkerSafety({ cwd: root }),
			autonomy: () => "default",
			sessionCodeConsent: consent,
		});
		let dispatched = 0;
		const contract = {
			dispatchBatch: async () => {
				dispatched += 1;
				throw new Error("dispatched");
			},
		} as unknown as DispatchContract;
		registry.register(
			createDispatchTool({
				dispatch: contract,
				getAgentSpecs: () => [{ id: "coder", capabilityClass: "workspace-edit" }] as never,
			}),
		);
		const asks: Array<{ meta: PermissionRequiredMeta; actionClass: string; detail: string }> = [];
		registry.onPermissionRequired((_call, decision, meta) => {
			asks.push({
				meta,
				actionClass: decision.classification.actionClass,
				detail: decision.kind === "ask" ? decision.rejection.detail : "",
			});
			setImmediate(() => {
				void registry.resumeParkedCalls({
					actionClass: decision.classification.actionClass,
					requestId: meta.requestId,
					requestedBy: "tool:one_shot",
				});
			});
		});
		const intent = (root: string) => ({ version: 2, write_roots: [root], verification: [{ check: "unit" }] });
		const verdict = await registry.invoke({
			tool: "dispatch",
			args: {
				tasks: [
					{ agent: "coder", task: "Edit input.txt.", intent: intent("input.txt") },
					{ agent: "coder", task: "Edit other.txt.", intent: intent("other.txt") },
				],
			},
		});
		strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
		deepStrictEqual(
			asks.map((ask) => [ask.meta.axis, ask.actionClass]),
			[["net:session-code-consent", "dispatch"]],
		);
		match(asks[0]?.detail ?? "", /Approving this call approves the whole plan/);
		match(asks[0]?.detail ?? "", /Approving also gives this session's test-runner consent/);
		strictEqual(dispatched, 1, "the approved plan reached dispatch");
		strictEqual(consent.pending(), false, "the one approval gives the session's consent");
	} finally {
		process.chdir(previousCwd);
	}
});

it("admits a compete whose operator turn names `npm test`, moving the check and every checkout path it names into each candidate's worktree (M10a)", async () => {
	const root = project([{ id: "test", command: [process.execPath, "-e", "process.exit(0)"] }]);
	// Absolute argv words and numeric inputs under the checkout follow the candidate; a path outside the checkout,
	// or a tool git ignores there, stays. An ignored operand is candidate output and moves.
	writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n");
	writeFileSync(join(root, "ref.json"), '{"e":1}');
	const argv = [
		process.execPath,
		join(root, "node_modules", ".bin", "tool"),
		join(root, "scripts", "check.mjs"),
		join(root, "src"),
		`--root=${root}`,
		join(root, "dist", "x.js"),
	];
	writeFileSync(
		join(root, ".clio-coder", "verifiers.yaml"),
		JSON.stringify({
			version: 2,
			checks: [
				{ id: "test", description: "Check test", command: argv, cwd: ".", timeoutMs: 5_000, tags: [] },
				{
					id: "num",
					description: "Check num",
					kind: "numeric-compare",
					command: [process.execPath, "-e", "process.stdout.write('{\"e\":1}')"],
					reference: "ref.json",
					tolerance: { absolute: 0 },
					inputs: ["input.txt"],
					cwd: ".",
					timeoutMs: 5_000,
					tags: [],
				},
			],
		}),
	);
	execFileSync("git", ["-C", root, "add", "-A"]);
	execFileSync("git", ["-C", root, "commit", "-qm", "checks"]);
	const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "yolo" });
		const requests: Array<Record<string, unknown>> = [];
		const contract = {
			dispatch: async (request: Record<string, unknown>) => {
				requests.push(request);
				throw new Error("dispatched");
			},
		} as unknown as DispatchContract;
		registry.register(
			createDispatchTool({
				dispatch: contract,
				getAgentSpecs: () => [{ id: "coder", capabilityClass: "workspace-edit" }] as never,
				getAutonomy: () => "yolo",
				captureWorkerContext: () =>
					({ messages: [{ role: "user", content: "Run npm test to verify, and compete on this edit." }] }) as never,
			}),
		);
		const verdict = await registry.invoke({
			tool: "dispatch",
			args: {
				agent: "coder",
				task: "Edit input.txt.",
				mode: "compete",
				candidates: 2,
				intent: { verification: [{ check: "num" }] },
			},
		});
		ok(!JSON.stringify(verdict).includes("verification_unsupported_for_mode"), JSON.stringify(verdict));
		ok(requests.length > 0, JSON.stringify(verdict));
		for (const request of requests) {
			const worktree = request.cwd as string;
			ok(worktree !== root && worktree.startsWith(root), worktree);
			const checks = request.resolvedVerification as Array<{
				check: string;
				cwd: string;
				argv: string[];
				numeric?: { reference: string; inputs?: string[] };
			}>;
			deepStrictEqual(checks.map((check) => [check.check, check.cwd]).sort(), [
				["num", worktree],
				["test", worktree],
			]);
			deepStrictEqual(checks.find((check) => check.check === "test")?.argv, [
				process.execPath,
				join(root, "node_modules", ".bin", "tool"),
				join(worktree, "scripts", "check.mjs"),
				join(worktree, "src"),
				`--root=${worktree}`,
				join(worktree, "dist", "x.js"),
			]);
			const numeric = checks.find((check) => check.check === "num")?.numeric;
			deepStrictEqual(numeric?.inputs, [join(worktree, "input.txt")]);
			strictEqual(numeric?.reference, join(root, "ref.json"), "the sealed reference stays where admission read it");
			deepStrictEqual(request.candidateWorktree, { root, path: worktree, base: head });
		}
	} finally {
		process.chdir(previousCwd);
	}
});

it("admits a toolchain check verify lists in a Python project and seals the argv verify runs", async () => {
	const stateDir = process.env.CLIO_CODER_STATE_DIR;
	ok(stateDir);
	const root = join(dirname(stateDir), "python-project");
	mkdirSync(join(root, "tests"), { recursive: true });
	writeFileSync(join(root, "tests", "test_greet.py"), "import unittest\n");
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: root }), autonomy: () => "yolo" });
		const requests: Array<Record<string, unknown>> = [];
		const contract = {
			dispatch: async (request: Record<string, unknown>) => {
				requests.push(request);
				throw new Error("dispatched");
			},
		} as unknown as DispatchContract;
		registry.register(
			createDispatchTool({
				dispatch: contract,
				getAgentSpecs: () => [{ id: "coder", capabilityClass: "workspace-edit" }] as never,
			}),
		);
		const verdict = await registry.invoke({
			tool: "dispatch",
			args: {
				agent: "coder",
				task: "Edit greet.py.",
				intent: { version: 2, write_roots: ["greet.py"], verification: [{ check: "python-unittest" }] },
			},
		});
		strictEqual(verdict.kind, "ok", JSON.stringify(verdict));
		const resolution = resolveVerifyCall(root, { check: "python-unittest" });
		ok(resolution.kind === "toolchain", JSON.stringify(resolution));
		deepStrictEqual(requests[0]?.resolvedVerification, [
			{ check: "python-unittest", argv: resolution.argv, cwd: root, timeoutMs: resolution.check.timeoutMs },
		]);
		// A family word verify maps to one derived owner is admitted too, sealing that owner's argv (FL-12).
		const family = resolveVerifyCall(root, { check: "test" });
		ok(family.kind === "toolchain" && family.check.id === "python-unittest", JSON.stringify(family));
		const aliased = await registry.invoke({
			tool: "dispatch",
			args: {
				agent: "coder",
				task: "Edit greet.py.",
				intent: { version: 2, write_roots: ["greet.py"], verification: [{ check: "test" }] },
			},
		});
		strictEqual(aliased.kind, "ok", JSON.stringify(aliased));
		deepStrictEqual(requests[1]?.resolvedVerification, [
			{ check: "test", argv: family.argv, cwd: root, timeoutMs: family.check.timeoutMs },
		]);
	} finally {
		process.chdir(previousCwd);
	}
});
