import { type Static, Type } from "typebox";
import { Id } from "./common.js";
import { TELEMETRY_DTO_SCHEMAS } from "./wire.js";

const closed = { additionalProperties: false };
const strings = Type.Array(Type.String());
const nullable = Type.Union([Type.String(), Type.Null()]);
const record = Type.Record(Type.String(), Type.Unknown());
export const Verdict = Type.Union([
	Type.Literal("compromised"),
	Type.Literal("unverified"),
	Type.Literal("unknown"),
	Type.Literal("grounded"),
	Type.Literal("reviewed"),
]);
export const TrustAxes = Type.Object(
	{
		artifactIntegrity: Type.String(),
		validationGrounding: Type.String(),
		independentReview: Type.String(),
		contextProvenance: Type.String(),
		completionEvidence: Type.String(),
	},
	closed,
);
export const TrustSummary = Type.Object(
	{
		version: Type.Literal(1),
		verdict: Verdict,
		text: Type.String(),
		axes: TrustAxes,
		claimant: Type.String(),
		unknown: strings,
		refs: strings,
	},
	closed,
);
const Quantity = TELEMETRY_DTO_SCHEMAS.cost.properties.total.properties.tokens;
/** One finished run as its sealed scope states it (#434): the seal's verdict and, under it, the run's assessment. */
export const EvidenceRun = Type.Object(
	{
		runId: Id,
		sessionId: nullable,
		integrity: Type.Union([Type.Literal("verified"), Type.Literal("unsealed"), Type.Literal("failed")]),
		/** The seal verifier's reason when the seal does not verify. */
		sealReason: nullable,
		assessedAt: nullable,
		settledAt: nullable,
		startedAt: nullable,
		endedAt: nullable,
		agentId: nullable,
		targetId: nullable,
		wireModelId: nullable,
		outcome: nullable,
		firstPassSuccess: Type.Union([Type.Boolean(), Type.Null()]),
		tags: strings,
		/** The run's folded quantities with their coverage; null unless the seal verifies. */
		quantities: Type.Union([Type.Object({ tokens: Quantity, usd: Quantity }, closed), Type.Null()]),
		totals: Type.Union([
			Type.Object(
				{
					toolCalls: Type.Number(),
					toolErrors: Type.Number(),
					blockedToolCalls: Type.Number(),
					wallTimeMs: Type.Number(),
				},
				closed,
			),
			Type.Null(),
		]),
	},
	closed,
);
export const EvidenceItem = Type.Object({ run: EvidenceRun, verdict: Verdict }, closed);
export const EvidencePage = Type.Object(
	{ items: Type.Array(EvidenceItem), nextCursor: nullable, present: Type.Boolean() },
	closed,
);
export const EvidenceDetail = Type.Object(
	{
		run: EvidenceRun,
		verdict: Verdict,
		findings: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					severity: Type.Union([Type.Literal("info"), Type.Literal("warn")]),
					tag: Type.String(),
					runId: Type.String(),
					message: Type.String(),
				},
				closed,
			),
		),
		// The full canonical attributed axes are intentionally retained.
		status: record,
		summary: TrustSummary,
		verdicts: Type.Array(
			Type.Object(
				{ decisionId: Type.String(), digest: Type.String(), outcome: Type.String(), review: Type.String() },
				closed,
			),
		),
		provenance: Type.Object({ view: record, lines: strings }, closed),
		decisions: Type.Array(
			Type.Object({ runId: Type.String(), sessionId: Type.String(), ref: Type.String(), record }, closed),
		),
	},
	closed,
);
export const RunRecordVerification = Type.Object(
	{
		version: Type.Literal(1),
		verifiedAt: Type.String(),
		runId: Id,
		state: Type.Union([
			Type.Literal("pending"),
			Type.Literal("verified"),
			Type.Literal("failed"),
			Type.Literal("unavailable"),
		]),
		reason: Type.Union([
			Type.Null(),
			...[
				"manifest-mismatch",
				"segment-mismatch",
				"object-mismatch",
				"chain-mismatch",
				"seal-mismatch",
				"unsealed",
				"run-unreadable",
			].map((value) => Type.Literal(value)),
		]),
		axes: TrustAxes,
	},
	closed,
);
export const EvidenceOperationResult = Type.Object(
	{
		kind: Type.Literal("run-record-verification"),
		id: Id,
		exitCode: Type.Literal(0),
		message: Type.String(),
		verification: RunRecordVerification,
	},
	closed,
);
export type EvidenceOperationResult = Static<typeof EvidenceOperationResult>;
export type EvidenceRequest = { kind: "list"; limit: number; cursor?: string } | { kind: "detail"; id: string };
