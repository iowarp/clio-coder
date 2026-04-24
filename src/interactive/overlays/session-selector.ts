import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import {
	Box,
	Input,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Text,
	type TUI,
} from "../../engine/tui.js";
import { filterSessions } from "./session-selector-search.js";

export const SESSION_OVERLAY_WIDTH = 84;
const VISIBLE_ROWS = 12;

const IDENTITY = (s: string): string => s;

const SESSION_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

function shortenId(id: string): string {
	return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Pure builder used by the /resume overlay. Renders one row per session:
 * a completion glyph (✓ for closed, ● for still open), the truncated id,
 * ISO-minute start time, and endpoint/model. The description carries cwd.
 */
export function buildSessionItems(sessions: ReadonlyArray<SessionMeta>): SelectItem[] {
	return sessions.map((meta) => {
		const started = meta.createdAt ? new Date(meta.createdAt).toISOString().slice(0, 16).replace("T", " ") : "?";
		const ended = meta.endedAt ? "✓" : "●";
		const endpoint = meta.endpoint ?? "-";
		const model = meta.model ?? "-";
		const name = meta.name ? `  ${meta.name}` : "";
		const labels = meta.labels && meta.labels.length > 0 ? `  labels: ${meta.labels.join(", ")}` : "";
		return {
			value: meta.id,
			label: `${ended} ${shortenId(meta.id)}${name}  ${started}  ${endpoint}/${model}`,
			description: `${meta.cwd ?? ""}${labels}`,
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
		const list = new SelectList(items, visible, SESSION_THEME);
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
	return tui.showOverlay(box, { anchor: "center", width: SESSION_OVERLAY_WIDTH });
}
