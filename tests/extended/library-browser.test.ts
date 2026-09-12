import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { LibraryImportPlan } from "../../src/domains/interop/index.js";
import type { PluginScope } from "../../src/domains/plugins/types.js";
import type {
	LibraryApplyResult,
	LibraryCopy,
	LibraryCopyInspection,
	LibraryInventory,
	LibraryPackageRecord,
	LibraryRefreshResult,
	LibraryResource,
} from "../../src/domains/resources/index.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import { openLibraryOverlay } from "../../src/interactive/overlays/library.js";
import type { LibraryLifecyclePort } from "../../src/interactive/overlays/library-lifecycle.js";
import {
	buildLibraryRows,
	type LibraryView,
	libraryOriginLabel,
	libraryRowActions,
	libraryStatusLine,
	libraryTruncationNotice,
	selectForCategory,
} from "../../src/interactive/overlays/library-model.js";
import { formatLibraryOutcome, formatLibraryPlanReview } from "../../src/interactive/overlays/library-review.js";
import {
	type ListOverlayHandle,
	type ListOverlayItem,
	type ListOverlayOptions,
	ListOverlayView,
} from "../../src/interactive/overlays/list-overlay.js";
import { libraryApplyFixture, libraryPlanFixture } from "../harness/library-plan-fixture.js";

function record(overrides: Partial<LibraryPackageRecord> = {}): LibraryPackageRecord {
	return {
		ref: "plugin:materio",
		kind: "plugin",
		name: "materio",
		description: "Materials science bundle",
		sourceUrl: "./materio",
		origin: { kind: "bundled", catalog: "/pkg/library/registry.yaml" },
		format: "portable",
		catalogOrigin: "catalog",
		copies: [],
		provides: [
			{ kind: "skill", name: "materio-lab" },
			{ kind: "agent", name: "materio-lab-definer" },
		],
		...overrides,
	};
}

function copy(overrides: Partial<LibraryCopy> = {}): LibraryCopy {
	return {
		ref: "plugin:materio",
		kind: "plugin",
		name: "materio",
		scope: "user",
		root: "/config/plugins/materio",
		version: "1.0.0",
		state: "loadable",
		enabled: true,
		valid: true,
		compatible: true,
		effective: true,
		loadable: true,
		trust: "trusted",
		origin: { kind: "bundled", catalog: "/pkg/library/registry.yaml" },
		format: "portable",
		diagnostics: [],
		...overrides,
	};
}

function resource(overrides: Partial<LibraryResource> = {}): LibraryResource {
	return {
		key: "skill:materio-lab@plugin:user:materio#skills/lab/SKILL.md",
		kind: "skill",
		name: "materio-lab",
		description: "Lab procedures",
		invocation: "/skill materio-lab",
		path: "/config/plugins/materio/skills/lab/SKILL.md",
		source: { class: "package", id: "plugin:user:materio", scope: "package" },
		owner: { ref: "plugin:materio", scope: "user" },
		origin: { kind: "bundled", catalog: "/pkg/library/registry.yaml" },
		availability: "available",
		trusted: true,
		diagnostics: [],
		...overrides,
	};
}

/** A recipe found directly in a resource root: no owning package, no invocation when it cannot run. */
function unowned(overrides: Partial<LibraryResource> = {}): LibraryResource {
	const { owner: _owner, invocation: _invocation, ...rest } = resource(overrides);
	return { ...rest, ...overrides } as LibraryResource;
}

function inventory(overrides: Partial<LibraryInventory> = {}): LibraryInventory {
	return {
		version: 1,
		generatedAt: "2026-01-01T00:00:00.000Z",
		cwd: "/work",
		audience: "operator",
		packages: [record()],
		copies: [copy()],
		resources: [resource()],
		diagnostics: [],
		truncated: { packages: false, copies: false, resources: false },
		...overrides,
	};
}

const BROWSE: LibraryView = { category: "plugin", mode: "browse", scope: "user" };

function plain(value: string): string {
	return stripVTControlCharacters(value);
}

describe("library browser projection", () => {
	it("keeps origin, format, trust and availability as separate facts", () => {
		equal(libraryOriginLabel({ kind: "bundled", catalog: "/x" }), "Bundled with Clio-Coder");
		equal(libraryOriginLabel({ kind: "remote", url: "https://example/x" }), "Remote");
		equal(libraryOriginLabel({ kind: "local", path: "/x" }), "Local");
		equal(libraryOriginLabel({ kind: "imported", agent: "claude-code", path: "/x" }), "Imported from claude-code");
		equal(libraryOriginLabel({ kind: "core" }), "Core");
		equal(libraryOriginLabel({ kind: "unknown" }), "Unknown origin");

		// A remote package in Claude's format is remote, not a local Claude install.
		const rows = buildLibraryRows({
			inventory: selectForCategory(
				inventory({
					packages: [record({ origin: { kind: "remote", url: "https://example/x" }, format: "claude-code" })],
				}),
				BROWSE,
			),
			view: BROWSE,
		});
		const meta = plain(rows.items[0]?.meta ?? "");
		match(meta, /Remote/);
		const detail = plain((rows.items[0]?.detail?.(80) ?? []).join("\n"));
		match(detail, /Claude Code format/);
		match(detail, /https:\/\/example\/x/);
	});

	it("draws mode and scope at every width, including a narrow one", () => {
		const counts = { rows: 3, notices: 1, truncated: false };
		for (const width of [140, 100, 48, 32]) {
			const line = plain(libraryStatusLine({ ...BROWSE, mode: "installed", scope: "project" }, counts, width));
			match(line, /Installed/, `width ${width}`);
			match(line, /Project/, `width ${width}`);
		}
		match(plain(libraryStatusLine(BROWSE, counts, 120)), /Browse/);
		match(plain(libraryStatusLine(BROWSE, counts, 120)), /User/);
	});

	it("offers no package lifecycle on core and loose recipes, and says why", () => {
		const core = libraryRowActions(
			{
				kind: "recipe",
				resource: unowned({
					key: "agent:scout@core#builtins/scout.md",
					kind: "agent",
					name: "scout",
					source: { class: "core", id: "core", scope: "user" },
					origin: { kind: "core" },
				}),
			},
			{ ...BROWSE, category: "agent", mode: "installed" },
		);
		deepStrictEqual(
			{ install: core.install, remove: core.remove, update: core.update, enable: core.enable },
			{ install: false, remove: false, update: false, enable: false },
		);
		equal(core.use, true);
		match(core.reasons.join(" "), /Core recipes ship with Clio-Coder/);

		const loose = libraryRowActions(
			{
				kind: "recipe",
				resource: unowned({
					key: "skill:draft@project#.clio-coder/skills/draft/SKILL.md",
					source: { class: "project", id: "project", scope: "project" },
					origin: { kind: "local", path: "/work/.clio-coder/skills/draft" },
				}),
			},
			{ ...BROWSE, category: "skill", mode: "installed" },
		);
		equal(loose.remove, false);
		match(loose.reasons.join(" "), /not installed as a package/);
	});

	it("gives an unavailable recipe no use action and states the reason", () => {
		const actions = libraryRowActions(
			{
				kind: "recipe",
				resource: unowned({ availability: "unavailable", reason: "its bound skill failed to load" }),
			},
			{ ...BROWSE, category: "skill", mode: "installed" },
		);
		equal(actions.use, false);
		match(actions.reasons.join(" "), /bound skill failed to load/);
	});

	it("identifies the whole owner and the selected scope from a member row", () => {
		const owner = copy({ scope: "project" });
		const actions = libraryRowActions(
			{
				kind: "member",
				owner,
				member: { kind: "skill", name: "materio-lab", path: "/p/skills/lab/SKILL.md", valid: true, diagnostics: [] },
			},
			{ ...BROWSE, scope: "project" },
		);
		equal(actions.remove, true);
		match(actions.reasons.join(" "), /identify the whole owner plugin:materio in project scope/);
	});

	it("refuses to read an absent package as proof when results were capped", () => {
		const capped = inventory({ truncated: { packages: false, copies: true, resources: false } });
		const notice = libraryTruncationNotice(capped) ?? "";
		match(notice, /installed copies/);
		match(notice, /does not prove a package is not installed/);
		const rows = buildLibraryRows({ inventory: selectForCategory(capped, BROWSE), view: BROWSE });
		equal(rows.truncated, true);
		ok(rows.items.some((item) => plain(item.label).includes("does not prove")));
	});

	it("separates Browse install targets from Installed copies and recipes", () => {
		const browse = buildLibraryRows({ inventory: selectForCategory(inventory(), BROWSE), view: BROWSE });
		deepStrictEqual(
			browse.items.map((item) => item.id),
			["pkg:plugin:materio"],
		);
		const installedView: LibraryView = { category: "plugin", mode: "installed", scope: "user" };
		const installed = buildLibraryRows({
			inventory: selectForCategory(inventory(), installedView),
			view: installedView,
		});
		deepStrictEqual(
			installed.items.map((item) => item.id),
			["copy:plugin:materio@user"],
		);
		const skillsView: LibraryView = { category: "skill", mode: "installed", scope: "user" };
		const skills = buildLibraryRows({ inventory: selectForCategory(inventory(), skillsView), view: skillsView });
		deepStrictEqual(
			skills.items.map((item) => item.id),
			["res:skill:materio-lab@plugin:user:materio#skills/lab/SKILL.md"],
		);
	});

	it("finds a bundle in a recipe category through its catalog hints, without calling it loaded", () => {
		const view: LibraryView = { category: "skill", mode: "browse", scope: "user" };
		const rows = buildLibraryRows({ inventory: selectForCategory(inventory(), view), view });
		equal(rows.items.length, 1);
		const detail = plain((rows.items[0]?.detail?.(80) ?? []).join("\n"));
		match(detail, /Catalog hints:.*skill:materio-lab/);
		equal(rows.items[0]?.id, "pkg:plugin:materio");
	});

	it("keeps a damaged copy of a recipe package reachable in its own category", () => {
		const view: LibraryView = { category: "skill", mode: "installed", scope: "user" };
		const damaged = inventory({
			copies: [copy({ ref: "skill:ship", kind: "skill", name: "ship", state: "damaged", loadable: false })],
			resources: [],
		});
		const rows = buildLibraryRows({ inventory: selectForCategory(damaged, view), view });
		deepStrictEqual(
			rows.items.map((item) => item.id),
			["copy:skill:ship@user"],
		);
	});
});

describe("library review and outcome wording", () => {
	it("states operation, scope, dependencies, reverse dependencies, fallback and recovery", () => {
		const plan = libraryPlanFixture({
			operation: "remove",
			ref: "plugin:materio",
			scope: "project",
			newlyBroken: [{ ref: "plugin:lab", scope: "project", missing: ["plugin:materio"] }],
			refusal: "plugin:lab (project) would lose plugin:materio; repair or remove the dependent first.",
		});
		const body = plain(formatLibraryPlanReview(plan, 90).join("\n"));
		match(body, /remove plugin:materio in project scope/);
		match(body, /would break plugin:lab \(project\): needs plugin:materio/);
		match(body, /No copy in the other scope/);
		match(body, /Changed files are kept beside the package/);
		match(body, /cannot be applied as reviewed/);
		// Paths and digests are opt-in so the dependency story is not crowded out.
		ok(!body.includes("/tmp/materio"));
		match(plain(formatLibraryPlanReview(plan, 90, { detail: true }).join("\n")), /destination \/tmp\/materio/);
	});

	it("reports a partial batch as committed, failed and unattempted, with refresh separate", () => {
		const result = libraryApplyFixture({
			outcomes: [
				{
					status: "committed",
					operation: "install",
					identity: { ref: "skill:ship", kind: "skill", name: "ship", scope: "user" },
					verification: {
						evidence: "pre-refresh",
						tree: "present",
						record: "recorded",
						resources: [{ kind: "skill", name: "ship", available: true }],
						effective: { scope: "user", loadable: true },
					},
					diagnostics: [],
				},
				{
					status: "failed",
					operation: "install",
					identity: { ref: "plugin:materio", kind: "plugin", name: "materio", scope: "user" },
					diagnostics: [],
					error: { code: "stale_plan", message: "reviewed tree changed", next: "Review a fresh plan." },
				},
				{
					status: "unattempted",
					operation: "install",
					identity: { ref: "plugin:extra", kind: "plugin", name: "extra", scope: "user" },
					diagnostics: [],
				},
			],
			refresh: { status: "failed", error: "reload threw" },
		});
		const body = plain(formatLibraryOutcome(result, 90).join("\n"));
		match(body, /1 committed · 1 failed · 1 unattempted/);
		match(body, /stale_plan: reviewed tree changed/);
		match(body, /Review a fresh plan/);
		match(body, /session refresh failed: reload threw; press R to retry/);
		// Disk and resource evidence predate the refresh; a failed refresh must not
		// read as "this session now has it".
		match(body, /resource evidence from before refresh; current session admission is unverified/);
		match(body, /Unattempted steps were never started/);
		match(body, /never repeats a write/);
	});

	it("keeps resource evidence from before refresh distinct from current session admission", () => {
		const body = plain(
			formatLibraryOutcome(
				libraryApplyFixture({
					outcomes: [
						{
							status: "committed",
							operation: "install",
							identity: { ref: "skill:ship", kind: "skill", name: "ship", scope: "user" },
							verification: {
								evidence: "pre-refresh",
								tree: "present",
								record: "recorded",
								resources: [{ kind: "skill", name: "ship", available: false, reason: "untrusted project import" }],
								effective: { scope: "user", loadable: true },
							},
							diagnostics: [],
						},
					],
					refresh: { status: "refreshed", generation: 4, changed: true },
				}),
				90,
			).join("\n"),
		);
		match(body, /reopen the Library for current\s+admission/);
		// A package can be on disk while one resource is still unavailable.
		match(body, /skill:ship unavailable \(untrusted project import\)/);
		match(body, /generation 4/);
	});
});

/** A TUI stub: the browser only asks for a render. */
function stubTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

interface Harness {
	options: ListOverlayOptions;
	handle: OverlayHandle;
	notices: Array<[string, string]>;
	editor: string[];
	planned: Array<{ operation: string; ref: string; scope?: PluginScope }>;
	applied: number;
	released: number;
	importsReleased: number;
	refreshes: number;
	review: { accept: () => void; cancel: () => void } | null;
	inventoryReads: number;
	closed: number;
	fleetRuns: string[];
	imports: number;
	rows: (category?: string) => ReadonlyArray<ListOverlayItem>;
	/** A real list view over the browser's own options, for rendered keyboard checks. */
	mount: () => ListOverlayView;
	press: (key: string, rowId?: string, category?: string) => void;
	status: (width: number) => string;
}

/**
 * Drive the browser through the list overlay's own option surface.
 *
 * The overlay's contract is exactly what it hands the list: which rows each tab
 * builds, which keys are bound where, what the status row says, and what Esc
 * claims. Calling those is closer to the operator's keystroke than reaching
 * into the view would be, and it does not need a terminal.
 */
function harness(
	options: {
		inventory?: LibraryInventory;
		inspection?: LibraryCopyInspection;
		refresh?: LibraryRefreshResult;
		refusal?: string;
		initialTab?: LibraryPackageRecord["kind"];
		focus?: string;
		intent?: "install" | "remove";
		result?: LibraryApplyResult;
		importSource?: string;
		importPlanAction?: "install" | "blocked";
	} = {},
): Harness {
	let captured: ListOverlayOptions | null = null;
	const state = {
		notices: [] as Array<[string, string]>,
		editor: [] as string[],
		planned: [] as Array<{ operation: string; ref: string; scope?: PluginScope }>,
		applied: 0,
		released: 0,
		importsReleased: 0,
		refreshes: 0,
		review: null as Harness["review"],
		inventoryReads: 0,
		closed: 0,
		fleetRuns: [] as string[],
		imports: 0,
	};
	const lifecycle: LibraryLifecyclePort = {
		plan: (request) => {
			state.planned.push({
				operation: request.operation,
				ref: request.ref,
				...(request.scope ? { scope: request.scope } : {}),
			});
			return libraryPlanFixture({
				operation: request.operation,
				ref: request.ref as `plugin:${string}`,
				...(request.scope ? { scope: request.scope } : {}),
				...(options.refusal ? { refusal: options.refusal } : {}),
				...(options.refusal ? { missing: ["skill:ship"] } : {}),
			});
		},
		apply: () => {
			state.applied += 1;
			return (
				options.result ??
				libraryApplyFixture({ refresh: options.refresh ?? { status: "refreshed", generation: 2, changed: true } })
			);
		},
		release: () => {
			state.released += 1;
		},
		retryRefresh: () => {
			state.refreshes += 1;
			return options.refresh ?? { status: "refreshed", generation: 3, changed: false };
		},
	};
	const listHandle = {
		hide: () => {},
		setHidden: () => {},
		focus: () => {},
		setItems: () => {},
		refreshTabs: () => {},
		setActiveTab: () => {},
		activeTabId: () => captured?.activeTabId ?? "",
		selectById: () => true,
		toggleDetail: () => {},
	} as unknown as ListOverlayHandle;

	const handle = openLibraryOverlay(stubTui(), {
		lifecycle,
		cwd: "/work",
		columns: () => 120,
		...(options.initialTab ? { initialTab: options.initialTab } : {}),
		...(options.focus ? { focus: options.focus } : {}),
		...(options.intent ? { intent: options.intent } : {}),
		...(options.importSource ? { importSource: options.importSource } : {}),
		scheduleInitial: (run) => run(),
		openList: (_tui, listOptions) => {
			captured = listOptions;
			// The real opener builds every tab's rows in its constructor, which is
			// what fills the subject map the actions read.
			for (const tab of listOptions.tabs ?? []) tab.items();
			return listHandle;
		},
		readInventory: () => {
			state.inventoryReads += 1;
			return options.inventory ?? inventory();
		},
		inspectCopy: () =>
			options.inspection ?? {
				copy: copy(),
				resources: [{ kind: "skill", name: "materio-lab", path: "/p/skills/lab/SKILL.md", valid: true, diagnostics: [] }],
				ancillary: [],
				prerequisites: [],
				diagnostics: [],
			},
		openReview: (_tui, reviewOptions) => {
			state.review = {
				accept: () => reviewOptions.onDone(reviewOptions.commit(reviewOptions.plan)),
				cancel: () => reviewOptions.onCancel(),
			};
			return { hide: () => {}, setHidden: () => {}, focus: () => {} } as unknown as OverlayHandle;
		},
		planImport: (input) =>
			({
				source: { input, transport: "local", root: "/staged", path: input },
				detection: {} as never,
				action: options.importPlanAction ?? "install",
				reasons: [],
				id: "vendor-pack",
				scope: "user",
				cwd: "/work",
				destination: "/config/plugins/vendor-pack",
				outcomes: [{ kind: "skill", name: "vendor-skill", status: "install" }],
				unsupported: ["hooks"],
				omitted: ["run.py"],
				requirements: [],
				origin: { kind: "interop", host: "claude-code", source: input },
				reviewFingerprint: "f".repeat(64),
				files: {},
				cleanup: () => {
					state.importsReleased += 1;
				},
			}) as unknown as LibraryImportPlan,
		applyImport: () => {
			state.imports += 1;
			return {
				published: true,
				installed: "vendor-pack",
				admission: { trust: "foreign", gate: "integrations.projectResources.trustProjectImports", gateEnabled: "unknown" },
				diagnostics: [],
			} as never;
		},
		openImportReview: (_tui, importOptions) => {
			state.review = {
				accept: () =>
					importOptions.onDone(importOptions.outcome(importOptions.plan, importOptions.commit(importOptions.plan))),
				cancel: () => importOptions.onCancel(),
			};
			return { hide: () => {}, setHidden: () => {}, focus: () => {} } as unknown as OverlayHandle;
		},
		openImport: () => {
			state.imports += 1;
		},
		openFleetRun: (name) => state.fleetRuns.push(name),
		setEditorText: (text) => state.editor.push(text),
		notice: (level, text) => state.notices.push([level, text]),
		onClose: () => {
			state.closed += 1;
		},
	});

	const listOptions = captured as unknown as ListOverlayOptions;
	const rows = (category?: string): ReadonlyArray<ListOverlayItem> => {
		const tab = listOptions.tabs?.find((candidate) => candidate.id === (category ?? listOptions.activeTabId));
		return tab ? tab.items() : [];
	};
	return {
		options: listOptions,
		handle,
		...state,
		get notices() {
			return state.notices;
		},
		get editor() {
			return state.editor;
		},
		get planned() {
			return state.planned;
		},
		get applied() {
			return state.applied;
		},
		get released() {
			return state.released;
		},
		get importsReleased() {
			return state.importsReleased;
		},
		get refreshes() {
			return state.refreshes;
		},
		get review() {
			return state.review;
		},
		get inventoryReads() {
			return state.inventoryReads;
		},
		get closed() {
			return state.closed;
		},
		get fleetRuns() {
			return state.fleetRuns;
		},
		get imports() {
			return state.imports;
		},
		rows,
		mount: () => new ListOverlayView(listOptions, () => {}),
		press: (key, rowId, category) => {
			const global = listOptions.globalActions?.[key];
			if (global) {
				global();
				return;
			}
			const current = rows(category);
			const item = current.find((candidate) => candidate.id === rowId) ?? current[0];
			if (!item) return;
			if (key === "\r") {
				listOptions.onSelect?.(item);
				return;
			}
			listOptions.actions?.[key]?.(item);
		},
		status: (width) => plain(listOptions.status?.(width) ?? ""),
	};
}

describe("library browser behavior", () => {
	it("reads the inventory once and projects it across the five categories", () => {
		const state = harness();
		equal(state.inventoryReads, 1);
		deepStrictEqual(
			state.options.tabs?.map((tab) => tab.id),
			["skill", "agent", "prompt", "fleet", "plugin"],
		);
	});

	it("changes mode and scope without a selected row and keeps both on the status line", () => {
		const state = harness({ inventory: inventory({ packages: [], copies: [], resources: [] }) });
		match(state.status(120), /Browse/);
		match(state.status(120), /User/);
		state.options.globalActions?.b?.();
		state.options.globalActions?.s?.();
		match(state.status(120), /Installed/);
		match(state.status(120), /Project/);
		// The same two facts survive a narrow terminal.
		match(state.status(32), /Installed/);
		match(state.status(32), /Project/);
		match(state.notices.map(([, text]) => text).join(" "), /now select project scope/);
	});

	it("reviews a removal, and cancelling writes nothing and releases staging", () => {
		const state = harness({ initialTab: "plugin" });
		state.options.globalActions?.b?.();
		state.press("r");
		ok(state.review, "r on an installed copy opens a review");
		equal(state.applied, 0, "nothing is written before the review is accepted");
		state.review?.cancel();
		equal(state.applied, 0);
		equal(state.released, 1, "cancel releases the staged source");
		match(state.notices.map(([, text]) => text).join(" "), /cancelled; nothing was written/);
	});

	it("applies an accepted plan once and reports the session refresh separately", () => {
		const state = harness({ initialTab: "plugin" });
		state.options.globalActions?.b?.();
		state.press("r");
		state.review?.accept();
		equal(state.applied, 1);
		deepStrictEqual(state.planned, [{ operation: "remove", ref: "plugin:materio", scope: "user" }]);
		match(state.notices.map(([, text]) => text).join(" "), /session refresh refreshed/);
	});

	it("refuses an install with missing requirements once, then reviews them together", () => {
		const state = harness({ initialTab: "plugin", refusal: "needs skill:ship" });
		state.press("i");
		equal(state.review, null, "a refused plan is reported before a review is opened");
		match(state.notices.map(([, text]) => text).join(" "), /needs skill:ship; press i again/);
		equal(state.released, 1, "the refused plan is released rather than left staged");
		state.press("i");
		ok(state.review, "the second press reviews the requirements with it");
		equal(state.applied, 0);
	});

	it("fills the composer from a usable recipe and refuses an unusable one", () => {
		const usable = harness({ initialTab: "skill" });
		usable.options.globalActions?.b?.();
		usable.press("v");
		deepStrictEqual(usable.editor, ["/skill materio-lab "]);
		equal(usable.closed, 1, "using a recipe closes the browser onto the composer");

		const blocked = harness({
			initialTab: "skill",
			inventory: inventory({
				resources: [unowned({ availability: "untrusted", reason: "project imports are not trusted" })],
			}),
		});
		blocked.options.globalActions?.b?.();
		blocked.press("v");
		deepStrictEqual(blocked.editor, []);
		match(blocked.notices.map(([, text]) => text).join(" "), /project imports are not trusted/);
	});

	it("sends a fleet's use to the run approval preview rather than the composer", () => {
		const state = harness({
			initialTab: "fleet",
			inventory: inventory({
				resources: [
					resource({
						key: "fleet:release@plugin:user:materio#fleets/release.yaml",
						kind: "fleet",
						name: "release",
						invocation: "clio-coder fleet run release",
					}),
				],
			}),
		});
		state.options.globalActions?.b?.();
		state.press("v");
		deepStrictEqual(state.fleetRuns, ["release"]);
		deepStrictEqual(state.editor, []);
	});

	it("opens a package's members and leaves them with Esc rather than closing", () => {
		const state = harness({ initialTab: "plugin" });
		state.options.globalActions?.b?.();
		equal(state.options.onBack?.active(), false);
		state.press("\r");
		equal(state.options.onBack?.active(), true);
		deepStrictEqual(
			state.rows("plugin").map((item) => item.id),
			["mem:plugin:materio@user#skill:materio-lab"],
		);
		state.options.onBack?.back();
		equal(state.options.onBack?.active(), false);
		equal(state.closed, 0, "leaving the members never closes the Library");
	});

	it("never routes a plugin row back to its own tab or into a command", () => {
		const state = harness({ initialTab: "plugin" });
		state.press("\r");
		equal(state.closed, 0);
		deepStrictEqual(state.editor, []);
	});

	it("opens on a named reference and arms its review without writing first", () => {
		const state = harness({
			initialTab: "plugin",
			focus: "plugin:materio",
			intent: "remove",
			inventory: inventory({ packages: [record({ copies: [{ scope: "user", state: "loadable" }] })] }),
		});
		deepStrictEqual(state.planned, [{ operation: "remove", ref: "plugin:materio", scope: "user" }]);
		equal(state.applied, 0);
		ok(state.review);
	});

	it("refuses an unknown reference with selection guidance instead of acting", () => {
		const state = harness({ initialTab: "plugin", focus: "plugin:nothing", intent: "remove" });
		deepStrictEqual(state.planned, []);
		equal(state.applied, 0);
		match(state.notices.map(([, text]) => text).join(" "), /not in this category/);
	});

	it("reviews the explicit import source rather than local-agent discovery", () => {
		const state = harness({ initialTab: "plugin", importSource: "/vendor/pack" });
		ok(state.review, "an explicit import source opens its own review");
		equal(state.imports, 0, "nothing is imported before the review is accepted");
		state.review?.accept();
		equal(state.imports, 1);
		match(state.notices.map(([, text]) => text).join(" "), /import \/vendor\/pack: 1 committed/);
	});

	it("releases the staged vendor tree when an import review is cancelled", () => {
		const state = harness({ initialTab: "plugin", importSource: "/vendor/pack" });
		state.review?.cancel();
		equal(state.imports, 0);
		equal(state.importsReleased, 1);
		match(state.notices.map(([, text]) => text).join(" "), /cancelled; nothing was written/);
	});

	it("releases a pending review when the browser closes under it", () => {
		const state = harness({ initialTab: "plugin" });
		state.options.globalActions?.b?.();
		state.press("r");
		ok(state.review);
		state.handle.hide();
		equal(state.released, 1, "closing the browser releases the plan it left open");
		equal(state.applied, 0);
	});

	it("acts on the new category after an arrow key changes it, not the previous one", () => {
		const state = harness({
			initialTab: "plugin",
			inventory: inventory({
				packages: [record()],
				copies: [copy()],
				resources: [resource()],
			}),
		});
		const view = state.mount();
		view.setViewportRows(24);
		match(plain(view.render(120).join("\n")), /materio/);
		equal(view.activeTab()?.id, "plugin");

		// Right wraps from Plugins to Skills. The rows, the status row and the
		// subjects the action keys read must all describe Skills afterwards.
		view.handleInput("\u001b[C");
		equal(view.activeTab()?.id, "skill");
		state.options.globalActions?.b?.();
		const skillRows = state.rows("skill");
		deepStrictEqual(
			skillRows.map((item) => item.id),
			["res:skill:materio-lab@plugin:user:materio#skills/lab/SKILL.md"],
		);
		state.press("v", skillRows[0]?.id, "skill");
		deepStrictEqual(state.editor, ["/skill materio-lab "], "use acts on the skill row, not the plugin it left");

		const after = harness({ initialTab: "plugin" });
		const afterView = after.mount();
		afterView.handleInput("\u001b[C");
		after.options.globalActions?.b?.();
		after.press("r", after.rows("skill")[0]?.id, "skill");
		deepStrictEqual(after.planned, [{ operation: "remove", ref: "plugin:materio", scope: "user" }]);
		match(after.status(120), /Installed/);
	});

	it("advertises only the keys the selected row accepts", () => {
		const available = harness({ initialTab: "plugin" });
		const availableRow = available.rows("plugin")[0];
		const availableHints = (
			available.options.hints as (item?: ListOverlayItem) => ReadonlyArray<{ key: string; verb: string }>
		)(availableRow);
		deepStrictEqual(
			availableHints.map((entry) => entry.key),
			["Enter", "i"],
			"an uninstalled package offers install, never remove",
		);

		const installed = harness({
			initialTab: "plugin",
			inventory: inventory({ packages: [record({ copies: [{ scope: "user", state: "loadable" }] })] }),
		});
		const installedHints = (
			installed.options.hints as (item?: ListOverlayItem) => ReadonlyArray<{ key: string; verb: string }>
		)(installed.rows("plugin")[0]);
		deepStrictEqual(
			installedHints.map((entry) => entry.key),
			["Enter", "e", "u", "r"],
		);
	});

	it("keeps a package name readable at a narrow width and compacts its metadata", () => {
		const state = harness({ initialTab: "plugin" });
		const view = state.mount();
		view.setViewportRows(18);
		const narrow = plain(view.render(48).join("\n"));
		match(narrow, /materio/, "the name survives at 48 columns");
		for (const line of view.render(48)) equal(stripVTControlCharacters(line).length <= 48, true);
	});

	it("draws the Installed empty text in Installed mode and the Browse one in Browse", () => {
		const state = harness({ initialTab: "skill", inventory: inventory({ packages: [], copies: [], resources: [] }) });
		const view = state.mount();
		view.setViewportRows(18);
		match(plain(view.render(100).join("\n")), /No packages of this kind/);
		state.options.globalActions?.b?.();
		const installed = state.mount();
		installed.setViewportRows(18);
		match(plain(installed.render(100).join("\n")), /Nothing of this kind is installed/);
	});

	it("keeps `o` as the separate local-agent discovery route", () => {
		const state = harness();
		state.options.globalActions?.o?.();
		equal(state.imports, 1);
		match(state.notices.map(([, text]) => text).join(" "), /before anything is written/);
	});
});
