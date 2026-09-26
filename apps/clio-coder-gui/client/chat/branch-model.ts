// What the conversation's branches say, before any of it is drawn. The terminal's /tree lists every
// turn; a person choosing where to continue reads requests and replies, so tool steps are folded into
// the exchange they belong to and counted. Pure, so wording, depth and permitted actions are testable
// without a DOM.

import type { SessionTree, TreeNodeKind } from "../../contracts/branches.js";

export interface BranchRow {
	id: string;
	/** Branch level: it grows only where a turn has more than one continuation, as in /tree. */
	depth: number;
	kind: "request" | "reply" | "structure";
	word: string;
	text: string;
	label: string | null;
	at: string;
	/** On the path the next request follows. */
	active: boolean;
	/** The last visible turn on that path: the next request continues after it. */
	tip: boolean;
	/** Where "continue" and "fork" are offered; structural rows are not a place to stand. */
	selectable: boolean;
}

export interface BranchView {
	rows: BranchRow[];
	/** Tool calls and results folded into the replies around them. */
	foldedSteps: number;
	/** Turns that continue from more than one place: the count a person reads as "branches". */
	branchPoints: number;
	forkedFrom: { sessionId: string; turnId: string } | null;
	truncated: boolean;
}

const WORDS: Record<TreeNodeKind, { kind: BranchRow["kind"]; word: string } | null> = {
	user: { kind: "request", word: "Request" },
	assistant: { kind: "reply", word: "Reply" },
	compaction: { kind: "structure", word: "Compacted here" },
	branch: { kind: "structure", word: "Returned from a branch" },
	tool_call: null,
	tool_result: null,
	system: null,
	checkpoint: null,
};

export function branchView(tree: SessionTree): BranchView {
	const children = new Map<string | null, string[]>();
	const byId = new Map(tree.nodes.map((node) => [node.id, node]));
	for (const node of tree.nodes) {
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node.id);
		children.set(node.parentId, siblings);
	}
	const rows: BranchRow[] = [];
	let foldedSteps = 0;
	let branchPoints = 0;
	const visit = (id: string, depth: number) => {
		const node = byId.get(id);
		if (!node) return;
		const words = WORDS[node.kind];
		if (words)
			rows.push({
				id: node.id,
				depth,
				kind: words.kind,
				word: words.word,
				text: node.preview ?? node.label ?? "(no text recorded)",
				label: node.label,
				at: node.at,
				active: node.active,
				tip: false,
				selectable: node.selectable && words.kind !== "structure",
			});
		else foldedSteps++;
		const next = children.get(id) ?? [];
		if (next.length > 1) branchPoints++;
		for (const child of next) visit(child, depth + (next.length > 1 ? 1 : 0));
	};
	for (const root of children.get(null) ?? []) visit(root, 0);
	const tip = rows.filter((row) => row.active && row.selectable).at(-1);
	if (tip) tip.tip = true;
	return {
		rows,
		foldedSteps,
		branchPoints,
		forkedFrom:
			tree.parentSessionId !== null && tree.parentTurnId !== null
				? { sessionId: tree.parentSessionId, turnId: tree.parentTurnId }
				: null,
		truncated: tree.truncated,
	};
}

/** The sentence under a branch change, so a person knows what moved and what did not. */
export const SWITCHED_NOTE =
	"The next request continues from this turn. The other branch is kept in this conversation's history.";
export const FORKED_NOTE = "Workspace files were not rewound; existing edits remain.";
