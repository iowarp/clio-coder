import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { type ExtensionRuntimeHookExecutor, RUNTIME_V2_LIMITS } from "../../src/domains/extensions/index.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import type { HookReceipt } from "../../src/domains/middleware/index.js";
import {
	buildExtensionRuntimeHooks,
	buildWorkerExtensionHooks,
	evaluateWorkerHookRequest,
} from "../../src/entry/extension-runtime-hooks.js";
import type { WorkerHookRequest, WorkerHookRun } from "../../src/worker/protocol.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/** One installed extension with a before_tool gate on `read`, run through the given executor. */
async function workerGate(t: TestContext, hook: ExtensionRuntimeHookExecutor["hook"]) {
	const env = await isolateClioEnv("clio-coder-worker-hook-host-");
	const source = path.join(env.dir, "source");
	const workspace = path.join(env.dir, "workspace");
	mkdirSync(source);
	mkdirSync(workspace);
	writeFileSync(
		path.join(source, "clio-coder-extension.json"),
		JSON.stringify({
			id: "worker_gate",
			name: "Worker gate",
			version: "1.0.0",
			description: "Gates worker reads",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				hooks: [{ on: "before_tool", tools: ["read"], timeoutMs: 1000, onTimeout: "block", onError: "block" }],
				access: ["tool-args"],
			},
		}),
	);
	writeFileSync(path.join(source, "extension.mjs"), "export default () => {};\n");
	ok(installExtension(source, { cwd: workspace, scope: "user" }).extension?.loadable);
	const previous = process.cwd();
	process.chdir(workspace);
	t.after(() => {
		process.chdir(previous);
		env.restore();
	});
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({ hook, notify: () => {} });
	const receipts: HookReceipt[] = [];
	const packages = listInstalledExtensions(workspace, { all: true });
	const hooks = buildExtensionRuntimeHooks(packages, bridge, {
		generation: 1,
		recordReceipt: (receipt) => receipts.push(receipt),
	});
	const [declared] = buildWorkerExtensionHooks(packages);
	ok(declared);
	const ask = (n: number, extra: Partial<WorkerHookRequest> = {}, run: Partial<WorkerHookRun> = {}) =>
		evaluateWorkerHookRequest(
			{
				requestId: `r${n}`,
				hookId: declared.id,
				point: "before_tool",
				tool: "read",
				args: { path: "a.txt" },
				...extra,
			},
			hooks.workerEvaluators.get(declared.id),
			declared,
			{ runId: "run-1", sessionId: "session-1", ...run },
			() => {},
		);
	return { hooks, receipts, ask, dir: realpathSync(env.dir), workspace: realpathSync(workspace) };
}

test("nine concurrent worker hook calls all wait for the runtime and none is scored as a failure", async (t) => {
	// The executor refuses past the runtime's request cap, as runtime-process-v2 does.
	let inFlight = 0;
	const { receipts, ask } = await workerGate(t, async () => {
		if (inFlight >= RUNTIME_V2_LIMITS.concurrentRequests) return { kind: "error", message: "runtime is busy" };
		inFlight += 1;
		await new Promise((resolve) => setImmediate(resolve));
		inFlight -= 1;
		return { kind: "ok", effects: [] };
	});
	const answers = await Promise.all(Array.from({ length: RUNTIME_V2_LIMITS.concurrentRequests + 1 }, (_, n) => ask(n)));
	deepStrictEqual(
		answers,
		Array.from({ length: answers.length }, () => []),
	);
	deepStrictEqual(
		receipts.map((receipt) => receipt.outcome),
		answers.map(() => "runtime-ok"),
	);
});

test("a worker's missed deadlines never disable the session's own hook", async (t) => {
	let timeouts = 3;
	const { hooks, receipts, ask } = await workerGate(t, async () => {
		if (timeouts > 0) {
			timeouts -= 1;
			return { kind: "timeout" };
		}
		return { kind: "ok", effects: [] };
	});
	for (let n = 0; n < 3; n += 1) strictEqual((await ask(n))[0]?.kind, "block_tool");
	const [registration] = hooks.registrations;
	deepStrictEqual(await registration?.evaluateAsync?.({ hook: "before_tool", toolName: "read", toolArgs: {} }), []);
	strictEqual(receipts.at(-1)?.outcome, "runtime-ok");
});

test("a worktree worker's landing reads as the checkout path it stands for", async (t) => {
	const events: ExtensionHookEvent[] = [];
	const { ask, dir, workspace } = await workerGate(t, async (_id, event) => {
		events.push(event);
		return { kind: "ok", effects: [] };
	});
	// One worktree under the checkout, one under a separate worktree root such as a tmpfs.
	for (const worktree of [path.join(workspace, ".clio-coder", "worktrees", "run-1"), path.join(dir, "tmpfs", "run-1")]) {
		const landed = path.join(worktree, "src", "a.txt");
		await ask(
			0,
			{ workspaceRoot: worktree, landing: { path: { arg: "path", path: landed, resolved: true } } },
			{ sourceRoot: workspace },
		);
	}
	deepStrictEqual(
		events.map((event) => (event.point === "before_tool" ? event.target?.workspacePath : event.point)),
		["src/a.txt", "src/a.txt"],
	);
});

test("a worker hook call still queued at its deadline is answered by its timeout policy", {
	timeout: 10_000,
}, async (t) => {
	const held: Array<() => void> = [];
	const { ask } = await workerGate(t, async () => {
		await new Promise<void>((resolve) => held.push(resolve));
		return { kind: "ok", effects: [] };
	});
	const running = Array.from({ length: Math.max(1, Math.floor(RUNTIME_V2_LIMITS.concurrentRequests / 2)) }, (_, n) =>
		ask(n),
	);
	const queued = await ask(running.length);
	strictEqual(queued[0]?.kind, "block_tool");
	ok(queued[0]?.kind === "block_tool" && /deadline/.test(queued[0].reason));
	strictEqual(held.length, running.length);
	for (const release of held) release();
	await Promise.all(running);
});

test("a worktree worker's protect_path reaches its guard at the worker's own path", async (t) => {
	let checkout = "";
	let worktree = "";
	const { ask, dir, workspace } = await workerGate(t, async () => ({
		kind: "ok",
		effects: [
			{ kind: "protect_path", path: "src/a.txt", reason: "relative" },
			{ kind: "protect_path", path: path.join(checkout, "src", "b.txt"), reason: "absolute" },
			{ kind: "protect_path", path: path.join(dir, "outside.txt"), reason: "outside" },
			{ kind: "protect_path", path: path.join(worktree, "src", "c.txt"), reason: "the worker's own target.path" },
		],
	}));
	checkout = workspace;
	// A worktree beside the checkout, and the default one under it, where a worker path also sits inside the checkout.
	for (const root of [path.join(dir, "tmpfs", "run-1"), path.join(workspace, ".clio-coder", "worktrees", "run-1")]) {
		worktree = root;
		const answer = await ask(0, { workspaceRoot: worktree }, { sourceRoot: workspace });
		deepStrictEqual(
			answer.map((effect) => (effect.kind === "protect_path" ? effect.path : effect.kind)),
			[
				path.join(worktree, "src", "a.txt"),
				path.join(worktree, "src", "b.txt"),
				path.join(dir, "outside.txt"),
				path.join(worktree, "src", "c.txt"),
			],
		);
	}
});
