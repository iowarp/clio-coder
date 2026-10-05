import type { ExtensionStatus } from "../../domains/extensions/public-api.js";
import type { ExtensionSkin } from "../../domains/extensions/public-api-v2.js";
import type { ActiveExtensionWorkspace, ExtensionSurfaceModel } from "../../domains/extensions/surface-model.js";
import type { View } from "../../domains/extensions/view.js";
import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { GLYPH } from "../theme/glyphs.js";
import { applySkin, clioTheme, frame } from "../theme/index.js";
import type { SemanticRole } from "../theme/tokens.js";
import { skinEpoch } from "../theme/tokens.js";
import { renderView } from "./view-renderer.js";

/** The floating stack matches the host's task island width, so the two read as one family. */
const WORKSPACE_ISLAND_WIDTH = 48;
const ISLAND_MIN_COLUMNS = 80;
const ISLAND_MIN_ROWS = 18;
const ISLAND_BODY_ROWS = 12;
const ISLAND_STACK_ROWS = 28;
const HEADER_ROWS = 12;
const BOARD_ROWS = 14;

const STATUS_ROLES = {
	neutral: "counter",
	positive: "success",
	warning: "warning",
	error: "error",
} as const satisfies Record<NonNullable<ExtensionStatus["tone"]>, SemanticRole>;

export interface WorkspaceSurfaceDeps {
	model: ExtensionSurfaceModel;
	tui: Pick<TUI, "requestRender" | "showOverlay">;
	skinFor(active: ActiveExtensionWorkspace): ExtensionSkin | null;
	/** How the operator leaves, as the exit label prints it. */
	leaveHint(): string;
	/** Host overlays own the screen; the floating stack hides under them like the task island. */
	isOverlayOpen(): boolean;
}

/**
 * The terminal side of the extension surface model: everything an active
 * workspace draws in place of the host's own parts, plus the ambient status
 * facts. Each part is painted from getters at render time and cached per
 * width, data version and skin epoch, so an idle frame costs a key compare.
 * Nothing here talks to a runtime; presses go back through the facade.
 */
export interface WorkspaceSurfaces {
	active(): ActiveExtensionWorkspace | null;
	/** The banner part: the workspace header while one is active, the host banner otherwise. */
	banner(host: Component): Component;
	/** A band above the steering queue; empty unless the workspace places its board there. */
	readonly board: Component;
	/** First segment of the composer's top rail, or null to keep the host's model nickname. */
	rail(width: number): string | null;
	/** One footer line naming the workspace, its footer region and how to leave. */
	footerLine(width: number): string | null;
	/** Owner-labelled status facts for the compact footer's second line. */
	statusFacts(width: number): string[];
	/** True while the workspace's islands hold the top-right corner. */
	yieldsTaskIsland(): boolean;
	/** Re-evaluate the floating stack; called on model change and by the host's island tick. */
	refresh(): void;
	dispose(): void;
}

export function createWorkspaceSurfaces(deps: WorkspaceSurfaceDeps): WorkspaceSurfaces {
	const cache = new Map<string, { key: string; lines: string[] }>();
	const memo = (slot: string, extra: string, build: () => string[]): string[] => {
		const active = deps.model.activeWorkspace;
		const key = `${deps.model.version}:${skinEpoch()}:${active?.extensionId ?? ""}:${active?.workspaceId ?? ""}:${extra}`;
		const hit = cache.get(slot);
		if (hit?.key === key) return hit.lines;
		const lines = build();
		cache.set(slot, { key, lines });
		return lines;
	};
	const takes = (region: ActiveExtensionWorkspace["regions"][number]): ActiveExtensionWorkspace | null => {
		const active = deps.model.activeWorkspace;
		return active?.regions.includes(region) ? active : null;
	};
	const regionView = (
		active: ActiveExtensionWorkspace,
		region: "header" | "board" | "rail" | "footer",
	): View | undefined => deps.model.entry(active.extensionId)?.regions[region];
	const draw = (view: View, width: number, rows: number): string[] =>
		renderView(view, Math.max(1, width), { maxRows: rows }).lines;

	const islandLines = (): string[] => {
		const active = deps.model.activeWorkspace;
		if (!active) return [];
		return memo("islands", "", () => {
			const theme = clioTheme();
			const inner = WORKSPACE_ISLAND_WIDTH - 4;
			const out: string[] = [];
			const board =
				active.board === "island" && active.regions.includes("board") ? regionView(active, "board") : undefined;
			if (board) out.push(...frame(theme, active.title, draw(board, inner, ISLAND_BODY_ROWS), WORKSPACE_ISLAND_WIDTH));
			if (active.regions.includes("islands"))
				for (const island of deps.model.entry(active.extensionId)?.islands ?? []) {
					if (out.length >= ISLAND_STACK_ROWS) break;
					out.push(
						...frame(
							theme,
							island.title,
							draw(island.view, inner, ISLAND_BODY_ROWS),
							WORKSPACE_ISLAND_WIDTH,
							island.meta ? { rightMeta: island.meta } : {},
						),
					);
				}
			return out.slice(0, ISLAND_STACK_ROWS);
		});
	};
	const islandComponent: Component = {
		render: () => islandLines(),
		invalidate: () => cache.delete("islands"),
	};
	let islandHandle: OverlayHandle | undefined;
	let islandHidden = true;
	const refresh = (): void => {
		const hidden = islandLines().length === 0;
		if (!islandHandle && !hidden)
			islandHandle = deps.tui.showOverlay(islandComponent, {
				anchor: "top-right",
				width: WORKSPACE_ISLAND_WIDTH,
				margin: { top: 1, right: 1 },
				nonCapturing: true,
				// Checked at composite time, so an overlay opening hides the stack without a model change.
				visible: (width, height) => width >= ISLAND_MIN_COLUMNS && height >= ISLAND_MIN_ROWS && !deps.isOverlayOpen(),
			});
		if (islandHandle && hidden !== islandHidden) islandHandle.setHidden(hidden);
		islandHidden = hidden;
	};

	// The skin follows the workspace: on when one is entered, off when it is left or dropped.
	let skinned = false;
	const unsubscribe = deps.model.subscribe((event) => {
		if (event?.kind === "workspace") {
			const skin = event.active ? deps.skinFor(event.active) : null;
			if (skin || skinned) applySkin(skin);
			skinned = skin !== null;
		}
		refresh();
		deps.tui.requestRender();
	});

	const board: Component = {
		render(width) {
			const active = takes("board");
			if (active?.board !== "band") return [];
			const view = regionView(active, "board");
			return view ? memo("board", String(width), () => draw(view, width, BOARD_ROWS)) : [];
		},
		invalidate: () => cache.delete("board"),
	};

	return {
		active: () => deps.model.activeWorkspace,
		banner(host) {
			return {
				render(width) {
					const active = takes("header");
					if (!active) return host.render(width);
					const view = regionView(active, "header");
					return memo("header", String(width), () =>
						view
							? draw(view, width, HEADER_ROWS)
							: [truncateToWidth(clioTheme().fg("sectionHeading", active.title), width, GLYPH.ellipsis, false)],
					);
				},
				invalidate() {
					cache.delete("header");
					host.invalidate();
				},
			};
		},
		board,
		rail(width) {
			const active = takes("rail");
			if (!active) return null;
			const view = regionView(active, "rail");
			if (!view) return null;
			const line = memo("rail", String(width), () => draw(view, width, 1))[0];
			return line === undefined || visibleWidth(line.trim()) === 0
				? null
				: truncateToWidth(line.trim(), width, GLYPH.ellipsis, false);
		},
		footerLine(width) {
			const active = deps.model.activeWorkspace;
			if (!active) return null;
			return (
				memo("footer", String(width), () => {
					const theme = clioTheme();
					const separator = theme.fg("border", " · ");
					const exit = theme.fg("keyboardHint", deps.leaveHint());
					const title = theme.fg("sectionHeading", active.title);
					const view = active.regions.includes("footer") ? regionView(active, "footer") : undefined;
					const room = Math.max(1, width - visibleWidth(title) - visibleWidth(exit) - 6);
					const middle = view ? (draw(view, room, 1)[0]?.trim() ?? "") : "";
					const parts = middle ? [title, truncateToWidth(middle, room, GLYPH.ellipsis, false), exit] : [title, exit];
					return [truncateToWidth(parts.join(separator), width, GLYPH.ellipsis, false)];
				})[0] ?? null
			);
		},
		statusFacts(width) {
			return memo("status", String(width), () => {
				const theme = clioTheme();
				const room = Math.max(8, Math.floor(width / 4));
				return deps.model.ids().flatMap((id) => {
					const status = deps.model.entry(id)?.status;
					if (!status) return [];
					const text = truncateToWidth(`${id} ${status.text}`, room, GLYPH.ellipsis, false);
					return [theme.fg(STATUS_ROLES[status.tone ?? "neutral"], text)];
				});
			});
		},
		yieldsTaskIsland() {
			const active = deps.model.activeWorkspace;
			return active !== null && (active.regions.includes("islands") || active.board === "island");
		},
		refresh,
		dispose() {
			unsubscribe();
			islandHandle?.hide();
			islandHandle = undefined;
			if (skinned) applySkin(null);
			skinned = false;
		},
	};
}
