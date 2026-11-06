import { extensionOwnerLabel } from "../../domains/extensions/owner-label.js";
import type { ExtensionStatus } from "../../domains/extensions/public-api.js";
import type { ExtensionSkin } from "../../domains/extensions/public-api-v2.js";
import type { ActiveExtensionWorkspace, ExtensionSurfaceModel } from "../../domains/extensions/surface-model.js";
import type { View } from "../../domains/extensions/view.js";
import type { Component, TUI } from "../../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { GLYPH } from "../theme/glyphs.js";
import { applySkin, clioTheme, frame } from "../theme/index.js";
import type { SemanticRole } from "../theme/tokens.js";
import { skinEpoch } from "../theme/tokens.js";
import { renderView } from "./view-renderer.js";

/** Island tiles share a row of the dock, each between these widths, one column apart. */
const ISLAND_TILE_MAX_WIDTH = 48;
const ISLAND_TILE_MIN_WIDTH = 30;
const ISLAND_BODY_ROWS = 6;
/** Below this terminal height the islands keep one row naming them instead of tiles. */
const ISLAND_MIN_ROWS = 18;
/** Share of the terminal's rows the tiles may take, so the transcript keeps most of the screen. */
const ISLAND_ROW_SHARE = 0.4;
const HEADER_ROWS = 12;
const BOARD_ROWS = 14;

const STATUS_ROLES = {
	neutral: "counter",
	positive: "success",
	warning: "warning",
	error: "error",
} as const satisfies Record<NonNullable<ExtensionStatus["tone"]>, SemanticRole>;

/**
 * An extension status as `Owner: words`. A status that already opens with its
 * owner's name ("Local status ready") gives the name to the label instead of
 * saying it twice, so the footer reads "Local status: ready".
 */
function ownedStatus(owner: string, text: string): { owner: string; text: string } {
	const trimmed = text.trim();
	if (trimmed.toLowerCase().startsWith(owner.toLowerCase())) {
		const rest = trimmed.slice(owner.length).replace(/^[\s:·-]+/u, "");
		if (rest.length > 0) return { owner: trimmed.slice(0, owner.length), text: rest };
	}
	return { owner, text: trimmed };
}

export interface WorkspaceSurfaceDeps {
	model: ExtensionSurfaceModel;
	tui: Pick<TUI, "requestRender">;
	skinFor(active: ActiveExtensionWorkspace): ExtensionSkin | null;
	/** How the operator leaves, as the exit label prints it. */
	leaveHint(): string;
	/** The terminal's height, which bounds how many dock rows the island tiles take. */
	terminalRows?(): number;
	/** A workspace key or a band action was pressed through the leader menu. */
	press(extensionId: string, action: string, source?: "leader" | "band"): void;
	/** The leader key as the footer prints it, or null when none is bound. */
	leaderLabel?(): string | null;
	/** Open the board in the pressable panel; absent where no such panel exists. */
	focusBoard?(extensionId: string, title: string, view: () => View | undefined): void;
	leave(): void;
	/**
	 * Statuses from runtimes outside the surface model (api 1), so the footer is
	 * the one place every running extension's status is read.
	 */
	otherStatuses?(): ReadonlyArray<{ id: string; status: ExtensionStatus }>;
}

/** The leader suffix that leaves an active workspace; built-in suffixes never use it. */
export const WORKSPACE_LEAVE_KEY = "b";
/** The leader suffix that opens the workspace board for selecting and pressing its cards and rows. */
export const WORKSPACE_FOCUS_KEY = "j";

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
	/**
	 * Workspace board, its island tiles, then owner-labelled ambient bands, all
	 * in the dock above the steering queue.
	 */
	readonly board: Component;
	/** First segment of the composer's top rail, or null to keep the host's model nickname. */
	rail(width: number): string | null;
	/** One footer line naming the workspace, its footer region and how to leave. */
	footerLine(width: number): string | null;
	/** Owner-labelled status facts for the compact footer's second line. */
	statusFacts(width: number): string[];
	/** The active workspace's leader entries: its declared keys, then how to leave. */
	leaderTargets(): Array<{ key: string; label: string; run: () => void }>;
	dispose(): void;
}

/** The action rows inside a band, in drawing order. */
function bandActionItems(view: View): Array<{ id: string; label: string }> {
	if (view.t === "actions") return view.items;
	if (view.t === "box") return view.children.flatMap(bandActionItems);
	return [];
}

/** A copy of a band whose action rows show the key that presses them. */
function withBandKeys(view: View, keys: ReadonlyMap<string, string>): View {
	if (view.t === "actions")
		return {
			...view,
			// A band's own hotkey is never live, since a band never holds the keys; only the leader chord is shown.
			items: view.items.map(({ hotkey: _unused, ...item }) => {
				const key = keys.get(item.id);
				return key === undefined ? item : { ...item, hotkey: key };
			}),
		};
	if (view.t === "box") return { ...view, children: view.children.map((child) => withBandKeys(child, keys)) };
	return view;
}

/** Whether a view names an action a row, card or node press would send. */
function pressable(view: View | undefined): boolean {
	if (view === undefined) return false;
	if ((view.t === "board" || view.t === "table" || view.t === "list" || view.t === "tree") && view.action) return true;
	if (view.t === "actions") return view.items.length > 0;
	return view.t === "box" && view.children.some(pressable);
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

	/**
	 * The workspace's islands as framed tiles side by side in the dock. They
	 * were a floating stack anchored top right, which painted over transcript
	 * words, so they now take rows of their own like the task board's row. A
	 * tile row that does not fit the budget whole becomes one row naming the
	 * islands left out.
	 */
	const islandRows = (active: ActiveExtensionWorkspace, width: number, budget: number): string[] => {
		const theme = clioTheme();
		const board = active.board === "island" && active.regions.includes("board") ? regionView(active, "board") : undefined;
		const tiles: Array<{ title: string; view: View; meta?: string }> = [
			...(board ? [{ title: active.title, view: board }] : []),
			...(active.regions.includes("islands")
				? (deps.model.entry(active.extensionId)?.islands ?? []).map((island) => ({
						title: island.title,
						view: island.view,
						...(island.meta ? { meta: island.meta } : {}),
					}))
				: []),
		];
		if (tiles.length === 0 || width < 1) return [];
		const left = (from: number): string => {
			const rest = tiles.slice(from);
			const names = rest.map((tile) => tile.title).join(", ");
			const lead =
				from === 0 ? "Islands" : `${rest.length} more ${rest.length === 1 ? "island" : "islands"} need a taller terminal`;
			const row = `${theme.fg("sectionHeading", lead)}${theme.fg("border", " · ")}${theme.fg("annotation", names)}`;
			return truncateToWidth(row, width, GLYPH.ellipsis, false);
		};
		if (budget < ISLAND_BODY_ROWS) return budget > 0 ? [left(0)] : [];
		const columns = Math.max(1, Math.min(tiles.length, Math.floor((width + 1) / (ISLAND_TILE_MIN_WIDTH + 1))));
		const tileWidth = Math.max(4, Math.min(ISLAND_TILE_MAX_WIDTH, Math.floor((width - (columns - 1)) / columns)));
		const out: string[] = [];
		for (let index = 0; index < tiles.length; index += columns) {
			const group = tiles.slice(index, index + columns);
			const bodies = group.map((tile) => draw(tile.view, tileWidth - 4, ISLAND_BODY_ROWS));
			const height = Math.max(...bodies.map((body) => body.length));
			const more = index + columns < tiles.length ? 1 : 0;
			if (out.length + height + 2 + more > budget) {
				out.push(left(index));
				break;
			}
			const framed = group.map((tile, at) =>
				frame(
					theme,
					tile.title,
					[...(bodies[at] ?? []), ...Array.from({ length: height - (bodies[at]?.length ?? 0) }, () => "")],
					tileWidth,
					tile.meta ? { rightMeta: tile.meta } : {},
				),
			);
			for (let row = 0; row < height + 2; row++) out.push(framed.map((lines) => lines[row] ?? "").join(" "));
		}
		return out;
	};
	const islandBudget = (): number => {
		const rows = deps.terminalRows?.();
		if (rows === undefined) return ISLAND_BODY_ROWS * 2 + 4;
		return rows < ISLAND_MIN_ROWS ? 1 : Math.floor(rows * ISLAND_ROW_SHARE);
	};

	// The skin follows the workspace: on when one is entered, off when it is left or dropped.
	let skinned = false;
	const unsubscribe = deps.model.subscribe((event) => {
		if (event?.kind === "workspace") {
			const skin = event.active ? deps.skinFor(event.active) : null;
			if (skin || skinned) applySkin(skin);
			skinned = skin !== null;
		}
		deps.tui.requestRender();
	});

	/** Every band action with the leader suffix that presses it: digits, in band order, up to nine. */
	const bandPresses = (): Array<{ extensionId: string; action: string; label: string; key: string }> => {
		const presses: Array<{ extensionId: string; action: string; label: string; key: string }> = [];
		for (const id of deps.model.ids().sort()) {
			const band = deps.model.entry(id)?.band;
			if (!band) continue;
			for (const item of bandActionItems(band)) {
				if (presses.length >= 9) return presses;
				presses.push({ extensionId: id, action: item.id, label: item.label, key: String(presses.length + 1) });
			}
		}
		return presses;
	};

	const board: Component = {
		render(width) {
			const budget = islandBudget();
			return memo("board", `${width}:${budget}`, () => {
				const active = takes("board");
				const view = active?.board === "band" ? regionView(active, "board") : undefined;
				const lines = view ? draw(view, width, BOARD_ROWS) : [];
				const workspace = deps.model.activeWorkspace;
				if (workspace) lines.push(...islandRows(workspace, width, budget));
				const leader = deps.leaderLabel?.() ?? null;
				const pressKeys = bandPresses();
				for (const id of deps.model.ids().sort()) {
					const band = deps.model.entry(id)?.band;
					if (!band) continue;
					// The band is labelled with the name the operator installed, not the package id.
					const owner = clioTheme().fg("sectionHeading", `${extensionOwnerLabel(id)} · `);
					const indent = " ".repeat(visibleWidth(owner));
					// A band never holds the keyboard, so its actions are pressed through the leader
					// menu, and each row names that chord instead of a cursor nothing can move.
					const keys = new Map(
						leader === null
							? []
							: pressKeys.filter((press) => press.extensionId === id).map((press) => [press.action, `${leader} ${press.key}`]),
					);
					const rows = draw(withBandKeys(band, keys), Math.max(1, width - visibleWidth(owner)), 3);
					lines.push(
						...rows.map((row, index) =>
							truncateToWidth(`${index === 0 ? owner : indent}${row}`, width, GLYPH.ellipsis, false),
						),
					);
				}
				return lines;
			});
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
			const modelIds = new Set(deps.model.ids());
			const others = (deps.otherStatuses?.() ?? []).filter((entry) => !modelIds.has(entry.id));
			const othersKey = others
				.map((entry) => `${entry.id}\u0000${entry.status.tone ?? ""}\u0000${entry.status.text}`)
				.join("\u0001");
			return memo("status", `${width}:${othersKey}`, () => {
				const theme = clioTheme();
				// The footer gives its facts up to half the row when wide; one status may use all of it.
				const room = Math.max(12, Math.floor(width * (width >= 100 ? 0.5 : 0.4)));
				const statuses = [
					// An extension with a band already says its piece above the composer on every frame;
					// repeating it here only crowds out the extensions that have no band.
					...deps.model.ids().flatMap((id) => {
						const entry = deps.model.entry(id);
						return entry?.status && !entry.band ? [{ id, status: entry.status }] : [];
					}),
					...others,
				];
				return statuses.flatMap(({ id, status }) => {
					const { owner, text } = ownedStatus(extensionOwnerLabel(id), status.text);
					const label = `${owner}: `;
					const body = truncateToWidth(text, Math.max(4, room - visibleWidth(label)), GLYPH.ellipsis, false);
					return [`${theme.fg("annotation", label)}${theme.fg(STATUS_ROLES[status.tone ?? "neutral"], body)}`];
				});
			});
		},
		leaderTargets() {
			const bands = bandPresses().map((press) => ({
				key: press.key,
				label: `${extensionOwnerLabel(press.extensionId)}: ${press.label}`,
				run: () => deps.press(press.extensionId, press.action, "band"),
			}));
			const active = deps.model.activeWorkspace;
			if (!active) return bands;
			return [
				...bands,
				...active.keys
					.filter((binding) => binding.key !== WORKSPACE_LEAVE_KEY && binding.key !== WORKSPACE_FOCUS_KEY)
					.map((binding) => ({
						key: binding.key,
						label: `${active.title}: ${binding.label}`,
						run: () => deps.press(active.extensionId, binding.action),
					})),
				...(deps.focusBoard && active.regions.includes("board") && pressable(regionView(active, "board"))
					? [
							{
								key: WORKSPACE_FOCUS_KEY,
								label: `${active.title}: select a card on the board`,
								run: () =>
									deps.focusBoard?.(active.extensionId, active.title, () => {
										const current = deps.model.activeWorkspace;
										return current?.extensionId === active.extensionId ? regionView(current, "board") : undefined;
									}),
							},
						]
					: []),
				{ key: WORKSPACE_LEAVE_KEY, label: `Leave ${active.title}`, run: () => deps.leave() },
			];
		},
		dispose() {
			unsubscribe();
			if (skinned) applySkin(null);
			skinned = false;
		},
	};
}
