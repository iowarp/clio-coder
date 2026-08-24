/**
 * The Skills Hub's kind tabs: the interactive half of the resource library.
 *
 * These pin the four claims the surface makes. Each tab lists the entries of
 * its kind from the same discovery `library list --kind` reads. A row states
 * whether it is installed, what pinned it, and which of its requirements are
 * still missing. An install refuses an entry with an unmet requirement by name,
 * offers to install them with it, and writes nothing until the confirmation
 * accepts. And `use` leads where the kind's own surface is.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
	LibraryDiscoveryResult,
	LibraryEntry,
	LibraryInstallPlan,
	LibraryRequirementStatus,
} from "../../src/domains/resources/index.js";
import { discoverLibrary, libraryEntryRef } from "../../src/domains/resources/index.js";
import { formatLibraryInstallConfirmBody } from "../../src/interactive/overlays/library-install-confirm.js";
import { type ListOverlayItem, ListOverlayView } from "../../src/interactive/overlays/list-overlay.js";
import {
	buildLibraryDiagnosticItems,
	buildLibraryItems,
	isLibraryTab,
	LIBRARY_ROW_PREFIX,
	LIBRARY_TABS,
	libraryRowId,
	libraryUseInvocation,
	runLibraryInstall,
	SKILLS_HUB_TITLE,
} from "../../src/interactive/overlays/skills-hub.js";
import {
	commandReference,
	dispatchSlashCommand,
	parseSlashCommand,
	type SlashCommandContext,
} from "../../src/interactive/slash-commands.js";
import { clioTheme } from "../../src/interactive/theme/index.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const ESC = String.fromCharCode(27);
const stripAnsi = (text: string): string => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
const KEY_LEFT = `${ESC}[D`;
const KEY_RIGHT = `${ESC}[C`;

function entry(overrides: Partial<LibraryEntry> & Pick<LibraryEntry, "kind" | "name">): LibraryEntry {
	return {
		description: `${overrides.name} description`,
		sourceUrl: `/catalog/${overrides.name}.md`,
		origin: "index",
		...overrides,
	} as LibraryEntry;
}

function discovery(entries: LibraryEntry[], diagnostics: string[] = []): LibraryDiscoveryResult {
	return { entries, diagnostics, refusals: {} };
}

/** The classifier's answer for a fixture: everything not in `installed` is unmet. */
function classifier(installed: ReadonlySet<string>) {
	return (target: LibraryEntry, catalog: ReadonlyArray<LibraryEntry>): LibraryRequirementStatus => {
		const ordered = (target.requires ?? []).flatMap((ref) => catalog.filter((item) => libraryEntryRef(item) === ref));
		const satisfied = ordered.filter((item) => installed.has(libraryEntryRef(item)));
		const satisfiedRefs = new Set(satisfied.map(libraryEntryRef));
		return { ordered, satisfied, unsatisfied: ordered.filter((item) => !satisfiedRefs.has(libraryEntryRef(item))) };
	};
}

function planFor(target: LibraryEntry): LibraryInstallPlan {
	return { entry: target, path: `/config/${target.kind}s/${target.name}.md`, sha256: `${target.name}-hash` };
}

function context(entries: LibraryEntry[], installed: ReadonlySet<string> = new Set()) {
	return {
		discovery: discovery(entries),
		installed: (target: LibraryEntry) => installed.has(libraryEntryRef(target)),
		pin: (target: LibraryEntry) =>
			installed.has(libraryEntryRef(target))
				? { sha256: `${target.name}0123456789abcdef`, sourceUrl: target.sourceUrl }
				: undefined,
		unresolved: (target: LibraryEntry) => classifier(installed)(target, entries).unsatisfied,
	};
}

describe("contracts/skills-hub-kinds tabs", () => {
	it("names one tab per library kind in the CLI's kind vocabulary", () => {
		deepStrictEqual(
			LIBRARY_TABS.map((tab) => tab.id),
			["skill", "agent", "prompt", "fleet"],
		);
		deepStrictEqual(
			LIBRARY_TABS.map((tab) => tab.label),
			["Skills", "Agents", "Prompts", "Fleets"],
		);
		ok(isLibraryTab("fleet"));
		ok(!isLibraryTab("fleets"));
	});

	it("switches tabs with the Settings Center's arrow vocabulary and retitles and recounts as it goes", () => {
		const rows = (label: string, count: number): ListOverlayItem[] =>
			Array.from({ length: count }, (_, index) => ({ id: `${label}-${index}`, label: `${label}${index}` }));
		const view = new ListOverlayView(
			{
				title: SKILLS_HUB_TITLE,
				items: [],
				tabs: [
					{ id: "skill", label: "Skills", items: () => rows("skill", 2) },
					{ id: "agent", label: "Agents", items: () => rows("agent", 3) },
					{ id: "prompt", label: "Prompts", items: () => rows("prompt", 1) },
				],
				onClose: () => {},
			},
			() => {},
		);

		strictEqual(view.title(), "Skills Hub · Skills");
		ok(stripAnsi(view.render(100).join("\n")).includes("skill0"));
		// The tab bar states every tab's count, so a reader sees where the rows are
		// before pressing anything.
		const bar = stripAnsi(view.render(100)[0] ?? "");
		ok(bar.includes("Skills 2"), bar);
		ok(bar.includes("Agents 3"), bar);
		ok(bar.includes("Prompts 1"), bar);

		view.handleInput(KEY_RIGHT);
		strictEqual(view.title(), "Skills Hub · Agents");
		strictEqual(view.activeTab()?.id, "agent");
		const agentFrame = stripAnsi(view.render(100).join("\n"));
		ok(agentFrame.includes("agent0"), agentFrame);
		ok(!agentFrame.includes("skill0"), agentFrame);
		// The footer count is the active tab's count, not the overlay's.
		ok(stripAnsi(view.getHint()).includes("3 agents"), view.getHint());

		view.handleInput(KEY_LEFT);
		strictEqual(view.activeTab()?.id, "skill");
		ok(stripAnsi(view.getHint()).includes("2 skills"), view.getHint());

		// The walk wraps, which is what keeps the last tab one key from the first.
		view.handleInput(KEY_LEFT);
		strictEqual(view.activeTab()?.id, "prompt");
	});
});

describe("contracts/skills-hub-kinds rows", () => {
	let home = "";

	beforeEach(async () => {
		home = await newScratchClioHome("clio-hub-kinds-");
	});

	afterEach(() => {
		clearScratchClioHome(home);
		home = "";
	});

	it("lists each kind from the same catalog discovery the CLI reads", () => {
		const catalogDir = path.join(home, "catalog");
		mkdirSync(catalogDir, { recursive: true });
		writeFileSync(path.join(catalogDir, "shipper.md"), "recipe\n", "utf8");
		writeFileSync(path.join(catalogDir, "review.md"), "prompt\n", "utf8");
		writeFileSync(path.join(catalogDir, "release.md"), "contract\n", "utf8");
		const catalog = path.join(catalogDir, "library.yaml");
		writeFileSync(
			catalog,
			[
				"skills:",
				"  - kind: agent",
				"    name: shipper",
				"    description: Ships a release.",
				"    sourceUrl: ./shipper.md",
				"  - kind: prompt",
				"    name: review",
				"    description: Reviews a diff.",
				"    sourceUrl: ./review.md",
				"  - kind: fleet",
				"    name: release",
				"    description: Builds a release.",
				"    sourceUrl: ./release.md",
				"",
			].join("\n"),
			"utf8",
		);

		const found = discoverLibrary({ catalog, marketplace: { indexPath: null, catalogDir: null } });
		const shared = {
			discovery: found,
			installed: () => false,
			pin: () => undefined,
			unresolved: () => [],
		};

		deepStrictEqual(
			buildLibraryItems("agent", shared).map((item) => item.label),
			["shipper"],
		);
		deepStrictEqual(
			buildLibraryItems("prompt", shared).map((item) => item.label),
			["review"],
		);
		deepStrictEqual(
			buildLibraryItems("fleet", shared).map((item) => item.label),
			["release"],
		);
		// A row's id carries its typed reference, which is what every action
		// resolves the entry back through.
		strictEqual(buildLibraryItems("fleet", shared)[0]?.id, `${LIBRARY_ROW_PREFIX}fleet:release`);
	});

	it("names unresolved requirements in the requires column and marks installed rows", () => {
		const entries = [
			entry({ kind: "agent", name: "builder" }),
			entry({ kind: "skill", name: "ship" }),
			entry({ kind: "fleet", name: "release", requires: ["agent:builder", "skill:ship"] }),
		];
		const items = buildLibraryItems("fleet", context(entries, new Set(["agent:builder"])));
		const meta = items[0]?.meta ?? "";

		ok(stripAnsi(meta).includes("requires skill:ship"), stripAnsi(meta));
		ok(!stripAnsi(meta).includes("agent:builder"), "a satisfied requirement is not unresolved");
		ok(meta.includes(clioTheme().fgSequence("warning")), "the requires column renders in the warning token");
		strictEqual(items[0]?.group, "Available");
		ok(stripAnsi(meta).includes("available"), stripAnsi(meta));
		ok(stripAnsi(meta).includes("unpinned"), stripAnsi(meta));

		const installedRow = buildLibraryItems("agent", context(entries, new Set(["agent:builder"])))[0];
		strictEqual(installedRow?.group, "Installed");
		ok(stripAnsi(installedRow?.meta ?? "").includes("installed"), installedRow?.meta);
		ok(stripAnsi(installedRow?.meta ?? "").includes("pin builder0"), installedRow?.meta);
	});

	it("keeps a refused catalog entry visible as a diagnostic row", () => {
		const items = buildLibraryDiagnosticItems(discovery([], ["library_requirement_missing: agent:ghost"]));
		strictEqual(items.length, 1);
		strictEqual(items[0]?.group, "Diagnostics");
		ok(stripAnsi(items[0]?.label ?? "").includes("library_requirement_missing: agent:ghost"), items[0]?.label);
	});
});

describe("contracts/skills-hub-kinds install", () => {
	const entries = [
		entry({ kind: "agent", name: "builder" }),
		entry({ kind: "fleet", name: "release", requires: ["agent:builder"] }),
	];
	const release = entries[1] as LibraryEntry;

	function runner(installed: ReadonlySet<string>, confirm: (subject: unknown) => Promise<boolean>, writes: string[]) {
		return {
			discovery: discovery(entries),
			classify: classifier(installed),
			plan: planFor,
			write: (plan: LibraryInstallPlan) => {
				writes.push(libraryEntryRef(plan.entry));
			},
			installed: (target: LibraryEntry) => installed.has(libraryEntryRef(target)),
			confirm: confirm as never,
		};
	}

	it("refuses an entry with an unmet requirement by name and plans nothing", async () => {
		const writes: string[] = [];
		let confirmed = false;
		const outcome = await runLibraryInstall(
			release,
			runner(
				new Set(),
				async () => {
					confirmed = true;
					return true;
				},
				writes,
			),
			{ withRequirements: false },
		);

		deepStrictEqual(outcome, { status: "refused", unresolved: ["agent:builder"] });
		strictEqual(confirmed, false, "a refusal never reaches the confirmation");
		deepStrictEqual(writes, []);
	});

	it("installs the requirements before the entry when the second confirmation accepts", async () => {
		const writes: string[] = [];
		let named: string[] = [];
		const outcome = await runLibraryInstall(
			release,
			runner(
				new Set(),
				async (subject) => {
					named = (subject as { writes: { ref: string }[] }).writes.map((write) => write.ref);
					return true;
				},
				writes,
			),
			{ withRequirements: true },
		);

		// The confirmation names every entry it would write, in dependency order.
		deepStrictEqual(named, ["agent:builder", "fleet:release"]);
		deepStrictEqual(writes, ["agent:builder", "fleet:release"]);
		deepStrictEqual(outcome, { status: "installed", refs: ["agent:builder", "fleet:release"] });
	});

	it("writes nothing when the confirmation is declined", async () => {
		const writes: string[] = [];
		const outcome = await runLibraryInstall(
			release,
			runner(new Set(["agent:builder"]), async () => false, writes),
			{
				withRequirements: false,
			},
		);

		deepStrictEqual(outcome, { status: "cancelled" });
		deepStrictEqual(writes, [], "a declined confirmation leaves the destination untouched");
	});

	it("writes exactly the confirmed plan when it is accepted", async () => {
		const writes: string[] = [];
		const outcome = await runLibraryInstall(
			release,
			runner(new Set(["agent:builder"]), async () => true, writes),
			{
				withRequirements: false,
			},
		);

		deepStrictEqual(outcome, { status: "installed", refs: ["fleet:release"] });
		deepStrictEqual(writes, ["fleet:release"]);
	});

	it("declines to reinstall an entry that is already on disk", async () => {
		const writes: string[] = [];
		const outcome = await runLibraryInstall(
			release,
			runner(new Set(["fleet:release"]), async () => true, writes),
			{
				withRequirements: false,
			},
		);
		deepStrictEqual(outcome, { status: "already-installed" });
		deepStrictEqual(writes, []);
	});

	it("states every destination and hash in the confirmation body", () => {
		const body = stripAnsi(
			formatLibraryInstallConfirmBody(
				{
					entryRef: "fleet:release",
					writes: [
						{ ref: "agent:builder", path: "/config/agents/builder.md", sha256: "builder-hash" },
						{ ref: "fleet:release", path: "/config/fleets/release.md", sha256: "release-hash" },
					],
					requirements: ["agent:builder"],
					satisfied: [],
				},
				100,
			).join("\n"),
		);

		ok(body.includes("install fleet:release with its requirements: agent:builder"), body);
		ok(body.includes("/config/agents/builder.md"), body);
		ok(body.includes("sha256 release-hash"), body);
		ok(body.includes("Esc writes nothing"), body);
	});
});

describe("contracts/skills-hub-kinds use", () => {
	it("routes each kind's use to the surface that kind is invoked from", () => {
		strictEqual(libraryUseInvocation({ kind: "agent", name: "builder" }), "/run builder ");
		strictEqual(libraryUseInvocation({ kind: "prompt", name: "review" }), "/review ");
		strictEqual(libraryUseInvocation({ kind: "skill", name: "ship" }), "/skill ship ");
		// A fleet has no composer spelling: its use opens the approval preview.
		strictEqual(libraryUseInvocation({ kind: "fleet", name: "release" }), null);
	});

	it("carries the row id an action resolves the entry back through", () => {
		strictEqual(libraryRowId({ kind: "prompt", name: "review" }), "library:prompt:review");
	});
});

describe("contracts/skills-hub-kinds /library", () => {
	function ctx(opened: string[]): SlashCommandContext {
		return {
			openSkillsHub: (tab?: string) => opened.push(tab ? `library:${tab}` : "library"),
			notice: (_level: string, text: string) => opened.push(`notice:${text}`),
			io: { stdout: () => undefined, stderr: () => undefined },
			render: () => undefined,
		} as unknown as SlashCommandContext;
	}

	it("opens the hub on the named kind and on Skills when the kind is omitted", () => {
		deepStrictEqual(parseSlashCommand("/library"), { kind: "library" });
		deepStrictEqual(parseSlashCommand("/library fleet"), { kind: "library", tab: "fleet" });

		const opened: string[] = [];
		dispatchSlashCommand(parseSlashCommand("/library"), ctx(opened));
		dispatchSlashCommand(parseSlashCommand("/library agent"), ctx(opened));
		deepStrictEqual(opened, ["library", "library:agent"]);
	});

	it("reports an unknown kind through the usage path rather than sending it to the model", () => {
		const parsed = parseSlashCommand("/library agents");
		deepStrictEqual(parsed, {
			kind: "usage-error",
			command: "library",
			reason: "Unknown kind: agents (one of skill, agent, prompt, fleet)",
		});

		const opened: string[] = [];
		dispatchSlashCommand(parsed, ctx(opened));
		ok(
			opened.some((event) => event.startsWith("notice:") && event.includes("/library [kind]")),
			opened.join(" | "),
		);
		ok(!opened.includes("library"), "a usage error never opens the hub");
	});

	it("is registered in the declarative command reference", () => {
		const reference = commandReference().find((command) => command.name === "library");
		strictEqual(reference?.usage, "/library [kind]");
		strictEqual(reference?.group, "Run");
	});
});
