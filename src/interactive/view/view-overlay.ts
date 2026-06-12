import {
	type Component,
	fuzzyFilter,
	Markdown,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../../engine/tui.js";
import { buildHint, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, markdownTheme } from "../theme/index.js";
import {
	type ArtifactProvider,
	listViewArtifacts,
	VIEW_ARTIFACT_CATEGORIES,
	type ViewArtifact,
	type ViewArtifactCategory,
	type ViewArtifactFormat,
} from "./artifacts.js";

export const VIEW_OVERLAY_WIDTH = "100%";
export const VIEW_OVERLAY_MAX_HEIGHT = "100%";
export const VIEW_OVERLAY_MARGIN = { top: 1, right: 2, bottom: 1, left: 2 } as const;

const LEFT_PANE_TARGET_WIDTH = 38;
const LEFT_PANE_MIN_WIDTH = 30;
const LEFT_PANE_MAX_WIDTH = 44;
const SEPARATOR = " │ ";

export type ViewPaneFocus = "list" | "content";
export type ViewNoticeLevel = "info" | "success" | "warning" | "error";
export type ViewVerificationState =
	| { status: "idle" }
	| { status: "running" }
	| { status: "ok"; detail: string }
	| { status: "fail"; detail: string };

export type ViewScrollAction =
	| "line-up"
	| "line-down"
	| "page-up"
	| "page-down"
	| "half-up"
	| "half-down"
	| "top"
	| "bottom";

export interface RenderedViewRow {
	type: "group" | "empty" | "item";
	category: ViewArtifactCategory;
	item?: ViewArtifact;
	itemIndex?: number;
}

interface LoadedContent {
	key: string;
	status: "loading" | "loaded" | "error";
	lines: string[];
	format: ViewArtifactFormat;
	error?: string;
	renderWidth?: number;
	renderedLines?: string[];
}

export interface ViewOverlayOptions {
	providers: ReadonlyArray<ArtifactProvider>;
	getBodyHeight: () => number;
	initialFilter?: string;
	notice?: (level: ViewNoticeLevel, text: string, key?: string) => void;
	onClose: () => void;
	requestRender?: () => void;
}

function artifactKey(artifact: ViewArtifact): string {
	return `${artifact.category}:${artifact.id}:${artifact.path ?? ""}`;
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function categoryLabel(category: ViewArtifactCategory): string {
	switch (category) {
		case "receipt":
			return "Receipts";
		case "dispatch":
			return "Dispatch outputs";
		case "tool-output":
			return "Tool outputs";
		case "compaction":
			return "Compaction summaries";
	}
}

export function formatArtifactSize(sizeBytes: number | undefined): string {
	if (sizeBytes === undefined) return "";
	if (sizeBytes < 1024) return `${sizeBytes} B`;
	if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
	return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

export function filterViewArtifacts(artifacts: ReadonlyArray<ViewArtifact>, query: string): ViewArtifact[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [...artifacts];
	return fuzzyFilter([...artifacts], trimmed, (artifact) => `${artifact.id} ${artifact.category} ${artifact.title}`);
}

export function initialViewSelection(artifacts: ReadonlyArray<ViewArtifact>, initialFilter = ""): number {
	const filtered = filterViewArtifacts(artifacts, initialFilter);
	if (filtered.length === 0) return 0;
	const exact = initialFilter.trim();
	if (exact.length > 0) {
		const exactIndex = filtered.findIndex(
			(artifact) => artifact.id === exact || `${artifact.category}:${artifact.id}` === exact,
		);
		if (exactIndex >= 0) return exactIndex;
	}
	return 0;
}

export function groupedViewRows(artifacts: ReadonlyArray<ViewArtifact>): RenderedViewRow[] {
	const rows: RenderedViewRow[] = [];
	for (const category of VIEW_ARTIFACT_CATEGORIES) {
		const items = artifacts.filter((artifact) => artifact.category === category);
		rows.push({ type: "group", category });
		if (items.length === 0) {
			rows.push({ type: "empty", category });
			continue;
		}
		for (const item of items) {
			rows.push({ type: "item", category, item, itemIndex: artifacts.indexOf(item) });
		}
	}
	return rows;
}

export function nextContentScrollOffset(
	current: number,
	totalLines: number,
	height: number,
	action: ViewScrollAction,
): number {
	const maxOffset = Math.max(0, totalLines - Math.max(1, height));
	const page = Math.max(1, height - 1);
	const half = Math.max(1, Math.floor(height / 2));
	let next = current;
	switch (action) {
		case "line-up":
			next -= 1;
			break;
		case "line-down":
			next += 1;
			break;
		case "page-up":
			next -= page;
			break;
		case "page-down":
			next += page;
			break;
		case "half-up":
			next -= half;
			break;
		case "half-down":
			next += half;
			break;
		case "top":
			next = 0;
			break;
		case "bottom":
			next = maxOffset;
			break;
	}
	return Math.max(0, Math.min(next, maxOffset));
}

function verificationText(state: ViewVerificationState | undefined): string {
	if (!state || state.status === "idle") return "";
	if (state.status === "running") return "verify running";
	if (state.status === "ok") return `verify ok ${state.detail}`;
	return `verify fail ${state.detail}`;
}

export function buildArtifactHeader(
	artifact: ViewArtifact | undefined,
	verification: ViewVerificationState | undefined,
	width: number,
): string {
	if (!artifact) return padAnsi("No artifact selected", width);
	const theme = clioTheme();
	const timestamp = artifact.timestamp > 0 ? new Date(artifact.timestamp).toISOString() : "unknown time";
	const size = formatArtifactSize(artifact.sizeBytes);
	const parts = [artifact.category, artifact.id, timestamp];
	if (size.length > 0) parts.push(size);
	const verify = verificationText(verification);
	if (verify.length > 0) parts.push(verify);
	const raw = parts.join("  ");
	const styled =
		verification?.status === "ok"
			? raw.replace(verify, theme.fg("success", verify))
			: verification?.status === "fail"
				? raw.replace(verify, theme.fg("error", verify))
				: raw;
	return padAnsi(styled, width);
}

export function viewFooterHint(focus: ViewPaneFocus, canVerify: boolean): string {
	if (focus === "list") {
		return buildHint("browse", [
			{ key: "↑↓", verb: "select" },
			{ key: "type", verb: "filter" },
			{ key: "Tab", verb: "content" },
			...(canVerify ? [{ key: "v", verb: "verify" }] : []),
			{ key: "o", verb: "path" },
		]);
	}
	return buildHint("browse", [
		{ key: "↑↓", verb: "scroll" },
		{ key: "PgUp/PgDn", verb: "page" },
		{ key: "g/G", verb: "top/bottom" },
		{ key: "Tab", verb: "list" },
		...(canVerify ? [{ key: "v", verb: "verify" }] : []),
		{ key: "o", verb: "path" },
	]);
}

export class ViewOverlayView implements Component {
	private artifacts: ViewArtifact[] = [];
	private filterText = "";
	private selectedIndex = 0;
	private listScrollOffset = 0;
	private contentScrollOffset = 0;
	private focus: ViewPaneFocus = "list";
	private loadingArtifacts = true;
	private artifactError: string | null = null;
	private content: LoadedContent | null = null;
	private loadToken = 0;
	private lastContentWidth = 80;
	private lastContentBodyHeight = 1;
	private readonly verifications = new Map<string, ViewVerificationState>();

	constructor(private readonly options: ViewOverlayOptions) {
		this.filterText = options.initialFilter ?? "";
	}

	refresh(): void {
		this.loadingArtifacts = true;
		this.artifactError = null;
		this.options.requestRender?.();
		void (async () => {
			try {
				this.artifacts = await listViewArtifacts(this.options.providers);
				this.selectedIndex = initialViewSelection(this.artifacts, this.filterText);
				this.contentScrollOffset = 0;
				this.content = null;
			} catch (err) {
				this.artifactError = err instanceof Error ? err.message : String(err);
				this.artifacts = [];
			} finally {
				this.loadingArtifacts = false;
				this.options.requestRender?.();
			}
		})();
	}

	getHint(): string {
		return viewFooterHint(this.focus, !!this.selectedArtifact()?.verify);
	}

	private filteredArtifacts(): ViewArtifact[] {
		return filterViewArtifacts(this.artifacts, this.filterText);
	}

	private selectedArtifact(): ViewArtifact | undefined {
		const filtered = this.filteredArtifacts();
		if (this.selectedIndex >= filtered.length) this.selectedIndex = Math.max(0, filtered.length - 1);
		return filtered[this.selectedIndex];
	}

	private selectIndex(next: number): void {
		const filtered = this.filteredArtifacts();
		if (filtered.length === 0) {
			this.selectedIndex = 0;
			this.content = null;
			return;
		}
		this.selectedIndex = (next + filtered.length) % filtered.length;
		this.contentScrollOffset = 0;
		this.content = null;
		this.options.requestRender?.();
	}

	private ensureContentLoaded(artifact: ViewArtifact | undefined): void {
		if (!artifact) return;
		const key = artifactKey(artifact);
		if (this.content?.key === key) return;
		const token = ++this.loadToken;
		this.content = { key, status: "loading", lines: ["loading artifact..."], format: "text" };
		void (async () => {
			try {
				const loaded = await artifact.load();
				if (token !== this.loadToken) return;
				this.content = { key, status: "loaded", lines: loaded.lines, format: loaded.format };
			} catch (err) {
				if (token !== this.loadToken) return;
				const message = err instanceof Error ? err.message : String(err);
				this.content = { key, status: "error", lines: [`load failed: ${message}`], format: "text", error: message };
			} finally {
				if (token === this.loadToken) this.options.requestRender?.();
			}
		})();
	}

	private renderedContentLines(width: number): string[] {
		const content = this.content;
		if (!content) return [];
		if (content.format !== "markdown") return content.lines;
		if (content.renderedLines && content.renderWidth === width) return content.renderedLines;
		const md = new Markdown(content.lines.join("\n"), 0, 0, markdownTheme(clioTheme()));
		const rendered = md.render(width);
		content.renderWidth = width;
		content.renderedLines = rendered;
		return rendered;
	}

	private renderList(width: number, height: number): string[] {
		const theme = clioTheme();
		const lines: string[] = [];
		const filterLabel = this.focus === "list" ? theme.fg("accent", "filter") : theme.fg("dim", "filter");
		const filterValue = this.filterText.length > 0 ? this.filterText : theme.fg("dim", "(empty)");
		lines.push(padAnsi(`${filterLabel}: ${filterValue}`, width));

		if (this.loadingArtifacts) {
			lines.push(padAnsi(theme.fg("dim", "loading artifacts..."), width));
			return this.fixedLines(lines, width, height);
		}
		if (this.artifactError) {
			lines.push(padAnsi(theme.fg("error", this.artifactError), width));
			return this.fixedLines(lines, width, height);
		}

		const filtered = this.filteredArtifacts();
		const rows = groupedViewRows(filtered);
		const selectedRow = rows.findIndex((row) => row.type === "item" && row.itemIndex === this.selectedIndex);
		const rowHeight = Math.max(1, height - 1);
		if (selectedRow >= 0) {
			if (selectedRow < this.listScrollOffset) this.listScrollOffset = selectedRow;
			if (selectedRow >= this.listScrollOffset + rowHeight) this.listScrollOffset = selectedRow - rowHeight + 1;
		}
		this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset, Math.max(0, rows.length - rowHeight)));

		for (const row of rows.slice(this.listScrollOffset, this.listScrollOffset + rowHeight)) {
			if (row.type === "group") {
				const count = filtered.filter((artifact) => artifact.category === row.category).length;
				lines.push(padAnsi(theme.fg("dim", `── ${categoryLabel(row.category)} (${count})`), width));
				continue;
			}
			if (row.type === "empty") {
				lines.push(padAnsi(theme.fg("dim", "  (empty)"), width));
				continue;
			}
			if (!row.item) continue;
			const selected = row.itemIndex === this.selectedIndex;
			const cursor = selected ? theme.fg("accent", "▸ ") : "  ";
			const title = selected ? theme.style("accent", row.item.title, { bold: true }) : row.item.title;
			const metaParts = [formatRelativeTime(row.item.timestamp), formatArtifactSize(row.item.sizeBytes)].filter(Boolean);
			const meta = metaParts.length > 0 ? theme.fg("dim", metaParts.join(" ")) : "";
			const available = Math.max(1, width - visibleWidth(cursor));
			const metaWidth = visibleWidth(meta);
			const titleWidth = Math.max(1, available - (metaWidth > 0 ? metaWidth + 1 : 0));
			const clippedTitle = truncateToWidth(title, titleWidth, "...", true);
			const gap = " ".repeat(Math.max(1, available - visibleWidth(clippedTitle) - metaWidth));
			lines.push(padAnsi(`${cursor}${clippedTitle}${metaWidth > 0 ? `${gap}${meta}` : ""}`, width));
		}

		return this.fixedLines(lines, width, height);
	}

	private renderContent(width: number, height: number): string[] {
		const artifact = this.selectedArtifact();
		this.ensureContentLoaded(artifact);
		this.lastContentWidth = width;
		const verification = artifact ? this.verifications.get(artifactKey(artifact)) : undefined;
		const header = buildArtifactHeader(artifact, verification, width);
		const bodyHeight = Math.max(0, height - 1);
		this.lastContentBodyHeight = Math.max(1, bodyHeight);
		const body = this.renderedContentLines(width);
		const maxOffset = Math.max(0, body.length - Math.max(1, bodyHeight));
		if (this.contentScrollOffset > maxOffset) this.contentScrollOffset = maxOffset;
		const visible = body
			.slice(this.contentScrollOffset, this.contentScrollOffset + bodyHeight)
			.map((line) => padAnsi(line, width));
		const lines = [header, ...visible];
		return this.fixedLines(lines, width, height);
	}

	private fixedLines(lines: readonly string[], width: number, height: number): string[] {
		const out = lines.slice(0, height).map((line) => padAnsi(line, width));
		while (out.length < height) out.push(" ".repeat(Math.max(0, width)));
		return out;
	}

	render(width: number): string[] {
		const bodyHeight = Math.max(1, this.options.getBodyHeight());
		const separatorWidth = visibleWidth(SEPARATOR);
		const leftWidth = Math.min(
			LEFT_PANE_MAX_WIDTH,
			Math.max(LEFT_PANE_MIN_WIDTH, Math.min(LEFT_PANE_TARGET_WIDTH, Math.floor(width * 0.38))),
		);
		const rightWidth = Math.max(1, width - leftWidth - separatorWidth);
		const list = this.renderList(leftWidth, bodyHeight);
		const content = this.renderContent(rightWidth, bodyHeight);
		const separator = clioTheme().fg("frame", SEPARATOR);
		return Array.from({ length: bodyHeight }, (_, index) => `${list[index] ?? ""}${separator}${content[index] ?? ""}`);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "tab")) {
			this.focus = this.focus === "list" ? "content" : "list";
			this.options.requestRender?.();
			return;
		}
		if (data === "v") {
			this.verifySelected();
			return;
		}
		if (data === "o") {
			this.openPathNotice();
			return;
		}
		if (matchesKey(data, "esc")) {
			if (this.focus === "list" && this.filterText.length > 0) {
				this.filterText = "";
				this.selectIndex(0);
				this.options.requestRender?.();
				return;
			}
			this.options.onClose();
			return;
		}
		if (this.focus === "content") {
			if (this.handleContentInput(data)) return;
		} else if (this.handleListInput(data)) {
			return;
		}
	}

	invalidate(): void {}

	private handleListInput(data: string): boolean {
		const filtered = this.filteredArtifacts();
		if (matchesKey(data, "up") || data === "k") {
			if (filtered.length > 0) this.selectIndex(this.selectedIndex - 1);
			return true;
		}
		if (matchesKey(data, "down") || data === "j") {
			if (filtered.length > 0) this.selectIndex(this.selectedIndex + 1);
			return true;
		}
		if (matchesKey(data, "backspace")) {
			if (this.filterText.length > 0) {
				this.filterText = this.filterText.slice(0, -1);
				this.selectIndex(0);
			}
			return true;
		}
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.filterText += data;
			this.selectIndex(0);
			return true;
		}
		return false;
	}

	private handleContentInput(data: string): boolean {
		const bodyHeight = this.lastContentBodyHeight;
		const total = this.renderedContentLines(this.lastContentWidth).length;
		let action: ViewScrollAction | null = null;
		if (matchesKey(data, "up") || data === "k") action = "line-up";
		else if (matchesKey(data, "down") || data === "j") action = "line-down";
		else if (data === "\x1b[5~") action = "page-up";
		else if (data === "\x1b[6~") action = "page-down";
		else if (data === "\x15") action = "half-up";
		else if (data === "\x04") action = "half-down";
		else if (data === "g") action = "top";
		else if (data === "G") action = "bottom";
		if (!action) return false;
		this.contentScrollOffset = nextContentScrollOffset(this.contentScrollOffset, total, bodyHeight, action);
		this.options.requestRender?.();
		return true;
	}

	private verifySelected(): void {
		const artifact = this.selectedArtifact();
		if (!artifact?.verify) return;
		const key = artifactKey(artifact);
		this.verifications.set(key, { status: "running" });
		this.options.requestRender?.();
		void artifact
			.verify()
			.then((result) => {
				this.verifications.set(
					key,
					result.ok ? { status: "ok", detail: result.detail } : { status: "fail", detail: result.detail },
				);
			})
			.catch((err) => {
				const detail = err instanceof Error ? err.message : String(err);
				this.verifications.set(key, { status: "fail", detail });
			})
			.finally(() => this.options.requestRender?.());
	}

	private openPathNotice(): void {
		const artifact = this.selectedArtifact();
		if (!artifact?.path) {
			this.options.notice?.("warning", "view: selected artifact has no backing path", "view:path");
			return;
		}
		this.options.notice?.("info", `artifact path: ${artifact.path}`, `view:path:${artifact.category}:${artifact.id}`);
	}
}

function viewBodyHeight(tui: TUI): number {
	return Math.max(1, tui.terminal.rows - VIEW_OVERLAY_MARGIN.top - VIEW_OVERLAY_MARGIN.bottom - 2);
}

export function openViewOverlay(
	tui: TUI,
	options: Omit<ViewOverlayOptions, "getBodyHeight" | "requestRender">,
): OverlayHandle {
	const view = new ViewOverlayView({
		...options,
		getBodyHeight: () => viewBodyHeight(tui),
		requestRender: () => tui.requestRender(),
	});
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "top-left",
		width: VIEW_OVERLAY_WIDTH,
		maxHeight: VIEW_OVERLAY_MAX_HEIGHT,
		margin: VIEW_OVERLAY_MARGIN,
		title: "View",
		footerHint: () => view.getHint(),
	});
	view.refresh();
	return handle;
}
