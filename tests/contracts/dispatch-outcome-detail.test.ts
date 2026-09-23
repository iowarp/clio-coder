import { match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const REQUEST: DispatchRequest = {
	agentId: "scout",
	executionRole: "researcher",
	task: "Inspect isolated fixture evidence.",
	requestOrigin: "internal",
	resultContractOverride: { kind: "provenance-report" },
};

const REASON =
	"result contract failed after 2 bounded repair rounds: finding 1 cites src/a.ts:40 but no read covered that line";

async function exhaustedRun(detail: unknown) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: () => {
			const worker: SpawnedWorker = {
				pid: null,
				promise: Promise.resolve({ exitCode: 1, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					yield {
						type: "clio_coder_run_outcome",
						payload: { outcomeCode: "result_contract_exhausted", ...(detail === undefined ? {} : { detail }) },
					};
				})(),
			};
			return worker;
		},
	});
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch(REQUEST);
		return await run.finalPromise;
	} finally {
		await bundle.extension.stop?.();
	}
}

describe("exhausted result contract detail", () => {
	beforeEach(() => isolateDispatchState());
	afterEach(() => restoreDispatchState());

	it("seals the worker's reason in the receipt, not only the exit code", async () => {
		const receipt = await exhaustedRun(REASON);
		strictEqual(receipt.outcome, "failed");
		strictEqual(receipt.outcomeCode, "result_contract_exhausted");
		strictEqual(receipt.outcomeDetail, `exit code 1; ${REASON}`);
		match(receipt.failureMessage ?? "", /no read covered that line/u);
	});

	it("keeps the exit-code detail when the worker gives no reason", async () => {
		const receipt = await exhaustedRun(undefined);
		strictEqual(receipt.outcomeCode, "result_contract_exhausted");
		strictEqual(receipt.outcomeDetail, "exit code 1");
	});

	it("bounds and redacts the reason before it reaches the receipt", async () => {
		const receipt = await exhaustedRun(`${REASON} Authorization: Bearer sk-live-123\n${"x".repeat(5_000)}`);
		const detail = receipt.outcomeDetail ?? "";
		ok(!detail.includes("sk-live-123"), detail.slice(0, 300));
		ok(Buffer.byteLength(detail, "utf8") < 1_200, `detail is ${Buffer.byteLength(detail, "utf8")} bytes`);
		match(detail, /\[diagnostic truncated\]$/u);
	});
});
