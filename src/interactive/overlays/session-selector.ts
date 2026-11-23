import { basename } from "node:path";
import { tierPolicy } from "../../core/presentation-tier.js";
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
import { clioTheme, emptyState, type Fact, factRows, GLYPH, positionRow, selectionRow } from "../theme/index.js";
import { filterSessions } from "./session-selector-search.js";

export const SESSION_OVERLAY_WIDTH = 110;
/** Sessions a page shows while each takes two rows (standard, detailed) or one (compact). */
const VISIBLE_ROWS = 6;
const COMPACT_VISIBLE_ROWS = 12;
/** The selection's fact rows at detailed: id, folder, open state. */
const DETAIL_FACT_ROWS = 3;
export const SESSION_ESCAPE_GRACE_MS = 75;
const ESC = String.fromCharCode(27);

/**
 * A session row: the label the list selects by, when it last moved, the strip under it, the one-row status the
 * compact tier shows for the selection, and the facts the detailed tier adds for it.
 */
interface SessionItem extends SelectItem {
	when: string;
	status: string;
	facts: Fact[];
}

/** Rows one session takes in the list: the strip under each session shows from standard up. */
function rowsPerSession(): number {
	return tierPolicy().pickerDetail === "status" ? 1 : 2;
}

/** Sessions a page holds at the current tier before the frame says how many rows it has. */
function sessionPageCap(): number {
	return rowsPerSession() === 1 ? COMPACT_VISIBLE_ROWS : VISIBLE_ROWS;
}

/** Rows under the list: the status or legend row, and the selection's facts at detailed. */
function sessionTrailRows(): number {
	return 1 + (tierPolicy().pickerDetail === "pane" ? DETAIL_FACT_ROWS : 0);
}

/**
 * Session metadata gets its own row so a narrow picker never drops it
 * (flywheel r4/5). Each session is a selection row: the name or first message
 * with its age at the right. From standard up the turn count, folder and route
 * sit beneath, clipped to one row so every session costs the same two; at
 * compact each session is one row and the selection's strip is the status row
 * under the list. Detailed adds the selection's id, folder and open state.
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
		const detail = tierPolicy().pickerDetail;
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
					...(detail === "status"
						? {}
						: {
								description: truncateToWidth(item.description ?? "", Math.max(1, width - 4), GLYPH.ellipsis, false),
							}),
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
		const focused = this.sessionItems[selected];
		if (!focused) return rows;
		// Compact names the selection's state in words, so it needs no legend; the strips from standard up lead with
		// the bare marker, which the legend row spells out.
		const trail = detail === "status" ? focused.status : SESSION_STATUS_LEGEND;
		rows.push(truncateToWidth(theme.fg("annotation", trail), width, GLYPH.ellipsis, false));
		if (detail === "pane")
			rows.push(...factRows(theme, focused.facts, width, { labelRole: "fieldName", stack: "never" }));
		return rows;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return super.handleMouse({ ...event, y: Math.floor(event.y / rowsPerSession()) });
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
	if (target && model) return `${target} ${GLYPH.sep} ${model}`;
	return target || model || "no target";
}

function previewLine(meta: SessionMeta): string {
	const fork = meta.parentSessionId ? `Fork ${sanitizeCallTargetText(meta.id).slice(0, 6)} ${GLYPH.sep} ` : "";
	const name = sanitizeCallTargetText(meta.name ?? "");
	if (name) return `${fork}${name}`;
	const explicit = sanitizeCallTargetText(meta.firstMessagePreview ?? "");
	if (explicit) return `${fork}${explicit}`;
	const cwdLeaf = sanitizeCallTargetText(meta.cwd ? basename(meta.cwd) : "");
	const id = sanitizeCallTargetText(meta.id) || "Unnamed session";
	return `${id} ${GLYPH.sep} ${cwdLeaf || "no preview"}`;
}

/**
 * The status marker each row leads its strip with, and what it means. Closing a
 * session does not establish that its run succeeded; a session that never ended
 * reads as open only while its owning process is (#420). The picker's legend
 * row is spelled from this same table.
 */
const SESSION_STATUS = {
	open: { glyph: GLYPH.running, word: "open", meaning: "open in a running CLIO Coder" },
	closed: { glyph: GLYPH.queued, word: "not open", meaning: "not open" },
} as const;

const SESSION_STATUS_LEGEND = Object.values(SESSION_STATUS)
	.map((status) => `${status.glyph} ${status.meaning}`)
	.join(` ${GLYPH.sep} `);

/** The turn count, folder and route; `status` leads with the marker alone or with its meaning in words. */
function metaStrip(meta: SessionMeta, status: "glyph" | "words"): string {
	const open = liveSessionOwner(meta) ? SESSION_STATUS.open : SESSION_STATUS.closed;
	const count = typeof meta.messageCount === "number" ? meta.messageCount : 0;
	const countLabel = count === 1 ? "1 turn" : `${count} turns`;
	const lead = status === "glyph" ? [`${open.glyph} ${countLabel}`] : [`${open.glyph} ${open.word}`, countLabel];
	const folder = sanitizeCallTargetText(meta.cwd ? basename(meta.cwd) : "") || "no folder";
	// meta.json describes the session, not its spend; the picker shows no spend (#434).
	return [...lead, folder, shortTarget(meta)].join(` ${GLYPH.sep} `);
}

/** What the detailed tier adds for the selection: the id `--resume` takes, the whole folder, and the open state. */
function sessionFacts(meta: SessionMeta): Fact[] {
	const owner = liveSessionOwner(meta);
	return [
		{ label: "id", value: sanitizeCallTargetText(meta.id) || "unknown", fit: "clip" },
		{ label: "folder", value: sanitizeCallTargetText(meta.cwd ?? "") || "no folder", fit: "clip" },
		{
			label: "state",
			value: owner
				? `${SESSION_STATUS.open.glyph} ${SESSION_STATUS.open.meaning} ${GLYPH.sep} pid ${owner.pid}`
				: `${SESSION_STATUS.closed.glyph} ${SESSION_STATUS.closed.meaning}`,
			fit: "clip",
		},
	];
}

/**
 * The saved name, first message or fallback identity stays visible as metadata yields.
 * Keep the canonical ID as the selection value, independent of display text.
 */
function buildSessionItems(sessions: ReadonlyArray<SessionMeta>, now: number = Date.now()): SessionItem[] {
	return sessions.map((meta) => {
		const labels = meta.labels?.map(sanitizeCallTargetText).filter(Boolean).join(", ");
		const labelText = labels ? `labels: ${labels}` : "";
		const join = (strip: string): string => [strip, labelText].filter(Boolean).join(` ${GLYPH.sep} `);
		return {
			value: meta.id,
			label: previewLine(meta),
			description: join(metaStrip(meta, "glyph")),
			status: join(metaStrip(meta, "words")),
			facts: sessionFacts(meta),
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
	// Sessions the dock has room for: one or two rows each (by tier) under the
	// filter row, a position row, the legend or status row and, at detailed,
	// the selection's facts; never more than a page of the tier. Zero means the
	// frame has not said yet, so the page cap stands.
	let visibleBudget = sessionPageCap();
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
		const cap = sessionPageCap();
		const next =
			rows > 0 ? Math.max(1, Math.min(cap, Math.floor((rows - 2 - sessionTrailRows()) / rowsPerSession()))) : cap;
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
