import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";
import { runLibraryCommand } from "../../src/cli/library.js";
import { runPluginsCommand } from "../../src/cli/plugins.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	type PluginCatalogEntry,
	parsePluginGithubSource,
	readPluginCatalog,
} from "../../src/domains/plugins/catalog.js";
import { listInstalledPlugins, pluginContentDigest } from "../../src/domains/plugins/index.js";
import {
	classifyLibraryRequirements,
	discoverLibrary,
	installLibraryPlan,
	type LibraryEntry,
	libraryEntryDrift,
	libraryEntryInstalled,
	libraryEntryPin,
	libraryInstallPath,
	pinLibraryEntry,
	planLibraryInstall,
	planPluginUpdate,
	releaseLibraryPlan,
	removeLibraryEntry,
	resolveLibraryPlugin,
	resolveLibraryRequirements,
} from "../../src/domains/resources/library.js";
import { discoverMarketplaceSkills } from "../../src/domains/resources/skills/marketplace.js";
import { LIBRARY_TABS } from "../../src/interactive/overlays/library-tabs.js";
import { runPluginLibraryAction } from "../../src/interactive/overlays/plugin-actions.js";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import { parseSlashCommand } from "../../src/interactive/slash-commands.js";

let root: string;
let previousConfig: string | undefined;
let previousCwd: string;
function bundle(name = "fixture", version = "1.0.0"): string {
	const location = path.join(root, "sources", name);
	mkdirSync(path.join(location, "assets"), { recursive: true });
	writeFileSync(
		path.join(location, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name,
			version,
			description: "Library integrity fixture",
		}),
	);
	writeFileSync(path.join(location, "assets", "evidence.txt"), `evidence ${version}`);
	return location;
}
function entry(source: string, overrides: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
	const manifest = JSON.parse(readFileSync(path.join(source, "plugin.json"), "utf8"));
	return {
		kind: "plugin",
		name: manifest.name,
		version: manifest.version,
		description: manifest.description,
		sourceUrl: source,
		sha256: pluginContentDigest(source),
		origin: "catalog",
		...overrides,
	};
}
function catalog(items: LibraryEntry[]): string {
	const file = path.join(root, "config", "library.yaml");
	writeFileSync(file, stringify({ entries: items }));
	return file;
}
async function captureCli(args: string[], command = runPluginsCommand): Promise<{ code: number; output: string }> {
	let output = "";
	const original = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output += String(chunk);
		return true;
	}) as typeof original;
	try {
		return { code: await command([...args, "--json"]), output };
	} finally {
		process.stdout.write = original;
	}
}

describe("plugin library lifecycle", () => {
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "clio-plugin-library-"));
		previousConfig = process.env.CLIO_CODER_CONFIG_DIR;
		previousCwd = process.cwd();
		process.env.CLIO_CODER_CONFIG_DIR = path.join(root, "config");
		mkdirSync(path.join(root, "config"));
		process.chdir(root);
		resetXdgCache();
	});
	afterEach(() => {
		process.chdir(previousCwd);
		if (previousConfig === undefined) delete process.env.CLIO_CODER_CONFIG_DIR;
		else process.env.CLIO_CODER_CONFIG_DIR = previousConfig;
		resetXdgCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("verifies assets as well as the manifest and refuses post-plan source changes", () => {
		const source = bundle();
		const plan = planLibraryInstall(entry(source));
		writeFileSync(path.join(source, "assets", "evidence.txt"), "changed after review");
		throws(() => installLibraryPlan(plan), /digest|pin|changed/i);
		equal(existsSync(plan.path), false);
		equal(libraryEntryInstalled(plan.entry), false);
	});

	it("force cannot bypass a catalog pin and a catalog cannot substitute bundle identity", () => {
		const source = bundle();
		throws(() => planLibraryInstall(entry(source, { sha256: "0".repeat(64) }), { force: true }), /plugin_pin_mismatch/);
		throws(() => planLibraryInstall(entry(source, { name: "another" })), /identity mismatch/);
		throws(() => planLibraryInstall(entry(source, { version: "2.0.0" })), /version mismatch/);
	});

	it("uses local directories before identically named catalog IDs", () => {
		const source = bundle();
		catalog([entry(source, { description: "catalog row" })]);
		mkdirSync(path.join(root, "fixture"));
		writeFileSync(
			path.join(root, "fixture", "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "local-choice",
				version: "1.0.0",
			}),
		);
		equal(resolveLibraryPlugin("fixture").name, "local-choice");
		equal(resolveLibraryPlugin("plugin:fixture").name, "fixture");
	});

	it("keeps plugin entries out of the skill marketplace", () => {
		const source = bundle();
		const index = path.join(root, "skills.json");
		writeFileSync(index, JSON.stringify({ skills: [entry(source)] }));
		const result = discoverMarketplaceSkills({ catalogDir: null, indexPath: index });
		equal(result.skills.length, 0);
		ok(result.diagnostics.some((diagnostic) => diagnostic.includes("unsupported kind")));
		catalog([entry(source)]);
		ok(
			discoverLibrary({ marketplace: { indexPath: null, catalogDir: null } }).entries.some(
				(item) => item.kind === "plugin" && item.name === "fixture",
			),
		);
	});

	it("does not mistake a stale pin for an installed resource", () => {
		writeFileSync(
			path.join(root, "config", "library-pins.yaml"),
			stringify({ "prompt:gone": { sha256: "0".repeat(64), sourceUrl: "/missing" } }),
		);
		equal(libraryEntryInstalled({ kind: "prompt", name: "gone" }), false);
		throws(() => libraryInstallPath({ kind: "prompt", name: "../outside" }), /invalid library entry name/);
	});

	it("records scoped pins, reports drift, refuses repinning drift, and removes the selected scope", () => {
		const source = bundle();
		const item = entry(source);
		installLibraryPlan(planLibraryInstall(item));
		installLibraryPlan(planLibraryInstall(item, { scope: "project" }));
		const userPin = libraryEntryPin(item, { scope: "user" });
		ok(userPin);
		equal(libraryEntryDrift(item, { scope: "project" }).status, "clean");
		const projectPath = libraryInstallPath(item, { scope: "project" });
		writeFileSync(path.join(projectPath, "assets", "evidence.txt"), "local changes");
		equal(libraryEntryDrift(item, { scope: "project" }).status, "changed");
		equal(libraryEntryDrift(item, { scope: "user" }).status, "clean");
		throws(() => pinLibraryEntry(item, { scope: "project" }), /plugin_local_changes/);
		removeLibraryEntry(item, { scope: "project" });
		equal(existsSync(projectPath), false);
		equal(libraryEntryInstalled(item, { scope: "project" }), false);
		equal(libraryEntryInstalled(item, { scope: "user" }), true);
		deepStrictEqual(libraryEntryPin(item, { scope: "user" }), userPin);
	});

	it("updates a local origin to a new version and refuses destination changes after review", () => {
		const source = bundle();
		installLibraryPlan(planLibraryInstall(resolveLibraryPlugin(source)));
		bundle("fixture", "2.0.0");
		const plan = planPluginUpdate("fixture");
		installLibraryPlan(plan);
		equal(listInstalledPlugins(root)[0]?.version, "2.0.0");
		bundle("fixture", "3.0.0");
		const changed = planPluginUpdate("fixture");
		writeFileSync(path.join(changed.path, "assets", "evidence.txt"), "edit during review");
		throws(() => installLibraryPlan(changed), /plugin_destination_changed/);
		equal(listInstalledPlugins(root)[0]?.version, "2.0.0");
	});

	it("updates from the latest catalog pin and refuses a changed upstream even with force", () => {
		const source = bundle();
		catalog([entry(source)]);
		installLibraryPlan(planLibraryInstall(resolveLibraryPlugin("fixture")));
		bundle("fixture", "2.0.0");
		catalog([entry(source)]);
		installLibraryPlan(planPluginUpdate("fixture"));
		equal(listInstalledPlugins(root)[0]?.version, "2.0.0");
		writeFileSync(path.join(source, "assets", "evidence.txt"), "unpinned upstream");
		throws(() => planPluginUpdate("fixture", { force: true }), /plugin_pin_mismatch/);
	});

	it("CLI and interactive actions share install, toggle, pin, drift, cancellation and removal behavior", async () => {
		const source = bundle();
		const installed = await captureCli(["install", source]);
		equal(installed.code, 0, installed.output);
		const item = entry(source);
		match(await runPluginLibraryAction(item, "toggle", async () => true), /disabled/);
		equal(listInstalledPlugins(root)[0]?.enabled, false);
		equal((await captureCli(["enable", "fixture"])).code, 0);
		match(await runPluginLibraryAction(item, "pin", async () => true), /pinned [a-f0-9]{64}/);
		match(await runPluginLibraryAction(item, "drift", async () => true), /clean/);
		match(await runPluginLibraryAction(item, "remove", async () => false), /cancelled/);
		equal(libraryEntryInstalled(item), true);
		match(
			await runPluginLibraryAction(item, "remove", async (subject) => {
				equal(subject.action, "remove");
				equal(subject.writes[0]?.path, libraryInstallPath(item));
				return true;
			}),
			/removed/,
		);
		equal(libraryEntryInstalled(item), false);
		ok(LIBRARY_TABS.some((tab) => tab.id === "plugin"));
	});

	it("only advertises supported, pinned remote sources and rejects traversal", () => {
		const file = path.join(root, "registry.yaml");
		const item = entry(bundle(), { sourceUrl: "https://github.com/example/repo/tree/v1/plugins/fixture" });
		writeFileSync(
			file,
			stringify({
				plugins: [
					item,
					{ ...item, name: "unsupported", sourceUrl: "https://other.example/plugin.zip" },
					{ ...item, name: "unpinned", sha256: undefined },
				],
			}),
		);
		const diagnostics: string[] = [];
		const found = readPluginCatalog(file, diagnostics);
		equal(found.length, 1);
		equal(diagnostics.length, 2);
		ok(parsePluginGithubSource(item.sourceUrl));
		equal(parsePluginGithubSource("https://github.com/example/repo/tree/main/../../outside"), undefined);
		throws(() => resolveLibraryPlugin(item.sourceUrl), /requires a catalog entry/);
	});

	it("previews catalog installs in the CLI and commits only after the explicit yes flag", async () => {
		const item = entry(bundle());
		catalog([item]);
		const preview = await captureCli(["add", "plugin:fixture"], runLibraryCommand);
		equal(preview.code, 0, preview.output);
		equal(JSON.parse(preview.output).confirmed, false);
		equal(libraryEntryInstalled(item), false);
		const applied = await captureCli(["add", "plugin:fixture", "--yes"], runLibraryCommand);
		equal(applied.code, 0, applied.output);
		equal(libraryEntryInstalled(item), true);
	});

	it("fetches remote bundle directories using a vector and cleans the staged source", () => {
		const source = bundle();
		const tools = path.join(root, "bin");
		mkdirSync(tools);
		const argsFile = path.join(root, "git-args.json");
		writeFileSync(
			path.join(tools, "git"),
			`#!${process.execPath}\nconst fs=require('node:fs');const p=require('node:path');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(args));fs.cpSync(${JSON.stringify(source)},p.join(args.at(-1),'plugins','fixture'),{recursive:true});\n`,
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
		try {
			const plan = planLibraryInstall(
				entry(source, { sourceUrl: "https://github.com/example/repo/tree/v1/plugins/fixture" }),
			);
			ok(plan.sourceRoot);
			const staged = plan.sourceRoot;
			const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
			deepStrictEqual(args.slice(0, -1), [
				"-c",
				"core.hooksPath=/dev/null",
				"clone",
				"--depth",
				"1",
				"--branch",
				"v1",
				"--",
				"https://github.com/example/repo.git",
			]);
			installLibraryPlan(plan);
			equal(existsSync(staged), false);
			equal(libraryEntryPin(plan.entry)?.sourceUrl, "https://github.com/example/repo/tree/v1/plugins/fixture");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("reports the recovery path when an explicit forced update preserves edited content", async () => {
		const source = bundle();
		equal((await captureCli(["install", source])).code, 0);
		const installed = libraryInstallPath(entry(source));
		writeFileSync(path.join(installed, "assets", "evidence.txt"), "preserve this edit");
		bundle("fixture", "2.0.0");
		equal((await captureCli(["update", "fixture"])).code, 1);
		const result = await captureCli(["update", "fixture", "--force"]);
		equal(result.code, 0, result.output);
		const backup = JSON.parse(result.output).recovery?.packageBackup as string;
		ok(backup);
		equal(readFileSync(path.join(backup, "assets", "evidence.txt"), "utf8"), "preserve this edit");
	});

	it("routes the plugin tab and reload command through the resources slash surface", () => {
		deepStrictEqual(parseSlashCommand("/resources plugins"), { kind: "resources", family: "plugins" });
		deepStrictEqual(parseSlashCommand("/resources library plugin"), { kind: "resources", tab: "plugin" });
		deepStrictEqual(parseSlashCommand("/resources plugins reload"), {
			kind: "resources",
			family: "plugins",
			action: "reload",
		});
		equal(parseSlashCommand("/resources plugins unsupported").kind, "usage-error");
	});

	it("completes plugin browsing and reload through the ordinary slash grammar", async () => {
		const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
		for (const [line, expected] of [
			["/resources library pl", "plugin"],
			["/resources pl", "plugins"],
			["/resources plugins re", "reload"],
		]) {
			ok(line);
			ok(expected);
			const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
			ok(
				suggestions?.items.some((item) => item.value === expected),
				`${line} should complete ${expected}`,
			);
		}
	});

	it("preserves a local fork's source and disabled state across updates", async () => {
		const local = bundle();
		equal((await captureCli(["install", local])).code, 0);
		equal((await captureCli(["disable", "fixture"])).code, 0);
		const upstream = bundle("upstream", "3.0.0");
		writeFileSync(
			path.join(upstream, "plugin.json"),
			JSON.stringify({
				$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
				name: "fixture",
				version: "3.0.0",
			}),
		);
		catalog([entry(upstream)]);
		bundle("fixture", "2.0.0");
		const plan = planPluginUpdate("fixture");
		equal(plan.entry.sourceUrl, local);
		installLibraryPlan(plan);
		const installed = listInstalledPlugins(root)[0];
		equal(installed?.version, "2.0.0");
		equal(installed?.enabled, false);
	});

	it("retains dedicated plugin catalog requirements and checks their dependency graph", () => {
		const item = entry(bundle(), { requires: ["plugin:missing"] });
		const file = path.join(root, "plugins.yaml");
		writeFileSync(file, stringify({ plugins: [item] }));
		const diagnostics: string[] = [];
		const rows = readPluginCatalog(file, diagnostics);
		deepStrictEqual(rows[0]?.requires, ["plugin:missing"]);
		equal(diagnostics.length, 0);
		const loaded = rows[0];
		ok(loaded);
		throws(() => resolveLibraryRequirements(loaded, rows), /library_requirement_missing/);
		const cyclic = { ...loaded, requires: ["plugin:fixture" as const] };
		throws(() => resolveLibraryRequirements(cyclic, [cyclic]), /library_requirement_cycle/);
	});

	it("refuses unavailable plugin requirements without reactivating installed dependencies", async () => {
		const dependency = entry(bundle());
		const consumer = entry(bundle("consumer"), { requires: ["plugin:fixture"] });
		catalog([dependency, consumer]);
		equal((await captureCli(["install", "fixture"])).code, 0);
		equal((await captureCli(["disable", "fixture"])).code, 0);
		const status = classifyLibraryRequirements(consumer, [dependency, consumer]);
		deepStrictEqual(status.satisfied, []);
		deepStrictEqual(
			status.inactive?.map((item) => item.name),
			["fixture"],
		);
		const add = await captureCli(["add", "plugin:consumer", "--with-requirements", "--yes"], runLibraryCommand);
		equal(add.code, 1);
		match(add.output, /library_requirement_inactive/);
		equal((await captureCli(["install", "consumer"])).code, 1);
		equal(listInstalledPlugins(root)[0]?.enabled, false);
		equal(libraryEntryInstalled(consumer), false);
	});

	it("removes a plugin independently of legacy pins and reports retained edited files", async () => {
		const item = entry(bundle());
		installLibraryPlan(planLibraryInstall(item));
		const installed = libraryInstallPath(item);
		writeFileSync(path.join(installed, "assets", "evidence.txt"), "edited content");
		const legacyPins = path.join(root, "config", "library-pins.yaml");
		writeFileSync(legacyPins, "[malformed yaml");
		const removed = await captureCli(["remove", "fixture"]);
		equal(removed.code, 0, removed.output);
		const backup = JSON.parse(removed.output).recovery?.packageBackup as string;
		ok(backup);
		equal(readFileSync(path.join(backup, "assets", "evidence.txt"), "utf8"), "edited content");
		equal(readFileSync(legacyPins, "utf8"), "[malformed yaml");
		equal(libraryEntryInstalled(item), false);
	});

	it("releases cancelled staging plans without modifying installation state", () => {
		const item = entry(bundle());
		const plan = planLibraryInstall(item);
		let released = false;
		plan.cleanup = () => {
			released = true;
		};
		releaseLibraryPlan(plan);
		equal(released, true);
		equal(libraryEntryInstalled(item), false);
	});
});
