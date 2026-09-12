/**
 * Outbound portability: the canonical `library/` sources stay installable by
 * Claude Code and loadable by Codex without a second hand-maintained catalog.
 *
 * These are static repository contracts. They deliberately do not shell out to
 * a host CLI, because a host binary is not something this repository owns or
 * can require in CI. `scripts/verify-portable-hosts.sh` reproduces the host
 * behavior asserted here against the real Claude Code and Codex CLIs in
 * throwaway homes; the layouts below were measured on Claude Code 2.1.267 and
 * Codex 0.153.3.
 */

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { renderLibraryMarketplace } from "../../scripts/generate-library-marketplace.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
describe("the portable inclusion rule", () => {
	/**
	 * The library accepts agent-, prompt- and fleet-only packages, and the
	 * composite authoring template puts a Clio strict-v1 recipe in a top-level
	 * `agents/` directory. Claude Code default-scans `agents/` with no manifest
	 * and no marketplace field asking it to: publishing the composite template
	 * on 2.1.267 produced `Agents (1) data-curator`, and `--strict` validation
	 * raised nothing. So the generator publishes a package only when a host
	 * would load a real skill surface from it and nothing else, and reports the
	 * rest instead of failing the pin for the whole library.
	 */
	const fixtures = mkdtempSync(join(tmpdir(), "clio-coder-portability-"));
	after(() => rmSync(fixtures, { recursive: true, force: true }));

	const TEMPLATES = join(REPO_ROOT, "library", "_authoring", "templates");

	/** A throwaway repository root holding just the named packages and their pins. */
	function fixtureRoot(name: string, packages: ReadonlyArray<{ name: string; template: string }>): string {
		const root = join(fixtures, name);
		mkdirSync(join(root, "library", "plugins"), { recursive: true });
		writeFileSync(join(root, "package.json"), JSON.stringify({ homepage: "https://example.invalid" }));
		const pins = packages.map((pkg) => {
			const directory = join(root, "library", "plugins", pkg.name);
			cpSync(join(TEMPLATES, pkg.template), directory, { recursive: true });
			const manifest = JSON.parse(readFileSync(join(directory, "plugin.json"), "utf8")) as {
				name: string;
				version: string;
				description?: string;
			};
			manifest.name = pkg.name;
			writeFileSync(join(directory, "plugin.json"), JSON.stringify(manifest, null, "\t"));
			return {
				kind: "plugin",
				name: pkg.name,
				description: manifest.description ?? "",
				version: manifest.version,
				sourceUrl: `plugins/${pkg.name}`,
				sha256: "0".repeat(64),
			};
		});
		writeFileSync(join(root, "library", "registry.yaml"), stringifyYaml({ entries: pins }));
		return root;
	}

	it("refuses to publish a package whose root agents/ Claude Code would claim as native", () => {
		const root = fixtureRoot("composite", [{ name: "composite", template: "plugin" }]);
		const result = renderLibraryMarketplace({ root });
		deepStrictEqual(result.errors, []);
		deepStrictEqual(result.entries, []);
		equal(result.excluded.length, 1);
		equal(result.excluded[0]?.name, "composite");
		ok(
			result.excluded[0]?.reason.includes("root agents"),
			`reason should name the host-scanned directory: ${result.excluded[0]?.reason}`,
		);
	});

	it("refuses to publish native-only packages, naming the missing skill surface", () => {
		const root = fixtureRoot("native-only", [
			{ name: "agent-only", template: "agent" },
			{ name: "prompt-only", template: "prompt" },
			{ name: "fleet-only", template: "fleet" },
		]);
		const result = renderLibraryMarketplace({ root });
		deepStrictEqual(result.errors, []);
		deepStrictEqual(result.entries, []);
		deepStrictEqual(result.excluded.map((entry) => entry.name).sort(), ["agent-only", "fleet-only", "prompt-only"]);
		const promptOnly = result.excluded.find((entry) => entry.name === "prompt-only");
		ok(promptOnly?.reason.includes("no portable skill surface"), `actionable reason expected: ${promptOnly?.reason}`);
	});

	it("still publishes a standalone skill package alongside them", () => {
		const root = fixtureRoot("mixed", [
			{ name: "portable-skill", template: "skill" },
			{ name: "agent-only", template: "agent" },
		]);
		const result = renderLibraryMarketplace({ root });
		deepStrictEqual(result.errors, []);
		deepStrictEqual(
			result.entries.map((entry) => entry.name),
			["portable-skill"],
		);
		deepStrictEqual(
			result.excluded.map((entry) => entry.name),
			["agent-only"],
		);
	});
});

describe("Codex skills roots", () => {
	/**
	 * Codex scans `$REPO_ROOT/.agents/skills`, recurses into subdirectories and
	 * follows symlinks at that location. Two links therefore publish the whole
	 * canonical catalog to a Codex session started in a clone, with no copied
	 * SKILL.md bodies and no wrapper tree.
	 */
	const expected: ReadonlyArray<[string, string]> = [
		["clio-coder", "../../library/skills"],
		["materio", "../../library/plugins/materio/skills"],
	];

	it("links the canonical directories and nothing else", () => {
		const root = join(REPO_ROOT, ".agents", "skills");
		const entries = readdirSync(root).sort();
		deepStrictEqual(entries, expected.map(([name]) => name).sort());
		for (const [name, target] of expected) {
			const link = join(root, name);
			ok(lstatSync(link).isSymbolicLink(), `.agents/skills/${name} must stay a symlink, never a copy`);
			equal(readlinkSync(link).split("\\").join("/"), target, `.agents/skills/${name} must point at the canonical tree`);
			const resolved = resolve(root, target);
			ok(existsSync(join(resolved)), `.agents/skills/${name} target is missing`);
			ok(!relative(REPO_ROOT, resolved).startsWith(".."), `.agents/skills/${name} must stay inside the repository`);
		}
	});
});
