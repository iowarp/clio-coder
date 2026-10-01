import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker, SpawnedWorkerResult } from "../../src/domains/dispatch/worker-spawn.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createRegistry } from "../../src/tools/registry.js";
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
	const root = join(stateDir, "project");
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

	const cwdLog = join(root, "..", "check-cwd.log");
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
		const checkedCwd = readFileSync(cwdLog, "utf8");
		ok(!relative(worktree, checkedCwd).startsWith(".."), `check ran in ${checkedCwd}, worktree ${worktree}`);
		strictEqual(receipt.hostVerification?.checks[0]?.tree?.root, worktree);
	} finally {
		finish({ exitCode: 0, signal: null });
		await bundle.extension.stop?.();
	}
});
