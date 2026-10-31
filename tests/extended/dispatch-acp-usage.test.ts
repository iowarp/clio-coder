import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { factKnownValue } from "../../src/core/telemetry/known.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { capacityLeaseUsage } from "../../src/domains/dispatch/capacity-lease.js";
import { runUsageFromCallRecords } from "../../src/domains/dispatch/run-call-usage.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { readVerifiedRun } from "../../src/domains/telemetry/index.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { verifyRunRecordReport } from "../../src/interactive/view/artifacts.js";
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
const measured = (value: number) => ({ kind: "measured", value, source: "provider" });
const quantity = (metric: string, fact: unknown) => ({ fact, display: "-", ref: `session:peer#${metric}` });
const pricers = (counts: Partial<Record<"provider" | "target-rates" | "catalog" | "free" | "none", number>>) => ({
	provider: 0,
	"target-rates": 0,
	catalog: 0,
	free: 0,
	none: 0,
	...counts,
});
/** A Clio peer's session block: its quantities as facts and who priced its calls (#434). */
const peerSession = (input: number, output: number, usd: number, pricedBy: ReturnType<typeof pricers>) =>
	meta({
		session: {
			quantities: {
				input: quantity("input", measured(input)),
				output: quantity("output", measured(output)),
				cacheRead: quantity("cacheRead", measured(0)),
				cacheWrite: quantity("cacheWrite", measured(0)),
				reasoning: quantity("reasoning", measured(0)),
				total: quantity("total", measured(input + output)),
				usd: quantity("usd", measured(usd)),
				calls: quantity("calls", measured(3)),
			},
			pricedBy,
		},
	});

for (const scenario of [
	{
		name: "a Clio peer's session facts",
		response: peerSession(140, 10, 0.02, pricers({ "target-rates": 3 })),
		total: 150,
		split: [140, 10, 0, 0, 0],
		cost: 0.02,
		pricedBy: "provider",
	},
	{
		name: "a Clio peer whose every call was free",
		response: peerSession(4, 3, 0, pricers({ free: 3 })),
		total: 7,
		split: [4, 3, 0, 0, 0],
		cost: 0,
		pricedBy: "free",
	},
	{ name: "another agent's components", response: { usage: components }, total: 18, split, cost: 0, pricedBy: "none" },
	{
		name: "explicit total overrides component sum",
		response: { usage: { ...components, total_tokens: 100 } },
		total: 100,
		split,
		cost: 0,
		pricedBy: "none",
	},
	{
		name: "explicit zero total overrides component sum, and its cost names no pricer",
		response: { usage: { ...components, totalTokens: 0, cost: { total: 0 } } },
		total: 0,
		split,
		cost: 0,
		pricedBy: "none",
	},
	{ name: "absent usage stays unknown", response: {}, total: 0, split: zero, cost: 0, pricedBy: "none" },
]) {
	it(`seals ACP usage: ${scenario.name}`, { timeout: 15_000 }, async (t) => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.safety.autonomy = "yolo";
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
			ok(envelope);
			strictEqual(envelope.budget?.effective.mode, "advisory");
			strictEqual(receipt.budget?.enforcement.perTool, "unobserved-not-enforced");
			strictEqual(receipt.budget?.effective.toolCalls, 1000);
			const persisted = readVerifiedRun(clioStateDir(), envelope.id)!;
			strictEqual(persisted.settled.digest, receipt.digest);
			const stateDir = process.env.CLIO_CODER_STATE_DIR;
			ok(stateDir);
			const journal = await readCallJournal(telemetryRunDirectory(stateDir, run.runId));
			const aggregate = journal.records.find(({ record }) => record.k === "run.usage_reported")?.record;
			ok(aggregate?.k === "run.usage_reported");
			strictEqual(aggregate.ctx.sessionId, null);
			const replayed = runUsageFromCallRecords(journal.records.map(({ record }) => record));
			deepStrictEqual(receipt.spend, replayed.facts);
			const integrity = verifyRunRecordReport(stateDir, run.runId);
			ok(integrity.ok, JSON.stringify(integrity));
			const { spend } = receipt;
			const pricing = spend.pricing;
			const facts = {
				tokenCount: factKnownValue(spend.totalTokens),
				split: [
					spend.usage.input,
					spend.usage.output,
					spend.usage.cacheRead,
					spend.usage.cacheWrite,
					spend.usage.reasoning,
				].map(factKnownValue),
				costUsd: factKnownValue(pricing.usd),
				pricedBy: pricing.pricedBy,
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
			if (scenario.name === "a Clio peer's session facts") {
				t.diagnostic(JSON.stringify({ sealedEvidence: { receipt: persisted, envelope } }));
			}
			strictEqual(receipt.outcome, "succeeded");
			deepStrictEqual(facts, {
				tokenCount: scenario.total,
				split: scenario.split,
				costUsd: scenario.cost,
				pricedBy: scenario.pricedBy,
			});
			if (scenario.name === "absent usage stays unknown") {
				// A real ACP reply without usage is still one provider observation, but never a metered call.
				strictEqual(receipt.upstreamResponses?.length, 1);
				strictEqual("usage" in (receipt.upstreamResponses?.[0] ?? {}), false);
			}
			if (scenario.name === "a Clio peer's session facts") {
				deepStrictEqual(spend.apiCalls, { kind: "measured", value: 3, source: "local-count" });
				const { usd } = bundle.contract.snapshot().totals.cost;
				strictEqual(usd.measured + usd.estimated, factKnownValue(pricing.usd));
			}
			deepStrictEqual(envelope.spend, receipt.spend);

			deepStrictEqual(bundle.contract.snapshot().running, []);
			deepStrictEqual(bundle.contract.snapshot().retrying, []);
			strictEqual(capacityLeaseUsage().global, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});
}

it("records no upstream row for a synthetic ACP delegation fault", { timeout: 15_000 }, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.safety.autonomy = "yolo";
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{
			id: "usage-fault",
			command: process.execPath,
			args: ["-e", "process.exit(1)"],
			toolGovernance: "clio-coder-policy",
		},
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "usage-fault",
			task: "Inspect the fixture input.",
			executionRole: "researcher",
			requestOrigin: "internal",
		});
		const receipt = await run.finalPromise;
		ok(receipt.outcome !== "succeeded");
		strictEqual(receipt.upstreamResponses, undefined);
	} finally {
		await bundle.extension.stop?.();
	}
});
