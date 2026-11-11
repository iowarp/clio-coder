/**
 * Ms. Clio: the pure game state behind the arcade easter egg. No I/O and no
 * timers; the overlay drives `tickArcade` and renders the result.
 */

export type ArcadeDirection = "up" | "down" | "left" | "right";
export type ArcadeStatus = "playing" | "won" | "lost";

export interface ArcadeGhost {
	readonly label: string;
	x: number;
	y: number;
}

export interface ArcadeState {
	/** Rows of cells: `#` wall, `c` emblem (a wall), `=` gate (ghosts only), `.` bug, `*` issue, space empty. */
	readonly grid: string[][];
	player: { x: number; y: number; facing: ArcadeDirection; next: ArcadeDirection | null };
	ghosts: ArcadeGhost[];
	score: number;
	remaining: number;
	status: ArcadeStatus;
	ticks: number;
}

/** `P` is the player start, `1`-`5` the ghosts in GHOST_LABELS order. */
/** A circuit-trace board around the C emblem chamber (`c`); the ghosts leave it through four gates. */
export const ARCADE_MAZE: readonly string[] = [
	"###########################",
	"#.....#.........#.........#",
	"#.###.#.#####.#.#.#######.#",
	"#.#...#.....#.#...#.....#.#",
	"#.#.#####.#.#.#####.###.#.#",
	"#.#.......#...........#...#",
	"#.####.##.##.#.####.#.###.#",
	"#......#####=#####..#.....#",
	"####.#.#    1    #.##.###.#",
	"#....#.#  ccccc  #....#...#",
	"#.####.=  c   2  =.##.#.#.#",
	"#......#  ccccc  #.#....#.#",
	"#.##.###3   4   5#.#.####.#",
	"#..#...#####=#####.#......#",
	"##.#.#..............#####.#",
	"#..#.#.#####.#.###.......##",
	"#.##...#...#.#...#.#####..#",
	"#....#.#.#.#.###.#.#...#..#",
	"#.####.#.#...#...#...#.##.#",
	"#....P.....#.....#.#.....*#",
	"#.##*......#.#.......##...#",
	"###########################",
];

export const GHOST_LABELS = ["CI", "CD", "lint", "tests", "review"] as const;

const STEP: Record<ArcadeDirection, readonly [number, number]> = {
	up: [0, -1],
	down: [0, 1],
	left: [-1, 0],
	right: [1, 0],
};
const ORDER: readonly ArcadeDirection[] = ["up", "left", "down", "right"];
const OPPOSITE: Record<ArcadeDirection, ArcadeDirection> = { up: "down", down: "up", left: "right", right: "left" };

export function createArcadeState(maze: readonly string[] = ARCADE_MAZE): ArcadeState {
	const grid: string[][] = [];
	const ghosts: ArcadeGhost[] = [];
	let player = { x: 1, y: 1 };
	let remaining = 0;
	maze.forEach((line, y) => {
		const row = [...line];
		row.forEach((cell, x) => {
			if (cell === "P") {
				player = { x, y };
				row[x] = " ";
			} else if (cell >= "1" && cell <= "5") {
				ghosts.push({ label: GHOST_LABELS[Number(cell) - 1] ?? "CI", x, y });
				row[x] = " ";
			} else if (cell === "." || cell === "*") remaining += 1;
		});
		grid.push(row);
	});
	ghosts.sort((a, b) => GHOST_LABELS.indexOf(a.label as never) - GHOST_LABELS.indexOf(b.label as never));
	return {
		grid,
		player: { ...player, facing: "left", next: null },
		ghosts,
		score: 0,
		remaining,
		status: "playing",
		ticks: 0,
	};
}

function cellAt(state: ArcadeState, x: number, y: number): string {
	return state.grid[y]?.[x] ?? "#";
}

function moved(x: number, y: number, dir: ArcadeDirection): { x: number; y: number } {
	const [dx, dy] = STEP[dir];
	return { x: x + dx, y: y + dy };
}

function open(state: ArcadeState, x: number, y: number, dir: ArcadeDirection, ghost: boolean): boolean {
	const to = moved(x, y, dir);
	const cell = cellAt(state, to.x, to.y);
	return cell !== "#" && cell !== "c" && (ghost || cell !== "=");
}

/** Queue a turn; it takes effect on the next tick the way is open. */
export function steerArcade(state: ArcadeState, dir: ArcadeDirection): void {
	if (state.status === "playing") state.player.next = dir;
}

/** The player always moves first, so a shared cell is the only way to meet. */
function caught(state: ArcadeState): boolean {
	return state.ghosts.some((ghost) => ghost.x === state.player.x && ghost.y === state.player.y);
}

/** Each ghost chases a point near the player; ties break in ORDER so play is deterministic. */
function moveGhost(
	state: ArcadeState,
	ghost: ArcadeGhost,
	index: number,
	last: ArcadeDirection | undefined,
): ArcadeDirection | undefined {
	const offsets: readonly (readonly [number, number])[] = [
		[0, 0],
		[4, 0],
		[-4, 0],
		[0, 3],
		[0, -3],
	];
	const [ox, oy] = offsets[index % offsets.length] ?? [0, 0];
	const tx = state.player.x + ox;
	const ty = state.player.y + oy;
	const options = ORDER.filter((dir) => open(state, ghost.x, ghost.y, dir, true));
	const forward = options.filter((dir) => last === undefined || dir !== OPPOSITE[last]);
	const choices = forward.length > 0 ? forward : options;
	let best: ArcadeDirection | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const dir of choices) {
		const to = moved(ghost.x, ghost.y, dir);
		const distance = Math.abs(to.x - tx) + Math.abs(to.y - ty);
		if (distance < bestDistance) {
			best = dir;
			bestDistance = distance;
		}
	}
	if (best === undefined) return last;
	const to = moved(ghost.x, ghost.y, best);
	ghost.x = to.x;
	ghost.y = to.y;
	return best;
}

const ghostHeading = new WeakMap<ArcadeGhost, ArcadeDirection>();

/** Advance one tick: the player moves, eats, then the ghosts move every other tick. */
export function tickArcade(state: ArcadeState): ArcadeStatus {
	if (state.status !== "playing") return state.status;
	state.ticks += 1;
	const player = state.player;
	if (player.next && open(state, player.x, player.y, player.next, false)) {
		player.facing = player.next;
		player.next = null;
	}
	if (open(state, player.x, player.y, player.facing, false)) {
		const to = moved(player.x, player.y, player.facing);
		player.x = to.x;
		player.y = to.y;
	}
	const row = state.grid[player.y];
	const cell = row?.[player.x];
	if (row && (cell === "." || cell === "*")) {
		state.score += cell === "*" ? 50 : 10;
		state.remaining -= 1;
		row[player.x] = " ";
	}
	if (caught(state)) state.status = "lost";
	else if (state.remaining === 0) state.status = "won";
	if (state.status !== "playing" || state.ticks % 2 === 1) return state.status;
	state.ghosts.forEach((ghost, i) => {
		const heading = moveGhost(state, ghost, i, ghostHeading.get(ghost));
		if (heading) ghostHeading.set(ghost, heading);
	});
	if (caught(state)) state.status = "lost";
	return state.status;
}
