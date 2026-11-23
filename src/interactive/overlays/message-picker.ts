import { tierPolicy, tierRevision } from "../../core/presentation-tier.js";
import { collectSessionEntries } from "../../domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../domains/session/entries.js";
import { filterEntriesToActivePath } from "../../domains/session/tree/active-path.js";
import { buildTurnPreview } from "../../domains/session/tree/preview.js";
import { openSession, sessionPaths } from "../../engine/session.js";
import { type Component, matchesKey, type OverlayHandle, Text, type TUI, truncateToWidth } from "../../engine/tui.js";
import { clockLocal, dateLocal, stampLocal } from "../format-time.js";
import { buildResponsiveHint, FocusBox, type RowBudgetedBody, showClioOverlayFrame } from "../overlay-frame.js";
import { type ClioTheme, clioTheme, emptyState, type Fact, factRows, GLYPH, sectionRule } from "../theme/index.js";
import { type ChoiceItem, ChoiceList } from "./settings-submenus.js";

export const MESSAGE_PICKER_OVERLAY_WIDTH = 88;
const PREVIEW_WIDTH = 60;

/**
 * /fork picker. Lists the current session's prompts, most-recent first, each
 * forking after the last assistant reply of its turn. Selecting a row
 * calls onFork(parentTurnId); the caller wires that through
 * SessionContract.fork(parentTurnId).
 *
 * Scope: current-session turns only. A multi-session picker is not
 * implemented; it would need TreeSnapshot to carry a payload preview field.
 */
export interface OpenMessagePickerOverlayDeps {
	session: SessionContract;
	onFork: (parentTurnId: string) => void;
	onClose: () => void;
}

export interface MessagePickerRow {
	turnId: string;
	at: string;
	preview: string;
	/** The operator message this reply answered, which is what tells otherwise similar replies apart. */
	asked?: string;
}

/**
 * Pure transformer: given the persisted messages of a session, return one row
 * per operator prompt in reverse-chronological order. A prompt's turn can hold
 * many assistant replies (one per tool round), and listing each repeated the
 * same `after "…"` label; the row forks after the turn's last reply instead.
 * Where /tree left several reply chains under one prompt, the chain on the
 * active path wins, so the row the picker opens on is the active leaf. A
 * ledger whose parent links have gaps falls back to the prompt before the
 * reply in the file.
 */
export function buildMessagePickerRows(
	entries: ReadonlyArray<SessionEntry>,
	activeTurnIds: ReadonlySet<string> = new Set(),
): MessagePickerRow[] {
	const byId = new Map(entries.map((entry) => [entry.turnId, entry]));
	const promptOf = (turn: MessageEntry): MessageEntry | undefined => {
		const seen = new Set<string>();
		let parentId = turn.parentTurnId;
		while (parentId && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) return undefined;
			if (parent.kind === "message" && parent.role === "user") return parent;
			parentId = parent.parentTurnId;
		}
		return undefined;
	};
	const forkPoints = new Map<string, { reply: MessageEntry; prompt?: MessageEntry }>();
	let previousPrompt: MessageEntry | undefined;
	for (const turn of entries) {
		if (turn.kind !== "message") continue;
		if (turn.role === "user") previousPrompt = turn;
		if (turn.role !== "assistant") continue;
		const prompt = promptOf(turn) ?? previousPrompt;
		const key = prompt?.turnId ?? turn.turnId;
		const held = forkPoints.get(key);
		if (held && activeTurnIds.has(held.reply.turnId) && !activeTurnIds.has(turn.turnId)) continue;
		forkPoints.set(key, { reply: turn, ...(prompt ? { prompt } : {}) });
	}
	const order = new Map(entries.map((entry, index) => [entry.turnId, index]));
	return [...forkPoints.values()]
		.sort((a, b) => (order.get(b.reply.turnId) ?? 0) - (order.get(a.reply.turnId) ?? 0))
		.map(({ reply, prompt }) => ({
			turnId: reply.turnId,
			at: reply.timestamp,
			preview: buildTurnPreview({ kind: "assistant", payload: reply.payload }, PREVIEW_WIDTH),
			...(prompt ? { asked: buildTurnPreview({ kind: "user", payload: prompt.payload }, PREVIEW_WIDTH) } : {}),
		}));
}

/** The one local time format: the clock alone for today, the date as well for any other day. */
function formatTimestampForRow(timestamp: string): string {
	const millis = Date.parse(timestamp);
	if (!Number.isFinite(millis)) return "";
	return stampLocal(millis);
}

/**
 * The preview is the label, because turn ids in a session share their
 * time-ordered prefix and say nothing; the time sits at the right as the
 * row's metadata, where the selection row compacts it before the preview.
 * The reply line under each row shows from standard up; compact keeps one
 * row per prompt and says the selection's reply on the status row.
 */
function rowsToItems(rows: ReadonlyArray<MessagePickerRow>, describe: boolean): ChoiceItem[] {
	return rows.map((row) => ({
		value: row.turnId,
		label: row.asked
			? `after ${GLYPH.quoteOpen}${row.asked.replaceAll("**", "")}${GLYPH.quoteClose}`
			: row.preview.replaceAll("**", ""),
		...(row.asked && describe ? { description: replyLine(row) } : {}),
		meta: formatTimestampForRow(row.at),
	}));
}

function replyLine(row: MessagePickerRow): string {
	return `CLIO Coder: ${row.preview.replaceAll("**", "")}`;
}

/**
 * What the tier adds for the selected row under the list: at compact one status row naming the reply the fork
 * keeps; at detailed a titled pane with the turn id, the full time, the prompt and the reply.
 */
function forkDetail(theme: ClioTheme, row: MessagePickerRow, width: number): string[] {
	const detail = tierPolicy().pickerDetail;
	if (detail === "status") {
		const status = row.asked ? replyLine(row) : `forks after this reply ${GLYPH.sep} ${formatTimestampForRow(row.at)}`;
		return [truncateToWidth(theme.fg("annotation", status), width, GLYPH.ellipsis, false)];
	}
	if (detail !== "pane") return [];
	const millis = Date.parse(row.at);
	const facts: Fact[] = [
		{ label: "turn", value: row.turnId, fit: "clip" },
		...(Number.isFinite(millis) ? [{ label: "at", value: `${dateLocal(row.at)} ${clockLocal(row.at)}` }] : []),
		...(row.asked ? [{ label: "asked", value: row.asked.replaceAll("**", "") }] : []),
		{ label: "reply", value: row.preview.replaceAll("**", "") },
		{ label: "keeps", value: "every turn up to this reply; later turns stay in this session" },
	];
	return [
		sectionRule(theme, width, "Fork point", { meta: row.turnId.length > 6 ? row.turnId.slice(-6) : row.turnId }),
		...factRows(theme, facts, width, { stack: "never" }),
	];
}

/**
 * The list and what the tier shows for its selection. The list is rebuilt when the tier changes, keeping the
 * selected row, so its reply lines follow the tier; the frame's row budget is shared out after the detail rows.
 */
class ForkPickerBody implements Component, RowBudgetedBody {
	private list: ChoiceList;
	private builtRevision: number;
	private bodyRows = 0;

	constructor(
		private readonly rows: ReadonlyArray<MessagePickerRow>,
		private readonly onFork: (parentTurnId: string) => void,
		private readonly onClose: () => void,
		selectedIndex: number,
	) {
		this.builtRevision = tierRevision();
		this.list = this.buildList(selectedIndex);
	}

	private buildList(selectedIndex: number): ChoiceList {
		const list = new ChoiceList(rowsToItems(this.rows, tierPolicy().pickerDetail !== "status"));
		list.setSelectedIndex(selectedIndex);
		list.onSelect = (item: ChoiceItem): void => {
			this.onFork(item.value);
			this.onClose();
		};
		list.onCancel = (): void => {
			this.onClose();
		};
		return list;
	}

	private selectedIndex(): number {
		const value = this.list.getSelectedItem()?.value;
		return Math.max(
			0,
			this.rows.findIndex((row) => row.turnId === value),
		);
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		if (this.builtRevision !== tierRevision()) {
			this.builtRevision = tierRevision();
			this.list = this.buildList(this.selectedIndex());
		}
		const row = this.rows[this.selectedIndex()];
		const detail = row ? forkDetail(clioTheme(), row, Math.max(1, width)) : [];
		this.list.setBodyRows(this.bodyRows > 0 ? Math.max(1, this.bodyRows - detail.length) : 0);
		return [...this.list.render(width), ...detail];
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {}
}

function createMessagePickerContent(
	rows: ReadonlyArray<MessagePickerRow>,
	onFork: (parentTurnId: string) => void,
	onClose: () => void,
	selectedTurnId?: string,
): Component {
	if (rows.length === 0) {
		const empty = emptyState(clioTheme(), "No assistant turns to fork.", MESSAGE_PICKER_OVERLAY_WIDTH - 4, {
			remedy: "Esc closes",
		});
		return new FocusBox(new Text(empty.join("\n"), 0, 0), {
			onInput: (data) => {
				if (matchesKey(data, "esc")) onClose();
			},
		});
	}
	// The body is the overlay's own child so the frame hands it the dock's
	// rows; it gives the list what its detail rows leave and the list windows itself.
	return new ForkPickerBody(
		rows,
		onFork,
		onClose,
		Math.max(
			0,
			rows.findIndex((row) => row.turnId === selectedTurnId),
		),
	);
}

export function openMessagePickerOverlay(tui: TUI, deps: OpenMessagePickerOverlayDeps): OverlayHandle {
	const current = deps.session.current();
	// Caller is expected to short-circuit when there is no current session;
	// this path renders an empty list rather than throwing so the overlay is
	// resilient if the session closes between /fork and handler dispatch.
	const reader = current ? openSession(current.id) : null;
	const entries = reader ? collectSessionEntries(reader.turns(), sessionPaths(reader.meta()).current) : [];
	const activePath = filterEntriesToActivePath(entries, deps.session.leafId() ?? undefined);
	const rows = buildMessagePickerRows(entries, new Set(activePath.map((entry) => entry.turnId)));
	// Enter on open forks after the newest reply on the active /tree path, not a
	// newer abandoned sibling, as the retired /branch did (#444).
	const newest = activePath.reverse().find((entry) => entry.kind === "message" && entry.role === "assistant");
	const box = createMessagePickerContent(
		rows,
		(parentTurnId) => deps.onFork(parentTurnId),
		() => deps.onClose(),
		newest?.turnId,
	);
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: MESSAGE_PICKER_OVERLAY_WIDTH,
		markerId: "message-picker",
		title: "Fork into a new session; workspace files stay unchanged",
		footerHint: buildResponsiveHint(
			rows.length > 0 ? [{ key: "Enter", verb: "fork after this reply", short: "fork" }] : [],
			"close",
		),
	});
}
