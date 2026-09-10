import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import { extensionContentDigest } from "../../src/domains/extensions/integrity.js";
import {
	clearPluginSnapshots,
	disablePlugin,
	enabledPluginResourceRoots,
	enablePlugin,
	installPlugin,
	listInstalledPlugins,
	PLUGIN_SCHEMA,
	pluginBaseDir,
	pluginContentDigest,
	pluginStatePath,
	readPluginManifest,
	reloadPluginResources,
	removePlugin,
	updatePlugin,
} from "../../src/domains/plugins/index.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let project: string;
const roots: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-plugin-contract-"));
	roots.push(dir);
	return dir;
}

function fixture(name = "research-kit"): string {
	const root = scratch();
	mkdirSync(join(root, "skills", "research"), { recursive: true });
	writeFileSync(
		join(root, "skills", "research", "SKILL.md"),
		"---\nname: research\ndescription: Research fixture\n---\nRead supplied papers.\n",
	);
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version: "1.0.0", description: "Research fixture" }),
	);
	return root;
}

function rewriteManifest(root: string, modify: (manifest: Record<string, unknown>) => void): void {
	const file = join(root, "plugin.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	modify(manifest);
	writeFileSync(file, JSON.stringify(manifest));
}

describe("agent plugin engine", () => {
	beforeEach(async () => {
		env = await isolateClioEnv();
		project = scratch();
	});
	afterEach(() => {
		clearPluginSnapshots();
		env.restore();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("loads a portable skills-only package without inventing native declarations", () => {
		const root = fixture();
		const candidate = readPluginManifest(root);
		strictEqual(candidate.valid, true);
		deepStrictEqual(candidate.manifest?.clio.resources, { skills: "skills" });
		strictEqual(candidate.contentDigest, extensionContentDigest(root));
		const result = installPlugin(root, { cwd: project });
		strictEqual(result.plugin?.loadable, true);
		strictEqual(enabledPluginResourceRoots("skills", project)[0]?.source, "plugin:user:research-kit");
		strictEqual(existsSync(join(env.dir, "config", "extensions", "state.json")), false);
	});

	it("rejects missing, duplicate and cyclic component references", () => {
		for (const inventory of [
			[{ kind: "skill", id: "research", path: "skills/research/SKILL.md", requires: ["resource:absent"] }],
			[{ kind: "skill", id: "research", path: "skills/research/SKILL.md", requires: ["skill:research"] }],
			[
				{ kind: "skill", id: "research", path: "skills/research/SKILL.md" },
				{ kind: "skill", id: "research", path: "skills/research/SKILL.md" },
			],
		]) {
			const root = fixture();
			rewriteManifest(root, (manifest) => {
				manifest.extensions = { "ai.iowarp.clio": { manifestVersion: 1, components: inventory } };
			});
			strictEqual(readPluginManifest(root).valid, false);
			strictEqual(installPlugin(root, { cwd: project }).plugin, undefined);
		}
	});

	it("loads native resources into the namespaced project installation", () => {
		const root = fixture();
		mkdirSync(join(root, "ai.iowarp.clio", "prompts"), { recursive: true });
		writeFileSync(join(root, "ai.iowarp.clio", "prompts", "review.md"), "Review the evidence.\n");
		rewriteManifest(root, (manifest) => {
			manifest.extensions = {
				"ai.iowarp.clio": {
					manifestVersion: 1,
					resources: { prompts: "ai.iowarp.clio/prompts" },
					components: [{ kind: "prompt", id: "review", path: "ai.iowarp.clio/prompts/review.md" }],
				},
			};
		});
		const installed = installPlugin(root, { cwd: project, scope: "project" }).plugin;
		ok(installed);
		strictEqual(installed?.loadable, true);
		strictEqual(installed?.rootPath, join(project, ".clio-coder", "plugins", "research-kit"));
		strictEqual(
			enabledPluginResourceRoots("prompts", project)[0]?.path,
			join(installed.rootPath, "ai.iowarp.clio", "prompts"),
		);
	});

	it("covers siblings, empty directories and contained links in full-tree pins", () => {
		const root = fixture();
		const original = pluginContentDigest(root);
		mkdirSync(join(root, "assets"));
		const empty = pluginContentDigest(root);
		notStrictEqual(empty, original);
		writeFileSync(join(root, "assets", "paper.txt"), "First evidence.");
		const content = pluginContentDigest(root);
		notStrictEqual(content, empty);
		symlinkSync("paper.txt", join(root, "assets", "paper-link.txt"));
		strictEqual(readPluginManifest(root).valid, true);
		notStrictEqual(pluginContentDigest(root), content);
		strictEqual(installPlugin(root, { cwd: project, expectedDigest: original, force: true }).plugin, undefined);
		strictEqual(existsSync(pluginBaseDir("user", project)), false);
	});

	it("refuses escaping links, hard links, reserved state, and source overlap", () => {
		const external = scratch();
		writeFileSync(join(external, "data"), "external");
		for (const mutate of [
			(root: string) => symlinkSync(join(external, "data"), join(root, "outside")),
			(root: string) => linkSync(join(external, "data"), join(root, "hard-link")),
			(root: string) => writeFileSync(join(root, "state.json"), "{}"),
		]) {
			const root = fixture();
			mutate(root);
			strictEqual(installPlugin(root, { cwd: project }).plugin, undefined);
		}
		const root = fixture();
		const installed = installPlugin(root, { cwd: project }).plugin;
		ok(installed);
		strictEqual(installPlugin(installed.rootPath, { cwd: project, force: true }).plugin, undefined);
		strictEqual(listInstalledPlugins(project)[0]?.loadable, true);
	});

	it("keeps a previous install and state untouched when a planned pin no longer matches", () => {
		const root = fixture();
		const initial = installPlugin(root, { cwd: project });
		ok(initial.plugin);
		const stateBefore = readFileSync(pluginStatePath("user", project), "utf8");
		const expected = pluginContentDigest(root);
		writeFileSync(join(root, "skills", "research", "extra.txt"), "Changed after plan.");
		strictEqual(installPlugin(root, { cwd: project, force: true, expectedDigest: expected }).plugin, undefined);
		strictEqual(readFileSync(pluginStatePath("user", project), "utf8"), stateBefore);
		strictEqual(pluginContentDigest(initial.plugin.rootPath), expected);
	});

	it("refuses staged-source races and restores the prior package after publication failure", () => {
		const root = fixture();
		const initial = installPlugin(root, { cwd: project });
		ok(initial.plugin);
		const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
		const originalCopy = fs.cpSync;
		try {
			fs.cpSync = ((source, destination, options) => {
				originalCopy(source, destination, options);
				writeFileSync(join(String(destination), "race.txt"), "changed while copying");
			}) as typeof cpSync;
			syncBuiltinESMExports();
			strictEqual(installPlugin(root, { cwd: project, force: true }).plugin, undefined);
			strictEqual(listInstalledPlugins(project)[0]?.loadable, true);
		} finally {
			fs.cpSync = originalCopy;
			syncBuiltinESMExports();
		}
		const originalRename = fs.renameSync;
		try {
			fs.renameSync = ((from, to) => {
				if (String(to) === pluginStatePath("user", project)) throw new Error("injected state publication failure");
				originalRename(from, to);
			}) as typeof fs.renameSync;
			syncBuiltinESMExports();
			writeFileSync(join(root, "new.txt"), "New version.");
			strictEqual(installPlugin(root, { cwd: project, force: true }).plugin, undefined);
			strictEqual(pluginContentDigest(initial.plugin.rootPath), initial.plugin.provenance?.contentDigest);
			strictEqual(listInstalledPlugins(project)[0]?.loadable, true);
		} finally {
			fs.renameSync = originalRename;
			syncBuiltinESMExports();
		}
	});

	it("suppresses a user copy when a valid project copy is disabled", () => {
		const root = fixture();
		installPlugin(root, { cwd: project, scope: "user" });
		installPlugin(root, { cwd: project, scope: "project" });
		strictEqual(listInstalledPlugins(project).find((entry) => entry.effective)?.scope, "project");
		disablePlugin("research-kit", { cwd: project, scope: "project" });
		deepStrictEqual(enabledPluginResourceRoots("skills", project), []);
		enablePlugin("research-kit", { cwd: project, scope: "project" });
		strictEqual(enabledPluginResourceRoots("skills", project)[0]?.scope, "project");
	});

	it("preserves edits made to an installed copy while its replacement is staged", () => {
		const root = fixture();
		const initial = installPlugin(root, { cwd: project }).plugin;
		ok(initial);
		const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
		const originalCopy = fs.cpSync;
		try {
			fs.cpSync = ((source, destination, options) => {
				originalCopy(source, destination, options);
				writeFileSync(join(initial.rootPath, "concurrent-notes.txt"), "operator edit during staging");
			}) as typeof cpSync;
			syncBuiltinESMExports();
			const result = installPlugin(root, { cwd: project, force: true });
			ok(result.plugin?.loadable);
			ok(result.recovery?.packageBackup);
			strictEqual(
				readFileSync(join(result.recovery.packageBackup, "concurrent-notes.txt"), "utf8"),
				"operator edit during staging",
			);
		} finally {
			fs.cpSync = originalCopy;
			syncBuiltinESMExports();
		}
	});

	it("revokes drifted resources even while an earlier snapshot remains committed", () => {
		const root = fixture();
		const installed = installPlugin(root, { cwd: project }).plugin;
		ok(installed);
		const snapshot = reloadPluginResources(project);
		ok(snapshot.generation > 0);
		writeFileSync(join(installed.rootPath, "skills", "research", "SKILL.md"), "tampered");
		deepStrictEqual(enabledPluginResourceRoots("skills", project), []);
		strictEqual(enablePlugin("research-kit", { cwd: project }).plugin, undefined);
		ok(listInstalledPlugins(project)[0]?.diagnostics.some((entry) => entry.message.includes("drift")));
	});

	it("updates from durable local origin and preserves changed files during removal", () => {
		const root = fixture();
		installPlugin(root, { cwd: project });
		rewriteManifest(root, (manifest) => {
			manifest.version = "1.1.0";
		});
		strictEqual(updatePlugin("research-kit", { cwd: project }).plugin?.version, "1.1.0");
		const installed = listInstalledPlugins(project)[0];
		ok(installed);
		writeFileSync(join(installed.rootPath, "notes.txt"), "operator edits");
		const removed = removePlugin("research-kit", { cwd: project });
		ok(removed.removed);
		ok(removed.recovery?.packageBackup);
		strictEqual(readFileSync(join(removed.recovery.packageBackup, "notes.txt"), "utf8"), "operator edits");
		deepStrictEqual(listInstalledPlugins(project), []);
	});

	it("rejects redirected managed directories and incompatible packages before publication", () => {
		const root = fixture();
		rewriteManifest(root, (manifest) => {
			manifest.extensions = { "ai.iowarp.clio": { manifestVersion: 1, compatibility: { clio: ">=999.0.0" } } };
		});
		strictEqual(installPlugin(root, { cwd: project }).plugin, undefined);
		const clean = fixture();
		const external = scratch();
		symlinkSync(external, join(project, ".clio-coder"), "dir");
		strictEqual(installPlugin(clean, { cwd: project, scope: "project" }).plugin, undefined);
		strictEqual(existsSync(join(external, "plugins")), false);
	});

	it("preserves a disabled plugin during an ordinary update", () => {
		const root = fixture();
		installPlugin(root, { cwd: project });
		disablePlugin("research-kit", { cwd: project });
		rewriteManifest(root, (manifest) => {
			manifest.version = "1.1.0";
		});
		const result = updatePlugin("research-kit", { cwd: project });
		strictEqual(result.plugin?.version, "1.1.0");
		strictEqual(result.plugin?.enabled, false);
		deepStrictEqual(enabledPluginResourceRoots("skills", project), []);
	});

	it("retains valid user resources and a diagnostic when the project plugin directory is invalid", () => {
		installPlugin(fixture(), { cwd: project });
		mkdirSync(join(project, ".clio-coder"));
		writeFileSync(pluginBaseDir("project", project), "not a directory");
		const entries = listInstalledPlugins(project);
		strictEqual(entries.find((entry) => entry.id === "research-kit")?.loadable, true);
		ok(
			entries.some(
				(entry) =>
					entry.scope === "project" &&
					entry.diagnostics.some((diagnostic) => diagnostic.path === pluginBaseDir("project", project)),
			),
		);
		strictEqual(enabledPluginResourceRoots("skills", project).length, 1);
	});

	it("never serves old canonical roots when a config alias switches to an identical install", () => {
		const first = scratch();
		const second = scratch();
		const aliasParent = scratch();
		const alias = join(aliasParent, "config");
		symlinkSync(first, alias, "dir");
		process.env.CLIO_CODER_CONFIG_DIR = alias;
		resetXdgCache();
		installPlugin(fixture(), { cwd: project });
		reloadPluginResources(project);
		cpSync(join(first, "plugins"), join(second, "plugins"), { recursive: true });
		rmSync(alias);
		symlinkSync(second, alias, "dir");
		writeFileSync(join(first, "plugins", "research-kit", "skills", "research", "SKILL.md"), "changed old profile");
		strictEqual(listInstalledPlugins(project).find((entry) => entry.id === "research-kit")?.loadable, true);
		deepStrictEqual(enabledPluginResourceRoots("skills", project), []);
		reloadPluginResources(project);
		ok(enabledPluginResourceRoots("skills", project)[0]?.path.startsWith(second));
	});
});
