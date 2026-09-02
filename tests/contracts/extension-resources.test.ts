import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateClioCompatibility } from "../../src/domains/extensions/compatibility.js";
import {
	discoverExtensionPackages,
	loadManifestFromRoot,
	parseExtensionManifest,
} from "../../src/domains/extensions/discovery.js";
import { enabledExtensionResourceRoots, extensionResourcePath } from "../../src/domains/extensions/resources.js";
import {
	installExtension,
	listInstalledExtensions,
	removeExtension,
	upgradeLegacyExtensionInstallState,
} from "../../src/domains/extensions/state.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-extension-resources-"));
	roots.push(root);
	return root;
}

function writeManifest(root: string, id: string, resources = "resources: {}\n"): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "clio-coder-extension.yaml"),
		[
			"manifestVersion: 1",
			`id: ${id}`,
			`name: ${id}`,
			"version: 1.0.0",
			"description: Extension integrity fixture.",
			resources.trimEnd(),
			"",
		].join("\n"),
	);
}

describe("extension resource boundary", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("accepts an omitted resources map and strictly validates a present value", () => {
		const base = {
			manifestVersion: 1,
			id: "optional-resources",
			name: "Optional Resources",
			version: "1.0.0",
			description: "Optional resources fixture.",
		};
		const omitted = parseExtensionManifest(base, "/fixture/clio-coder-extension.yaml");
		deepStrictEqual(omitted.diagnostics, []);
		deepStrictEqual(omitted.manifest?.resources, {});

		for (const [resources, expected] of [
			[null, "resources must be an object"],
			[[], "resources must be an object"],
			[{ prompts: "" }, "resources.prompts must be a non-empty string"],
			[{ executable: "bin" }, "unknown resources key 'executable'"],
		] as const) {
			const parsed = parseExtensionManifest({ ...base, resources }, "/fixture/clio-coder-extension.yaml");
			strictEqual(parsed.manifest, undefined);
			ok(parsed.diagnostics.some((diagnostic) => diagnostic.message === expected));
		}
	});

	it("accepts a strict compatible manifest and retains declared resource roots", () => {
		const parsed = parseExtensionManifest(
			{
				manifestVersion: 1,
				id: "research-kit",
				name: "Research Kit",
				version: "2.0.0",
				description: "Portable research resources.",
				compatibility: { clio: ">=0.4.0 <0.5.0" },
				resources: { prompts: "prompts", skills: "skills", agents: "agents", fleets: "fleets" },
			},
			"clio-coder-extension.yaml",
		);
		deepStrictEqual(parsed.diagnostics, []);
		deepStrictEqual(parsed.manifest?.resources, {
			prompts: "prompts",
			skills: "skills",
			agents: "agents",
			fleets: "fleets",
		});
		deepStrictEqual(evaluateClioCompatibility(">=0.4.0 <0.5.0", "0.4.1"), {
			rangeValid: true,
			satisfied: true,
			runningVersion: "0.4.1",
		});
	});

	it("rejects unknown manifest, resource, and compatibility keys", () => {
		const base = {
			manifestVersion: 1,
			id: "strict-keys",
			name: "Strict Keys",
			version: "1.0.0",
			description: "Strict key fixture.",
			resources: {},
		};
		for (const [value, expected] of [
			[{ ...base, executable: "index.ts" }, "unknown manifest key 'executable'"],
			[{ ...base, resources: { prompts: "prompts", executable: "bin" } }, "unknown resources key 'executable'"],
			[{ ...base, compatibility: { clio: ">=0.0.0", runtime: "node" } }, "unknown compatibility key 'runtime'"],
		] as const) {
			const parsed = parseExtensionManifest(value, "/fixture/clio-coder-extension.yaml");
			strictEqual(parsed.manifest, undefined);
			ok(parsed.diagnostics.some((diagnostic) => diagnostic.message === expected));
		}
	});

	it("rejects mixed and duplicate tools or settings arrays", () => {
		const base = {
			manifestVersion: 1,
			id: "strict-arrays",
			name: "Strict Arrays",
			version: "1.0.0",
			description: "Strict array fixture.",
			resources: {},
		};
		for (const [value, expected] of [
			[{ ...base, tools: ["read", 42] }, "tools must contain only non-empty strings"],
			[{ ...base, settings: ["theme", null] }, "settings must contain only non-empty strings"],
			[{ ...base, tools: ["read", "read"] }, "tools contains duplicate entry 'read'"],
			[{ ...base, settings: ["theme", "theme"] }, "settings contains duplicate entry 'theme'"],
		] as const) {
			const parsed = parseExtensionManifest(value, "/fixture/clio-coder-extension.yaml");
			strictEqual(parsed.manifest, undefined);
			ok(parsed.diagnostics.some((diagnostic) => diagnostic.message === expected));
		}
	});

	it("canonicalizes duplicate root spellings and retains a deterministic diagnostic", () => {
		const parent = scratch();
		const packageRoot = join(parent, "z-package");
		writeManifest(packageRoot, "canonical-root");
		symlinkSync(packageRoot, join(parent, "a-alias"), "dir");
		symlinkSync(packageRoot, join(parent, "b-alias"), "dir");

		const first = discoverExtensionPackages(parent);
		const second = discoverExtensionPackages(parent);
		deepStrictEqual(second, first);
		strictEqual(first.length, 1);
		strictEqual(first[0]?.path, realpathSync(packageRoot));
		strictEqual(first[0]?.valid, true);
		ok(
			first[0]?.diagnostics.some(
				(diagnostic) =>
					diagnostic.type === "warning" && diagnostic.message.includes("duplicate canonical extension root loaded once"),
			),
		);
	});

	it("still rejects the same id from distinct canonical roots", () => {
		const parent = scratch();
		writeManifest(join(parent, "one"), "duplicate-id");
		writeManifest(join(parent, "two"), "duplicate-id");
		const discovered = discoverExtensionPackages(parent);
		strictEqual(discovered.length, 2);
		ok(discovered.every((candidate) => !candidate.valid));
		ok(
			discovered.every((candidate) =>
				candidate.diagnostics.some((diagnostic) => diagnostic.message === "duplicate extension id duplicate-id"),
			),
		);
	});

	it("resolves only directories contained by the extension root", () => {
		const root = scratch();
		const outside = scratch();
		mkdirSync(join(root, "prompts"));
		mkdirSync(join(outside, "external"));
		strictEqual(extensionResourcePath(root, "prompts"), join(root, "prompts"));
		strictEqual(extensionResourcePath(root, "../outside"), null);
		symlinkSync(join(outside, "external"), join(root, "linked"), "dir");
		strictEqual(extensionResourcePath(root, "linked"), null);
		strictEqual(extensionResourcePath(root, "."), null);
	});

	it("keeps a package with an invalid resource tree visible but inactive", () => {
		const project = scratch();
		const outside = scratch();
		const installed = join(project, ".clio-coder", "extensions", "invalid-tree");
		mkdirSync(installed, { recursive: true });
		mkdirSync(join(outside, "agents"));
		writeFileSync(
			join(installed, "clio-coder-extension.yaml"),
			[
				"manifestVersion: 1",
				"id: invalid-tree",
				"name: Invalid Tree",
				"version: 1.0.0",
				"description: Invalid resource fixture.",
				"resources:",
				"  agents: agents",
				"",
			].join("\n"),
		);
		symlinkSync(join(outside, "agents"), join(installed, "agents"), "dir");

		const candidate = loadManifestFromRoot(installed);
		strictEqual(candidate.valid, false);
		const [entry] = listInstalledExtensions(project);
		strictEqual(entry?.valid, false);
		strictEqual(entry?.effective, false);
		strictEqual(entry?.loadable, false);
		ok(entry?.diagnostics.some((diagnostic) => diagnostic.message.includes("symbolic link")));
		deepStrictEqual(enabledExtensionResourceRoots("agents", project), []);
	});

	it("revalidates the staged copy and preserves the previous install on failure", () => {
		const project = scratch();
		const original = scratch();
		const replacement = scratch();
		writeManifest(original, "staged-rollback");
		writeFileSync(join(original, "marker.txt"), "original\n");
		const first = installExtension(original, { cwd: project, scope: "project" });
		ok(first.extension?.loadable);
		const originalDigest = first.extension.installedContentDigest;

		writeManifest(replacement, "staged-rollback", "resources:\n  agents: agents\n");
		mkdirSync(join(replacement, "real-agents"));
		writeFileSync(join(replacement, "real-agents", "replacement.md"), "# replacement\n");
		// Valid at the source location, but copying preserves this absolute link.
		// At staging it points outside the staged package and must be rejected.
		symlinkSync(join(replacement, "real-agents"), join(replacement, "agents"), "dir");
		strictEqual(loadManifestFromRoot(replacement).valid, true);

		const forced = installExtension(replacement, { cwd: project, scope: "project", force: true });
		strictEqual(forced.extension, undefined);
		ok(forced.diagnostics.some((diagnostic) => diagnostic.message.includes("staged extension content is invalid")));
		const installedRoot = join(project, ".clio-coder", "extensions", "staged-rollback");
		strictEqual(readFileSync(join(installedRoot, "marker.txt"), "utf8"), "original\n");
		const [preserved] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(preserved?.loadable, true);
		strictEqual(preserved?.installedContentDigest, originalDigest);
		strictEqual(preserved?.observedContentDigest, originalDigest);
	});

	it("detects post-install content drift and prevents activation", () => {
		const project = scratch();
		const source = scratch();
		writeManifest(source, "drift-contract");
		writeFileSync(join(source, "hooks.yaml"), "[]\n");
		const result = installExtension(source, { cwd: project, scope: "project" });
		ok(result.extension?.loadable);
		const installedRoot = join(project, ".clio-coder", "extensions", "drift-contract");
		writeFileSync(join(installedRoot, "hooks.yaml"), "# changed after install\n[]\n");

		const [drifted] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(drifted?.valid, false);
		strictEqual(drifted?.effective, false);
		strictEqual(drifted?.loadable, false);
		ok(drifted?.installedContentDigest);
		ok(drifted?.observedContentDigest);
		ok(drifted?.installedContentDigest !== drifted?.observedContentDigest);
		ok(drifted?.diagnostics.some((diagnostic) => diagnostic.message.includes("content drift detected")));
	});

	it("distinguishes absent install state from corrupt install state and fails closed", () => {
		const absentProject = scratch();
		const absentRoot = join(absentProject, ".clio-coder", "extensions", "absent-state");
		writeManifest(absentRoot, "absent-state");
		const [absent] = listInstalledExtensions(absentProject, { scope: "project" });
		strictEqual(absent?.loadable, false);
		ok(absent?.diagnostics.some((diagnostic) => diagnostic.message.includes("install state is absent")));

		const corruptProject = scratch();
		const corruptBase = join(corruptProject, ".clio-coder", "extensions");
		writeManifest(join(corruptBase, "corrupt-state"), "corrupt-state");
		writeFileSync(join(corruptBase, "state.json"), "{ not-json\n");
		const [corrupt] = listInstalledExtensions(corruptProject, { scope: "project" });
		strictEqual(corrupt?.loadable, false);
		ok(corrupt?.diagnostics.some((diagnostic) => diagnostic.message.includes("install state is corrupt")));
	});

	it("keeps legacy inspection read-only, then upgrades digests once with a backup", () => {
		const project = scratch();
		const base = join(project, ".clio-coder", "extensions");
		const installed = join(base, "legacy-digest");
		writeManifest(installed, "legacy-digest");
		writeFileSync(join(installed, "marker.txt"), "legacy bytes\n", "utf8");
		const originalState = `${JSON.stringify(
			{
				version: 1,
				disabled: ["legacy-digest"],
				installed: {
					"legacy-digest": {
						installedAt: "2026-08-31T12:34:56.000Z",
						source: "/original/source",
					},
				},
			},
			null,
			2,
		)}\n`;
		const statePath = join(base, "state.json");
		writeFileSync(statePath, originalState, "utf8");

		const [before] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(before?.loadable, false);
		ok(before?.diagnostics.some((diagnostic) => diagnostic.message.includes("run clio-coder upgrade")));
		strictEqual(readFileSync(statePath, "utf8"), originalState, "plain list must not migrate state");

		const [first] = upgradeLegacyExtensionInstallState(project, ["project"]);
		deepStrictEqual(first?.upgraded, ["legacy-digest"]);
		deepStrictEqual(first?.refused, []);
		strictEqual(first?.backupPath, `${statePath}.pre-digest.bak`);
		strictEqual(readFileSync(`${statePath}.pre-digest.bak`, "utf8"), originalState);
		const migratedBytes = readFileSync(statePath, "utf8");
		const migrated = JSON.parse(migratedBytes) as {
			disabled: string[];
			installed: Record<string, { installedAt: string; source?: string; contentDigest?: string }>;
		};
		deepStrictEqual(migrated.disabled, ["legacy-digest"]);
		strictEqual(migrated.installed["legacy-digest"]?.installedAt, "2026-08-31T12:34:56.000Z");
		strictEqual(migrated.installed["legacy-digest"]?.source, "/original/source");
		ok(/^[a-f0-9]{64}$/u.test(migrated.installed["legacy-digest"]?.contentDigest ?? ""));
		const [after] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(after?.valid, true);
		strictEqual(after?.enabled, false, "migration preserves disabled state");

		const [second] = upgradeLegacyExtensionInstallState(project, ["project"]);
		deepStrictEqual(second?.upgraded, []);
		deepStrictEqual(second?.refused, []);
		strictEqual(readFileSync(statePath, "utf8"), migratedBytes);
		strictEqual(readFileSync(`${statePath}.pre-digest.bak`, "utf8"), originalState);
	});

	it("refuses to bless an invalid legacy tree and leaves it visible but non-loadable", () => {
		const project = scratch();
		const outside = scratch();
		const base = join(project, ".clio-coder", "extensions");
		const installed = join(base, "invalid-legacy");
		writeManifest(installed, "invalid-legacy", "resources:\n  prompts: prompts\n");
		mkdirSync(join(outside, "prompts"));
		symlinkSync(join(outside, "prompts"), join(installed, "prompts"), "dir");
		const statePath = join(base, "state.json");
		const original = `${JSON.stringify({
			version: 1,
			disabled: [],
			installed: { "invalid-legacy": { installedAt: "2026-08-31T00:00:00.000Z" } },
		})}\n`;
		writeFileSync(statePath, original, "utf8");

		const [report] = upgradeLegacyExtensionInstallState(project, ["project"]);
		deepStrictEqual(report?.upgraded, []);
		strictEqual(report?.refused[0]?.id, "invalid-legacy");
		ok(report?.refused[0]?.reason.includes("symbolic link"));
		strictEqual(readFileSync(statePath, "utf8"), original);
		strictEqual(existsSync(`${statePath}.pre-digest.bak`), false);
		const [entry] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(entry?.id, "invalid-legacy");
		strictEqual(entry?.loadable, false);
	});

	it("backs up corrupt state and unverifiable bytes during remove and forced reinstall recovery", () => {
		const removeProject = scratch();
		const removeBase = join(removeProject, ".clio-coder", "extensions");
		const removeRoot = join(removeBase, "corrupt-remove");
		writeManifest(removeRoot, "corrupt-remove");
		writeFileSync(join(removeRoot, "marker.txt"), "preserve remove bytes\n", "utf8");
		const corruptState = "{ definitely-not-json\n";
		writeFileSync(join(removeBase, "state.json"), corruptState, "utf8");
		listInstalledExtensions(removeProject, { scope: "project" });
		strictEqual(readFileSync(join(removeBase, "state.json"), "utf8"), corruptState, "inspection stays read-only");

		const removed = removeExtension("corrupt-remove", { cwd: removeProject, scope: "project" });
		strictEqual(removed.removed?.id, "corrupt-remove");
		ok(removed.recovery?.stateBackup);
		ok(removed.recovery?.packageBackup);
		strictEqual(readFileSync(removed.recovery?.stateBackup as string, "utf8"), corruptState);
		strictEqual(
			readFileSync(join(removed.recovery?.packageBackup as string, "marker.txt"), "utf8"),
			"preserve remove bytes\n",
		);
		strictEqual(existsSync(removeRoot), false);
		deepStrictEqual(listInstalledExtensions(removeProject, { scope: "project" }), []);

		const reinstallProject = scratch();
		const reinstallBase = join(reinstallProject, ".clio-coder", "extensions");
		const oldRoot = join(reinstallBase, "corrupt-reinstall");
		writeManifest(oldRoot, "corrupt-reinstall");
		writeFileSync(join(oldRoot, "marker.txt"), "old unverifiable bytes\n", "utf8");
		writeFileSync(join(reinstallBase, "state.json"), corruptState, "utf8");
		const replacement = scratch();
		writeManifest(replacement, "corrupt-reinstall");
		writeFileSync(join(replacement, "marker.txt"), "verified replacement\n", "utf8");

		const refused = installExtension(replacement, { cwd: reinstallProject, scope: "project" });
		strictEqual(refused.extension, undefined);
		ok(refused.diagnostics.some((diagnostic) => diagnostic.message.includes("retry with --force")));
		const reinstalled = installExtension(replacement, { cwd: reinstallProject, scope: "project", force: true });
		strictEqual(reinstalled.extension?.loadable, true);
		ok(reinstalled.recovery?.stateBackup);
		ok(reinstalled.recovery?.packageBackup);
		strictEqual(readFileSync(reinstalled.recovery?.stateBackup as string, "utf8"), corruptState);
		strictEqual(
			readFileSync(join(reinstalled.recovery?.packageBackup as string, "marker.txt"), "utf8"),
			"old unverifiable bytes\n",
		);
		strictEqual(readFileSync(join(oldRoot, "marker.txt"), "utf8"), "verified replacement\n");
	});

	it("preserves every payload byte after the command delimiter", () => {
		const promptRoot = scratch();
		mkdirSync(join(promptRoot, "research"));
		writeFileSync(
			join(promptRoot, "research", "draft.md"),
			["<invocation_arguments>", "$ARGUMENTS", "</invocation_arguments>", ""].join("\n"),
		);
		const templates = loadPromptTemplates({
			roots: [{ path: promptRoot, scope: "project", source: "extension:research-kit", trusted: true }],
		});
		const payload = ["", "  Exact  spacing.", "", "\t- Keep tabs.", "Trailing spaces.  ", ""].join("\n");
		const expanded = expandPromptTemplateInput(`/research:draft\n${payload}`, templates);
		strictEqual(expanded.expanded, true);
		if (!expanded.expanded) return;
		strictEqual(expanded.text, ["<invocation_arguments>", payload, "</invocation_arguments>"].join("\n"));
		ok(expanded.template.filePath.endsWith(join("research", "draft.md")));
	});
});
