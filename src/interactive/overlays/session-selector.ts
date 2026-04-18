import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import {
	Box,
	type OverlayHandle,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
} from "../../engine/tui.js";

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
 * ISO-minute start time, and provider/model. The description carries cwd.
 */
export function buildSessionItems(sessions: ReadonlyArray<SessionMeta>): SelectItem[] {
	return sessions.map((meta) => {
		const started = meta.createdAt ? new Date(meta.createdAt).toISOString().slice(0, 16).replace("T", " ") : "?";
		const ended = meta.endedAt ? "✓" : "●";
		const provider = meta.provider ?? "-";
		const model = meta.model ?? "-";
		return {
			value: meta.id,
			label: `${ended} ${shortenId(meta.id)}  ${started}  ${provider}/${model}`,
			description: meta.cwd ?? "",
		};
	});
}

export interface OpenSessionOverlayDeps {
	session: SessionContract;
	onResume: (sessionId: string) => void;
	onClose: () => void;
}

class SessionOverlayBox extends Box {
	constructor(private readonly list: SelectList) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

export function openSessionOverlay(tui: TUI, deps: OpenSessionOverlayDeps): OverlayHandle {
	const items = buildSessionItems(deps.session.history());
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length));
	const list = new SelectList(items, visible, SESSION_THEME);
	list.onSelect = (item: SelectItem): void => {
		deps.onResume(item.value);
		deps.onClose();
	};
	list.onCancel = (): void => {
		deps.onClose();
	};
	const box = new SessionOverlayBox(list);
	box.addChild(list);
	return tui.showOverlay(box, { anchor: "center", width: SESSION_OVERLAY_WIDTH });
}
