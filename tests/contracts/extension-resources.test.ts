import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateClioCompatibility } from "../../src/domains/extensions/compatibility.js";
import { parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import { extensionResourcePath } from "../../src/domains/extensions/resources.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-extension-resources-"));
	roots.push(root);
	return root;
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
