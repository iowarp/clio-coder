import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resultContractRepairMessages } from "../../src/domains/agents/result-contract.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const REQUEST: DispatchRequest = {
	agentId: "scout",
	executionRole: "explorer",
	task: "Inspect isolated fixture evidence.",
	requestOrigin: "internal",
	resultContractOverride: { kind: "provenance-report" },
};

const REASON =
	"result contract failed after 2 bounded repair rounds: finding 1 cites src/a.ts:40 but no read covered that line";

async function exhaustedRun(detail: unknown, calls: ReadonlyArray<unknown> = []) {
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
					for (const message of calls) yield { type: "message_end", message };
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

	it("counts only calls that reached a provider and records how each one ended", async () => {
		const origin = { provider: "openai", api: "openai-completions", model: "gpt-4o" };
		const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 };
		const answered = {
			role: "assistant",
			content: [{ type: "text", text: "{}" }],
			stopReason: "stop",
			usage,
			responseId: "resp-1",
			// The stream echoed the requested id, which is no difference to record.
			responseModel: "gpt-4o",
			...origin,
		};
		const [repair] = resultContractRepairMessages(
			{ contract: { kind: "provenance-report" }, reason: REASON, attempt: 1, anchors: [] },
			origin,
		);
		const failed = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "provider closed the stream before the first chunk",
			usage: { ...usage, input: 0, output: 0, totalTokens: 0 },
			responseModel: "gpt-4o-2024-08-06",
			...origin,
		};
		const receipt = await exhaustedRun(REASON, [answered, repair, failed]);
		const rows = receipt.upstreamResponses ?? [];
		strictEqual(rows.length, 2, JSON.stringify(rows));
		strictEqual(rows[0]?.providerResponseId, "resp-1");
		strictEqual(rows[0]?.differingResponseModelId, null);
		strictEqual(rows[1]?.differingResponseModelId, "gpt-4o-2024-08-06");
		strictEqual(rows[0]?.stopReason, "stop");
		strictEqual(rows[1]?.providerResponseId, null);
		strictEqual(rows[1]?.stopReason, "error");
		strictEqual(rows[1]?.errorMessage, "provider closed the stream before the first chunk");
	});

	it("judges the report a capped worker replies with and names the files it left", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-coder-refusal-cap-"));
		execFileSync("git", ["init", "-q", cwd]);
		const cap = "permission refusal limit reached: the worker ended after 3 refused commands with no approval route";
		const report = {
			role: "assistant",
			content: [{ type: "text", text: "Nothing to report." }],
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
		};
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			heartbeatIntervalMs: 3_600_000,
			spawnWorker: () => ({
				pid: null,
				promise: Promise.resolve({ exitCode: 3, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: performance.now() },
				abort: () => {},
				send: () => true,
				events: (async function* () {
					writeFileSync(join(cwd, "verify_slug_edge.py"), "print(1)\n");
					yield {
						type: "clio_coder_permission_resolved",
						payload: { tool: "bash", actionClass: "execute", mode: "deny", source: "policy", reason: cap },
					};
					yield { type: "message_end", message: report };
				})(),
			}),
		});
		await bundle.extension.start();
		try {
			const receipt = await (await bundle.contract.dispatch({ ...REQUEST, cwd })).finalPromise;
			strictEqual(receipt.outcome, "failed", "a report does not lift the cap");
			ok(receipt.outcomeDetail?.startsWith(`permission_required; ${cap}`), receipt.outcomeDetail ?? "");
			strictEqual(receipt.quality.resultContract?.conformance, "fail", "the prose report is judged, not left unreached");
			match(receipt.outcomeDetail ?? "", /untracked files this run left in the checkout: verify_slug_edge\.py$/u);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
