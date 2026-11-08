import { type Static, Type } from "typebox";
import { Id } from "./common.js";

const closed = { additionalProperties: false };
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);

/** `YYYYMMDD-HHMMSS-xxxx`, the id `clio-coder arena run` gives a match. */
export const ArenaMatchId = Type.String({ pattern: "^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$" });
export const ArenaLabel = Type.Union([Type.Literal("A"), Type.Literal("B"), Type.Literal("C"), Type.Literal("D")]);
export const ArenaChoice = Type.Union([ArenaLabel, Type.Literal("tie"), Type.Literal("both-bad")]);
/** A model id as targets name them: `claude-haiku-5.5`, `mini/qwen3.8-27b-iq4r-v4`, `org/model:tag`. */
export const ArenaModel = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$" });
export const ArenaNote = Type.String({ minLength: 1, maxLength: 500, pattern: "^[^\\r\\n]*$" });
export const ArenaPrompt = Type.String({ minLength: 1, maxLength: 8000 });
export const ArenaTimeoutSeconds = Type.Integer({ minimum: 30, maximum: 3600 });

export const ArenaContenderRequest = Type.Object({ target: Id, model: ArenaModel }, closed);
export const ArenaStartRequest = Type.Object(
	{
		prompt: ArenaPrompt,
		contenders: Type.Array(ArenaContenderRequest, { minItems: 2, maxItems: 4 }),
		timeoutSeconds: ArenaTimeoutSeconds,
		suite: Type.Optional(Id),
		check: Type.Optional(Id),
	},
	closed,
);
export type ArenaStartRequest = Static<typeof ArenaStartRequest>;
export const ArenaVoteRequest = Type.Object(
	{ choice: ArenaChoice, note: Type.Optional(ArenaNote), replace: Type.Boolean() },
	closed,
);
export type ArenaVoteRequest = Static<typeof ArenaVoteRequest>;

const ContenderStatus = Type.Union([
	Type.Literal("pending"),
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("timed-out"),
]);
const MatchStatus = Type.Union([Type.Literal("running"), Type.Literal("complete"), Type.Literal("failed")]);
const Count = Nullable(Type.Integer({ minimum: 0 }));

export const ArenaEntry = Type.Object(
	{
		label: ArenaLabel,
		status: ContenderStatus,
		exitCode: Nullable(Type.Integer()),
		timedOut: Type.Boolean(),
		turns: Count,
		toolCalls: Count,
		toolErrors: Count,
		writes: Count,
		blocks: Count,
		diffStat: Nullable(
			Type.Object(
				{
					files: Type.Integer({ minimum: 0 }),
					insertions: Type.Integer({ minimum: 0 }),
					deletions: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
		),
		check: Nullable(Type.Object({ id: Type.String(), exitCode: Nullable(Type.Integer()), tail: Type.String() }, closed)),
		finalText: Type.String(),
		diff: Nullable(Type.String()),
		diffTruncated: Type.Boolean(),
		error: Nullable(Type.String()),
		reveal: Nullable(
			Type.Object(
				{
					index: Type.Integer({ minimum: 0 }),
					target: Type.String(),
					model: Type.String(),
					durationMs: Nullable(Type.Number({ minimum: 0 })),
					sessionId: Nullable(Type.String()),
					tokens: Type.String(),
					cost: Type.String(),
				},
				closed,
			),
		),
	},
	closed,
);
export type ArenaEntry = Static<typeof ArenaEntry>;

const VoteSummary = Type.Object({ choice: ArenaChoice, note: Nullable(Type.String()), votedAt: Type.String() }, closed);

export const ArenaMatch = Type.Object(
	{
		id: ArenaMatchId,
		createdAt: Type.String(),
		completedAt: Nullable(Type.String()),
		status: MatchStatus,
		prompt: Type.String(),
		suite: Nullable(Type.String()),
		isolation: Type.Union([Type.Literal("worktree"), Type.Literal("read-only")]),
		check: Nullable(Type.String()),
		error: Nullable(Type.String()),
		revealed: Type.Boolean(),
		vote: Nullable(VoteSummary),
		entries: Type.Array(ArenaEntry, { maxItems: 4 }),
	},
	closed,
);
export type ArenaMatch = Static<typeof ArenaMatch>;

export const ArenaMatchSummary = Type.Object(
	{
		id: ArenaMatchId,
		createdAt: Type.String(),
		status: MatchStatus,
		suite: Nullable(Type.String()),
		prompt: Type.String(),
		contenders: Type.Integer({ minimum: 0 }),
		vote: Nullable(ArenaChoice),
		/** Present only once the match has a vote, so the list never unblinds a pending match. */
		identities: Nullable(Type.Array(Type.String(), { maxItems: 4 })),
	},
	closed,
);
export type ArenaMatchSummary = Static<typeof ArenaMatchSummary>;
export const ArenaMatches = Type.Object({ matches: Type.Array(ArenaMatchSummary, { maxItems: 100_000 }) }, closed);
export type ArenaMatches = Static<typeof ArenaMatches>;

export const ArenaStanding = Type.Object(
	{
		identity: Type.String(),
		target: Type.String(),
		model: Type.String(),
		votes: Type.Integer({ minimum: 0 }),
		wins: Type.Integer({ minimum: 0 }),
		losses: Type.Integer({ minimum: 0 }),
		ties: Type.Integer({ minimum: 0 }),
		bad: Type.Integer({ minimum: 0 }),
		score: Nullable(Type.Integer()),
	},
	closed,
);
export type ArenaStanding = Static<typeof ArenaStanding>;
export const ArenaStandings = Type.Object(
	{
		suite: Nullable(Type.String()),
		matches: Type.Integer({ minimum: 0 }),
		votedMatches: Type.Integer({ minimum: 0 }),
		minVotesForScore: Type.Integer({ minimum: 1 }),
		standings: Type.Array(ArenaStanding, { maxItems: 10_000 }),
	},
	closed,
);
export type ArenaStandings = Static<typeof ArenaStandings>;
export const ArenaStandingsQuery = Type.Object({ suite: Type.Optional(Id) }, closed);

export const ArenaVote = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		matchId: ArenaMatchId,
		choice: ArenaChoice,
		note: Nullable(Type.String()),
		votedAt: Type.String(),
		replaced: Type.Boolean(),
	},
	closed,
);
export type ArenaVote = Static<typeof ArenaVote>;
