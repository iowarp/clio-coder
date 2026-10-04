import {
	AcpBranchSwitchedSchema,
	AcpForkedSchema,
	AcpSessionTreeSchema,
	AcpBranchesCapability as BranchesCapability,
} from "./wire.js";

export { BranchesCapability };

import type { Static } from "typebox";
import { Type } from "typebox";

// `_clio-coder/session/tree`, `switch_turn` and `fork`: the terminal's /tree and /fork.
// The agent bounds the tree at 400 nodes, a preview at 240 bytes and a label at 256; these schemas restate that.
const closed = { additionalProperties: false };
export const TurnId = Type.String({ minLength: 1, maxLength: 128 });

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

export const SessionTree = AcpSessionTreeSchema;
export type SessionTree = Static<typeof SessionTree>;

export const BranchRequest = Type.Object({ turnId: TurnId }, closed);
export const BranchSwitched = AcpBranchSwitchedSchema;
export const Forked = AcpForkedSchema;
export type Forked = Static<typeof Forked>;
