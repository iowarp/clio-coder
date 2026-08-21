import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "../../src/engine/types.js";
import {
	compactReasoningTokens,
	emptyRunTally,
	foldMessageIntoRunTally,
	formatReasoningChip,
	formatReasoningLabel,
	type RunTally,
	reasoningFromSummary,
	reasoningFromTally,
	type TurnSummary,
} from "../../src/interactive/status/index.js";

function tally(overrides: Partial<RunTally> = {}): RunTally {
	return { ...emptyRunTally(), ...overrides };
}

function summary(overrides: Partial<TurnSummary> = {}): TurnSummary {
	return {
		elapsedMs: 1000,
		modelId: "m",
		targetId: "t",
		inputTokens: 10,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		toolCount: 0,
		toolErrorCount: 0,
		stopReason: "stop",
		watchdogPeak: 0,
		truncated: false,
		...overrides,
	};
}

function assistant(fields: Record<string, unknown>): AgentMessage {
	return { role: "assistant", content: [], ...fields } as unknown as AgentMessage;
}

describe("contracts/reasoning-projection", () => {
	it("projects provider, estimated, mixed, and unmeasured tallies", () => {
		strictEqual(reasoningFromTally(undefined).provenance, "unmeasured");
		strictEqual(reasoningFromTally(tally()).provenance, "unmeasured");
		strictEqual(reasoningFromTally(tally()).tokens, 0);

		const provider = reasoningFromTally(tally({ reasoningTokens: 42, hadProviderReasoning: true }));
		strictEqual(provider.provenance, "provider");
		strictEqual(provider.tokens, 42);

		const estimated = reasoningFromTally(tally({ reasoningTokens: 7, hadEstimatedReasoning: true }));
		strictEqual(estimated.provenance, "estimated");

		const mixed = reasoningFromTally(
			tally({ reasoningTokens: 49, hadProviderReasoning: true, hadEstimatedReasoning: true }),
		);
		strictEqual(mixed.provenance, "mixed");
		strictEqual(mixed.tokens, 49);
	});

	// A provider that attests zero has measured the turn. That is not the same
	// as a turn nothing has folded into yet, and only the second one is unknown.
	it("keeps an attested zero distinct from an unmeasured turn", () => {
		const attestedZero = reasoningFromTally(tally({ reasoningTokens: 0, hadProviderReasoning: true }));
		strictEqual(attestedZero.provenance, "provider");
		strictEqual(formatReasoningChip(attestedZero), null, "an attested zero still prints no chip");
		strictEqual(formatReasoningChip(reasoningFromTally(undefined)), null);
	});

	it("projects a settled summary, including one replayed without provenance", () => {
		strictEqual(reasoningFromSummary(undefined).provenance, "unmeasured");
		strictEqual(reasoningFromSummary(summary()).provenance, "unmeasured");

		const settled = reasoningFromSummary(summary({ reasoningTokens: 315, reasoningTokenProvenance: "estimated" }));
		strictEqual(settled.provenance, "estimated");
		strictEqual(settled.tokens, 315);

		// Persisted history written before provenance was recorded carries a
		// provider count and no label.
		const replayed = reasoningFromSummary(summary({ reasoningTokens: 315 }));
		strictEqual(replayed.provenance, "provider");
		strictEqual(replayed.tokens, 315);
	});

	it("marks only inferred counts with the approximation glyph", () => {
		strictEqual(formatReasoningChip({ tokens: 42, provenance: "provider" }), "r42");
		strictEqual(formatReasoningChip({ tokens: 42, provenance: "estimated" }), "r≈42");
		strictEqual(formatReasoningChip({ tokens: 42, provenance: "mixed" }), "r≈42");
		strictEqual(formatReasoningChip({ tokens: 0, provenance: "estimated" }), null);
		strictEqual(formatReasoningChip({ tokens: 9, provenance: "unmeasured" }), null);
		strictEqual(formatReasoningChip({ tokens: 1240, provenance: "estimated" }), "r≈1.2k");
		strictEqual(formatReasoningChip({ tokens: 1240, provenance: "provider" }, String), "r1240");
	});

	it("names each provenance for the surfaces that spell it out", () => {
		strictEqual(formatReasoningLabel({ tokens: 1, provenance: "provider" }), "provider-reported");
		strictEqual(formatReasoningLabel({ tokens: 1, provenance: "estimated" }), "estimated");
		strictEqual(formatReasoningLabel({ tokens: 1, provenance: "mixed" }), "mixed");
		strictEqual(formatReasoningLabel({ tokens: 0, provenance: "unmeasured" }), "unmeasured");
	});

	it("compacts token counts the way the footer does", () => {
		strictEqual(compactReasoningTokens(0), "0");
		strictEqual(compactReasoningTokens(999), "999");
		strictEqual(compactReasoningTokens(1000), "1k");
		strictEqual(compactReasoningTokens(3400), "3.4k");
		strictEqual(compactReasoningTokens(2_500_000), "2.5M");
	});

	// The estimator runs over displayed thinking text, which a provider may
	// summarize or a rail may repeat. Reasoning is part of generated output, so
	// reported output is its ceiling.
	it("never estimates more reasoning than the call reported as output", () => {
		const message = assistant({
			content: [{ type: "thinking", thinking: "x".repeat(4000) }],
			usage: { input: 100, output: 25 },
		});
		const folded = foldMessageIntoRunTally(emptyRunTally(), message);
		strictEqual(folded.hadEstimatedReasoning, true);
		strictEqual(folded.reasoningTokens, 25);

		// With no reported output there is no ceiling to clamp against.
		const unreported = foldMessageIntoRunTally(
			emptyRunTally(),
			assistant({ content: [{ type: "thinking", thinking: "x".repeat(4000) }] }),
		);
		strictEqual(unreported.reasoningTokens, 1000);

		// An explicit zero is still a provider report and therefore a real ceiling,
		// not the same thing as an absent output field.
		const reportedZero = foldMessageIntoRunTally(
			emptyRunTally(),
			assistant({ content: [{ type: "thinking", thinking: "x".repeat(4000) }], usage: { input: 100, output: 0 } }),
		);
		strictEqual(reportedZero.hadEstimatedReasoning, true);
		strictEqual(reportedZero.reasoningTokens, 0);

		// Clio's interrupted-turn estimate keeps a reasoning key for durable
		// record-shape parity. Its zero is synthetic, so streamed thinking still
		// contributes an estimate bounded by the estimated output total.
		const interrupted = foldMessageIntoRunTally(
			emptyRunTally(),
			assistant({
				content: [{ type: "thinking", thinking: "x".repeat(200) }],
				usage: { input: 100, output: 20, reasoning: 0, estimated: true },
			}),
		);
		strictEqual(interrupted.hadProviderReasoning, false);
		strictEqual(interrupted.hadEstimatedReasoning, true);
		strictEqual(interrupted.reasoningTokens, 20);
	});

	it("folds a multi-call turn that mixes attested and estimated reasoning", () => {
		let run = emptyRunTally();
		run = foldMessageIntoRunTally(
			run,
			assistant({ content: [{ type: "thinking", thinking: "attested" }], usage: { input: 5, output: 9, reasoning: 40 } }),
		);
		run = foldMessageIntoRunTally(
			run,
			assistant({ content: [{ type: "thinking", thinking: "x".repeat(40) }], usage: { input: 5, output: 900 } }),
		);
		const view = reasoningFromTally(run);
		strictEqual(view.provenance, "mixed");
		strictEqual(view.tokens, 50);
		ok(formatReasoningChip(view)?.startsWith("r≈"), "a mixed turn is marked approximate");
	});
});
