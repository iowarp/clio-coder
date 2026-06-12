import { basename } from "node:path";
import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import {
	Input,
	matchesKey,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Text,
	type TUI,
} from "../../engine/tui.js";
import { buildHint, DEFAULT_SELECT_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { filterSessions } from "./session-selector-search.js";

export const SESSION_OVERLAY_WIDTH = 110;
const VISIBLE_ROWS = 12;
export const SESSION_ESCAPE_GRACE_MS = 75;
const ESC = String.fromCharCode(27);

/**
 * SelectList allocates the primary column to the label and uses any
 * remaining width for the description. The picker treats the meta strip
 * (status glyph, time, count, target) as the primary column and the
 * conversation preview as the description, so users scan the right column
 * for the topic they remember.
 */
const SESSION_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 52,
	maxPrimaryColumnWidth: 60,
};

/**
 * Format an ISO-8601 instant as a human-relative string ("3 minutes ago",
 * "yesterday", "2026-04-12"). Mirrors common coding-tool resume pickers so
 * users do not have to read raw timestamps.
 */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return "—";
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "—";
	const diffMs = now - ts;
	if (diffMs < 0) return "just now";
	const sec = Math.floor(diffMs / 1000);
	if (sec < 5) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day === 1) return "yesterday";
	if (day < 7) return `${day}d ago`;
	if (day < 30) return `${Math.floor(day / 7)}w ago`;
	return new Date(ts).toISOString().slice(0, 10);
}

function shortTarget(meta: SessionMeta): string {
	const target = meta.target?.trim();
	const model = meta.model?.trim();
	if (!target && !model) return "no target";
	if (target && model) return `${target}/${model}`;
	return target ?? model ?? "no target";
}

function previewLine(meta: SessionMeta): string {
	const explicit = meta.firstMessagePreview?.trim();
	if (explicit) return explicit;
	const name = meta.name?.trim();
	if (name) return `(${name})`;
	const cwdLeaf = meta.cwd ? basename(meta.cwd) : "";
	return cwdLeaf ? `(no preview · ${cwdLeaf})` : "(no preview)";
}

function metaStrip(meta: SessionMeta, now: number): string {
	const status = meta.endedAt ? "✓" : "●";
	const when = formatRelativeTime(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt, now);
	const count = typeof meta.messageCount === "number" ? meta.messageCount : 0;
	const countLabel = count === 1 ? "1 msg" : `${count} msgs`;
	return `${status} ${when} · ${countLabel} · ${shortTarget(meta)}`;
}

/**
 * Pure builder used by the /resume overlay. Each row carries a meta strip
 * (status, last-activity, msg count, target/model) in the primary column
 * and the first user-message preview in the description column.
 */
export function buildSessionItems(sessions: ReadonlyArray<SessionMeta>, now: number = Date.now()): SelectItem[] {
	return sessions.map((meta) => {
		const labels = meta.labels && meta.labels.length > 0 ? `  labels: ${meta.labels.join(", ")}` : "";
		return {
			value: meta.id,
			label: metaStrip(meta, now),
			description: `${previewLine(meta)}${labels}`,
		};
	});
}

export interface OpenSessionOverlayDeps {
	session: SessionContract;
	onResume: (sessionId: string) => void;
	onClose: () => void;
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
export function createSessionOverlayBox(
	sessions: ReadonlyArray<SessionMeta>,
	onSelect: (sessionId: string) => void,
	onClose: () => void,
	options: { escapeGraceMs?: number } = {},
): FocusBox & { dispose(): void } {
	const input = new Input();
	const noMatchView = new Text("");
	const allSessions = [...sessions];
	let filtered = [...sessions];
	let lastQuery = "";
	let list = buildList(filtered);
	let pendingEscape = "";
	let pendingEscapeTimer: ReturnType<typeof setTimeout> | null = null;
	const box = new FocusBox([], { onInput: handleInput }) as FocusBox & { dispose(): void };
	box.dispose = (): void => {
		clearPendingEscape();
	};
	input.setValue("");
	input.onSubmit = () => commitSelection();
	rebuildChildren();
	return box;

	function buildList(sessions: ReadonlyArray<SessionMeta>): SelectList {
		const items = buildSessionItems(sessions);
		const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length || 1));
		const list = new SelectList(items, visible, DEFAULT_SELECT_THEME, SESSION_LAYOUT);
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
		filtered = filterSessions(allSessions, lastQuery);
		list = buildList(filtered);
		rebuildChildren();
	}

	function commitSelection(): void {
		const first = filtered[0];
		if (!first) return;
		onSelect(first.id);
		closeOverlay();
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
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			list.handleInput(data);
			return;
		}
		if (matchesKey(data, "enter") || data === "\n") {
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
	const sessions = deps.session.history();
	const box = createSessionOverlayBox(
		sessions,
		(sessionId) => deps.onResume(sessionId),
		() => deps.onClose(),
	);
	const handle = showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: SESSION_OVERLAY_WIDTH,
		title: "Sessions",
		footerHint: buildHint("commit", [
			{ key: "type", verb: "search" },
			{ key: "Enter", verb: "resume" },
		]),
	});
	return {
		...handle,
		hide(): void {
			box.dispose();
			handle.hide();
		},
	};
}
