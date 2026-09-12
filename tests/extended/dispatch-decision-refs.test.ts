import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { AgentsContract } from "../../src/domains/agents/contract.js";
import { routeValidationProjection } from "../../src/domains/dispatch/active-route-planner.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import { activeDecisionRefs, DECISION_REFS_CAP } from "../../src/domains/session/decision-board.js";
import { type DecisionLedgerEntry, decisionRef } from "../../src/domains/session/entries.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function ledgerEntry(
	interviewId: string,
	decisions: ReadonlyArray<{ key: string; status?: "active" | "superseded" }>,
	origin?: "interview" | "agent",
): DecisionLedgerEntry {
	return {
		kind: "decisionLedger",
		turnId: `${interviewId}-entry`,
		parentTurnId: "turn-1",
		timestamp: "2026-09-05T00:00:00.000Z",
		...(origin ? { origin } : {}),
		interviewId,
		interviewStatus: "complete",
		startedAt: "2026-09-05T00:00:00.000Z",
		endedAt: "2026-09-05T00:00:01.000Z",
		roundCount: origin === "agent" ? 0 : 1,
		decisions: decisions.map(({ key, status }) => ({
			key,
			value: `${key}-value`,
			status: status ?? "active",
			decidedAt: "2026-09-05T00:00:01.000Z",
		})),
	};
}

const BOARD: DecisionLedgerEntry[] = [
	ledgerEntry("agent:b2c3", [{ key: "zeta" }], "agent"),
	ledgerEntry("interview-1", [{ key: "db" }, { key: "old-db", status: "superseded" }]),
	ledgerEntry("agent:a1b2", [{ key: "cache-key-shape" }], "agent"),
];

const EXPECTED_REFS = ["agent:a1b2/cache-key-shape", "agent:b2c3/zeta", "interview-1/db"];

describe("decision refs are sealed from the board", () => {
	it("collects only active decisions, sorted, deduplicated, and capped", () => {
		deepStrictEqual(activeDecisionRefs(BOARD), EXPECTED_REFS);
		deepStrictEqual(activeDecisionRefs([]), []);
		const wide = ledgerEntry(
			"interview-wide",
			Array.from({ length: DECISION_REFS_CAP + 8 }, (_, index) => ({ key: `k-${String(index).padStart(2, "0")}` })),
		);
		const refs = activeDecisionRefs([wide, wide]);
		strictEqual(refs.length, DECISION_REFS_CAP);
		strictEqual(refs[0], decisionRef("interview-wide", "k-00"));
	});

	it("rejects decisionRefs in model-authored job JSON and strips it before validation", () => {
		const rejected = validateJobSpec({ agentId: "coder", task: "do it", decisionRefs: ["interview-1/db"] });
		strictEqual(rejected.ok, false);
		if (!rejected.ok) ok(rejected.errors.includes("unknown key: decisionRefs"), rejected.errors.join("; "));

		const request: DispatchRequest = {
			agentId: "coder",
			task: "do it",
			executionRole: "builder",
			decisionRefs: EXPECTED_REFS,
		} as DispatchRequest;
		const projection = routeValidationProjection(request);
		strictEqual("decisionRefs" in projection.jobSpec, false);
		const validated = validateJobSpec(projection.jobSpec);
		strictEqual(validated.ok, true, validated.ok ? "" : validated.errors.join("; "));
		if (!validated.ok) return;
		deepStrictEqual(projection.restore(validated.spec).decisionRefs, EXPECTED_REFS);
	});

	it("carries the refs from envelope to receipt under integrity coverage", () => {
		const envelope = { ...fixtureEnvelope("run-decisions"), decisionRefs: EXPECTED_REFS };
		// Production receipt drafts copy the field from the lifecycle exactly as
		// they copy personaOverride; the fixture draft mirrors that copy here.
		const receipt = withReceiptIntegrity({ ...fixtureReceiptDraft(envelope), decisionRefs: EXPECTED_REFS }, envelope);
		deepStrictEqual(receipt.decisionRefs, EXPECTED_REFS);
		strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
		const forged = { ...receipt, decisionRefs: ["agent:a1b2/cache-key-shape"] };
		strictEqual(verifyReceiptIntegrity(forged, envelope).ok, false);
		const dropped = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
		strictEqual(verifyReceiptIntegrity({ ...dropped, decisionRefs: EXPECTED_REFS }, envelope).ok, false);
		const bare = withReceiptIntegrity(fixtureReceiptDraft(fixtureEnvelope("run-bare")), fixtureEnvelope("run-bare"));
		strictEqual("decisionRefs" in bare, false);
		strictEqual(verifyReceiptIntegrity(bare, fixtureEnvelope("run-bare")).ok, true);
	});

	describe("at the dispatch tool boundary", () => {
		beforeEach(async () => isolateDispatchState());
		afterEach(() => restoreDispatchState());

		async function captureRequests(
			board: ReadonlyArray<DecisionLedgerEntry>,
			args: Record<string, unknown>,
		): Promise<DispatchRequest[]> {
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.safety.autonomy = "full-auto";
			const context = dispatchStubContext({ settings });
			const bundle = makeDispatchBundle(context, {
				spawnWorker: () => {
					throw new Error("fixture: no worker starts");
				},
			});
			await bundle.extension.start();
			const captured: DispatchRequest[] = [];
			try {
				const tool = createDispatchTool({
					dispatch: {
						...bundle.contract,
						dispatch: async (request) => {
							captured.push(structuredClone(request));
							throw new Error("fixture: captured request");
						},
						dispatchBatch: async (requests) => {
							for (const request of requests) captured.push(structuredClone(request));
							throw new Error("fixture: captured batch");
						},
					},
					getAgentSpecs: () => context.getContract<AgentsContract>("agents")?.listSpecs() ?? [],
					getAutonomy: () => "full-auto",
					getDecisionBoard: () => board,
				});
				const result = await tool.run(args, { toolCallId: "call-1" });
				ok(result.kind === "error", JSON.stringify(result));
				if (result.kind === "error") match(result.message, /fixture: captured/u);
			} finally {
				await bundle.extension.stop?.();
			}
			ok(captured.length > 0, "the runner must have built at least one request");
			return captured;
		}

		it("stamps every built request with the board's active refs", async () => {
			const requests = await captureRequests(BOARD, { agent: "coder", task: "add a test" });
			for (const request of requests) {
				deepStrictEqual(request.decisionRefs, EXPECTED_REFS);
				strictEqual(request.parentToolCallId, "call-1");
			}
		});

		it("leaves the field absent for an empty board even when the model argues for it", async () => {
			const requests = await captureRequests([], {
				agent: "coder",
				task: "add a test",
				decisionRefs: ["interview-1/db"],
			});
			for (const request of requests) strictEqual("decisionRefs" in request, false);
		});
	});
});
