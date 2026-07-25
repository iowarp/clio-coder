import { deepStrictEqual, doesNotThrow, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { parseScoutSplitRecommendation } from "../../src/tools/scout-split-recommendation.js";

const ONE_SUBTASK = [
	"SPLIT RECOMMENDATION: The request spans independent domains",
	"- Inspect src/tools/dispatch.ts:576 and report the details seam",
].join("\n");

function fourSubtasks(): string {
	return [
		"SPLIT RECOMMENDATION: Four independent surfaces need focused inspection",
		"- Inspect src/tools/dispatch.ts:576",
		"- Inspect src/domains/agents/builtins/scout.md:18",
		"- Inspect tests/contracts/tools.test.ts:1675",
		"- Inspect tests/contracts/agents.test.ts:255",
	].join("\n");
}

interface LaunchCounts {
	dispatch: number;
	dispatchBatch: number;
}

function receiptEnvelope(draft: RunReceiptDraft): RunEnvelope {
	return {
		id: draft.runId,
		agentId: draft.agentId,
		task: draft.task,
		targetId: draft.targetId,
		wireModelId: draft.wireModelId,
		runtimeId: draft.runtimeId,
		runtimeKind: draft.runtimeKind,
		startedAt: draft.startedAt,
		endedAt: draft.endedAt,
		status: "completed",
		outcome: draft.outcome,
		exitCode: draft.exitCode,
		pid: null,
		heartbeatAt: null,
		receiptPath: `/tmp/${draft.runId}.json`,
		sessionId: draft.sessionId,
		cwd: "/tmp",
		tokenCount: draft.tokenCount,
		costUsd: draft.costUsd,
	};
}

function assistantEvents(text: string): AsyncIterableIterator<unknown> {
	return (async function* () {
		yield { type: "message_end", message: { role: "assistant", content: text } };
	})();
}

function toolForAnswer(answer: string, runId = "run-scout") {
	const counts: LaunchCounts = { dispatch: 0, dispatchBatch: 0 };
	let envelope: RunEnvelope | null = null;
	const dispatch: DispatchContract = {
		dispatch: async (request: DispatchRequest) => {
			counts.dispatch += 1;
			const verification =
				request.agentId === "scout"
					? ({ state: "not_applicable", basis: "read-only-agent" } as const)
					: ({ state: "verified", basis: "validation-tool" } as const);
			const draft: RunReceiptDraft = {
				costProvenance: "unknown",
				outcome: "succeeded",
				runId,
				agentId: request.agentId,
				task: request.task,
				targetId: "target",
				wireModelId: "model",
				runtimeId: "runtime",
				runtimeKind: "http",
				startedAt: "",
				endedAt: "",
				exitCode: 0,
				tokenCount: 0,
				costUsd: 0,
				compiledPromptHash: null,
				staticCompositionHash: null,
				clioVersion: "0.0.0",
				piMonoVersion: "0.0.0",
				platform: "",
				nodeVersion: "",
				toolCalls: 0,
				toolStats: [],
				sessionId: null,
				verification,
				output: {
					state: "final",
					text: answer,
					bytes: Buffer.byteLength(answer, "utf8"),
					truncated: false,
				},
			};
			envelope = receiptEnvelope(draft);
			return {
				runId,
				events: assistantEvents(answer),
				finalPromise: Promise.resolve(withReceiptIntegrity(draft, envelope)),
			};
		},
		dispatchBatch: async () => {
			counts.dispatchBatch += 1;
			throw new Error("dispatchBatch must not be called for one Scout task");
		},
		listRuns: () => [],
		getRun: (id: string) => (id === runId ? envelope : null),
		abort: () => {},
		steer: () => {},
		snapshot: () => ({
			generatedAt: new Date(0).toISOString(),
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		drain: async () => {},
	};
	return { tool: createDispatchTool({ dispatch }), counts };
}

describe("contracts/Scout split recommendation parser", () => {
	it("accepts valid one- and four-subtask recommendations at the head", () => {
		deepStrictEqual(parseScoutSplitRecommendation(ONE_SUBTASK), {
			rationale: "The request spans independent domains",
			subtasks: ["Inspect src/tools/dispatch.ts:576 and report the details seam"],
		});
		deepStrictEqual(parseScoutSplitRecommendation(fourSubtasks()), {
			rationale: "Four independent surfaces need focused inspection",
			subtasks: [
				"Inspect src/tools/dispatch.ts:576",
				"Inspect src/domains/agents/builtins/scout.md:18",
				"Inspect tests/contracts/tools.test.ts:1675",
				"Inspect tests/contracts/agents.test.ts:255",
			],
		});

		const exactUtf8Bounds = [`SPLIT RECOMMENDATION: ${"é".repeat(100)}`, `- ${"é".repeat(60)}`].join("\n");
		deepStrictEqual(parseScoutSplitRecommendation(exactUtf8Bounds), {
			rationale: "é".repeat(100),
			subtasks: ["é".repeat(60)],
		});
	});

	it("ignores a marker after byte 800, a mid-prose marker, and ordinary prose", () => {
		strictEqual(parseScoutSplitRecommendation(`${"\n".repeat(800)}${ONE_SUBTASK}`), null);
		strictEqual(parseScoutSplitRecommendation(`Scout mapped the first domain.\n\n${ONE_SUBTASK}`), null);
		strictEqual(parseScoutSplitRecommendation("Scout mapped the dispatcher and found two likely call sites."), null);
	});

	it("fails closed for malformed, incomplete, truncated, zero-task, and over-four envelopes", () => {
		const invalid = [
			"SPLIT RECOMMENDATION missing colon\n- Inspect src/tools/dispatch.ts:576",
			"SPLIT RECOMMENDATION: no tasks follow",
			"SPLIT RECOMMENDATION: truncated task follows\n-",
			"SPLIT RECOMMENDATION: truncated second task follows\n- Inspect src/tools/dispatch.ts:576\n- ",
			[
				"SPLIT RECOMMENDATION: too many tasks",
				...Array.from({ length: 5 }, (_, index) => `- Inspect src/area-${index + 1}.ts:${index + 1}`),
			].join("\n"),
		];
		doesNotThrow(() => {
			for (const answer of invalid) strictEqual(parseScoutSplitRecommendation(answer), null);
		});
	});

	it("rejects over-length UTF-8 fields and a valid-shape block extending beyond byte 800", () => {
		strictEqual(parseScoutSplitRecommendation(`SPLIT RECOMMENDATION: ${"é".repeat(101)}\n- Inspect src/a.ts:1`), null);
		strictEqual(parseScoutSplitRecommendation(`SPLIT RECOMMENDATION: rationale\n- ${"é".repeat(61)}`), null);

		const maximalBlock = [
			`SPLIT RECOMMENDATION: ${"r".repeat(200)}`,
			...Array.from({ length: 4 }, () => `- ${"t".repeat(120)}`),
		].join("\n");
		ok(Buffer.byteLength(maximalBlock, "utf8") < 800);
		strictEqual(parseScoutSplitRecommendation(`${"\n".repeat(100)}${maximalBlock}`), null);
	});
});

describe("contracts/dispatch Scout split recommendation promotion", () => {
	it("promotes one valid Scout recommendation without changing output, A2 details, or launch count", async () => {
		const { tool, counts } = toolForAnswer(ONE_SUBTASK);
		const result = await tool.run({ task: "map independent domains", agent_id: "scout" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;

		strictEqual(
			result.output,
			[
				"dispatch (parallel) total=1 failed=0",
				"runs=run-scout",
				"",
				"- run-scout agent=scout exit=0 target=target model=model tokens=0 receipt=/tmp/run-scout.json receipt_integrity=verified/v6/sha256 evidence_verification=not_applicable/read-only-agent briefing=none project_context=absent",
				"  reconnaissance output (advisory leads, not validation evidence):",
				"  SPLIT RECOMMENDATION: The request spans independent domains",
				"  - Inspect src/tools/dispatch.ts:576 and report the details seam",
			].join("\n"),
		);
		const details = result.details as {
			splitRecommendation?: unknown;
			runs?: Array<{ verification?: unknown; receiptIntegrity?: unknown; splitRecommendation?: unknown }>;
		};
		deepStrictEqual(details.splitRecommendation, {
			rationale: "The request spans independent domains",
			subtasks: ["Inspect src/tools/dispatch.ts:576 and report the details seam"],
		});
		deepStrictEqual(details.runs?.[0]?.verification, { state: "not_applicable", basis: "read-only-agent" });
		deepStrictEqual(details.runs?.[0]?.receiptIntegrity, { ok: true });
		strictEqual(details.runs?.[0]?.splitRecommendation, undefined);
		deepStrictEqual(counts, { dispatch: 1, dispatchBatch: 0 });
	});

	it("promotes the head block from an answer beyond the 8192-byte output bound", async () => {
		const answer = `${ONE_SUBTASK}\n\n${"tail".repeat(2_400)}`;
		ok(Buffer.byteLength(answer, "utf8") > 8192);
		const { tool, counts } = toolForAnswer(answer, "run-long-scout");
		const result = await tool.run({ task: "map a broad repository", agent_id: "scout", max_output_bytes: 8192 });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes("[agent output truncated]"), result.output);
		deepStrictEqual((result.details as { splitRecommendation?: unknown }).splitRecommendation, {
			rationale: "The request spans independent domains",
			subtasks: ["Inspect src/tools/dispatch.ts:576 and report the details seam"],
		});
		deepStrictEqual(counts, { dispatch: 1, dispatchBatch: 0 });
	});

	it("enforces head and field byte bounds against the raw event text before display trimming", async () => {
		const afterHeadWindow = toolForAnswer(`${"\n".repeat(801)}${ONE_SUBTASK}`, "run-late-marker");
		const lateResult = await afterHeadWindow.tool.run({ task: "map a broad repository", agent_id: "scout" });
		strictEqual(lateResult.kind, "ok");
		if (lateResult.kind === "ok") {
			strictEqual("splitRecommendation" in (lateResult.details ?? {}), false);
			// Existing human-facing output stays normalized exactly as before A3.
			ok(lateResult.output.includes(`  ${ONE_SUBTASK.split("\n")[0]}`), lateResult.output);
		}
		deepStrictEqual(afterHeadWindow.counts, { dispatch: 1, dispatchBatch: 0 });

		const rawOverLength = `SPLIT RECOMMENDATION: raw trailing space must count\n- ${"t".repeat(120)} `;
		const overLength = toolForAnswer(rawOverLength, "run-raw-over-length");
		const overLengthResult = await overLength.tool.run({ task: "map a broad repository", agent_id: "scout" });
		strictEqual(overLengthResult.kind, "ok");
		if (overLengthResult.kind === "ok") {
			strictEqual("splitRecommendation" in (overLengthResult.details ?? {}), false);
		}
		deepStrictEqual(overLength.counts, { dispatch: 1, dispatchBatch: 0 });
	});

	it("does not promote the same protocol-shaped prose from a non-Scout worker", async () => {
		const { tool, counts } = toolForAnswer(ONE_SUBTASK, "run-coder");
		const result = await tool.run({ task: "inspect dispatch", agent_id: "coder" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual("splitRecommendation" in (result.details ?? {}), false);
		deepStrictEqual(counts, { dispatch: 1, dispatchBatch: 0 });
	});

	it("keeps malformed Scout protocol advisory instead of failing the dispatch", async () => {
		const malformed = "SPLIT RECOMMENDATION: partial envelope\n- ";
		const { tool, counts } = toolForAnswer(malformed, "run-malformed-scout");
		const result = await tool.run({ task: "map a broad repository", agent_id: "scout" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual("splitRecommendation" in (result.details ?? {}), false);
		deepStrictEqual(counts, { dispatch: 1, dispatchBatch: 0 });
	});
});
