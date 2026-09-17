import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import type {
	LibraryCopy,
	LibraryEntryKind,
	LibraryInventory,
	LibraryResource,
} from "../../src/domains/resources/index.js";
import { readLibraryInventory } from "../../src/domains/resources/index.js";
import type { TUI } from "../../src/engine/tui.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { ClioOverlayFrame } from "../../src/interactive/overlay-frame.js";
import { openLibraryOverlay } from "../../src/interactive/overlays/library.js";
import { buildLibraryRows, selectForCategory } from "../../src/interactive/overlays/library-model.js";
import { type ListOverlayHandle, ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import { clioTheme, createClioTheme } from "../../src/interactive/theme/index.js";
import { libraryApplyFixture, libraryPlanFixture } from "../harness/library-plan-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function recipe(kind: "agent" | "fleet", name: string): LibraryResource {
	return {
		key: `${kind}:${name}`,
		kind,
		name,
		description: "A loaded core recipe.",
		path: `/core/${name}`,
		source: { class: "core", id: "core", scope: "user" },
		origin: { kind: "core" },
		availability: "available",
		trusted: true,
		diagnostics: [],
	};
}

function inventory(): LibraryInventory {
	return {
		version: 1,
		generatedAt: "2026-09-16T00:00:00Z",
		cwd: "/fixture",
		audience: "operator",
		packages: [
			{
				ref: "plugin:materio",
				name: "materio",
				kind: "plugin",
				description: "Science bundle",
				origin: { kind: "bundled", catalog: "/library/registry.yaml" },
				format: "portable",
				copies: [],
				sourceUrl: "./materio",
				catalogOrigin: "catalog",
				provides: [
					{ kind: "agent", name: "lab-agent" },
					{ kind: "fleet", name: "lab-fleet" },
					{ kind: "skill", name: "lab-skill" },
				],
			},
		],
		copies: [],
		resources: [recipe("agent", "debugger"), recipe("fleet", "review")],
		diagnostics: Array.from({ length: 8 }, (_, index) => `skill diagnostic ${index}`),
		truncated: { packages: false, copies: false, resources: false },
	};
}

function browser(category: LibraryEntryKind, data = inventory()) {
	let view!: ListOverlayView;
	let reads = 0;
	let plans = 0;
	let writes = 0;
	let closes = 0;
	const editor: string[] = [];
	const fleets: string[] = [];
	openLibraryOverlay({} as TUI, {
		initialTab: category,
		readInventory: () => {
			reads++;
			return data;
		},
		lifecycle: {
			plan: (request) => {
				plans++;
				return libraryPlanFixture({ operation: request.operation });
			},
			apply: () => {
				writes++;
				return libraryApplyFixture();
			},
			release() {},
			retryRefresh: () => ({ status: "not-applicable", reason: "fixture" }),
		},
		setEditorText: (text) => editor.push(text),
		openFleetRun: (name) => fleets.push(name),
		notice() {},
		onClose: () => {
			closes++;
		},
		scheduleInitial() {},
		openList: (_tui, options) => {
			const listView = new ListOverlayView(options, () => {});
			view = listView;
			listView.setViewportRows(30);
			return {
				hide() {},
				setHidden(hidden: boolean) {
					if (!hidden) view = listView;
				},
				focus() {},
				refreshTabs: () => listView.refreshTabs(),
				setItems: (items: Parameters<ListOverlayHandle["setItems"]>[0]) => listView.setItems(items),
				setActiveTab: (id: string) => listView.setActiveTab(id),
				activeTabId: () => listView.activeTab()?.id ?? "",
				selectById: (id: string) => listView.selectById(id),
				toggleDetail: () => listView.toggleDetail(),
			} as unknown as ListOverlayHandle;
		},
	});
	view.setViewportRows(30);
	return {
		get view() {
			return view;
		},
		editor,
		fleets,
		get reads() {
			return reads;
		},
		get plans() {
			return plans;
		},
		get writes() {
			return writes;
		},
		get closes() {
			return closes;
		},
	};
}

it("separates eight diagnostic notices from package counts across Plugins, Agents and Fleets", () => {
	for (const category of ["plugin", "agent", "fleet"] as const) {
		const state = browser(category);
		const text = plain(state.view.render(88).join("\n"));
		match(text, /1 package/);
		match(text, /n:8 notices/);
		match(text, /Actions: User/);
		ok(!text.includes("skill diagnostic"));
		state.view.handleInput("n");
		match(plain(state.view.render(88).join("\n")), /8 notices/);
		state.view.handleInput("i");
		state.view.handleInput("r");
		equal(state.plans, 0);
		equal(state.writes, 0);
		state.view.handleInput("\u001b");
		match(plain(state.view.render(88).join("\n")), /1 package/);
		equal(state.closes, 0);
		equal(state.reads, 1, "notice navigation and rendering use the cached inventory");
	}
});

it("identifies provider packages and limits their catalog hints to the selected recipe kind", () => {
	for (const category of ["agent", "fleet"] as const) {
		const view = { category, mode: "browse" as const, scope: "user" as const };
		const rows = buildLibraryRows({ view, inventory: selectForCategory(inventory(), view) });
		const item = rows.items[0];
		ok(item);
		equal(item.label, "materio [plugin]");
		equal(item.group, "Provider packages");
		const detail = item.detail?.(40).join("\n") ?? "";
		match(detail, new RegExp(`plugin provider package for ${category}`));
		match(detail, new RegExp(`lab-${category}`));
		ok(!detail.includes("lab-skill"));
		match(detail, /not loaded resources/);
		match(detail, /b shows loaded recipes/);
		match(detail, /i review install/);
		ok(!detail.includes("Enter members"));
	}
});

it("opens a useful inspector at 40, 60, 92 and 140 columns without render-time reads", () => {
	for (const category of ["plugin", "agent", "fleet"] as const) {
		const state = browser(category);
		const frame = new ClioOverlayFrame(
			state.view,
			() => state.view.title(),
			() => state.view.getHint(),
		);
		frame.setRowBudget(30);
		for (const width of [40, 60, 92, 140]) {
			const lines = frame.render(width);
			equal(lines.length, 30);
			for (const line of lines) equal(visibleWidth(line), width);
			match(plain(lines.join("\n")), /review install/);
			match(plain(lines.join("\n")), /materio/);
			match(plain(lines.join("\n")), /n:8 notices/);
			ok(!plain(lines.join("\n")).includes("Plugins packages"));
		}
		equal(state.reads, 1);
	}
});

it("preserves search typing and routes loaded agent and fleet use through existing entry points", () => {
	const state = browser("agent");
	state.view.handleInput("/");
	for (const key of "bnir") state.view.handleInput(key);
	equal(state.plans, 0);
	equal(state.reads, 1);
	state.view.handleInput("\u001b");
	state.view.handleInput("\u001b");
	state.view.handleInput("b");
	match(plain(state.view.render(88).join("\n")), /debugger/);
	state.view.handleInput("v");
	deepStrictEqual(state.editor, ["/run debugger "]);
	state.view.handleInput("\u001b[C");
	state.view.handleInput("\u001b[C");
	match(plain(state.view.render(88).join("\n")), /review/);
	state.view.handleInput("v");
	deepStrictEqual(state.fleets, ["review"]);
	equal(state.writes, 0);
});

it("neutralizes terminal controls while preserving Unicode identity and full inspectable detail", () => {
	const data = inventory();
	const name = "量子👩‍🔬é";
	const record = data.packages[0];
	ok(record);
	record.name = `${name}\u001b]0;spoof\u0007\u001b[2J\r`;
	record.description = `Long description ${name} `.repeat(50);
	const state = browser("agent", data);
	for (const width of [40, 92, 140]) {
		const lines = state.view.render(width);
		for (const line of lines) ok(visibleWidth(line) <= width);
		const text = plain(lines.join("\n"));
		ok(!text.includes("spoof"));
		ok(!lines.join("").includes("\u001b[2J"));
		match(text, /量子/);
	}
	const view = { category: "agent" as const, mode: "browse" as const, scope: "user" as const };
	const rows = buildLibraryRows({ view, inventory: selectForCategory(data, view) });
	ok(rows.items[0]?.detail?.(40).join("\n").includes(record.description));
});

it("finds core agents through the real inventory in Installed without broadening audience", async () => {
	const env = await isolateClioEnv("tui-library-ergonomics-");
	try {
		const data = readLibraryInventory({ cwd: env.dir });
		const state = browser("agent", data);
		state.view.handleInput("b");
		ok(
			state.view.selectById(
				data.resources.filter((r) => r.kind === "agent" && r.name === "debugger").map((r) => `res:${r.key}`)[0] ??
					"missing",
			),
		);
		state.view.handleInput("v");
		deepStrictEqual(state.editor, ["/run debugger "]);
		ok(!data.resources.some((r) => r.kind === "agent" && r.audience === "shadow"));
	} finally {
		env.restore();
	}
});

it("returns from notices to the exact resource selection, filter and browse focus at 40 columns", () => {
	const data = inventory();
	data.resources.push(recipe("agent", "debugger-two"));
	const state = browser("agent", data);
	state.view.handleInput("b");
	state.view.handleInput("/");
	for (const key of "debugger") state.view.handleInput(key);
	state.view.handleInput("\r");
	state.view.handleInput("\u001b[B");
	const parent = state.view;
	const before = plain(parent.render(36).join("\n"));
	match(before, /n:8 notices/);
	for (const exit of ["n", "\u001b"]) {
		state.view.handleInput("n");
		ok(state.view !== parent);
		state.view.handleInput("/");
		state.view.handleInput("0");
		state.view.handleInput("\r");
		if (exit === "\u001b") state.view.handleInput("\u001b");
		state.view.handleInput(exit);
		equal(state.view, parent);
		equal(state.view.keyboardScope, "browse");
		equal(plain(state.view.render(36).join("\n")), before);
	}
	state.view.handleInput("v");
	deepStrictEqual(state.editor, ["/run debugger-two "]);
});

it("preserves semantic colors while stripping external controls before metadata styling", (t) => {
	const theme = createClioTheme({ color: true });
	t.mock.method(clioTheme(), "fg", theme.fg);
	const hostile = "lab\u001b[2J\u001b[35m text\u001b]0;spoof\u0007";
	const data = inventory();
	const view = { category: "agent" as const, mode: "installed" as const, scope: "user" as const };
	for (const [availability, token] of [
		["available", "success"],
		["untrusted", "warning"],
		["unavailable", "error"],
		["shadowed", "dim"],
	] as const) {
		data.resources = [
			{
				...recipe("agent", "debugger"),
				availability,
				origin: { kind: "imported", agent: hostile, path: "/fixture" },
				owner: { ref: `plugin:${hostile}`, scope: "user" },
			},
		];
		const meta = buildLibraryRows({ view, inventory: selectForCategory(data, view) }).items[0]?.meta ?? "";
		ok(meta.includes(theme.fg(token, availability)));
		ok(!meta.includes("\u001b[2J") && !meta.includes("\u001b[35m") && !meta.includes("spoof"));
		match(plain(meta), /lab text/);
	}
	for (const [state, token] of [
		["loadable", "success"],
		["disabled", "warning"],
		["damaged", "error"],
		["shadowed", "dim"],
	] as const) {
		const copy: LibraryCopy = {
			ref: "plugin:fixture",
			kind: "plugin",
			name: "fixture",
			scope: "user",
			root: "/fixture",
			version: "1.0.0",
			state,
			enabled: state !== "disabled",
			valid: true,
			compatible: true,
			effective: true,
			loadable: state === "loadable",
			trust: "foreign",
			origin: { kind: "imported", agent: hostile, path: "/fixture" },
			diagnostics: [],
		};
		data.copies = [copy];
		const copyView = { ...view, category: "plugin" as const };
		const meta = buildLibraryRows({ view: copyView, inventory: selectForCategory(data, copyView) }).items[0]?.meta ?? "";
		ok(meta.includes(theme.fg(token, state)));
		ok(meta.includes(theme.fg("warning", "foreign")));
		ok(!meta.includes("\u001b[2J") && !meta.includes("\u001b[35m") && !meta.includes("spoof"));
		match(plain(meta), /lab text/);
	}
});

it("qualifies notice return guidance while retaining search-first keyboard precedence", () => {
	const state = browser("agent");
	const parent = state.view;
	state.view.handleInput("n");
	const notices = state.view;
	match(plain(notices.render(140).join("\n")), /From browse focus, n returns/);
	state.view.handleInput("/");
	state.view.handleInput("x");
	state.view.handleInput("\u001b");
	equal(state.view, notices);
	equal(state.view.keyboardScope, "edit");
	state.view.handleInput("n");
	equal(state.view, notices);
	match(plain(notices.render(140).join("\n")), /> n/);
	state.view.handleInput("\u001b");
	equal(state.view.keyboardScope, "edit");
	state.view.handleInput("\u001b");
	equal(state.view.keyboardScope, "browse");
	state.view.handleInput("n");
	equal(state.view, parent);
});

it("uses package and entry footer units with singular/plural forms across recipe categories", () => {
	for (const category of ["agent", "fleet"] as const) {
		for (const count of [0, 1, 2]) {
			const data = inventory();
			const provider = data.packages[0];
			ok(provider);
			data.packages = Array.from({ length: count }, (_, index) => ({
				...provider,
				ref: `plugin:provider-${index}` as const,
				name: `provider-${index}`,
			}));
			data.resources = Array.from({ length: count }, (_, index) => recipe(category, `recipe-${index}`));
			const state = browser(category, data);
			match(plain(state.view.getHint()), new RegExp(`tab · ${count} ${count === 1 ? "package" : "packages"}`));
			ok(!plain(state.view.getHint()).includes(`1 ${category}s`));
			state.view.handleInput("b");
			match(plain(state.view.getHint()), new RegExp(`tab · ${count} ${count === 1 ? "entry" : "entries"}`));
		}
	}
	const legacy = new ListOverlayView(
		{
			title: "Other",
			items: [],
			tabs: [{ id: "agents", label: "Agents", items: () => [{ id: "one", label: "One" }] }],
			onClose() {},
		},
		() => {},
	);
	match(plain(legacy.getHint()), /tab · 1 agents/);
});
