/**
 * The architecture seed: an archify architecture specification derived from
 * the codewiki index, with no model call.
 *
 * `clio-coder context map` writes it so a "map this repository" turn starts
 * from real evidence instead of a blank page: components are the index's
 * largest directory areas, connections are its import edges collapsed
 * area-to-area, and every `sources` entry names a file and line the index
 * actually recorded. Clio never renders the seed; the archify skill validates
 * and delivers it, and `--repo-root` re-verifies every source path there.
 *
 * The output is deterministic for one index: keys are sorted, ids derive from
 * area paths, and every ranking breaks ties on path order. Two runs over the
 * same codewiki.json produce byte-identical JSON.
 */

import type { Codewiki, CodewikiFile, CodewikiInternalEdge, CodewikiSymbol } from "../codewiki/schema.js";
import { areaForPath, classifyDepth, WIKI_DEPTH_STRATEGY } from "./plan.js";

export type SeedComponentType = "frontend" | "backend" | "database" | "external";

export interface SeedSource {
	path: string;
	line?: number;
}

export type SeedSide = "top" | "bottom";

export interface SeedComponent {
	id: string;
	type: SeedComponentType;
	label: string;
	sublabel: string;
	row: number;
	col: number;
	size: [number, number];
	sources?: SeedSource[];
}

export interface SeedConnection {
	id: string;
	from: string;
	to: string;
	label: string;
	fromSide: SeedSide;
	toSide: SeedSide;
	route?: "straight";
	via?: [number, number][];
	/** Label center; set on straight routes, whose midpoint would otherwise sit on a node. */
	labelAt?: [number, number];
}

export interface SeedLayout {
	mode: "grid";
	origin: [number, number];
	cols: number;
	cellW: number;
	cellH: number;
	gapX: number;
	gapY: number;
}

export interface SeedRepository {
	url: string;
	revision: string;
}

export interface ArchitectureSeed {
	schema_version: 1;
	diagram_type: "architecture";
	meta: {
		title: string;
		quality_profile: "standard";
		repository?: SeedRepository;
	};
	layout: SeedLayout;
	components: SeedComponent[];
	connections: SeedConnection[];
}

export interface BuildArchitectureSeedOptions {
	title: string;
	/**
	 * Recorded as `meta.repository` only when it is a GitHub repository URL at
	 * a full 40-hex revision. Components carry `sources` only in that case,
	 * since archify accepts source citations only against a pinned revision.
	 */
	repository?: { url: string; revision: string } | undefined;
}

/** Most primary (internal area) components a seed carries. */
export const MAX_SEED_COMPONENTS = 12;
/** Most external-package components a seed carries. */
export const MAX_SEED_EXTERNALS = 3;
/** Most connections a seed carries, by descending import count. */
export const MAX_SEED_CONNECTIONS = 16;
/** Most `sources` entries per component; the schema caps at 3. */
const MAX_SEED_SOURCES = 3;
const GRID_COLS = 4;
const CELL_W = 220;
const CELL_H = 72;
const GAP_X = 70;
/** Vertical distance between route lanes inside one row gap or one margin. */
const LANE_STEP = 16;
/** Clearance between a node edge and the nearest lane, and beyond the last lane. */
const LANE_MARGIN = 24;
/** Horizontal offset of a straight route's label center from its line. */
const LABEL_BESIDE_OFFSET = 48;

const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const FULL_REVISION = /^[a-fA-F0-9]{40}$/;
const DATABASE_DIR =
	/^(?:store|stores|storage|persistence|persist|db|database|databases|repository|repositories|dao)$/i;

interface Area {
	key: string;
	files: CodewikiFile[];
	loc: number;
}

/** A schema-legal id from an area path: letters, digits, `_`, `-`, starting with a letter. */
function areaId(key: string): string {
	const slug = key
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	const body = slug.length > 0 ? slug : "root";
	return /^[a-z]/.test(body) ? body : `a-${body}`;
}

/** Keep readable ids, reserving every preferred spelling before adding collision suffixes. */
function uniqueIds(preferred: ReadonlyArray<string>): string[] {
	const reserved = new Set(preferred);
	const used = new Set<string>();
	return preferred.map((base) => {
		let id = base;
		if (used.has(id)) {
			let suffix = 2;
			do {
				id = `${base}-${suffix++}`;
			} while (reserved.has(id) || used.has(id));
		}
		used.add(id);
		return id;
	});
}

function componentTypeFor(area: Area): SeedComponentType {
	const last = area.key.split("/").filter(Boolean).at(-1) ?? "";
	if (DATABASE_DIR.test(last)) return "database";
	if (area.files.some((file) => file.role === "entry")) return "frontend";
	return "backend";
}

function collectAreas(files: ReadonlyArray<CodewikiFile>, areaDepth: number): Area[] {
	const byKey = new Map<string, Area>();
	for (const file of files) {
		const key = areaForPath(file.path, areaDepth);
		const area = byKey.get(key) ?? { key, files: [], loc: 0 };
		area.files.push(file);
		area.loc += Math.max(0, file.loc);
		byKey.set(key, area);
	}
	return [...byKey.values()].sort(
		(a, b) => b.files.length - a.files.length || b.loc - a.loc || a.key.localeCompare(b.key),
	);
}

/** The first declared symbol's line for each file id, when the index has one. */
function firstSymbolLines(symbols: ReadonlyArray<CodewikiSymbol>): Map<string, number> {
	const lines = new Map<string, number>();
	for (const symbol of symbols) {
		if (!Number.isInteger(symbol.line) || symbol.line < 1) continue;
		const current = lines.get(symbol.fileId);
		if (current === undefined || symbol.line < current) lines.set(symbol.fileId, symbol.line);
	}
	return lines;
}

function sourcesFor(area: Area, lines: ReadonlyMap<string, number>): SeedSource[] {
	return [...area.files]
		.sort((a, b) => b.loc - a.loc || a.path.localeCompare(b.path))
		.slice(0, MAX_SEED_SOURCES)
		.map((file) => {
			const line = lines.get(file.id);
			return line === undefined ? { path: file.path } : { line, path: file.path };
		});
}

function isInternalEdge(edge: Codewiki["edges"][number]): edge is CodewikiInternalEdge {
	return "toFileId" in edge;
}

/**
 * The package an external import specifier names: `@scope/pkg/deep` is
 * `@scope/pkg`, `pkg/sub` is `pkg`. Runtime builtins (`node:fs`, `fs`) are
 * not dependencies of the repository and return null.
 */
function externalPackage(specifier: string): string | null {
	if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) return null;
	const segments = specifier.split("/");
	if (specifier.startsWith("@")) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
	return segments[0] && segments[0].length > 0 ? segments[0] : null;
}

const NODE_BUILTINS = new Set([
	"assert",
	"buffer",
	"child_process",
	"crypto",
	"events",
	"fs",
	"http",
	"https",
	"module",
	"net",
	"os",
	"path",
	"process",
	"readline",
	"stream",
	"url",
	"util",
	"zlib",
]);

/** JSON with every object's keys sorted, so equal seeds serialize identically. */
export function serializeArchitectureSeed(seed: ArchitectureSeed): string {
	const sortKeys = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sortKeys);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.keys(value as Record<string, unknown>)
					.sort()
					.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
			);
		}
		return value;
	};
	return `${JSON.stringify(sortKeys(seed), null, 2)}\n`;
}

interface Unplaced {
	id: string;
	type: SeedComponentType;
	label: string;
	sublabel: string;
	sources?: SeedSource[];
}

interface WeightedEdge {
	from: string;
	to: string;
	weight: number;
}

/**
 * Rows by import direction. Edges are admitted by descending weight into a
 * DAG (an edge that would close a cycle is drawn anyway, but does not shape
 * the rows), and each node's row is its longest path from a source. Rows
 * wider than the grid wrap onto following rows; externals sit last since
 * nothing imports back into them.
 */
function assignRows(nodes: ReadonlyArray<Unplaced>, edges: ReadonlyArray<WeightedEdge>): Map<string, number> {
	const ids = nodes.filter((node) => node.type !== "external").map((node) => node.id);
	const successors = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
	const reaches = (from: string, to: string): boolean => {
		const stack = [from];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const current = stack.pop() as string;
			if (current === to) return true;
			if (seen.has(current)) continue;
			seen.add(current);
			for (const next of successors.get(current) ?? []) stack.push(next);
		}
		return false;
	};
	for (const edge of edges) {
		if (!successors.has(edge.from) || !successors.has(edge.to)) continue;
		if (reaches(edge.to, edge.from)) continue;
		successors.get(edge.from)?.add(edge.to);
	}
	const layer = new Map<string, number>();
	const depth = (id: string): number => {
		const known = layer.get(id);
		if (known !== undefined) return known;
		let best = 0;
		for (const node of ids) {
			if (successors.get(node)?.has(id)) best = Math.max(best, depth(node) + 1);
		}
		layer.set(id, best);
		return best;
	};
	for (const id of ids) depth(id);
	const rows = new Map<string, number>();
	let row = 0;
	const layers = [...new Set(ids.map((id) => layer.get(id) as number))].sort((a, b) => a - b);
	for (const current of layers) {
		// Node order within a layer follows the caller's ranking (file count).
		const members = ids.filter((id) => layer.get(id) === current);
		members.forEach((id, index) => {
			rows.set(id, row + Math.floor(index / GRID_COLS));
		});
		row += Math.ceil(members.length / GRID_COLS);
	}
	const externals = nodes.filter((node) => node.type === "external");
	externals.forEach((node, index) => {
		rows.set(node.id, row + Math.floor(index / GRID_COLS));
	});
	return rows;
}

/**
 * Place every node on the grid and give every connection an explicit
 * orthogonal route that cannot cross a node: routes leave and enter on the
 * top or bottom side, run horizontally only inside the gap between two rows,
 * and when they must pass other rows they do so in a margin column outside
 * the grid. Each gap and margin hands out distinct lanes so routes never
 * share a segment. The geometry is fixed cell math, the same the renderer
 * applies to `row`/`col`, so the via points land where the nodes are.
 */
function placeAndRoute(
	nodes: ReadonlyArray<Unplaced>,
	edges: ReadonlyArray<WeightedEdge>,
): { layout: SeedLayout; components: SeedComponent[]; connections: SeedConnection[] } {
	const rowOf = assignRows(nodes, edges);
	const colOf = new Map<string, number>();
	const used = new Map<number, number>();
	for (const node of nodes) {
		const row = rowOf.get(node.id) as number;
		const col = used.get(row) ?? 0;
		colOf.set(node.id, col);
		used.set(row, col + 1);
	}

	// Lane bookkeeping: which gap (below row r) and which margin each route uses.
	const gapLanes = new Map<number, number>();
	const leftLanes = { count: 0 };
	const rightLanes = { count: 0 };
	const takeGap = (row: number): number => {
		const lane = gapLanes.get(row) ?? 0;
		gapLanes.set(row, lane + 1);
		return lane;
	};
	interface Plan {
		edge: WeightedEdge;
		fromSide: SeedSide;
		toSide: SeedSide;
		straight: boolean;
		/** [gap row, lane] pairs in route order, and an optional margin lane. */
		gaps: Array<[number, number]>;
		margin?: { side: "left" | "right"; lane: number };
	}
	const plans: Plan[] = edges.map((edge) => {
		const fromRow = rowOf.get(edge.from) as number;
		const toRow = rowOf.get(edge.to) as number;
		const sameCol = colOf.get(edge.from) === colOf.get(edge.to);
		if (fromRow === toRow) {
			return { edge, fromSide: "bottom", toSide: "bottom", straight: false, gaps: [[fromRow, takeGap(fromRow)]] };
		}
		if (fromRow < toRow) {
			if (toRow === fromRow + 1) {
				return {
					edge,
					fromSide: "bottom",
					toSide: "top",
					straight: sameCol,
					gaps: sameCol ? [] : [[fromRow, takeGap(fromRow)]],
				};
			}
			return {
				edge,
				fromSide: "bottom",
				toSide: "top",
				straight: false,
				gaps: [
					[fromRow, takeGap(fromRow)],
					[toRow - 1, takeGap(toRow - 1)],
				],
				margin: { side: "left", lane: leftLanes.count++ },
			};
		}
		if (fromRow === toRow + 1) {
			return {
				edge,
				fromSide: "top",
				toSide: "bottom",
				straight: sameCol,
				gaps: sameCol ? [] : [[toRow, takeGap(toRow)]],
			};
		}
		return {
			edge,
			fromSide: "top",
			toSide: "bottom",
			straight: false,
			gaps: [
				[fromRow - 1, takeGap(fromRow - 1)],
				[toRow, takeGap(toRow)],
			],
			margin: { side: "right", lane: rightLanes.count++ },
		};
	});

	const maxGapLanes = Math.max(0, ...gapLanes.values());
	const gapY = Math.max(90, 2 * LANE_MARGIN + Math.max(1, maxGapLanes) * LANE_STEP);
	const originX = LANE_MARGIN + Math.max(1, leftLanes.count) * LANE_STEP + LANE_MARGIN;
	const layout: SeedLayout = {
		mode: "grid",
		origin: [originX, 80],
		cols: GRID_COLS,
		cellW: CELL_W,
		cellH: CELL_H,
		gapX: GAP_X,
		gapY,
	};
	const centerX = (id: string): number => originX + (colOf.get(id) as number) * (CELL_W + GAP_X) + CELL_W / 2;
	const topY = (row: number): number => layout.origin[1] + row * (CELL_H + gapY);
	const laneY = (row: number, lane: number): number => topY(row) + CELL_H + LANE_MARGIN + lane * LANE_STEP;
	const gridRight = originX + GRID_COLS * (CELL_W + GAP_X) - GAP_X;
	const marginX = (margin: NonNullable<Plan["margin"]>): number =>
		margin.side === "left"
			? originX - LANE_MARGIN - margin.lane * LANE_STEP
			: gridRight + LANE_MARGIN + margin.lane * LANE_STEP;

	const components: SeedComponent[] = nodes.map((node) => ({
		id: node.id,
		type: node.type,
		label: node.label,
		sublabel: node.sublabel,
		row: rowOf.get(node.id) as number,
		col: colOf.get(node.id) as number,
		size: [CELL_W, CELL_H],
		...(node.sources ? { sources: node.sources } : {}),
	}));
	const connectionIds = uniqueIds(plans.map(({ edge }) => `${edge.from}-to-${edge.to}`));
	const connections: SeedConnection[] = plans.map((plan, index) => {
		const { edge } = plan;
		const base: SeedConnection = {
			id: connectionIds[index] as string,
			from: edge.from,
			to: edge.to,
			label: `${edge.weight} import${edge.weight === 1 ? "" : "s"}`,
			fromSide: plan.fromSide,
			toSide: plan.toSide,
		};
		const xa = centerX(edge.from);
		const xb = centerX(edge.to);
		if (plan.straight) {
			// A straight vertical between two adjacent rows in one column: put the
			// label beside the line, centered on the gap, so it covers neither node.
			const upperRow = Math.min(rowOf.get(edge.from) as number, rowOf.get(edge.to) as number);
			const gapMid = topY(upperRow) + CELL_H + gapY / 2;
			return { ...base, route: "straight", labelAt: [xa + LABEL_BESIDE_OFFSET, gapMid] };
		}
		const [first, second] = plan.gaps;
		if (!first) return { ...base, route: "straight" };
		const y1 = laneY(first[0], first[1]);
		if (!plan.margin || !second)
			return {
				...base,
				via: [
					[xa, y1],
					[xb, y1],
				],
			};
		const y2 = laneY(second[0], second[1]);
		const mx = marginX(plan.margin);
		return {
			...base,
			via: [
				[xa, y1],
				[mx, y1],
				[mx, y2],
				[xb, y2],
			],
		};
	});
	return { layout, components, connections };
}

export function buildArchitectureSeed(codewiki: Codewiki, options: BuildArchitectureSeedOptions): ArchitectureSeed {
	const source = codewiki.files.filter((file) => file.lang !== "config");
	const sourceLines = source.reduce((total, file) => total + Math.max(0, file.loc), 0);
	const { areaDepth } = WIKI_DEPTH_STRATEGY[classifyDepth(source.length, sourceLines)];
	const areas = collectAreas(source, areaDepth).slice(0, MAX_SEED_COMPONENTS);
	const lines = firstSymbolLines(codewiki.symbols);
	const areaByFile = new Map<string, string>();
	for (const area of areas) for (const file of area.files) areaByFile.set(file.id, area.key);

	// Archify's repository-evidence contract: `sources` are only legal when
	// `meta.repository` pins the revision they were read at. Without a GitHub
	// origin at a full sha the seed cites nothing rather than citing what the
	// validator would reject.
	const repository = options.repository;
	const pinned =
		repository && GITHUB_REPOSITORY_URL.test(repository.url) && FULL_REVISION.test(repository.revision)
			? { url: repository.url, revision: repository.revision.toLowerCase() }
			: undefined;

	// External packages: one component per top external module by import
	// count, so the map shows what the repository leans on beyond itself.
	const externalCounts = new Map<string, number>();
	const externalWeights = new Map<string, number>();
	for (const edge of codewiki.edges) {
		if (isInternalEdge(edge)) continue;
		const fromArea = areaByFile.get(edge.fileId);
		const pkg = externalPackage(edge.externalModule);
		if (fromArea === undefined || pkg === null) continue;
		externalCounts.set(pkg, (externalCounts.get(pkg) ?? 0) + 1);
		const key = `${fromArea}\0${pkg}`;
		externalWeights.set(key, (externalWeights.get(key) ?? 0) + 1);
	}
	const externals = [...externalCounts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, MAX_SEED_EXTERNALS)
		.map(([module]) => module);
	// Both component kinds share one identity namespace. Reserve all readable
	// spellings before allocating suffixes, including names already ending in -2.
	const componentIds = uniqueIds([
		...areas.map((area) => areaId(area.key)),
		...externals.map((module) => `ext-${areaId(module)}`),
	]);
	const idByArea = new Map(areas.map((area, index) => [area.key, componentIds[index] as string]));
	const idByExternal = new Map(externals.map((module, index) => [module, componentIds[areas.length + index] as string]));
	const nodes: Unplaced[] = areas.map((area) => {
		const sources = pinned ? sourcesFor(area, lines) : [];
		return {
			id: idByArea.get(area.key) as string,
			type: componentTypeFor(area),
			label: area.key,
			sublabel: `${area.files.length} file${area.files.length === 1 ? "" : "s"}, ${area.loc} LOC`,
			...(sources.length > 0 ? { sources } : {}),
		};
	});
	for (const module of externals) {
		const count = externalCounts.get(module) ?? 0;
		nodes.push({
			id: idByExternal.get(module) as string,
			type: "external",
			label: module,
			sublabel: `${count} import${count === 1 ? "" : "s"}`,
		});
	}

	// Internal edges collapsed area to area; self edges are the area's own
	// internal structure and say nothing about boundaries. Preserve destination
	// kind in the weight key: a local area and a package may have the same name.
	const weights = new Map<string, number>();
	for (const edge of codewiki.edges) {
		if (!isInternalEdge(edge)) continue;
		const from = areaByFile.get(edge.fileId);
		const to = areaByFile.get(edge.toFileId);
		if (from === undefined || to === undefined || from === to) continue;
		const key = `${from}\0${to}\0internal`;
		weights.set(key, (weights.get(key) ?? 0) + 1);
	}
	for (const module of externals) {
		for (const area of areas) {
			const weight = externalWeights.get(`${area.key}\0${module}`);
			if (weight) weights.set(`${area.key}\0${module}\0external`, weight);
		}
	}
	const edges: WeightedEdge[] = [...weights.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, MAX_SEED_CONNECTIONS)
		.map(([key, weight]) => {
			const [fromKey, toKey, kind] = key.split("\0") as [string, string, "internal" | "external"];
			const from = idByArea.get(fromKey) as string;
			const to = (kind === "internal" ? idByArea : idByExternal).get(toKey) as string;
			return { from, to, weight };
		});
	const { layout, components, connections } = placeAndRoute(nodes, edges);

	const meta: ArchitectureSeed["meta"] = {
		title: options.title,
		quality_profile: "standard",
		...(pinned ? { repository: pinned } : {}),
	};
	return {
		schema_version: 1,
		diagram_type: "architecture",
		meta,
		layout,
		components,
		connections,
	};
}
