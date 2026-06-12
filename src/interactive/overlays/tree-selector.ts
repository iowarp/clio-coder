import type { SessionContract } from "../../domains/session/contract.js";
import type { TreeSnapshot, TreeSnapshotNode } from "../../domains/session/tree/navigator.js";
import {
	type Component,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../engine/tui.js";
import { buildHint, clioError, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";

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
	return id.length > 6 ? id.slice(0, 6) : id;
}

/**
 * Translate a deleteSession failure into an operator-facing message. The
 * session.deleteSession guard against removing the currently-open session
 * throws a verbose `session.deleteSession: refusing to delete the currently
 * open session; close() first` string that leaks contract-level language
 * into the TUI. Strip it down to a plain sentence; surface anything else
 * verbatim so genuine disk errors still reach the user.
 */
/** @internal */
export function formatTreeDeleteError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (message.includes("refusing to delete the currently open session")) {
		return "[tree] cannot delete the currently-open session";
	}
	return `[tree] could not delete session: ${message}`;
}

function clampPreview(text: string, max: number): string {
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/**
 * Fallback when the snapshot omits a payload preview (e.g. unit tests, or a
 * session whose current.jsonl cannot be read). Returns a kind-tagged token so
 * the row still renders a non-empty cell.
 */
function fallbackPreview(node: TreeSnapshotNode): string {
	switch (node.kind) {
		case "user":
			return "(no text)";
		case "assistant":
			return "(no text)";
		case "tool_call":
			return "(unknown tool)";
		case "tool_result":
			return "(no result)";
		case "system":
			return "(system)";
		case "checkpoint":
			return "(checkpoint)";
		default:
			return `(${node.kind})`;
	}
}

function isLeaf(node: TreeSnapshotNode): boolean {
	return node.children.length === 0;
}

function flattenTreeSnapshot(snapshot: TreeSnapshot): TreeRow[] {
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

/** Width budget for the inline preview cell. Sized so the surrounding indent,
 * role marker, and short turn id still fit on an 88-column overlay. */
const ROW_PREVIEW_BUDGET = 55;

/** @internal */
export function formatTreeRow(row: TreeRow, opts: { showTimestamps: boolean; width: number }): string {
	const indent = "  ".repeat(row.depth);
	const glyph = isLeaf(row.node) ? "●" : "○";
	const turnId = shortTurnId(row.node.id);
	const rawPreview = row.node.preview && row.node.preview.length > 0 ? row.node.preview : fallbackPreview(row.node);
	const labelSuffix = row.node.label ? ` · label:"${row.node.label}"` : "";
	const prefix = `${indent}${glyph} ${row.node.kind.padEnd(12)} ${turnId}  `;
	const previewBudget = Math.min(
		ROW_PREVIEW_BUDGET,
		Math.max(1, opts.width - visibleWidth(prefix) - visibleWidth(labelSuffix)),
	);
	const preview = clampPreview(rawPreview, previewBudget);
	const main = `${prefix}${preview}${labelSuffix}`;
	if (!opts.showTimestamps) return truncateToWidth(main, opts.width, "", true);
	const ts = row.node.at.slice(0, 19).replace("T", " ");
	if (opts.width < ts.length + 12) return truncateToWidth(main, opts.width, "", true);
	const budget = Math.max(1, opts.width - ts.length - 2);
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
	private deleteConfirmBuffer = "";
	private deleteContext: DeleteContext | null = null;
	private status = "";
	private statusKind: "info" | "error" = "info";

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
		const contentWidth = Math.max(1, width);
		const lines: string[] = [];
		if (this.rows.length === 0) {
			lines.push("(no sessions yet)");
		} else {
			const end = Math.min(this.rows.length, this.scrollTop + VISIBLE_ROWS);
			for (let i = this.scrollTop; i < end; i++) {
				const row = this.rows[i];
				if (!row) continue;
				const prefix = i === this.highlight ? "▸ " : "  ";
				const body = formatTreeRow(row, {
					showTimestamps: this.showTimestamps,
					width: Math.max(1, contentWidth - visibleWidth(prefix)),
				});
				const full = `${prefix}${body}`;
				lines.push(truncateToWidth(full, contentWidth, "", true));
			}
			for (let i = end - this.scrollTop; i < VISIBLE_ROWS; i++) {
				lines.push("");
			}
		}
		if (this.status) {
			const status = truncateToWidth(this.status, contentWidth, "", true);
			lines.push(this.statusKind === "error" ? clioError(status) : status);
		}
		return lines;
	}

	getHint(): string {
		return this.footerText();
	}

	private footerText(): string {
		if (this.submode === "edit-label") {
			return `label: ${this.labelBuffer}_  ${buildHint("commit", [{ key: "Enter", verb: "commit" }])}`;
		}
		if (this.submode === "confirm-delete") {
			const scope = this.deleteContext?.keepFiles ? "tombstone" : "delete with files";
			const typed = this.deleteConfirmBuffer ? ` typed:${this.deleteConfirmBuffer}` : "";
			return `Delete session (${scope})? confirm: y + Enter${typed}  ${buildHint("commit", [{ key: "n", verb: "cancel" }])}`;
		}
		const tsLabel = this.showTimestamps ? "on" : "off";
		return buildHint("browse", [
			{ key: "↑↓", verb: "move" },
			{ key: "Enter", verb: "switch" },
			{ key: "e", verb: "label" },
			{ key: "d/Shift+D", verb: "delete" },
			{ key: "Shift+T", verb: `ts:${tsLabel}` },
		]);
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
		if (matchesKey(data, "esc")) {
			this.deps.onClose();
			return;
		}
		// Empty snapshot: only Esc is meaningful; swallow everything else.
		if (this.rows.length === 0) return;
		// Arrows: CSI A/B for up/down.
		if (matchesKey(data, "up")) {
			this.moveHighlight(-1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.moveHighlight(1);
			return;
		}
		if (matchesKey(data, "enter") || data === "\n") {
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
			this.setStatus("");
			return;
		}
		if (data === "d") {
			this.submode = "confirm-delete";
			this.deleteContext = { keepFiles: false };
			this.deleteConfirmBuffer = "";
			this.setStatus("");
			return;
		}
		if (data === "D") {
			this.submode = "confirm-delete";
			this.deleteContext = { keepFiles: true };
			this.deleteConfirmBuffer = "";
			this.setStatus("");
			return;
		}
	}

	private handleLabelInput(data: string): void {
		if (matchesKey(data, "esc")) {
			this.submode = "browse";
			this.labelBuffer = "";
			this.setStatus("");
			return;
		}
		if (matchesKey(data, "enter") || data === "\n") {
			const row = this.currentRow();
			if (!row) {
				this.submode = "browse";
				this.labelBuffer = "";
				return;
			}
			try {
				this.deps.session.editLabel(row.node.id, this.labelBuffer, row.sessionId);
				this.setStatus(`[tree] label updated on ${shortTurnId(row.node.id)}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.setStatus(`[tree] editLabel failed: ${msg}`, "error");
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
		if (data.length === 0) return;
		// Accept printable chars (including multi-byte UTF-8 runs).
		if (data.charCodeAt(0) < 0x20) return;
		this.labelBuffer += data;
	}

	private handleDeleteConfirmInput(data: string): void {
		if (matchesKey(data, "esc") || data === "n" || data === "N") {
			this.cancelDeleteConfirm();
			return;
		}
		if (data === "\x7f" || data === "\b") {
			this.deleteConfirmBuffer = this.deleteConfirmBuffer.slice(0, -1);
			return;
		}
		if (matchesKey(data, "enter") || data === "\n") {
			const normalized = this.deleteConfirmBuffer.trim().toLowerCase();
			if (normalized === "y" || normalized === "yes") this.confirmDelete();
			else this.cancelDeleteConfirm();
			return;
		}
		if (data.length === 0) return;
		if (data.charCodeAt(0) < 0x20) return;
		const next = `${this.deleteConfirmBuffer}${data}`.slice(0, 3);
		if ("yes".startsWith(next.toLowerCase())) {
			this.deleteConfirmBuffer = next;
			return;
		}
		this.cancelDeleteConfirm();
	}

	private cancelDeleteConfirm(): void {
		this.submode = "browse";
		this.deleteContext = null;
		this.deleteConfirmBuffer = "";
	}

	private confirmDelete(): void {
		const row = this.currentRow();
		const ctx = this.deleteContext;
		if (!row || !ctx) {
			this.submode = "browse";
			this.deleteContext = null;
			this.deleteConfirmBuffer = "";
			return;
		}
		try {
			this.deps.session.deleteSession(row.sessionId, { keepFiles: ctx.keepFiles });
			this.setStatus(`[tree] session ${shortTurnId(row.sessionId)} ${ctx.keepFiles ? "tombstoned" : "deleted"}`);
		} catch (err) {
			this.setStatus(formatTreeDeleteError(err), "error");
		}
		this.submode = "browse";
		this.deleteContext = null;
		this.deleteConfirmBuffer = "";
		this.refresh();
	}

	private setStatus(status: string, kind: "info" | "error" = "info"): void {
		this.status = status;
		this.statusKind = kind;
	}

	private moveHighlight(delta: number): void {
		const next = this.highlight + delta;
		if (next < 0 || next >= this.rows.length) return;
		this.highlight = next;
		this.invalidateLayout();
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
	const box = new FocusBox(view);
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: TREE_OVERLAY_WIDTH,
		title: "Tree",
		footerHint: () => view.getHint(),
	});
}
