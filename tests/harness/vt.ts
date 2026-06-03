/**
 * Minimal VT emulator that models scrollback separately from the visible
 * screen. Purpose-built for the exact escape sequences pi-tui's differential
 * renderer emits (cursor moves, \r\n scrolling, ED/EL erases, scrollback
 * clear), so tests can assert what actually lands in a terminal's scrollback
 * after a stream of writes — the user-visible source of the "frozen chrome /
 * duplicated reply" bug.
 *
 * SGR colors and OSC/APC sequences are consumed and dropped: cells store plain
 * text, which is what assertions about chrome/reply leakage need.
 */
export interface VtEmulator {
	write(data: string): void;
	/** Committed-to-scrollback lines, oldest first (trailing blanks trimmed). */
	scrollback(): string[];
	/** Current on-screen lines (trailing blanks trimmed per line). */
	screen(): string[];
	/** scrollback + screen, the full user-visible history. */
	history(): string[];
}

export interface VtOptions {
	/**
	 * Whether ESC[3J clears the scrollback buffer. True models xterm/Windows
	 * Terminal; false models tmux, screen, and terminals that ignore 3J — where
	 * pi-tui's fullRender(true) cannot self-clean and re-emits accumulate.
	 */
	honorScrollbackClear?: boolean;
}

export function createVt(cols: number, rows: number, options: VtOptions = {}): VtEmulator {
	const honorScrollbackClear = options.honorScrollbackClear ?? true;
	const scroll: string[] = [];
	let grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
	let row = 0;
	let col = 0;

	const blankRow = (): string[] => Array.from({ length: cols }, () => " ");
	const lineFeed = (): void => {
		if (row >= rows - 1) {
			scroll.push((grid.shift() ?? blankRow()).join("").replace(/\s+$/, ""));
			grid.push(blankRow());
		} else {
			row += 1;
		}
	};
	const putChar = (ch: string): void => {
		if (col >= cols) {
			col = 0;
			lineFeed();
		}
		const line = grid[row];
		if (line) line[col] = ch;
		col += 1;
	};

	let i = 0;
	const write = (data: string): void => {
		i = 0;
		while (i < data.length) {
			const ch = data[i] as string;
			if (ch === "\x1b") {
				const next = data[i + 1];
				if (next === "[") {
					// CSI: ESC [ params... final
					let j = i + 2;
					let params = "";
					while (j < data.length && /[0-9;?]/.test(data[j] as string)) {
						params += data[j];
						j += 1;
					}
					const final = data[j] as string;
					applyCsi(final, params);
					i = j + 1;
					continue;
				}
				if (next === "]") {
					// OSC: ESC ] ... (BEL | ESC \)
					let j = i + 2;
					while (j < data.length && data[j] !== "\x07" && !(data[j] === "\x1b" && data[j + 1] === "\\")) j += 1;
					i = data[j] === "\x07" ? j + 1 : j + 2;
					continue;
				}
				if (next === "_") {
					// APC (pi cursor marker): ESC _ ... (BEL | ESC \)
					let j = i + 2;
					while (j < data.length && data[j] !== "\x07" && !(data[j] === "\x1b" && data[j + 1] === "\\")) j += 1;
					i = data[j] === "\x07" ? j + 1 : j + 2;
					continue;
				}
				i += 2; // unknown 2-byte escape, skip
				continue;
			}
			if (ch === "\r") {
				col = 0;
				i += 1;
				continue;
			}
			if (ch === "\n") {
				lineFeed();
				i += 1;
				continue;
			}
			if (ch === "\b") {
				col = Math.max(0, col - 1);
				i += 1;
				continue;
			}
			if (ch === "\x07") {
				i += 1;
				continue;
			}
			putChar(ch);
			i += 1;
		}
	};

	const applyCsi = (final: string, params: string): void => {
		const nums = params
			.replace(/\?/g, "")
			.split(";")
			.map((p) => (p.length === 0 ? Number.NaN : Number.parseInt(p, 10)));
		const n0 = Number.isNaN(nums[0] ?? Number.NaN) ? undefined : (nums[0] as number);
		switch (final) {
			case "H":
			case "f":
				row = Math.max(0, Math.min(rows - 1, (n0 ?? 1) - 1));
				col = Math.max(0, Math.min(cols - 1, (Number.isNaN(nums[1] ?? Number.NaN) ? 1 : (nums[1] as number)) - 1));
				break;
			case "A":
				row = Math.max(0, row - (n0 ?? 1));
				break;
			case "B":
				row = Math.min(rows - 1, row + (n0 ?? 1));
				break;
			case "C":
				col = Math.min(cols - 1, col + (n0 ?? 1));
				break;
			case "D":
				col = Math.max(0, col - (n0 ?? 1));
				break;
			case "G":
				col = Math.max(0, Math.min(cols - 1, (n0 ?? 1) - 1));
				break;
			case "J": {
				const mode = n0 ?? 0;
				if (mode === 2 || mode === 3) {
					grid = Array.from({ length: rows }, () => blankRow());
					if (mode === 3 && honorScrollbackClear) scroll.length = 0;
				} else if (mode === 0) {
					for (let c = col; c < cols; c++) (grid[row] as string[])[c] = " ";
					for (let r = row + 1; r < rows; r++) grid[r] = blankRow();
				} else if (mode === 1) {
					for (let c = 0; c <= col; c++) (grid[row] as string[])[c] = " ";
					for (let r = 0; r < row; r++) grid[r] = blankRow();
				}
				break;
			}
			case "K": {
				const mode = n0 ?? 0;
				const line = grid[row] as string[];
				if (mode === 0) for (let c = col; c < cols; c++) line[c] = " ";
				else if (mode === 1) for (let c = 0; c <= col; c++) line[c] = " ";
				else for (let c = 0; c < cols; c++) line[c] = " ";
				break;
			}
			default:
				break; // SGR 'm', private modes, etc. — ignore
		}
	};

	const trim = (lines: string[]): string[] => lines.map((l) => l.replace(/\s+$/, ""));
	return {
		write,
		scrollback: () => trim([...scroll]),
		screen: () => trim(grid.map((r) => r.join(""))),
		history: () => trim([...scroll, ...grid.map((r) => r.join(""))]),
	};
}
