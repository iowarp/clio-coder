import { type Static, Type } from "typebox";
import { Id } from "./common.js";

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
		autonomyEnforcement: Type.String(),
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
export const EvidenceOverview = Type.Object(
	{
		version: Type.Literal(1),
		evidenceId: Id,
		source: Type.Union([
			Type.Object({ kind: Type.Literal("run"), runId: Id }, closed),
			Type.Object({ kind: Type.Literal("session"), sessionId: Id }, closed),
			Type.Object({ kind: Type.Literal("eval"), evalId: Id }, closed),
		]),
		generatedAt: Type.String(),
		runIds: strings,
		sessionId: nullable,
		statuses: strings,
		startedAt: nullable,
		endedAt: nullable,
		tasks: strings,
		cwds: strings,
		agentIds: strings,
		targetIds: strings,
		runtimeIds: strings,
		modelIds: strings,
		tags: strings,
		files: strings,
		totals: Type.Object(
			{
				runs: Type.Number(),
				receipts: Type.Number(),
				toolCalls: Type.Number(),
				toolErrors: Type.Number(),
				blockedToolCalls: Type.Number(),
				sessionEntries: Type.Number(),
				auditRows: Type.Number(),
				toolEvents: Type.Number(),
				linkedToolEvents: Type.Number(),
				protectedArtifacts: Type.Number(),
				tokens: Type.Number(),
				costUsd: Type.Number(),
				wallTimeMs: Type.Number(),
			},
			closed,
		),
		redactionCount: Type.Optional(Type.Number()),
		decisions: Type.Optional(
			Type.Array(Type.Object({ runId: Type.String(), sessionId: Type.String(), ref: Type.String(), record }, closed)),
		),
	},
	closed,
);
export const EvidenceItem = Type.Object({ overview: EvidenceOverview, verdict: Verdict }, closed);
export const EvidencePage = Type.Object({ items: Type.Array(EvidenceItem), nextCursor: nullable }, closed);
export const EvidenceDetail = Type.Object(
	{
		overview: EvidenceOverview,
		verdict: Verdict,
		projection: Type.Union([Type.Literal("canonical"), Type.Literal("historical_format")]),
		findings: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					severity: Type.Union([Type.Literal("info"), Type.Literal("warn")]),
					tag: Type.String(),
					runId: nullable,
					message: Type.String(),
				},
				closed,
			),
		),
		// Full canonical attributed axes and authenticated decisions are intentionally retained.
		runs: Type.Array(Type.Object({ runId: Type.String(), status: record, summary: TrustSummary }, closed)),
		provenance: Type.Array(Type.Object({ runId: Type.String(), view: record, lines: strings }, closed)),
		gateDecisions: Type.Array(record),
	},
	closed,
);
export const ReceiptVerification = Type.Object(
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
				"integrity-mismatch",
				"ledger-mismatch",
				"integrity-invalid",
				"execution-role-invalid",
				"routing-intent-invalid",
				"route-decision-invalid",
				"receipt-unreadable",
				"envelope-unavailable",
				"unclassified",
			].map((value) => Type.Literal(value)),
		]),
		axes: TrustAxes,
	},
	closed,
);
export const EvidenceOperationResult = Type.Union([
	Type.Object(
		{ kind: Type.Literal("evidence"), id: Id, exitCode: Type.Literal(0), message: Type.String(), artifact: EvidenceItem },
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("receipt-verification"),
			id: Id,
			exitCode: Type.Literal(0),
			message: Type.String(),
			verification: ReceiptVerification,
		},
		closed,
	),
]);
export type EvidenceOperationResult = Static<typeof EvidenceOperationResult>;
export type EvidenceRequest =
	| { kind: "list"; limit: number; cursor?: string }
	| { kind: "detail"; id: string }
	| { kind: "built"; runId: string };
