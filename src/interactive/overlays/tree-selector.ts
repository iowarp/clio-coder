import type { SessionContract } from "../../domains/session/contract.js";
import type { TreeSnapshot, TreeSnapshotNode } from "../../domains/session/tree/navigator.js";
import { Box, type Component, type OverlayHandle, type TUI, truncateToWidth } from "../../engine/tui.js";

export const TREE_OVERLAY_WIDTH = 88;
const VISIBLE_ROWS = 16;

/**
 * /tree navigator overlay. Phase 12 slice 12b-2 behaviors only:
 *   - One row per node, children indented under parents by 2 spaces per depth
 *   - Shift+T toggles ISO timestamps on/off
 *   - `e` enters label edit submode (Enter commits, Esc cancels)
 *   - `d` deletes the highlighted session with files
 *   - Shift+D deletes the highlighted session and keeps files (tombstone)
 *   - Enter on a row calls onSwitchBranch with the snapshot's session id
 *   - Esc closes the overlay
 *
 * Cwd-toggle (`p`) and sort-order (`s`) land in Phase 18.
 *
 * The overlay queries `session.tree()` on open and after any mutation so
 * label/delete edits are reflected without a close/reopen cycle.
 */
export interface OpenTreeOverlayDeps {
	session: SessionContract;
	onSwitchBranch: (sessionId: string) => void;
	onClose: () => void;
}

interface TreeRow {
	depth: number;
	node: TreeSnapshotNode;
	sessionId: string;
}

type Submode = "browse" | "edit-label" | "confirm-delete";

interface DeleteContext {
	keepFiles: boolean;
}

function shortTurnId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

function clampPreview(text: string, max: number): string {
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

function previewForNode(node: TreeSnapshotNode): string {
	// TreeSnapshotNode only carries kind + ids + label; the entry payload lives
	// in current.jsonl and is not part of the snapshot. Render kind-specific
	// short strings so the operator still sees what the row represents.
	switch (node.kind) {
		case "user":
			return "[user]";
		case "assistant":
			return "[assistant]";
		case "tool_call":
			return "[tool_call]";
		case "tool_result":
			return "[tool_result]";
		case "system":
			return "[system]";
		case "checkpoint":
			return "[checkpoint]";
		default:
			return `[${node.kind}]`;
	}
}

function isLeaf(node: TreeSnapshotNode): boolean {
	return node.children.length === 0;
}

export function flattenTreeSnapshot(snapshot: TreeSnapshot): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (id: string, depth: number): void => {
		const node = snapshot.nodesById[id];
		if (!node) return;
		rows.push({ depth, node, sessionId: snapshot.sessionId });
		for (const childId of node.children) walk(childId, depth + 1);
	};
	for (const rootId of snapshot.rootIds) walk(rootId, 0);
	return rows;
}

export function formatTreeRow(row: TreeRow, opts: { showTimestamps: boolean; width: number }): string {
	const indent = "  ".repeat(row.depth);
	const glyph = isLeaf(row.node) ? "●" : "○";
	const turnId = shortTurnId(row.node.id);
	const preview = clampPreview(previewForNode(row.node), 40);
	const labelSuffix = row.node.label ? ` · label:"${row.node.label}"` : "";
	const main = `${indent}${glyph} ${row.node.kind.padEnd(12)} ${turnId}  ${preview}${labelSuffix}`;
	if (!opts.showTimestamps) return truncateToWidth(main, opts.width, "", true);
	const ts = row.node.at.slice(0, 19).replace("T", " ");
	const budget = Math.max(10, opts.width - ts.length - 2);
	const primary = truncateToWidth(main, budget, "", true);
	const pad = " ".repeat(Math.max(1, opts.width - primary.length - ts.length));
	return `${primary}${pad}${ts}`;
}

class TreeOverlayView implements Component {
	private snapshot: TreeSnapshot | null;
	private rows: TreeRow[];
	private highlight = 0;
	private scrollTop = 0;
	private showTimestamps = false;
	private submode: Submode = "browse";
	private labelBuffer = "";
	private deleteContext: DeleteContext | null = null;
	private status = "";

	constructor(
		private readonly deps: OpenTreeOverlayDeps,
		initial: TreeSnapshot | null,
	) {
		this.snapshot = initial;
		this.rows = initial ? flattenTreeSnapshot(initial) : [];
	}

	private invalidateLayout(): void {
		if (this.rows.length === 0) {
			this.highlight = 0;
			this.scrollTop = 0;
			return;
		}
		if (this.highlight >= this.rows.length) this.highlight = this.rows.length - 1;
		if (this.highlight < 0) this.highlight = 0;
		if (this.highlight < this.scrollTop) this.scrollTop = this.highlight;
		if (this.highlight >= this.scrollTop + VISIBLE_ROWS) {
			this.scrollTop = Math.max(0, this.highlight - VISIBLE_ROWS + 1);
		}
	}

	private currentRow(): TreeRow | null {
		return this.rows[this.highlight] ?? null;
	}

	private refresh(): void {
		try {
			this.snapshot = this.deps.session.tree();
			this.rows = flattenTreeSnapshot(this.snapshot);
		} catch {
			this.snapshot = null;
			this.rows = [];
		}
		this.invalidateLayout();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(10, width - 4);
		const lines: string[] = [];
		lines.push(`┌${" /tree ".padEnd(contentWidth + 2, "─")}┐`);
		if (this.rows.length === 0) {
			lines.push(`│ ${"(no sessions yet)".padEnd(contentWidth)} │`);
		} else {
			const end = Math.min(this.rows.length, this.scrollTop + VISIBLE_ROWS);
			for (let i = this.scrollTop; i < end; i++) {
				const row = this.rows[i];
				if (!row) continue;
				const body = formatTreeRow(row, { showTimestamps: this.showTimestamps, width: contentWidth - 2 });
				const prefix = i === this.highlight ? "▸ " : "  ";
				const full = `${prefix}${body}`;
				lines.push(`│ ${full.padEnd(contentWidth)} │`);
			}
			for (let i = end - this.scrollTop; i < VISIBLE_ROWS; i++) {
				lines.push(`│ ${" ".repeat(contentWidth)} │`);
			}
		}
		lines.push(`├${"─".repeat(contentWidth + 2)}┤`);
		const footer = this.footerText();
		lines.push(`│ ${truncateToWidth(footer, contentWidth, "", true).padEnd(contentWidth)} │`);
		if (this.status) {
			lines.push(`│ ${truncateToWidth(this.status, contentWidth, "", true).padEnd(contentWidth)} │`);
		}
		lines.push(`└${"─".repeat(contentWidth + 2)}┘`);
		return lines;
	}

	private footerText(): string {
		if (this.submode === "edit-label") {
			return `label: ${this.labelBuffer}_  [Enter] commit  [Esc] cancel`;
		}
		if (this.submode === "confirm-delete") {
			const scope = this.deleteContext?.keepFiles ? "tombstone" : "delete with files";
			return `Delete session (${scope})? [y] confirm  [n] cancel`;
		}
		const tsLabel = this.showTimestamps ? "on" : "off";
		return `[↑/↓] move  [Enter] switch  [e] label  [d/Shift+D] delete  [Shift+T] ts:${tsLabel}  [Esc] close`;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.submode === "edit-label") {
			this.handleLabelInput(data);
			return;
		}
		if (this.submode === "confirm-delete") {
			this.handleDeleteConfirmInput(data);
			return;
		}
		this.handleBrowseInput(data);
	}

	private handleBrowseInput(data: string): void {
		// Esc in browse closes the overlay. In submodes it cancels the submode
		// first (handled by the submode input handlers).
		if (data === "\x1b") {
			this.deps.onClose();
			return;
		}
		// Empty snapshot: only Esc is meaningful; swallow everything else.
		if (this.rows.length === 0) return;
		// Arrows: CSI A/B for up/down.
		if (data === "\x1b[A") {
			this.moveHighlight(-1);
			return;
		}
		if (data === "\x1b[B") {
			this.moveHighlight(1);
			return;
		}
		if (data === "\r" || data === "\n") {
			const row = this.currentRow();
			if (!row) return;
			this.deps.onSwitchBranch(row.sessionId);
			this.deps.onClose();
			return;
		}
		if (data === "T") {
			this.showTimestamps = !this.showTimestamps;
			return;
		}
		if (data === "e") {
			this.submode = "edit-label";
			this.labelBuffer = this.currentRow()?.node.label ?? "";
			this.status = "";
			return;
		}
		if (data === "d") {
			this.submode = "confirm-delete";
			this.deleteContext = { keepFiles: false };
			this.status = "";
			return;
		}
		if (data === "D") {
			this.submode = "confirm-delete";
			this.deleteContext = { keepFiles: true };
			this.status = "";
			return;
		}
	}

	private handleLabelInput(data: string): void {
		if (data === "\x1b") {
			this.submode = "browse";
			this.labelBuffer = "";
			this.status = "";
			return;
		}
		if (data === "\r" || data === "\n") {
			const row = this.currentRow();
			if (!row) {
				this.submode = "browse";
				this.labelBuffer = "";
				return;
			}
			try {
				this.deps.session.editLabel(row.node.id, this.labelBuffer, row.sessionId);
				this.status = `[tree] label updated on ${shortTurnId(row.node.id)}`;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.status = `[tree] editLabel failed: ${msg}`;
			}
			this.submode = "browse";
			this.labelBuffer = "";
			this.refresh();
			return;
		}
		// Backspace: DEL (0x7f) or BS (0x08).
		if (data === "\x7f" || data === "\b") {
			this.labelBuffer = this.labelBuffer.slice(0, -1);
			return;
		}
		// Swallow other control sequences (arrows, etc.) so they do not end up
		// in the label buffer.
		if (data.startsWith("\x1b") || data.length === 0) return;
		// Accept printable chars (including multi-byte UTF-8 runs).
		if (data.charCodeAt(0) < 0x20) return;
		this.labelBuffer += data;
	}

	private handleDeleteConfirmInput(data: string): void {
		if (data === "y" || data === "Y") {
			const row = this.currentRow();
			const ctx = this.deleteContext;
			if (!row || !ctx) {
				this.submode = "browse";
				this.deleteContext = null;
				return;
			}
			try {
				this.deps.session.deleteSession(row.sessionId, { keepFiles: ctx.keepFiles });
				this.status = `[tree] session ${shortTurnId(row.sessionId)} ${ctx.keepFiles ? "tombstoned" : "deleted"}`;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.status = `[tree] deleteSession failed: ${msg}`;
			}
			this.submode = "browse";
			this.deleteContext = null;
			this.refresh();
			return;
		}
		// Any other key cancels the confirm prompt.
		this.submode = "browse";
		this.deleteContext = null;
	}

	private moveHighlight(delta: number): void {
		const next = this.highlight + delta;
		if (next < 0 || next >= this.rows.length) return;
		this.highlight = next;
		this.invalidateLayout();
	}
}

class TreeOverlayBox extends Box {
	constructor(private readonly view: TreeOverlayView) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.view.handleInput(data);
	}
}

function loadInitialSnapshot(session: SessionContract): TreeSnapshot | null {
	try {
		return session.tree();
	} catch {
		return null;
	}
}

export function openTreeOverlay(tui: TUI, deps: OpenTreeOverlayDeps): OverlayHandle {
	const initial = loadInitialSnapshot(deps.session);
	const view = new TreeOverlayView(deps, initial);
	const box = new TreeOverlayBox(view);
	box.addChild(view);
	return tui.showOverlay(box, { anchor: "center", width: TREE_OVERLAY_WIDTH });
}
