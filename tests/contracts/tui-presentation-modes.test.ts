import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { asciiOnly, colorDisabled, motionEnabled, nerdFontEnabled } from "../../src/core/terminal-preferences.js";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import {
	buildWelcomeDashboardLines,
	createBootWelcome,
	createWelcomeDashboard,
} from "../../src/interactive/welcome-dashboard.js";

const originalEnv = { ...process.env };
afterEach(() => {
	for (const key of ["TERM", "CLIO_CODER_ASCII", "CLIO_CODER_SCREEN_READER", "CLIO_CODER_NERD_FONT", "NO_COLOR"]) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

test("ASCII glyph selection is startup-wide and keeps decision marks, frames, and rails readable", () => {
	const probe = `
		import { GLYPH, clioTheme, frame } from "./src/interactive/theme/index.ts";
		import { renderEditorRail } from "./src/interactive/editor-rails.ts";
		import { ClioOverlayFrame } from "./src/interactive/overlay-frame.ts";
		import { cardHead, cardRows } from "./src/interactive/card.ts";
		import { createDemoHints } from "./src/interactive/footer/demo-hints.ts";
		import { idleReadinessPresentation } from "./src/interactive/footer/widgets.ts";
		import { DEFAULT_SETTINGS } from "./src/core/defaults.ts";
		import { createBootWelcome } from "./src/interactive/welcome-dashboard.ts";
		const theme = clioTheme();
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = "local";
		settings.chat.model = "test-model";
		settings.interface.outputDetail = "detailed";
		const lines = frame(theme, "Approval", ["target /work/example", "[Enter] allow [Esc] deny"], 40);
		const rail = renderEditorRail(theme, 40, {}, { phase: "working", yolo: false, animate: true, now: 0 });
		const overlay = new ClioOverlayFrame({ render: () => ["target /work/example"], invalidate() {} }, "Approval", "[Enter] allow / [Esc] deny").render(40);
		const card = [...cardHead(GLYPH.toolHeader + " read /work/example", " " + GLYPH.ok, 40), ...cardRows("target /work/example", 40, true)];
		const welcome = createBootWelcome(settings).render(80);
		const status = idleReadinessPresentation({ targetId: "local", available: true, reason: "ok", health: "healthy", lastStop: null }, 80);
		const tip = createDemoHints()({ enabled: true, now: 0, quiet: false, agentActive: false, toolsUsed: false, contextBusy: false, dashboardKey: "Ctrl+U" });
		delete process.env.CLIO_CODER_ASCII;
		process.env.TERM = "xterm-256color";
		console.log(JSON.stringify({ glyphs: GLYPH, lines, overlay, card, rail, welcome, status, tip }));
	`;
	for (const fallback of [{ CLIO_CODER_ASCII: "1", TERM: "xterm-256color" }, { TERM: "dumb" }, { TERM: "unknown" }]) {
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
			env: { ...process.env, NO_COLOR: "1", ...fallback },
			encoding: "utf8",
			timeout: 20_000,
		});
		strictEqual(result.status, 0, result.stderr);
		const output = JSON.parse(result.stdout) as {
			glyphs: Record<string, string>;
			lines: string[];
			overlay: string[];
			card: string[];
			rail: string;
			welcome: string[];
			status: { label: string };
			tip: string;
		};
		ok(Object.values(output.glyphs).every((glyph) => /^[\x20-\x7e]+$/u.test(glyph)));
		strictEqual(new Set([output.glyphs.ok, output.glyphs.error, output.glyphs.cancelled]).size, 3);
		ok(output.lines.every((line) => visibleWidth(line) === 40));
		ok(output.lines.map(stripTerminalSequences).every((line) => /^[\x20-\x7e]+$/u.test(line)));
		ok(output.overlay.every((line) => visibleWidth(line) === 40));
		ok(output.overlay.map(stripTerminalSequences).every((line) => /^[\x20-\x7e]+$/u.test(line)));
		match(stripTerminalSequences(output.overlay[0] ?? ""), /^\+- Approval /u);
		ok(output.card.map(stripTerminalSequences).every((line) => /^[\x20-\x7e]+$/u.test(line)));
		match(stripTerminalSequences(output.card[1] ?? ""), /^ {2}\| target/u);
		match(stripTerminalSequences(output.rail), /^-+$/u);
		strictEqual(output.glyphs.rail, "|");
		strictEqual(output.welcome.length, 1);
		match(stripTerminalSequences(output.welcome[0] ?? ""), /test-model/u);
		match(output.status.label, /is ready \. no request yet/u);
		match(output.tip, /lists keys \. Ctrl\+G opens every action \. \/help/u);
	}
	const env = { TERM: "xterm-256color", CLIO_CODER_ASCII: "1", CLIO_CODER_NERD_FONT: "1" };
	strictEqual(asciiOnly(env), true);
	strictEqual(motionEnabled(env), false);
	strictEqual(nerdFontEnabled(env), false);
	strictEqual(asciiOnly({ TERM: "xterm-256color", NO_COLOR: "1" }), false);
});

test("demo-off skips welcome-only readers and live toggles restore the full welcome", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.CLIO_CODER_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.demo = false;
	settings.interface.outputDetail = "detailed";
	settings.chat.target = "local";
	settings.chat.model = "test-model";
	const reads = { context: 0, quota: 0, recipes: 0, keys: 0 };
	const header = createWelcomeDashboard({
		providers: { list: () => [] },
		getSettings: () => settings,
		getContextState: () => {
			reads.context++;
			return { clioMd: "none" } as never;
		},
		getQuotaSummary: () => {
			reads.quota++;
			return "quota";
		},
		getAgentCount: () => {
			reads.recipes++;
			return 3;
		},
		getKeyLabel: () => {
			reads.keys++;
			return "Ctrl+J";
		},
		scheduleRefresh: (run) => run(),
	});
	try {
		for (const width of [8, 40, 80, 120, 180]) {
			const lines = header.render(width);
			strictEqual(lines.length, 1);
			ok(lines.every((line) => visibleWidth(line) <= width));
		}
		deepStrictEqual(reads, { context: 0, quota: 0, recipes: 0, keys: 0 });
		match(stripTerminalSequences(header.render(180)[0] ?? ""), /test-model/u);
		settings.interface.demo = true;
		ok(header.render(180).length > 1);
		ok(reads.context > 0 && reads.quota > 0 && reads.keys > 0);
		strictEqual(reads.recipes, 0);
		strictEqual(header.isLaunchpadVisible(), true);
		header.collapseToSessionHeader();
		settings.interface.demo = false;
		header.resetToLaunchpad();
		strictEqual(header.render(180).length, 1);
		settings.interface.demo = true;
		ok(header.render(180).length > 1);
	} finally {
		header.dispose();
	}
});

test("instant welcome caches stable frames, fits resizing, and honors demo-off", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.CLIO_CODER_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	const full = createBootWelcome(settings, "Enter");
	const frame = full.render(180);
	strictEqual(full.render(180), frame);
	ok(frame.length > 1);
	const resized = full.render(80);
	ok(resized.every((line) => visibleWidth(line) <= 80));
	full.invalidate();
	ok(full.render(80) !== resized);
	settings.interface.demo = false;
	strictEqual(createBootWelcome(settings, "Enter").render(180).length, 1);
});

test("limited terminal and screen-reader welcome avoids the artwork even with demo on", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	for (const term of ["dumb", "unknown"]) {
		process.env.TERM = term;
		strictEqual(createBootWelcome(settings, "Enter").render(180).length, 1);
	}
	process.env.TERM = "xterm-256color";
	process.env.CLIO_CODER_SCREEN_READER = "1";
	strictEqual(createBootWelcome(settings, "Enter").render(180).length, 1);
});

test("thinking rail uses ordinary marks unless Nerd Font coverage is explicitly declared", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.NO_COLOR;
	delete process.env.CLIO_CODER_NERD_FONT;
	delete process.env.CLIO_CODER_SCREEN_READER;
	const editor = new ClioEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getModelLabel: () => "test-model",
		getThinkingLabel: () => "high",
		getThinking: () => ({ label: "high", hasLevels: true, supportedLevels: ["off", "low", "medium", "high"] }),
	});
	const rail = () => stripTerminalSequences(editor.render(80).at(-1) ?? "");
	match(rail(), /● ● ● ○/u);
	ok(!rail().includes("\uEE9C"));
	process.env.CLIO_CODER_NERD_FONT = "1";
	ok(rail().includes("\uEE9C"));
	process.env.CLIO_CODER_SCREEN_READER = "1";
	match(rail(), /think high/u);
	strictEqual(nerdFontEnabled(), false);
});

test("three-column welcome aligns field values, command descriptions, and bound key descriptions", () => {
	const stats = {
		outputStyle: "detailed" as const,
		cwd: "/tmp/welcome-test",
		workspace: null,
		targetLabel: "local",
		modelLabel: "test-model",
		route: "ready" as const,
		routeReason: null,
		projectContext: "ok" as const,
		submitKeyLabel: "Enter",
		autonomy: "default",
		targets: "3 configured",
		fleet: "12 agent recipes",
		quota: "Claude 5h 7% used/wk 100% used · Codex wk 26% used · Local $0.00",
	};
	const keyLabel = (action: string): string | null =>
		({
			"clio-coder.leader": "Ctrl+G",
			"clio-coder.model.select": "Alt+M",
			"clio-coder.editor.external": "Alt+G",
		})[action] ?? null;
	for (const width of [160, 200, 240]) {
		const lines = buildWelcomeDashboardLines(stats, "0.5.7", width, "launchpad", 0, keyLabel).map(stripTerminalSequences);
		ok(lines.every((line) => visibleWidth(line) <= width));
		const column = (text: string) => {
			const row = lines.find((line) => line.includes(text));
			ok(row, `missing ${text} at ${width} columns`);
			return row.indexOf(text);
		};
		strictEqual(column("/tmp/welcome-test"), column("Up to date"));
		strictEqual(column("Claude"), column("Up to date"));
		strictEqual(column("Choose a model"), column("Browse plugins"));
		strictEqual(column("Explore commands"), column("Browse plugins"));
		strictEqual(column("Every action by letter"), column("Model picker"));
		strictEqual(column("Write in your own"), column("Model picker"));
		const local = lines.find((line) => line.includes("Local"));
		if (!local) {
			match(lines.join("\n"), /… \/usage/u);
			continue;
		}
		const valueColumn = column("Up to date");
		// Wrapped subscription continuations start on the same value axis.
		ok(!local.slice(0, valueColumn).includes("Local"));
	}
});

test("terminals declaring no capabilities disable color independently of font opt-in", () => {
	for (const term of ["dumb", "unknown"]) {
		strictEqual(colorDisabled({ TERM: term }), true);
		strictEqual(nerdFontEnabled({ TERM: term, CLIO_CODER_NERD_FONT: "1" }), false);
	}
	strictEqual(colorDisabled({ TERM: "xterm-256color", NO_COLOR: "" }), false);
	strictEqual(colorDisabled({ TERM: "xterm-256color", NO_COLOR: "1" }), true);
});

test("welcome height and usage placement stay fixed from Stage 0 through quota hydration", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.CLIO_CODER_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.outputDetail = "detailed";
	const boot = createBootWelcome(settings, "Enter");
	let quota: string | null = null;
	const hydrated = createWelcomeDashboard({
		providers: { list: () => [] },
		getSettings: () => settings,
		getQuotaSummary: () => quota,
		getKeyLabel: () => "Ctrl+J",
	});
	try {
		for (const width of [8, 20, 40, 60, 76, 80, 100, 160, 200, 240]) {
			const initial = boot.render(width);
			ok(initial.length <= 24, "artwork remains bounded on narrow terminals");
			const usageRow = initial.map(stripTerminalSequences).findIndex((line) => line.includes("AI usage"));
			for (const reading of [
				null,
				"Local $0.00",
				"Claude 5h 7% used/wk 100% used · Codex wk 26% used · Local $0.00",
				"Account quota summary ".repeat(100),
			]) {
				quota = reading;
				const lines = hydrated.render(width);
				strictEqual(lines.length, initial.length, `height changed at ${width} columns`);
				ok(lines.every((line) => visibleWidth(line) <= width));
				if (usageRow !== -1)
					strictEqual(
						lines.map(stripTerminalSequences).findIndex((line) => line.includes("AI usage")),
						usageRow,
					);
			}
		}
		const overflow = hydrated.render(200).map(stripTerminalSequences).join("\n");
		match(overflow, /… \/usage/u);
		quota = null;
		const cleared = hydrated.render(200).map(stripTerminalSequences).join("\n");
		ok(!cleared.includes("Account quota"));
		ok(cleared.includes("/usage for limits"));
		settings.interface.demo = false;
		quota = "Account quota summary ".repeat(100);
		strictEqual(hydrated.render(200).length, 1);
	} finally {
		hydrated.dispose();
	}
});

test("welcome centers the artwork and gives contextual project guidance without configuration inventory", () => {
	const stats = {
		outputStyle: "detailed" as const,
		cwd: "/tmp/project",
		workspace: null,
		targetLabel: "local",
		modelLabel: "model",
		route: "ready" as const,
		routeReason: null,
		projectContext: "none" as const,
		submitKeyLabel: "Enter",
		autonomy: "yolo",
		targets: "9 configured",
		fleet: "28 recipes",
		quota: null,
	};
	for (const width of [80, 120, 180, 240]) {
		const rows = buildWelcomeDashboardLines(stats, "0.5.7", width, "launchpad").map(stripTerminalSequences);
		const artRows = rows.flatMap((line, index) => (line.includes("██") ? [index] : []));
		ok(artRows.length > 0);
		const text = rows.join("\n");
		ok(!/describe a task|Permissions|configured|recipes|Systems engineering/u.test(text));
		match(text, /local · model/u);
		match(text, /YOLO · no approval stops/u);
		match(text, /\/context init/u);
		const stale = buildWelcomeDashboardLines({ ...stats, projectContext: "stale" }, "0.5.7", width, "launchpad")
			.map(stripTerminalSequences)
			.join("\n");
		match(stale, /Stale project awareness: \/context refresh/u);
		ok(!stale.includes("/context init"));
	}
});

test("startup and live tier changes share one bounded welcome policy", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.CLIO_CODER_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "local";
	settings.chat.model = "test-model";
	const live = createWelcomeDashboard({
		providers: { list: () => [] },
		getSettings: () => settings,
		getTerminalRows: () => 40,
	});
	try {
		for (const demo of [true, false]) {
			settings.interface.demo = demo;
			for (const style of ["compact", "standard", "detailed"] as const) {
				settings.interface.outputDetail = style;
				const boot = createBootWelcome(settings, "Enter");
				for (const width of [80, 120, 200]) {
					for (const header of [boot, live]) {
						const lines = header.render(width);
						const text = lines.map(stripTerminalSequences).join("\n");
						ok(lines.every((line) => visibleWidth(line) <= width));
						match(text, /test-model/u);
						if (!demo || style === "compact") {
							strictEqual(lines.length, 1);
							ok(!/██|\/help|Awareness/u.test(text));
						} else if (style === "standard") {
							ok(lines.length <= 8);
							match(text, /Default · reviewed approvals/u);
							ok(!text.includes("██"));
						} else ok(text.includes("██"));
					}
				}
			}
		}
		settings.interface.demo = true;
		settings.interface.outputDetail = "standard";
		const before = live.render(120);
		settings.safety.autonomy = "yolo";
		const after = live.render(120);
		ok(after !== before, "autonomy invalidates the welcome cache");
		match(after.map(stripTerminalSequences).join("\n"), /YOLO · no approval stops/u);
	} finally {
		live.dispose();
	}
});
