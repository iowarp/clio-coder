import { resolve } from "node:path";
import type { SessionContract } from "../../domains/session/contract.js";
import type { TreeSnapshot, TreeSnapshotNode } from "../../domains/session/tree/navigator.js";
import {
	type Component,
	Input,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { clockLocal, dateLocal } from "../format-time.js";
import { localKey } from "../keyboard-owner.js";
import { buildHint, centeredWindow, clioError, type RowBudgetedBody, showClioOverlayFrame } from "../overlay-frame.js";
import { type ClioTheme, clioTheme, emptyState, GLYPH, positionRow, selectionRow } from "../theme/index.js";

export const TREE_OVERLAY_WIDTH = 88;
/** Rows the list shows while the frame has not said how many it has. */
const VISIBLE_ROWS = 16;
const MIN_VISIBLE_ROWS = 3;

/**
 * /tree navigator overlay. Behaviors:
 *   - One row per node, indented two spaces per branch level (not per message)
 *   - Shift+T toggles operator-local timestamps on/off
 *   - `p` filters to nodes whose session cwd matches the current cwd
 *   - `s` cycles between tree order and most recent first
 *   - `e` enters label edit submode (Enter commits, Esc cancels)
 *   - Enter on a row switches the active append point to that turn id
 *   - Esc closes the overlay
 *
 * The overlay queries `session.tree()` on open and after any mutation so
 * label edits are reflected without a close/reopen cycle.
 */
export interface OpenTreeOverlayDeps {
	session: Pick<SessionContract, "tree" | "editLabel">;
	/** The current workspace directory. Defaults to the process cwd. */
	cwd?: string;
	onSwitchTurn: (turnId: string) => void;
	onClose: () => void;
}

interface TreeRow {
	depth: number;
	/** The tree lines drawn before this row: `├ ` or `└ ` opens a branch, `│ ` continues one beside it. */
	rail?: string;
	node: TreeSnapshotNode;
	sessionId: string;
	/** This row is the session's active append point: where the next message lands. */
	isActiveTip: boolean;
	/** Enter on this row will move the append point; false for structural rows. */
	switchable: boolean;
}

type Submode = "browse" | "edit-label";

/**
 * The distinguishing end of a turn id. Ids are time-ordered, so turns written
 * in the same second share their first characters; the head made every reply
 * in a quick exchange read as the same turn.
 */
function shortTurnId(id: string): string {
	return id.length > 6 ? id.slice(-6) : id;
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
	if (close < 0) return theme.fg("menuDescription", text);
	return `${theme.fg("annotation", text.slice(0, close + 1))}${theme.fg("menuDescription", text.slice(close + 1))}`;
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
function forkParentLine(snapshot: TreeSnapshot, theme: ClioTheme): string | null {
	const parentSessionId = snapshot.meta.parentSessionId;
	if (typeof parentSessionId !== "string" || parentSessionId.length === 0) return null;
	const parentTurnId = snapshot.meta.parentTurnId;
	const at = typeof parentTurnId === "string" && parentTurnId.length > 0 ? ` at ${shortTurnId(parentTurnId)}` : "";
	return `${theme.fg("annotation", "↰ forked from ")}${theme.fg("menuDescription", `${parentSessionId}${at}`)}${theme.fg("annotation", " · /resume it to reach the turns left behind")}`;
}

function isLeaf(node: TreeSnapshotNode): boolean {
	return node.children.length === 0;
}

/**
 * `switchTurn` validates against message-tree nodes only (tree.json), so a
 * structural row that /tree draws on top of it (a compaction marker or a
 * fork's returned-from-branch summary) throws "turn not found" if Enter is
 * pressed on it. Before issue #94 the row rendered exactly like a switchable
 * one and gave no sign it would fail.
 */
function isSwitchable(node: TreeSnapshotNode): boolean {
	return node.kind !== "compaction" && node.kind !== "branch";
}

function flattenTreeSnapshot(snapshot: TreeSnapshot): TreeRow[] {
	const rows: TreeRow[] = [];
	const walk = (id: string, depth: number, rail = "", rest = ""): void => {
		const node = snapshot.nodesById[id];
		if (!node) return;
		rows.push({
			depth,
			rail,
			node,
			sessionId: snapshot.sessionId,
			isActiveTip: snapshot.leafId !== null && node.id === snapshot.leafId,
			switchable: isSwitchable(node),
		});
		// Indentation marks a fork, not a step. Every message is a child of the
		// one before it, so indenting per child made depth equal message count:
		// a seventeen-message session rendered as a seventeen-level staircase
		// that took a column off the preview every row and walked off the right
		// edge. A node with a single child continues the same line of the
		// conversation and keeps its parent's depth; only a branch point pushes
		// its children right, which is the thing the operator opened this view
		// to see.
		// Each branch opens with a rail glyph and the ones above the last keep a
		// vertical rail down their rows, so where one branch ends and the next
		// begins reads at a glance instead of as one continuous column.
		if (node.children.length > 1) {
			node.children.forEach((childId, index) => {
				const last = index === node.children.length - 1;
				walk(childId, depth + 1, `${rest}${last ? "└ " : "├ "}`, `${rest}${last ? "  " : "│ "}`);
			});
			return;
		}
		for (const childId of node.children) walk(childId, depth, rest, rest);
	};
	for (const rootId of snapshot.rootIds) walk(rootId, 0);
	return rows;
}

/**
 * Who wrote a turn, in the words the transcript uses. The stored kinds
 * ("user", "assistant", "tool_result") are the session format's vocabulary.
 */
const TREE_ROLE_WORDS: Readonly<Record<string, string>> = {
	user: "You",
	assistant: "Clio",
	tool_call: "Tool call",
	tool_result: "Tool result",
	system: "System",
	checkpoint: "Checkpoint",
	compaction: "Compacted",
	branch: "Branch",
};
const TREE_ROLE_WIDTH = 11;

/** Width budget for the inline preview cell. With no turn id in the row, a wide overlay shows most of a turn;
 * the row still clips to the overlay width below this. */
const ROW_PREVIEW_BUDGET = 96;

/**
 * One node as the label of a selection row, and its timestamp as the row's
 * metadata when timestamps are on. The row itself (cursor, clipping, the
 * right-aligned time) is the shared selection row's business.
 * @internal
 */
function formatTreeRow(
	row: TreeRow,
	opts: { showTimestamps: boolean; width: number; focused?: boolean },
): { label: string; meta?: string } {
	const theme = clioTheme();
	const indent = row.rail ?? "  ".repeat(row.depth);
	// The active tip is where the next message lands; it gets its own glyph so
	// a branched session shows exactly one live tip instead of every childless
	// node reading the same as every other (issue #94). Other leaves still get
	// a leaf glyph, just not the one that claims to be current.
	const glyph = row.isActiveTip ? GLYPH.active : isLeaf(row.node) ? GLYPH.running : "○";
	const who = TREE_ROLE_WORDS[row.node.kind] ?? row.node.kind.replace(/_/gu, " ");
	const rawPreview = row.node.preview && row.node.preview.length > 0 ? row.node.preview : fallbackPreview(row.node);
	const labelText = row.node.label ? ` · label:"${row.node.label}"` : "";
	// Enter cannot switch to a structural row (switchTurn only knows message
	// turns), so it says so instead of looking like every switchable row.
	const inertText = row.switchable ? "" : " (fixed)";
	// A plain copy of the prefix and label drives the width math; the rendered
	// versions below carry color, so every measurement uses visibleWidth.
	const plainPrefix = `${indent}${glyph} ${who.padEnd(TREE_ROLE_WIDTH)} `;
	const previewBudget = Math.min(
		ROW_PREVIEW_BUDGET,
		Math.max(1, opts.width - visibleWidth(plainPrefix) - visibleWidth(labelText) - visibleWidth(inertText)),
	);
	const preview = clampPreview(rawPreview, previewBudget);
	// The node glyph and kind are structural scaffolding and render dim; the turn
	// id and preview are content and render muted; the optional label reads as a
	// dim key with a muted value. The active tip's glyph renders in accent so it
	// stands out against every other row.
	const glyphStyled = row.isActiveTip ? theme.fg("selectedOption", glyph) : theme.fg("annotation", glyph);
	const styledPrefix = `${indent}${glyphStyled}${theme.fg("annotation", ` ${who.padEnd(TREE_ROLE_WIDTH)}`)} `;
	const styledLabel = labelText
		? `${theme.fg("annotation", " · label:")}${theme.fg("menuDescription", `"${row.node.label}"`)}`
		: "";
	const styledInert = inertText ? theme.fg("annotation", inertText) : "";
	const previewStyled = opts.focused
		? theme.style("selectedOption", preview, { bold: true })
		: theme.fg("menuOption", preview);
	const label = truncateToWidth(`${styledPrefix}${previewStyled}${styledLabel}${styledInert}`, opts.width, "", false);
	if (!opts.showTimestamps) return { label };
	return { label, meta: `${dateLocal(row.node.at)} ${clockLocal(row.node.at)}` };
}

/** @internal */
export class TreeOverlayView implements Component, RowBudgetedBody {
	private snapshot: TreeSnapshot | null;
	private rows: TreeRow[];
	private highlight = 0;
	private bodyRows = 0;
	private showTimestamps = false;
	private currentCwdOnly = false;
	private sortOrder: "tree" | "recent" = "tree";
	private submode: Submode = "browse";
	private labelBuffer = "";
	/** Labels typed and stepped out of with Esc, by turn: `e` on that turn offers the text again. */
	private readonly keptLabels = new Map<string, string>();
	private readonly labelInput = new Input();
	undoInput(): boolean {
		if (this.submode !== "edit-label") return false;
		this.labelInput.applyEdit("undo");
		this.labelBuffer = this.labelInput.getValue();
		return true;
	}
	private status = "";
	private statusKind: "info" | "error" = "info";

	constructor(
		private readonly deps: OpenTreeOverlayDeps,
		initial: TreeSnapshot | null,
	) {
		this.snapshot = initial;
		this.rows = [];
		this.rebuildRows();
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	private invalidateLayout(): void {
		if (this.rows.length === 0) {
			this.highlight = 0;
			return;
		}
		if (this.highlight >= this.rows.length) this.highlight = this.rows.length - 1;
		if (this.highlight < 0) this.highlight = 0;
	}

	private currentRow(): TreeRow | null {
		return this.rows[this.highlight] ?? null;
	}

	private rebuildRows(): void {
		const selectedId = this.currentRow()?.node.id;
		const snapshot = this.snapshot;
		const matchesCwd = snapshot?.meta.cwd && resolve(snapshot.meta.cwd) === resolve(this.deps.cwd ?? process.cwd());
		this.rows = snapshot && (!this.currentCwdOnly || matchesCwd) ? flattenTreeSnapshot(snapshot) : [];
		if (this.sortOrder === "recent") {
			this.rows.sort((a, b) => Date.parse(b.node.at) - Date.parse(a.node.at));
			this.rows = this.rows.map((row) => ({ ...row, depth: 0, rail: "" }));
		}
		const selectedIndex = this.rows.findIndex((row) => row.node.id === selectedId);
		this.highlight = selectedIndex < 0 ? 0 : selectedIndex;
		this.invalidateLayout();
	}

	private refresh(): void {
		try {
			this.snapshot = this.deps.session.tree();
		} catch {
			this.snapshot = null;
		}
		this.rebuildRows();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width);
		const theme = clioTheme();
		const lines: string[] = [];
		const lineage = this.snapshot ? forkParentLine(this.snapshot, theme) : null;
		if (lineage !== null) lines.push(truncateToWidth(lineage, contentWidth, "", true));
		// What the marks and Enter mean, said once above the turns while there is room for it.
		const guide =
			this.rows.length > 0 && (this.bodyRows === 0 || this.bodyRows >= MIN_VISIBLE_ROWS + 3)
				? theme.fg(
						"annotation",
						`${GLYPH.active} is where your next message goes and ${GLYPH.running} ends another branch. Enter on an earlier turn continues from there; later turns stay as a branch.`,
					)
				: null;
		if (guide !== null) lines.push(...wrapTextWithAnsi(guide, contentWidth));
		if (this.rows.length === 0) {
			// The overlay navigates the CURRENT session's turn tree; an empty
			// tree means no turns yet, not a missing session list.
			lines.push(
				...(this.currentCwdOnly && this.snapshot && Object.keys(this.snapshot.nodesById).length > 0
					? emptyState(theme, "no turns match the current cwd", contentWidth, { remedy: "p shows all" })
					: emptyState(theme, "no turns in this session yet", contentWidth)),
			);
		} else {
			// The list takes what the lineage, the label editor and the status
			// leave, and gives one row back to the position line while rows hide.
			const chrome =
				(lineage !== null ? 1 : 0) +
				(guide !== null ? wrapTextWithAnsi(guide, contentWidth).length : 0) +
				(this.submode === "edit-label" ? 1 : 0) +
				(this.status ? 1 : 0);
			const budget = Math.max(MIN_VISIBLE_ROWS, (this.bodyRows > 0 ? this.bodyRows : VISIBLE_ROWS) - chrome);
			const windowed = this.rows.length > budget;
			const visible = windowed ? Math.max(1, budget - 1) : budget;
			const [start, end] = centeredWindow(this.rows.length, this.highlight, visible);
			for (let i = start; i < end; i++) {
				const row = this.rows[i];
				if (!row) continue;
				const focused = i === this.highlight;
				const cell = formatTreeRow(row, {
					showTimestamps: this.showTimestamps,
					focused,
					width: Math.max(1, contentWidth - 2),
				});
				lines.push(
					...selectionRow(theme, {
						focused,
						label: cell.label,
						...(cell.meta === undefined ? {} : { meta: cell.meta }),
						width: contentWidth,
					}),
				);
			}
			if (windowed)
				lines.push(positionRow(theme, { start: start + 1, end, total: this.rows.length, unit: "turns" }, contentWidth));
		}
		if (this.submode === "edit-label") {
			// The label editor is the same `> text` input every list overlay shows;
			// it used to be a footer string with a fake `_` caret that never moved.
			this.labelInput.focused = true;
			lines.push(...this.labelInput.render(contentWidth));
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
			return buildHint([{ key: "Enter", verb: "commit label" }], "back, keeps draft");
		}
		// Each toggle names its current setting in words, not a field:value code.
		return buildHint([
			{ key: "↑↓", verb: "move" },
			{ key: "Enter", verb: "continue from here" },
			{ key: "e", verb: "label" },
			{ key: "p", verb: `folder: ${this.currentCwdOnly ? "this" : "all"}` },
			{ key: "s", verb: `order: ${this.sortOrder === "tree" ? "tree" : "newest"}` },
			{ key: "Shift+T", verb: `times: ${this.showTimestamps ? "on" : "off"}` },
		]);
	}

	invalidate(): void {}

	get keyboardScope(): "edit" | "browse" {
		return this.submode === "edit-label" ? "edit" : "browse";
	}
	handleInput(data: string): void {
		data = localKey(data);
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
		if (data === "p") {
			this.currentCwdOnly = !this.currentCwdOnly;
			this.rebuildRows();
			return;
		}
		if (data === "s") {
			this.sortOrder = this.sortOrder === "tree" ? "recent" : "tree";
			this.rebuildRows();
			return;
		}
		// Filtering and sorting remain available when the visible list is empty.
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
			if (!row.switchable) {
				this.setStatus(
					`${TREE_ROLE_WORDS[row.node.kind] ?? row.node.kind} rows mark a moment in the timeline; they are not a place to switch to.`,
				);
				return;
			}
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
			const node = this.currentRow()?.node;
			this.labelBuffer = (node ? this.keptLabels.get(node.id) : undefined) ?? node?.label ?? "";
			this.labelInput.setValue(this.labelBuffer);
			this.labelInput.handleInput("\x1b[F");
			this.setStatus("");
			return;
		}
	}

	private handleLabelInput(data: string): void {
		// Esc leaves the field and keeps an unsaved label for the next `e` on the same turn.
		if (matchesKey(data, "esc")) {
			const node = this.currentRow()?.node;
			const changed = node !== undefined && this.labelBuffer !== (node.label ?? "");
			if (node && changed) this.keptLabels.set(node.id, this.labelBuffer);
			else if (node) this.keptLabels.delete(node.id);
			this.submode = "browse";
			this.labelBuffer = "";
			this.setStatus(changed ? "Draft kept · e reopens it" : "");
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
				this.keptLabels.delete(row.node.id);
				this.setStatus(this.labelBuffer.trim() ? `Label saved on this turn.` : "Label removed from this turn.");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.setStatus(`Clio could not save the label: ${msg}`, "error");
			}
			this.submode = "browse";
			this.labelBuffer = "";
			this.refresh();
			return;
		}
		this.labelInput.handleInput(data);
		this.labelBuffer = this.labelInput.getValue();
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

function loadInitialSnapshot(session: OpenTreeOverlayDeps["session"]): TreeSnapshot | null {
	try {
		return session.tree();
	} catch {
		return null;
	}
}

export function openTreeOverlay(tui: TUI, deps: OpenTreeOverlayDeps): OverlayHandle {
	const initial = loadInitialSnapshot(deps.session);
	// The view is the frame's own child so it receives the dock's row budget.
	const view = new TreeOverlayView(deps, initial);
	return showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: TREE_OVERLAY_WIDTH,
		markerId: "tree",
		title: "Session Tree",
		footerHint: () => view.getHint(),
	});
}
