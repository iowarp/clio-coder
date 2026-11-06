import { collectSessionEntries } from "../../domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { MessageEntry } from "../../domains/session/entries.js";
import { buildTurnPreview } from "../../domains/session/tree/preview.js";
import { openSession, sessionPaths } from "../../engine/session.js";
import { type Component, matchesKey, type OverlayHandle, Text, type TUI } from "../../engine/tui.js";
import { clockLocal, dateLocal } from "../format-time.js";
import { buildHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, emptyState } from "../theme/index.js";
import { type ChoiceItem, ChoiceList } from "./settings-submenus.js";

export const MESSAGE_PICKER_OVERLAY_WIDTH = 88;
const PREVIEW_WIDTH = 60;

/**
 * /fork picker. Lists the current session's assistant turns, most-recent first,
 * with a structured assistant preview as the row label. Selecting a row
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
 * Pure transformer: given the persisted JSONL records of a session, return one
 * row per assistant turn in reverse-chronological order. Exposed for unit
 * tests so the overlay layer stays render-only.
 */
function buildMessagePickerRows(turns: ReadonlyArray<MessageEntry>): MessagePickerRow[] {
	const rows: MessagePickerRow[] = [];
	let asked: string | undefined;
	for (const turn of turns) {
		if (turn.role === "user") {
			asked = buildTurnPreview({ kind: "user", payload: turn.payload }, PREVIEW_WIDTH);
			continue;
		}
		if (turn.role !== "assistant") continue;
		rows.push({
			turnId: turn.turnId,
			at: turn.timestamp,
			preview: buildTurnPreview({ kind: "assistant", payload: turn.payload }, PREVIEW_WIDTH),
			...(asked !== undefined ? { asked } : {}),
		});
	}
	return rows.reverse();
}

function formatTimestampForRow(timestamp: string): string {
	const millis = Date.parse(timestamp);
	if (!Number.isFinite(millis)) return "";
	return `${dateLocal(millis)} ${clockLocal(millis)}`;
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
	const messages = entries.filter((entry): entry is MessageEntry => entry.kind === "message");
	const rows = buildMessagePickerRows(messages);
	const box = createMessagePickerContent(
		rows,
		(parentTurnId) => deps.onFork(parentTurnId),
		() => deps.onClose(),
	);
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: MESSAGE_PICKER_OVERLAY_WIDTH,
		markerId: "message-picker",
		title: "Fork into a new session; workspace files stay unchanged",
		footerHint: rows.length > 0 ? buildHint([{ key: "Enter", verb: "fork after this reply" }]) : buildHint([]),
	});
}
