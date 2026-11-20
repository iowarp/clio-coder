import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import type { SpawnedWorker, SpawnedWorkerResult, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const REQUEST: DispatchRequest = {
	agentId: "scout",
	executionRole: "researcher",
	task: "Inspect isolated fixture evidence.",
	requestOrigin: "internal",
	resultContractOverride: { kind: "provenance-report" },
};

const HTTP_503 = "HTTP 503 Service Unavailable";
const OVERFLOW =
	"[worker] provider error: exceed_context_size_error: request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it";

/**
 * A bundle whose workers finish at once: `failure` (a 503 by default) on any
 * target in `failing`, success elsewhere. `spawned` lists the target each
 * worker ran on. `windows` sets each target's context window.
 */
async function retryFleet(
	targetIds: ReadonlyArray<string>,
	failing: ReadonlySet<string>,
	vision: ReadonlySet<string>,
	options: {
		failure?: string;
		windows?: Readonly<Record<string, number>>;
		maxRetries?: number;
		report?: object;
		models?: ReadonlyArray<string>;
		onSpawn?: (spec: WorkerSpec) => void;
	} = {},
) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.sandbox = "off";
	settings.targets = targetIds.map((id) => ({
		id,
		runtime: "openai",
		defaultModel: "gpt-4o",
		...(options.models !== undefined ? { wireModels: [...options.models] } : {}),
	}));
	settings.fleet.default.target = "default";
	settings.fleet.default.model = "gpt-4o";
	settings.fleet.retry.maxRetries = options.maxRetries ?? 1;
	const context = dispatchStubContext({ settings });
	const providers = context.getContract("providers");
	for (const status of providers?.list() ?? []) {
		status.capabilities.vision = vision.has(status.target.id);
		const window = options.windows?.[status.target.id];
		if (window !== undefined) status.capabilities.contextWindow = window;
	}
	const spawned: string[] = [];
	const bundle = makeDispatchBundle(context, {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: (spec) => {
			spawned.push(spec.target.id);
			options.onSpawn?.(spec);
			const result: SpawnedWorkerResult = failing.has(spec.target.id)
				? { exitCode: 1, signal: null, stderrTail: options.failure ?? HTTP_503 }
				: { exitCode: 0, signal: null };
			const worker: SpawnedWorker = {
				pid: null,
				promise: Promise.resolve(result),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					if (result.exitCode === 0)
						yield {
							type: "message_end",
							message: {
								role: "assistant",
								stopReason: "stop",
								content: JSON.stringify(options.report ?? { confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
							},
						};
				})(),
			};
			return worker;
		},
	});
	await bundle.extension.start();
	const waitForSpawns = async (count: number): Promise<void> => {
		for (let i = 0; i < 200 && spawned.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 25));
		// Let the last attempt settle before the bundle stops.
		await new Promise((resolve) => setTimeout(resolve, 50));
	};
	return { bundle, spawned, waitForSpawns };
}

describe("retry target selection", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-retry-target-");
	});
	afterEach(() => scratch.restore());

	it("skips an alternate target that lacks a required capability", async () => {
		const fleet = await retryFleet(["default", "plain", "seeing"], new Set(["default"]), new Set(["default", "seeing"]));
		try {
			const first = await fleet.bundle.contract.dispatch({
				...REQUEST,
				cwd: scratch.dir,
				requiredCapabilities: ["vision"],
			});
			await first.finalPromise;
			await fleet.waitForSpawns(2);
			deepStrictEqual(fleet.spawned, ["default", "seeing"]);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("skips an alternate target whose breaker is open", async () => {
		const fleet = await retryFleet(["default", "sick", "good"], new Set(["default", "sick"]), new Set());
		try {
			// A pinned run trips the breaker on sick; its exact retry stays on sick.
			const pinned = await fleet.bundle.contract.dispatch({ ...REQUEST, cwd: scratch.dir, target: "sick" });
			await pinned.finalPromise;
			await fleet.waitForSpawns(2);
			const first = await fleet.bundle.contract.dispatch({ ...REQUEST, cwd: scratch.dir });
			await first.finalPromise;
			await fleet.waitForSpawns(4);
			deepStrictEqual(fleet.spawned, ["sick", "sick", "default", "good"]);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("keeps automatic failover for the retry after one that moved the target", async () => {
		const fleet = await retryFleet(["default", "second", "third"], new Set(["default", "second"]), new Set(), {
			maxRetries: 2,
		});
		try {
			const first = await fleet.bundle.contract.dispatch({ ...REQUEST, cwd: scratch.dir });
			await fleet.bundle.contract.assignments?.get(first.runId)?.terminal;
			deepStrictEqual(fleet.spawned, ["default", "second", "third"]);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("does not rerun the model that left its obligation unmet when no other model is eligible (ruling 5)", async () => {
		// Two targets serving one model: another target is not another model.
		const fleet = await retryFleet(["default", "other"], new Set(), new Set());
		try {
			const scope = declaredScopeIntent({ readRoots: ["src/"] });
			ok(scope.ok);
			const settle = async (request: Partial<DispatchRequest>) => {
				const first = await fleet.bundle.contract.dispatch({
					...REQUEST,
					cwd: scratch.dir,
					intent: scope.intent,
					...request,
				});
				await fleet.bundle.contract.assignments?.get(first.runId)?.terminal;
				return fleet.bundle.contract.assignments?.get(first.runId);
			};
			const pinned = await settle({ target: "default" });
			deepStrictEqual(fleet.spawned, ["default"]);
			strictEqual(pinned?.status, "failed");
			match(pinned?.outcomeDetail ?? "", /^obligation observed-evidence unmet, not retried because failover is none/u);
			const automatic = await settle({});
			deepStrictEqual(fleet.spawned, ["default", "default"], "one attempt, no second spawn");
			strictEqual(automatic?.status, "failed");
			strictEqual(
				automatic?.outcomeDetail,
				"obligation observed-evidence unmet, not retried because no other eligible model can take it, and default/gpt-4o left it unmet",
			);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("retries an idle builder's unmet obligation on another model in its kept task worktree", async () => {
		const repo = join(scratch.dir, "repo");
		mkdirSync(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
		git("init", "-q");
		git("config", "user.name", "Contract");
		git("config", "user.email", "contract@example.invalid");
		writeFileSync(join(repo, "base.txt"), "base");
		git("add", ".");
		git("commit", "-qm", "base");
		const trees: Array<{ path: string | undefined; present: boolean; model: string }> = [];
		const fleet = await retryFleet(["default"], new Set(), new Set(), {
			report: { mutatedPaths: [], validations: [], summary: "nothing to change" },
			models: ["gpt-4o-mini"],
			onSpawn: (spec) => {
				const path = spec.taskWorktree?.path;
				trees.push({ path, present: path !== undefined && existsSync(path), model: spec.wireModelId });
			},
		});
		try {
			const first = await fleet.bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "Fix base.txt.",
				requestOrigin: "internal",
				cwd: repo,
				worktree: true,
			});
			await fleet.bundle.contract.assignments?.get(first.runId)?.terminal;
			strictEqual(trees.length, 2, "the unmet obligation retries once");
			ok(trees[0]?.path !== undefined);
			deepStrictEqual(
				trees.map((tree) => tree.model),
				["gpt-4o", "gpt-4o-mini"],
				"the retry runs on the other model",
			);
			deepStrictEqual(
				trees[1],
				{ path: trees[0]?.path, present: true, model: "gpt-4o-mini" },
				"the retry runs in the kept worktree",
			);
			strictEqual(existsSync(trees[0].path), false, "the idle worktree goes once no retry remains");
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});
});

describe("context overflow retry", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-overflow-retry-");
	});
	afterEach(() => scratch.restore());

	async function settle(fleet: Awaited<ReturnType<typeof retryFleet>>, request: DispatchRequest) {
		const first = await fleet.bundle.contract.dispatch({ ...request, cwd: scratch.dir });
		await fleet.bundle.contract.assignments?.get(first.runId)?.terminal;
		return fleet.bundle.contract.assignments?.get(first.runId) ?? null;
	}

	it("retries once onto the first eligible route with a strictly larger window", async () => {
		const fleet = await retryFleet(["default", "small", "same", "big"], new Set(["default"]), new Set(), {
			failure: OVERFLOW,
			windows: { default: 8192, small: 4096, same: 8192, big: 32768 },
		});
		try {
			const assignment = await settle(fleet, REQUEST);
			deepStrictEqual(fleet.spawned, ["default", "big"]);
			strictEqual(assignment?.status, "succeeded");
			deepStrictEqual(
				assignment?.attempts.map((attempt) => attempt.retryReason),
				[null, "context-overflow: 8192 -> 32768 on big/gpt-4o"],
			);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("stays terminal with a detail when no route has a larger window", async () => {
		const fleet = await retryFleet(["default", "small"], new Set(["default"]), new Set(), {
			failure: OVERFLOW,
			windows: { default: 8192, small: 8192 },
		});
		try {
			const assignment = await settle(fleet, REQUEST);
			deepStrictEqual(fleet.spawned, ["default"]);
			strictEqual(assignment?.status, "failed");
			strictEqual(
				assignment?.outcomeDetail,
				"context overflow not retried because no eligible route has a context window larger than 8192 on default/gpt-4o",
			);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("does not retry an overflow retry that overflows again", async () => {
		const fleet = await retryFleet(["default", "mid", "big"], new Set(["default", "mid"]), new Set(), {
			failure: OVERFLOW,
			windows: { default: 8192, mid: 16384, big: 32768 },
			maxRetries: 3,
		});
		try {
			const assignment = await settle(fleet, REQUEST);
			deepStrictEqual(fleet.spawned, ["default", "mid"]);
			strictEqual(assignment?.status, "failed");
			strictEqual(
				assignment?.outcomeDetail,
				"context overflow not retried again because this attempt was already an overflow retry",
			);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("does not retry under failover none", async () => {
		const fleet = await retryFleet(["default", "big"], new Set(["default"]), new Set(), {
			failure: OVERFLOW,
			windows: { default: 8192, big: 32768 },
		});
		try {
			const assignment = await settle(fleet, { ...REQUEST, target: "default" });
			deepStrictEqual(fleet.spawned, ["default"]);
			strictEqual(assignment?.status, "failed");
			strictEqual(
				assignment?.outcomeDetail,
				"context overflow not retried because failover is none, which pins the route",
			);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});
});
