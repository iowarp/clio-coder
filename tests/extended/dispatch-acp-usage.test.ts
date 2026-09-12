import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { capacityLeaseUsage } from "../../src/domains/dispatch/capacity-lease.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { verifyReceiptFileReport } from "../../src/interactive/view/artifacts.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

// A JSON-RPC peer on owned stdio, using the real adapter and finalizer. No model.
const PEER = `
const response = JSON.parse(process.argv[1]);
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\\n");
require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id: request.id, result: {protocolVersion: 1}});
  if (request.method === "session/new") send({id: request.id, result: {sessionId: "usage-fixture"}});
  if (request.method === "session/prompt") {
    send({method: "session/update", params: {sessionId: "usage-fixture", update: {
      sessionUpdate: "agent_message_chunk", content: {type: "text", text: "Fixture inspection complete."}
    }}});
    send({id: request.id, result: {stopReason: "end_turn", ...response}});
  }
});
`;
const components = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 };
const split = [10, 5, 2, 1, 3];
const zero = [0, 0, 0, 0, 0];
const meta = (usage: unknown) => ({ _meta: { "clio-coder/usage": usage } });

for (const scenario of [
	{
		name: "total-only with nested peer cost",
		response: meta({ totalTokens: 123, cost: { total: 0.0123 }, costProvenance: "known" }),
		total: 123,
		split: zero,
		cost: 0.0123,
		provenance: "known",
	},
	{
		name: "Clio metadata costUsd with estimated provenance",
		response: meta({ totalTokens: 123, costUsd: 0.02, costProvenance: "estimated" }),
		total: 123,
		split: zero,
		cost: 0.02,
		provenance: "estimated",
	},
	{
		name: "components seen by both adapter and event meter",
		response: { usage: components },
		total: 18,
		split,
		cost: 0,
		provenance: "unknown",
	},
	{
		name: "explicit total overrides component sum",
		response: { usage: { ...components, total_tokens: 100 } },
		total: 100,
		split,
		cost: 0,
		provenance: "unknown",
	},
	{
		name: "explicit zero total overrides component sum",
		response: { usage: { ...components, totalTokens: 0, cost: { total: 0 }, costProvenance: "known" } },
		total: 0,
		split,
		cost: 0,
		provenance: "known",
	},
	{
		name: "explicit zero metadata overrides event usage",
		response: { ...meta({ totalTokens: 0, costUsd: 0, costProvenance: "known_free" }), usage: components },
		total: 0,
		split: zero,
		cost: 0,
		provenance: "known_free",
	},
	{
		name: "absent metadata usage retains event components",
		response: { ...meta({}), usage: components },
		total: 18,
		split,
		cost: 0,
		provenance: "unknown",
	},
	{
		name: "cost-only metadata retains event components",
		response: { ...meta({ costUsd: 0.03, costProvenance: "known" }), usage: components },
		total: 18,
		split,
		cost: 0.03,
		provenance: "known",
	},
	{ name: "absent usage stays unknown", response: {}, total: 0, split: zero, cost: 0, provenance: "unknown" },
	{
		name: "unsupported provenance remains unknown",
		response: meta({ totalTokens: 7, costUsd: 0.04, costProvenance: "measured" }),
		total: 7,
		split: zero,
		cost: 0.04,
		provenance: "unknown",
	},
	{
		name: "absent cost ignores claimed provenance",
		response: meta({ totalTokens: 7, costProvenance: "known_free" }),
		total: 7,
		split: zero,
		cost: 0,
		provenance: "unknown",
	},
]) {
	it(`seals ACP usage: ${scenario.name}`, { timeout: 15_000 }, async (t) => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.autonomy = "full-auto";
		settings.fleet.retry.maxRetries = 0;
		settings.integrations.externalAgents.entries = [
			{
				id: "usage-fixture",
				command: process.execPath,
				args: ["-e", PEER, JSON.stringify(scenario.response)],
				toolGovernance: "clio-coder-policy",
			},
		];
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
		await bundle.extension.start();
		try {
			const run = await bundle.contract.dispatch({
				agentId: "usage-fixture",
				budget: { toolCalls: 1000, readReserve: 10 },
				task: "Inspect the fixture input.",
				executionRole: "researcher",
				requestOrigin: "internal",
			});
			const receipt = await run.finalPromise;
			const envelope = bundle.contract.getRun(run.runId);
			ok(envelope?.receiptPath);
			strictEqual(envelope.budget?.effective.mode, "advisory");
			strictEqual(receipt.budget?.enforcement.perTool, "unobserved-not-enforced");
			strictEqual(receipt.budget?.effective.toolCalls, 1000);
			const persisted = JSON.parse(readFileSync(envelope.receiptPath, "utf8")) as RunReceipt;
			deepStrictEqual(persisted, receipt);
			const stateDir = process.env.CLIO_CODER_STATE_DIR;
			ok(stateDir);
			const integrity = verifyReceiptFileReport(stateDir, run.runId);
			ok(integrity.ok, JSON.stringify(integrity));
			const facts = {
				tokenCount: receipt.tokenCount,
				split: [
					receipt.inputTokenCount,
					receipt.outputTokenCount,
					receipt.cacheReadTokenCount,
					receipt.cacheWriteTokenCount,
					receipt.reasoningTokenCount,
				],
				costUsd: receipt.costUsd,
				costProvenance: receipt.costProvenance,
			};
			t.diagnostic(
				JSON.stringify({
					scenario: scenario.name,
					response: scenario.response,
					facts,
					outcome: receipt.outcome,
					sealedIntegrity: integrity.ok,
				}),
			);
			if (scenario.name === "total-only with nested peer cost") {
				t.diagnostic(JSON.stringify({ sealedEvidence: { receipt: persisted, envelope } }));
			}
			strictEqual(receipt.outcome, "succeeded");
			deepStrictEqual(facts, {
				tokenCount: scenario.total,
				split: scenario.split,
				costUsd: scenario.cost,
				costProvenance: scenario.provenance,
			});
			strictEqual(envelope.tokenCount, receipt.tokenCount);
			strictEqual(envelope.costUsd, receipt.costUsd);
			strictEqual(envelope.costProvenance, receipt.costProvenance);
			strictEqual(verifyReceiptIntegrity({ ...receipt, tokenCount: receipt.tokenCount + 1 }, envelope).ok, false);
			strictEqual(verifyReceiptIntegrity({ ...receipt, costUsd: receipt.costUsd + 1 }, envelope).ok, false);
			deepStrictEqual(bundle.contract.snapshot().running, []);
			deepStrictEqual(bundle.contract.snapshot().retrying, []);
			strictEqual(capacityLeaseUsage().global, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});
}
