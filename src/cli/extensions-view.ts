import { appendFileSync, type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ExtensionDockFrame, ExtensionDockTap } from "../domains/extensions/dock-frame.js";
import { encodeDockTap, readExtensionDockFrame } from "../domains/extensions/dock-frame.js";
import {
	isKeyRelease,
	matchesKey,
	ProcessTerminal,
	parseKey,
	sliceByColumn,
	TuiAltScreen,
	truncateToWidth,
} from "../engine/tui-primitives.js";

const HELP = "usage: clio-coder extensions view --watch <frame-file> [--dock-taps <tap-file>]\n";

/** This process paints host-rendered data; it never imports an interactive surface. */
export async function runExtensionsView(argv: ReadonlyArray<string>): Promise<number> {
	let frameFile: string | undefined;
	let tapFile: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(HELP);
			return 0;
		}
		const value = argv[i + 1];
		if (
			!value ||
			value.startsWith("--") ||
			(arg !== "--watch" && arg !== "--dock-taps") ||
			(arg === "--watch" ? frameFile !== undefined : tapFile !== undefined)
		) {
			process.stderr.write(HELP);
			return 2;
		}
		if (arg === "--watch") frameFile = value;
		else tapFile = value;
		i++;
	}
	if (!frameFile) {
		process.stderr.write(HELP);
		return 2;
	}
	const file = frameFile;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		const result = readExtensionDockFrame(file);
		process.stdout.write(`${result.ok ? [result.frame.title, ...result.frame.lines].join("\n") : result.reason}\n`);
		return 0;
	}
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	let frame: ExtensionDockFrame | null = null;
	let reason = "waiting for extension dock frame";
	let selected = -1;
	let lastSeq = 0;
	let top = 0;
	let reportedWidth = 0;
	let reportedRows = 0;
	const tap = (value: ExtensionDockTap): void => {
		if (!tapFile) return;
		try {
			appendFileSync(tapFile, encodeDockTap(value));
		} catch {
			// A lost host or unwritable state directory must not crash the viewer.
		}
	};
	const refresh = (): void => {
		const result = readExtensionDockFrame(file);
		if (!result.ok) {
			frame = null;
			reason = result.reason;
			selected = -1;
			return;
		}
		// Keep the last painted frame while the host catches up to a resize.
		if (tapFile && frame !== null && result.frame.width !== terminal.columns) return;
		if (result.frame.seq <= lastSeq && frame !== null) return;
		if (result.frame.seq < lastSeq) return;
		lastSeq = result.frame.seq;
		frame = result.frame;
		frame.targets.sort((a, b) => a.row - b.row || a.col - b.col);
		selected = Math.min(selected, frame.targets.length - 1);
	};
	const view = {
		render(width: number): string[] {
			const rows = Math.max(1, terminal.rows);
			if (width !== reportedWidth || rows !== reportedRows) {
				reportedWidth = width;
				reportedRows = rows;
				tap({ kind: "size", width, rows });
			}
			if (frame === null) return [truncateToWidth(`\x1b[2m${reason}\x1b[22m`, width, "")];
			const current = frame;
			const bodyRows = Math.max(0, rows - 1);
			const target = frame.targets[selected];
			if (target && bodyRows > 0) {
				if (target.row < top) top = target.row;
				if (target.row >= top + bodyRows) top = target.row - bodyRows + 1;
			}
			top = Math.max(0, Math.min(top, Math.max(0, frame.lines.length - bodyRows)));
			const lines = frame.lines.slice(top, top + bodyRows).map((line, index) => {
				if (!target || index + top !== target.row || target.col >= width) return truncateToWidth(line, width, "");
				const end = Math.min(width, target.col + target.width);
				const padded = truncateToWidth(line, current.width, "", true);
				const before = truncateToWidth(sliceByColumn(padded, 0, target.col, true), target.col, "", true);
				// Reapply reverse after SGR resets inside the selected range.
				const middle = truncateToWidth(
					sliceByColumn(padded, target.col, end - target.col, true),
					end - target.col,
					"",
					true,
				).replace(
					// biome-ignore lint/suspicious/noControlCharactersInRegex: Preserve highlighting across host SGR resets.
					/\x1b\[[\d;:]*m/g,
					(sgr) => `${sgr}\x1b[7m`,
				);
				const after = sliceByColumn(padded, end, width - end, true);
				return truncateToWidth(`${before}\x1b[7m${middle}\x1b[27m${after}`, width, "");
			});
			return [truncateToWidth(frame.title, width, ""), ...lines];
		},
		invalidate(): void {},
	};
	tui.addChild(view);
	refresh();
	return await new Promise<number>((resolve) => {
		let settled = false;
		let watcher: FSWatcher | null = null;
		const repaint = (): void => {
			refresh();
			tui.requestRender();
		};
		const timer = setInterval(repaint, 250);
		try {
			watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
				if (name === null || name === basename(file)) repaint();
			});
			watcher.on("error", () => undefined);
		} catch {
			// The polling backstop also catches a directory created after startup.
		}
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			watcher?.close();
			removeInput();
			process.off("SIGTERM", finish);
			tui.stop();
			resolve(0);
		};
		const press = (target: ExtensionDockFrame["targets"][number]): void => {
			if (frame)
				tap({
					kind: "press",
					seq: frame.seq,
					action: target.action,
					...(target.key === undefined ? {} : { key: target.key }),
				});
		};
		const removeInput = tui.addInputListener((data: string) => {
			if (isKeyRelease(data)) return undefined;
			if (matchesKey(data, "ctrl+c")) finish();
			else if (data === "q") {
				if (tapFile) tap({ kind: "hide" });
				else finish();
			} else if (frame) {
				const count = frame.targets.length;
				if (count && (matchesKey(data, "tab") || matchesKey(data, "down"))) selected = (selected + 1) % count;
				else if (count && (matchesKey(data, "shift+tab") || matchesKey(data, "up")))
					selected = selected < 0 ? count - 1 : (selected + count - 1) % count;
				else if (matchesKey(data, "enter")) {
					const target = frame.targets[selected];
					if (target) press(target);
				} else {
					const target = frame.targets.find(
						(entry) => entry.hotkey !== undefined && (data === entry.hotkey || parseKey(data) === entry.hotkey),
					);
					if (!target) return undefined;
					press(target);
				}
				tui.requestRender();
			} else return undefined;
			return { consume: true };
		});
		process.once("SIGTERM", finish);
		tui.start();
		tui.requestRender();
	});
}
