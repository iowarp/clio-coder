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
import { type ClioTheme, clioTheme, GLYPH } from "../theme/index.js";

export const TREE_OVERLAY_WIDTH = 88;
const VISIBLE_ROWS = 16;

/**
 * /tree navigator overlay. Phase 12 slice 12b-2 behaviors only:
 *   - One row per node, indented two spaces per branch level (not per message)
 *   - Shift+T toggles ISO timestamps on/off
 *   - `e` enters label edit submode (Enter commits, Esc cancels)
 *   - Enter on a row switches the active append point to that turn id
 *   - Esc closes the overlay
 *
 * Cwd-toggle (`p`) and sort-order (`s`) land in Phase 18.
 *
 * The overlay queries `session.tree()` on open and after any mutation so
 * label edits are reflected without a close/reopen cycle.
 */
export interface OpenTreeOverlayDeps {
	session: SessionContract;
	onSwitchTurn: (turnId: string) => void;
	onClose: () => void;
}

interface TreeRow {
	depth: number;
	node: TreeSnapshotNode;
	sessionId: string;
}

type Submode = "browse" | "edit-label";

function shortTurnId(id: string): string {
	return id.length > 6 ? id.slice(0, 6) : id;
}

function clampPreview(text: string, max: number): string {
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/**
 * Paint a bracketed status notice: the `[tag]` reads dim and the message muted.
 * A status with no bracketed tag falls back to muted so it never renders plain.
 */
function bracketNotice(theme: ClioTheme, text: string): string {
	const close = text.indexOf("] ");
	if (close < 0) return theme.fg("muted", text);
	return `${theme.fg("dim", text.slice(0, close + 1))}${theme.fg("muted", text.slice(close + 1))}`;
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
		case "compaction":
			return "(history compacted)";
		case "branch":
			return "(branch returned)";
		default:
			return `(${node.kind})`;
	}
}

/**
 * The lineage row for a forked session. A fork writes `parentSessionId` and
 * `parentTurnId` into its own meta.json and nothing else records the split, so
 * without this the navigator showed a fork and its parent as the same flat list
 * of turns and the discarded branch had no route back. Returns null for a
 * session that was not forked.
 */
export function forkParentLine(snapshot: TreeSnapshot, theme: ClioTheme): string | null {
	const parentSessionId = snapshot.meta.parentSessionId;
	if (typeof parentSessionId !== "string" || parentSessionId.length === 0) return null;
	const parentTurnId = snapshot.meta.parentTurnId;
	const at = typeof parentTurnId === "string" && parentTurnId.length > 0 ? ` at ${shortTurnId(parentTurnId)}` : "";
	return `${theme.fg("dim", "↰ forked from ")}${theme.fg("muted", `${parentSessionId}${at}`)}${theme.fg("dim", " · /resume it to reach the turns left behind")}`;
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
		// Indentation marks a fork, not a step. Every message is a child of the
		// one before it, so indenting per child made depth equal message count:
		// a seventeen-message session rendered as a seventeen-level staircase
		// that took a column off the preview every row and walked off the right
		// edge. A node with a single child continues the same line of the
		// conversation and keeps its parent's depth; only a branch point pushes
		// its children right, which is the thing the operator opened this view
		// to see.
		const childDepth = node.children.length > 1 ? depth + 1 : depth;
		for (const childId of node.children) walk(childId, childDepth);
	};
	for (const rootId of snapshot.rootIds) walk(rootId, 0);
	return rows;
}

/** Width budget for the inline preview cell. Sized so the surrounding indent,
 * role marker, and short turn id still fit on an 88-column overlay. */
const ROW_PREVIEW_BUDGET = 55;

/** @internal */
export function formatTreeRow(row: TreeRow, opts: { showTimestamps: boolean; width: number }): string {
	const theme = clioTheme();
	const indent = "  ".repeat(row.depth);
	const glyph = isLeaf(row.node) ? GLYPH.running : "○";
	const turnId = shortTurnId(row.node.id);
	const rawPreview = row.node.preview && row.node.preview.length > 0 ? row.node.preview : fallbackPreview(row.node);
	const labelText = row.node.label ? ` · label:"${row.node.label}"` : "";
	// A plain copy of the prefix and label drives the width math; the rendered
	// versions below carry color, so every measurement uses visibleWidth.
	const plainPrefix = `${indent}${glyph} ${row.node.kind.padEnd(12)} ${turnId}  `;
	const previewBudget = Math.min(
		ROW_PREVIEW_BUDGET,
		Math.max(1, opts.width - visibleWidth(plainPrefix) - visibleWidth(labelText)),
	);
	const preview = clampPreview(rawPreview, previewBudget);
	// The node glyph and kind are structural scaffolding and render dim; the turn
	// id and preview are content and render muted; the optional label reads as a
	// dim key with a muted value.
	const styledPrefix = `${theme.fg("dim", `${indent}${glyph} ${row.node.kind.padEnd(12)}`)} ${theme.fg("muted", turnId)}  `;
	const styledLabel = labelText ? `${theme.fg("dim", " · label:")}${theme.fg("muted", `"${row.node.label}"`)}` : "";
	const main = `${styledPrefix}${theme.fg("muted", preview)}${styledLabel}`;
	if (!opts.showTimestamps) return truncateToWidth(main, opts.width, "", true);
	const ts = row.node.at.slice(0, 19).replace("T", " ");
	if (opts.width < ts.length + 12) return truncateToWidth(main, opts.width, "", true);
	const budget = Math.max(1, opts.width - ts.length - 2);
	const primary = truncateToWidth(main, budget, "", true);
	const pad = " ".repeat(Math.max(1, opts.width - visibleWidth(primary) - ts.length));
	return `${primary}${pad}${theme.fg("dim", ts)}`;
}

/** @internal */
export class TreeOverlayView implements Component {
	private snapshot: TreeSnapshot | null;
	private rows: TreeRow[];
	private highlight = 0;
	private scrollTop = 0;
	private showTimestamps = false;
	private submode: Submode = "browse";
	private labelBuffer = "";
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
		const theme = clioTheme();
		const lines: string[] = [];
		const lineage = this.snapshot ? forkParentLine(this.snapshot, theme) : null;
		if (lineage !== null) lines.push(truncateToWidth(lineage, contentWidth, "", true));
		if (this.rows.length === 0) {
			// The overlay navigates the CURRENT session's turn tree; an empty
			// tree means no turns yet, not a missing session list.
			lines.push(theme.fg("muted", "(no turns in this session yet)"));
		} else {
			const end = Math.min(this.rows.length, this.scrollTop + VISIBLE_ROWS);
			for (let i = this.scrollTop; i < end; i++) {
				const row = this.rows[i];
				if (!row) continue;
				const focused = i === this.highlight;
				const prefix = focused ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
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
			// A status is a bracketed notice: the tag reads dim and the message
			// muted, except a failure which renders red end to end.
			const colored = this.statusKind === "error" ? clioError(this.status) : bracketNotice(theme, this.status);
			lines.push(truncateToWidth(colored, contentWidth, "", true));
		}
		return lines;
	}

	getHint(): string {
		return this.footerText();
	}

	private footerText(): string {
		if (this.submode === "edit-label") {
			return `label: ${this.labelBuffer}_  ${buildHint([{ key: "Enter", verb: "commit" }], "back")}`;
		}
		const tsLabel = this.showTimestamps ? "on" : "off";
		return buildHint([
			{ key: "↑↓", verb: "move" },
			{ key: "Enter", verb: "switch" },
			{ key: "e", verb: "label" },
			{ key: "Shift+T", verb: `ts:${tsLabel}` },
		]);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.submode === "edit-label") {
			this.handleLabelInput(data);
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
			this.deps.onSwitchTurn(row.node.id);
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
