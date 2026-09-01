import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateClioCompatibility } from "../../src/domains/extensions/compatibility.js";
import { loadManifestFromRoot, parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import { enabledExtensionResourceRoots, extensionResourcePath } from "../../src/domains/extensions/resources.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
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
