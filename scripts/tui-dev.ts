/**
 * The transcript's visual harness and render bench (`pnpm tui:gallery`, `pnpm tui:bench`).
 *
 * `gallery` renders fixed scenes through the real chat panel in every output
 * style at several widths, as ANSI, plain text, or HTML pages that headless
 * Chrome can turn into PNGs for before/after review. `bench` measures frame
 * cost, bytes written and full redraws for synthetic transcripts of several
 * sizes through Clio's instrumented pi-tui renderers.
 *
 * The theme reads COLORTERM and NO_COLOR when its modules load, so both are
 * settled here before the rendering modules are imported.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { printError } from "../src/cli/argv.js";
import type { OutputStyle } from "../src/core/defaults.js";

const HELP = `pnpm tui:gallery [--scene <id,...>] [--style <compact,standard,detailed>]
                           [--width <40,60,100,200>] [--format ansi|plain|html] [--out <dir>] [--png]
                           [--no-color] [--list]
pnpm tui:bench [--entries <50,400,2000>] [--mode <regular,fullscreen>] [--columns 120]
                         [--rows 40] [--deltas 400] [--keystrokes 40] [--json]

gallery  Render transcript scenes through the real chat panel. Without --out, frames print to
         stdout. With --out, each scene writes <scene>.html (every style and width) plus one
         .ansi file per frame; --png also screenshots each page with headless Chrome
         (CLIO_CODER_CHROME, or google-chrome/chromium on PATH).
bench    Measure transcript frames in-process: per-frame cost, Markdown finalize, Alt+O style
         switches, bytes written per streamed delta, and full redraws.
`;

interface Options {
	values: Map<string, string>;
	flags: Set<string>;
	positional: string[];
}

function parse(args: ReadonlyArray<string>): Options {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
		const next = args[i + 1];
		if (inline !== undefined) values.set(key, inline);
		else if (next !== undefined && !next.startsWith("--") && VALUE_OPTIONS.has(key)) {
			values.set(key, next);
			i += 1;
		} else flags.add(key);
	}
	return { values, flags, positional };
}

const VALUE_OPTIONS = new Set([
	"scene",
	"style",
	"width",
	"format",
	"out",
	"entries",
	"mode",
	"columns",
	"rows",
	"deltas",
	"keystrokes",
]);

function list(options: Options, key: string, fallback: readonly string[]): string[] {
	const raw = options.values.get(key);
	return raw === undefined
		? [...fallback]
		: raw
				.split(",")
				.map((part) => part.trim())
				.filter(Boolean);
}

function numbers(options: Options, key: string, fallback: readonly number[]): number[] {
	return list(options, key, fallback.map(String))
		.map((value) => Number.parseInt(value, 10))
		.filter(Number.isFinite);
}

function prepareTheme(color: boolean): void {
	process.env.COLORTERM = "truecolor";
	if (color) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = "1";
}

const STYLES: readonly OutputStyle[] = ["compact", "standard", "detailed"];

async function runGallery(options: Options): Promise<number> {
	prepareTheme(!options.flags.has("no-color"));
	const [{ createChatPanel }, scenes, { framesToHtml }, { stripTerminalSequences }] = await Promise.all([
		import("../src/interactive/chat-panel.js"),
		import("../src/interactive/dev/transcript-scenes.js"),
		import("../src/interactive/dev/ansi-html.js"),
		import("../src/engine/tui.js"),
	]);
	const all = scenes.transcriptScenes();
	if (options.flags.has("list")) {
		for (const scene of all) process.stdout.write(`${scene.id.padEnd(14)}${scene.title}\n`);
		return 0;
	}
	const wanted = list(options, "scene", ["all"]);
	const selected = wanted.includes("all") ? all : all.filter((scene) => wanted.includes(scene.id));
	const unknown = wanted.filter((id) => id !== "all" && !all.some((scene) => scene.id === id));
	if (unknown.length > 0) {
		printError(`unknown scene: ${unknown.join(", ")}`, `scenes: ${all.map((scene) => scene.id).join(", ")}`);
		return 2;
	}
	const styles = list(options, "style", STYLES).filter((style): style is OutputStyle =>
		STYLES.includes(style as OutputStyle),
	);
	const widths = numbers(options, "width", [40, 60, 100, 200]);
	const format = options.values.get("format") ?? (options.values.has("out") ? "html" : "ansi");
	const out = options.values.get("out");
	if (out !== undefined) mkdirSync(resolve(out), { recursive: true });

	const shots: Array<{ html: string; png: string; columns: number; rows: number }> = [];
	for (const scene of selected) {
		const frames: Array<{ label: string; columns: number; lines: string[] }> = [];
		for (const style of styles) {
			for (const width of widths) {
				const clock = scenes.createSceneClock();
				const panel = createChatPanel({ now: clock.now, getOutputStyle: () => style, getTerminalRows: () => 40 });
				scene.play(panel, clock);
				const lines = panel.render(width);
				frames.push({ label: `${scene.id} · ${style} · ${width} cols`, columns: width, lines });
			}
		}
		if (out === undefined) {
			for (const frame of frames) {
				const body = format === "plain" ? frame.lines.map((line) => stripTerminalSequences(line)) : frame.lines;
				process.stdout.write(`\n── ${frame.label} ${"─".repeat(Math.max(0, frame.columns - frame.label.length - 4))}\n`);
				process.stdout.write(`${body.join("\n")}\n`);
			}
			continue;
		}
		const directory = resolve(out);
		for (const frame of frames) {
			const name = frame.label.replace(/ · /gu, "-").replace(/ cols$/u, "");
			writeFileSync(join(directory, `${name}.ansi`), `${frame.lines.join("\n")}\n`);
			if (options.flags.has("png")) {
				const html = join(directory, `${name}.frame.html`);
				writeFileSync(html, framesToHtml([frame], { title: frame.label }));
				shots.push({ html, png: join(directory, `${name}.png`), columns: frame.columns, rows: frame.lines.length });
			}
		}
		if (format === "html") {
			writeFileSync(
				join(directory, `${scene.id}.html`),
				framesToHtml(frames, { title: `${scene.title} · Clio transcript gallery` }),
			);
		}
	}
	if (out !== undefined) process.stdout.write(`wrote ${selected.length} scene(s) to ${resolve(out)}\n`);
	return shots.length > 0 ? screenshot(shots) : 0;
}

function chromeBinary(): string | null {
	const configured = process.env.CLIO_CODER_CHROME;
	if (configured && existsSync(configured)) return configured;
	for (const candidate of ["google-chrome", "chromium", "chromium-browser"]) {
		const found = spawnSync("sh", ["-c", `command -v ${candidate}`], { encoding: "utf8" });
		if (found.status === 0 && found.stdout.trim().length > 0) return found.stdout.trim();
	}
	return null;
}

/** Cell metrics of the gallery page: 14px DejaVu Sans Mono, 18px rows, 16px body padding. */
const CELL_WIDTH_PX = 8.44;
const ROW_HEIGHT_PX = 18;

function screenshot(shots: ReadonlyArray<{ html: string; png: string; columns: number; rows: number }>): number {
	const chrome = chromeBinary();
	if (chrome === null) {
		printError("no headless Chrome found", "set CLIO_CODER_CHROME to a Chrome or Chromium binary");
		return 1;
	}
	for (const shot of shots) {
		const width = Math.ceil(shot.columns * CELL_WIDTH_PX) + 60;
		const height = shot.rows * ROW_HEIGHT_PX + 90;
		const result = spawnSync(
			chrome,
			[
				"--headless=new",
				"--disable-gpu",
				"--hide-scrollbars",
				"--force-device-scale-factor=1",
				`--window-size=${width},${height}`,
				`--screenshot=${shot.png}`,
				pathToFileURL(shot.html).href,
			],
			{ encoding: "utf8" },
		);
		rmSync(shot.html, { force: true });
		if (result.status !== 0) {
			printError(`chrome failed for ${shot.png}`, result.stderr.slice(0, 400));
			return 1;
		}
		process.stdout.write(`${shot.png}\n`);
	}
	return 0;
}

function fmt(value: number): string {
	return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

async function runBench(options: Options): Promise<number> {
	prepareTheme(true);
	const { benchScale } = await import("../src/interactive/dev/render-bench.js");
	const entries = numbers(options, "entries", [50, 400, 2000]);
	const modes = list(options, "mode", ["regular", "fullscreen"]).filter(
		(mode): mode is "regular" | "fullscreen" => mode === "regular" || mode === "fullscreen",
	);
	const columns = numbers(options, "columns", [120])[0] ?? 120;
	const rows = numbers(options, "rows", [40])[0] ?? 40;
	const deltas = numbers(options, "deltas", [400])[0] ?? 400;
	const keystrokes = numbers(options, "keystrokes", [40])[0] ?? 40;
	const results = [];
	for (const mode of modes) {
		for (const count of entries) {
			// One discarded warm-up so JIT compilation does not land in the first scale's numbers.
			if (results.length === 0) benchScale({ entries: 20, mode, columns, rows, deltas: 60, keystrokes: 5 });
			results.push(benchScale({ entries: count, mode, columns, rows, deltas, keystrokes }));
		}
	}
	if (options.flags.has("json")) {
		process.stdout.write(
			`${JSON.stringify({ node: process.versions.node, columns, rows, deltas, keystrokes, results }, null, 2)}\n`,
		);
		return 0;
	}
	process.stdout.write(
		`node ${process.versions.node} · ${columns}x${rows} · ${deltas} streamed deltas · ${keystrokes} keystrokes\n\n`,
	);
	const header = [
		"mode",
		"entries",
		"lines",
		"stream frame p50/p99",
		"panel p50/p99",
		"normalize p50",
		"B/delta p50",
		"redraws",
		"key settled p50/p99",
		"key streaming p50/p99",
		"finalize",
		"Alt+O max",
		"Alt+O again",
	];
	const rowsOut = results.map((r) => [
		r.mode,
		String(r.entries),
		String(r.lines),
		`${fmt(r.streaming.frame.p50)}/${fmt(r.streaming.frame.p99)} ms`,
		`${fmt(r.streaming.panel.p50)}/${fmt(r.streaming.panel.p99)} ms`,
		`${fmt(r.streaming.normalization.p50)} ms`,
		String(Math.round(r.streaming.bytesPerDelta.p50)),
		String(r.streaming.fullRedraws),
		`${fmt(r.keystrokeSettled.frame.p50)}/${fmt(r.keystrokeSettled.frame.p99)} ms`,
		`${fmt(r.keystrokeStreaming.frame.p50)}/${fmt(r.keystrokeStreaming.frame.p99)} ms`,
		`${fmt(r.finalize.frameMs)} ms${r.finalize.fullRedraw ? " (full redraw)" : ""}`,
		`${fmt(Math.max(...r.styleSwitch.map((s) => s.frameMs)))} ms`,
		`${fmt(Math.max(...r.styleSwitchWarm.map((s) => s.frameMs)))} ms`,
	]);
	const widths = header.map((cell, index) => Math.max(cell.length, ...rowsOut.map((row) => (row[index] ?? "").length)));
	for (const row of [header, ...rowsOut]) {
		process.stdout.write(`${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ")}\n`);
	}
	return 0;
}

async function runDevTuiCommand(args: string[]): Promise<number> {
	const options = parse(args);
	const command = options.positional[0];
	if (command === undefined || options.flags.has("help") || options.flags.has("h")) {
		process.stdout.write(HELP);
		return command === undefined && !options.flags.has("help") ? 2 : 0;
	}
	if (command === "gallery") return runGallery(options);
	if (command === "bench") return runBench(options);
	printError(`unknown dev tui command: ${command}`);
	process.stdout.write(HELP);
	return 2;
}

process.exitCode = await runDevTuiCommand(process.argv.slice(2));
