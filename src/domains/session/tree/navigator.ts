import type { SessionTreeNode } from "../../../engine/session.js";
import type { SessionMeta } from "../contract.js";
import type { ResolvedLabel } from "./manager.js";

/**
 * Purely functional tree-walk helpers. Given the raw SessionTreeNode[] that
 * the engine persists plus a label map and a leaf pointer, produce a
 * render-friendly snapshot. No I/O. Used by SessionContract.tree() to
 * deliver a serializable structure to overlay renderers in slice 12b-2.
 */

export interface TreeSnapshotNode {
	id: string;
	parentId: string | null;
	at: string;
	kind: SessionTreeNode["kind"];
	label?: string;
	/** Child ids in oldest-first order. */
	children: string[];
}

export interface TreeSnapshot {
	sessionId: string;
	/**
	 * SessionMeta slice suitable for overlay rendering. Keep the shape
	 * stable so the /tree overlay does not need to re-type it.
	 */
	meta: {
		id: string;
		cwd: string;
		createdAt: string;
		endedAt: string | null;
		model: string | null;
		endpoint: string | null;
		parentSessionId?: string | null;
		parentTurnId?: string | null;
	};
	/** Id of the leaf node the session will append under next. */
	leafId: string | null;
	/** Flat node map keyed by id. */
	nodesById: Record<string, TreeSnapshotNode>;
	/** Root node ids in oldest-first order. A well-formed session has one. */
	rootIds: string[];
}

function pickMeta(meta: SessionMeta): TreeSnapshot["meta"] {
	const out: TreeSnapshot["meta"] = {
		id: meta.id,
		cwd: meta.cwd,
		createdAt: meta.createdAt,
		endedAt: meta.endedAt,
		model: meta.model,
		endpoint: meta.endpoint,
	};
	if (meta.parentSessionId !== undefined) out.parentSessionId = meta.parentSessionId;
	if (meta.parentTurnId !== undefined) out.parentTurnId = meta.parentTurnId;
	return out;
}

/**
 * Compute the natural leaf of a tree: the most recent node with no children.
 * Returns null for an empty tree. Used by tree() when the caller has not
 * explicitly tracked a current-branch pointer yet.
 */
export function computeLeafId(nodes: ReadonlyArray<SessionTreeNode>): string | null {
	if (nodes.length === 0) return null;
	const hasChild = new Set<string>();
	for (const node of nodes) {
		if (node.parentId) hasChild.add(node.parentId);
	}
	let leaf: SessionTreeNode | null = null;
	for (const node of nodes) {
		if (hasChild.has(node.id)) continue;
		if (!leaf || node.at > leaf.at) leaf = node;
	}
	return leaf?.id ?? null;
}

/**
 * Build a serializable snapshot from raw tree nodes + labels + meta. Pure:
 * no fs, no time. Sorts child lists by timestamp ascending so the overlay
 * renders consistently across platforms.
 */
export function buildTreeSnapshot(input: {
	meta: SessionMeta;
	nodes: ReadonlyArray<SessionTreeNode>;
	labels: ReadonlyMap<string, ResolvedLabel>;
	leafId?: string | null;
}): TreeSnapshot {
	const nodesById: Record<string, TreeSnapshotNode> = {};
	for (const node of input.nodes) {
		const entry: TreeSnapshotNode = {
			id: node.id,
			parentId: node.parentId,
			at: node.at,
			kind: node.kind,
			children: [],
		};
		const resolved = input.labels.get(node.id);
		// Empty-string label is a tombstone produced by resolveLabelMap; treat
		// it as "no label" so tombstone entries do not surface as blank chips.
		if (resolved && resolved.label !== "") entry.label = resolved.label;
		nodesById[node.id] = entry;
	}

	const rootIds: string[] = [];
	for (const node of input.nodes) {
		const parent = node.parentId ? nodesById[node.parentId] : undefined;
		if (!parent) {
			rootIds.push(node.id);
		} else {
			parent.children.push(node.id);
		}
	}

	// Oldest-first for stable rendering. Unknown timestamps sort by id.
	const byTime = (a: string, b: string) => {
		const na = nodesById[a];
		const nb = nodesById[b];
		if (!na || !nb) return a < b ? -1 : a > b ? 1 : 0;
		if (na.at === nb.at) return na.id < nb.id ? -1 : na.id > nb.id ? 1 : 0;
		return na.at < nb.at ? -1 : 1;
	};
	rootIds.sort(byTime);
	for (const key of Object.keys(nodesById)) {
		const entry = nodesById[key];
		if (entry) entry.children.sort(byTime);
	}

	const leafId = input.leafId !== undefined ? input.leafId : computeLeafId(input.nodes);

	return {
		sessionId: input.meta.id,
		meta: pickMeta(input.meta),
		leafId,
		nodesById,
		rootIds,
	};
}
