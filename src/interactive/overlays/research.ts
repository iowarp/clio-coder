import {
	campaignStatusLines,
	listCampaigns,
	type ResearchCampaignView,
	researchProjectRoot,
} from "../../domains/research/index.js";
import { type Component, matchesKey, type OverlayHandle, type TUI, wrapTextWithAnsi } from "../../engine/tui.js";
import { backOutOneLayer, type EscapeLayers, escapeHintEntry } from "../escape-layers.js";
import {
	fitHintEntries,
	fitRow,
	type HintEntry,
	selectionLabel,
	selectionMark,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import { clioTheme, emptyState, positionRow, statusChip } from "../theme/index.js";

export const RESEARCH_OVERLAY_WIDTH = 104;

export type ResearchCampaignEntry = ResearchCampaignView | { id: string; error: string };

export interface OpenResearchOverlayOptions {
	onClose: () => void;
	requestRender?: () => void;
}

/** The campaigns of the project `cwd` belongs to, oldest first, read fresh on every frame. */
export function readResearchCampaigns(cwd: string): ResearchCampaignEntry[] {
	return listCampaigns(researchProjectRoot(cwd));
}

function entryId(entry: ResearchCampaignEntry): string {
	return "error" in entry ? entry.id : entry.campaign.id;
}

/** One list row per campaign: id, state, objective and how far the budget went. */
export function formatResearchListRow(entry: ResearchCampaignEntry): string {
	if ("error" in entry) return `${entry.id}  unreadable: ${entry.error}`;
	const objective = entry.campaign.objective;
	const state = entry.state === "stopped" ? (entry.stop?.reason ?? "stopped") : "running";
	return `${entry.campaign.id}  ${state}  ${objective.direction} ${objective.metric} (${objective.check})  ${entry.iterations.length}/${entry.campaign.budget.maxIterations} it, ${entry.ratchets} kept`;
}

/**
 * Read-only view of research campaigns: a list, and per campaign the same
 * timeline `clio-coder research status` prints. Starting a campaign stays on
 * the CLI, since a campaign spawns agent runs that outlive any overlay.
 */
class ResearchOverlayBody implements Component {
	private selectedIndex = 0;
	private openId: string | null = null;
	private scroll = 0;
	private rows = 0;
	private error: string | null = null;

	constructor(
		private readonly getCampaigns: () => ReadonlyArray<ResearchCampaignEntry>,
		private readonly options: Required<Pick<OpenResearchOverlayOptions, "requestRender">> & OpenResearchOverlayOptions,
	) {}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	private read(): ReadonlyArray<ResearchCampaignEntry> {
		try {
			this.error = null;
			return this.getCampaigns();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			return [];
		}
	}

	render(width: number): string[] {
		const theme = clioTheme();
		const safeWidth = Math.max(1, Math.floor(width));
		const campaigns = this.read();
		const room = this.rows > 0 ? this.rows : Number.MAX_SAFE_INTEGER;
		if (this.error !== null) return wrapTextWithAnsi(statusChip(theme, "warning", this.error), safeWidth);
		const open = this.openId === null ? undefined : campaigns.find((entry) => entryId(entry) === this.openId);
		if (open !== undefined) {
			const lines =
				"error" in open
					? [`${open.id} cannot be read: ${open.error}`]
					: campaignStatusLines(open).flatMap((line) => wrapTextWithAnsi(line, safeWidth));
			return this.window(lines, room, safeWidth, "lines");
		}
		this.openId = null;
		if (campaigns.length === 0)
			return emptyState(theme, "No research campaigns in this project yet.", safeWidth, {
				remedy:
					"Start one with clio-coder research start --check <id> --metric <key> --direction min|max --max-iterations <N>.",
			});
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, campaigns.length - 1));
		const lines = campaigns.map((entry, index) => {
			const focused = index === this.selectedIndex;
			return fitRow(`${selectionMark(focused)} ${selectionLabel(focused, formatResearchListRow(entry))}`, safeWidth);
		});
		const page = Math.max(1, room - 1);
		if (this.selectedIndex < this.scroll) this.scroll = this.selectedIndex;
		else if (this.selectedIndex >= this.scroll + page) this.scroll = this.selectedIndex - page + 1;
		return this.window(lines, room, safeWidth, "campaigns");
	}

	private window(lines: ReadonlyArray<string>, room: number, width: number, unit: string): string[] {
		if (lines.length <= room) {
			this.scroll = 0;
			return [...lines];
		}
		const { window, start, position } = windowRows(lines, this.scroll, Math.max(1, room - 1));
		this.scroll = start;
		return position ? [...window, positionRow(clioTheme(), { ...position, unit }, width)] : window;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "esc")) {
			backOutOneLayer(this.escapeLayers());
			this.options.requestRender();
			return;
		}
		const campaigns = this.read();
		if (this.openId !== null) {
			if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "down")) this.scroll += 1;
			else return;
			this.options.requestRender();
			return;
		}
		if (campaigns.length === 0) return;
		if (matchesKey(data, "up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		else if (matchesKey(data, "down")) this.selectedIndex = Math.min(campaigns.length - 1, this.selectedIndex + 1);
		else if (matchesKey(data, "enter") || data === "\n") {
			const selected = campaigns[this.selectedIndex];
			if (selected === undefined) return;
			this.openId = entryId(selected);
			this.scroll = 0;
		} else return;
		this.options.requestRender();
	}

	invalidate(): void {}

	private escapeLayers(): EscapeLayers {
		return [
			this.openId !== null && {
				verb: "back",
				back: () => {
					this.openId = null;
					this.scroll = 0;
				},
			},
			{ verb: "close", back: () => this.options.onClose() },
		];
	}

	footerHint(innerWidth: number): string {
		const esc = escapeHintEntry(this.escapeLayers()) ?? { key: "Esc", verb: "close" };
		const entries: HintEntry[] =
			this.openId !== null
				? [{ key: "↑↓", verb: "scroll" }, esc]
				: [{ key: "↑↓", verb: "select" }, { key: "Enter", verb: "timeline" }, esc];
		return fitHintEntries(entries, innerWidth - 3);
	}

	title(): string {
		return this.openId === null ? "Research" : `Research · ${this.openId}`;
	}
}

export function openResearchOverlay(
	tui: TUI,
	getCampaigns: () => ReadonlyArray<ResearchCampaignEntry>,
	options: OpenResearchOverlayOptions,
): OverlayHandle {
	const body = new ResearchOverlayBody(getCampaigns, {
		...options,
		requestRender: options.requestRender ?? (() => tui.requestRender()),
	});
	return showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: RESEARCH_OVERLAY_WIDTH,
		markerId: "research",
		title: () => body.title(),
		footerHint: (innerWidth) => body.footerHint(innerWidth),
	});
}
