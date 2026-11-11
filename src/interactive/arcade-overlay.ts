/**
 * Ms. Clio: the arcade easter egg overlay. Opened only by its trigger phrase;
 * it draws over the terminal, owns the keys while open, and leaves nothing
 * behind when closed: no timer, no session entry, no telemetry.
 */
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { matchesKey } from "../engine/tui.js";
import {
	ARCADE_MAZE,
	type ArcadeDirection,
	type ArcadeState,
	createArcadeState,
	steerArcade,
	tickArcade,
} from "./arcade-game.js";
import { ARCADE_PALETTE } from "./theme/arcade-palette.js";

const TICK_MS = 140;
const { bg: BG, wall: WALL, teal: TEAL, orange: ORANGE, ghost: GHOST, bold: BOLD, reset: RESET } = ARCADE_PALETTE;

/** Columns and rows the maze needs: two columns a cell, plus a title and a key line. */
export function arcadeSize(maze: readonly string[] = ARCADE_MAZE): { columns: number; rows: number } {
	return { columns: Math.max(...maze.map((row) => row.length)) * 2, rows: maze.length + 2 };
}

function ghostGlyph(label: string): string {
	return label.length >= 2 ? label.slice(0, 2) : `${label} `;
}

/** Render the board as plain lines of exactly `width` visible columns each. */
export function renderArcade(state: ArcadeState, width: number, height: number): string[] {
	const size = arcadeSize();
	if (width < size.columns || height < size.rows) {
		const notice = `Ms. Clio needs a ${size.columns}x${size.rows} terminal (this one is ${width}x${height}). Press q to return.`;
		return [notice.slice(0, Math.max(0, width))];
	}
	const pad = Math.floor((width - size.columns) / 2);
	const fill = (text: string, visible: number) =>
		`${BG}${" ".repeat(pad)}${text}${BG}${" ".repeat(Math.max(0, width - pad - visible))}${RESET}`;
	const ghostAt = new Map(state.ghosts.map((ghost) => [`${ghost.x},${ghost.y}`, ghost.label]));
	const lines: string[] = [];
	const status =
		state.status === "won"
			? "All bugs fixed. Ship it! (Enter: again, q: quit)"
			: state.status === "lost"
				? "Caught by the gates. (Enter: again, q: quit)"
				: `bugs left ${state.remaining}`;
	const title = `MS. CLIO  score ${state.score}  ${status}`.slice(0, size.columns);
	lines.push(fill(`${BOLD}${TEAL}${title}`, title.length));
	state.grid.forEach((row, y) => {
		let text = "";
		row.forEach((cell, x) => {
			const ghost = ghostAt.get(`${x},${y}`);
			if (state.player.x === x && state.player.y === y) text += `${BOLD}${ORANGE}C${TEAL}${facingMark(state)}`;
			else if (ghost) text += `${BOLD}${GHOST}${ghostGlyph(ghost)}${RESET}${BG}`;
			else if (cell === "#") text += `${WALL}██`;
			else if (cell === "=") text += `${ORANGE}▬▬`;
			else if (cell === ".") text += `${TEAL}· `;
			else if (cell === "*") text += `${ORANGE}✱ `;
			else text += "  ";
		});
		lines.push(fill(text, row.length * 2));
	});
	const keys = "arrows/WASD move  q/Esc quit".slice(0, size.columns);
	lines.push(fill(`${WALL}${keys}`, keys.length));
	while (lines.length < height) lines.push(`${BG}${" ".repeat(width)}${RESET}`);
	return lines;
}

function facingMark(state: ArcadeState): string {
	return state.player.facing === "left"
		? "<"
		: state.player.facing === "right"
			? ">"
			: state.player.facing === "up"
				? "^"
				: "v";
}

function direction(data: string): ArcadeDirection | null {
	if (matchesKey(data, "up") || data === "w" || data === "W") return "up";
	if (matchesKey(data, "down") || data === "s" || data === "S") return "down";
	if (matchesKey(data, "left") || data === "a" || data === "A") return "left";
	if (matchesKey(data, "right") || data === "d" || data === "D") return "right";
	return null;
}

export interface ArcadeSession {
	close(): void;
	/** Route one key to the game; the host calls this ahead of its own key handling. */
	handleInput(data: string): void;
	isOpen(): boolean;
}

type ArcadeTui = Pick<TUI, "showOverlay" | "requestRender"> & { terminal: Pick<TUI["terminal"], "columns" | "rows"> };

/** Open the game over the TUI; closing restores the previous focus and stops the clock. */
export function openArcadeOverlay(
	tui: ArcadeTui,
	options: {
		onClose?: () => void;
		setInterval?: typeof setInterval;
		clearInterval?: typeof clearInterval;
	} = {},
): ArcadeSession {
	const every = options.setInterval ?? setInterval;
	const stop = options.clearInterval ?? clearInterval;
	let state = createArcadeState();
	let handle: OverlayHandle | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	const close = () => {
		if (timer !== null) stop(timer);
		timer = null;
		const open = handle;
		handle = null;
		if (!open) return;
		open.hide();
		tui.requestRender(true);
		options.onClose?.();
	};
	const handleInput = (data: string): void => {
		if (data === "q" || data === "Q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			close();
			return;
		}
		if (state.status !== "playing" && (matchesKey(data, "enter") || data === " ")) {
			state = createArcadeState();
			tui.requestRender();
			return;
		}
		const dir = direction(data);
		if (dir) steerArcade(state, dir);
	};
	const component: Component & { ownsCtrlC: boolean } = {
		ownsCtrlC: true,
		render: (width: number) => renderArcade(state, width, tui.terminal.rows),
		invalidate: () => {},
		handleInput,
	};
	handle = tui.showOverlay(component, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
	timer = every(() => {
		if (state.status !== "playing") return;
		const size = arcadeSize();
		// A shrunken terminal pauses the game behind its notice.
		if (tui.terminal.columns < size.columns || tui.terminal.rows < size.rows) return;
		tickArcade(state);
		tui.requestRender();
	}, TICK_MS);
	timer.unref?.();
	tui.requestRender(true);
	return { close, handleInput, isOpen: () => handle !== null };
}
