import { basename } from "node:path";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import type { SessionContract, SessionMeta } from "../../domains/session/index.js";
import { liveSessionOwner } from "../../domains/session/live-owner.js";
import type { TuiMouseEvent, TuiMouseEventResult } from "../../engine/tui.js";
import {
	getKeybindings,
	Input,
	matchesKey,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
	truncateToWidth,
} from "../../engine/tui.js";
import { backOutOneLayer, type EscapeLayers, escapeHintEntry } from "../escape-layers.js";
import { relative } from "../format-time.js";
import {
	buildResponsiveHint,
	centeredWindow,
	DEFAULT_SELECT_THEME,
	FILTER_HINT,
	FocusBox,
	showClioOverlayFrame,
} from "../overlay-frame.js";
import { clioTheme, emptyState, GLYPH, positionRow, selectionRow } from "../theme/index.js";
import { filterSessions } from "./session-selector-search.js";

export const SESSION_OVERLAY_WIDTH = 110;
const VISIBLE_ROWS = 6;
export const SESSION_ESCAPE_GRACE_MS = 75;
const ESC = String.fromCharCode(27);

/** A session row: the label the list selects by, when it last moved, and the strip under it. */
interface SessionItem extends SelectItem {
	when: string;
}

/**
 * Session metadata gets its own row so a narrow picker never drops it
 * (flywheel r4/5). Each session is a selection row: the name or first message
 * with its age at the right, and the turn count, folder and route beneath,
 * clipped to one row so every session costs the same two.
 */
class SessionSelectList extends SelectList {
	constructor(
		private readonly sessionItems: SessionItem[],
		private readonly visibleSessions: number,
	) {
		super(sessionItems, visibleSessions, DEFAULT_SELECT_THEME);
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const theme = clioTheme();
		const selected = Math.max(
			0,
			this.sessionItems.findIndex((item) => item.value === this.getSelectedItem()?.value),
		);
		const [start, end] = centeredWindow(this.sessionItems.length, selected, this.visibleSessions);
		const rows: string[] = [];
		for (let index = start; index < end; index++) {
			const item = this.sessionItems[index];
			if (!item) continue;
			rows.push(
				...selectionRow(theme, {
					focused: index === selected,
					label: item.label,
					meta: item.when,
					description: truncateToWidth(item.description ?? "", Math.max(1, width - 4), GLYPH.ellipsis, false),
					width,
				}),
			);
		}
		if (start > 0 || end < this.sessionItems.length)
			rows.push(
				positionRow(
					theme,
					{ start: start + 1, end, total: this.sessionItems.length, unit: "sessions", keys: ["PgUp/PgDn page"] },
					width,
				),
			);
		return rows;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return super.handleMouse({ ...event, y: Math.floor(event.y / 2) });
	}
}

/**
 * Format an ISO-8601 instant as a human-relative string ("3 minutes ago",
 * "yesterday", "2026-04-12"). Mirrors common coding-tool resume pickers so
 * users do not have to read raw timestamps. The absent case is the picker's
 * own: a session row can carry no activity instant at all.
 */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
	return iso ? relative(iso, now) : "—";
}

/** The session's connection and model the way the composer names them: `mock · mock/judge-model`. */
function shortTarget(meta: SessionMeta): string {
	const target = sanitizeCallTargetText(meta.target ?? "");
	const model = sanitizeCallTargetText(meta.model ?? "");
	if (!target && !model) return "no target";
	if (target && model) return `${target} · ${model}`;
	return target || model || "no target";
}

function previewLine(meta: SessionMeta): string {
	const fork = meta.parentSessionId ? `Fork ${sanitizeCallTargetText(meta.id).slice(0, 6)} · ` : "";
	const name = sanitizeCallTargetText(meta.name ?? "");
	if (name) return `${fork}${name}`;
	const explicit = sanitizeCallTargetText(meta.firstMessagePreview ?? "");
	if (explicit) return `${fork}${explicit}`;
	const cwdLeaf = sanitizeCallTargetText(meta.cwd ? basename(meta.cwd) : "");
	const id = sanitizeCallTargetText(meta.id) || "Unnamed session";
	return `${id} · ${cwdLeaf || "no preview"}`;
}

function metaStrip(meta: SessionMeta): string {
	// Closing a session does not establish that its run succeeded. A session that
	// never ended reads as running only while its owning process is (#420).
	const status = liveSessionOwner(meta) ? GLYPH.running : GLYPH.queued;
	const count = typeof meta.messageCount === "number" ? meta.messageCount : 0;
	const countLabel = count === 1 ? "1 turn" : `${count} turns`;
	const folder = sanitizeCallTargetText(meta.cwd ? basename(meta.cwd) : "") || "no folder";
	// meta.json describes the session, not its spend; the picker shows no spend (#434).
	return `${status} ${countLabel} · ${folder} · ${shortTarget(meta)}`;
}

/**
 * The saved name, first message or fallback identity stays visible as metadata yields.
 * Keep the canonical ID as the selection value, independent of display text.
 */
function buildSessionItems(sessions: ReadonlyArray<SessionMeta>, now: number = Date.now()): SessionItem[] {
	return sessions.map((meta) => {
		const labels = meta.labels?.map(sanitizeCallTargetText).filter(Boolean).join(", ");
		const details = [metaStrip(meta), labels ? `labels: ${labels}` : ""].filter(Boolean);
		return {
			value: meta.id,
			label: previewLine(meta),
			description: details.join(" · "),
			when: formatRelativeTime(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt, now),
		};
	});
}

export interface OpenSessionOverlayDeps {
	session: SessionContract;
	onResume: (sessionId: string) => void;
	onClose: () => void;
	/** Prefills the search box, so `/resume <id>` that missed opens already filtered. */
	initialQuery?: string;
}

/**
 * SelectList navigation keys (arrows + Enter) route to the list; everything
 * else feeds the search Input which live-filters the candidate set. pi-tui key
 * matching avoids treating fragmented arrow escape sequences as overlay close.
 */
function isLikelyCompleteEscapeSequence(data: string): boolean {
	if (!data.startsWith(ESC)) return false;
	const rest = data.slice(1);
	if (/^\[[0-9;:?]*[A-Za-z~]$/.test(rest)) return true;
	return /^O.$/.test(rest);
}

function isPotentialEscapeSequence(data: string): boolean {
	if (isBareEscape(data)) return true;
	if (!data.startsWith(ESC)) return false;
	if (`${ESC}[`.startsWith(data) || `${ESC}O`.startsWith(data)) return true;
	if (data.startsWith(`${ESC}[`)) return !isLikelyCompleteEscapeSequence(data);
	if (data.startsWith(`${ESC}O`)) return data.length < 3;
	return false;
}

function isBareEscape(data: string): boolean {
	return data.length === 1 && matchesKey(data, "esc");
}

/** @internal */
function createSessionOverlayBox(
	sessions: ReadonlyArray<SessionMeta>,
	onSelect: (sessionId: string) => void,
	onClose: () => void,
	options: { escapeGraceMs?: number; initialQuery?: string; requestRender?: () => void } = {},
): FocusBox & { dispose(): void; escapeLayers(): EscapeLayers } {
	const input = new Input();
	const noMatchView = new Text("");
	const allSessions = [...sessions];
	let filtered = [...sessions];
	let lastQuery = "";
	let selectedSessionId: string | undefined;
	// Sessions the dock has room for: two rows each under the filter row and a
	// position row, never more than the six a page moves by. Zero means the
	// frame has not said yet, so the six stand.
	let visibleBudget = VISIBLE_ROWS;
	let list = buildList(filtered);
	let pendingEscape = "";
	let pendingEscapeTimer: ReturnType<typeof setTimeout> | null = null;
	const box = new FocusBox(input, { onInput: handleInput }) as FocusBox & {
		dispose(): void;
		setBodyRows(rows: number): void;
		escapeLayers(): EscapeLayers;
	};
	// A typed filter is a layer of its own: Esc clears it and keeps the picker, and a second Esc closes.
	box.escapeLayers = (): EscapeLayers => [
		input.getValue().length > 0 && {
			verb: "clear filter",
			short: "clear",
			back: () => {
				input.setValue("");
				lastQuery = "";
				applyFilter();
				options.requestRender?.();
			},
		},
		{ verb: "close", back: closeOverlay },
	];
	const escapeOnce = (): void => {
		clearPendingEscape();
		backOutOneLayer(box.escapeLayers());
	};
	box.setBodyRows = (rows: number): void => {
		const next = rows > 0 ? Math.max(1, Math.min(VISIBLE_ROWS, Math.floor((rows - 2) / 2))) : VISIBLE_ROWS;
		if (next === visibleBudget) return;
		visibleBudget = next;
		applyFilter();
	};
	box.undoInput = () => {
		input.applyEdit("undo");
		lastQuery = input.getValue();
		applyFilter();
		return true;
	};
	box.dispose = (): void => {
		clearPendingEscape();
	};
	input.setValue(options.initialQuery ?? "");
	input.onSubmit = () => commitSelection();
	if (options.initialQuery) {
		lastQuery = options.initialQuery;
		applyFilter();
	} else {
		rebuildChildren();
	}
	return box;

	function buildList(sessions: ReadonlyArray<SessionMeta>): SelectList {
		const items = buildSessionItems(sessions);
		const visible = Math.min(visibleBudget, Math.max(1, items.length || 1));
		const list = new SessionSelectList(items, visible);
		list.onSelect = (item: SelectItem): void => {
			onSelect(item.value);
			closeOverlay();
		};
		list.onCancel = (): void => {
			escapeOnce();
		};
		return list;
	}

	function rebuildChildren(): void {
		box.clear();
		box.addChild(input);
		if (filtered.length === 0) {
			noMatchView.setText(
				emptyState(clioTheme(), "no matching sessions", SESSION_OVERLAY_WIDTH, {
					remedy: "Esc clears the filter",
				}).join("\n"),
			);
			box.addChild(noMatchView);
		} else {
			box.addChild(list);
		}
		box.invalidate();
	}

	function applyFilter(): void {
		// Keep identity through reordering and an empty-result query/undo.
		selectedSessionId = list.getSelectedItem()?.value ?? selectedSessionId;
		filtered = filterSessions(allSessions, lastQuery);
		list = buildList(filtered);
		const selectedIndex = filtered.findIndex((session) => session.id === selectedSessionId);
		if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		selectedSessionId = list.getSelectedItem()?.value ?? selectedSessionId;
		rebuildChildren();
	}

	function commitSelection(): void {
		const selected = list.getSelectedItem();
		if (!selected) return;
		onSelect(selected.value);
		closeOverlay();
	}

	function moveSelectionByPage(direction: -1 | 1): void {
		const selected = list.getSelectedItem();
		const currentIndex = selected ? filtered.findIndex((session) => session.id === selected.value) : 0;
		const targetIndex = currentIndex + direction * visibleBudget;
		list.setSelectedIndex(targetIndex);
		box.invalidate();
	}

	function closeOverlay(): void {
		clearPendingEscape();
		onClose();
	}

	function clearPendingEscape(): void {
		if (pendingEscapeTimer) clearTimeout(pendingEscapeTimer);
		pendingEscapeTimer = null;
		pendingEscape = "";
	}

	function armPendingEscape(data: string): void {
		if (pendingEscapeTimer) clearTimeout(pendingEscapeTimer);
		pendingEscape = data;
		pendingEscapeTimer = setTimeout(() => {
			pendingEscapeTimer = null;
			pendingEscape = "";
			escapeOnce();
		}, options.escapeGraceMs ?? SESSION_ESCAPE_GRACE_MS);
	}

	function dispatchResolvedInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.pageUp")) {
			moveSelectionByPage(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.pageDown")) {
			moveSelectionByPage(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
			list.handleInput(data);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			list.handleInput(data);
			return;
		}
		input.handleInput(data);
		const next = input.getValue();
		if (next !== lastQuery) {
			lastQuery = next;
			applyFilter();
		}
	}

	function handleInput(data: string): void {
		if (pendingEscape) {
			const combined = `${pendingEscape}${data}`;
			if (isLikelyCompleteEscapeSequence(combined)) {
				clearPendingEscape();
				dispatchResolvedInput(combined);
				return;
			}
			if (isPotentialEscapeSequence(combined)) {
				armPendingEscape(combined);
				return;
			}
			// A lone Esc followed by an ordinary key: the Esc backs out one layer, and the key still counts if the picker stays.
			const closing = box.escapeLayers().filter(Boolean).length === 1;
			escapeOnce();
			if (!closing) dispatchResolvedInput(data);
			return;
		}
		if (isBareEscape(data)) {
			armPendingEscape(data);
			return;
		}
		if (matchesKey(data, "esc")) {
			escapeOnce();
			return;
		}
		dispatchResolvedInput(data);
	}
}

export function openSessionOverlay(tui: TUI, deps: OpenSessionOverlayDeps): OverlayHandle {
	const sessions = deps.session.history().filter((session) => session.hasModelTurn !== false);
	const box = createSessionOverlayBox(
		sessions,
		(sessionId) => deps.onResume(sessionId),
		() => deps.onClose(),
		{
			...(deps.initialQuery !== undefined ? { initialQuery: deps.initialQuery } : {}),
			requestRender: () => tui.requestRender(),
		},
	);
	const handle = showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: SESSION_OVERLAY_WIDTH,
		markerId: "resume",
		title: "Sessions",
		footerHint: (innerWidth) =>
			buildResponsiveHint(
				[FILTER_HINT, { key: "Enter", verb: "resume" }],
				escapeHintEntry(box.escapeLayers()),
			)(innerWidth),
	});
	return {
		...handle,
		hide(): void {
			box.dispose();
			handle.hide();
		},
	};
}
