import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import type { SpawnedWorker, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { resolveWriteRootRequest } from "../../src/domains/dispatch/write-root-requests.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const ASK = { scope: "the fix needs a regression test", reason: "write-root", paths: ["tests/a.test.ts"] };

/** A coder whose first attempt asks for `tests/a.test.ts` and changes nothing; later attempts finish clean. */
function writeRootFleet() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.sandbox = "off";
	const context = dispatchStubContext({ settings });
	const specs: WorkerSpec[] = [];
	const bundle = makeDispatchBundle(context, {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: (spec) => {
			specs.push(spec);
			const asking = specs.length === 1;
			const worker: SpawnedWorker = {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					if (asking) {
						yield { type: "tool_execution_start", toolCallId: "c1", toolName: "limitation", args: ASK };
						yield {
							type: "tool_execution_end",
							toolCallId: "c1",
							toolName: "limitation",
							isError: false,
							result: { content: [{ type: "text", text: "limitation recorded" }] },
						};
					}
					yield {
						type: "message_end",
						message: {
							role: "assistant",
							stopReason: "stop",
							content: JSON.stringify({
								mutatedPaths: [],
								validations: [],
								summary: asking ? "stopped: tests/a.test.ts is outside my write roots" : "nothing left to change",
							}),
						},
					};
				})(),
			};
			return worker;
		},
	});
	return { bundle, specs };
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("a worker's request for wider write roots", () => {
	let scratch: IsolatedClioEnv;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-write-root-request-");
	});
	afterEach(() => scratch.restore());

	function coderRequest(routable: boolean): DispatchRequest {
		const scope = declaredScopeIntent({ writeRoots: ["src/"] });
		ok(scope.ok);
		return {
			agentId: "coder",
			executionRole: "builder",
			task: "Fix the parser in src/parse.ts.",
			cwd: scratch.dir,
			intent: scope.intent,
			...(routable ? { ownerSessionId: "s1", mainGrantRoute: { kind: "yield" as const } } : {}),
		};
	}

	it("parks for the main agent and, approved, continues the same assignment with the wider roots", async () => {
		const fleet = writeRootFleet();
		await fleet.bundle.extension.start();
		try {
			const grants = fleet.bundle.contract.grants;
			ok(grants !== undefined);
			const announced: string[] = [];
			const unsubscribe = grants.onPending((view) => announced.push(view.tool));
			const first = await fleet.bundle.contract.dispatch(coderRequest(true));
			await waitFor(() => grants.list({ pendingOnly: true }).length > 0);
			unsubscribe();
			deepStrictEqual(announced, ["write_roots"], "a parked request is pushed, not only listed");
			const [pending] = grants.list({ pendingOnly: true });
			strictEqual(pending?.tool, "write_roots");
			strictEqual(pending?.approvalAuthority, "main");
			match(pending?.summary ?? "", /tests\/a\.test\.ts/u);
			strictEqual(fleet.bundle.contract.assignments?.get(first.runId)?.status, "running");

			const outcome = await grants.decideAsMain({
				requestId: pending.requestId,
				runId: pending.runId,
				decision: "approve",
				sessionId: "s1",
				autonomy: "yolo",
			});
			ok(outcome.ok, outcome.message);
			await fleet.bundle.contract.assignments?.get(first.runId)?.terminal;
			strictEqual(fleet.specs.length, 2);
			ok(fleet.specs[1]?.writeRoots?.includes(join(scratch.dir, "tests/a.test.ts")), "the new attempt may write the path");
			match(JSON.stringify(fleet.specs[1]), /widened your write roots to include tests\/a\.test\.ts/u);
			const assignment = fleet.bundle.contract.assignments?.get(first.runId);
			strictEqual(assignment?.attempts.length, 2);
			match(assignment?.attempts[1]?.retryReason ?? "", /write roots widened to tests\/a\.test\.ts/u);
			strictEqual(grants.get(pending.requestId)?.state, "completed");
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("settles the assignment as not done when the request is denied", async () => {
		const fleet = writeRootFleet();
		await fleet.bundle.extension.start();
		try {
			const grants = fleet.bundle.contract.grants;
			ok(grants !== undefined);
			const first = await fleet.bundle.contract.dispatch(coderRequest(true));
			await waitFor(() => grants.list({ pendingOnly: true }).length > 0);
			const [pending] = grants.list({ pendingOnly: true });
			ok(pending !== undefined);
			await grants.decideAsMain({
				requestId: pending.requestId,
				runId: pending.runId,
				decision: "deny",
				sessionId: "s1",
				autonomy: "yolo",
			});
			await fleet.bundle.contract.assignments?.get(first.runId)?.terminal;
			const assignment = fleet.bundle.contract.assignments?.get(first.runId);
			strictEqual(assignment?.status, "failed");
			match(assignment?.outcomeDetail ?? "", /write roots tests\/a\.test\.ts was denied by the main agent/u);
			strictEqual(fleet.specs.length, 1);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("cancels a parked request and its assignment when the session drains", async () => {
		const fleet = writeRootFleet();
		await fleet.bundle.extension.start();
		try {
			const grants = fleet.bundle.contract.grants;
			ok(grants !== undefined);
			const first = await fleet.bundle.contract.dispatch(coderRequest(true));
			await waitFor(() => grants.list({ pendingOnly: true }).length > 0);
			const [pending] = grants.list({ pendingOnly: true });
			ok(pending !== undefined);
			await fleet.bundle.contract.drain();
			await fleet.bundle.contract.assignments?.get(first.runId)?.terminal;
			strictEqual(grants.get(pending.requestId)?.state, "canceled");
			strictEqual(fleet.bundle.contract.assignments?.get(first.runId)?.status, "canceled");
			strictEqual(fleet.specs.length, 1);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});

	it("names the re-dispatch when nobody can answer the request", async () => {
		const fleet = writeRootFleet();
		await fleet.bundle.extension.start();
		try {
			const first = await fleet.bundle.contract.dispatch(coderRequest(false));
			const receipt = await first.finalPromise;
			strictEqual(receipt.outcomeCode, "worker_no_work");
			match(receipt.outcomeDetail ?? "", /re-dispatch with intent\.write_roots including tests\/a\.test\.ts/u);
			strictEqual(fleet.bundle.contract.grants?.list({ pendingOnly: true }).length, 0);
		} finally {
			await fleet.bundle.extension.stop?.();
		}
	});
});

describe("resolveWriteRootRequest", () => {
	const scope = declaredScopeIntent({ writeRoots: ["src/"] });
	ok(scope.ok);
	const req = { cwd: "/repo", intent: scope.intent, task: "t" };

	it("keeps uncovered paths inside the run cwd and refuses the rest", () => {
		deepStrictEqual(resolveWriteRootRequest(req, { scope: "s", paths: ["/repo/tests/a.ts", "src/b.ts"] }), {
			ok: true,
			request: { scope: "s", paths: ["tests/a.ts"] },
		});
		const outside = resolveWriteRootRequest(req, { scope: "s", paths: ["../other/x.ts"] });
		ok(!outside.ok && /cannot be a write root/u.test(outside.reason));
		const covered = resolveWriteRootRequest(req, { scope: "s", paths: ["src/b.ts"] });
		ok(!covered.ok && /already cover/u.test(covered.reason));
		const unscoped = resolveWriteRootRequest({ cwd: "/repo", task: "t" }, { scope: "s", paths: ["tests/a.ts"] });
		ok(!unscoped.ok && /nothing to widen/u.test(unscoped.reason));
	});
});
