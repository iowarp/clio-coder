import { basename } from "node:path";
import { formatFooterTokens } from "../../core/display-units.js";
import { formatCostAggregate } from "../../domains/observability/cost.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import type { SessionContract, SessionMeta } from "../../domains/session/index.js";
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
import { relative } from "../format-time.js";
import { buildHint, DEFAULT_SELECT_THEME, FILTER_HINT, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { GLYPH } from "../theme/index.js";
import { filterSessions } from "./session-selector-search.js";

export const SESSION_OVERLAY_WIDTH = 110;
const VISIBLE_ROWS = 6;
export const SESSION_ESCAPE_GRACE_MS = 75;
const ESC = String.fromCharCode(27);

/** Session metadata gets its own row so a narrow picker never drops it (flywheel r4/5). */
class SessionSelectList extends SelectList {
	constructor(
		private readonly sessionItems: SelectItem[],
		private readonly visibleSessions: number,
	) {
		super(sessionItems, visibleSessions, DEFAULT_SELECT_THEME);
	}

	override render(width: number): string[] {
		if (width <= 0) return [];
		const selected = Math.max(
			0,
			this.sessionItems.findIndex((item) => item.value === this.getSelectedItem()?.value),
		);
		const start = Math.max(
			0,
			Math.min(selected - Math.floor(this.visibleSessions / 2), this.sessionItems.length - this.visibleSessions),
		);
		const end = Math.min(start + this.visibleSessions, this.sessionItems.length);
		const rows: string[] = [];
		for (let index = start; index < end; index++) {
			const item = this.sessionItems[index];
			if (!item) continue;
			const focused = index === selected;
			const label = truncateToWidth(`${focused ? "→ " : "  "}${item.label}`, width, "…", true);
			rows.push(focused ? DEFAULT_SELECT_THEME.selectedText(label) : label);
			rows.push(DEFAULT_SELECT_THEME.description(truncateToWidth(`  ${item.description ?? ""}`, width, "…", true)));
		}
		if (start > 0 || end < this.sessionItems.length)
			rows.push(
				DEFAULT_SELECT_THEME.scrollInfo(truncateToWidth(`  ${selected + 1}/${this.sessionItems.length}`, width, "…", true)),
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

function shortTarget(meta: SessionMeta): string {
	const target = sanitizeCallTargetText(meta.target ?? "");
	const model = sanitizeCallTargetText(meta.model ?? "");
	if (!target && !model) return "no target";
	if (target && model) return `${target}/${model}`;
	return target || model || "no target";
}

function previewLine(meta: SessionMeta): string {
	const fork = meta.parentSessionId ? `Fork ${sanitizeCallTargetText(meta.id).slice(0, 6)} · ` : "";
	const explicit = sanitizeCallTargetText(meta.firstMessagePreview ?? "");
	if (explicit) return `${fork}${explicit}`;
	const name = sanitizeCallTargetText(meta.name ?? "");
	if (name) return `${fork}(${name})`;
	const cwdLeaf = sanitizeCallTargetText(meta.cwd ? basename(meta.cwd) : "");
	const id = sanitizeCallTargetText(meta.id) || "Unnamed session";
	return `${id} · ${cwdLeaf || "no preview"}`;
}

function metaStrip(meta: SessionMeta, now: number): string {
	// Closing a session does not establish that its run succeeded.
	const status = meta.endedAt ? GLYPH.scoped : GLYPH.running;
	const when = formatRelativeTime(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt, now);
	const count = typeof meta.messageCount === "number" ? meta.messageCount : 0;
	const countLabel = count === 1 ? "1 turn" : `${count} turns`;
	const folder = sanitizeCallTargetText(meta.cwd ? basename(meta.cwd) : "") || "no folder";
	const base = `${status} ${when} · ${countLabel} · ${folder} · ${shortTarget(meta)}`;
	if (!meta.usage) return base;
	const cost = formatCostAggregate(meta.usage.cost);
	return `${base} · ${formatFooterTokens(meta.usage.tokens)} tok${cost !== null ? ` · ${cost}` : ""}`;
}

/**
 * The first message or fallback identity stays visible as metadata yields.
 * Keep the canonical ID as the selection value, independent of display text.
 */
function buildSessionItems(sessions: ReadonlyArray<SessionMeta>, now: number = Date.now()): SelectItem[] {
	return sessions.map((meta) => {
		const labels = meta.labels?.map(sanitizeCallTargetText).filter(Boolean).join(", ");
		const details = [metaStrip(meta, now), labels ? `labels: ${labels}` : ""].filter(Boolean);
		return {
			value: meta.id,
			label: previewLine(meta),
			description: details.join(" · "),
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
	options: { escapeGraceMs?: number; initialQuery?: string } = {},
): FocusBox & { dispose(): void } {
	const input = new Input();
	const noMatchView = new Text("");
	const allSessions = [...sessions];
	let filtered = [...sessions];
	let lastQuery = "";
	let selectedSessionId: string | undefined;
	let list = buildList(filtered);
	let pendingEscape = "";
	let pendingEscapeTimer: ReturnType<typeof setTimeout> | null = null;
	const box = new FocusBox(input, { onInput: handleInput }) as FocusBox & { dispose(): void };
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
		const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length || 1));
		const list = new SessionSelectList(items, visible);
		list.onSelect = (item: SelectItem): void => {
			onSelect(item.value);
			closeOverlay();
		};
		list.onCancel = (): void => {
			closeOverlay();
		};
		return list;
	}

	function rebuildChildren(): void {
		box.clear();
		box.addChild(input);
		if (filtered.length === 0) {
			noMatchView.setText("(no matching sessions)");
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
		const targetIndex = currentIndex + direction * VISIBLE_ROWS;
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
			onClose();
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
			closeOverlay();
			return;
		}
		if (isBareEscape(data)) {
			armPendingEscape(data);
			return;
		}
		if (matchesKey(data, "esc")) {
			closeOverlay();
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
		deps.initialQuery !== undefined ? { initialQuery: deps.initialQuery } : {},
	);
	const handle = showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: SESSION_OVERLAY_WIDTH,
		markerId: "resume",
		title: "Sessions",
		footerHint: buildHint([FILTER_HINT, { key: "Enter", verb: "resume" }]),
	});
	return {
		...handle,
		hide(): void {
			box.dispose();
			handle.hide();
		},
	};
}
