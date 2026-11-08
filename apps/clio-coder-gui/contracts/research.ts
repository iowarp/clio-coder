import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);

/** `r<yyyymmdd>-<hhmmss>-<hex4>`, the id `clio-coder research start` gives a campaign. */
export const ResearchCampaignId = Type.String({ pattern: "^r[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$" });
export const ResearchDirection = Type.Union([Type.Literal("min"), Type.Literal("max")]);
/** A key of the JSON payload the objective check prints, such as `wall_ms`. */
export const ResearchMetric = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,127}$" });
/** A repository-relative glob; never a leading dash, so it cannot read as an option. */
export const ResearchScope = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\-\\r\\n][^\\r\\n]*$" });
/** One line of guidance for the agent; never a leading dash, so `--goal` always takes it as its value. */
export const ResearchGoal = Type.String({ minLength: 1, maxLength: 2000, pattern: "^[^\\-\\s][^\\r\\n]*$" });
export const ResearchModel = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$" });

export const ResearchStartRequest = Type.Object(
	{
		check: Id,
		metric: ResearchMetric,
		direction: ResearchDirection,
		maxIterations: Type.Integer({ minimum: 1, maximum: 1000 }),
		minImprovement: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
		trials: Type.Optional(Type.Integer({ minimum: 2, maximum: 100 })),
		gates: Type.Array(Id, { maxItems: 32 }),
		scope: Type.Array(ResearchScope, { maxItems: 64 }),
		maxWallMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10_080 })),
		maxCostUsd: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 10_000 })),
		allowUnpriced: Type.Boolean(),
		goal: Type.Optional(ResearchGoal),
		target: Type.Optional(Id),
		model: Type.Optional(ResearchModel),
	},
	closed,
);
export type ResearchStartRequest = Static<typeof ResearchStartRequest>;

const Verdict = Type.Union([
	Type.Literal("improved"),
	Type.Literal("unchanged"),
	Type.Literal("regressed"),
	Type.Literal("inconclusive"),
]);
export const ResearchGrade = Type.Object(
	{
		verdict: Verdict,
		classification: Type.Union([
			Type.Literal("improved"),
			Type.Literal("unchanged"),
			Type.Literal("regressed"),
			Type.Literal("undefined"),
		]),
		baseMedian: Nullable(Type.Number()),
		candidateMedian: Nullable(Type.Number()),
		delta: Nullable(Type.Number()),
		ci: Nullable(Type.Object({ low: Type.Number(), high: Type.Number() }, closed)),
		seed: Type.Integer(),
		resamples: Type.Integer(),
	},
	closed,
);
export type ResearchGrade = Static<typeof ResearchGrade>;

export const ResearchArchiveReason = Type.Union([
	Type.Literal("agent-failed"),
	Type.Literal("no-op"),
	Type.Literal("duplicate"),
	Type.Literal("out-of-scope"),
	Type.Literal("protected"),
	Type.Literal("measure-failed"),
	Type.Literal("gate-failed"),
	Type.Literal("not-improved"),
	Type.Literal("ratchet-lost"),
	Type.Literal("deadline"),
	Type.Literal("interrupted"),
]);
export const ResearchStopReason = Type.Union([
	Type.Literal("max-iterations"),
	Type.Literal("max-wall-minutes"),
	Type.Literal("max-cost-usd"),
	Type.Literal("budget-unenforceable"),
	Type.Literal("stopped"),
	Type.Literal("noisy"),
	Type.Literal("error"),
]);
const HypothesisVerdict = Type.Union([
	Type.Literal("supported"),
	Type.Literal("refuted"),
	Type.Literal("inconclusive"),
]);
const Cost = Type.Union([
	Type.Object({ kind: Type.Literal("measured"), usd: Type.Number() }, closed),
	Type.Object({ kind: Type.Literal("estimated"), usd: Type.Number() }, closed),
	Type.Object({ kind: Type.Literal("free") }, closed),
	Type.Object({ kind: Type.Literal("unknown"), reason: Type.String() }, closed),
]);
const Gate = Type.Object(
	{
		check: Type.String(),
		passed: Type.Boolean(),
		execution: Type.String(),
		summary: Type.String(),
		claim: Type.Optional(Type.String()),
	},
	closed,
);

export const ResearchIteration = Type.Object(
	{
		iteration: Type.Integer({ minimum: 1 }),
		parent: Type.String(),
		commit: Nullable(Type.String()),
		changed: Type.Array(Type.String()),
		agent: Nullable(
			Type.Object(
				{
					exitCode: Nullable(Type.Integer()),
					sessionId: Nullable(Type.String()),
					outcome: Nullable(Type.String()),
					summary: Type.String(),
				},
				closed,
			),
		),
		cost: Nullable(Cost),
		samples: Nullable(Type.String()),
		grade: Nullable(ResearchGrade),
		gates: Type.Array(Gate),
		outcome: Type.Union([Type.Literal("ratcheted"), Type.Literal("running"), ResearchArchiveReason]),
		detail: Type.String(),
		hypothesis: Nullable(Type.String()),
		hypothesisVerdict: Nullable(HypothesisVerdict),
		claims: Type.Array(Type.String()),
	},
	closed,
);
export type ResearchIteration = Static<typeof ResearchIteration>;

/** A check exactly as the campaign froze it; kind parameters are shown, never interpreted, by the GUI. */
const FrozenCheck = Type.Object(
	{
		id: Type.String(),
		description: Type.String(),
		command: Type.Array(Type.String()),
		cwd: Type.String(),
		timeoutMs: Type.Number(),
		tags: Type.Array(Type.String()),
		source: Type.Object({ kind: Type.String(), path: Type.String() }, closed),
		kind: Type.Union([
			Type.Literal("command"),
			Type.Literal("numeric-compare"),
			Type.Literal("perf-budget"),
			Type.Literal("reproduce"),
		]),
		numeric: Type.Optional(
			Type.Object({ reference: Type.String(), tolerance: Type.Record(Type.String(), Type.Unknown()) }, closed),
		),
		perf: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		reproduce: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		runs: Type.Optional(Type.String()),
	},
	closed,
);

export const ResearchCampaignRecord = Type.Object(
	{
		version: Type.Literal(1),
		id: ResearchCampaignId,
		createdAt: Type.String(),
		project: Type.String(),
		objective: Type.Object(
			{
				check: Type.String(),
				metric: Type.String(),
				direction: ResearchDirection,
				minImprovement: Type.Number(),
				trials: Type.Integer(),
			},
			closed,
		),
		gates: Type.Array(Type.String()),
		scope: Type.Array(Type.String()),
		protected: Type.Array(Type.String()),
		budget: Type.Object(
			{
				maxIterations: Type.Integer(),
				maxWallMinutes: Type.Optional(Type.Number()),
				maxCostUsd: Type.Optional(Type.Number()),
				allowUnpriced: Type.Boolean(),
			},
			closed,
		),
		allowNoisy: Type.Boolean(),
		keep: Type.Boolean(),
		agent: Type.Object(
			{
				target: Type.Optional(Type.String()),
				model: Type.Optional(Type.String()),
				autonomy: Type.Literal("default"),
				goal: Type.Optional(Type.String()),
			},
			closed,
		),
		base: Type.String(),
		ref: Type.String(),
		checks: Type.Array(FrozenCheck),
		checkDigest: Type.String(),
		seed: Type.Integer(),
		resamples: Type.Integer(),
		clioVersion: Type.String(),
	},
	closed,
);

const viewFields = {
	id: ResearchCampaignId,
	state: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
	stop: Nullable(Type.Object({ reason: ResearchStopReason, detail: Type.String(), at: Type.String() }, closed)),
	best: Type.String(),
	ratchets: Type.Integer({ minimum: 0 }),
	spend: Type.Object(
		{ usd: Type.Number(), unknownRuns: Type.Integer({ minimum: 0 }), estimated: Type.Boolean() },
		closed,
	),
	aa: Nullable(
		Type.Object({ grade: ResearchGrade, noisy: Type.Boolean(), allowed: Type.Boolean(), samples: Type.String() }, closed),
	),
	iterations: Type.Array(ResearchIteration),
	campaign: ResearchCampaignRecord,
	unreadableJournalLines: Type.Integer({ minimum: 0 }),
	/** Money as the CLI's own renderer reads it; the server adds it, so the page never formats an amount itself. */
	display: Type.Optional(
		Type.Object(
			{
				spend: Type.String(),
				cap: Type.Optional(Type.String()),
				/** One per entry of `iterations`, in the same order. */
				costs: Type.Array(Type.String()),
			},
			closed,
		),
	),
};

/** `clio-coder research status <id> --json`: the journal folded as written. */
export const ResearchCampaign = Type.Object(viewFields, closed);
export type ResearchCampaign = Static<typeof ResearchCampaign>;

/** `clio-coder research report <id> --json`: every grade recomputed from the raw samples with the recorded seed. */
export const ResearchReport = Type.Object(
	{
		...viewFields,
		recomputed: Type.Array(
			Type.Object(
				{
					of: Type.Union([Type.Literal("aa"), Type.Integer({ minimum: 1 })]),
					samples: Type.String(),
					journal: Nullable(ResearchGrade),
					recomputed: ResearchGrade,
					agrees: Type.Boolean(),
				},
				closed,
			),
		),
		agrees: Type.Boolean(),
	},
	closed,
);
export type ResearchReport = Static<typeof ResearchReport>;

/** `clio-coder research list --json`, as the CLI prints it; the server projects it into `ResearchCampaigns`. */
export const ResearchCliList = Type.Object(
	{
		project: Type.String(),
		campaigns: Type.Array(
			Type.Union([ResearchCampaign, Type.Object({ id: Type.String(), error: Type.String() }, closed)]),
		),
	},
	closed,
);
export type ResearchCliList = Static<typeof ResearchCliList>;

export const ResearchCampaignSummary = Type.Union([
	Type.Object(
		{
			id: ResearchCampaignId,
			createdAt: Type.String(),
			state: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
			objective: Type.Object({ check: Type.String(), metric: Type.String(), direction: ResearchDirection }, closed),
			stop: Nullable(ResearchStopReason),
			iterations: Type.Integer({ minimum: 0 }),
			ratchets: Type.Integer({ minimum: 0 }),
		},
		closed,
	),
	Type.Object({ id: Type.String(), error: Type.String() }, closed),
]);
export type ResearchCampaignSummary = Static<typeof ResearchCampaignSummary>;

/** Campaigns in this workspace, newest first. */
export const ResearchCampaigns = Type.Object(
	{
		campaigns: Type.Array(ResearchCampaignSummary),
		/** The workspace's unsettled `research start` operation, so a page opened later can follow and stop it. */
		runningOperationId: Type.Optional(Type.String()),
	},
	closed,
);
export type ResearchCampaigns = Static<typeof ResearchCampaigns>;
