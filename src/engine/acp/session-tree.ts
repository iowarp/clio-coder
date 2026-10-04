import type { AcpSessionTree } from "./types.js";

export type { AcpSessionTree, AcpTreeNodeKind } from "./types.js";
export { ACP_SESSION_FORK_METHOD, ACP_SESSION_SWITCH_TURN_METHOD, ACP_SESSION_TREE_METHOD } from "./types.js";

/**
 * `_clio-coder/session/tree`: the terminal's /tree navigator as one bounded
 * projection, plus the two operations it leads to.
 *
 * `_clio-coder/session/switch_turn` moves the session's append point to a turn,
 * as Enter does in /tree, and `_clio-coder/session/fork` starts a new session
 * from a turn, as /fork does. Both reset the conversation and replay the
 * resulting branch with the same frames `session/load` sends.
 *
 * The projection carries what the navigator shows a person: shape, kind, time,
 * the operator's label and a one-line preview. Payloads, tool arguments and
 * transcript paths stay in the ledger.
 */

import type { TreeSnapshot } from "../../domains/session/tree/navigator.js";

/** Nodes one answer carries; the active path is always kept whole within it. */
export const ACP_SESSION_TREE_MAX_NODES = 400;
const MAX_PREVIEW_BYTES = 240;
const MAX_LABEL_BYTES = 256;

function bounded(text: string, maxBytes: number): string {
	const oneLine = text.replace(/\s+/gu, " ").trim();
	if (Buffer.byteLength(oneLine, "utf8") <= maxBytes) return oneLine;
	let cut = oneLine.slice(0, maxBytes);
	while (Buffer.byteLength(cut, "utf8") > maxBytes - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}

const optional = (text: string | undefined, maxBytes: number) => {
	if (text === undefined) return null;
	const value = bounded(text, maxBytes);
	return value.length === 0 ? null : value;
};

/** True for a node a person can continue or fork from. */
export function isSelectableTreeNode(kind: string): boolean {
	return kind !== "compaction" && kind !== "branch";
}

export function projectSessionTree(snapshot: TreeSnapshot): AcpSessionTree {
	const active = new Set<string>();
	for (let id = snapshot.leafId; id !== null && !active.has(id); ) {
		active.add(id);
		id = snapshot.nodesById[id]?.parentId ?? null;
	}
	const ordered = Object.values(snapshot.nodesById).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	let kept = ordered;
	let truncated = false;
	if (ordered.length > ACP_SESSION_TREE_MAX_NODES) {
		// The active path is what a person is standing on, so it survives whole;
		// the newest of the rest fill what is left, and a node whose parent was
		// cut is re-rooted rather than dangling.
		truncated = true;
		const others = ordered.filter((node) => !active.has(node.id));
		const room = Math.max(0, ACP_SESSION_TREE_MAX_NODES - active.size);
		const keep = new Set([...active].slice(0, ACP_SESSION_TREE_MAX_NODES));
		for (const node of others.slice(Math.max(0, others.length - room))) keep.add(node.id);
		kept = ordered.filter((node) => keep.has(node.id));
	}
	const keptIds = new Set(kept.map((node) => node.id));
	return {
		version: 1,
		sessionId: snapshot.sessionId,
		leafId: snapshot.leafId,
		parentSessionId: snapshot.meta.parentSessionId ?? null,
		parentTurnId: snapshot.meta.parentTurnId ?? null,
		nodes: kept.map((node) => ({
			id: node.id,
			parentId: node.parentId !== null && keptIds.has(node.parentId) ? node.parentId : null,
			kind: node.kind,
			at: node.at,
			label: optional(node.label, MAX_LABEL_BYTES),
			preview: optional(node.preview, MAX_PREVIEW_BYTES),
			active: active.has(node.id),
			selectable: isSelectableTreeNode(node.kind),
		})),
		truncated,
	};
}
