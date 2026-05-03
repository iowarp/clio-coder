import { basename } from "node:path";
import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import {
	Box,
	Input,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	Text,
	type TUI,
} from "../../engine/tui.js";
import { showClioOverlayFrame } from "../overlay-frame.js";
import { filterSessions } from "./session-selector-search.js";

export const SESSION_OVERLAY_WIDTH = 110;
const VISIBLE_ROWS = 12;

const IDENTITY = (s: string): string => s;

const SESSION_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

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
 * "yesterday", "2026-04-12"). Mirrors the convention Claude Code and Codex
 * use in their resume pickers so users do not have to read raw timestamps.
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
	const endpoint = meta.endpoint?.trim();
	const model = meta.model?.trim();
	if (!endpoint && !model) return "no target";
	if (endpoint && model) return `${endpoint}/${model}`;
	return endpoint ?? model ?? "no target";
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
 * (status, last-activity, msg count, endpoint/model) in the primary column
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

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ENTER = "\r";
const ENTER_LF = "\n";
const ESCAPE = "\x1b";

/**
 * SelectList navigation keys (arrows + Enter) route to the list; everything
 * else feeds the search Input which live-filters the candidate set. Bare
 * `Esc` closes the overlay; an `Esc` followed by `[` is the lead-in for an
 * arrow code so the Input has to ignore that prefix.
 */
class SessionOverlayBox extends Box {
	private readonly input = new Input();
	private readonly noMatchView = new Text("");
	private list: SelectList;
	private allSessions: SessionMeta[];
	private filtered: SessionMeta[];

	private lastQuery = "";

	constructor(
		sessions: ReadonlyArray<SessionMeta>,
		private readonly onSelect: (sessionId: string) => void,
		private readonly onClose: () => void,
	) {
		super(1, 0);
		this.allSessions = [...sessions];
		this.filtered = [...sessions];
		this.input.setValue("");
		this.input.onSubmit = () => this.commitSelection();
		this.list = this.buildList(this.filtered);
		this.rebuildChildren();
	}

	private buildList(sessions: ReadonlyArray<SessionMeta>): SelectList {
		const items = buildSessionItems(sessions);
		const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length || 1));
		const list = new SelectList(items, visible, SESSION_THEME, SESSION_LAYOUT);
		list.onSelect = (item: SelectItem): void => {
			this.onSelect(item.value);
			this.onClose();
		};
		list.onCancel = (): void => {
			this.onClose();
		};
		return list;
	}

	private rebuildChildren(): void {
		this.clear();
		this.addChild(this.input);
		if (this.filtered.length === 0) {
			this.noMatchView.setText("(no matching sessions)");
			this.addChild(this.noMatchView);
		} else {
			this.addChild(this.list);
		}
		this.invalidate();
	}

	private applyFilter(): void {
		this.filtered = filterSessions(this.allSessions, this.lastQuery);
		this.list = this.buildList(this.filtered);
		this.rebuildChildren();
	}

	private commitSelection(): void {
		const first = this.filtered[0];
		if (!first) return;
		this.onSelect(first.id);
		this.onClose();
	}

	handleInput(data: string): void {
		if (data === ESCAPE) {
			this.onClose();
			return;
		}
		if (data === ARROW_UP || data === ARROW_DOWN) {
			this.list.handleInput(data);
			return;
		}
		if (data === ENTER || data === ENTER_LF) {
			this.list.handleInput(data);
			return;
		}
		this.input.handleInput(data);
		const next = this.input.getValue();
		if (next !== this.lastQuery) {
			this.lastQuery = next;
			this.applyFilter();
		}
	}
}

export function openSessionOverlay(tui: TUI, deps: OpenSessionOverlayDeps): OverlayHandle {
	const sessions = deps.session.history();
	const box = new SessionOverlayBox(
		sessions,
		(sessionId) => deps.onResume(sessionId),
		() => deps.onClose(),
	);
	return showClioOverlayFrame(tui, box, { anchor: "center", width: SESSION_OVERLAY_WIDTH, title: "Resume" });
}
