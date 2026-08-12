/**
 * The TUI at the terminal sizes people actually have, driven through a real
 * pseudo-terminal.
 *
 * Piping stdout reports no width, so every width-sensitive path collapses to
 * the 80-column fallback and the interesting sizes are never exercised. These
 * cases run the built entry under `node-pty` at each size in the release
 * matrix and hold two properties: nothing is written outside the frame, and
 * the terminal is handed back in the state it was borrowed in.
 *
 * Clio renders inline rather than on the alternate screen, so there is no
 * `?1049h`/`?1049l` pair to balance. What must balance is the cursor, the
 * bracketed-paste mode, and the kitty keyboard-protocol stack, because those
 * are what leave a shell unusable when a TUI exits badly.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { RenderTraceRow } from "../../src/interactive/render-trace.js";
import { colorSequences, type PtyRunResult, ptySupported, runInPty, stripAnsi, visibleLines } from "../harness/pty.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CTRL_C = String.fromCharCode(3);

/**
 * The footer's status word, which is the first thing on screen that only
 * appears once the application is mounted and taking keys. Waiting for it
 * instead of sleeping long enough for the slowest machine takes each case from
 * nine seconds to about two.
 */
const READY = /idle/;

/** The release width matrix, plus an ultrawide terminal. */
const SIZES: ReadonlyArray<{ cols: number; rows: number }> = [
	{ cols: 40, rows: 12 },
	{ cols: 60, rows: 20 },
	{ cols: 80, rows: 24 },
	{ cols: 100, rows: 30 },
	{ cols: 120, rows: 40 },
	{ cols: 160, rows: 50 },
	{ cols: 400, rows: 50 },
];

interface Scratch {
	dir: string;
	env: Record<string, string>;
	cleanup(): void;
}

/**
 * A declared target the TUI can name but never reach. Without one the empty
 * state routes into `clio configure` and the frame under test never renders;
 * with a reachable one the test would depend on a live endpoint.
 */
function makeScratch(extraEnv: Record<string, string> = {}): Scratch {
	const dir = mkdtempSync(join(tmpdir(), "clio-tui-width-"));
	mkdirSync(join(dir, "config"), { recursive: true });
	const settings = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
	settings.targets = [
		{
			id: "declared",
			runtime: "openai-compat",
			// Port 9 is discard. Nothing listens and nothing is contacted.
			url: "http://127.0.0.1:9",
			defaultModel: "declared-model",
			lifecycle: "user-managed",
		},
	];
	settings.orchestrator = { target: "declared", model: "declared-model", thinkingLevel: "off" };
	writeFileSync(join(dir, "config", "settings.yaml"), stringify(settings), "utf8");
	return {
		dir,
		env: {
			...process.env,
			CLIO_HOME: dir,
			CLIO_CONFIG_DIR: join(dir, "config"),
			CLIO_DATA_DIR: join(dir, "data"),
			CLIO_STATE_DIR: join(dir, "state"),
			CLIO_CACHE_DIR: join(dir, "cache"),
			// Never manage residency on any runtime from a test.
			CLIO_RESIDENCY: "observe",
			TERM: "xterm-256color",
			...extraEnv,
		} as Record<string, string>,
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function launch(scratch: Scratch, cols: number, rows: number): Promise<PtyRunResult> {
	return runInPty(process.execPath, [join(REPO_ROOT, "dist", "cli", "index.js")], {
		cols,
		rows,
		cwd: REPO_ROOT,
		env: scratch.env,
		timeoutMs: 30_000,
		readyWhen: READY,
		// Two Ctrl-C inside the 500ms double-tap window is the documented exit.
		input: [
			{ afterMs: 500, data: CTRL_C },
			{ afterMs: 650, data: CTRL_C },
		],
	});
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe("TUI width matrix", { concurrency: false, skip: ptySupported ? false : "no pty on this platform" }, () => {
	for (const { cols, rows } of SIZES) {
		it(`renders inside the frame and exits cleanly at ${cols}x${rows}`, async () => {
			const scratch = makeScratch();
			try {
				const result = await launch(scratch, cols, rows);

				strictEqual(result.timedOut, false, "two Ctrl-C inside the double-tap window exits");
				strictEqual(result.exitCode, 0, `clean exit; output tail: ${stripAnsi(result.output).slice(-400)}`);

				const lines = visibleLines(result.output);
				const overflowing = lines.filter((line) => line.length > cols);
				strictEqual(
					overflowing.length,
					0,
					`lines wider than ${cols} columns: ${overflowing
						.slice(0, 3)
						.map((l) => JSON.stringify(l))
						.join(" | ")}`,
				);
				ok(
					lines.some((line) => line.includes("Clio Coder")),
					`the banner rendered at ${cols}x${rows}`,
				);

				// Every terminal mode the TUI takes is handed back.
				const raw = result.output;
				ok(raw.trimEnd().endsWith("\u001B[?2004l"), "bracketed paste is disabled last");
				ok(occurrences(raw, "\u001B[?25h") > 0, "the cursor is shown again");
				strictEqual(
					occurrences(raw, "\u001B[>"),
					occurrences(raw, "\u001B[<u"),
					"the kitty keyboard-protocol stack is popped as many times as it was pushed",
				);
				strictEqual(occurrences(raw, "\u001B[?1049h"), 0, "Clio renders inline, never on the alternate screen");
			} finally {
				scratch.cleanup();
			}
		});
	}

	it("drops color under NO_COLOR and keeps the frame readable", async () => {
		const scratch = makeScratch({ NO_COLOR: "1" });
		try {
			const result = await launch(scratch, 80, 24);
			strictEqual(result.exitCode, 0);
			// Bold, dim, italic, and underline stay; foreground and background go.
			const colored = colorSequences(result.output);
			strictEqual(
				colored.length,
				0,
				`NO_COLOR must leave no foreground or background sequence, found: ${colored.slice(0, 5).join(" ")}`,
			);
			const lines = visibleLines(result.output);
			ok(
				lines.some((line) => line.includes("Clio Coder")),
				"the banner is still readable without color",
			);
			ok(
				lines.some((line) => line.includes("idle")),
				"status is still carried by text, not by color alone",
			);
		} finally {
			scratch.cleanup();
		}
	});

	it("survives content that is wider than one column per character", async () => {
		// Combining marks, wide CJK, emoji with a variation selector, and a
		// zero-width joiner sequence. Each one measures differently from its
		// JavaScript `length`, which is how a frame ends up overrun.
		const scratch = makeScratch();
		try {
			const wide = "漢字テスト 🙂 👩‍💻 é́ ｆｕｌｌｗｉｄｔｈ";
			const result = await runInPty(process.execPath, [join(REPO_ROOT, "dist", "cli", "index.js")], {
				cols: 60,
				rows: 20,
				cwd: REPO_ROOT,
				env: scratch.env,
				timeoutMs: 30_000,
				readyWhen: READY,
				input: [
					{ afterMs: 500, data: wide },
					{ afterMs: 1_200, data: CTRL_C },
					{ afterMs: 1_350, data: CTRL_C },
				],
			});
			strictEqual(result.exitCode, 0, "wide glyphs in the editor do not crash the render");
			const overflowing = visibleLines(result.output).filter((line) => line.length > 60);
			strictEqual(
				overflowing.length,
				0,
				`wide input overran the frame: ${overflowing
					.slice(0, 2)
					.map((l) => JSON.stringify(l))
					.join(" | ")}`,
			);
		} finally {
			scratch.cleanup();
		}
	});

	it("leaves the terminal usable when a single Ctrl-C does not exit", async () => {
		// One press cancels; it must not exit and must not tear anything down.
		const scratch = makeScratch();
		try {
			const result = await runInPty(process.execPath, [join(REPO_ROOT, "dist", "cli", "index.js")], {
				cols: 80,
				rows: 24,
				cwd: REPO_ROOT,
				env: scratch.env,
				timeoutMs: 30_000,
				readyWhen: READY,
				input: [
					{ afterMs: 500, data: CTRL_C },
					// Well outside the 500ms double-tap window.
					{ afterMs: 2_000, data: CTRL_C },
					{ afterMs: 3_500, data: CTRL_C },
					{ afterMs: 3_650, data: CTRL_C },
				],
			});
			strictEqual(result.timedOut, false, "the third and fourth presses are a double tap and do exit");
			strictEqual(result.exitCode, 0);
			ok(result.output.trimEnd().endsWith("\u001B[?2004l"), "the terminal is still handed back");
		} finally {
			scratch.cleanup();
		}
	});

	it("keeps the per-frame cost bounded at 160x50", async () => {
		// The largest size in the matrix, driven with forty keystrokes so the
		// editor redraws on every one. `CLIO_RENDER_TRACE` records frame timing
		// and byte counts and no conversation text, which is what makes this
		// number reproducible by a user reading the same instrument.
		const scratch = makeScratch();
		const tracePath = join(scratch.dir, "render.jsonl");
		try {
			const typed = Array.from({ length: 40 }, (_, index) => ({
				afterMs: 500 + index * 25,
				data: "abcdefghij"[index % 10] ?? "x",
			}));
			const result = await runInPty(process.execPath, [join(REPO_ROOT, "dist", "cli", "index.js")], {
				cols: 160,
				rows: 50,
				cwd: REPO_ROOT,
				env: { ...scratch.env, CLIO_RENDER_TRACE: tracePath },
				timeoutMs: 30_000,
				readyWhen: READY,
				input: [...typed, { afterMs: 2_000, data: CTRL_C }, { afterMs: 2_150, data: CTRL_C }],
			});
			strictEqual(result.exitCode, 0);

			const traceText = readFileSync(tracePath, "utf8");
			const frames = traceText
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as RenderTraceRow);
			ok(frames.length >= 20, `the trace recorded the session's frames, got ${frames.length}`);

			// A 160x50 terminal is 8000 cells. A frame that repaints all of them
			// with styling still fits inside this ceiling; exceeding it means the
			// diff was lost and every keystroke now redraws the whole screen.
			const widestFrame = Math.max(...frames.map((frame) => frame.bytes));
			ok(widestFrame < 24_000, `widest frame was ${widestFrame} bytes`);

			const panelMs = frames
				.map((frame) => frame.panelMs)
				.filter((value): value is number => typeof value === "number")
				.sort((a, b) => a - b);
			ok(panelMs.length >= 10, `panel renders were attributed to frames, got ${panelMs.length}`);
			// Measured at 0.03ms p95 on the development machine. The ceiling is
			// loose enough to survive a loaded CI box and tight enough to catch a
			// lost render cache or a quadratic wrap.
			const p95 = panelMs[Math.min(panelMs.length - 1, Math.floor(panelMs.length * 0.95))] ?? 0;
			ok(p95 < 5, `panel render p95 was ${p95}ms across ${panelMs.length} frames`);

			// The instrument itself: content-free by construction, which is what
			// lets it be documented as safe to share.
			ok(!traceText.includes("abcdefghij"), "the render trace records timing, never typed text");
		} finally {
			scratch.cleanup();
		}
	});
});
