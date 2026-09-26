import { type Static, Type } from "typebox";

// `_clio-coder/context/ledger`: the terminal's /context window view, read and never recomputed.
// The agent bounds groups at 32 and handbook files at 16; these schemas restate that.
const closed = { additionalProperties: false };
const text = Type.String({ maxLength: 300 });
const tokens = Type.Integer({ minimum: 0 });
const nullableCount = Type.Union([tokens, Type.Null()]);

export const ContextCapability = Type.Object(
	{ version: Type.Literal(1), ledger: Type.String({ maxLength: 128 }) },
	closed,
);
export type ContextCapability = Static<typeof ContextCapability>;

export const ContextLedger = Type.Object(
	{
		version: Type.Literal(1),
		provider: Type.Union([text, Type.Null()]),
		model: Type.Union([text, Type.Null()]),
		contextWindow: tokens,
		contextWindowSource: Type.Union([text, Type.Null()]),
		contextWindowSlots: Type.Union([Type.Object({ slots: tokens, totalTokens: tokens }, closed), Type.Null()]),
		usedTokens: tokens,
		reserveTokens: tokens,
		freeTokens: tokens,
		percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
		measured: Type.Boolean(),
		compactionThreshold: Type.Union([Type.Number(), Type.Null()]),
		compactionAuto: Type.Boolean(),
		projectPreload: Type.Union([text, Type.Null()]),
		projectHandbookFiles: Type.Union([Type.Array(text, { maxItems: 16 }), Type.Null()]),
		toolCount: tokens,
		groups: Type.Array(
			Type.Object(
				{
					category: Type.String({ maxLength: 32 }),
					label: text,
					tokens,
					percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
				},
				closed,
			),
			{ maxItems: 32 },
		),
		lastCompaction: Type.Union([
			Type.Object({ stage: text, tokensBefore: tokens, tokensAfter: tokens, trigger: text }, closed),
			Type.Null(),
		]),
		promptCache: Type.Union([
			Type.Object(
				{
					shellReused: Type.Boolean(),
					cacheReadTokens: nullableCount,
					cacheWriteTokens: nullableCount,
					uncachedInputTokens: nullableCount,
					backendVerdict: Type.Union([
						Type.Literal("hot"),
						Type.Literal("partial"),
						Type.Literal("cold"),
						Type.Literal("small"),
						Type.Literal("unknown"),
						Type.Null(),
					]),
				},
				closed,
			),
			Type.Null(),
		]),
	},
	closed,
);
export type ContextLedger = Static<typeof ContextLedger>;
