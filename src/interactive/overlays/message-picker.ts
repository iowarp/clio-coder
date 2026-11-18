import { collectSessionEntries } from "../../domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../domains/session/entries.js";
import { filterEntriesToActivePath } from "../../domains/session/tree/active-path.js";
import { buildTurnPreview } from "../../domains/session/tree/preview.js";
import { openSession, sessionPaths } from "../../engine/session.js";
import { type Component, matchesKey, type OverlayHandle, Text, type TUI } from "../../engine/tui.js";
import { stampLocal } from "../format-time.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, emptyState } from "../theme/index.js";
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
 */
function rowsToItems(rows: ReadonlyArray<MessagePickerRow>): ChoiceItem[] {
	return rows.map((row) => ({
		value: row.turnId,
		label: row.asked ? `after “${row.asked.replaceAll("**", "")}”` : row.preview.replaceAll("**", ""),
		...(row.asked ? { description: `Clio: ${row.preview.replaceAll("**", "")}` } : {}),
		meta: formatTimestampForRow(row.at),
	}));
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
	// The list is the overlay's own child so the frame hands it the dock's
	// rows and it windows itself.
	const list = new ChoiceList(rowsToItems(rows));
	list.setSelectedIndex(
		Math.max(
			0,
			rows.findIndex((row) => row.turnId === selectedTurnId),
		),
	);
	list.onSelect = (item: ChoiceItem): void => {
		onFork(item.value);
		onClose();
	};
	list.onCancel = (): void => {
		onClose();
	};
	return list;
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
