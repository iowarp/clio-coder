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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { colorSequences, type PtyRunResult, ptySupported, runInPty, stripAnsi, visibleLines } from "../harness/pty.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CTRL_C = String.fromCharCode(3);

/**
 * The footer's status word, which is the first thing on screen that only
 * appears once the application is mounted and taking keys. Waiting for it
 * instead of sleeping long enough for the slowest machine takes each case from
 * nine seconds to about two.
 */
const READY = /ctx /;

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
 * state routes into `clio-coder configure` and the frame under test never renders;
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
	settings.chat = {
		...(settings.chat as Record<string, unknown>),
		target: "declared",
		model: "declared-model",
		thinkingLevel: "off",
	};
	writeFileSync(join(dir, "config", "settings.yaml"), stringify(settings), "utf8");
	return {
		dir,
		env: {
			...process.env,
			CLIO_CODER_HOME: dir,
			CLIO_CODER_CONFIG_DIR: join(dir, "config"),
			CLIO_CODER_DATA_DIR: join(dir, "data"),
			CLIO_CODER_STATE_DIR: join(dir, "state"),
			CLIO_CODER_CACHE_DIR: join(dir, "cache"),
			// Never manage residency on any runtime from a test.
			CLIO_CODER_RESIDENCY: "observe",
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

				// The tail matters here: a timeout is either "the TUI never reached
				// the ready banner, so the keystrokes were never sent" or "it did,
				// and the double tap missed the product's 500ms window". The bare
				// "true !== false" this used to print separates neither.
				strictEqual(
					result.timedOut,
					false,
					`two Ctrl-C inside the double-tap window exits; output tail: ${stripAnsi(result.output).slice(-400)}`,
				);
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

				// Every terminal mode the TUI takes is handed back. Presence is what
				// binds; asserting the exact final byte position depended on pty flush
				// order and flaked across full-suite runs on both Node majors.
				const raw = result.output;
				ok(occurrences(raw, "\u001B[?2004l") > 0, "bracketed paste is disabled before exit");
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
				!lines.some((line) => line.includes("idle")) &&
					lines.some((line) => line.includes(basename(REPO_ROOT))) &&
					lines.some((line) => line.includes("ctx ")),
				"the idle footer stays quiet while workspace and context remain visible",
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
					// The first press clears the editor and is not shutdown intent.
					{ afterMs: 1_200, data: CTRL_C },
					{ afterMs: 1_350, data: CTRL_C },
					{ afterMs: 1_500, data: CTRL_C },
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
			ok(occurrences(result.output, "\u001B[?2004l") > 0, "the terminal is still handed back");
		} finally {
			scratch.cleanup();
		}
	});
});
