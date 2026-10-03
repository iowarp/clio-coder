import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { colorDisabled, nerdFontEnabled } from "../../src/core/terminal-preferences.js";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { ClioEditor } from "../../src/interactive/clio-editor.js";
import {
	buildWelcomeDashboardLines,
	createBootWelcome,
	createWelcomeDashboard,
} from "../../src/interactive/welcome-dashboard.js";

const originalEnv = { ...process.env };
afterEach(() => {
	for (const key of ["TERM", "CLIO_CODER_SCREEN_READER", "CLIO_CODER_NERD_FONT", "NO_COLOR"]) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

test("demo-off skips welcome-only readers and live toggles restore the full welcome", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.CLIO_CODER_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.demo = false;
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
			"tui.input.newLine": "Ctrl+J",
			"clio-coder.model.select": "Alt+M",
			"clio-coder.editor.external": "Ctrl+G",
		})[action] ?? null;
	for (const width of [160, 200, 240]) {
		const lines = buildWelcomeDashboardLines(stats, "0.5.7", width, "launchpad", 0, keyLabel).map(stripTerminalSequences);
		ok(lines.every((line) => visibleWidth(line) <= width));
		const column = (text: string) => {
			const row = lines.find((line) => line.includes(text));
			ok(row, `missing ${text} at ${width} columns`);
			return row.indexOf(text);
		};
		strictEqual(column("/tmp/welcome-test"), column("Current"));
		strictEqual(column("Claude"), column("Current"));
		strictEqual(column("Choose a model"), column("Browse skills"));
		strictEqual(column("Explore commands"), column("Browse skills"));
		strictEqual(column("New line"), column("Model picker"));
		strictEqual(column("Open your external"), column("Model picker"));
		const local = lines.find((line) => line.includes("Local"));
		if (!local) {
			match(lines.join("\n"), /… \/usage/u);
			continue;
		}
		const valueColumn = column("Current");
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
			const baseRows = width >= 57 && width < 76 ? 21 : 17;
			const taglineRows = width < 40 ? 0 : width < 76 ? 2 : 1;
			ok(initial.length >= baseRows && initial.length <= baseRows + taglineRows);
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
		strictEqual(rows.length, 18);
		const artRows = rows.flatMap((line, index) => (line.includes("██") ? [index] : []));
		strictEqual(artRows[0], 2);
		strictEqual(artRows.at(-1), 12);
		const text = rows.join("\n");
		ok(!/describe a task|Permissions|configured|recipes|Systems engineering/u.test(text));
		match(text, /Session started/u);
		match(text, /\/context init/u);
		const stale = buildWelcomeDashboardLines({ ...stats, projectContext: "stale" }, "0.5.7", width, "launchpad")
			.map(stripTerminalSequences)
			.join("\n");
		match(stale, /Stale project awareness: \/context refresh/u);
		ok(!stale.includes("/context init"));
	}
});
