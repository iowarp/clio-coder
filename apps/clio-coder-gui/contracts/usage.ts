import { type Static, Type } from "typebox";

// `_clio-coder/usage/read`: the terminal's /usage numbers. Session cost and tokens are Clio Coder's own
// accounting, folded per provider and model; quota is each provider's own report. The agent bounds rows
// at 32, providers at 16, windows at 8 and every string at 256 bytes.
const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 260 });
const count = Type.Integer({ minimum: 0 });
const nullableText = Type.Union([text, Type.Null()]);
const pct = Type.Number({ minimum: 0, maximum: 100 });

export const UsageCapability = Type.Object({ version: Type.Literal(1), read: Type.String({ maxLength: 128 }) }, closed);

const Cost = Type.Object(
	{
		knownUsd: Type.Number({ minimum: 0 }),
		calls: count,
		estimated: Type.Boolean(),
		unknown: Type.Boolean(),
		free: Type.Boolean(),
	},
	closed,
);

export const SessionUsage = Type.Object(
	{
		version: Type.Literal(1),
		session: Type.Object(
			{
				cost: Cost,
				tokens: count,
				rows: Type.Array(
					Type.Object(
						{
							provider: text,
							model: text,
							runs: count,
							calls: count,
							tokens: Type.Object(
								{ input: count, output: count, cacheRead: count, cacheWrite: count, reasoning: count, total: count },
								closed,
							),
							beside: Type.Object({ sideQuestions: count, handoffs: count, prewarms: count, backgroundMemory: count }, closed),
							cost: Cost,
						},
						closed,
					),
					{ maxItems: 32 },
				),
				truncated: Type.Boolean(),
			},
			closed,
		),
		quota: Type.Union([
			Type.Object(
				{
					status: Type.Literal("read"),
					providers: Type.Array(
						Type.Object(
							{
								provider: text,
								name: text,
								status: text,
								plan: nullableText,
								message: nullableText,
								credits: Type.Union([
									Type.Object({ display: text, usedPct: Type.Union([pct, Type.Null()]) }, closed),
									Type.Null(),
								]),
								stale: Type.Boolean(),
								fetchedAt: nullableText,
								retryAfterSeconds: Type.Union([count, Type.Null()]),
								windows: Type.Array(
									Type.Object(
										{ label: text, usedPct: pct, resetsAt: nullableText, scope: nullableText, active: Type.Boolean() },
										closed,
									),
									{ maxItems: 8 },
								),
							},
							closed,
						),
						{ maxItems: 16 },
					),
				},
				closed,
			),
			Type.Object({ status: Type.Literal("failed"), reason: text }, closed),
		]),
	},
	closed,
);
export type SessionUsage = Static<typeof SessionUsage>;
