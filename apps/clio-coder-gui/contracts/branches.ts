import { type Static, Type } from "typebox";
import { Id } from "./common.js";

// `_clio-coder/session/tree`, `switch_turn` and `fork`: the terminal's /tree and /fork.
// The agent bounds the tree at 400 nodes, a preview at 240 bytes and a label at 256; these schemas restate that.
const closed = { additionalProperties: false };
const method = Type.String({ maxLength: 128 });
export const TurnId = Type.String({ minLength: 1, maxLength: 128 });

export const BranchesCapability = Type.Object(
	{ version: Type.Literal(1), tree: method, switchTurn: method, fork: method },
	closed,
);
export type BranchesCapability = Static<typeof BranchesCapability>;

export const TreeNodeKind = Type.Union([
	Type.Literal("user"),
	Type.Literal("assistant"),
	Type.Literal("tool_call"),
	Type.Literal("tool_result"),
	Type.Literal("system"),
	Type.Literal("checkpoint"),
	Type.Literal("compaction"),
	Type.Literal("branch"),
]);
export type TreeNodeKind = Static<typeof TreeNodeKind>;

export const SessionTree = Type.Object(
	{
		version: Type.Literal(1),
		sessionId: Id,
		leafId: Type.Union([TurnId, Type.Null()]),
		parentSessionId: Type.Union([Id, Type.Null()]),
		parentTurnId: Type.Union([TurnId, Type.Null()]),
		nodes: Type.Array(
			Type.Object(
				{
					id: TurnId,
					parentId: Type.Union([TurnId, Type.Null()]),
					kind: TreeNodeKind,
					at: Type.String({ maxLength: 64 }),
					label: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
					preview: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
					active: Type.Boolean(),
					selectable: Type.Boolean(),
				},
				closed,
			),
			{ maxItems: 400 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export type SessionTree = Static<typeof SessionTree>;

export const BranchRequest = Type.Object({ turnId: TurnId }, closed);
export const BranchSwitched = Type.Object({ leafId: TurnId, replayedTurns: Type.Integer({ minimum: 0 }) }, closed);
export const Forked = Type.Object(
	{
		sessionId: Id,
		parentSessionId: Id,
		parentTurnId: TurnId,
		/** False when the fork exists but its transcript could not be replayed; it starts empty. */
		replayed: Type.Boolean(),
	},
	closed,
);
export type Forked = Static<typeof Forked>;
