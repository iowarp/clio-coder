import { collectSessionEntries } from "../../domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { MessageEntry } from "../../domains/session/entries.js";
import { openSession } from "../../engine/session.js";
import { type OverlayHandle, type SelectItem, SelectList, type TUI } from "../../engine/tui.js";
import { DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";

export const MESSAGE_PICKER_OVERLAY_WIDTH = 88;
const VISIBLE_ROWS = 12;
const PREVIEW_WIDTH = 60;

/**
 * /fork picker. Lists the current session's assistant turns, most-recent first,
 * with the first line of the assistant text as the row label. Selecting a row
 * calls onFork(parentTurnId); the caller wires that through
 * SessionContract.fork(parentTurnId).
 *
 * Phase 12 slice 12b-3 scope: current-session turns only. Multi-session picker
 * lives in a later slice once TreeSnapshot grows a payload preview field.
 */
export interface OpenMessagePickerOverlayDeps {
	session: SessionContract;
	onFork: (parentTurnId: string) => void;
	onClose: () => void;
}

function shortTurnId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Coerce a ClioTurnRecord payload into a preview string. Handles the common
 * shapes the assistant writer produces: raw string, `{text}`, and pi-ai's
 * `{content: [{type:"text", text}]}`. Anything unrecognizable returns "".
 */
function payloadPreview(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const p = payload as Record<string, unknown>;
	if (typeof p.text === "string") return p.text;
	if (Array.isArray(p.content)) {
		for (const block of p.content) {
			if (block && typeof block === "object") {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") return b.text;
			}
		}
	}
	return "";
}

function firstLineClamped(text: string, max: number): string {
	const firstLine = text.split("\n", 1)[0] ?? "";
	const trimmed = firstLine.trim();
	if (trimmed.length === 0) return "(no text)";
	return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

interface MessagePickerRow {
	turnId: string;
	shortId: string;
	at: string;
	preview: string;
}

/**
 * Pure transformer: given the persisted JSONL records of a session, return one
 * row per assistant turn in reverse-chronological order. Exposed for unit
 * tests so the overlay layer stays render-only.
 */
function buildMessagePickerRows(turns: ReadonlyArray<unknown>): MessagePickerRow[] {
	const assistantTurns = collectSessionEntries(turns).filter(
		(entry): entry is MessageEntry => entry.kind === "message" && entry.role === "assistant",
	);
	const rows: MessagePickerRow[] = [];
	for (let i = assistantTurns.length - 1; i >= 0; i--) {
		const turn = assistantTurns[i];
		if (!turn) continue;
		rows.push({
			turnId: turn.turnId,
			shortId: shortTurnId(turn.turnId),
			at: turn.timestamp,
			preview: firstLineClamped(payloadPreview(turn.payload), PREVIEW_WIDTH),
		});
	}
	return rows;
}

function rowsToItems(rows: ReadonlyArray<MessagePickerRow>): SelectItem[] {
	return rows.map((row) => ({
		value: row.turnId,
		label: `● ${row.shortId}  ${row.preview}`,
		description: row.at ? new Date(row.at).toISOString().slice(0, 16).replace("T", " ") : "",
	}));
}

export function openMessagePickerOverlay(tui: TUI, deps: OpenMessagePickerOverlayDeps): OverlayHandle {
	const current = deps.session.current();
	// Caller is expected to short-circuit when there is no current session;
	// this path renders an empty list rather than throwing so the overlay is
	// resilient if the session closes between /fork and handler dispatch.
	const turns = current ? openSession(current.id).turns() : [];
	const rows = buildMessagePickerRows(turns);
	const items = rowsToItems(rows);
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length));
	const list = new SelectList(items, visible, DEFAULT_SELECT_THEME);
	list.onSelect = (item: SelectItem): void => {
		deps.onFork(item.value);
		deps.onClose();
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new FocusBox(list);
	return showClioOverlayFrame(tui, box, { anchor: "center", width: MESSAGE_PICKER_OVERLAY_WIDTH, title: "Fork" });
}
